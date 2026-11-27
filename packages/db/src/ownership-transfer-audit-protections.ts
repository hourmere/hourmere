import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

/** Provide the behavioral checks for the ownership-transfer additions to the audit constraint. */
export async function assertOwnershipTransferAuditProtections(pool: pg.Pool): Promise<void> {
  const organizationId = randomUUID()
  const targetMembershipId = '8e94c5f4-40d0-4cf4-9a26-360085ea04a4'
  const offered = 'organization.ownership_transfer_offered'
  const refused = { code: '23514', constraint: 'audit_events_details_check' }
  const insert = (action: string, details: unknown) =>
    pool.query<{ details: unknown }>(
      `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
        action, target_type, target_id, details)
       VALUES ($1, 'system', 'test', 'none', $2, 'organization', $3, $4::jsonb)
       RETURNING details`,
      [organizationId, action, organizationId, JSON.stringify(details)],
    )

  await expect(insert(offered, { targetMembershipId })).resolves.toMatchObject({
    rows: [{ details: { targetMembershipId } }],
  })
  for (const details of [
    {},
    [],
    { targetMembershipId: null },
    { targetMembershipId: [targetMembershipId] },
    { targetMembershipId: targetMembershipId.toUpperCase() },
    { targetMembershipId: 'member@example.test' },
    { targetMembershipId, transferId: randomUUID() },
    { targetMembershipId, email: 'member@example.test' },
  ]) {
    await expect(insert(offered, details)).rejects.toMatchObject(refused)
  }

  for (const action of [
    'organization.ownership_transfer_revoked',
    'organization.ownership_transfer_expired',
    'organization.ownership_transfer_invalidated',
    'organization.ownership_transferred',
  ]) {
    await expect(insert(action, {}), action).resolves.toMatchObject({ rows: [{ details: {} }] })
    await expect(insert(action, { targetMembershipId }), action).rejects.toMatchObject(refused)
  }
}
