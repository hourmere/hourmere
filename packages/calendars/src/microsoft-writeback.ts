import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { type CalendarDeps, getMicrosoftCalendarToken } from './index.ts'
import { hasMicrosoftCalendarWriteAccess, MicrosoftCalendarError } from './microsoft.ts'
import type { MicrosoftBookingEvent } from './microsoft-events.ts'

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
const stateSchema = z.object({
  status: z.enum(['pending', 'retrying', 'failed', 'succeeded']),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  nextAttemptAt: z.iso.datetime().optional(),
  reason: reasons.optional(),
  // Persisted marker that a previous claim may already have created the event.
  lookupOnly: z.boolean().optional(),
  seatCount: z.number().int().positive().optional(),
  countRevision: z
    .string()
    .regex(/^[1-9]\d*$/u)
    .optional(),
})
type WriteState = z.infer<typeof stateSchema>
const maxAttempts = 6
const leaseMs = 120_000
const settleMs = 30_000
const pending = (now: number): WriteState => ({
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
})

/** Save the host's selected destination in the booking transaction, even if access was lost. */
export async function recordMicrosoftBookingDestinations(db: Db, bookingId: string, now: number) {
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
        microsoft_writeback: JSON.stringify(pending(now)),
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
  return Boolean(numAffectedRows)
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

async function claim(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  clock: () => number,
) {
  return db.transaction().execute(async (trx) => {
    const state = await readState(trx, payload, target, true)
    const now = clock()
    if (!state?.nextAttemptAt || Date.parse(state.nextAttemptAt) > now) return
    if (state.attempts >= maxAttempts) {
      await setState(trx, payload, target, writeFailure(state, now, 'outcome_unknown'))
      return
    }
    const possiblyCreated = state.lookupOnly === true
    const desired = possiblyCreated ? undefined : await desiredEvent(trx, payload, target)
    if (!desired && !possiblyCreated) {
      await setState(trx, payload, target, null)
      return
    }
    const lease = {
      ...state,
      status: 'retrying',
      attempts: state.attempts + 1,
      updatedAt: new Date(now).toISOString(),
      nextAttemptAt: new Date(now + leaseMs).toISOString(),
      // Commit before provider I/O. If this worker dies, its lease gives Graph
      // time to settle before another worker looks up the same transaction.
      lookupOnly: true,
      // A group replay uses the original seat count and reports the revision that sent it.
      seatCount: possiblyCreated ? state.seatCount : desired?.seatCount,
      countRevision: possiblyCreated ? state.countRevision : desired?.countRevision,
    } satisfies WriteState
    await setState(trx, payload, target, lease)
    return { lease, possiblyCreated }
  })
}

async function desiredEvent(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
): Promise<
  { title: string; start: Date; end: Date; seatCount?: number; countRevision?: string } | undefined
> {
  if ('bookingId' in payload) {
    const booking = await db
      .selectFrom('bookings as b')
      .innerJoin('booking_hosts as bh', 'bh.booking_id', 'b.id')
      .select(['b.title', 'b.start_at as start', 'b.end_at as end'])
      .where('b.id', '=', payload.bookingId)
      .where('bh.user_id', '=', target.userId)
      .where('b.status', '=', 'confirmed')
      .where('b.rescheduled_from_id', 'is', null)
      .executeTakeFirst()
    return booking
  }
  const slot = await groupIntent(db, payload.groupSlotId, target)
    .select([
      'title',
      'start_at as start',
      'end_at as end',
      'active_seats as seatCount',
      'count_revision as countRevision',
    ])
    .where('state', '=', 'open')
    .where('active_seats', '>', 0)
    .executeTakeFirst()
  return slot
}

async function saveMapping(
  db: Db,
  payload: CalendarWritePayload,
  target: Destination,
  event: MicrosoftBookingEvent,
  countRevision: string | undefined,
) {
  const mapping = {
    calendar_id: target.calendarId,
    external_event_id: event.id,
    etag: event.etag ?? null,
  }
  if ('bookingId' in payload)
    await db
      .insertInto('booking_calendar_events')
      .values({ booking_id: payload.bookingId, ...mapping })
      .onConflict((oc) => oc.columns(['booking_id', 'calendar_id']).doNothing())
      .execute()
  else {
    if (!countRevision) throw new Error('Missing Microsoft group calendar revision')
    await db
      .insertInto('group_slot_calendar_events')
      .values({ group_slot_id: payload.groupSlotId, count_revision: countRevision, ...mapping })
      .onConflict((oc) => oc.column('group_slot_id').doNothing())
      .execute()
  }
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
  const { lease, possiblyCreated } = attempt
  const { connectionId } = target
  if (!connectionId) {
    // A group slot retains its pinned destination after explicit disconnection.
    return setState(
      deps.db,
      payload,
      target,
      writeFailure({ ...lease, lookupOnly: possiblyCreated }, clock(), 'calendar_removed'),
      lease,
    )
  }
  await deps.db.transaction().execute(async (trx) => {
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

    const finish = (reason: Reason, retryMs?: number, uncertain = possiblyCreated) =>
      setState(
        trx,
        payload,
        target,
        writeFailure({ ...lease, lookupOnly: uncertain }, clock(), reason, retryMs),
        lease,
      )
    const calendar = await trx
      .selectFrom('calendars')
      .select(['external_id', 'access_role', 'sync_error'])
      .where('id', '=', target.calendarId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst()
    if (!calendar || calendar.sync_error === 'calendar_removed') return finish('calendar_removed')
    if (!connection || !deps.microsoft || calendar.access_role !== 'owner')
      return finish('calendar_unavailable')
    if (connection.status !== 'active') return finish('needs_reauth')
    if (!hasMicrosoftCalendarWriteAccess(connection.scopes)) return finish('permissions_missing')

    if (!possiblyCreated && !(await desiredEvent(trx, payload, target)))
      return setState(trx, payload, target, null, lease)
    const resource =
      'bookingId' in payload ? ['booking', payload.bookingId] : ['group', payload.groupSlotId]
    const transactionId = createHash('sha256')
      .update(JSON.stringify(['hourmere', ...resource, calendar.external_id]))
      .digest('hex')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    const backoff = Math.min(settleMs * 2 ** (lease.attempts - 1), 15 * 60_000)
    let event: MicrosoftBookingEvent | undefined
    let posted = false
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
      event = await client.findEvent(token, calendar.external_id, transactionId, deadline)
      if (!event) {
        const desired = await desiredEvent(trx, payload, target)
        if (!desired)
          return possiblyCreated
            ? finish(
                lease.reason === 'event_conflict' ? 'event_conflict' : 'provider_unavailable',
                backoff,
              )
            : setState(trx, payload, target, null, lease)
        // An empty lookup after the settle delay permits an idempotent replay.
        posted = true
        event = await client.createEvent(
          token,
          calendar.external_id,
          { ...desired, seatCount: lease.seatCount ?? desired.seatCount, transactionId },
          deadline,
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
      if (error.status === 404 || error.status === 410) return finish('calendar_removed')
      if (error.status === 429)
        return finish('rate_limited', Math.max(error.retryAfterMs ?? 0, backoff))
      if (error.status === 409 || error.status === 412)
        return finish('event_conflict', backoff, possiblyCreated || posted)
      if (
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        return finish('calendar_unavailable')
      return finish('provider_unavailable', backoff, posted || possiblyCreated)
    }
    // Do not hold the group slot lock over provider I/O. Recheck the lease before
    // committing the mapping and status together.
    if (!ownsLease(await readState(trx, payload, target, true), lease)) return
    await saveMapping(trx, payload, target, event, lease.countRevision)
    await setState(trx, payload, target, {
      status: 'succeeded',
      attempts: lease.attempts,
      updatedAt: new Date(clock()).toISOString(),
    })
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
    await writeDestination(deps, payload, destination, signal)
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
        JOIN bookings b ON b.id=t.root_booking_id
        WHERE t.calendar_id=c.id AND t.user_id=cc.user_id AND b.start_at>${stamp}::timestamptz
          AND t.microsoft_writeback IS NOT NULL
        UNION ALL
        SELECT s.microsoft_writeback AS state FROM group_slots s
        WHERE s.destination_calendar_id=c.id AND s.host_user_id=cc.user_id AND s.start_at>${stamp}::timestamptz
          AND s.microsoft_writeback IS NOT NULL
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
  const unknown = sql<boolean>`microsoft_writeback->>'status'='failed'
    AND microsoft_writeback->>'reason'='outcome_unknown'`
  if ('bookingId' in payload)
    await db
      .updateTable('booking_calendar_targets')
      .set({ microsoft_writeback: recovered })
      .where('root_booking_id', '=', payload.bookingId)
      .where(unknown)
      .execute()
  else
    await db
      .updateTable('group_slots')
      .set({ microsoft_writeback: recovered })
      .where('id', '=', payload.groupSlotId)
      .where(unknown)
      .execute()
}

/** Restart failed future writes for this account after reconnect or operator recovery. */
export async function recoverMicrosoftWritebacks(db: Db, connectionId: string, now: number) {
  const stamp = new Date(now).toISOString()
  const recovered = resetWriteState(stamp)
  await sql`
    UPDATE booking_calendar_targets t SET microsoft_writeback=${recovered}
    FROM calendars c, bookings b
    WHERE t.calendar_id=c.id AND c.connection_id=${connectionId} AND b.id=t.root_booking_id
      AND b.start_at>${stamp}::timestamptz AND t.microsoft_writeback->>'status'='failed'
      AND t.microsoft_writeback->>'reason' IN ('needs_reauth','permissions_missing','outcome_unknown')
  `.execute(db)
  await sql`
    UPDATE group_slots s SET microsoft_writeback=${recovered}
    FROM calendars c
    WHERE s.destination_calendar_id=c.id AND c.connection_id=${connectionId}
      AND s.start_at>${stamp}::timestamptz AND s.microsoft_writeback->>'status'='failed'
      AND s.microsoft_writeback->>'reason' IN ('needs_reauth','permissions_missing','outcome_unknown')
  `.execute(db)
}
