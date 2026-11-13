// Host lifecycle for meeting polls: create, read, close, cancel, delete and public-link
// rotation. This is an internal service with no transport; voter admission lives in
// meeting-poll-voters.ts, ballots in meeting-poll-ballots.ts and results and voter removal in
// meeting-poll-results.ts, while finalization lands in a later step (docs/meeting-polls.md).
//
// Every host write takes the shared order: the transport's organization-write hook, actor
// user SHARE, organization SHARE, actor membership SHARE, then the poll row FOR UPDATE and
// its event FOR SHARE. Creation instead takes public booking's host phase after the actor
// locks: the hosts' sorted booking locks, the event FOR SHARE, then host users and members
// SHARE. The database clock is captured once after those locks and is the only clock used
// for lifecycle and availability decisions.
import { createHash, randomBytes } from 'node:crypto'
import { ApiKeyScopeError, requireActiveApiKey } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  findOneTimeEventType,
  intersectSlots,
  selectDurationMinutes,
  unionRoundRobinSlots,
} from './availability.ts'
import { canonicalJson, lockHosts } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid, validTimeZone } from './internal.ts'
import { MEETING_POLL_LIMITS } from './meeting-poll-policy.ts'

export type MeetingPollStatus = 'open' | 'closed' | 'scheduled' | 'canceled'
export type MeetingPollAdmissionMode = 'public_link' | 'invited'
export type MeetingPollVisibility = 'private' | 'aggregate'

export interface MeetingPollCandidate {
  id: string
  startAt: string
  endAt: string
  position: number
}

/** Host metadata. It never contains a capability, a digest or the settings snapshot. */
export interface MeetingPoll {
  id: string
  organizationId: string
  eventTypeId: string
  title: string
  durationMinutes: number
  displayTimeZone: string
  admissionMode: MeetingPollAdmissionMode
  visibility: MeetingPollVisibility
  deadlineAt: string
  /** Effective state: an open poll whose deadline has passed reads as closed. */
  status: MeetingPollStatus
  closedAt: string | null
  canceledAt: string | null
  scheduledAt: string | null
  chosenSlotId: string | null
  bookingId: string | null
  hostRevision: number
  createdByUserId: string | null
  source: 'web' | 'api' | 'mcp'
  createdAt: string
  updatedAt: string
  candidates: MeetingPollCandidate[]
}

export interface CreateMeetingPollInput {
  eventTypeId: string
  candidateStarts: string[]
  durationMinutes?: number | undefined
  deadlineAt: string
  displayTimeZone: string
  admissionMode: MeetingPollAdmissionMode
  visibility?: MeetingPollVisibility | undefined
  idempotencyKey: string
}

export interface MeetingPollHostWriteInput {
  id: string
  expectedHostRevision: number
}

export interface RotateMeetingPollLinkInput extends MeetingPollHostWriteInput {
  idempotencyKey: string
}

/** The raw public capability is returned only by create and rotate, exactly once. */
export interface MeetingPollWithLink {
  poll: MeetingPoll
  publicToken: string | null
}

/** Exact create replay: the authorized poll ID, or null once that poll was deleted. */
export class MeetingPollAlreadyCreatedError extends DomainError {
  readonly pollId: string | null

  constructor(pollId: string | null) {
    super(
      'conflict',
      'poll_already_created',
      'This poll was already created. Read it by its ID; a link or capability is never shown again.',
    )
    this.pollId = pollId
  }
}

/**
 * Candidates the availability engine does not offer at creation. `unavailableStarts` lists
 * every refused start in chronological order, so a host can replace exactly those times.
 */
export class MeetingPollSlotUnavailableError extends DomainError {
  readonly unavailableStarts: string[]

  constructor(unavailableStarts: string[]) {
    super(
      'conflict',
      'slot_unavailable',
      'Every candidate must be a time this event can be booked now. Choose other times.',
    )
    this.unavailableStarts = unavailableStarts
  }
}

export const MEETING_POLL_PAGE_DEFAULT = 50
export const MEETING_POLL_PAGE_MAX = 100

const CREATE_FIELDS = new Set([
  'eventTypeId',
  'candidateStarts',
  'durationMinutes',
  'deadlineAt',
  'displayTimeZone',
  'admissionMode',
  'visibility',
  'idempotencyKey',
])
const TOKEN_FIELDS = new Set(['token', 'oneTimeToken', 'oneTimeLinkToken', 'publicToken'])
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/
const EARLIEST = -62135596800000 // 0001-01-01T00:00:00Z
// A day short of year 10000, so database microsecond rounding can never leave year 9999.
const LATEST = 253402214400000 // 9999-12-31T00:00:00Z
const MINUTE_NS = 60_000_000_000n
const SECOND_NS = 1_000_000_000n
/** Lifecycle writes may set only these columns; everything else is fixed at creation. */
const HOST_WRITE_COLUMNS = new Set(['status', 'closed_at', 'canceled_at', 'public_token_digest'])

