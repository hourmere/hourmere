import { fromKysely, type KyselyTransactionLike } from 'pg-boss'
import { z } from 'zod'
import { defineJob } from './index.ts'

export const ONE_TIME_LINK_RETENTION_DAYS = 90
export const ONE_TIME_LINK_CLEANUP_BATCH = 500
export const ONE_TIME_LINK_CLEANUP_CRON = '0 * * * *'

/** Unused capabilities become eligible for deletion about 90 days after ending. */
export function oneTimeBookingLinksRetentionJob(db: KyselyTransactionLike) {
  return defineJob({
    name: 'one-time-booking-links-retention',
    payload: z.strictObject({}),
    schedule: { cron: ONE_TIME_LINK_CLEANUP_CRON, payload: {} },
    handler: async (_, { signal }) => {
      if (signal.aborted) return
      // Each indexed branch locks at most one batch; the combined delete remains capped
      // at 500. Other workers and foreground operations can keep their locked rows.
      // Used links are booking evidence and follow their booking's retention instead.
      await fromKysely(db).executeSql(`
        WITH expired AS (
          SELECT id, expires_at AS ended_at FROM one_time_booking_links
          WHERE state IN ('active', 'expired')
            AND expires_at <= statement_timestamp() - INTERVAL '${ONE_TIME_LINK_RETENTION_DAYS} days'
          ORDER BY expires_at, id LIMIT ${ONE_TIME_LINK_CLEANUP_BATCH} FOR UPDATE SKIP LOCKED
        ), revoked AS (
          SELECT id, revoked_at AS ended_at FROM one_time_booking_links
          WHERE state = 'revoked'
            AND revoked_at <= statement_timestamp() - INTERVAL '${ONE_TIME_LINK_RETENTION_DAYS} days'
          ORDER BY revoked_at, id LIMIT ${ONE_TIME_LINK_CLEANUP_BATCH} FOR UPDATE SKIP LOCKED
        ), ended AS (
          SELECT id, ended_at FROM expired UNION ALL SELECT id, ended_at FROM revoked
        ), batch AS (
          SELECT id FROM ended ORDER BY ended_at, id LIMIT ${ONE_TIME_LINK_CLEANUP_BATCH}
        )
        DELETE FROM one_time_booking_links link USING batch WHERE link.id = batch.id
      `)
    },
  })
}
