import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { latestBookingId } from '@hourmere/scheduling/booking-chain'
import { sql } from 'kysely'
import { z } from 'zod'
import { type CalendarDeps, getMicrosoftCalendarToken } from './index.ts'
import {
  hasMicrosoftCalendarWriteAccess,
  type MicrosoftCalendarClient,
  MicrosoftCalendarError,
} from './microsoft.ts'
import { type MicrosoftBookingEvent, teamsJoinUrl } from './microsoft-events.ts'
import { clearMicrosoftChanges } from './microsoft-snapshot.ts'

export type CalendarWritePayload = { bookingId: string } | { groupSlotId: string }

const reasons = z.enum([
  'calendar_removed',
  'calendar_unavailable',
  'needs_reauth',
  'permissions_missing',
  'provider_unavailable',
  'rate_limited',
  'outcome_unknown',
  'event_conflict',
])
type Reason = z.infer<typeof reasons>
const maxAttempts = 6
const projectionSchema = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  seatCount: z.number().int().positive().optional(),
})
type EventProjection = z.infer<typeof projectionSchema>
const stateSchema = z.object({
  status: z.enum(['pending', 'retrying', 'failed', 'succeeded']),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime().optional(),
  reason: reasons.optional(),
  revision: z.string().optional(),
  mappedBookingId: z.uuid().optional(),
  // A claim may have sent a create request even if it did not commit a mapping.
  lookupOnly: z.boolean().optional(),
  createRevision: z.string().optional(),
  createProjection: projectionSchema.optional(),
  patchProjections: z.array(projectionSchema).max(maxAttempts).optional(),
  seatCount: z.number().int().positive().optional(),
  teamsStatus: z
    .enum(['pending', 'supported', 'join_url_pending', 'ready', 'teams_unavailable'])
    .optional(),
  teamsJoinUrl: teamsJoinUrl.optional(),
  countRevision: z
    .string()
    .regex(/^[1-9]\d*$/u)
    .optional(),
})
type WriteState = z.infer<typeof stateSchema>
const leaseMs = 120_000
const settleMs = 30_000
const pending = (now: number): WriteState => ({
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
})

/** Save the host's selected destination in the booking transaction, even if access was lost. */
export async function recordMicrosoftBookingDestinations(
  db: Db,
  bookingId: string,
  now: number,
  microsoftTeamsForTest?: CalendarDeps['microsoftTeamsForTest'],
) {
  const destinations = await db
    .selectFrom('booking_hosts as bh')
    .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
    .innerJoin('profiles as p', 'p.user_id', 'bh.user_id')
    .leftJoin('event_type_hosts as h', (join) =>
      join.onRef('h.event_type_id', '=', 'b.event_type_id').onRef('h.user_id', '=', 'bh.user_id'),
    )
    .innerJoin('calendars as c', (join) =>
      join.on(sql<boolean>`c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)`),
    )
    .innerJoin('calendar_connections as cc', (join) =>
      join.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 'bh.user_id'),
    )
    .select(['bh.user_id', 'c.id'])
    .$if(microsoftTeamsForTest !== undefined, (query) =>
      query
        .select(['b.event_type_id'])
        .select(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('booking_hosts as other')
                .select('other.user_id')
                .whereRef('other.booking_id', '=', 'b.id')
                .whereRef('other.user_id', '!=', 'bh.user_id'),
            ),
          ).as('singleHost'),
        ),
    )
    .where('bh.booking_id', '=', bookingId)
    .where('cc.provider', '=', 'microsoft')
    .where('c.access_role', '=', 'owner')
    .forKeyShare('c')
    .execute()
  if (!destinations.length) return false
  await db
    .insertInto('booking_calendar_targets')
    .values(
      destinations.map((destination) => ({
        root_booking_id: bookingId,
        user_id: destination.user_id,
        calendar_id: destination.id,
        microsoft_writeback: JSON.stringify({
          ...pending(now),
          // Production does not pass a selector until event types can choose Teams.
          ...(destination.singleHost &&
            destination.event_type_id &&
            microsoftTeamsForTest?.(destination.event_type_id) && { teamsStatus: 'pending' }),
        } satisfies WriteState),
      })),
    )
    .onConflict((oc) => oc.columns(['root_booking_id', 'user_id']).doNothing())
    .execute()
  return true
}

export async function recordMicrosoftGroupDestination(db: Db, groupSlotId: string, now: number) {
  const { numAffectedRows } = await sql`
    UPDATE group_slots s SET microsoft_writeback=${JSON.stringify(pending(now))}::jsonb
    FROM calendars c JOIN calendar_connections cc ON cc.id=c.connection_id
    WHERE s.id=${groupSlotId} AND s.destination_calendar_id=c.id AND cc.user_id=s.host_user_id
      AND cc.provider='microsoft' AND s.microsoft_writeback IS NULL
      AND c.access_role='owner'
      AND s.location->>'autoCreate' IS DISTINCT FROM 'true'
  `.execute(db)
  return Boolean(numAffectedRows) || hasMicrosoftGroupDestination(db, groupSlotId)
}

export async function hasMicrosoftBookingDestination(db: Db, bookingId: string) {
  return Boolean(
    await bookingIntents(db)
      .select('root_booking_id')
      .where('root_booking_id', '=', bookingId)
      .where('microsoft_writeback', 'is not', null)
      .executeTakeFirst(),
  )
}

