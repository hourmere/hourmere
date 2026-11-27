import { isImportedBooking } from '@hourmere/db'
import { sql } from 'kysely'
import { findOneTimeEventType, parseLocation } from './availability.ts'
import { automaticConference } from './conferences.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { meetingPollChainLinked } from './meeting-poll-outcomes.ts'
import { validateResponses } from './questions.ts'

const bookingNotFound = () => new DomainError('not_found', 'booking_not_found', 'No such booking')
const ineligibleSource = () =>
  new DomainError(
    'conflict',
    'handoff_source_ineligible',
    'This booking is not eligible for handoff.',
  )
const ineligibleCandidate = () =>
  new DomainError(
    'conflict',
    'handoff_candidate_ineligible',
    'No eligible replacement host is configured.',
  )

export interface DepartureHandoffEligibilityInput {
  bookingId: string
  departingUserId: string
}

/** Internal facts for a preview or an apply that already holds the source and host locks. */
export async function getDepartureHandoffEligibility(
  ctx: ServiceContext,
  organizationId: string,
  input: DepartureHandoffEligibilityInput,
  now = ctx.now(),
  lockEvent = false,
) {
  const { db } = ctx
  if (!isUuid(organizationId) || !isUuid(input.bookingId)) throw bookingNotFound()
  const source = await db
    .selectFrom('bookings as booking')
    .select([
      'booking.id',
      'booking.event_type_id',
      'booking.status',
      'booking.source',
      'booking.required_host_user_ids',
      'booking.hosts_use_default_schedule',
      'booking.has_routing_snapshot',
      'booking.group_slot_id',
      'booking.series_occurrence_id',
      'booking.payment_hold_expires_at',
      'booking.responses',
      'booking.location',
      'booking.location_option',
    ])
    .select([
      sql<
        string | null
      >`to_char(timezone('UTC', booking.start_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('start'),
      sql<
        string | null
      >`to_char(timezone('UTC', booking.end_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('end'),
      meetingPollChainLinked(input.bookingId).as('poll_linked'),
    ])
    .select((eb) => [
      eb
        .exists(
          eb
            .selectFrom('bookings as successor')
            .select('successor.id')
            .whereRef('successor.rescheduled_from_id', '=', 'booking.id')
            .whereRef('successor.organization_id', '=', 'booking.organization_id'),
        )
        .as('has_successor'),
      // A moved paid booking may only carry checkout provenance on the attempt.
      eb
        .exists(
          eb
            .selectFrom('payment_checkout_attempts as attempt')
            .select('attempt.id')
            .where((qb) =>
              qb.or([
                qb('attempt.booking_id', '=', eb.ref('booking.id')),
                qb('attempt.current_booking_id', '=', eb.ref('booking.id')),
              ]),
            ),
        )
        .as('has_payment_attempt'),
    ])
    .where('booking.id', '=', input.bookingId)
    .where('booking.organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!source) throw bookingNotFound()
  if (
    !isUuid(input.departingUserId) ||
    source.status !== 'confirmed' ||
    source.source === 'import' ||
    !source.event_type_id ||
    !source.start ||
    !source.end ||
    source.has_successor ||
    source.required_host_user_ids.length !== 1 ||
    source.required_host_user_ids[0] !== input.departingUserId.toLowerCase() ||
    source.hosts_use_default_schedule ||
    source.has_routing_snapshot ||
    source.group_slot_id !== null ||
    source.series_occurrence_id !== null ||
    source.poll_linked ||
    source.payment_hold_expires_at !== null ||
    source.has_payment_attempt
  )
    throw ineligibleSource()
  const start = Temporal.Instant.from(source.start)
  const end = Temporal.Instant.from(source.end)
  if (Temporal.Instant.compare(start, now) <= 0) throw ineligibleSource()

  const location = parseLocation(source.location)
  if (
    (source.location !== null && location === null) ||
    location?.kind === 'link' ||
    (location?.url !== undefined && !automaticConference(location))
  )
    throw ineligibleSource()
  // A legacy successor may contain a local source value on an imported chain.
  if (await isImportedBooking(db, source.id)) throw ineligibleSource()

  // Event types have no price setting yet (docs/payments.md). A future price setting
  // also belongs in this target admission check.
  const event = await findOneTimeEventType(db, source.event_type_id, {
    lock: lockEvent,
    scimResourcesEnabled: ctx.scimResourcesEnabled,
  })
  if (
    !event?.team ||
    event.organizationId !== organizationId.toLowerCase() ||
    event.schedulingType !== 'individual' ||
    event.bookingMode !== 'individual' ||
    event.hostUserId === input.departingUserId.toLowerCase()
  )
    throw ineligibleCandidate()

  const attendees = await db
    .selectFrom('booking_attendees')
    .select('is_booker')
    .where('booking_id', '=', source.id)
    .execute()
  if (!attendees.some((attendee) => attendee.is_booker)) throw ineligibleSource()
  if (!event.allowGuests && attendees.some((attendee) => !attendee.is_booker))
    throw ineligibleCandidate()
  try {
    validateResponses(event.questions, source.responses)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'invalid_responses')
      throw ineligibleCandidate()
    throw error
  }

  const option = parseLocation(source.location_option)
  return {
    source: {
      id: source.id,
      start,
      end,
      locationOptionId: typeof option?.id === 'string' ? option.id : undefined,
      savedInviteePhone:
        option?.kind === 'phone' &&
        option.askInvitee === true &&
        typeof location?.number === 'string'
          ? location.number
          : undefined,
    },
    event,
    candidateUserId: event.hostUserId,
  }
}
