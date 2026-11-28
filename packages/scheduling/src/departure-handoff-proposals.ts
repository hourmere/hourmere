import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { type InferResult, sql } from 'kysely'
import { findSlots } from './availability.ts'
import { lockHosts } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import {
  type DepartureHandoffSourceInput,
  type DepartureHandoffWriteContext,
  handoffBookingNotFound,
  handoffOfferChanged,
  handoffOfferNotFound,
  withDepartureHandoffWrite,
} from './departure-handoff-access.ts'
import { departureHandoffDeadline, readDepartureHandoffTerms } from './departure-handoff-apply.ts'
import {
  closeDepartureHandoffOffer,
  DEPARTURE_HANDOFF_SEND_LIMIT,
  departureHandoffRecipientHash,
  lockDepartureHandoffSource,
} from './departure-handoff-delivery.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { withDepartureHandoffRead } from './departure-handoff-preview.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { cleanInviteeEmail } from './text.ts'

const MAX_VERSION = 2_147_483_647
const CLEANUP_BATCH_SIZE = 100
const CLEANUP_MAX_BATCHES = 10
const queueDeadline = sql<Date>`clock_timestamp() - interval '20 minutes'`

export const DEPARTURE_HANDOFF_PROPOSAL_STATES = [
  'live',
  'withdrawn',
  'superseded',
  'expired',
  'closed',
] as const
export const DEPARTURE_HANDOFF_DELIVERY_STATES = [
  'not_requested',
  'queued',
  'unknown',
  'sent',
  'failed',
  'unavailable',
  'skipped',
] as const

type ProposalState = (typeof DEPARTURE_HANDOFF_PROPOSAL_STATES)[number]
type DeliveryState = (typeof DEPARTURE_HANDOFF_DELIVERY_STATES)[number]
type CloseReason = Extract<ProposalState, 'withdrawn' | 'superseded' | 'expired'>

interface SourceKey {
  organizationId: string
  sourceBookingId: string
}

interface VersionKey {
  offerId: string
  version: number
}

interface ProposalInput extends DepartureHandoffSourceInput {
  departingUserId: string
  start?: string | undefined
  durationMinutes?: number | undefined
  locationOptionId?: string | undefined
  previous?: VersionKey | undefined
}

export type EnqueueDepartureHandoffEmail = (db: Db, recipientId: string) => Promise<string>

const exhausted = () => new DomainError('conflict', 'handoff_send_limit')
const before = (left: Temporal.Instant, right: string | Temporal.Instant) =>
  Temporal.Instant.compare(left, right) < 0
const utc = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

function offers(db: Db, key: SourceKey) {
  return db
    .selectFrom('departure_handoff_offers')
    .where('organization_id', '=', key.organizationId)
    .where('source_booking_id', '=', key.sourceBookingId)
}

function offerStatusRows(db: Db, key: SourceKey) {
  return offers(db, key).select([
    'id',
    'version',
    'state',
    'close_reason',
    utc('issued_at').as('issuedAt'),
    utc('expires_at').as('expiresAt'),
  ])
}
type OfferStatusRow = InferResult<ReturnType<typeof offerStatusRows>>[number]

function matchesVersion(offer: OfferStatusRow, key: VersionKey) {
  return offer.id === key.offerId.toLowerCase() && offer.version === key.version
}

async function getOffer(
  db: Db,
  key: SourceKey,
  input: { offerId: string; version?: number | undefined },
  lock = false,
) {
  if (!isUuid(input.offerId)) throw handoffOfferNotFound()
  const offer = await offerStatusRows(db, key)
    .where('id', '=', input.offerId)
    .$if(lock, (query) => query.forUpdate())
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!offer) throw handoffOfferNotFound()
  if (input.version === undefined || matchesVersion(offer, { ...input, version: input.version }))
    return offer
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > MAX_VERSION)
    throw handoffOfferChanged()
  const version = await offerStatusRows(db, key)
    .where('id', '=', input.offerId)
    .where('version', '=', input.version)
    .$if(lock, (query) => query.forUpdate())
    .executeTakeFirst()
  if (!version) throw handoffOfferChanged()
  return version
}