export async function hasMicrosoftGroupDestination(db: Db, slotId: string) {
  return Boolean(
    await groupIntents(db)
      .select('id')
      .where('id', '=', slotId)
      .where('microsoft_writeback', 'is not', null)
      .executeTakeFirst(),
  )
}

interface Destination {
  calendarId: string
  connectionId: string | null
  userId: string
}
const bookingIntents = (db: Db) => db.selectFrom('booking_calendar_targets')
const groupIntents = (db: Db) => db.selectFrom('group_slots')
const bookingIntent = (db: Db, bookingId: string, target: Destination) =>
  bookingIntents(db)
    .where('root_booking_id', '=', bookingId)
    .where('user_id', '=', target.userId)
    .where('calendar_id', '=', target.calendarId)
const groupIntent = (db: Db, groupSlotId: string, target: Destination) =>
  groupIntents(db)
    .where('id', '=', groupSlotId)
    .where('host_user_id', '=', target.userId)
    .where('destination_calendar_id', '=', target.calendarId)

async function setState(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  state: WriteState | null,
  expected?: WriteState,
) {
  const value = state === null ? null : JSON.stringify(state)
  const current = sql<boolean>`microsoft_writeback->>'nextAttemptAt'=${expected?.nextAttemptAt}
    AND microsoft_writeback->>'attempts'=${String(expected?.attempts)}`
  if ('bookingId' in payload)
    await db
      .updateTable('booking_calendar_targets')
      .set({ microsoft_writeback: value })
      .where('root_booking_id', '=', payload.bookingId)
      .where('user_id', '=', target.userId)
      .where('calendar_id', '=', target.calendarId)
      .$if(expected !== undefined, (query) => query.where(current))
      .execute()
  else
    await db
      .updateTable('group_slots')
      .set({ microsoft_writeback: value })
      .where('id', '=', payload.groupSlotId)
      .where('host_user_id', '=', target.userId)
      .where('destination_calendar_id', '=', target.calendarId)
      .$if(expected !== undefined, (query) => query.where(current))
      .execute()
}

async function readState(db: Db, payload: CalendarWritePayload, target: Destination, lock = false) {
  const row =
    'bookingId' in payload
      ? await bookingIntent(db, payload.bookingId, target)
          .select('microsoft_writeback')
          .$if(lock, (query) => query.forUpdate())
          .executeTakeFirst()
      : await groupIntent(db, payload.groupSlotId, target)
          .select('microsoft_writeback')
          .$if(lock, (query) => query.forUpdate())
          .executeTakeFirst()
  return stateSchema.safeParse(row?.microsoft_writeback).data
}

const ownsLease = (state: WriteState | undefined, lease: WriteState) =>
  state?.attempts === lease.attempts && state.nextAttemptAt === lease.nextAttemptAt

function writeFailure(state: WriteState, now: number, reason: Reason, retryMs?: number) {
  const retry = retryMs !== undefined && state.attempts < maxAttempts
  return {
    ...state,
    status: retry ? 'retrying' : 'failed',
    updatedAt: new Date(now).toISOString(),
    nextAttemptAt: retry ? new Date(now + retryMs).toISOString() : undefined,
    reason: !retry && retryMs !== undefined && state.lookupOnly ? 'outcome_unknown' : reason,
  } satisfies WriteState
}

interface DesiredEvent {
  revision: string
  active: boolean
  bookingId?: string
  title: string
  start: Date
  end: Date
  seatCount?: number
  countRevision?: string
}

const bookingRevision = (bookingId: string, active: boolean) => `${bookingId}:${active}`
const groupRevision = (countRevision: string, active: boolean) => `${countRevision}:${active}`

async function desiredEvent(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
): Promise<DesiredEvent | undefined> {
  if ('bookingId' in payload) {
    const booking = await db
      .selectFrom('bookings as b')
      .leftJoin('booking_hosts as bh', (join) =>
        join.onRef('bh.booking_id', '=', 'b.id').on('bh.user_id', '=', target.userId),
      )
      .select(['b.id as bookingId', 'b.title', 'b.start_at as start', 'b.end_at as end'])
      .select(sql<boolean>`b.status='confirmed' AND bh.user_id IS NOT NULL`.as('active'))
      .where('b.id', '=', latestBookingId(payload.bookingId))
      .executeTakeFirst()
    return booking && { ...booking, revision: bookingRevision(booking.bookingId, booking.active) }
  }
  const slot = await groupIntent(db, payload.groupSlotId, target)
    .select([
      'title',
      'start_at as start',
      'end_at as end',
      'active_seats as seatCount',
      'count_revision as countRevision',
    ])
    .select(sql<boolean>`state='open' AND active_seats>0`.as('active'))
    .executeTakeFirst()
  return slot && { ...slot, revision: groupRevision(slot.countRevision, slot.active) }
}

const bookingMappings = (db: Db, bookingId: string, calendarId: string) =>
  db
    .selectFrom('booking_calendar_events')
    .where('booking_id', '=', bookingId)
    .where('calendar_id', '=', calendarId)
