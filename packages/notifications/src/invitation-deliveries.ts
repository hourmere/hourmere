import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

export type InvitationDeliveryState = 'queued' | 'sending' | 'smtp_accepted' | 'failed' | 'skipped'

/** A delivery result is independent of accepting or joining the organization. */
export interface PendingInvitationDelivery {
  id: string
  organizationId: string
  email: string
  role: string | null
  inviterId: string
  expiresAt: Date
  createdAt: Date
  delivery: {
    /** Missing storage means unknown/not sent, never an SMTP receipt. */
    state: InvitationDeliveryState | 'unknown'
    generation: number | null
    attempts: number | null
    dueAt: Date | null
    smtpAcceptedAt: Date | null
    lastErrorCode: string | null
    createdAt: Date | null
    updatedAt: Date | null
  }
}

function batchLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Invitation delivery limit must be an integer between 1 and 100')
  }
  return limit
}

/**
 * Storage query only: the caller must authorize invitation access in organizationId.
 * Cursor pagination follows invitation IDs; expiry always uses the database clock.
 * The delivery summary excludes lease, job and resend identities and provider details.
 */
export async function listPendingInvitationDeliveries(
  db: Db,
  organizationId: string,
  options: { afterId?: string; limit?: number } = {},
): Promise<PendingInvitationDelivery[]> {
  const result = await sql<{
    id: string
    organizationId: string
    email: string
    role: string | null
    inviterId: string
    expiresAt: Date
    createdAt: Date
    state: InvitationDeliveryState | 'unknown'
    generation: number | null
    attempts: number | null
    dueAt: Date | null
    smtpAcceptedAt: Date | null
    lastErrorCode: string | null
    deliveryCreatedAt: Date | null
    deliveryUpdatedAt: Date | null
  }>`
    SELECT i.id, i."organizationId", i.email, i.role, i."inviterId", i."expiresAt", i."createdAt",
      COALESCE(d.state, 'unknown') AS state, d.generation, d.attempts,
      d.due_at AS "dueAt", d.smtp_accepted_at AS "smtpAcceptedAt",
      d.last_error_code AS "lastErrorCode", d.created_at AS "deliveryCreatedAt",
      d.updated_at AS "deliveryUpdatedAt"
    FROM auth.invitation AS i
    LEFT JOIN public.invitation_deliveries AS d ON d.invitation_id = i.id
    WHERE i."organizationId" = ${organizationId}::uuid
      AND i.status = 'pending' AND i."expiresAt" > clock_timestamp()
      AND (${options.afterId ?? null}::uuid IS NULL OR i.id > ${options.afterId ?? null}::uuid)
    ORDER BY i.id
    LIMIT ${batchLimit(options.limit ?? 100)}
  `.execute(db)
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    inviterId: row.inviterId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    delivery: {
      state: row.state,
      generation: row.generation,
      attempts: row.attempts,
      dueAt: row.dueAt,
      smtpAcceptedAt: row.smtpAcceptedAt,
      lastErrorCode: row.lastErrorCode,
      createdAt: row.deliveryCreatedAt,
      updatedAt: row.deliveryUpdatedAt,
    },
  }))
}

// Both ages are conservative because Better Auth has no business-terminal timestamp.
// Pending invitations remain renewable after expiry. Retain their generation cap,
// original validity and replay identity until the invitation itself becomes terminal.
// Unknown business statuses are retained too; delivery outcomes never permit deletion.
const cleanupEligible = sql<boolean>`
  i.status IN ('accepted', 'canceled', 'rejected')
  AND i."expiresAt" <= clock_timestamp() - INTERVAL '7 days'
  AND d.updated_at <= clock_timestamp() - INTERVAL '7 days'
  AND (d.lease_until IS NULL OR d.lease_until <= clock_timestamp())
`

/**
 * Deletes at most one bounded batch of obsolete delivery rows; never invitations.
 * Lock invitation before delivery, matching future delivery/renewal transactions.
 * SKIP LOCKED leaves an in-progress renewal or delivery update for a later cleanup.
 */
export async function cleanupInvitationDeliveries(db: Db, limit = 100): Promise<number> {
  const size = batchLimit(limit)
  return db.transaction().execute(async (trx) => {
    const invitations = await sql<{ id: string }>`
      SELECT i.id FROM auth.invitation AS i
      JOIN public.invitation_deliveries AS d ON d.invitation_id = i.id
      WHERE ${cleanupEligible}
      ORDER BY d.updated_at, i.id
      LIMIT ${size}
      FOR UPDATE OF i SKIP LOCKED
    `.execute(trx)
    if (invitations.rows.length === 0) return 0
    const deliveries = await sql<{ invitation_id: string }>`
      SELECT d.invitation_id FROM public.invitation_deliveries AS d
      WHERE d.invitation_id IN (${sql.join(invitations.rows.map((row) => row.id))})
      ORDER BY d.invitation_id
      FOR UPDATE OF d SKIP LOCKED
    `.execute(trx)
    if (deliveries.rows.length === 0) return 0
    // A delivery may have changed between candidate selection and taking its lock.
    // Recheck current eligibility after both locks, in the deleting statement.
    const deleted = await sql<{ invitation_id: string }>`
      DELETE FROM public.invitation_deliveries AS d USING auth.invitation AS i
      WHERE d.invitation_id = i.id AND ${cleanupEligible}
        AND d.invitation_id IN (${sql.join(deliveries.rows.map((row) => row.invitation_id))})
      RETURNING d.invitation_id
    `.execute(trx)
    return deleted.rows.length
  })
}
