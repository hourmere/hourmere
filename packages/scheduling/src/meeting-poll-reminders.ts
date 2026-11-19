import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { lockPolls } from './meeting-poll-cleanup.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import { MEETING_POLL_LIMITS, MEETING_POLL_RETENTION } from './meeting-poll-policy.ts'

const lead = sql`make_interval(secs => ${MEETING_POLL_LIMITS.reminderLeadSeconds})`
// The admission cap bounds the number of recipient rows each poll can enqueue.
const pollBatch = Math.floor(MEETING_POLL_RETENTION.batchSize / MEETING_POLL_LIMITS.maxEnrollments)

const unqueuedRecipients = sql`
  SELECT v.id AS voter_id, c.generation, c.capability_ciphertext
  FROM meeting_poll_voters AS v
  JOIN meeting_poll_capabilities AS c ON c.poll_id = v.poll_id AND c.voter_id = v.id
  LEFT JOIN meeting_poll_mailbox_counters AS m ON m.poll_id = v.poll_id AND m.email_key = v.email_key
  WHERE v.poll_id = p.id AND (v.invited_at IS NOT NULL OR v.verified_at IS NOT NULL)
    AND v.ballot_submitted_at IS NULL AND v.withdrawn_at IS NULL
    AND m.removed_at IS NULL AND m.reminder_opted_out_at IS NULL AND m.reminder_consumed_at IS NULL
    AND c.purpose = 'voting' AND c.expires_at > decision.at
    AND c.revoked_at IS NULL AND c.consumed_at IS NULL AND c.capability_ciphertext IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM meeting_poll_deliveries AS d
      WHERE d.poll_id = v.poll_id AND d.voter_id = v.id
        AND d.kind = 'reminder' AND d.generation = c.generation AND d.sequence = 0
    )`

const duePoll = sql`
  p.status = 'open' AND p.deadline_at > decision.at AND p.deadline_at <= decision.at + ${lead}
  AND p.deadline_at > p.created_at + ${lead}`

/** The minute email worker queues a bounded page of due reminders before dispatching. */
export async function queueDueMeetingPollReminders(
  db: Db,
  secret: string,
  options: { now?: (() => Temporal.Instant) | undefined } = {},
) {
  return db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const clock = () => sql`WITH decision AS MATERIALIZED (
      SELECT ${options.now?.().toString() ?? sql`clock_timestamp()`}::timestamptz AS at)`
    const candidates = await sql<{ id: string }>`
      ${clock()}
      SELECT p.id FROM meeting_polls AS p CROSS JOIN decision
      WHERE ${duePoll} AND EXISTS (${unqueuedRecipients})
      ORDER BY p.deadline_at, p.id LIMIT ${pollBatch}`.execute(trx)
    const locked = await lockPolls(
      trx,
      candidates.rows.map(({ id }) => id),
    )
    if (!locked.length) return
    // Reread the clock and eligibility under the parent locks. A ballot, opt-out, removal
    // or generation change that committed before a lock was acquired takes precedence.
    await sql`
      ${clock()}
      INSERT INTO meeting_poll_deliveries (
        organization_id, poll_id, voter_id, kind, generation, capability_ciphertext,
        due_at, created_at, updated_at
      )
      SELECT p.organization_id, p.id, r.voter_id, 'reminder', r.generation, r.capability_ciphertext,
        p.deadline_at - ${lead}, decision.at, decision.at
      FROM meeting_polls AS p CROSS JOIN decision CROSS JOIN LATERAL (${unqueuedRecipients}) AS r
      WHERE p.id = ANY(${locked}::uuid[]) AND ${duePoll}`.execute(trx)
  })
}
