import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  BOOKING_CALENDAR_JOB,
  recoverBookingCalendarPage,
  writeBookingCalendar,
} from './booking-events.ts'
import { writeGroupSlotCalendar } from './group-slot-events.ts'
import type { CalendarDeps } from './index.ts'
import { syncMicrosoftCalendar } from './microsoft-sync.ts'
import {
  type CalendarWritePayload,
  dispatchMicrosoftWritebacks,
  writeMicrosoftCalendar,
} from './microsoft-writeback.ts'
import { SYNC_MAX_AGE_MS, syncGoogleCalendar } from './sync.ts'

export function calendarSyncJob(deps: CalendarDeps) {
  return defineJob({
    name: 'calendar-sync',
    payload: z.strictObject({ calendarId: z.uuid() }),
    policy: 'exclusive',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 120,
    handler: async ({ calendarId }, { signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      const calendar =
        deps.microsoft &&
        (await deps.db
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select('cc.provider')
          .where('c.id', '=', calendarId)
          .executeTakeFirst())
      if (calendar && calendar.provider === 'microsoft')
        await syncMicrosoftCalendar(deps, calendarId, deadline)
      else await syncGoogleCalendar(deps, calendarId, deadline)
    },
  })
}
export function bookingCalendarJob(deps: CalendarDeps) {
  return defineJob({
    name: BOOKING_CALENDAR_JOB,
    payload: z.union([
      z.strictObject({ bookingId: z.uuid() }),
      z.strictObject({ groupSlotId: z.uuid() }),
    ]),
    policy: 'stately',
    concurrency: 2,
    retry: { limit: 12, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
    expireInSeconds: 300,
    handler: async (payload, { signal }) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      if ('groupSlotId' in payload) {
        await writeMicrosoftCalendar(deps, payload, deadline)
        await writeGroupSlotCalendar(deps, payload.groupSlotId, deadline)
      } else await writeBookingCalendar(deps, payload.bookingId, deadline)
    },
  })
}
export function calendarDispatchJob(
  deps: CalendarDeps,
  enqueue: (calendarId: string) => Promise<unknown>,
  enqueueWriteback?: (payload: CalendarWritePayload) => Promise<unknown>,
) {
  return defineJob({
    name: 'calendar-sync-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 120,
    handler: async (_payload, { signal }) => {
      if (enqueueWriteback) await dispatchMicrosoftWritebacks(deps, enqueueWriteback, signal)
      const providers = [
        ...(deps.google ? ['google'] : []),
        ...(deps.microsoft ? ['microsoft'] : []),
      ]
      if (!providers.length) return
      let after: string | undefined
      for (;;) {
        signal.throwIfAborted()
        const now = (deps.now ?? Date.now)()
        const calendars = await deps.db
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select('c.id')
          .where('cc.provider', 'in', providers)
          .where('cc.status', '=', 'active')
          .where('c.check_conflicts', '=', true)
          .where(({ or, eb }) =>
            or([
              eb('cc.provider', '!=', 'microsoft'),
              eb.and([
                eb('c.sync_error', 'is distinct from', 'calendar_removed'),
                sql<boolean>`coalesce(c.sync_state->>'retryAt','') <= ${new Date(now).toISOString()}`,
                or([
                  eb('c.last_synced_at', 'is', null),
                  eb('c.sync_error', 'is not', null),
                  sql<boolean>`c.sync_state->>'deltaLink' is null or c.sync_state->'microsoftPending' is not null`,
                  // Refresh the Graph cursor before the snapshot becomes stale.
                  eb('c.last_synced_at', '<=', new Date(now - SYNC_MAX_AGE_MS / 2)),
                ]),
              ]),
            ]),
          )
          .$if(Boolean(after), (q) => q.where('c.id', '>', after as string))
          .orderBy('c.id')
          .limit(100)
          .execute()
        for (const calendar of calendars) {
          signal.throwIfAborted()
          await enqueue(calendar.id)
        }
        if (calendars.length < 100) return
        after = calendars.at(-1)?.id
      }
    },
  })
}

/** Explicit finite pass after reauthorization or an operator-requested recovery. */
export function bookingCalendarRecoveryJob(
  deps: CalendarDeps,
  enqueueBooking: (bookingId: string, transaction: Db) => Promise<unknown>,
  enqueueRecovery: (connectionId: string, after: string) => Promise<unknown>,
) {
  return defineJob({
    name: 'booking-calendar-recover',
    payload: z.strictObject({ connectionId: z.uuid(), after: z.uuid().optional() }),
    policy: 'stately',
    concurrency: 1,
    retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
    expireInSeconds: 300,
    handler: async ({ connectionId, after }, { signal }) => {
      signal.throwIfAborted()
      const next = await recoverBookingCalendarPage(deps, connectionId, after, enqueueBooking)
      if (next) await enqueueRecovery(connectionId, next)
    },
  })
}