export const pollNotFound = () => new DomainError('not_found', 'poll_not_found', 'No such poll')
const eventNotFound = () =>
  new DomainError('not_found', 'event_type_not_found', 'No such event type')
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const invalidPoll = (message: string) => new DomainError('invalid', 'invalid_poll', message)
export const changed = () =>
  new DomainError(
    'conflict',
    'poll_changed',
    'This poll changed since you loaded it. Reload it before trying again.',
  )
export const keyReused = () =>
  new DomainError(
    'conflict',
    'idempotency_key_reused',
    'This Idempotency-Key was already used for a different request.',
  )
const eventChanged = () =>
  new DomainError(
    'conflict',
    'poll_event_changed',
    'This event type’s hosts changed while the poll was being created. Try again.',
  )

const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const utc = (ref: string) =>
  sql<string>`to_char(${sql.ref(ref)} AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
const utcNullable = (ref: string) =>
  sql<string | null>`to_char(${sql.ref(ref)} AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
const databaseClock = sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
/** Microsecond database text as RFC 3339 UTC, without trailing zero fractions. */
const rfc3339 = (value: string) => Temporal.Instant.from(value).toString()
const sha256 = (domain: string, value: string) =>
  createHash('sha256').update(`hourmere.meeting-poll.${domain}\0${value}`, 'utf8').digest()

/** Stored digest of a public poll capability; later public enrollment uses the same digest. */
export function meetingPollPublicTokenDigest(token: string): Buffer {
  return sha256('public-link', token)
}

/**
 * The event settings a voter consents to, snapshotted at creation and compared again by
 * finalization. Private connection, organizer and calendar IDs are deliberately excluded.
 */
export async function meetingPollEventSettings(
  db: Db,
  eventTypeId: string,
  durationMinutes: number,
): Promise<{ snapshot: Record<string, unknown>; fingerprint: Buffer }> {
  const event = await db
    .selectFrom('event_types')
    .select([
      'title',
      'location',
      'locations',
      'questions',
      'scheduling_type',
      'booking_mode',
      'allow_guests',
    ])
    .where('id', '=', eventTypeId)
    .executeTakeFirstOrThrow()
  const hosts = await db
    .selectFrom('event_type_hosts')
    .select('user_id')
    .where('event_type_id', '=', eventTypeId)
    .orderBy('user_id')
    .execute()
  const snapshot = {
    version: 1,
    title: event.title,
    durationMinutes,
    location: event.location,
    locations: event.locations,
    questions: event.questions,
    schedulingType: event.scheduling_type,
    bookingMode: event.booking_mode,
    hostUserIds: hosts.map((host) => host.user_id.toLowerCase()).sort(),
    allowGuests: event.allow_guests,
  }
  return { snapshot, fingerprint: sha256('settings', canonicalJson(snapshot)) }
}

/**
 * Create an open poll for an event the caller manages. Every candidate must be a slot the
 * availability engine offers at creation, as public booking would check it; candidates
 * stay proposals only: no booking, hold, calendar write or notification is created.
 * Requires an idempotency key; an exact replay throws MeetingPollAlreadyCreatedError and
 * never returns another link.
 */
export async function createMeetingPoll(
  ctx: ServiceContext,
  input: CreateMeetingPollInput,
  options: { source?: 'api' | 'mcp' } = {},
): Promise<MeetingPollWithLink> {
  requireWriteScope(ctx)
  const request = validCreateInput(input)
  const source = pollSource(ctx, options.source)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)
    const authority = await lockAuthority(trx, ctx)
    const named = await trx
      .selectFrom('event_types')
      .select(['id', 'owner_user_id'])
      .where('id', '=', request.eventTypeId)
      .where('organization_id', '=', ctx.principal.organization.id)
      .executeTakeFirst()
    if (!named || !manages(authority, named.owner_user_id)) throw eventNotFound()
    // Public booking's host phase: an unlocked read names the hosts, whose sorted booking
    // locks precede the event share lock. A booking of these hosts that committed earlier
    // is visible to the availability check below; a later one waits for this commit.
    const hostUserIds = (await findOneTimeEventType(trx, named.id))?.hostUserIds ?? []
    await lockHosts(trx, hostUserIds)
    const event = await trx
      .selectFrom('event_types')
      .select([
        'id',
        'owner_user_id',
        'is_active',
        'deleted_at',
        'booking_mode',
        'duration_minutes',
        'allowed_durations_minutes',
        'minimum_notice_minutes',
      ])
      .where('id', '=', request.eventTypeId)
      .where('organization_id', '=', ctx.principal.organization.id)
      .forShare()
      .executeTakeFirst()
    if (!event || !manages(authority, event.owner_user_id)) throw eventNotFound()
    const normalized = await normalizeInstants(trx, [request.deadlineAt, ...request.candidates])
    const deadlineAt = normalized[0] as string
    const starts = [...new Set(normalized.slice(1))].sort(compareInstants)
    if (starts.length !== request.candidates.length)
      throw invalidPoll('candidateStarts must not contain the same instant twice')
    const receipt = receiptIdentity(ctx, 'create', request.idempotencyKey, {
      eventTypeId: request.eventTypeId.toLowerCase(),
      candidateStarts: starts,
      durationMinutes: request.durationMinutes ?? null,
      deadlineAt,
      displayTimeZone: request.displayTimeZone,
      admissionMode: request.admissionMode,
      visibility: request.visibility,
    })
    // Authorization precedes replay; replay precedes every clock- or event-state check.
    const previous = await lockedReceipt(trx, receipt)
    if (previous) {
      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()
      throw new MeetingPollAlreadyCreatedError(previous.poll_id)
    }
    if (event.deleted_at !== null) throw eventNotFound()
    if (!event.is_active)
      throw new DomainError('invalid', 'event_type_inactive', 'This event type is turned off')
    if (event.booking_mode !== 'individual')
      throw new DomainError(
        'invalid',
        'poll_event_unsupported',
        'Polls are not available for group seat event types',
      )
    const durationMinutes = selectDurationMinutes(
      {
        durationMinutes: event.duration_minutes,
        allowedDurationsMinutes: event.allowed_durations_minutes,
      },
      request.durationMinutes,
    )
    // Host users and members are share-locked before the clock is read, as in public
    // booking, so a wait for those rows never leaves the decision instant stale.
    const bookable = await lockBookableEvent(trx, event.id, hostUserIds)
    const createdAt = await clock(trx)
    validateSchedule(createdAt, deadlineAt, starts, event.minimum_notice_minutes)
    await requireBookableCandidates(trx, bookable, starts, durationMinutes, createdAt)
    const settings = await meetingPollEventSettings(trx, event.id, durationMinutes)
    const publicToken =
      request.admissionMode === 'public_link' ? randomBytes(32).toString('base64url') : null
    const poll = await trx
      .insertInto('meeting_polls')
      .values({
        organization_id: ctx.principal.organization.id,
        event_type_id: event.id,
        created_by_user_id: ctx.principal.user.id,
        source,
        api_key_id: ctx.principal.kind === 'api_key' ? ctx.principal.apiKeyId : null,
        title: settings.snapshot.title as string,
        duration_minutes: durationMinutes,
        display_time_zone: request.displayTimeZone,
        settings_snapshot: JSON.stringify(settings.snapshot),
        settings_fingerprint: settings.fingerprint,
        admission_mode: request.admissionMode,
        visibility: request.visibility,
        deadline_at: deadlineAt,
        public_token_digest:
          publicToken === null ? null : meetingPollPublicTokenDigest(publicToken),
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('meeting_poll_slots')
      .values(
        starts.map((start, position) => ({
          organization_id: ctx.principal.organization.id,
          poll_id: poll.id,
          start_at: start,
          end_at: Temporal.Instant.from(start).add({ minutes: durationMinutes }).toString(),
          position,
          created_at: createdAt,
          updated_at: createdAt,
        })),
      )
      .execute()
    await insertReceipt(trx, receipt, poll.id, createdAt)
    return { poll: await loadPoll(trx, ctx, poll.id), publicToken }
  })
}

