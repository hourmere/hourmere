import type { Db } from '@hourmere/db'
import { auditActor } from '@hourmere/db/audit'
import { sql } from 'kysely'
import { findOneTimeEventType, selectDurationMinutes } from './availability.ts'
import {
  type Booking,
  type CreateBookingInput,
  createBookingInTransaction,
  latestBookingId,
  prepareBookingAttendees,
} from './bookings.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { LOCATION_OPTION_LIMITS } from './location-options.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import { MEETING_POLL_LIMITS } from './meeting-poll-policy.ts'
import { type MeetingPollHostContext, requireSecret } from './meeting-poll-voters.ts'
import {
  type Authority,
  changed,
  insertReceipt,
  keyReused,
  loadPoll,
  lockedReceipt,
  lockHostPoll,
  type MeetingPoll,
  manages,
  meetingPollClock,
  meetingPollEventSettings,
  meetingPollSource,
  meetingPollUtc,
  pollNotFound,
  receiptIdentity,
  requireWriteScope,
  validIdempotencyKey,
} from './meeting-polls.ts'

export interface FinalizeMeetingPollInput {
  id: string
  slotId: string
  bookerVoterId: string
  attendeeVoterIds: readonly string[]
  expectedResultsRevision: number
  expectedBallotRevisions: Readonly<Record<string, number>>
  acknowledgeConditional: boolean
  idempotencyKey: string
  locationOptionId?: string | undefined
}

type FinalizedBooking = Pick<Booking, 'id' | 'eventTypeId' | 'status' | 'start' | 'end' | 'source'>

export interface FinalizeMeetingPollResult {
  poll: MeetingPoll
  booking: FinalizedBooking
  replayed: boolean
}

type HostPoll = Awaited<ReturnType<typeof lockHostPoll>>['poll']

export class MeetingPollAlreadyScheduledError extends DomainError {
  readonly poll: MeetingPoll

  constructor(poll: MeetingPoll) {
    super(
      'conflict',
      'poll_already_scheduled',
      'This poll is scheduled. Manage its booking instead.',
    )
    this.poll = poll
  }
}

const eventChanged = () =>
  new DomainError(
    'conflict',
    'poll_event_changed',
    'The event settings changed. Create a new poll.',
  )
const invalidPoll = (message: string) => new DomainError('invalid', 'invalid_poll', message)

