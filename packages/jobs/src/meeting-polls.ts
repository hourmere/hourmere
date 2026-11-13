import { z } from 'zod'
import { defineJob } from './index.ts'

/**
 * Hourly meeting-poll cleanup (docs/meeting-polls.md, "Storage policy and cleanup schedule").
 * Each page is a bounded set of transactions that never wait for locks; a backlog continues
 * in one successor job instead of waiting another hour.
 */
export function meetingPollCleanupJob(handlers: {
  cleanup: () => Promise<{ more: boolean }>
  continueCleanup?: (() => Promise<unknown>) | undefined
}) {
  return defineJob({
    name: 'meeting-poll-cleanup-v1',
    payload: z.object({}).strict(),
    policy: 'stately',
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 55,
    schedule: { cron: '0 * * * *', payload: {} },
    handler: async (_, { signal }) => {
      const started = Date.now()
      for (let page = 0; page < 50 && Date.now() - started < 45_000; page++) {
        if (signal.aborted) return
        if (!(await handlers.cleanup()).more) return
      }
      // One bounded successor may queue beside a running cleanup.
      await handlers.continueCleanup?.()
    },
  })
}