/** Current metadata for a poll the caller manages; unrelated IDs stay opaque. */
export async function getMeetingPoll(ctx: ServiceContext, id: string): Promise<MeetingPoll> {
  return ctx.db.transaction().execute(async (trx) => {
    const authority = await lockAuthority(trx, ctx)
    if (!isUuid(id)) throw pollNotFound()
    const row = await trx
      .selectFrom('meeting_polls as poll')
      .innerJoin('event_types as event', (join) =>
        join
          .onRef('event.id', '=', 'poll.event_type_id')
          .onRef('event.organization_id', '=', 'poll.organization_id'),
      )
      .select(['poll.id', 'event.owner_user_id'])
      .where('poll.id', '=', id)
      .where('poll.organization_id', '=', ctx.principal.organization.id)
      .executeTakeFirst()
    if (!row || !manages(authority, row.owner_user_id)) throw pollNotFound()
    return loadPoll(trx, ctx, row.id)
  })
}

/** Newest first, scoped to the caller's organization and to events the caller manages. */
export async function listMeetingPolls(
  ctx: ServiceContext,
  input: { limit?: number | undefined; after?: string | undefined } = {},
): Promise<{ data: MeetingPoll[]; nextAfter: string | null }> {
  const limit = input.limit ?? MEETING_POLL_PAGE_DEFAULT
  if (!Number.isInteger(limit) || limit < 1 || limit > MEETING_POLL_PAGE_MAX)
    throw new DomainError('invalid', 'invalid_limit', 'limit must be an integer from 1 to 100')
  const cursor = input.after === undefined ? undefined : decodeCursor(input.after)
  return ctx.db.transaction().execute(async (trx) => {
    const authority = await lockAuthority(trx, ctx)
    const rows = await trx
      .selectFrom('meeting_polls as poll')
      .innerJoin('event_types as event', (join) =>
        join
          .onRef('event.id', '=', 'poll.event_type_id')
          .onRef('event.organization_id', '=', 'poll.organization_id'),
      )
      .select(['poll.id', utc('poll.created_at').as('created')])
      .where('poll.organization_id', '=', ctx.principal.organization.id)
      .where((eb) =>
        authority.personal
          ? eb('event.owner_user_id', '=', authority.userId)
          : eb('event.owner_user_id', 'is', null),
      )
      .$if(cursor !== undefined, (query) =>
        query.where(
          sql<boolean>`(poll.created_at, poll.id) < (${cursor?.createdAt}::timestamptz, ${cursor?.id}::uuid)`,
        ),
      )
      .orderBy('poll.created_at', 'desc')
      .orderBy('poll.id', 'desc')
      .limit(limit + 1)
      .execute()
    const page = rows.slice(0, limit)
    const data = await loadPolls(
      trx,
      ctx,
      page.map((row) => row.id),
    )
    const last = page.at(-1)
    return {
      data,
      nextAfter:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created, last.id])).toString('base64url')
          : null,
    }
  })
}