/** Admit the selected voters as one ordinary booking, using the poll's transaction. */
export async function finalizeMeetingPoll(
  ctx: MeetingPollHostContext,
  input: FinalizeMeetingPollInput,
  options: { source?: 'api' | 'mcp' } = {},
): Promise<FinalizeMeetingPollResult> {
  requireWriteScope(ctx)
  const secret = requireSecret(ctx.meetingPollSecret)
  const { idempotencyKey, ...request } = validRequest(input)
  const source = meetingPollSource(ctx, options.source)
  return ctx.db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const { authority, poll } = await lockHostPoll(trx, ctx, request.id)
    // Authorize before inspecting a receipt. The initial event read is unlocked so a new
    // booking still takes the host advisory locks before sharing the event row.
    await requireManagedEvent(trx, poll, authority)
    const receipt = receiptIdentity(ctx, 'finalize', idempotencyKey, request)
    const previous = await lockedReceipt(trx, receipt)
    if (previous) {
      await requireManagedEvent(trx, poll, authority, true)
      if (previous.poll_id !== poll.id || !previous.request_fingerprint.equals(receipt.fingerprint))
        throw keyReused()
      if (!previous.booking_id) throw pollNotFound()
      return {
        poll: await loadPoll(trx, ctx, poll.id),
        booking: await currentBooking(trx, poll.organization_id, previous.booking_id),
        replayed: true,
      }
    }
    if (poll.status === 'scheduled')
      throw new MeetingPollAlreadyScheduledError(await loadPoll(trx, ctx, poll.id))
    if (poll.status === 'canceled')
      throw new DomainError('conflict', 'poll_canceled', 'This poll was canceled')
    if (poll.results_revision !== request.expectedResultsRevision) throw changed()

    const slot = await trx
      .selectFrom('meeting_poll_slots')
      .select(meetingPollUtc('start_at').as('start'))
      .where('organization_id', '=', poll.organization_id)
      .where('poll_id', '=', poll.id)
      .where('id', '=', request.slotId)
      .executeTakeFirst()
    if (!slot) throw pollNotFound()
    const { booker, guests } = await selectAttendees(trx, poll, request)
    const bookingInput: Omit<CreateBookingInput, 'handle' | 'slug'> = {
      start: Temporal.Instant.from(slot.start),
      durationMinutes: poll.duration_minutes,
      ...(request.locationOptionId && { locationOptionId: request.locationOptionId }),
      invitee: {
        name: booker.name,
        email: booker.email,
        timeZone: booker.time_zone,
        locale: booker.locale,
      },
      guests,
      responses: booker.responses as Record<string, unknown>,
    }
    const { principal } = ctx
    const resolve = async (db: Db, options?: { lock?: boolean }) => {
      let current: Awaited<ReturnType<typeof findOneTimeEventType>>
      try {
        current = await findOneTimeEventType(db, poll.event_type_id, options)
      } catch (error) {
        if (error instanceof DomainError && error.code === 'booking_changed') throw eventChanged()
        throw error
      }
      if (!current)
        throw new DomainError(
          'conflict',
          'event_type_unavailable',
          'This event type does not take bookings right now',
        )
      if (options?.lock) await requireManagedEvent(db, poll, authority)
      return current
    }
    const { booking } = await createBookingInTransaction(ctx, trx, {
      input: bookingInput,
      attendees: prepareBookingAttendees(bookingInput),
      event: await resolve(trx),
      resolve,
      origin: {
        source,
        apiKeyId: principal.kind === 'api_key' ? principal.apiKeyId : null,
        oauthConsentId: principal.kind === 'oauth' ? principal.oauthConsentId : null,
        actorUserId: principal.user.id,
        audit: auditActor(principal),
      },
      checkEvent: async (current) => {
        if (current.bookingMode === 'group')
          throw new DomainError(
            'invalid',
            'poll_event_unsupported',
            'Polls cannot book group seats',
          )
        const { fingerprint } = await meetingPollEventSettings(
          trx,
          current.id,
          poll.duration_minutes,
        )
        if (!fingerprint.equals(poll.settings_fingerprint)) throw eventChanged()
        try {
          selectDurationMinutes(current, poll.duration_minutes)
        } catch (error) {
          if (error instanceof DomainError && error.code === 'invalid_duration')
            throw eventChanged()
          throw error
        }
      },
    })
    const at = await meetingPollClock(trx)
    if (Temporal.Instant.compare(bookingInput.start, Temporal.Instant.from(at)) <= 0)
      throw new DomainError('conflict', 'slot_unavailable', 'This time is no longer available')
    await trx
      .updateTable('meeting_polls')
      .set({
        status: 'scheduled',
        chosen_slot_id: request.slotId,
        booking_id: booking.id,
        scheduled_at: at,
        closed_at: sql`coalesce(closed_at, CASE WHEN deadline_at <= ${at}::timestamptz THEN deadline_at END)`,
        host_revision: poll.host_revision + 1,
        updated_at: at,
      })
      .where('organization_id', '=', poll.organization_id)
      .where('id', '=', poll.id)
      .execute()
    await trx
      .updateTable('meeting_poll_voters')
      .set({
        selected_booking_role: sql`CASE WHEN id = ${booker.id}::uuid THEN 'booker' ELSE 'guest' END`,
        updated_at: at,
      })
      .where('organization_id', '=', poll.organization_id)
      .where('poll_id', '=', poll.id)
      .where('id', 'in', request.attendeeVoterIds)
      .execute()
    await insertReceipt(trx, receipt, poll.id, at, booking.id)
    await enqueueOutcomes(trx, poll, request.attendeeVoterIds, at)
    return {
      poll: await loadPoll(trx, ctx, poll.id),
      booking: {
        id: booking.id,
        eventTypeId: booking.eventTypeId,
        status: booking.status,
        start: booking.start,
        end: booking.end,
        source: booking.source,
      },
      replayed: false,
    }
  })
}

