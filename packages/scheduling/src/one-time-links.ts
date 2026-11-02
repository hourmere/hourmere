import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiKeyScopeError, requireActiveApiKey } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import { type Selectable, sql, type Transaction } from 'kysely'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { isConstraintViolation, isUuid, SQLSTATE, timestamp } from './internal.ts'
import { cleanText } from './text.ts'

/** Active, unexpired links per personal owner or team organization. */
export const ONE_TIME_BOOKING_LINK_LIMIT = 1000
/** Ordinary team members share this sub-limit across all of their team event types. */
export const ONE_TIME_BOOKING_LINK_MEMBER_LIMIT = 200
export const ONE_TIME_LINK_ALREADY_CREATED_MESSAGE =
  'This link was already created. Its URL was shown once and cannot be retrieved. List your links to find its metadata; revoke it before creating a replacement with a new key.'

export type OneTimeBookingLinkState = 'active' | 'used' | 'expired' | 'revoked'

/** Convenience form values only; possessing them never proves invitee identity. */
export interface OneTimeBookingLinkPrefill {
  name: string | null
  email: string | null
}

export interface OneTimeBookingLink {
  id: string
  organizationId: string
  eventTypeId: string
  creatorUserId: string
  expiresAt: string | null
  prefill: OneTimeBookingLinkPrefill
  state: OneTimeBookingLinkState
  bookingId: string | null
  usedAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateOneTimeBookingLinkInput {
  eventTypeId: string
  idempotencyKey?: string | undefined
  expiresAt?: string | null | undefined
  prefill?: { name?: string | null | undefined; email?: string | null | undefined } | undefined
}

/** Resolution exposes no credential digest or private administrative history. */
export type ResolvedOneTimeBookingLink = Pick<
  OneTimeBookingLink,
  'id' | 'organizationId' | 'eventTypeId' | 'prefill'
>

type LinkRow = Selectable<Database['one_time_booking_links']>
type MetadataRow = Omit<LinkRow, 'token_hash'>
const metadataColumns = [
  'id',
  'organization_id',
  'event_type_id',
  'creator_user_id',
  'expires_at',
  'prefill_name',
  'prefill_email',
  'state',
  'booking_id',
  'used_at',
  'revoked_at',
  'created_at',
  'updated_at',
] as const
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DUMMY_HASH = createHash('sha256').update('hourmere-one-time-link-miss').digest()
const linkNotFound = () => new DomainError('not_found', 'one_time_link_not_found')
const eventNotFound = () => new DomainError('not_found', 'event_type_not_found')
const insufficientRole = () => new DomainError('forbidden', 'insufficient_role')
const invalid = () => new DomainError('invalid', 'invalid_one_time_link')

/** Return the raw capability only here; every persisted value is its SHA-256 digest. */
export async function createOneTimeBookingLink(
  ctx: ServiceContext,
  input: CreateOneTimeBookingLinkInput,
): Promise<OneTimeBookingLink & { token: string }> {
  requireWriteScope(ctx)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
  if (!isUuid(input.eventTypeId)) throw eventNotFound()
  const expiresAt = validExpiry(input.expiresAt)
  const prefill = validPrefill(input.prefill)
  const id = idempotentLinkId(ctx, input.idempotencyKey)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, input.eventTypeId)
    await lockWriteOwner(trx, ctx)
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.one-time-links:${ctx.principal.organization.id}`}, 0))`.execute(
      trx,
    )
    const event = await authorizedEvent(trx, ctx, input.eventTypeId)
    if (!event.is_active || event.deleted_at !== null)
      throw new DomainError('invalid', 'event_type_inactive')
    if (ctx.principal.kind === 'api_key') await requireActiveApiKey(trx, ctx.principal, Date.now)
    if (id !== undefined) {
      const previous = await trx
        .selectFrom('one_time_booking_links')
        .select(metadataColumns)
        .where('id', '=', id)
        .where('organization_id', '=', event.organization_id)
        .executeTakeFirst()
      if (previous) {
        const same =
          previous.event_type_id === event.id &&
          previous.creator_user_id === ctx.principal.user.id &&
          (previous.expires_at === null ? null : timestamp(previous.expires_at)) === expiresAt &&
          previous.prefill_name === prefill.name &&
          previous.prefill_email === prefill.email
        if (!same)
          throw new DomainError(
            'conflict',
            'idempotency_key_reused',
            'This Idempotency-Key was already used for a different request.',
          )
        throw new DomainError(
          'conflict',
          'one_time_link_already_created',
          ONE_TIME_LINK_ALREADY_CREATED_MESSAGE,
        )
      }
    }
    if (expiresAt !== null) {
      const { future } = await trx
        .selectNoFrom(sql<boolean>`${expiresAt}::timestamptz > clock_timestamp()`.as('future'))
        .executeTakeFirstOrThrow()
      if (!future) throw invalid()
    }
    const { count, creatorCount } = await trx
      .selectFrom('one_time_booking_links')
      .select((eb) => [
        eb.fn.countAll<string>().as('count'),
        eb.fn
          .countAll<string>()
          .filterWhere('creator_user_id', '=', ctx.principal.user.id)
          .as('creatorCount'),
      ])
      .where('organization_id', '=', event.organization_id)
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
      )
      .executeTakeFirstOrThrow()
    if (Number(count) >= ONE_TIME_BOOKING_LINK_LIMIT)
      throw new DomainError('conflict', 'one_time_link_limit_reached')
    if (event.memberLimited && Number(creatorCount) >= ONE_TIME_BOOKING_LINK_MEMBER_LIMIT)
      throw new DomainError('conflict', 'one_time_link_limit_reached')
    const token = randomBytes(32).toString('base64url')
    const row = await trx
      .insertInto('one_time_booking_links')
      .values({
        ...(id === undefined ? {} : { id }),
        organization_id: event.organization_id,
        event_type_id: event.id,
        creator_user_id: ctx.principal.user.id,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        prefill_name: prefill.name,
        prefill_email: prefill.email,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ...toLink(row, false), token }
  })
}