/**
 * Stop voting early. A poll that is already closed, including by its deadline, returns its
 * current state before the revision check. Closed and canceled polls never reopen.
 */
export async function closeMeetingPoll(
  ctx: ServiceContext,
  input: MeetingPollHostWriteInput,
): Promise<MeetingPoll> {
  requireWriteScope(ctx)
  const request = validHostWrite(input)
  return ctx.db.transaction().execute(async (trx) => {
    const poll = await lockManagedPoll(trx, ctx, request.id)
    if (poll.effectiveStatus === 'closed') return loadPoll(trx, ctx, poll.id)
    if (poll.status === 'canceled')
      throw new DomainError('conflict', 'poll_canceled', 'This poll was canceled')
    if (poll.status === 'scheduled') throw alreadyScheduled()
    requireHostRevision(poll, request.expectedHostRevision)
    await hostWrite(trx, poll, { status: 'closed', closed_at: poll.at })
    return loadPoll(trx, ctx, poll.id)
  })
}

/**
 * Cancel an open or closed poll before scheduling. A canceled poll returns its current
 * state before the revision check; a scheduled one is managed through its booking.
 */
export async function cancelMeetingPoll(
  ctx: ServiceContext,
  input: MeetingPollHostWriteInput,
): Promise<MeetingPoll> {
  requireWriteScope(ctx)
  const request = validHostWrite(input)
  return ctx.db.transaction().execute(async (trx) => {
    const poll = await lockManagedPoll(trx, ctx, request.id)
    if (poll.status === 'canceled') return loadPoll(trx, ctx, poll.id)
    if (poll.status === 'scheduled') throw alreadyScheduled()
    requireHostRevision(poll, request.expectedHostRevision)
    // Voting already closed at the deadline, whether or not a worker recorded it.
    const deadlineClosed = poll.status === 'open' && poll.effectiveStatus === 'closed'
    await hostWrite(trx, poll, {
      status: 'canceled',
      canceled_at: poll.at,
      ...(deadlineClosed ? { closed_at: poll.deadline } : {}),
    })
    return loadPoll(trx, ctx, poll.id)
  })
}

/**
 * Delete a poll in any state. Its candidates and stored digests go with it, its receipts
 * keep only pseudonymous replay identity (the organization ID and an unkeyed digest of the
 * acting user, API key or OAuth grant), and a linked booking is preserved.
 */
export async function deleteMeetingPoll(
  ctx: ServiceContext,
  input: MeetingPollHostWriteInput,
): Promise<void> {
  requireWriteScope(ctx)
  const request = validHostWrite(input)
  await ctx.db.transaction().execute(async (trx) => {
    const poll = await lockManagedPoll(trx, ctx, request.id)
    requireHostRevision(poll, request.expectedHostRevision)
    const deleted = await trx
      .deleteFrom('meeting_polls')
      .where('id', '=', poll.id)
      .where('organization_id', '=', poll.organization_id)
      .where('host_revision', '=', poll.host_revision)
      .executeTakeFirstOrThrow()
    if (deleted.numDeletedRows !== 1n) throw changed()
  })
}

/**
 * Replace a public-link poll's capability; the old link stops working at commit. Invited
 * polls have no public link. A matching retry reports the earlier rotation without a link.
 */
export async function rotateMeetingPollLink(
  ctx: ServiceContext,
  input: RotateMeetingPollLinkInput,
): Promise<MeetingPollWithLink> {
  requireWriteScope(ctx)
  const request = validHostWrite(input)
  const key = validIdempotencyKey(input.idempotencyKey)
  return ctx.db.transaction().execute(async (trx) => {
    const poll = await lockManagedPoll(trx, ctx, request.id)
    const receipt = receiptIdentity(ctx, 'rotate_link', key, {
      pollId: poll.id.toLowerCase(),
      expectedHostRevision: request.expectedHostRevision,
    })
    // A lost successful response stays recoverable after the revision has advanced.
    const previous = await lockedReceipt(trx, receipt)
    if (previous) {
      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()
      throw new DomainError(
        'conflict',
        'poll_link_already_rotated',
        'This rotation already happened. Its link was shown once; rotate again with a new key.',
      )
    }
    if (poll.admission_mode !== 'public_link')
      throw new DomainError(
        'conflict',
        'poll_link_unavailable',
        'Invited polls have no public link',
      )
    requireHostRevision(poll, request.expectedHostRevision)
    const publicToken = randomBytes(32).toString('base64url')
    await hostWrite(trx, poll, { public_token_digest: meetingPollPublicTokenDigest(publicToken) })
    await insertReceipt(trx, receipt, poll.id, poll.at)
    return { poll: await loadPoll(trx, ctx, poll.id), publicToken }
  })
}

