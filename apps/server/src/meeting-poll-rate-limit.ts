import { createHmac } from 'node:crypto'
import type { Db } from '@hourmere/db'
import {
  ensureMeetingPollKey,
  MeetingPollRateLimitError,
  waitlistIpBucket,
} from '@hourmere/scheduling'
import { sql } from 'kysely'

/** One durable budget across REST, MCP and every server process. No raw IP is retained. */
export async function enforceMeetingPollRateLimit(
  { db, meetingPollSecret }: { db: Db; meetingPollSecret: string },
  bucket: 'read' | 'admission' | 'ballot',
  trustedIp: string | undefined,
): Promise<void> {
  const limit = { read: 120, admission: 10, ballot: 30 }[bucket]
  const digest = createHmac('sha256', meetingPollSecret)
    .update(`hourmere/meeting-poll-request/v1\0${bucket}\0${waitlistIpBucket(trustedIp)}`)
    .digest()
  const retryAfter = await db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, meetingPollSecret)
    // A bounded opportunistic sweep; locked counters are left to another request.
    await sql`DELETE FROM meeting_poll_request_limits WHERE key_digest IN (
      SELECT key_digest FROM meeting_poll_request_limits WHERE reset_at <= clock_timestamp()
      LIMIT 100 FOR UPDATE SKIP LOCKED
    )`.execute(trx)
    const result = await sql<{ hits: number; retry: number }>`
      INSERT INTO meeting_poll_request_limits (key_digest, hits, reset_at)
      VALUES (${digest}, 1, clock_timestamp() + interval '60 seconds')
      ON CONFLICT (key_digest) DO UPDATE SET
        hits = CASE WHEN meeting_poll_request_limits.reset_at <= clock_timestamp() THEN 1
          ELSE LEAST(meeting_poll_request_limits.hits + 1, ${limit + 1}) END,
        reset_at = CASE WHEN meeting_poll_request_limits.reset_at <= clock_timestamp()
          THEN clock_timestamp() + interval '60 seconds' ELSE meeting_poll_request_limits.reset_at END
      RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM reset_at - clock_timestamp())))::integer AS retry
    `.execute(trx)
    const row = result.rows[0]
    return row && row.hits > limit ? row.retry : undefined
  })
  // Commit the debit even when the operation is refused.
  if (retryAfter !== undefined) throw new MeetingPollRateLimitError(retryAfter)
}
