import { z } from 'zod'
import { defineJob } from './index.ts'

export const AUDIT_RETENTION_CRON = '23 * * * *'

/**
 * Hourly, deletes audit events past their organization's retention (purgeAuditEvents in
 * @hourmere/scheduling): bounded batches that never wait on locks, safe to run again or
 * twice at once. What is not reached in one run is reached in the next.
 */
export function auditLogRetentionJob(purge: (signal: AbortSignal) => Promise<unknown>) {
  return defineJob({
    name: 'audit-log-retention-v1',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 900,
    schedule: { cron: AUDIT_RETENTION_CRON, payload: {} },
    handler: async (_, { signal }) => {
      if (signal.aborted) return
      await purge(signal)
    },
  })
}