const groupMappings = (db: Db, groupSlotId: string, calendarId: string) =>
  db
    .selectFrom('group_slot_calendar_events')
    .where('group_slot_id', '=', groupSlotId)
    .where('calendar_id', '=', calendarId)

interface EventMapping {
  id: string
  projection: EventProjection
  countRevision?: string
}

async function readMapping(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  state: WriteState,
  desired: DesiredEvent,
): Promise<EventMapping | undefined> {
  if ('bookingId' in payload) {
    const mapping = await bookingMappings(
      db,
      state.mappedBookingId ?? payload.bookingId,
      target.calendarId,
    )
      .innerJoin('bookings as b', 'b.id', 'booking_calendar_events.booking_id')
      .select(['external_event_id as id', 'b.start_at as start', 'b.end_at as end'])
      .executeTakeFirst()
    return mapping && { id: mapping.id, projection: projectionOf(mapping) }
  }
  const mapping = await groupMappings(db, payload.groupSlotId, target.calendarId)
    .select(['external_event_id as id', 'count_revision as countRevision'])
    .executeTakeFirst()
  // Group slot times are immutable. Older receipts may lack the written seat count.
  const seatCount =
    mapping?.countRevision === desired.countRevision ? desired.seatCount : state.seatCount
  return mapping && { ...mapping, projection: projectionOf({ ...desired, seatCount }) }
}

const projectionOf = (value: { start: Date; end: Date; seatCount?: number }): EventProjection => ({
  start: value.start.toISOString(),
  end: value.end.toISOString(),
  seatCount: value.seatCount,
})

const sameProjection = (a: EventProjection, b: EventProjection) =>
  a.start === b.start && a.end === b.end && a.seatCount === b.seatCount

async function claim(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  clock: () => number,
) {
  return db.transaction().execute(async (trx) => {
    const state = await readState(trx, payload, target, true)
    const now = clock()
    if (!state || (state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now)) return
    const desired = await desiredEvent(trx, payload, target)
    if (!desired) return
    const mapping = await readMapping(trx, payload, target, state, desired)
    // Existing receipts predate lifecycle revisions. They describe the original create.
    let priorRevision = state.revision
    if (!priorRevision) {
      if ('bookingId' in payload) priorRevision = bookingRevision(payload.bookingId, true)
      else {
        const count = state.countRevision ?? mapping?.countRevision
        if (count) priorRevision = groupRevision(count, true)
      }
    }
    const changed = priorRevision !== undefined && priorRevision !== desired.revision
    if (!state.nextAttemptAt && !changed) return
    const attempts = changed ? 0 : state.attempts
    if (attempts >= maxAttempts) {
      await setState(
        trx,
        payload,
        target,
        writeFailure(
          state,
          now,
          state.lookupOnly ? 'outcome_unknown' : (state.reason ?? 'provider_unavailable'),
        ),
      )
      return
    }
    const possiblyCreated = state.lookupOnly === true
    if (!desired.active && !mapping && !possiblyCreated) {
      await setState(trx, payload, target, null)
      return
    }
    const mayCreate = !mapping && desired.active && state.teamsStatus !== 'pending'
    const createRevision = possiblyCreated
      ? (state.createRevision ?? priorRevision)
      : desired.revision
    let createProjection = state.createProjection
    if (!createProjection && possiblyCreated) {
      // Older claims stored the original group count, or always wrote the booking root.
      if ('bookingId' in payload) {
        const original = await trx
          .selectFrom('bookings')
          .select(['start_at as start', 'end_at as end'])
          .where('id', '=', payload.bookingId)
          .executeTakeFirst()
        if (original) createProjection = projectionOf(original)
      } else if (state.seatCount !== undefined) {
        createProjection = projectionOf({ ...desired, seatCount: state.seatCount })
      }
    }
    const priorPatches = state.patchProjections ?? []
    const projection = projectionOf(desired)
    // Record what this worker could send before I/O. A completed preflight
    // failure will restore the earlier candidates without losing a lost PATCH.
    const patchProjections =
      desired.active && (mapping || possiblyCreated)
        ? [...priorPatches.filter((prior) => !sameProjection(prior, projection)), projection].slice(
            -maxAttempts,
          )
        : priorPatches
    const lease = {
      ...state,
      revision: desired.revision,
      status: 'retrying',
      attempts: attempts + 1,
      updatedAt: new Date(now).toISOString(),
      nextAttemptAt: new Date(now + leaseMs).toISOString(),
      // A replacement worker must look up an earlier POST before deciding whether it can replay.
      lookupOnly: possiblyCreated || mayCreate,
      createRevision: possiblyCreated || mayCreate ? createRevision : undefined,
      createProjection: possiblyCreated
        ? createProjection
        : mayCreate
          ? projectionOf(desired)
          : undefined,
      patchProjections,
    } satisfies WriteState
    await setState(trx, payload, target, lease)
    return { lease, possiblyCreated, desired, mapping, priorPatches }
  })
}