function recipients(db: Db, key: SourceKey, offer: OfferStatusRow) {
  return db
    .selectFrom('departure_handoff_recipients')
    .where('organization_id', '=', key.organizationId)
    .where('source_booking_id', '=', key.sourceBookingId)
    .where('offer_id', '=', offer.id)
    .where('offer_version', '=', offer.version)
}

async function budgetCounts(db: Db, key: SourceKey, recipientKeys: readonly string[]) {
  const counts = new Map<string, number>()
  if (!recipientKeys.length) return counts
  const rows = await db
    .selectFrom('departure_handoff_send_budgets')
    .select(['recipient_hash', 'counted_sends'])
    .where('organization_id', '=', key.organizationId)
    .where('source_booking_id', '=', key.sourceBookingId)
    .where(
      'recipient_hash',
      'in',
      recipientKeys.map((recipientKey) =>
        departureHandoffRecipientHash(key.sourceBookingId, recipientKey),
      ),
    )
    .execute()
  for (const row of rows) counts.set(row.recipient_hash, row.counted_sends)
  return counts
}

function sendsUsed(counts: Map<string, number>, key: SourceKey, recipientKey: string) {
  return counts.get(departureHandoffRecipientHash(key.sourceBookingId, recipientKey)) ?? 0
}

function proposalState(offer: OfferStatusRow, now: Temporal.Instant): ProposalState {
  if (offer.state === 'closed') return (offer.close_reason as CloseReason | null) ?? 'closed'
  return before(now, offer.expiresAt) ? 'live' : 'expired'
}

async function projectProposal(
  db: Db,
  key: SourceKey,
  offer: OfferStatusRow,
  now: Temporal.Instant,
  sourceLive: boolean,
) {
  const state = proposalState(offer, now)
  const rows = await recipients(db, key, offer)
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('departure_handoff_deliveries as delivery')
          .select((eb) =>
            eb
              .case()
              .when(eb.and([eb('state', '=', 'queued'), eb('created_at', '<=', queueDeadline)]))
              .then('unavailable')
              .else(eb.ref('state'))
              .end()
              .as('deliveryState'),
          )
          .whereRef('delivery.recipient_id', '=', 'departure_handoff_recipients.id')
          .orderBy('created_at', 'desc')
          .orderBy('job_id', 'desc')
          .limit(1)
          .as('latest_delivery'),
      (join) => join.onTrue(),
    )
    .select([
      'departure_handoff_recipients.id',
      'recipient_key',
      'decision',
      'latest_delivery.deliveryState',
    ])
    .orderBy('departure_handoff_recipients.id')
    .execute()
  const attendeeIdsByMailbox = new Map<string, string[]>()
  if (rows.length) {
    const attendees = await db
      .selectFrom('booking_attendees')
      .select(['id', 'email'])
      .where('booking_id', '=', key.sourceBookingId)
      .orderBy('id')
      .execute()
    for (const attendee of attendees) {
      const mailbox = cleanInviteeEmail(attendee.email)?.toLowerCase()
      if (!mailbox) continue
      const ids = attendeeIdsByMailbox.get(mailbox) ?? []
      ids.push(attendee.id)
      attendeeIdsByMailbox.set(mailbox, ids)
    }
  }
  const live = sourceLive && state === 'live' && !before(now, offer.issuedAt)
  const counts = live
    ? await budgetCounts(
        db,
        key,
        rows.map(({ recipient_key }) => recipient_key),
      )
    : new Map<string, number>()
  return {
    id: offer.id,
    version: offer.version,
    state,
    expiresAt: Temporal.Instant.from(offer.expiresAt).toString(),
    recipients: rows.map((row) => ({
      id: row.id,
      attendeeIds: attendeeIdsByMailbox.get(row.recipient_key) ?? [],
      decision: (row.decision as 'approved' | 'declined' | null) ?? ('pending' as const),
      delivery: (row.deliveryState as DeliveryState | null) ?? 'not_requested',
      resendAvailable:
        live &&
        row.decision === null &&
        row.deliveryState !== 'queued' &&
        sendsUsed(counts, key, row.recipient_key) < DEPARTURE_HANDOFF_SEND_LIMIT,
    })),
  }
}

