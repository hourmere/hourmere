import { ensurePersonalOrganization } from '@hourmere/auth'
import { createFixtures } from '@hourmere/scheduling/testing'
import { expect } from '@playwright/test'
import { recoverScimTeamMapping } from '../../../apps/server/src/scim-team-mapping-recovery.ts'
import { assertAudit, type ScimScenario } from './scim-fixture.ts'

const person = {
  username: 'scim-returning@example.test',
  email: 'scim-returning@example.test',
  firstName: 'Returning',
  lastName: 'Fixture',
}
const group = 'SCIM recovery group'
export const scimRecoveryLiterals = [...Object.values(person), 'Returning Fixture', group]

async function linkFixtureMember({ db, organizationId }: ScimScenario, externalId: string) {
  const { id: userId } = await db
    .insertInto('auth.user')
    .values({
      name: 'Returning Fixture',
      email: person.email,
      emailVerified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const { id: memberId } = await db
    .insertInto('auth.member')
    .values({ organizationId, userId, role: 'member', createdAt: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow()
  const { id: resourceId } = await db
    .updateTable('scim_users')
    .set({ linked_user_id: userId, linked_member_id: memberId })
    .where('organization_id', '=', organizationId)
    .where('external_id', '=', externalId)
    .returning('id')
    .executeTakeFirstOrThrow()
  return { userId, resourceId }
}

export async function acceptReadmission(scenario: ScimScenario) {
  const {
    db,
    realm,
    request,
    configureTarget,
    seen,
    capture,
    connectionId,
    organizationId,
    tokenId,
    signIn,
    sessionRequest,
  } = scenario
  await configureTarget({ deprovision: 'DELETE' })
  const externalId = await realm.createUser(person)
  await seen({ method: 'POST', path: '/Users', status: 201 })
  const { resourceId: retiredId, userId } = await linkFixtureMember(scenario, externalId)
  const personalId = await ensurePersonalOrganization(db, userId)
  const session = await signIn(userId, personalId)
  const teamSession = await signIn(userId, organizationId)
  const selectTeam = () =>
    sessionRequest(session, '/api/auth/organization/set-active', {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    })
  const cursor = capture.entries.length
  await realm.deleteUser(externalId)
  await seen(
    { method: 'DELETE', path: expect.stringMatching(/^\/Users\/user-\d+$/), status: 204 },
    cursor,
  )
  expect((await request(`/Users/${retiredId}`)).status).toBe(404)
  expect((await selectTeam()).status).toBe(403)
  expect(
    await db
      .selectFrom('auth.session')
      .select('id')
      .where('id', '=', teamSession.id)
      .executeTakeFirst(),
  ).toBeUndefined()

  const retryCursor = capture.entries.length
  const newExternalId = await realm.createUser(person)
  await seen({ method: 'POST', path: '/Users', status: 201 }, retryCursor)
  const fresh = await db
    .selectFrom('scim_users')
    .select(['id', 'active', 'linked_user_id', 'connection_id'])
    .where('external_id', '=', newExternalId)
    .executeTakeFirstOrThrow()
  expect(fresh.id).not.toBe(retiredId)
  expect(fresh).toMatchObject({ active: true, linked_user_id: null, connection_id: connectionId })
  const claim = () =>
    db
      .selectFrom('scim_user_claims')
      .select(['invitation_id', 'completed_at'])
      .where('scim_user_id', '=', fresh.id)
      .executeTakeFirstOrThrow()
  expect(await claim()).toEqual({ invitation_id: null, completed_at: null })
  const blockers = () =>
    db
      .selectFrom('scim_membership_blocks')
      .select('scim_user_id')
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', userId)
      .where('cleared_at', 'is', null)
      .execute()
  expect(await blockers()).toEqual([{ scim_user_id: retiredId }])

  const confirm = (actor: typeof session, headers?: Record<string, string>) =>
    sessionRequest(actor, '/api/auth/organization/complete-scim-readmission', {
      method: 'POST',
      ...(headers && { headers }),
      body: JSON.stringify({ organizationId, scimUserId: fresh.id }),
    })
  const fixtures = createFixtures(db)
  const otherUserId = await fixtures.user('Other SCIM fixture member')
  await fixtures.member(otherUserId, organizationId, 'member')
  const otherPersonalId = await ensurePersonalOrganization(db, otherUserId)
  expect((await confirm(await signIn(otherUserId, otherPersonalId))).status).toBe(403)
  expect((await confirm(session, { authorization: `Bearer ${scenario.credential}` })).status).toBe(
    401,
  )
  expect((await selectTeam()).status).toBe(403)
  expect(await blockers()).toEqual([{ scim_user_id: retiredId }])
  expect(await claim()).toEqual({ invitation_id: null, completed_at: null })
  expect((await confirm(session)).status).toBe(204)
  expect((await confirm(session)).status).toBe(403)
  expect((await selectTeam()).status).toBe(200)
  expect(await blockers()).toEqual([])
  expect(await claim()).toEqual({ invitation_id: null, completed_at: expect.anything() })
  expect(
    await db
      .selectFrom('scim_users')
      .select('linked_user_id')
      .where('id', '=', fresh.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ linked_user_id: userId })
  expect(
    await db
      .selectFrom('auth.session')
      .select('id')
      .where('id', '=', teamSession.id)
      .executeTakeFirst(),
  ).toBeUndefined()
  await assertAudit(db, {
    organizationId,
    targetId: retiredId,
    targetType: 'scim_user',
    actorType: 'scim_token',
    actorId: tokenId,
    actions: ['scim_user.created', 'scim_user.credentials_revoked', 'scim_user.retired'],
  })
  await assertAudit(db, {
    organizationId,
    targetId: fresh.id,
    targetType: 'scim_user',
    actorType: 'scim_token',
    actorId: tokenId,
    actions: ['scim_user.created'],
  })
  await assertAudit(db, {
    organizationId,
    targetId: fresh.id,
    targetType: 'scim_user',
    actorType: 'user',
    actorId: userId,
    credentialType: 'session',
    credentialId: session.id,
    actions: ['scim_user.claimed'],
  })
}

export async function acceptMappingRecovery(scenario: ScimScenario) {
  const {
    db,
    realm,
    configureTarget,
    capture,
    seen,
    request,
    organizationId,
    childId,
    ownerId,
    childOwnerId,
    connectionId,
    notices,
    noticeQueue,
  } = scenario
  const externalId = await realm.createGroup('Initial recovery group')
  const { id: mappingId } = await db
    .insertInto('scim_team_mappings')
    .values({
      parent_organization_id: organizationId,
      child_organization_id: childId,
      connection_id: connectionId,
      external_id: externalId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await configureTarget()
  await realm.updateGroup(externalId, group)
  await seen({ method: 'POST', path: '/Groups', status: 201 })
  const { id: resourceId } = await db
    .selectFrom('scim_groups')
    .select('id')
    .where('mapping_id', '=', mappingId)
    .executeTakeFirstOrThrow()
  const userExternalId = await realm.createUser(person)
  await seen({ method: 'POST', path: '/Users', status: 201 })
  const { userId, resourceId: userResourceId } = await linkFixtureMember(scenario, userExternalId)
  const cursor = capture.entries.length
  await realm.setGroupMembership(userExternalId, externalId, true)
  await seen(
    { method: 'PATCH', path: expect.stringMatching(/^\/Groups\/group-\d+$/), status: 200 },
    cursor,
  )

  const roster = () =>
    db
      .selectFrom('auth.member')
      .select(['userId', 'role'])
      .where('organizationId', '=', childId)
      .orderBy('role')
      .execute()
  const managed = { userId, role: 'member' }
  const local = { userId: childOwnerId, role: 'owner' }
  expect(await roster()).toEqual([managed, local])
  const recover = (action: 'suspend' | 'detach', childOrganizationId = childId) =>
    recoverScimTeamMapping(db, noticeQueue, true, {
      action,
      mappingId,
      parentOrganizationId: organizationId,
      childOrganizationId,
    })
  const unrelatedId = await createFixtures(db).organization()
  await expect(recover('suspend', unrelatedId)).rejects.toMatchObject({
    kind: 'forbidden',
    code: 'scim_mapping_access_denied',
  })
  expect((await request(`/Groups/${resourceId}`)).status).toBe(200)
  expect(await recover('suspend')).toBe('suspended')
  expect(await recover('suspend')).toBe('unchanged')
  expect((await request(`/Groups/${resourceId}`)).status).toBe(404)
  expect((await request(`/Groups/${resourceId}`, { method: 'DELETE' })).status).toBe(404)
  expect(await roster()).toEqual([managed, local])
  // A later parent User deactivation can no longer suspend this child's managed access.
  const beforeDeactivation = capture.entries.length
  await realm.updateUser(userExternalId, { enabled: false })
  await seen(
    {
      method: 'PATCH',
      path: expect.stringMatching(/^\/Users\/user-\d+$/),
      status: 200,
      response: expect.objectContaining({ active: false }),
    },
    beforeDeactivation,
  )
  expect(
    await db
      .selectFrom('scim_team_managed_memberships')
      .select('suspended_at')
      .where('mapping_id', '=', mappingId)
      .where('scim_user_id', '=', userResourceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ suspended_at: null })
  const setChildRole = (role: 'member' | 'admin') =>
    db
      .updateTable('auth.member')
      .set({ role })
      .where('organizationId', '=', childId)
      .where('userId', '=', userId)
      .execute()
  await setChildRole('admin')
  await expect(recover('detach')).rejects.toMatchObject({
    kind: 'forbidden',
    code: 'scim_mapping_privileged_member',
  })
  expect(await roster()).toEqual([{ userId, role: 'admin' }, local])
  await setChildRole('member')
  expect(await recover('detach')).toBe('detached')
  expect(await recover('detach')).toBe('unchanged')
  expect(await roster()).toEqual([local])
  expect((await request(`/Groups/${resourceId}`)).status).toBe(404)

  for (const [org, owner] of [
    [organizationId, ownerId],
    [childId, childOwnerId],
  ] as const) {
    await assertAudit(db, {
      organizationId: org,
      targetId: mappingId,
      targetType: 'scim_mapping',
      actorType: 'system',
      actorId: 'scim-mapping-recovery',
      actions: ['scim_mapping.suspended', 'scim_mapping.unlinked'],
    })
    expect(notices.filter((notice) => notice.organizationId === org)).toEqual([
      { organizationId: org, userId: owner, mappingId, action: 'suspended', language: 'en' },
      { organizationId: org, userId: owner, mappingId, action: 'unlinked', language: 'en' },
    ])
  }
}
