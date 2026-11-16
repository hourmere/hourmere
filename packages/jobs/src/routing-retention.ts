import { z } from 'zod'
import { defineJob } from './index.ts'

/** Every 15 minutes, well inside the 24-hour purge grace after receipt expiry. */
export const ROUTING_RETENTION_CRON = '*/15 * * * *'
/** Bounds of one run; the rest continues in one queued successor. */
export const ROUTING_RETENTION_RUN = { transactions: 100, budgetMs: 45_000 } as const

/**
 * Routing receipt and version cleanup (docs/routing-forms.md, step a4). Each handler call is one
 * bounded transaction. Receipts go first, because deleting them frees the versions they kept.
 * It keeps running while routing is off, as the design requires; with no routing data every
 * call finds nothing and writes nothing.
 */
export function routingRetentionJob(handlers: {
  /** Deletes one batch of expired, unconsumed receipts; `more` when the batch was full. */
  purgeReceipts: () => Promise<{ more: boolean }>
  /** Cleans one batch of versions after `after`; `next` is null once all were examined. */
  cleanupVersions: (after: string | null) => Promise<{ next: string | null }>
  continueRetention?: ((payload: { versionsAfter?: string }) => Promise<unknown>) | undefined
}) {
  return defineJob({
    name: 'routing-retention-v1',
    // Only a version ID to resume the sweep from: never answers, tokens or receipts.
    payload: z.strictObject({ versionsAfter: z.uuid().optional() }),
    policy: 'stately',
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 55,
    schedule: { cron: ROUTING_RETENTION_CRON, payload: {} },
    handler: async (payload, { signal }) => {
      const started = Date.now()
      let transactions = 0
      const another = () =>
        !signal.aborted &&
        transactions < ROUTING_RETENTION_RUN.transactions &&
        Date.now() - started < ROUTING_RETENTION_RUN.budgetMs
      // Receipts first: the version sweep starts only once they are drained.
      while (another()) {
        transactions++
        if (!(await handlers.purgeReceipts()).more) break
      }
      let after = payload.versionsAfter ?? null
      while (another()) {
        transactions++
        after = (await handlers.cleanupVersions(after)).next
        if (after === null) return
      }
      if (signal.aborted) return
      // A backlog does not wait for the next schedule; each transaction stays bounded.
      await handlers.continueRetention?.(after === null ? {} : { versionsAfter: after })
    },
  })
}