async function queueDelivery(
  db: Db,
  enqueue: EnqueueDepartureHandoffEmail,
  recipientId: string,
  requestKey: string | null,
) {
  let jobId: string
  try {
    jobId = await enqueue(db, recipientId)
    if (!isUuid(jobId)) throw new Error()
  } catch {
    throw new DomainError('unavailable', 'handoff_delivery_unavailable')
  }
  await db
    .insertInto('departure_handoff_deliveries')
    .values({ job_id: jobId, recipient_id: recipientId, request_key: requestKey })
    .execute()
}

/** Caller holds the scoped source and offer locks. SMTP never holds these locks. */
async function closeOffer(
  db: Db,
  key: SourceKey,
  offer: OfferStatusRow,
  reason: CloseReason,
): Promise<OfferStatusRow> {
  await closeDepartureHandoffOffer(
    db,
    { ...key, offerId: offer.id, version: offer.version },
    reason,
  )
  return { ...offer, state: 'closed', close_reason: reason }
}

function normalizeStart(start: string | undefined, fallback: Temporal.Instant) {
  try {
    return (start === undefined ? fallback : Temporal.Instant.from(start)).round({
      smallestUnit: 'microsecond',
      roundingMode: 'floor',
    })
  } catch {
    throw new DomainError('invalid', 'invalid_handoff_start')
  }
}

export function createDepartureHandoffProposal(
  ctx: DepartureHandoffWriteContext,
  input: ProposalInput,
  enqueue: EnqueueDepartureHandoffEmail,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return withDepartureHandoffWrite(ctx, input, capabilities, async (write, key, actor) => {
    const { db } = write
    const receipt = await db
      .selectFrom('departure_booking_handoffs')
      .select('source_booking_id')
      .where('organization_id', '=', key.organizationId)
      .where('source_booking_id', '=', key.sourceBookingId)
      .executeTakeFirst()
    if (receipt) throw handoffOfferChanged()
    const previous = await offerStatusRows(db, key)
      .orderBy('version', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst()
    if (
      previous
        ? !input.previous ||
          !matchesVersion(previous, input.previous) ||
          previous.version >= MAX_VERSION
        : input.previous
    )
      throw handoffOfferChanged()

    const eligibleInput = { bookingId: key.sourceBookingId, departingUserId: input.departingUserId }
    const preliminary = await getDepartureHandoffEligibility(
      write,
      key.organizationId,
      eligibleInput,
    )
    await lockHosts(db, [input.departingUserId.toLowerCase(), preliminary.candidateUserId])
    const eligible = await getDepartureHandoffEligibility(
      write,
      key.organizationId,
      eligibleInput,
      write.now(),
      true,
    )
    if (
      eligible.candidateUserId !== preliminary.candidateUserId ||
      eligible.event.id !== preliminary.event.id
    )
      throw handoffOfferChanged()

    const start = normalizeStart(input.start, eligible.source.start)
    const selectedLocation = input.locationOptionId ?? eligible.source.locationOptionId
    const terms = await readDepartureHandoffTerms(
      write,
      key.organizationId,
      {
        ...eligibleInput,
        start: start.toString(),
        durationMinutes:
          input.durationMinutes ??
          eligible.source.end.since(eligible.source.start).total('minutes'),
        ...(selectedLocation !== undefined && { locationOptionId: selectedLocation }),
      },
      eligible,
      true,
    )
    const now = write.now()
    const issuedAt = now.round({ smallestUnit: 'microsecond', roundingMode: 'floor' }).toString()
    const expiresAt = departureHandoffDeadline(
      { issuedAt, expiresAt: start.toString() },
      eligible.source.start,
      start,
    ).toString()
    if (!before(now, expiresAt)) throw handoffOfferChanged()

    const counts = await budgetCounts(db, key, terms.recipientKeys)
    if (
      terms.recipientKeys.some(
        (recipientKey) => sendsUsed(counts, key, recipientKey) >= DEPARTURE_HANDOFF_SEND_LIMIT,
      )
    )
      throw exhausted()

    const slots = await findSlots(db, {
      eventTypeId: eligible.event.id,
      hostUserId: eligible.candidateUserId,
      rangeStart: start,
      rangeEnd: terms.end,
      now,
      durationMinutes: terms.duration,
      excludeBookingId: key.sourceBookingId,
    })
    if (!slots.some((slot) => slot.start.equals(start) && slot.end.equals(terms.end)))
      throw new DomainError('conflict', 'slot_unavailable')

    if (previous?.state === 'live') await closeOffer(db, key, previous, 'superseded')
    const offer = await db
      .insertInto('departure_handoff_offers')
      .values({
        ...(previous && { id: previous.id }),
        organization_id: key.organizationId,
        source_booking_id: key.sourceBookingId,
        proposer_user_id: actor.userId,
        departing_user_id: input.departingUserId,
        version: (previous?.version ?? 0) + 1,
        issued_at: issuedAt,
        expires_at: expiresAt,
        target_start_at: start.toString(),
        duration_minutes: terms.duration,
        location_option_id: selectedLocation ?? null,
        terms_digest: terms.termsDigest,
      })
      .returning(['id', 'version', 'state', 'close_reason'])
      .executeTakeFirstOrThrow()
    const pending = await db
      .insertInto('departure_handoff_recipients')
      .values(
        terms.recipientKeys.map((recipientKey) => ({
          organization_id: key.organizationId,
          source_booking_id: key.sourceBookingId,
          offer_id: offer.id,
          offer_version: offer.version,
          recipient_key: recipientKey,
        })),
      )
      .returning('id')
      .execute()
    for (const { id } of pending) await queueDelivery(db, enqueue, id, null)
    if (!before(write.now(), expiresAt)) throw handoffOfferChanged()
    return projectProposal(db, key, { ...offer, issuedAt, expiresAt }, now, true)
  })
}

export function readDepartureHandoffProposal(
  ctx: ServiceContext,
  input: DepartureHandoffSourceInput & { offerId: string; version?: number | undefined },
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return withDepartureHandoffRead(
    ctx,
    input.teamId,
    input.expectedOrganizationId,
    capabilities,
    async ({ db }, organizationId, now) => {
      if (!isUuid(input.bookingId)) throw handoffBookingNotFound()
      const source = await db
        .selectFrom('bookings')
        .select(['id', 'status', utc('start_at').as('start')])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.bookingId)
        .executeTakeFirst()
      if (!source) throw handoffBookingNotFound()
      const key = { organizationId, sourceBookingId: source.id }
      const offer = await getOffer(db, key, input)
      return projectProposal(
        db,
        key,
        offer,
        now,
        source.status === 'confirmed' && Boolean(source.start && before(now, source.start)),
      )
    },
  )
}