// --- Authority -----------------------------------------------------------------------------

export interface Authority {
  personal: boolean
  userId: string
}

export function requireWriteScope(ctx: ServiceContext) {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'read')
    throw new ApiKeyScopeError()
}

/**
 * Current verified membership, rechecked on every read, write and replay. A personal space
 * is managed by its own user; a team only by its current owners and admins. Ordinary
 * members, including configured hosts, receive the same refusal for every poll ID.
 */
export async function lockAuthority(db: Db, ctx: ServiceContext): Promise<Authority> {
  const { principal } = ctx
  if (!isUuid(principal.user.id) || !isUuid(principal.organization.id)) throw denied()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', principal.organization.id)
    .executeTakeFirst()
  if (personal && personal.user_id !== principal.user.id) throw denied()
  const actor = await db
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!actor?.emailVerified) throw denied()
  const organization = await db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', principal.organization.id)
    .forShare()
    .executeTakeFirst()
  if (!organization) throw denied()
  const membership = await db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', principal.organization.id)
    .where('userId', '=', principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!membership) throw denied()
  const roles = membership.role.split(',').map((role) => role.trim())
  if (!personal && !roles.includes('owner') && !roles.includes('admin')) throw denied()
  if (principal.kind === 'api_key') await requireActiveApiKey(db, principal, Date.now)
  return { personal: personal !== undefined, userId: principal.user.id }
}

/** A personal space manages its owner's events; a team manages its team events. */
export function manages(authority: Authority, ownerUserId: string | null) {
  return authority.personal ? ownerUserId === authority.userId : ownerUserId === null
}

export interface LockedPoll {
  id: string
  organization_id: string
  status: string
  effectiveStatus: MeetingPollStatus
  admission_mode: string
  host_revision: number
  display_time_zone: string
  /** The event was soft-deleted: history stays, new voter admission stops. */
  eventDeleted: boolean
  deadline: string
  /** Database clock captured once after the poll and event locks. */
  at: string
}

/** Lock the poll before its event (the host phase), then capture the database clock. */
export async function lockManagedPoll(
  trx: Db,
  ctx: ServiceContext,
  id: string,
): Promise<LockedPoll> {
  await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)
  const authority = await lockAuthority(trx, ctx)
  if (!isUuid(id)) throw pollNotFound()
  const poll = await trx
    .selectFrom('meeting_polls')
    .select([
      'id',
      'organization_id',
      'event_type_id',
      'status',
      'admission_mode',
      'host_revision',
      'display_time_zone',
    ])
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .forUpdate()
    .executeTakeFirst()
  if (!poll) throw pollNotFound()
  const event = await trx
    .selectFrom('event_types')
    .select(['owner_user_id', 'deleted_at'])
    .where('id', '=', poll.event_type_id)
    .where('organization_id', '=', poll.organization_id)
    .forShare()
    .executeTakeFirst()
  if (!event || !manages(authority, event.owner_user_id)) throw pollNotFound()
  // One clock reading decides the deadline and timestamps this write.
  const { rows } = await sql<{ at: string; deadline: string; deadlinePassed: boolean }>`
    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
    SELECT to_char(decision.t AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS at,
      to_char(poll.deadline_at AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS deadline,
      poll.deadline_at <= decision.t AS "deadlinePassed"
    FROM meeting_polls AS poll CROSS JOIN decision
    WHERE poll.id = ${poll.id}`.execute(trx)
  const { at, deadline, deadlinePassed } = rows[0] as (typeof rows)[number]
  return {
    id: poll.id,
    organization_id: poll.organization_id,
    status: poll.status,
    effectiveStatus:
      poll.status === 'open' && deadlinePassed ? 'closed' : (poll.status as MeetingPollStatus),
    admission_mode: poll.admission_mode,
    host_revision: poll.host_revision,
    display_time_zone: poll.display_time_zone,
    eventDeleted: event.deleted_at !== null,
    deadline,
    at,
  }
}

export function requireHostRevision(poll: LockedPoll, expected: number) {
  if (poll.host_revision !== expected) throw changed()
}

export const alreadyScheduled = () =>
  new DomainError(
    'conflict',
    'poll_already_scheduled',
    'This poll is scheduled. Reschedule or cancel its booking instead.',
  )

