import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { z } from 'zod'
import {
  BOOKING_CALENDAR_JOB,
  recoverBookingCalendarPage,
  writeBookingCalendar,
} from './booking-events.ts'
import type { CalendarDeps } from './index.ts'
import { syncGoogleCalendar } from './sync.ts'

export function calendarSyncJob(deps: CalendarDeps) {
  return defineJob({
    name: 'calendar-sync',
    payload: z.strictObject({ calendarId: z.uuid() }),
    policy: 'exclusive',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 120,
    handler: ({ calendarId }, { signal }) =>
      syncGoogleCalendar(deps, calendarId, AbortSignal.any([signal, AbortSignal.timeout(60_000)])),
  })
}
export function bookingCalendarJob(deps: CalendarDeps) {
  return defineJob({
    name: BOOKING_CALENDAR_JOB,
    payload: z.strictObject({ bookingId: z.uuid() }),
    policy: 'stately',
    concurrency: 2,
    retry: { limit: 12, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
    expireInSeconds: 300,
    handler: ({ bookingId }, { signal }) =>
      writeBookingCalendar(
        deps,
        bookingId,
        AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      ),
  })
}
export function calendarDispatchJob(
  deps: CalendarDeps,
  enqueue: (calendarId: string) => Promise<unknown>,
) {
  return defineJob({
    name: 'calendar-sync-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 120,
    handler: async (_payload, { signal }) => {
      if (!deps.google) return
      let after: string | undefined
      for (;;) {
        signal.throwIfAborted()
        const calendars = await deps.db
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select('c.id')
          .where('cc.provider', '=', 'google')
          .where('cc.status', '=', 'active')
          .where('c.check_conflicts', '=', true)
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
