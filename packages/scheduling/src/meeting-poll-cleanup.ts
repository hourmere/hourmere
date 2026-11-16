// Bounded cleanup of meeting-poll storage (docs/meeting-polls.md, "Storage policy and cleanup
// schedule"): expired public pending reservations, terminal polls past the installation's
// retention, and the pseudonymous replay tombstones of deleted polls once their purge instant
// passes. An internal service for the hourly worker job; no transport.
//
// Cleanup never waits for a lock. It takes the public voter order of the voter services (a
// personal owner's user, then the organization, FOR SHARE; then the poll FOR UPDATE), each
// with SKIP LOCKED, so a poll that a voter, host, booking or organization deletion holds is
// skipped and retried on a later run. Voter and child rows are deleted only under their
// poll's lock, so the deletions find them free: every writer of those rows holds the poll
// first. The database clock is read once after the locks and decides expiry and retention.
//
// Cleanup moves no revision: an expired reservation already stopped counting toward capacity
// and the results at its expiry instant, so a delayed run changes nothing anyone can see. It
// reads and writes no keyed data with the installation secret, so it takes no key fence and
// works under any configured secret, as poll deletion does.
import type { Db } from '@hourmere/db'
import { type RawBuilder, sql } from 'kysely'
import { MEETING_POLL_RETENTION } from './meeting-poll-policy.ts'

/**
 * Terminal polls deleted per transaction. Each poll's rows are bounded by the admission caps
 * (40 voters, 20 candidates, 800 votes), so ten polls stay a bounded transaction.
 */
export const MEETING_POLL_TERMINAL_BATCH = 10

export interface MeetingPollCleanupOptions {
  /** Rows chosen per transaction; at most, and by default, `MEETING_POLL_RETENTION.batchSize`. */
  limit?: number | undefined
  /**
   * The installation's booking-data retention in whole days, measured from scheduling,
   * cancellation or closure (the deadline for deadline closure). Without one, terminal polls
   * stay until explicit poll, linked-booking or organization deletion.
   */
  terminalRetentionDays?: number | null | undefined
}

export interface MeetingPollCleanupResult {
  /** Expired public pending voters deleted with their votes, credentials and deliveries. */
  expiredReservations: number
  /** Terminal polls deleted with all their personal data. */
  terminalPolls: number
  /** Replay tombstones of deleted polls removed after their purge instant. */
  receipts: number
  /** A batch was full, so another page may find more. */
  more: boolean
}

/** One bounded page of each cleanup, each in its own transaction. */
export async function cleanupMeetingPolls(
  db: Db,
  options: MeetingPollCleanupOptions = {},
): Promise<MeetingPollCleanupResult> {
  const limit = cleanupLimit(options.limit)
  const retentionDays = terminalRetention(options.terminalRetentionDays)
  const expired = await deleteExpiredReservations(db, limit)
  const terminal =
    retentionDays === null
      ? { deleted: 0, more: false }
      : await deleteTerminalPolls(db, retentionDays, Math.min(limit, MEETING_POLL_TERMINAL_BATCH))
  const receipts = await purgeReceipts(db, limit)
  return {
    expiredReservations: expired.deleted,
    terminalPolls: terminal.deleted,
    receipts: receipts.deleted,
    more: expired.more || terminal.more || receipts.more,
  }
}

/**
 * Public pending enrollees whose reservation expired: the voter row goes with its votes,
 * credentials and deliveries, so no name, mailbox, answer or IP digest remains. The mailbox
 * counter row stays with the poll, as the design keeps it for the poll's lifetime.
 */
async function deleteExpiredReservations(db: Db, limit: number) {
  return db.transaction().execute(async (trx) => {
    const { rows: candidates } = await sql<{ id: string }>`
      SELECT poll_id AS id FROM meeting_poll_voters
      WHERE verified_at IS NULL AND invited_at IS NULL
        AND pending_expires_at <= clock_timestamp()
      GROUP BY poll_id ORDER BY min(pending_expires_at), poll_id LIMIT ${limit}`.execute(trx)
    const polls = await lockPolls(
      trx,
      candidates.map((row) => row.id),
    )
    if (polls.length === 0) return { deleted: 0, more: false }
    const at = await clock(trx)
    const deleted = await sql<{ id: string }>`
      DELETE FROM meeting_poll_voters WHERE id IN (
        SELECT id FROM meeting_poll_voters
        WHERE poll_id = ANY(${polls}::uuid[]) AND verified_at IS NULL AND invited_at IS NULL
          AND pending_expires_at <= ${at}::timestamptz
        ORDER BY pending_expires_at, id LIMIT ${limit})
      RETURNING id`.execute(trx)
    const count = deleted.rows.length
    return { deleted: count, more: count > 0 && (count === limit || candidates.length === limit) }
  })
}