/** Compare-and-set one accepted host write; settings columns are never written here. */
async function hostWrite(
  trx: Db,
  poll: LockedPoll,
  changes: {
    status?: 'closed' | 'canceled'
    closed_at?: string
    canceled_at?: string
    public_token_digest?: Buffer
  },
) {
  for (const column of Object.keys(changes))
    if (!HOST_WRITE_COLUMNS.has(column))
      throw new TypeError(`Poll column ${column} is fixed at creation`)
  const updated = await trx
    .updateTable('meeting_polls')
    .set({ ...changes, host_revision: poll.host_revision + 1, updated_at: poll.at })
    .where('id', '=', poll.id)
    .where('organization_id', '=', poll.organization_id)
    .where('host_revision', '=', poll.host_revision)
    .returning('id')
    .executeTakeFirst()
  if (!updated) throw changed()
}

function pollSource(ctx: ServiceContext, requested: 'api' | 'mcp' | undefined) {
  const { principal } = ctx
  if (principal.kind === 'session') return 'web'
  if (principal.kind === 'oauth') return 'mcp'
  if (requested !== undefined && requested !== 'api' && requested !== 'mcp')
    throw new TypeError('An API-key poll source is api or mcp')
  return requested ?? 'api'
}

// --- Receipts ------------------------------------------------------------------------------

export interface ReceiptIdentity {
  organizationId: string
  operation: 'create' | 'invite' | 'resend' | 'rotate_link'
  actor: Buffer
  key: Buffer
  fingerprint: Buffer
}

/** Scope: organization, operation and actor (session user, API key or OAuth grant). */
export function receiptIdentity(
  ctx: ServiceContext,
  operation: ReceiptIdentity['operation'],
  key: string,
  request: Record<string, unknown>,
): ReceiptIdentity {
  const { principal } = ctx
  const actor =
    principal.kind === 'api_key'
      ? { kind: 'api_key', id: principal.apiKeyId.toLowerCase() }
      : principal.kind === 'oauth'
        ? { kind: 'oauth', id: principal.oauthConsentId.toLowerCase() }
        : { kind: 'session', id: principal.user.id.toLowerCase() }
  return {
    organizationId: principal.organization.id,
    operation,
    actor: sha256('actor', canonicalJson(actor)),
    key: sha256('idempotency-key', key),
    fingerprint: sha256(`request.${operation}`, canonicalJson(request)),
  }
}

