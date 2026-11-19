import type { Db } from '@hourmere/db'
import { defineJob, type Jobs } from '@hourmere/jobs'
import { z } from 'zod'
import { type CalDavSyncDeps, syncCalDavCalendar } from './caldav-sync.ts'
import { CalDavError } from './caldav-transport.ts'

/** Registered by configured web/all/worker processes; only all/worker execute jobs. */
export function calDavSyncJob(deps: CalDavSyncDeps) {
  return defineJob({
    name: 'caldav-sync',
    payload: z.strictObject({ calendarId: z.uuid() }),
    policy: 'exclusive',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 120,
    handler: async ({ calendarId }, { signal }) => {
      try {
        await syncCalDavCalendar(deps, calendarId, signal)
      } catch (error) {
        // Reconnect is required; retries cannot repair rejected credentials.
        if (error instanceof CalDavError && error.code === 'unauthorized') return
        throw error
      }
    },
  })
}
/** Use for both selection and dispatch: exclusive keys preserve pending retry backoff. */
export function createCalDavSyncEnqueuer(
  jobs: Pick<Jobs<readonly [ReturnType<typeof calDavSyncJob>]>, 'enqueue'>,
) {
  return (calendarId: string, transaction?: Db) =>
    jobs.enqueue('caldav-sync', { calendarId }, { singletonKey: calendarId, transaction })
}

/** Pass createCalDavSyncEnqueuer(jobs), also used as CalDavSyncDeps.enqueueSync. */
export function calDavDispatchJob(
  deps: CalDavSyncDeps,
  enqueue: (calendarId: string) => Promise<unknown>,
) {
  return defineJob({
    name: 'caldav-sync-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 120,
    handler: async (_payload, { signal }) => {
      let after: string | undefined
      for (;;) {
        signal.throwIfAborted()
        const calendars = await deps.db
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select('c.id')
          .where('cc.provider', '=', 'caldav')
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