async function saveMapping(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  previousBookingId: string | undefined,
  desired: DesiredEvent,
  event: MicrosoftBookingEvent | undefined,
  previous: EventMapping | undefined,
) {
  const calendarId = target.calendarId
  if ('bookingId' in payload) {
    const mappedBookingId = previousBookingId ?? payload.bookingId
    if (!event || mappedBookingId !== desired.bookingId)
      await db
        .deleteFrom('booking_calendar_events')
        .where('booking_id', '=', mappedBookingId)
        .where('calendar_id', '=', calendarId)
        .execute()
    if (event && desired.bookingId)
      await db
        .insertInto('booking_calendar_events')
        .values({
          booking_id: desired.bookingId,
          calendar_id: calendarId,
          external_event_id: event.id,
          etag: event.etag ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['booking_id', 'calendar_id']).doUpdateSet({
            external_event_id: event.id,
            etag: event.etag ?? null,
          }),
        )
        .execute()
  } else if (event && desired.countRevision) {
    await db
      .insertInto('group_slot_calendar_events')
      .values({
        group_slot_id: payload.groupSlotId,
        calendar_id: calendarId,
        external_event_id: event.id,
        etag: event.etag ?? null,
        count_revision: desired.countRevision,
      })
      .onConflict((oc) =>
        oc.column('group_slot_id').doUpdateSet({
          external_event_id: event.id,
          etag: event.etag ?? null,
          count_revision: desired.countRevision,
        }),
      )
      .execute()
  } else
    await db
      .deleteFrom('group_slot_calendar_events')
      .where('group_slot_id', '=', payload.groupSlotId)
      .where('calendar_id', '=', calendarId)
      .execute()

  const period = sql<string>`tstzrange(${desired.start.toISOString()}::timestamptz,${desired.end.toISOString()}::timestamptz,'[)')`
  if (event)
    await db
      .insertInto('calendar_busy')
      .values({ calendar_id: calendarId, external_event_id: event.id, period })
      .onConflict((oc) =>
        oc.columns(['calendar_id', 'external_event_id']).doUpdateSet({
          period,
          all_day_start: null,
          all_day_end: null,
        }),
      )
      .execute()
  else if (previous)
    await db
      .deleteFrom('calendar_busy')
      .where('calendar_id', '=', calendarId)
      .where('external_event_id', '=', previous.id)
      .execute()
}

const isGraphStatus = (error: unknown, ...statuses: number[]) =>
  error instanceof MicrosoftCalendarError &&
  error.status !== undefined &&
  statuses.includes(error.status)
const eventConflict = () => new MicrosoftCalendarError('provider_unavailable', 412)
const removedCalendar = () => new MicrosoftCalendarError('provider_unavailable', 404)

interface EventScope {
  client: MicrosoftCalendarClient
  token: string
  calendarId: string
  transactionId: string
  signal: AbortSignal
  includeTeams: boolean
}

async function updateMappedEvent(
  scope: EventScope,
  eventId: string,
  desired: DesiredEvent,
  earlier: { patches: EventProjection[]; written?: EventProjection },
  onSend: () => void,
) {
  const { client, token, calendarId, transactionId, signal, includeTeams } = scope
  const get = () =>
    client.getEvent(
      token,
      calendarId,
      eventId,
      transactionId,
      signal,
      desired.seatCount !== undefined,
      includeTeams,
    )
  const missing = async () => {
    const calendars = await client.calendars(token, signal)
    if (!calendars.some((calendar) => calendar.id === calendarId)) throw removedCalendar()
    throw eventConflict()
  }
  const wanted = projectionOf(desired)
  const actual = await get()
  if (!actual) return missing()
  if (!actual.etag || actual.hasAttendees) throw eventConflict()
  // A prior PATCH can apply before a timeout or a worker crash. Confirm the
  // written projection before using the current ETag for a subsequent revision.
  const actualProjection = projectionOf(actual)
  const written = earlier.written && {
    ...earlier.written,
    // For an older group receipt, keep the count seen on the first read as
    // the baseline for detecting a concurrent edit during this attempt.
    seatCount: earlier.written.seatCount ?? actualProjection.seatCount,
  }
  const matchesEarlierPatch = (projection: EventProjection) =>
    earlier.patches.some((prior) => sameProjection(prior, projection))
  const matchesEarlierWrite = (projection: EventProjection) =>
    (written && sameProjection(written, projection)) || matchesEarlierPatch(projection)
  if (sameProjection(actualProjection, wanted)) return actual
  if (!matchesEarlierWrite(actualProjection)) throw eventConflict()
  const patch = async (etag: string, currentJoinUrl?: string) => {
    onSend()
    const updated = await client.updateEvent(
      token,
      calendarId,
      eventId,
      etag,
      desired,
      signal,
      includeTeams,
    )
    const joinUrl = updated.teamsJoinUrl ?? currentJoinUrl
    return joinUrl ? { ...updated, teamsJoinUrl: joinUrl } : updated
  }
  let preconditionFailed: boolean
  try {
    return await patch(actual.etag, actual.teamsJoinUrl)
  } catch (error) {
    if (isGraphStatus(error, 404, 410)) return missing()
    if (!isGraphStatus(error, 409, 412)) throw error
    preconditionFailed = isGraphStatus(error, 412)
  }
  const latest = await get()
  if (!latest) return missing()
  if (!latest.etag || latest.hasAttendees) throw eventConflict()
  const latestProjection = projectionOf(latest)
  if (sameProjection(latestProjection, wanted)) return latest
  if (
    preconditionFailed
      ? matchesEarlierWrite(latestProjection)
      : latest.etag !== actual.etag && matchesEarlierPatch(latestProjection)
  )
    return patch(latest.etag, latest.teamsJoinUrl)
  throw eventConflict()
}