/** Serialize concurrent retries of one key before reading its receipt. */
export async function lockedReceipt(trx: Db, receipt: ReceiptIdentity) {
  const scope = `hourmere.meeting-poll-receipt:${receipt.organizationId}:${receipt.operation}:${receipt.actor.toString('hex')}:${receipt.key.toString('hex')}`
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`.execute(trx)
  return trx
    .selectFrom('meeting_poll_operations')
    .select(['poll_id', 'request_fingerprint'])
    .where('organization_id', '=', receipt.organizationId)
    .where('operation', '=', receipt.operation)
    .where('actor_scope_digest', '=', receipt.actor)
    .where('idempotency_key_digest', '=', receipt.key)
    .executeTakeFirst()
}

export async function insertReceipt(trx: Db, receipt: ReceiptIdentity, pollId: string, at: string) {
  await trx
    .insertInto('meeting_poll_operations')
    .values({
      organization_id: receipt.organizationId,
      poll_id: pollId,
      operation: receipt.operation,
      actor_scope_digest: receipt.actor,
      idempotency_key_digest: receipt.key,
      request_fingerprint: receipt.fingerprint,
      created_at: at,
      updated_at: at,
    })
    .execute()
}

// --- Validation ----------------------------------------------------------------------------

function validCreateInput(input: CreateMeetingPollInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalidPoll('The poll must be an object')
  for (const field of Object.keys(input)) {
    if (TOKEN_FIELDS.has(field))
      throw new DomainError(
        'invalid',
        'poll_event_unsupported',
        'Polls cannot use one-time links or other booking capabilities',
      )
    if (!CREATE_FIELDS.has(field)) throw invalidPoll(`Unknown poll field ${field}`)
  }
  if (!isUuid(input.eventTypeId)) throw eventNotFound()
  const key = validIdempotencyKey(input.idempotencyKey)
  if (!Array.isArray(input.candidateStarts))
    throw invalidPoll('candidateStarts must be a list of instants')
  if (input.candidateStarts.length > MEETING_POLL_LIMITS.maxCandidates)
    throw new DomainError(
      'invalid',
      'poll_limit_exceeded',
      `A poll can offer at most ${MEETING_POLL_LIMITS.maxCandidates} candidate times`,
    )
  if (input.candidateStarts.length < MEETING_POLL_LIMITS.minCandidates)
    throw invalidPoll(`A poll needs at least ${MEETING_POLL_LIMITS.minCandidates} candidate times`)
  const candidates = input.candidateStarts.map((value) => instantText(value, 'candidateStarts'))
  if (
    input.durationMinutes !== undefined &&
    (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1)
  )
    throw new DomainError(
      'invalid',
      'invalid_duration',
      'durationMinutes must be a positive integer',
    )
  if (input.admissionMode !== 'public_link' && input.admissionMode !== 'invited')
    throw invalidPoll('admissionMode must be public_link or invited')
  const visibility = input.visibility ?? 'private'
  if (visibility !== 'private' && visibility !== 'aggregate')
    throw invalidPoll('visibility must be private or aggregate')
  return {
    eventTypeId: input.eventTypeId,
    candidates,
    durationMinutes: input.durationMinutes,
    deadlineAt: instantText(input.deadlineAt, 'deadlineAt'),
    displayTimeZone: validTimeZone(input.displayTimeZone, 'displayTimeZone'),
    admissionMode: input.admissionMode,
    visibility,
    idempotencyKey: key,
  }
}

export function validHostWrite(input: MeetingPollHostWriteInput) {
  if (!input || typeof input !== 'object') throw invalidPoll('The request must be an object')
  if (
    !Number.isSafeInteger(input.expectedHostRevision) ||
    (input.expectedHostRevision as number) < 1
  )
    throw invalidPoll('expectedHostRevision must be a positive integer')
  return { id: input.id, expectedHostRevision: input.expectedHostRevision }
}

export function validIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new DomainError(
      'invalid',
      'invalid_idempotency_key',
      'Idempotency-Key must be 1 to 255 printable ASCII characters.',
    )
  return key
}

/** An instant with an explicit offset; local times without one are ambiguous. */
function instantText(value: unknown, field: string): string {
  const message = `${field} must contain RFC 3339 instants with an explicit offset`
  if (typeof value !== 'string' || value.length > 64) throw invalidPoll(message)
  let instant: Temporal.Instant
  try {
    instant = Temporal.Instant.from(value)
  } catch {
    throw invalidPoll(message)
  }
  if (instant.epochMilliseconds < EARLIEST || instant.epochMilliseconds > LATEST)
    throw invalidPoll(message)
  return instant.toString()
}

/** Round to stored microseconds in the database itself, so fingerprints match storage. */
async function normalizeInstants(trx: Db, values: readonly string[]): Promise<string[]> {
  const rows = await sql<{ value: string }>`
    SELECT to_char(input.value::timestamptz AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS value
    FROM unnest(${values}::text[]) WITH ORDINALITY AS input(value, ordinal)
    ORDER BY input.ordinal`.execute(trx)
  try {
    return rows.rows.map((row) => rfc3339(row.value))
  } catch {
    throw invalidPoll('Instants must fall within years 0001 to 9999')
  }
}

async function clock(trx: Db): Promise<string> {
  const { at } = await trx.selectNoFrom(databaseClock.as('at')).executeTakeFirstOrThrow()
  return rfc3339(at)
}

function compareInstants(a: string, b: string) {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b))
}

/**
 * Deadline 1 hour–30 days after creation, inclusive, as elapsed time; every candidate
 * starts after the deadline with at least the event's current minimum notice.
 */
function validateSchedule(
  createdAt: string,
  deadlineAt: string,
  starts: readonly string[],
  minimumNoticeMinutes: number,
) {
  const created = Temporal.Instant.from(createdAt).epochNanoseconds
  const deadline = Temporal.Instant.from(deadlineAt).epochNanoseconds
  const elapsed = deadline - created
  if (
    elapsed < BigInt(MEETING_POLL_LIMITS.minDeadlineSeconds) * SECOND_NS ||
    elapsed > BigInt(MEETING_POLL_LIMITS.maxDeadlineSeconds) * SECOND_NS
  )
    throw invalidPoll('deadlineAt must be from 1 hour to 30 days from now')
  const earliest = Temporal.Instant.from(starts[0] as string).epochNanoseconds
  const notice = BigInt(minimumNoticeMinutes) * MINUTE_NS
  if (earliest <= deadline || earliest - deadline < notice)
    throw invalidPoll(
      'Every candidate must start after deadlineAt, leaving the event’s minimum notice',
    )
}

type BookableEvent = NonNullable<Awaited<ReturnType<typeof findOneTimeEventType>>>

/**
 * ID-addressed booking's resolution under lock: host eligibility, then the host users and
 * members FOR SHARE. Call while holding the booking locks of `lockedHostUserIds`, the
 * hosts named before the event share lock; a host set that changed meanwhile conflicts.
 */
async function lockBookableEvent(
  trx: Db,
  eventTypeId: string,
  lockedHostUserIds: readonly string[],
): Promise<BookableEvent> {
  let event: Awaited<ReturnType<typeof findOneTimeEventType>>
  try {
    // ID-addressed booking's resolution, host eligibility and host user/member locks.
    event = await findOneTimeEventType(trx, eventTypeId, { lock: true })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'booking_changed') throw eventChanged()
    throw error
  }
  if (!event)
    throw new DomainError(
      'conflict',
      'event_type_unavailable',
      'This event type does not take bookings right now',
    )
  if (event.hostUserIds.join() !== lockedHostUserIds.join()) throw eventChanged()
  return event
}

/**
 * Every candidate must be a slot the availability engine offers at the creation instant,
 * exactly as public booking checks a start: the hosts' schedules and date overrides,
 * calendar busy time, confirmed bookings and live payment holds, minimum notice, booking
 * window, buffers and booking limits. Individual and collective events need every host
 * free; round-robin events need one eligible pool host. Collective hosts use their default
 * schedules, as public booking does.
 */
async function requireBookableCandidates(
  trx: Db,
  event: BookableEvent,
  starts: readonly string[],
  durationMinutes: number,
  createdAt: string,
) {
  const now = Temporal.Instant.from(createdAt)
  const unavailable: string[] = []
  for (const start of starts) {
    const from = Temporal.Instant.from(start)
    const to = from.add({ minutes: durationMinutes })
    const offered =
      event.schedulingType === 'round_robin'
        ? await unionRoundRobinSlots(
            trx,
            event.id,
            event.eligibleHostUserIds,
            from,
            to,
            now,
            durationMinutes,
          )
        : await intersectSlots(
            trx,
            event.id,
            event.hostUserIds,
            from,
            to,
            now,
            undefined,
            event.schedulingType === 'collective',
            durationMinutes,
          )
    if (
      !offered.some(
        (slot) =>
          Temporal.Instant.from(slot.start).equals(from) &&
          Temporal.Instant.from(slot.end).equals(to),
      )
    )
      unavailable.push(start)
  }
  if (unavailable.length > 0) throw new MeetingPollSlotUnavailableError(unavailable)
}

// --- Projection ----------------------------------------------------------------------------

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const invalid = () => new DomainError('invalid', 'invalid_cursor', 'cursor is not valid')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid()
  const [createdAt, id] = parsed
  if (typeof createdAt !== 'string' || !isUuid(id)) throw invalid()
  try {
    const instant = Temporal.Instant.from(createdAt)
    if (instant.epochMilliseconds < EARLIEST || instant.epochMilliseconds > LATEST) throw invalid()
    return { createdAt: instant.toString(), id }
  } catch {
    throw invalid()
  }
}

export async function loadPoll(trx: Db, ctx: ServiceContext, id: string): Promise<MeetingPoll> {
  const [poll] = await loadPolls(trx, ctx, [id])
  if (!poll) throw pollNotFound()
  return poll
}

async function loadPolls(trx: Db, ctx: ServiceContext, ids: string[]): Promise<MeetingPoll[]> {
  if (ids.length === 0) return []
  const rows = await trx
    .with(
      (cte) => cte('poll_clock').materialized(),
      (db) => db.selectNoFrom(sql<Date>`clock_timestamp()`.as('t')),
    )
    .selectFrom(['meeting_polls', 'poll_clock'])
    .select([
      'id',
      'organization_id',
      'event_type_id',
      'title',
      'duration_minutes',
      'display_time_zone',
      'admission_mode',
      'visibility',
      'status',
      'chosen_slot_id',
      'booking_id',
      'host_revision',
      'created_by_user_id',
      'source',
      utc('deadline_at').as('deadline'),
      utcNullable('canceled_at').as('canceled'),
      utcNullable('scheduled_at').as('scheduled'),
      utc('created_at').as('created'),
      utc('updated_at').as('updated'),
      // Reads derive deadline closure from one database clock reading, even before a
      // worker persists it.
      sql<boolean>`status = 'open' AND deadline_at <= poll_clock.t`.as('deadlinePassed'),
      sql<string | null>`to_char(CASE WHEN status = 'open' AND deadline_at <= poll_clock.t
        THEN deadline_at ELSE closed_at END AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`.as(
        'closed',
      ),
    ])
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('id', 'in', ids)
    .execute()
  const slots = await trx
    .selectFrom('meeting_poll_slots')
    .select(['id', 'poll_id', 'position', utc('start_at').as('start'), utc('end_at').as('end')])
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('poll_id', 'in', ids)
    .orderBy('poll_id')
    .orderBy('position')
    .execute()
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    return [
      {
        id: row.id,
        organizationId: row.organization_id,
        eventTypeId: row.event_type_id,
        title: row.title,
        durationMinutes: row.duration_minutes,
        displayTimeZone: row.display_time_zone,
        admissionMode: row.admission_mode as MeetingPollAdmissionMode,
        visibility: row.visibility as MeetingPollVisibility,
        deadlineAt: rfc3339(row.deadline),
        status: row.deadlinePassed ? 'closed' : (row.status as MeetingPollStatus),
        closedAt: optional(row.closed),
        canceledAt: optional(row.canceled),
        scheduledAt: optional(row.scheduled),
        chosenSlotId: row.chosen_slot_id,
        bookingId: row.booking_id,
        hostRevision: row.host_revision,
        createdByUserId: row.created_by_user_id,
        source: row.source as MeetingPoll['source'],
        createdAt: rfc3339(row.created),
        updatedAt: rfc3339(row.updated),
        candidates: slots
          .filter((slot) => slot.poll_id === id)
          .map((slot) => ({
            id: slot.id,
            startAt: rfc3339(slot.start),
            endAt: rfc3339(slot.end),
            position: slot.position,
          })),
      },
    ]
  })
}

const optional = (value: string | null) => (value === null ? null : rfc3339(value))
