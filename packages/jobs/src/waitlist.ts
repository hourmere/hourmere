import { z } from 'zod'
import { defineJob } from './index.ts'

/** Internal maintenance only. Dispatching candidates or sending mail is a later layer. */
export function waitlistMaintenanceJobs(handlers: {
  scan: () => Promise<unknown>
  cleanup: () => Promise<{ more: boolean }>
  continueCleanup?: (() => Promise<unknown>) | undefined
}) {
  const payload = z.object({}).strict()
  return [
    defineJob({
      name: 'waitlist-discovery-v1',
      payload,
      policy: 'exclusive',
      concurrency: 1,
      retry: { limit: 0 },
      expireInSeconds: 55,
      schedule: { cron: '* * * * *', payload: {} },
      handler: async () => {
        await handlers.scan()
      },
    }),
    defineJob({
      name: 'waitlist-cleanup-v1',
      payload,
      policy: 'stately',
      concurrency: 1,
      retry: { limit: 0 },
      expireInSeconds: 55,
      schedule: { cron: '0 * * * *', payload: {} },
      handler: async () => {
        const started = Date.now()
        for (let page = 0; page < 50 && Date.now() - started < 45_000; page++) {
          if (!(await handlers.cleanup()).more) return
        }
        // One bounded successor may queue beside a running cleanup. A backlog does not
        // wait another hour, and individual transactions retain their bounded page size.
        await handlers.continueCleanup?.()
      },
    }),
  ] as const
}