async function findRelocatedEvent(scope: EventScope) {
  const { client, token, calendarId, transactionId, signal } = scope
  const calendars = await client.calendars(token, signal)
  let relocated: { calendarId: string; event: MicrosoftBookingEvent } | undefined
  let incomplete = false
  for (const calendar of calendars) {
    if (calendar.id === calendarId) continue
    let event: MicrosoftBookingEvent | undefined
    try {
      event = await client.findEvent(token, calendar.id, transactionId, signal)
    } catch (error) {
      // Graph can return 404 for a shared calendar that contains private items.
      // Absence cannot be confirmed if the mailbox denies this marker lookup.
      if (calendar.accessRole !== 'owner' && isGraphStatus(error, 403, 404, 410)) {
        incomplete = true
        continue
      }
      if (isGraphStatus(error, 404, 410)) continue
      throw error
    }
    if (!event) {
      if (calendar.accessRole === 'writerWithoutPrivateAccess') incomplete = true
      continue
    }
    if (relocated || calendar.accessRole !== 'owner') throw eventConflict()
    relocated = { calendarId: calendar.id, event }
  }
  if (!relocated && incomplete) throw eventConflict()
  return { relocated, calendarPresent: calendars.some((calendar) => calendar.id === calendarId) }
}

interface DeletedEvent {
  calendarId: string
  eventId: string
}

async function removeMappedEvent(
  scope: EventScope,
  mapping: EventMapping | undefined,
  calendarRemoved: boolean,
): Promise<DeletedEvent | true | false> {
  const { client, token, calendarId, transactionId, signal } = scope
  const remove = async (calendar: string, id: string) => {
    // Deleting an organizer's meeting can send Outlook cancellation mail.
    // Verify that it is still our appointment before adopting the current ETag.
    const actual = await client.getEvent(token, calendar, id, transactionId, signal)
    if (!actual) return false
    if (!actual.etag || actual.hasAttendees) throw eventConflict()
    return (await client.deleteEvent(token, calendar, id, actual.etag, signal)) === 'deleted'
  }
  if (!calendarRemoved && mapping && (await remove(calendarId, mapping.id)))
    return { calendarId, eventId: mapping.id }

  if (!calendarRemoved) {
    let event: MicrosoftBookingEvent | undefined
    try {
      event = await client.findEvent(token, calendarId, transactionId, signal)
    } catch (error) {
      if (!isGraphStatus(error, 404, 410)) throw error
    }
    if (event) {
      if (await remove(calendarId, event.id)) return { calendarId, eventId: event.id }
      // The marker moved during cleanup. Check the remaining calendars before
      // acknowledging absence from the pinned calendar.
      throw eventConflict()
    }
  }
  const { relocated, calendarPresent } = await findRelocatedEvent(scope)
  if (relocated) {
    if (await remove(relocated.calendarId, relocated.event.id))
      return { calendarId: relocated.calendarId, eventId: relocated.event.id }
    throw eventConflict()
  }
  if (calendarRemoved || !calendarPresent) throw removedCalendar()
  // An absent mapped event has already been deleted. An ambiguous POST might
  // still become visible after Graph settles, so keep its bounded retry active.
  return Boolean(mapping)
}

async function resetWritebackSnapshot(db: Db, calendarId: string) {
  // A delta round staged before the write could otherwise publish the old time
  // again. Resume from the last complete cursor, keeping its current snapshot.
  const reset = await db
    .updateTable('calendars')
    .set({ sync_state: sql<string>`sync_state - 'microsoftPending'` })
    .where('id', '=', calendarId)
    .where(sql<boolean>`sync_state ? 'microsoftPending'`)
    .returning('id')
    .executeTakeFirst()
  if (reset) await clearMicrosoftChanges(db, reset.id)
}