export function withdrawDepartureHandoffProposal(
  ctx: DepartureHandoffWriteContext,
  input: DepartureHandoffSourceInput & VersionKey,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return withDepartureHandoffWrite(ctx, input, capabilities, async (write, key) => {
    const { db } = write
    const offer = await getOffer(db, key, input, true)
    const now = write.now()
    const closed =
      offer.state === 'live'
        ? await closeOffer(db, key, offer, before(now, offer.expiresAt) ? 'withdrawn' : 'expired')
        : offer
    return projectProposal(db, key, closed, now, false)
  })
}

export function resendDepartureHandoffProposal(
  ctx: DepartureHandoffWriteContext,
  input: DepartureHandoffSourceInput & VersionKey & { recipientId: string; requestKey: string },
  enqueue: EnqueueDepartureHandoffEmail,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return withDepartureHandoffWrite(ctx, input, capabilities, async (write, key, _actor, source) => {
    const { db } = write
    if (!isUuid(input.recipientId)) throw handoffOfferNotFound()
    if (!isUuid(input.requestKey)) throw new DomainError('invalid', 'invalid_idempotency_key')
    const offer = await getOffer(db, key, input, true)
    const recipient = await recipients(db, key, offer)
      .select(['id', 'recipient_key', 'decision'])
      .where('id', '=', input.recipientId)
      .forUpdate()
      .executeTakeFirst()
    if (!recipient) throw handoffOfferNotFound()

    const now = write.now()
    const live =
      source.status === 'confirmed' &&
      !source.hasSuccessor &&
      source.start !== null &&
      before(now, source.start) &&
      proposalState(offer, now) === 'live' &&
      !before(now, offer.issuedAt)
    const replay = await db
      .selectFrom('departure_handoff_deliveries')
      .select('job_id')
      .where('recipient_id', '=', recipient.id)
      .where('request_key', '=', input.requestKey)
      .executeTakeFirst()
    if (replay) return projectProposal(db, key, offer, now, live)

    if (!live || recipient.decision !== null) throw handoffOfferChanged()
    const counts = await budgetCounts(db, key, [recipient.recipient_key])
    if (sendsUsed(counts, key, recipient.recipient_key) >= DEPARTURE_HANDOFF_SEND_LIMIT)
      throw exhausted()

    await db
      .updateTable('departure_handoff_deliveries')
      .set({ state: 'unavailable' })
      .where('recipient_id', '=', recipient.id)
      .where('state', '=', 'queued')
      .where('created_at', '<=', queueDeadline)
      .execute()
    const queued = await db
      .selectFrom('departure_handoff_deliveries')
      .select('job_id')
      .where('recipient_id', '=', recipient.id)
      .where('state', '=', 'queued')
      .executeTakeFirst()
    if (queued) throw new DomainError('conflict', 'handoff_delivery_pending')
    await queueDelivery(db, enqueue, recipient.id, input.requestKey)
    if (!before(write.now(), offer.expiresAt)) throw handoffOfferChanged()
    return projectProposal(db, key, offer, now, true)
  })
}

