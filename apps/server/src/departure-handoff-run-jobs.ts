import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import {
  type EnqueueDepartureHandoffRun,
  recoverDepartureHandoffRuns,
  runDepartureHandoffQueueItem,
} from '@hourmere/scheduling/departure-handoff-queue'
import { z } from 'zod'

export const DEPARTURE_HANDOFF_RUN_JOB = 'departure-handoff-run-v1'
export const DEPARTURE_HANDOFF_RUN_RECOVERY_JOB = 'departure-handoff-run-recovery-v1'

const payload = z.strictObject({ organizationId: z.uuid(), runId: z.uuid() })
type RunJobPayload = z.output<typeof payload>

type RunQueue = {
  enqueue(
    name: typeof DEPARTURE_HANDOFF_RUN_JOB,
    args: RunJobPayload,
    options: EnqueueOptions,
  ): Promise<string | null>
}

export function enqueueDepartureHandoffRunJob(
  queue: RunQueue,
  args: RunJobPayload,
  { transaction, startAfter }: Pick<EnqueueOptions, 'transaction' | 'startAfter'>,
) {
  return queue.enqueue(DEPARTURE_HANDOFF_RUN_JOB, args, {
    singletonKey: `${args.organizationId}:${args.runId}`,
    transaction,
    startAfter,
  })
}

export function departureHandoffRunJobs(
  db: Db,
  options?: Parameters<typeof runDepartureHandoffQueueItem>[2] & {
    enqueue: EnqueueDepartureHandoffRun
    enqueueDelayed: (args: RunJobPayload, startAfter: Date) => Promise<string | null>
  },
) {
  const wake = {
    name: DEPARTURE_HANDOFF_RUN_JOB as typeof DEPARTURE_HANDOFF_RUN_JOB,
    payload,
    // A running worker can arrange its own follow-up while the database fences the item.
    policy: 'short' as const,
    retry: { limit: 0 },
  }
  const recovery = {
    name: DEPARTURE_HANDOFF_RUN_RECOVERY_JOB as typeof DEPARTURE_HANDOFF_RUN_RECOVERY_JOB,
    payload: z.strictObject({}),
    policy: 'exclusive' as const,
    retry: { limit: 0 },
  }
  if (!options) return [defineJob(wake), defineJob(recovery)] as const
  return [
    defineJob({
      ...wake,
      async handler(args, { signal }) {
        if (signal.aborted) return
        try {
          const next = await runDepartureHandoffQueueItem(db, args, { ...options, signal })
          if (next && !signal.aborted) await options.enqueueDelayed(args, next)
        } catch {
          throw new Error('handoff_run_processing_unavailable')
        }
      },
    }),
    defineJob({
      ...recovery,
      schedule: { cron: '* * * * *', payload: {} },
      async handler(_, { signal }) {
        if (signal.aborted) return
        try {
          await recoverDepartureHandoffRuns(db, options.enqueue)
        } catch {
          throw new Error('handoff_run_recovery_unavailable')
        }
      },
    }),
  ] as const
}