async function writeDestination(
  deps: CalendarDeps,
  payload: CalendarWritePayload,
  target: Destination,
  signal: AbortSignal,
) {
  const clock = deps.now ?? Date.now
  const attempt = await claim(deps.db, payload, target, clock)
  if (!attempt) return
  const { lease, possiblyCreated, desired, mapping, priorPatches } = attempt
  const { connectionId } = target
  if (!connectionId) {
    // A group slot retains its pinned destination after explicit disconnection.
    await setState(
      deps.db,
      payload,
      target,
      writeFailure({ ...lease, lookupOnly: possiblyCreated }, clock(), 'calendar_removed'),
      lease,
    )
    return
  }
  return deps.db.transaction().execute(async (trx) => {
    // Match the busy/list credential rotation lock order. This also serializes disconnect.
    await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', target.userId)
      .forKeyShare()
      .executeTakeFirst()
    const connection = await trx
      .selectFrom('calendar_connections')
      .select(['id', 'credentials', 'external_account_id', 'scopes', 'status'])
      .where('id', '=', connectionId)
      .where('user_id', '=', target.userId)
      .where('provider', '=', 'microsoft')
      .forUpdate()
      .executeTakeFirst()
    if (!ownsLease(await readState(trx, payload, target), lease)) return

    const complete = async (
      state: WriteState,
      event?: MicrosoftBookingEvent,
      deleted?: DeletedEvent | true,
    ) => {
      if (!ownsLease(await readState(trx, payload, target, true), lease)) return
      if (event || state.status === 'succeeded') {
        await saveMapping(trx, payload, target, lease.mappedBookingId, desired, event, mapping)
        if (mapping || patchSent || deleted) await resetWritebackSnapshot(trx, target.calendarId)
        if (deleted && deleted !== true) {
          const movedCalendar = await trx
            .selectFrom('calendars')
            .select('id')
            .where('connection_id', '=', connectionId)
            .where('external_id', '=', deleted.calendarId)
            .executeTakeFirst()
          if (movedCalendar) {
            await trx
              .deleteFrom('calendar_busy')
              .where('external_event_id', '=', deleted.eventId)
              .where('calendar_id', '=', movedCalendar.id)
              .execute()
            if (movedCalendar.id !== target.calendarId)
              await resetWritebackSnapshot(trx, movedCalendar.id)
          }
        }
      }
      // If the follow-up job saw the lease and returned, dispatch still needs to
      // find the new revision. Holding the intent lock also makes this check
      // atomic with any worker inspecting the new revision after the booking commits.
      const latest = await desiredEvent(trx, payload, target)
      const changed = latest && latest.revision !== desired.revision && !state.nextAttemptAt
      await setState(
        trx,
        payload,
        target,
        changed
          ? {
              ...state,
              ...pending(clock()),
              reason: undefined,
            }
          : state,
      )
      return changed
    }
    let patchSent = false
    const onPatch = () => {
      patchSent = true
    }
    const finish = (reason: Reason, retryMs?: number, uncertain = possiblyCreated) =>
      complete(
        writeFailure(
          {
            ...lease,
            lookupOnly: uncertain,
            patchProjections: patchSent ? lease.patchProjections : priorPatches,
          },
          clock(),
          reason,
          retryMs,
        ),
      )

    const calendar = await trx
      .selectFrom('calendars')
      .select(['external_id', 'access_role', 'sync_error'])
      .where('id', '=', target.calendarId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst()
    if (!calendar || (calendar.sync_error === 'calendar_removed' && desired.active))
      return finish('calendar_removed')
    if (!connection || !deps.microsoft || calendar.access_role !== 'owner')
      return finish('calendar_unavailable')
    if (connection.status !== 'active') return finish('needs_reauth')
    if (!hasMicrosoftCalendarWriteAccess(connection.scopes)) return finish('permissions_missing')

    const resource =
      'bookingId' in payload ? ['booking', payload.bookingId] : ['group', payload.groupSlotId]
    const transactionId = createHash('sha256')
      .update(JSON.stringify(['hourmere', ...resource, calendar.external_id]))
      .digest('hex')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    const backoff = Math.min(settleMs * 2 ** (lease.attempts - 1), 15 * 60_000)
    let event: MicrosoftBookingEvent | undefined
    let deleted: DeletedEvent | true | false | undefined
    let posted = false
    const includeTeams =
      lease.teamsStatus === 'supported' ||
      lease.teamsStatus === 'join_url_pending' ||
      lease.teamsStatus === 'ready'
    try {
      const { token, scopes } = await getMicrosoftCalendarToken(
        deps.microsoft,
        trx,
        target.userId,
        connection,
        clock,
        deadline,
      )
      if (!hasMicrosoftCalendarWriteAccess(scopes)) return finish('permissions_missing')
      const client = deps.microsoft.client
      const scope = {
        client,
        token,
        calendarId: calendar.external_id,
        transactionId,
        signal: deadline,
        includeTeams,
      }
      if (!desired.active) {
        deleted = await removeMappedEvent(
          scope,
          mapping,
          calendar.sync_error === 'calendar_removed',
        )
        if (!deleted) return finish('provider_unavailable', backoff)
      } else if (lease.teamsStatus === 'pending') {
        const supported = await client.calendarSupportsTeams(token, scope.calendarId, deadline)
        // Pin the provider choice before any POST so replay keeps the same request.
        // The capability check and the event write each have a bounded retry budget.
        await complete({
          ...pending(clock()),
          revision: desired.revision,
          teamsStatus: supported ? 'supported' : 'teams_unavailable',
        })
        return 'probed'
      } else if (mapping) {
        event = await updateMappedEvent(
          scope,
          mapping.id,
          desired,
          { patches: priorPatches, written: mapping.projection },
          onPatch,
        )
      } else {
        event = await client.findEvent(
          token,
          scope.calendarId,
          transactionId,
          deadline,
          includeTeams,
        )
        if (!event) {
          if (possiblyCreated && (await findRelocatedEvent(scope)).relocated) throw eventConflict()
          if (!(await desiredEvent(trx, payload, target))?.active) {
            if (possiblyCreated) return finish('provider_unavailable', backoff)
          } else {
            const original = lease.createProjection
            // A replay keeps the original POST projection and transaction ID.
            // If the booking moved, the same event can then be PATCHed safely.
            const value = original
              ? {
                  ...desired,
                  start: new Date(original.start),
                  end: new Date(original.end),
                  seatCount: original.seatCount,
                }
              : desired
            posted = true
            event = await client.createEvent(
              token,
              scope.calendarId,
              { ...value, transactionId, ...(includeTeams && { teams: true }) },
              deadline,
            )
          }
        }
        if (event && possiblyCreated && lease.createRevision !== desired.revision)
          event = await updateMappedEvent(
            scope,
            event.id,
            desired,
            {
              patches: priorPatches,
              written: lease.createProjection,
            },
            onPatch,
          )
      }
      if (event && includeTeams && !event.teamsJoinUrl) {
        // Graph confirmed the copy. Retry its meeting details using the saved event ID.
        return complete(
          writeFailure(
            {
              ...lease,
              mappedBookingId: desired.bookingId,
              lookupOnly: false,
              createRevision: undefined,
              createProjection: undefined,
              patchProjections: undefined,
              teamsStatus: 'join_url_pending',
              teamsJoinUrl: undefined,
            },
            clock(),
            'provider_unavailable',
            backoff,
          ),
          event,
        )
      }
    } catch (error) {
      if (!(error instanceof MicrosoftCalendarError)) throw error
      if (error.code === 'needs_reauth') {
        await trx
          .updateTable('calendar_connections')
          .set({ status: 'needs_reauth', last_error: 'needs_reauth' })
          .where('id', '=', connection.id)
          .execute()
        return finish('needs_reauth')
      }
      if (error.code === 'permissions_missing') return finish('permissions_missing')
      if (isGraphStatus(error, 404, 410)) return finish('calendar_removed')
      if (error.status === 429)
        return finish('rate_limited', Math.max(error.retryAfterMs ?? 0, backoff))
      if (isGraphStatus(error, 409, 412))
        return finish(
          'event_conflict',
          posted || !desired.active ? backoff : undefined,
          possiblyCreated || posted,
        )
      if (
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        return finish('calendar_unavailable')
      return finish('provider_unavailable', backoff, posted || possiblyCreated)
    }
    const joinUrl = includeTeams ? event?.teamsJoinUrl : undefined
    return complete(
      {
        status: 'succeeded',
        attempts: lease.attempts,
        updatedAt: new Date(clock()).toISOString(),
        revision: desired.revision,
        mappedBookingId: event ? desired.bookingId : undefined,
        seatCount: event ? desired.seatCount : undefined,
        teamsStatus: joinUrl
          ? 'ready'
          : event && lease.teamsStatus === 'teams_unavailable'
            ? 'teams_unavailable'
            : undefined,
        teamsJoinUrl: joinUrl,
      },
      event,
      deleted || undefined,
    )
  })
}

/** Reuses the booking queue for newly pinned destinations and due retries. */
export async function writeMicrosoftCalendar(
  deps: CalendarDeps,
  payload: CalendarWritePayload,
  signal: AbortSignal,
) {
  const destinations =
    'bookingId' in payload
      ? await deps.db
          .selectFrom('booking_calendar_targets as t')
          .innerJoin('calendars as c', 'c.id', 't.calendar_id')
          .innerJoin('calendar_connections as cc', (join) =>
            join.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 't.user_id'),
          )
          .select(['c.id as calendarId', 'cc.id as connectionId', 't.user_id as userId'])
          .where('t.root_booking_id', '=', payload.bookingId)
          .where('cc.provider', '=', 'microsoft')
          .where('t.microsoft_writeback', 'is not', null)
          .orderBy('c.id')
          .execute()
      : await deps.db
          .selectFrom('group_slots as s')
          .leftJoin('calendars as c', 'c.id', 's.destination_calendar_id')
          .leftJoin('calendar_connections as cc', (join) =>
            join
              .onRef('cc.id', '=', 'c.connection_id')
              .onRef('cc.user_id', '=', 's.host_user_id')
              .on('cc.provider', '=', 'microsoft'),
          )
          .select([
            's.destination_calendar_id as calendarId',
            'cc.id as connectionId',
            's.host_user_id as userId',
          ])
          .where('s.id', '=', payload.groupSlotId)
          .where('s.destination_calendar_id', 'is not', null)
          .where('s.microsoft_writeback', 'is not', null)
          .$narrowType<{ calendarId: string }>()
          .execute()
  for (const destination of destinations) {
    signal.throwIfAborted()
    let maxPasses = 2
    for (let pass = 0; pass < maxPasses; pass++) {
      const result = await writeDestination(deps, payload, destination, signal)
      if (!result) break
      // A capability probe reserves one pass in addition to the usual write and reconciliation.
      if (result === 'probed') maxPasses = 3
    }
  }
}

export async function dispatchMicrosoftWritebacks(
  deps: CalendarDeps,
  enqueue: (payload: CalendarWritePayload) => Promise<unknown>,
  signal: AbortSignal,
) {
  const now = new Date((deps.now ?? Date.now)()).toISOString()
  const { rows } = await sql<{ booking_id: string | null; group_slot_id: string | null }>`
    SELECT booking_id,group_slot_id FROM (
      (SELECT root_booking_id AS booking_id,NULL::uuid AS group_slot_id,min(microsoft_writeback->>'nextAttemptAt') AS due
      FROM booking_calendar_targets
      WHERE microsoft_writeback->>'status' IN ('pending','retrying')
        AND microsoft_writeback->>'nextAttemptAt' <= ${now}
      GROUP BY root_booking_id ORDER BY due,root_booking_id LIMIT 100)
      UNION ALL
      (SELECT NULL::uuid,id,microsoft_writeback->>'nextAttemptAt' AS due FROM group_slots
      WHERE microsoft_writeback->>'status' IN ('pending','retrying')
        AND microsoft_writeback->>'nextAttemptAt' <= ${now} AND destination_calendar_id IS NOT NULL
      ORDER BY due,id LIMIT 100)
    ) work ORDER BY due
  `.execute(deps.db)
  for (const item of rows) {
    signal.throwIfAborted()
    if (item.booking_id) await enqueue({ bookingId: item.booking_id })
    else if (item.group_slot_id) await enqueue({ groupSlotId: item.group_slot_id })
  }
}

export async function readMicrosoftWritebackSummary(db: Db, calendarIds: string[], now: number) {
  const result = new Map<string, Pick<WriteState, 'status' | 'reason'>>()
  if (!calendarIds.length) return result
  const stamp = new Date(now).toISOString()
  const { rows } = await sql<{ calendar_id: string; state: unknown }>`
    SELECT c.id AS calendar_id, latest.state FROM calendars c
    JOIN calendar_connections cc ON cc.id=c.connection_id AND cc.provider='microsoft'
    CROSS JOIN LATERAL (
      SELECT state FROM (
        SELECT t.microsoft_writeback AS state FROM booking_calendar_targets t
        JOIN bookings b ON b.id=${latestBookingId(sql.ref('t.root_booking_id'))}
        WHERE t.calendar_id=c.id AND t.user_id=cc.user_id AND t.microsoft_writeback IS NOT NULL
          AND (b.start_at>${stamp}::timestamptz OR (
            t.microsoft_writeback->>'revision' LIKE '%:false'
            AND t.microsoft_writeback->>'status'<>'succeeded'
          ))
        UNION ALL
        SELECT s.microsoft_writeback AS state FROM group_slots s
        WHERE s.destination_calendar_id=c.id AND s.host_user_id=cc.user_id
          AND s.microsoft_writeback IS NOT NULL AND (s.start_at>${stamp}::timestamptz OR (
            s.microsoft_writeback->>'revision' LIKE '%:false'
            AND s.microsoft_writeback->>'status'<>'succeeded'
          ))
      ) intents
      ORDER BY CASE state->>'status' WHEN 'failed' THEN 0 WHEN 'retrying' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        state->>'updatedAt' DESC LIMIT 1
    ) latest WHERE c.id = ANY(${calendarIds}::uuid[])
  `.execute(db)
  for (const row of rows) {
    const state = stateSchema.safeParse(row.state).data
    if (state) result.set(row.calendar_id, { status: state.status, reason: state.reason })
  }
  return result
}

const resetWriteState = (stamp: string) =>
  sql<string>`(microsoft_writeback - 'reason') || jsonb_build_object(
    'status','pending','attempts',0,'updatedAt',${stamp}::text,'nextAttemptAt',
    CASE WHEN microsoft_writeback->>'reason' = 'outcome_unknown' THEN
      to_char(greatest(${stamp}::timestamptz,
        (microsoft_writeback->>'updatedAt')::timestamptz + make_interval(secs => ${settleMs / 1000})
      ) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE ${stamp}::text END
  )`

/** Restart the selected resource's bounded retry budget without discarding its marker. */
export async function redispatchMicrosoftWriteback(
  db: Db,
  payload: CalendarWritePayload,
  now: number,
) {
  const recovered = resetWriteState(new Date(now).toISOString())
  const failed = sql<boolean>`microsoft_writeback->>'status'='failed'`
  if ('bookingId' in payload)
    await db
      .updateTable('booking_calendar_targets')
      .set({ microsoft_writeback: recovered })
      .where('root_booking_id', '=', payload.bookingId)
      .where(failed)
      .execute()
  else
    await db
      .updateTable('group_slots')
      .set({ microsoft_writeback: recovered })
      .where('id', '=', payload.groupSlotId)
      .where(failed)
      .execute()
}

/** Restart failed future writes for this account after reconnect or operator recovery. */
export async function recoverMicrosoftWritebacks(db: Db, connectionId: string, now: number) {
  const stamp = new Date(now).toISOString()
  const recovered = resetWriteState(stamp)
  await sql`
    UPDATE booking_calendar_targets t SET microsoft_writeback=${recovered}
    FROM calendars c, bookings b
    WHERE t.calendar_id=c.id AND c.connection_id=${connectionId}
      AND b.id=${latestBookingId(sql.ref('t.root_booking_id'))}
      AND (b.start_at>${stamp}::timestamptz OR t.microsoft_writeback->>'revision' LIKE '%:false')
      AND t.microsoft_writeback->>'status'='failed'
      AND t.microsoft_writeback->>'reason' IN ('needs_reauth','permissions_missing','outcome_unknown')
  `.execute(db)
  await sql`
    UPDATE group_slots s SET microsoft_writeback=${recovered}
    FROM calendars c
    WHERE s.destination_calendar_id=c.id AND c.connection_id=${connectionId}
      AND (s.start_at>${stamp}::timestamptz OR s.microsoft_writeback->>'revision' LIKE '%:false')
      AND s.microsoft_writeback->>'status'='failed'
      AND s.microsoft_writeback->>'reason' IN ('needs_reauth','permissions_missing','outcome_unknown')
  `.execute(db)
}
