import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import { MEETING_POLL_RETENTION } from './meeting-poll-policy.ts'

/** Clear expired encrypted credentials, retaining their digests for read-only receipts. */
export async function expireMeetingPollCapabilities(
  db: Db,
  secret: string,
  options: { limit?: number | undefined } = {},
): Promise<{ cleared: number; more: boolean }> {
  const limit = options.limit ?? MEETING_POLL_RETENTION.batchSize
  if (!Number.isInteger(limit) || limit < 1 || limit > MEETING_POLL_RETENTION.batchSize)
    throw new TypeError(`An expiry batch holds 1 to ${MEETING_POLL_RETENTION.batchSize} rows`)
  return db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    // Lock parents first, skipping concurrent deletion or voter writes. The child locks
    // also skip rather than waiting on another maintenance transaction.
    const { rows: polls } = await sql<{ id: string }>`
      SELECT p.id FROM meeting_polls p WHERE p.id IN (
        SELECT poll_id FROM meeting_poll_capabilities
        WHERE capability_ciphertext IS NOT NULL AND expires_at <= clock_timestamp()
        ORDER BY expires_at, id LIMIT ${limit})
      ORDER BY p.id FOR UPDATE SKIP LOCKED`.execute(trx)
    if (polls.length === 0) return { cleared: 0, more: false }
    const { rows: clock } = await sql<{ at: string }>`SELECT clock_timestamp()::text AS at`.execute(
      trx,
    )
    const at = (clock[0] as { at: string }).at
    const { rows } = await sql<{ id: string }>`
      WITH expired AS (
        SELECT id FROM meeting_poll_capabilities
        WHERE poll_id = ANY(${polls.map((poll) => poll.id)}::uuid[])
          AND capability_ciphertext IS NOT NULL AND expires_at <= ${at}::timestamptz
        ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE meeting_poll_capabilities SET capability_ciphertext = NULL
      WHERE id IN (SELECT id FROM expired) RETURNING id`.execute(trx)
    return { cleared: rows.length, more: rows.length === limit }
  })
}