/** Retire expired capabilities and later remove mailbox rows without resetting the cap.
 * Keep version identifiers so an old offer cannot become the current version again. */
export async function cleanupDepartureHandoffProposals(db: Db, now: Temporal.Instant) {
  const cutoff = now.subtract({ hours: 48 }).toString()
  const eligibleOffers = db
    .selectFrom('departure_handoff_offers as offer')
    .select([
      'organization_id',
      'source_booking_id',
      'id',
      'version',
      utc('expires_at').as('expiry'),
    ])
    .where('expires_at', '<=', sql<Date>`${now.toString()}::timestamptz`)
    .where((eb) =>
      eb.or([
        eb('state', '=', 'live'),
        eb.and([
          eb('expires_at', '<=', sql<Date>`${cutoff}::timestamptz`),
          eb.exists(
            eb
              .selectFrom('departure_handoff_recipients as recipient')
              .select('recipient.id')
              .whereRef('recipient.organization_id', '=', 'offer.organization_id')
              .whereRef('recipient.source_booking_id', '=', 'offer.source_booking_id')
              .whereRef('recipient.offer_id', '=', 'offer.id')
              .whereRef('recipient.offer_version', '=', 'offer.version'),
          ),
        ]),
      ]),
    )
    .orderBy(['expires_at', 'organization_id', 'source_booking_id', 'version'])
    .limit(CLEANUP_BATCH_SIZE)
  let cursor: InferResult<typeof eligibleOffers>[number] | undefined
  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch++) {
    // Advance past skipped locks for this run. The next run starts from the oldest expiry again.
    const page = cursor
      ? eligibleOffers.where(sql<boolean>`
          (expires_at, organization_id, source_booking_id, version) >
          (${cursor.expiry}::timestamptz, ${cursor.organization_id}::uuid,
           ${cursor.source_booking_id}::uuid, ${cursor.version}::int)
        `)
      : eligibleOffers
    const candidates = await page.execute()
    for (const candidate of candidates) {
      await db.transaction().execute(async (trx) => {
        const key = {
          organizationId: candidate.organization_id,
          sourceBookingId: candidate.source_booking_id,
        }
        const team = await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', key.organizationId)
          .forShare()
          .skipLocked()
          .executeTakeFirst()
        if (
          !team ||
          !(await lockDepartureHandoffSource(trx, key.organizationId, key.sourceBookingId, true))
        )
          return
        const offer = await offerStatusRows(trx, key)
          .where('id', '=', candidate.id)
          .where('version', '=', candidate.version)
          .forUpdate()
          .executeTakeFirst()
        if (!offer) return
        if (offer.state === 'live') await closeOffer(trx, key, offer, 'expired')
        if (Temporal.Instant.compare(offer.expiresAt, cutoff) <= 0)
          await trx
            .deleteFrom('departure_handoff_recipients')
            .where('id', 'in', recipients(trx, key, offer).select('id'))
            .execute()
      })
    }
    if (candidates.length < CLEANUP_BATCH_SIZE) return
    cursor = candidates.at(-1)
  }
}
