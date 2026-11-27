import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  eventTypeNotFound,
  findPublicEventType,
  findPublicTeamEventType,
  type PublicEventTypeRecord,
  selectBookableLocationOption,
  selectDurationMinutes,
} from './availability.ts'
import {
  type BookingOrigin,
  type BookingStatus,
  type CreateBookingInput,
  canonicalJson,
  createBookingInTransaction,
  IDEMPOTENCY_KEY,
  lockHosts,
  newManageToken,
  prepareBookingAttendees,
  sha256,
} from './bookings.ts'
import {
  automaticConference,
  automaticMeet,
  eligibleMeetHosts,
  withLocationAvailability,
} from './conferences.ts'
import type { BookingNotifier, PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { isConstraintViolation, jsonb, SQLSTATE, timestamp } from './internal.ts'
import { createNotificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import { validateResponses } from './questions.ts'
import {
  type RecurringBookingAdmissionDeps,
  recurringBookingAdmissionEnabled,
} from './recurring-admission.ts'
import { checkRecurringAvailability } from './recurring-availability.ts'
import {
  expandRecurringRule,
  MAX_RECURRING_OCCURRENCES,
  normalizeRecurringRule,
  type RecurringOccurrence,
  type RecurringRule,
  resolveFirstStart,
} from './recurring-rules.ts'
import { assignRoundRobinHost, lockRoundRobinState } from './round-robin.ts'

interface ExpectedOccurrence {
  ordinal: number
  localStart: string
  start: string | null
  end: string | null
  offset: string | null
}

export interface ExpectedBookingSeriesPreview {
  eventRevision: string
  timeZone: string
  rule: RecurringRule
  durationMinutes: number
  occurrences: readonly ExpectedOccurrence[]
}

export interface CreateBookingSeriesInput
  extends Omit<CreateBookingInput, 'start' | 'expectedGroupSlotId'> {
  idempotencyKey: string
  firstLocalStart: string
  rule: unknown
  expectedPreview: ExpectedBookingSeriesPreview
}

export interface CreateBookingSeriesOptions extends RecurringBookingAdmissionDeps {
  /** Trusted HMAC of the anonymous caller's rate-limit address key. */
  actorDigest: Buffer
  /** API key or OAuth attribution established by the authorized caller. */
  origin?: BookingOrigin | undefined
  /** The existing transaction-bound webhook notifier for booking.created. */
  notifyWebhook?: BookingNotifier | undefined
  /** The transaction-bound email notifier for each member's reminders and follow-ups. */
  notifyMemberEmail?: BookingNotifier | undefined
  /** The existing transaction-bound provider calendar notifier for each member. */
  notifyMemberCalendar?: BookingNotifier | undefined
  /** The existing transaction-bound automatic conference notifier for each member. */
  notifyMemberConference?: BookingNotifier | undefined
}

interface SeriesBooking {
  id: string
  ordinal: number
  bookingId: string
  start: string
  end: string
  status: BookingStatus
}

export interface CreateBookingSeriesResult {
  seriesId: string
  manageToken: string | null
  replayed: boolean
  occurrences: SeriesBooking[]
}

export class BookingSeriesRateLimitError extends Error {
  readonly code = 'rate_limited'
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('rate_limited')
    this.name = 'BookingSeriesRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const ADMISSIONS_PER_HOUR = 2
const BOOKING_PAGE: BookingOrigin = { source: 'web', apiKeyId: null }

const recurrenceNotSupported = () =>
  new DomainError('invalid', 'recurrence_not_supported', 'This event does not support a series.')
const invalidRecurrence = () =>
  new DomainError('invalid', 'invalid_recurrence', 'The requested series dates are invalid.')
const seriesChanged = () =>
  new DomainError('conflict', 'series_changed', 'The series preview has changed. Preview it again.')
const seriesUnavailable = () =>
  new DomainError('conflict', 'series_unavailable', 'The requested dates are no longer available.')

type EventResolver = (
  db: Db,
  options?: { lock?: boolean },
) => Promise<PublicEventTypeRecord | undefined>
type ResolvedOccurrence = Extract<RecurringOccurrence, { start: Temporal.Instant }>

interface ReceiptScope {
  organizationId: string
  authorityScope: Buffer
  key: Buffer
  fingerprint: Buffer
}

export function createPublicBookingSeries(
  ctx: PublicContext,
  input: CreateBookingSeriesInput,
  options: CreateBookingSeriesOptions,
): Promise<CreateBookingSeriesResult> {
  return createBookingSeries(ctx, input, options, (db, lock) =>
    findPublicEventType(db, input.handle, input.slug, {
      ...lock,
      scimResourcesEnabled: ctx.scimResourcesEnabled,
    }),
  )
}

export function createPublicTeamBookingSeries(
  ctx: PublicContext,
  input: CreateBookingSeriesInput,
  options: CreateBookingSeriesOptions,
): Promise<CreateBookingSeriesResult> {
  return createBookingSeries(ctx, input, options, (db, lock) =>
    findPublicTeamEventType(db, input.handle, input.slug, {
      ...lock,
      scimResourcesEnabled: ctx.scimResourcesEnabled,
    }),
  )
}

async function createBookingSeries(
  ctx: PublicContext,
  input: CreateBookingSeriesInput,
  options: CreateBookingSeriesOptions,
  resolve: EventResolver,
): Promise<CreateBookingSeriesResult> {
  const enabled = recurringBookingAdmissionEnabled(options)
  const event = await resolve(ctx.db)
  if (!event) throw enabled ? eventTypeNotFound() : recurrenceNotSupported()
  const origin = options.origin ?? BOOKING_PAGE
  const identity = origin.oauthConsentId
    ? ['oauth_consent', origin.oauthConsentId]
    : origin.apiKeyId
      ? ['api_key', origin.apiKeyId]
      : ['anonymous']
  const authorityScope = sha256(canonicalJson(['booking-series', ...identity]))
  const actorDigest = identity[0] === 'anonymous' ? options.actorDigest : authorityScope
  const request = prepareRequest(event, input, authorityScope, enabled)

  // All receipt reads follow public event authorization. A later retry also needs to
  // pass that check again, including after a uniqueness conflict across host pools.
  const authorizedReplay = async () => {
    const current = await resolve(ctx.db)
    if (!current || current.id !== event.id || current.organizationId !== event.organizationId)
      throw eventTypeNotFound()
    return findReplay(ctx.db, request.scope)
  }
  const replay = await findReplay(ctx.db, request.scope, enabled)
  if (replay) return replay
  if (!enabled || input.waitlistToken !== undefined) throw recurrenceNotSupported()

  try {
    const retryAfter = await admissionRetryAfter(ctx.db, event, actorDigest)
    if (retryAfter !== undefined) throw new BookingSeriesRateLimitError(retryAfter)
    const initial = await resolveBatch(ctx.db, event, input, request, ctx.now())
    if (
      !(
        await checkRecurringAvailability(
          ctx.db,
          initial.availability,
          ctx.scimResourcesEnabled === true,
        )
      ).canBook
    )
      throw seriesUnavailable()

    return await ctx.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`booking-series-admission:${event.id}:${actorDigest.toString('hex')}`}, 0))`.execute(
        trx,
      )
      await lockOrganization(trx, event.organizationId)
      await lockHosts(trx, event.hostUserIds)
      const current = await resolve(trx, { lock: true })
      if (!current || current.id !== event.id || current.organizationId !== event.organizationId)
        throw eventTypeNotFound()

      const committed = await findReplay(trx, request.scope)
      if (committed) return committed
      const lockedRetryAfter = await admissionRetryAfter(trx, current, actorDigest)
      if (lockedRetryAfter !== undefined) throw new BookingSeriesRateLimitError(lockedRetryAfter)

      if (
        current.schedulingType !== event.schedulingType ||
        current.hostUserIds.join() !== event.hostUserIds.join()
      )
        throw seriesChanged()

      const roundRobin = current.schedulingType === 'round_robin'
      if (roundRobin) await lockRoundRobinState(trx, current.id)
      const now = ctx.now()
      const batch = await resolveBatch(trx, current, input, request, now)
      for (const hostUserId of current.eligibleHostUserIds)
        await expirePaymentHolds({ db: trx, hostUserId })

      const checked = await checkRecurringAvailability(
        trx,
        batch.availability,
        ctx.scimResourcesEnabled === true,
      )
      if (!checked.canBook) throw seriesUnavailable()
      const candidates =
        roundRobin && automaticMeet(batch.locationOption)
          ? await withLocationAvailability(current.locations, input.locationOptionId, () =>
              eligibleMeetHosts(trx, checked.hostUserIds, current.id, ctx.automaticMeet),
            )
          : checked.hostUserIds
      const hostUserIds = roundRobin
        ? [await assignRoundRobinHost(trx, current.id, candidates)]
        : current.hostUserIds

      const { token, hash } = newManageToken()
      const { id: seriesId, revision } = await trx
        .insertInto('booking_series')
        .values({
          organization_id: current.organizationId,
          event_type_id: current.id,
          original_event_type_id: current.id,
          rule_pattern: request.rule.pattern,
          rule_ordinal:
            request.rule.pattern === 'monthly_weekday'
              ? request.rule.ordinal === 'last'
                ? -1
                : request.rule.ordinal
              : null,
          rule_weekday: request.rule.pattern === 'monthly_weekday' ? request.rule.weekday : null,
          time_zone: batch.timeZone,
          first_local_start: batch.firstLocalStart,
          requested_count: request.rule.count,
          duration_minutes: batch.availability.durationMinutes,
          created_at: now.toString(),
          notification_snapshot: jsonb(batch.notificationSnapshot),
          host_policy_snapshot: jsonb({ schedulingType: current.schedulingType, hostUserIds }),
          manage_token_hash: hash,
        })
        .returning(['id', 'revision'])
        .executeTakeFirstOrThrow()

      // The series outbox owns confirmation. Provider jobs still reconcile each root.
      const bookingContext = {
        requestId: ctx.requestId,
        automaticMeet: ctx.automaticMeet,
        automaticZoom: ctx.automaticZoom,
        microsoftCalendarEnabled: ctx.microsoftCalendarEnabled,
        notify: (async (trx, event, now) => {
          await options.notifyMemberConference?.(trx, event, now)
          await options.notifyMemberEmail?.(trx, event, now)
          await options.notifyMemberCalendar?.(trx, event, now)
          await options.notifyWebhook?.(trx, event, now)
        }) satisfies BookingNotifier,
        now: ctx.now,
      }
      const occurrences: SeriesBooking[] = []
      for (const occurrence of batch.occurrences) {
        const { id: occurrenceId, root_booking_id: bookingId } = await trx
          .insertInto('booking_series_occurrences')
          .values({
            organization_id: current.organizationId,
            series_id: seriesId,
            ordinal: occurrence.ordinal,
            original_local_start: occurrence.localStart,
            start_at: occurrence.start.toString(),
            end_at: occurrence.end.toString(),
            root_booking_id: sql<string>`uuidv7()`,
          })
          .returning(['id', 'root_booking_id'])
          .executeTakeFirstOrThrow()
        const { booking } = await createBookingInTransaction(bookingContext, trx, {
          input: {
            ...input,
            start: occurrence.start,
            durationMinutes: batch.availability.durationMinutes,
          },
          event: current,
          origin,
          attendees: request.attendees,
          seriesOccurrence: { bookingId, occurrenceId, hostUserIds, now },
        })
        occurrences.push({
          id: occurrenceId,
          ordinal: occurrence.ordinal,
          bookingId: booking.id,
          start: booking.start,
          end: booking.end,
          status: 'confirmed',
        })
      }

      const receipt = await trx
        .insertInto('booking_series_receipts')
        .values({
          organization_id: current.organizationId,
          series_id: seriesId,
          operation_kind: 'create',
          authority_scope: request.scope.authorityScope,
          idempotency_key: request.scope.key,
          fingerprint: request.scope.fingerprint,
          affected_occurrence_ids: occurrences.map(({ id }) => id),
          result_booking_ids: occurrences.map(({ bookingId }) => bookingId),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('booking_series_notifications')
        .values({
          id: receipt.id,
          organization_id: current.organizationId,
          series_id: seriesId,
          row_type: 'outbox',
          kind: 'confirmation',
          sequence: revision,
          due_at: (automaticConference(batch.locationOption)
            ? now.add({ minutes: 30 })
            : now
          ).toString(),
          attempts: 0,
          outbox_state: 'pending',
        })
        .execute()
      await trx
        .insertInto('booking_series_admissions')
        .values({
          organization_id: current.organizationId,
          event_type_id: current.id,
          actor_digest: actorDigest,
          admitted_at: sql`clock_timestamp()`,
        })
        .execute()
      return { seriesId, manageToken: token, replayed: false, occurrences }
    })
  } catch (error) {
    // Another request may have committed the receipt after our first lookup, while
    // this request hit the cap, changed policy, or the receipt uniqueness constraint.
    if (
      (error instanceof DomainError && error.code !== 'idempotency_key_reused') ||
      error instanceof BookingSeriesRateLimitError ||
      isConstraintViolation(error, SQLSTATE.uniqueViolation, 'booking_series_receipts_replay_key')
    ) {
      const committed = await authorizedReplay()
      if (committed) return committed
    }
    if (error instanceof DomainError && error.code === 'slot_taken') throw seriesUnavailable()
    throw error
  }
}

function prepareRequest(
  event: PublicEventTypeRecord,
  input: CreateBookingSeriesInput,
  authorityScope: Buffer,
  enabled: boolean,
) {
  try {
    if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotencyKey))
      throw new DomainError(
        'invalid',
        'invalid_idempotency_key',
        'Idempotency-Key must be 1 to 255 printable ASCII characters',
      )
    const rule = normalizeRecurringRule(input.rule)
    const preview = normalizePreview(input.expectedPreview)
    const firstStart = resolveFirstStart(input.firstLocalStart, preview.timeZone).toInstant()
    const attendees = prepareBookingAttendees(input)
    const fingerprint = sha256(
      canonicalJson({
        eventTypeId: event.id,
        firstStart: firstStart.toString(),
        rule,
        preview,
        durationMinutes: input.durationMinutes ?? preview.durationMinutes,
        locationOptionId: input.locationOptionId,
        inviteePhone: input.inviteePhone?.replace(/[ ().-]/g, '') || undefined,
        attendees,
        responses: Object.fromEntries(
          Object.entries(input.responses ?? {}).map(([id, answer]) => [
            id,
            typeof answer === 'string' ? answer.trim() : answer,
          ]),
        ),
        waitlistToken: input.waitlistToken,
      }),
    )
    return {
      attendees,
      preview,
      rule,
      scope: {
        organizationId: event.organizationId,
        authorityScope,
        key: sha256(input.idempotencyKey),
        fingerprint,
      },
    }
  } catch (error) {
    if (!enabled && error instanceof DomainError) throw recurrenceNotSupported()
    throw error
  }
}

/** Project only stable facts from the submitted preview. */
function normalizePreview(preview: ExpectedBookingSeriesPreview): ExpectedBookingSeriesPreview {
  if (
    !preview ||
    !Array.isArray(preview.occurrences) ||
    preview.occurrences.length > MAX_RECURRING_OCCURRENCES
  )
    throw invalidRecurrence()
  try {
    return {
      eventRevision: preview.eventRevision,
      timeZone: preview.timeZone,
      rule: normalizeRecurringRule(preview.rule),
      durationMinutes: preview.durationMinutes,
      occurrences: preview.occurrences.map(({ ordinal, localStart, start, end, offset }) => ({
        ordinal,
        localStart: Temporal.PlainDateTime.from(localStart).toString(),
        start: start === null ? null : Temporal.Instant.from(start).toString(),
        end: end === null ? null : Temporal.Instant.from(end).toString(),
        offset,
      })),
    }
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw invalidRecurrence()
    throw error
  }
}

async function resolveBatch(
  db: Db,
  event: PublicEventTypeRecord,
  input: CreateBookingSeriesInput,
  request: ReturnType<typeof prepareRequest>,
  now: Temporal.Instant,
) {
  const policy = await db
    .selectFrom('event_types')
    .select(['recurrence', 'recurrence_revision', 'notifications'])
    .where('id', '=', event.id)
    .where('organization_id', '=', event.organizationId)
    .executeTakeFirst()
  if (!policy) throw eventTypeNotFound()
  if (policy.recurrence_revision !== request.preview.eventRevision) throw seriesChanged()
  if (!policy.recurrence || event.bookingMode === 'group' || event.payment)
    throw recurrenceNotSupported()

  const { timeZone, maxOccurrences, allowedPatterns } = policy.recurrence as {
    timeZone: string
    maxOccurrences: number
    allowedPatterns: RecurringRule['pattern'][]
  }
  if (!allowedPatterns.includes(request.rule.pattern)) throw recurrenceNotSupported()
  if (request.rule.count > maxOccurrences) throw invalidRecurrence()
  if (timeZone !== request.preview.timeZone) throw seriesChanged()
  if (request.attendees.guests.length && !event.allowGuests)
    throw new DomainError('invalid', 'guests_not_allowed', 'This event type does not allow guests')
  validateResponses(event.questions, input.responses ?? {})
  const locationOption = selectBookableLocationOption(event, input.locationOptionId)

  const durationMinutes = selectDurationMinutes(event, input.durationMinutes)
  const expanded = expandRecurringRule({ ...input, timeZone, durationMinutes, now })
  const expected = request.preview
  const serialized = expanded.map(({ ordinal, localStart, start, end, offset }) => ({
    ordinal,
    localStart,
    start: start?.toString() ?? null,
    end: end?.toString() ?? null,
    offset,
  }))
  if (
    expected.durationMinutes !== durationMinutes ||
    canonicalJson(expected.rule) !== canonicalJson(request.rule) ||
    canonicalJson(expected.occurrences) !== canonicalJson(serialized)
  )
    throw seriesChanged()
  const occurrences = expanded.filter((date): date is ResolvedOccurrence => date.start !== null)
  const first = occurrences[0]
  if (!first || occurrences.length !== expanded.length) throw seriesUnavailable()

  return {
    timeZone,
    firstLocalStart: first.localStart,
    occurrences,
    locationOption,
    notificationSnapshot: createNotificationSnapshot(policy.notifications),
    availability: {
      eventTypeId: event.id,
      organizationId: event.organizationId,
      occurrences,
      now,
      durationMinutes,
    },
  }
}

async function admissionRetryAfter(
  db: Db,
  event: PublicEventTypeRecord,
  actorDigest: Buffer,
): Promise<number | undefined> {
  const row = await db
    .selectFrom('booking_series_admissions')
    .select(
      sql<number>`ceil(extract(epoch from
      admitted_at + interval '1 hour' - statement_timestamp()))::int`.as('retry_after'),
    )
    .where('organization_id', '=', event.organizationId)
    .where('event_type_id', '=', event.id)
    .where('actor_digest', '=', actorDigest)
    .where('admitted_at', '>', sql<Date>`statement_timestamp() - interval '1 hour'`)
    .orderBy('admitted_at', 'desc')
    .offset(ADMISSIONS_PER_HOUR - 1)
    .limit(1)
    .executeTakeFirst()
  return row?.retry_after
}

async function findReplay(
  db: Db,
  scope: ReceiptScope,
  enabled = true,
): Promise<CreateBookingSeriesResult | undefined> {
  const receipt = await db
    .selectFrom('booking_series_receipts')
    .select(['series_id', 'fingerprint'])
    .where('organization_id', '=', scope.organizationId)
    .where('authority_scope', '=', scope.authorityScope)
    .where('operation_kind', '=', 'create')
    .where('idempotency_key', '=', scope.key)
    .executeTakeFirst()
  if (!receipt) return undefined
  if (!receipt.fingerprint.equals(scope.fingerprint)) {
    if (!enabled) throw recurrenceNotSupported()
    throw new DomainError(
      'conflict',
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different request',
    )
  }
  const rows = await db
    .selectFrom('booking_series_occurrences as o')
    .innerJoin('bookings as b', (join) =>
      join
        .onRef('b.organization_id', '=', 'o.organization_id')
        .onRef('b.series_occurrence_id', '=', 'o.id'),
    )
    .select(['o.id', 'o.ordinal', 'b.id as booking_id', 'b.start_at', 'b.end_at', 'b.status'])
    .where('o.organization_id', '=', scope.organizationId)
    .where('o.series_id', '=', receipt.series_id)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('bookings as s').select('s.id').whereRef('s.rescheduled_from_id', '=', 'b.id'),
        ),
      ),
    )
    .orderBy('o.ordinal')
    .execute()
  if (!rows.length) throw eventTypeNotFound()
  return {
    seriesId: receipt.series_id,
    manageToken: null,
    replayed: true,
    occurrences: rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      bookingId: row.booking_id,
      start: timestamp(row.start_at),
      end: timestamp(row.end_at),
      status: row.status === 'confirmed' ? 'confirmed' : 'cancelled',
    })),
  }
}