async function requireManagedEvent(trx: Db, poll: HostPoll, authority: Authority, lock = false) {
  let query = trx
    .selectFrom('event_types')
    .select('owner_user_id')
    .where('organization_id', '=', poll.organization_id)
    .where('id', '=', poll.event_type_id)
  if (lock) query = query.forShare()
  const event = await query.executeTakeFirst()
  if (!event || !manages(authority, event.owner_user_id)) throw pollNotFound()
}

async function selectAttendees(
  trx: Db,
  poll: HostPoll,
  request: Omit<FinalizeMeetingPollInput, 'idempotencyKey'>,
) {
  const voters = await trx
    .selectFrom('meeting_poll_voters as v')
    .innerJoin('meeting_poll_votes as vote', (join) =>
      join
        .onRef('vote.organization_id', '=', 'v.organization_id')
        .onRef('vote.poll_id', '=', 'v.poll_id')
        .onRef('vote.voter_id', '=', 'v.id')
        .on('vote.slot_id', '=', request.slotId),
    )
    .select([
      'v.id',
      'v.name',
      'v.email',
      'v.time_zone',
      'v.locale',
      'v.responses',
      'v.ballot_revision',
      'vote.value',
    ])
    .where('v.organization_id', '=', poll.organization_id)
    .where('v.poll_id', '=', poll.id)
    .where('v.id', 'in', request.attendeeVoterIds)
    .where('v.verified_at', 'is not', null)
    .where('v.withdrawn_at', 'is', null)
    .where('v.ballot_submitted_at', 'is not', null)
    .where('v.join_consent_at', 'is not', null)
    .where('vote.value', 'in', ['yes', 'if_need_be'])
    .orderBy('v.id')
    .execute()
  const booker = voters.find((voter) => voter.id === request.bookerVoterId)
  if (!booker || voters.length !== request.attendeeVoterIds.length)
    throw new DomainError(
      'conflict',
      'poll_attendee_ineligible',
      'Select verified voters who agreed to join at this time',
    )
  if (voters.some((voter) => voter.ballot_revision !== request.expectedBallotRevisions[voter.id]))
    throw changed()
  if (!request.acknowledgeConditional && voters.some((voter) => voter.value === 'if_need_be'))
    throw new DomainError(
      'invalid',
      'poll_conditional_acknowledgment_required',
      'Acknowledge the selected conditional votes',
    )
  return {
    booker,
    guests: voters
      .filter((voter) => voter.id !== booker.id)
      .map(({ name, email }) => ({ name, email })),
  }
}