/** Administrative reads never select a credential digest, even internally. */
export async function listOneTimeBookingLinks(
  ctx: ServiceContext,
  input: { eventTypeId: string; limit?: number | undefined; after?: string | undefined },
): Promise<{ data: OneTimeBookingLink[]; nextAfter: string | null }> {
  requireReadScope(ctx)
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError('invalid', 'invalid_limit')
  if (input.after !== undefined && !isUuid(input.after))
    throw new DomainError('invalid', 'invalid_cursor')
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeAdminRead(trx, ctx, input.eventTypeId)
    const rows = await metadataQuery(trx, ctx, input.eventTypeId)
      .$if(input.after !== undefined, (query) => query.where('id', '<', input.after as string))
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()
    const data = rows.slice(0, limit).map((row) => toLink(row, row.expired))
    return { data, nextAfter: rows.length > limit ? (data.at(-1)?.id ?? null) : null }
  })
}

export async function getOneTimeBookingLink(
  ctx: ServiceContext,
  input: { eventTypeId: string; id: string },
): Promise<OneTimeBookingLink> {
  requireReadScope(ctx)
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeAdminRead(trx, ctx, input.eventTypeId)
    const row = await metadataQuery(trx, ctx, input.eventTypeId)
      .where('id', '=', isUuid(input.id) ? input.id : '00000000-0000-0000-0000-000000000000')
      .executeTakeFirst()
    if (!row) throw linkNotFound()
    return toLink(row, row.expired)
  })
}

/** An authorized terminal link reports its unchanged state; unrelated IDs stay opaque. */
export async function revokeManagedOneTimeBookingLink(
  ctx: ServiceContext,
  input: { eventTypeId: string; id: string },
): Promise<OneTimeBookingLink | null> {
  requireWriteScope(ctx)
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, input.eventTypeId)
    await authorizeAdminRead(trx, ctx, input.eventTypeId)
    const row = await metadataQuery(trx, ctx, input.eventTypeId)
      .where('id', '=', isUuid(input.id) ? input.id : '00000000-0000-0000-0000-000000000000')
      .forUpdate()
      .executeTakeFirst()
    if (!row) return null
    if (row.state === 'active' && !row.expired) {
      await trx
        .updateTable('one_time_booking_links')
        .set({ revoked_at: sql<Date>`clock_timestamp()`, state: 'revoked' })
        .where('id', '=', row.id)
        .where('state', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('expires_at', 'is', null),
            eb('expires_at', '>', sql<Date>`clock_timestamp()`),
          ]),
        )
        .execute()
    }
    const current = await metadataQuery(trx, ctx, input.eventTypeId)
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()
    return toLink(current, current.expired)
  })
}

async function authorizeAdminRead(db: Db, ctx: ServiceContext, eventTypeId: string) {
  if (!isUuid(eventTypeId)) throw eventNotFound()
  await lockWriteOwner(db, ctx)
  await authorizedEvent(db, ctx, eventTypeId)
  if (ctx.principal.kind === 'api_key') await requireActiveApiKey(db, ctx.principal, Date.now)
}