/**
 * Polls whose terminal instant is past the retention: the poll row goes with its candidates,
 * voters, votes, credentials, deliveries and mailbox counters, and its receipts keep only
 * the pseudonymous replay tombstone (0071's `meeting_polls_tombstones` trigger). A linked
 * booking stays; booking retention is independent.
 */
async function deleteTerminalPolls(db: Db, retentionDays: number, limit: number) {
  const due = (at: RawBuilder<unknown>) => sql<boolean>`(CASE status
    WHEN 'scheduled' THEN scheduled_at WHEN 'canceled' THEN canceled_at
    WHEN 'closed' THEN closed_at ELSE deadline_at END)
    <= ${at} - make_interval(days => ${retentionDays})`
  return db.transaction().execute(async (trx) => {
    const { rows: candidates } = await sql<{ id: string }>`
      SELECT id FROM meeting_polls WHERE ${due(sql`clock_timestamp()`)}
      ORDER BY (CASE status WHEN 'scheduled' THEN scheduled_at WHEN 'canceled' THEN canceled_at
        WHEN 'closed' THEN closed_at ELSE deadline_at END), id
      LIMIT ${limit}`.execute(trx)
    const polls = await lockPolls(
      trx,
      candidates.map((row) => row.id),
    )
    if (polls.length === 0) return { deleted: 0, more: false }
    const at = await clock(trx)
    const deleted = await sql<{ id: string }>`
      DELETE FROM meeting_polls
      WHERE id = ANY(${polls}::uuid[]) AND ${due(sql`${at}::timestamptz`)}
      RETURNING id`.execute(trx)
    const count = deleted.rows.length
    return { deleted: count, more: count > 0 && candidates.length === limit }
  })
}

/**
 * Replay tombstones of deleted polls (no poll or booking reference left) at or after their
 * purge instant. Live receipts keep their poll and are never chosen.
 */
async function purgeReceipts(db: Db, limit: number) {
  return db.transaction().execute(async (trx) => {
    const deleted = await sql<{ id: string }>`
      DELETE FROM meeting_poll_operations WHERE id IN (
        SELECT id FROM meeting_poll_operations
        WHERE poll_id IS NULL AND purge_at <= clock_timestamp()
        ORDER BY purge_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`.execute(trx)
    const count = deleted.rows.length
    return { deleted: count, more: count === limit }
  })
}

/**
 * Lock, without waiting, the polls among `ids` in the public voter order: personal owners'
 * users, then organizations, FOR SHARE; then the polls FOR UPDATE. Anything locked
 * elsewhere is skipped together with the polls behind it. Returns the locked poll IDs.
 */
async function lockPolls(trx: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const { rows: users } = await sql<{ id: string }>`
    SELECT u.id FROM auth."user" AS u
    WHERE u.id IN (SELECT personal.user_id FROM personal_organizations AS personal
      JOIN meeting_polls AS poll ON poll.organization_id = personal.organization_id
      WHERE poll.id = ANY(${ids}::uuid[]))
    ORDER BY u.id FOR SHARE SKIP LOCKED`.execute(trx)
  const { rows: organizations } = await sql<{ id: string }>`
    SELECT o.id FROM auth.organization AS o
    WHERE o.id IN (SELECT poll.organization_id FROM meeting_polls AS poll
      WHERE poll.id = ANY(${ids}::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM personal_organizations AS personal
        WHERE personal.organization_id = o.id
          AND NOT (personal.user_id = ANY(${users.map((row) => row.id)}::uuid[])))
    ORDER BY o.id FOR SHARE SKIP LOCKED`.execute(trx)
  if (organizations.length === 0) return []
  const { rows: polls } = await sql<{ id: string }>`
    SELECT id FROM meeting_polls
    WHERE id = ANY(${ids}::uuid[])
      AND organization_id = ANY(${organizations.map((row) => row.id)}::uuid[])
    ORDER BY id FOR UPDATE SKIP LOCKED`.execute(trx)
  return polls.map((row) => row.id)
}

/** The database clock, read once after the locks. */
async function clock(trx: Db): Promise<string> {
  const { rows } = await sql<{ at: string }>`SELECT clock_timestamp()::text AS at`.execute(trx)
  return (rows[0] as { at: string }).at
}

function cleanupLimit(limit: number | undefined): number {
  if (limit === undefined) return MEETING_POLL_RETENTION.batchSize
  if (!Number.isInteger(limit) || limit < 1 || limit > MEETING_POLL_RETENTION.batchSize)
    throw new TypeError(`A cleanup batch holds 1 to ${MEETING_POLL_RETENTION.batchSize} rows`)
  return limit
}

function terminalRetention(days: number | null | undefined): number | null {
  if (days === undefined || days === null) return null
  if (!Number.isInteger(days) || days < 1)
    throw new TypeError('Terminal retention is a whole number of days')
  return days
}