async function enqueueOutcomes(
  trx: Db,
  poll: HostPoll,
  attendeeIds: readonly string[],
  at: string,
) {
  // Selected voters receive the ordinary confirmation and calendar invite from the booking core.
  await trx
    .insertInto('meeting_poll_deliveries')
    .columns([
      'organization_id',
      'poll_id',
      'voter_id',
      'kind',
      'due_at',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('meeting_poll_voters')
        .select(['organization_id', 'poll_id', 'id'])
        .select([
          sql<string>`'selected'`.as('kind'),
          sql`${at}::timestamptz`.as('due_at'),
          sql`${at}::timestamptz`.as('created_at'),
          sql`${at}::timestamptz`.as('updated_at'),
        ])
        .where('organization_id', '=', poll.organization_id)
        .where('poll_id', '=', poll.id)
        .where('id', 'not in', attendeeIds)
        .where('withdrawn_at', 'is', null)
        .where((eb) =>
          eb.or([eb('verified_at', 'is not', null), eb('invited_at', 'is not', null)]),
        ),
    )
    .execute()
}

async function currentBooking(
  trx: Db,
  organizationId: string,
  bookingId: string,
): Promise<FinalizedBooking> {
  // Read the chain and its current row in one snapshot, without taking a booking lock.
  // Booking deletion takes the booking lock before the poll lock.
  const row = await trx
    .selectFrom('bookings')
    .select(['id', 'event_type_id', 'status', 'start_at', 'end_at', 'source'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', latestBookingId(bookingId, organizationId))
    .executeTakeFirst()
  if (!row) throw pollNotFound()
  return {
    id: row.id,
    eventTypeId: row.event_type_id,
    status: row.status as Booking['status'],
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    source: row.source as Booking['source'],
  }
}

const REQUEST_FIELDS = new Set([
  'id',
  'slotId',
  'bookerVoterId',
  'attendeeVoterIds',
  'expectedResultsRevision',
  'expectedBallotRevisions',
  'acknowledgeConditional',
  'idempotencyKey',
  'locationOptionId',
])

function validRequest(input: FinalizeMeetingPollInput) {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((field) => !REQUEST_FIELDS.has(field))
  )
    throw invalidPoll('Provide only meeting poll finalization fields')
  if (!isUuid(input.id)) throw pollNotFound()
  if (!isUuid(input.slotId) || !isUuid(input.bookerVoterId))
    throw invalidPoll('Select a candidate and a booker')
  if (!Array.isArray(input.attendeeVoterIds) || !input.attendeeVoterIds.length)
    throw invalidPoll('Select at least one attendee')
  if (input.attendeeVoterIds.length > MEETING_POLL_LIMITS.maxAttendees)
    throw new DomainError('invalid', 'too_many_guests', 'This booking has too many guests')
  const bookerVoterId = input.bookerVoterId.toLowerCase()
  const attendeeVoterIds = Array.from(input.attendeeVoterIds, (id: unknown) => {
    if (!isUuid(id)) throw invalidPoll('Attendees must be voter IDs')
    return id.toLowerCase()
  }).sort()
  if (
    new Set(attendeeVoterIds).size !== attendeeVoterIds.length ||
    !attendeeVoterIds.includes(bookerVoterId)
  )
    throw invalidPoll('Select each attendee once, including the booker')
  if (!Number.isSafeInteger(input.expectedResultsRevision) || input.expectedResultsRevision < 1)
    throw invalidPoll('expectedResultsRevision must be a positive integer')
  if (
    !input.expectedBallotRevisions ||
    typeof input.expectedBallotRevisions !== 'object' ||
    Array.isArray(input.expectedBallotRevisions)
  )
    throw invalidPoll('Provide the ballot revision of every selected attendee')
  const revisions = Object.entries(input.expectedBallotRevisions)
  if (
    revisions.length !== attendeeVoterIds.length ||
    revisions.some(
      ([id, revision]) => !isUuid(id) || !Number.isSafeInteger(revision) || revision < 0,
    )
  )
    throw invalidPoll('Provide the ballot revision of every selected attendee')
  const expectedBallotRevisions = Object.fromEntries(
    revisions.map(([id, revision]) => [id.toLowerCase(), revision]),
  )
  if (attendeeVoterIds.some((id) => !Object.hasOwn(expectedBallotRevisions, id)))
    throw invalidPoll('Provide the ballot revision of every selected attendee')
  if (typeof input.acknowledgeConditional !== 'boolean')
    throw invalidPoll('acknowledgeConditional must be true or false')
  if (
    input.locationOptionId !== undefined &&
    (typeof input.locationOptionId !== 'string' ||
      input.locationOptionId.length === 0 ||
      input.locationOptionId.length > LOCATION_OPTION_LIMITS.id)
  )
    throw invalidPoll('locationOptionId must identify a meeting location option')
  return {
    id: input.id.toLowerCase(),
    slotId: input.slotId.toLowerCase(),
    bookerVoterId,
    attendeeVoterIds,
    expectedResultsRevision: input.expectedResultsRevision,
    expectedBallotRevisions,
    acknowledgeConditional: input.acknowledgeConditional,
    locationOptionId: input.locationOptionId,
    idempotencyKey: validIdempotencyKey(input.idempotencyKey),
  }
}
