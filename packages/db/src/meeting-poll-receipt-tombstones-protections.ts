// Migration 0088 redefines the poll-deletion tombstone trigger: a deleted poll's receipts lose
// their poll and booking references, and every receipt but `create` also loses its request
// fingerprint, which for an invitation is a digest of invitee names and mailboxes. These checks
// pass on the migration as written and fail when the trigger is dropped
// (meeting-poll-receipt-tombstones-coverage.test.ts) or when an upgrade keeps an old
// fingerprint (meeting-poll-receipt-tombstones-migration.test.ts).
import type pg from 'pg'
import { expect } from 'vitest'
import { digest, fixture, insert } from './meeting-poll-protections.ts'

/** The fingerprint every non-`create` tombstone carries; no SHA-256 request digest equals it. */
export const CLEARED_FINGERPRINT = Buffer.alloc(32)
export const RECEIPT_OPERATIONS = ['create', 'invite', 'resend', 'rotate_link', 'finalize'] as const

/** Throws unless poll deletion keeps only pseudonymous replay identity in every receipt. */
export async function assertMeetingPollReceiptTombstoneProtections(pool: pg.Pool): Promise<void> {
  const f = await fixture(pool)
  const receipts = []
  for (const operation of RECEIPT_OPERATIONS) {
    const values = {
      organization_id: f.organization,
      poll_id: f.poll,
      operation,
      actor_scope_digest: digest(),
      idempotency_key_digest: digest(),
      request_fingerprint: digest(),
    }
    receipts.push({ id: await insert(pool, 'meeting_poll_operations', values), ...values })
  }
  await expect(
    pool.query('DELETE FROM meeting_polls WHERE id=$1', [f.poll]),
  ).resolves.toMatchObject({ rowCount: 1 })
  const rows = (
    await pool.query(
      `SELECT id,organization_id,poll_id,booking_id,operation,actor_scope_digest,idempotency_key_digest,
         request_fingerprint,purge_at BETWEEN clock_timestamp()+interval '89 days'
           AND clock_timestamp()+interval '90 days' AS retained
       FROM meeting_poll_operations WHERE id=ANY($1) ORDER BY operation`,
      [receipts.map((receipt) => receipt.id)],
    )
  ).rows
  expect(rows).toEqual(
    receipts
      .map((receipt) => ({
        id: receipt.id,
        organization_id: f.organization,
        poll_id: null,
        booking_id: null,
        operation: receipt.operation,
        actor_scope_digest: receipt.actor_scope_digest,
        idempotency_key_digest: receipt.idempotency_key_digest,
        // Only a create replay reads a tombstone; its fingerprint holds no voter data.
        request_fingerprint:
          receipt.operation === 'create' ? receipt.request_fingerprint : CLEARED_FINGERPRINT,
        retained: true,
      }))
      .sort((a, b) => a.operation.localeCompare(b.operation)),
  )
}
