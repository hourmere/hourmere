import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { type AuditEvent, writeAuditEvent } from './audit.ts'
import { createDb } from './index.ts'

const roleId = '019b0000-0000-4000-8000-000000000001'
const oldRoleId = '019b0000-0000-7000-8000-000000000002'
const outcome = 'succeeded'
const personalDataPermissionIds = [
  'team_bookings.read',
  'event_types.generate_open_time_snippet',
  'waitlists.read_settings',
  'waitlists.update_settings',
]
const role = { roleId, policyEpoch: 0, masterEpoch: 1, outcome }
const assigned = {
  ...role,
  newRevision: 1,
  oldRoleId,
  oldRevision: 3,
  personalDataPermissionIds,
}
const enabled = { oldPolicyEpoch: 0, newPolicyEpoch: 1, masterEpoch: 1, outcome }
const validDetails = {
  'custom_role.created': { ...role, newRevision: 1 },
  'custom_role.revised': { ...role, oldRevision: 1, newRevision: 2 },
  'custom_role.archived': { ...role, oldRevision: 2 },
  'membership.custom_role_assigned': assigned,
  'membership.custom_role_cleared': { ...role, oldRevision: 2, personalDataPermissionIds },
  'team.custom_roles_enabled': enabled,
  'team.custom_roles_disabled': { ...enabled, oldPolicyEpoch: 1, newPolicyEpoch: 2 },
} satisfies Partial<Record<AuditEvent['action'], Record<string, unknown>>>

export async function assertCustomRoleAuditProtections(pool: pg.Pool): Promise<void> {
  const organizationId = randomUUID()
  const actorId = randomUUID()
  const memberId = randomUUID()
  const refused = { code: '23514', constraint: 'audit_events_details_check' }
  const targetFor = (action: string) =>
    action.startsWith('custom_role.')
      ? { targetType: 'custom_role', targetId: roleId }
      : action.startsWith('membership.')
        ? { targetType: 'membership', targetId: memberId }
        : { targetType: 'organization', targetId: organizationId }
  const insert = (
    action: string,
    details: unknown,
    identity: {
      teamId?: string | null
      actorType?: string
      actorId?: string
      credentialType?: string
      credentialId?: string
      targetId?: string
    } = {},
  ) => {
    const { targetType, targetId } = targetFor(action)
    return pool.query<{ details: unknown }>(
      `INSERT INTO audit_events
         (organization_id, actor_type, actor_id, credential_type, credential_id,
          action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING details`,
      [
        identity.teamId === undefined ? organizationId : identity.teamId,
        identity.actorType ?? 'user',
        identity.actorId ?? actorId,
        identity.credentialType ?? 'session',
        identity.credentialId ?? null,
        action,
        targetType,
        identity.targetId ?? targetId,
        JSON.stringify(details),
      ],
    )
  }

  // Exercise both the transactional helper's allow-list and the database value checks.
  const db = createDb(pool)
  for (const action of Object.keys(validDetails) as (keyof typeof validDetails)[]) {
    const details = validDetails[action]
    await expect(
      db.transaction().execute((trx) =>
        writeAuditEvent(trx, {
          organizationId,
          actor: { type: 'user', id: actorId },
          credential: { type: 'session' },
          ...targetFor(action),
          action,
          details,
        }),
      ),
      action,
    ).resolves.toBeUndefined()
    await expect(
      insert(action, { ...details, name: 'Private role label' }),
      action,
    ).rejects.toMatchObject(refused)
  }

  const assignment = 'membership.custom_role_assigned'
  const created = 'custom_role.created'
  const teamEnabled = 'team.custom_roles_enabled'
  const minimalAssignment = { ...role, newRevision: 1 }
  await expect(insert(assignment, minimalAssignment)).resolves.toMatchObject({
    rows: [{ details: minimalAssignment }],
  })
  await expect(insert(assignment, { ...minimalAssignment, oldRoleId })).rejects.toMatchObject(
    refused,
  )
  for (const value of [
    {},
    { ...role, newRevision: 0 },
    { ...role, newRevision: '1' },
    { ...role, newRevision: 1.5 },
    { ...role, newRevision: 2_147_483_648 },
    { ...role, newRevision: 1, roleId: 'someone@example.test' },
    { ...role, newRevision: 1, policyEpoch: -1 },
    { ...role, newRevision: 1, masterEpoch: '1' },
    { ...role, newRevision: 1, outcome: 'refused' },
    { ...role, newRevision: 1, personalDataPermissionIds },
  ]) {
    await expect(insert(created, value), JSON.stringify(value)).rejects.toMatchObject(refused)
  }
  for (const identity of [
    { credentialId: randomUUID() },
    { teamId: null },
    { actorId: 'someone@example.test' },
    { targetId: 'someone@example.test' },
    { targetId: randomUUID() },
    { credentialType: 'api_key', credentialId: randomUUID() },
    { actorType: 'scim_token', credentialType: 'none' },
  ]) {
    await expect(insert(created, validDetails[created], identity)).rejects.toMatchObject(refused)
  }
  await expect(
    insert('membership.custom_role_cleared', validDetails['membership.custom_role_cleared'], {
      actorType: 'scim_token',
      credentialType: 'none',
    }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert('custom_role.revised', { ...validDetails['custom_role.revised'], newRevision: 1 }),
  ).rejects.toMatchObject(refused)
  for (const list of [
    [],
    null,
    'team_bookings.read',
    ['team_bookings.read', 'team_bookings.read'],
    ['branding.read'],
    ['team_bookings.*'],
    [{ id: 'team_bookings.read' }],
  ]) {
    await expect(
      insert(assignment, { ...assigned, personalDataPermissionIds: list }),
    ).rejects.toMatchObject(refused)
  }
  for (const value of [
    { ...enabled, newPolicyEpoch: 0 },
    { ...enabled, newPolicyEpoch: '1' },
    { ...enabled, newPolicyEpoch: 2_147_483_648 },
    { ...enabled, roleId },
  ]) {
    await expect(insert(teamEnabled, value)).rejects.toMatchObject(refused)
  }
  await expect(insert(teamEnabled, enabled, { targetId: randomUUID() })).rejects.toMatchObject(
    refused,
  )
}
