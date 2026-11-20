import { createHmac } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { teamWriteTransaction } from '@hourmere/db/team-write'
import {
  ensureMeetingPollKey,
  MEETING_POLL_LIMITS,
  type MeetingPollHostContext,
  MeetingPollKeyMismatchError,
  MeetingPollRateLimitError,
  meetingPollDerivedKey,
  waitlistIpBucket,
} from '@hourmere/scheduling'
import { lockMeetingPollManager } from '@hourmere/scheduling/meeting-poll-delivery'
import { sql } from 'kysely'

/** One durable budget across REST, MCP and every server process. No raw IP is retained. */
export async function enforceMeetingPollRateLimit(
  { db, meetingPollSecret }: { db: Db; meetingPollSecret: string },
  bucket: 'read' | 'admission' | 'ballot',
  trustedIp: string | undefined,
): Promise<void> {
  const limit = {
    read: MEETING_POLL_LIMITS.readRequestsPerWindow,
    admission: MEETING_POLL_LIMITS.admissionRequestsPerWindow,
    ballot: MEETING_POLL_LIMITS.ballotRequestsPerWindow,
  }[bucket]
  await enforceRequestBudget({ db, meetingPollSecret }, limit, [
    `${bucket}\0${waitlistIpBucket(trustedIp)}`,
  ])
}

/** Bound host mail-producing traffic across keys and transports without debiting voters. */
export async function enforceMeetingPollHostAdmission(
  { db, meetingPollSecret, principal, authorizeOrganizationWrite }: MeetingPollHostContext,
  trustedIp: string | undefined,
): Promise<void> {
  if (meetingPollSecret.length < 16) throw new MeetingPollKeyMismatchError()
  const ip = waitlistIpBucket(trustedIp)
  const keys = [`host-admission\0organization\0${principal.organization.id}`]
  if (ip !== 'unknown') keys.push(`host-admission\0ip\0${ip}`)
  await enforceRequestBudget(
    { db, meetingPollSecret },
    MEETING_POLL_LIMITS.admissionRequestsPerWindow,
    keys,
    async (trx) => {
      // A member who cannot manage polls must not spend the organization's allowance.
      await authorizeOrganizationWrite?.(trx, principal.organization.id)
      await lockMeetingPollManager(trx, principal)
    },
  )
}

async function enforceRequestBudget(
  { db, meetingPollSecret }: { db: Db; meetingPollSecret: string },
  limit: number,
  keys: string[],
  authorize?: (trx: Db) => Promise<void>,
) {
  const windowSeconds = MEETING_POLL_LIMITS.requestWindowSeconds
  const secret = meetingPollDerivedKey(meetingPollSecret, 'request/v1')
  const digests = keys.map((key) => createHmac('sha256', secret).update(key).digest())
  const retryAfter = await teamWriteTransaction(db.transaction(), async (trx) => {
    await ensureMeetingPollKey(trx, meetingPollSecret)
    await authorize?.(trx)
    // A bounded opportunistic sweep; locked counters are left to another request.
    await sql`DELETE FROM meeting_poll_request_limits WHERE key_digest IN (
      SELECT key_digest FROM meeting_poll_request_limits WHERE reset_at <= clock_timestamp()
      LIMIT 100 FOR UPDATE SKIP LOCKED
    )`.execute(trx)
    const result = await sql<{ hits: number; retry: number }>`
      INSERT INTO meeting_poll_request_limits (key_digest, hits, reset_at)
      SELECT digest, 1, clock_timestamp() + ${windowSeconds}::integer * interval '1 second'
      FROM unnest(ARRAY[${sql.join(digests)}]::bytea[]) AS keys(digest) ORDER BY digest
      ON CONFLICT (key_digest) DO UPDATE SET
        hits = CASE WHEN meeting_poll_request_limits.reset_at <= clock_timestamp() THEN 1
          ELSE LEAST(meeting_poll_request_limits.hits + 1, ${limit + 1}) END,
        reset_at = CASE WHEN meeting_poll_request_limits.reset_at <= clock_timestamp()
          THEN clock_timestamp() + ${windowSeconds}::integer * interval '1 second' ELSE meeting_poll_request_limits.reset_at END
      RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM reset_at - clock_timestamp())))::integer AS retry
    `.execute(trx)
    return result.rows
      .filter((row) => row.hits > limit)
      .reduce((retry, row) => Math.max(retry, row.retry), 0)
  })
  // Commit the debit even when the operation is refused.
  if (retryAfter > 0) throw new MeetingPollRateLimitError(retryAfter)
}