function metadataQuery(db: Db, ctx: ServiceContext, eventTypeId: string) {
  return db
    .selectFrom('one_time_booking_links')
    .select(metadataColumns)
    .select(sql<boolean>`expires_at IS NOT NULL AND expires_at <= clock_timestamp()`.as('expired'))
    .where('event_type_id', '=', eventTypeId)
    .where('organization_id', '=', ctx.principal.organization.id)
}

function requireReadScope(ctx: ServiceContext) {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'bookings')
    throw new ApiKeyScopeError()
}

/** A durable retry marker without retaining another secret or adding a storage column. */
function idempotentLinkId(ctx: ServiceContext, key: string | undefined): string | undefined {
  if (key === undefined) return undefined
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key))
    throw new DomainError(
      'invalid',
      'invalid_idempotency_key',
      'Idempotency-Key must be 1 to 255 printable ASCII characters.',
    )
  const actor = ctx.principal
  const credential =
    actor.kind === 'api_key'
      ? actor.apiKeyId
      : actor.kind === 'oauth'
        ? actor.oauthConsentId
        : actor.sessionId
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'hourmere.one-time-link-create.v1',
        actor.organization.id,
        actor.user.id,
        actor.kind,
        credential,
        key,
      ]),
    )
    .digest()
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Unknown and every unusable capability have the same public result. */
export async function resolveOneTimeBookingLink(
  ctx: Pick<PublicContext, 'db'>,
  token: string | undefined,
): Promise<ResolvedOneTimeBookingLink> {
  // Resolve eligibility in the digest lookup itself: unknown, inactive and terminal
  // links all execute this one query rather than taking state-dependent read paths.
  const live = await lookupToken(ctx.db, token, true)
  if (!live) throw linkNotFound()
  return {
    id: live.id,
    organizationId: live.organization_id,
    eventTypeId: live.event_type_id,
    prefill: { name: live.prefill_name, email: live.prefill_email },
  }
}

/**
 * Retire an eligible link without exposing its existence or state. Unknown, foreign,
 * inaccessible and already terminal IDs all receive the same empty acknowledgement.
 * Current principal, organization and API-key checks still apply to every request.
 */
export async function revokeOneTimeBookingLink(ctx: ServiceContext, id: string): Promise<void> {
  requireWriteScope(ctx)
  const candidateId = isUuid(id) ? id : '00000000-0000-0000-0000-000000000000'
  await ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)
    const personal = await lockWriteOwner(trx, ctx)
    if (ctx.principal.kind === 'api_key') await requireActiveApiKey(trx, ctx.principal, Date.now)
    const membership = await trx
      .selectFrom('auth.member')
      .select('role')
      .where('organizationId', '=', ctx.principal.organization.id)
      .where('userId', '=', ctx.principal.user.id)
      .forShare()
      .executeTakeFirst()
    const roles = membership?.role.split(',').map((role) => role.trim()) ?? []
    const teamManager = !personal && (roles.includes('owner') || roles.includes('admin'))
    // All IDs use the same authorization and conditional-write query. Filter before
    // locking the event, so absent and terminal links take the same no-op path.
    await trx
      .with('manageable_event', (db) =>
        db
          .selectFrom('event_types')
          .innerJoin('one_time_booking_links as link', 'link.event_type_id', 'event_types.id')
          .select('event_types.id')
          .where('link.id', '=', candidateId)
          .where('link.state', '=', 'active')
          .where((eb) =>
            eb.or([
              eb('link.expires_at', 'is', null),
              eb('link.expires_at', '>', sql<Date>`clock_timestamp()`),
            ]),
          )
          .where('event_types.organization_id', '=', ctx.principal.organization.id)
          .where(sql<boolean>`${membership !== undefined}`)
          .where((eb) =>
            eb.or([
              eb('event_types.owner_user_id', '=', ctx.principal.user.id),
              ...(teamManager ? [eb('event_types.owner_user_id', 'is', null)] : []),
            ]),
          )
          .forShare('event_types'),
      )
      .updateTable('one_time_booking_links')
      .set({ state: 'revoked', revoked_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', candidateId)
      .where('event_type_id', 'in', (eb) => eb.selectFrom('manageable_event').select('id'))
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
      )
      .execute()
  })
}

/**
 * Consume only for a booking inserted by this top-level transaction (not a savepoint).
 * A previously committed booking cannot claim a link, even after an update. Let failures
 * abort that transaction; rollback restores both the booking and its link together.
 * Cancellation and rescheduling never transition a used link back to active.
 */
