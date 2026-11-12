// The meeting-poll key fence. Mailbox digests (`email_key`), admission IP digests and the
// retained credential ciphertexts are all derived from the installation's
// `meetingPollSecret`, so data written under one secret is unusable under another: the same
// mailbox would enroll twice, a removal tombstone would stop matching, recovery would find
// nobody and stored ciphertexts would no longer open. The fence records a keyed fingerprint
// of the secret the data was written under (`meeting_poll_key_state`, never the secret) and
// refuses every other secret while any keyed meeting-poll data exists (docs/meeting-polls.md,
// Installation secret and key fence).
//
// Every voter service calls `ensureMeetingPollKey` first in its transaction, before any row
// lock. The transport step that supplies the secret also calls it at server start; nothing
// does yet.
import { createHmac, hkdfSync } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

/** One transaction-scoped advisory lock for the whole installation's meeting-poll key. */
const FENCE = sql`hashtextextended('hourmere.meeting-poll-key', 0)`

/**
 * The configured `meetingPollSecret` is not the one the stored meeting-poll data was written
 * under. Nothing is read or written for meeting-poll voters until the operator restores that
 * secret or follows the documented invalidation procedure. The message names no secret
 * material.
 */
export class MeetingPollKeyMismatchError extends Error {
  readonly code = 'meeting_poll_key_mismatch'

  constructor() {
    super(
      'Meeting poll data was written under a different meetingPollSecret. Restore that secret, or follow the key invalidation procedure in docs/meeting-polls.md.',
    )
    this.name = 'MeetingPollKeyMismatchError'
  }
}

/** Keyed fingerprint of the secret: an HMAC under its own HKDF subkey, never the secret. */
function fingerprintOf(secret: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', secret, 'hourmere/meeting-poll', 'key-version/v1', 32))
  return createHmac('sha256', key).update('hourmere/meeting-poll-key-fingerprint/v1').digest()
}

async function recordedFingerprint(db: Db): Promise<Buffer | undefined> {
  const row = await db
    .selectFrom('meeting_poll_key_state')
    .select('secret_fingerprint')
    .executeTakeFirst()
  return row?.secret_fingerprint
}

/**
 * Whether any data keyed by the recorded secret remains: a voter row (its mailbox and IP
 * digests; every stored ciphertext belongs to a voter's capability or delivery, and host
 * deliveries carry none) or a mailbox counter (removal tombstones and mail counts outlive the
 * voter row).
 */
async function keyedDataExists(db: Db): Promise<boolean> {
  const { rows } = await sql<{ keyed: boolean }>`
    SELECT EXISTS (SELECT FROM meeting_poll_voters)
      OR EXISTS (SELECT FROM meeting_poll_mailbox_counters) AS keyed`.execute(db)
  return rows[0]?.keyed === true
}

/**
 * The key fence, inside the caller's READ COMMITTED transaction. Under the recorded secret it
 * takes the fence lock shared and returns. Recording a secret takes the lock exclusively, so
 * it waits for every in-flight meeting-poll writer and none starts until it commits. A secret
 * is recorded only while no keyed data exists: at first use (concurrent first uses serialize
 * to one row) or replacing another one. Otherwise it throws `MeetingPollKeyMismatchError` and
 * the transaction writes nothing.
 */
export async function ensureMeetingPollKey(db: Db, secret: string): Promise<void> {
  if (!db.isTransaction) throw new Error('Meeting poll key checks need a transaction')
  const fingerprint = fingerprintOf(secret)
  const { rows } = await sql<{ isolation: string; seen: Buffer | null }>`
    SELECT current_setting('transaction_isolation') AS isolation,
      (SELECT secret_fingerprint FROM meeting_poll_key_state) AS seen`.execute(db)
  // The reads after the lock must see writers that committed while this one waited.
  if (rows[0]?.isolation !== 'read committed')
    throw new Error('Meeting poll key checks need a read committed transaction')
  const seen = rows[0]?.seen ?? undefined
  const same = seen?.equals(fingerprint) === true
  // Refusing needs no lock, so a process with another secret never stalls the others.
  if (!same && (await keyedDataExists(db))) throw new MeetingPollKeyMismatchError()
  if (same) await sql`SELECT pg_advisory_xact_lock_shared(${FENCE})`.execute(db)
  else await sql`SELECT pg_advisory_xact_lock(${FENCE})`.execute(db)
  // Read again under the lock: a key recorded or replaced meanwhile decides.
  const recorded = await recordedFingerprint(db)
  if (recorded?.equals(fingerprint)) return
  // A writer holding the shared lock cannot replace the key; the key changed under it.
  if (same) throw new MeetingPollKeyMismatchError()
  // Writers that held the lock have committed: their keyed data is visible now.
  if (await keyedDataExists(db)) throw new MeetingPollKeyMismatchError()
  if (recorded === undefined) {
    await db
      .insertInto('meeting_poll_key_state')
      .values({ singleton: true, secret_fingerprint: fingerprint })
      .execute()
    return
  }
  await db
    .updateTable('meeting_poll_key_state')
    .set({ secret_fingerprint: fingerprint, updated_at: sql<string>`now()` })
    .where('singleton', '=', true)
    .execute()
}
