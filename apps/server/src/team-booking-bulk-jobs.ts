import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { z } from 'zod'
import {
  type BulkCancellationWorkerOptions,
  type EnqueueBulkCancellation,
  recoverTeamBookingBulkCancellations,
  runTeamBookingBulkCancellation,
} from './team-booking-bulk-worker.ts'

export const TEAM_BOOKING_BULK_JOB = 'team-booking-bulk-cancellation-v1'
export const TEAM_BOOKING_BULK_RECOVERY_JOB = 'team-booking-bulk-cancellation-recovery-v1'

export function teamBookingBulkCancellationJobs(
  db: Db,
  options: BulkCancellationWorkerOptions & {
    enabled: boolean
    enqueue: EnqueueBulkCancellation
    enqueueDelayed: (batchId: string, startAfter: Date) => Promise<string | null>
  },
) {
  return [
    defineJob({
      name: TEAM_BOOKING_BULK_JOB,
      payload: z.strictObject({ batchId: z.uuid() }),
      // A running wake can arrange its own successor. An already queued wake is enough.
      policy: 'short',
      concurrency: 4,
      retry: { limit: 0 },
      expireInSeconds: 310,
      async handler({ batchId }, { signal }) {
        if (!options.enabled || signal.aborted) return
        const wakeAt = await runTeamBookingBulkCancellation(db, batchId, { ...options, signal })
        if (wakeAt && !signal.aborted) await options.enqueueDelayed(batchId, wakeAt)
      },
    }),
    defineJob({
      name: TEAM_BOOKING_BULK_RECOVERY_JOB,
      payload: z.strictObject({}),
      policy: 'exclusive',
      retry: { limit: 0 },
      ...(options.enabled && { schedule: { cron: '* * * * *', payload: {} } }),
      async handler(_, { signal }) {
        if (!options.enabled || signal.aborted) return
        await recoverTeamBookingBulkCancellations(db, options.enqueue)
      },
    }),
  ] as const
}