export async function claimOneTimeBookingLink(
  trx: Transaction<Database>,
  token: string | undefined,
  bookingId: string,
): Promise<OneTimeBookingLink> {
  if (!trx.isTransaction) throw new TypeError('A booking transaction is required')
  const initial = await lookupToken(trx, token)
  if (!initial || !isUuid(bookingId)) throw linkNotFound()
  try {
    await lockOrganization(trx, initial.organization_id)
  } catch (error) {
    if (error instanceof DomainError) throw linkNotFound()
    throw error
  }
  if (!(await publicEvent(trx, initial.event_type_id, true))) throw linkNotFound()
  const booking = await trx
    .selectFrom('bookings')
    .select('id')
    .where('id', '=', bookingId)
    .where('organization_id', '=', initial.organization_id)
    .where('event_type_id', '=', initial.event_type_id)
    .where('status', '=', 'confirmed')
    .where(sql<boolean>`xmin = pg_current_xact_id()::xid`)
    .where('created_at', '=', sql<Date>`transaction_timestamp()`)
    .forShare()
    .executeTakeFirst()
  if (!booking) throw linkNotFound()
  // Lock before reading wall time: a competing claim may have held the row past expiry.
  const locked = await trx
    .selectFrom('one_time_booking_links')
    .select('id')
    .where('id', '=', initial.id)
    .forUpdate()
    .executeTakeFirst()
  if (!locked) throw linkNotFound()
  try {
    const claimed = await trx
      .updateTable('one_time_booking_links')
      .set({ state: 'used', booking_id: bookingId, used_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', locked.id)
      .where('state', '=', 'active')
      .where((eb) =>
        eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`clock_timestamp()`)]),
      )
      .returningAll()
      .executeTakeFirst()
    if (!claimed) throw linkNotFound()
    return toLink(claimed, false)
  } catch (error) {
    if (
      isConstraintViolation(
        error,
        SQLSTATE.uniqueViolation,
        'one_time_booking_links_booking_id_key',
      ) ||
      isClaimGuardViolation(error)
    )
      throw linkNotFound()
    throw error
  }
}

function requireWriteScope(ctx: ServiceContext) {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'read')
    throw new ApiKeyScopeError()
}

/** Share locks preserve account/departure ordering without blocking FK inserts. */
async function lockWriteOwner(db: Db, ctx: ServiceContext) {
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (personal && personal.user_id !== ctx.principal.user.id) throw insufficientRole()
  const actor = await db
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', ctx.principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!actor?.emailVerified) throw insufficientRole()
  const organization = await db
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', ctx.principal.organization.id)
    .forShare()
    .executeTakeFirst()
  if (!organization) throw eventNotFound()
  return personal
}

async function authorizedEvent(db: Db, ctx: ServiceContext, eventTypeId: string) {
  const membership = await db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', ctx.principal.organization.id)
    .where('userId', '=', ctx.principal.user.id)
    .forShare()
    .executeTakeFirst()
  if (!membership) throw insufficientRole()
  const event = await db
    .selectFrom('event_types')
    .select(['id', 'organization_id', 'owner_user_id', 'is_active', 'deleted_at'])
    .where('id', '=', eventTypeId)
    .where('organization_id', '=', ctx.principal.organization.id)
    .forShare()
    .executeTakeFirst()
  if (!event || (event.owner_user_id !== null && event.owner_user_id !== ctx.principal.user.id))
    throw eventNotFound()
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', event.organization_id)
    .executeTakeFirst()
  if (personal && event.owner_user_id !== personal.user_id) throw eventNotFound()
  const roles = membership.role.split(',').map((role) => role.trim())
  if (event.owner_user_id === null && !roles.includes('owner') && !roles.includes('admin'))
    throw insufficientRole()
  return {
    ...event,
    memberLimited: !personal && !roles.includes('owner') && !roles.includes('admin'),
  }
}

/** Hidden types are deliberately eligible; current ownership and membership still apply. */
async function publicEvent(db: Db, eventTypeId: string, lock = false) {
  const query = db
    .selectFrom('event_types')
    .select(['organization_id', 'owner_user_id', 'is_active', 'deleted_at'])
    .where('id', '=', eventTypeId)
  let event = await query.executeTakeFirst()
  if (!event?.is_active || event.deleted_at !== null) return false
  // Account deletion locks the owner before cascading its event types. Take the
  // same order, then reread the event so an ownership change cannot escape the lock.
  const ownerId = event.owner_user_id
  if (ownerId !== null) {
    let ownerQuery = db.selectFrom('auth.user').select('emailVerified').where('id', '=', ownerId)
    if (lock) ownerQuery = ownerQuery.forShare()
    if (!(await ownerQuery.executeTakeFirst())?.emailVerified) return false
  }
  if (lock) {
    event = await query.forShare().executeTakeFirst()
    if (!event?.is_active || event.deleted_at !== null || event.owner_user_id !== ownerId)
      return false
  }
  const personal = await db
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', event.organization_id)
    .executeTakeFirst()
  if (personal && event.owner_user_id !== personal.user_id) return false
  if (event.owner_user_id !== null) {
    let memberQuery = db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', event.organization_id)
      .where('userId', '=', event.owner_user_id)
    if (lock) memberQuery = memberQuery.forShare()
    if (!(await memberQuery.executeTakeFirst())) return false
  }
  return true
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** One indexed digest lookup, followed by equal-length constant-time comparison on misses too. */
async function lookupToken(db: Db, token: string | undefined, activePublic = false) {
  const valid = typeof token === 'string' && TOKEN.test(token)
  const hash = hashToken(valid ? token : '')
  let query = db
    .selectFrom('one_time_booking_links')
    .selectAll('one_time_booking_links')
    .where('token_hash', '=', hash)
  if (activePublic) {
    query = query
      .innerJoin('event_types as event', 'event.id', 'one_time_booking_links.event_type_id')
      .leftJoin('auth.user as owner', 'owner.id', 'event.owner_user_id')
      .leftJoin(
        'personal_organizations as personal',
        'personal.organization_id',
        'event.organization_id',
      )
      .leftJoin('auth.member as member', (join) =>
        join
          .onRef('member.organizationId', '=', 'event.organization_id')
          .onRef('member.userId', '=', 'event.owner_user_id'),
      )
      .where('one_time_booking_links.state', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('one_time_booking_links.expires_at', 'is', null),
          eb('one_time_booking_links.expires_at', '>', sql<Date>`clock_timestamp()`),
        ]),
      )
      .where('event.is_active', '=', true)
      .where('event.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([eb('event.owner_user_id', 'is', null), eb('owner.emailVerified', '=', true)]),
      )
      .where((eb) =>
        eb.or([
          eb('personal.user_id', 'is', null),
          eb('event.owner_user_id', '=', eb.ref('personal.user_id')),
        ]),
      )
      .where((eb) =>
        eb.or([eb('event.owner_user_id', 'is', null), eb('member.id', 'is not', null)]),
      )
  }
  const row = await query.executeTakeFirst()
  const matches = timingSafeEqual(
    Buffer.from(hash, 'hex'),
    row ? Buffer.from(row.token_hash, 'hex') : DUMMY_HASH,
  )
  return valid && matches ? row : undefined
}

function toLink(row: MetadataRow, expired: boolean): OneTimeBookingLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventTypeId: row.event_type_id,
    creatorUserId: row.creator_user_id,
    expiresAt: row.expires_at === null ? null : timestamp(row.expires_at),
    prefill: { name: row.prefill_name, email: row.prefill_email },
    state: row.state === 'active' && expired ? 'expired' : (row.state as OneTimeBookingLinkState),
    bookingId: row.booking_id,
    usedAt: row.used_at === null ? null : timestamp(row.used_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

/** Internal replay lookup: a used credential may only retrieve its own winning request. */
export async function oneTimeBookingReplayTarget(
  ctx: Pick<PublicContext, 'db'>,
  token: string | undefined,
): Promise<(ResolvedOneTimeBookingLink & { bookingId: string }) | undefined> {
  const row = await lookupToken(ctx.db, token)
  if (row?.state !== 'used' || row.booking_id === null) return undefined
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventTypeId: row.event_type_id,
    prefill: { name: row.prefill_name, email: row.prefill_email },
    bookingId: row.booking_id,
  }
}

function validExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid()
  try {
    const instant = Temporal.Instant.from(value)
    const date = new Date(instant.epochMilliseconds)
    if (!Number.isFinite(date.getTime())) throw invalid()
    return date.toISOString()
  } catch {
    throw invalid()
  }
}

function validPrefill(value: unknown): OneTimeBookingLinkPrefill {
  if (value === undefined) return { name: null, email: null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  if (Object.keys(value).some((key) => key !== 'name' && key !== 'email')) throw invalid()
  const input = value as { name?: unknown; email?: unknown }
  const name = input.name == null ? null : cleanText(input.name, { max: 200 })
  const email = input.email == null ? null : cleanText(input.email, { max: 254 })
  if (name === undefined || email === undefined || (email !== null && !EMAIL.test(email)))
    throw invalid()
  return { name, email: email?.toLowerCase() ?? null }
}

function isClaimGuardViolation(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return (
    code === '23514' &&
    (constraint === 'one_time_booking_links_claim_expired' ||
      constraint === 'one_time_booking_links_claim_booking' ||
      constraint === 'one_time_booking_links_terminal')
  )
}
