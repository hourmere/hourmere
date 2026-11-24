import { createFixtures } from '@hourmere/scheduling/testing'
import { expect } from '@playwright/test'
import { assertAudit, type ScimScenario } from './scim-fixture.ts'

const groupSchema = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const patchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const groupPath = expect.stringMatching(/^\/Groups\/group-\d+$/)
const initialName = 'SCIM fixture group'
const renamedName = 'Renamed SCIM fixture group'
const replacementName = 'Replaced SCIM fixture group'

export const scimGroupLiterals = [
  initialName,
  renamedName,
  replacementName,
  'Membership',
  'Fixture',
  'Membership Fixture',
  'scim-roster-member@example.test',
  'scim-roster-admin@example.test',
  'scim-roster-owner@example.test',
]

type Role = 'member' | 'admin' | 'owner'
type Group = Awaited<ReturnType<typeof activateGroup>>

async function activateGroup(scenario: ScimScenario, protectedRoster = false) {
  const {
    db,
    realm,
    organizationId,
    childId,
    childOwnerId,
    connectionId,
    tokenId,
    configureTarget,
    seen,
    request,
  } = scenario
  // The group must exist in Keycloak before its opaque external ID can be reserved.
  const externalId = await realm.createGroup('Pending SCIM fixture group')
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
  await configureTarget(protectedRoster ? { deprovision: 'DELETE' } : undefined)
  await realm.updateGroup(externalId, initialName)
  await seen({
    method: 'GET',
    path: '/Groups',
    status: 200,
    query: expect.objectContaining({ filter: `displayName eq "${initialName}"` }),
    response: expect.objectContaining({ totalResults: 0 }),
  })
  await seen({
    method: 'POST',
    path: '/Groups',
    status: 201,
    response: expect.objectContaining({ displayName: initialName }),
  })
  const { id } = await db
    .selectFrom('scim_groups')
    .select('id')
    .where('mapping_id', '=', mappingId)
    .executeTakeFirstOrThrow()
  const path = `/Groups/${id}`
  const roster = () =>
    db
      .selectFrom('scim_team_managed_memberships as source')
      .innerJoin('auth.member as member', 'member.id', 'source.member_id')
      .select([
        'source.scim_user_id as scimId',
        'member.userId',
        'member.role',
        'source.suspended_at',
      ])
      .where('source.mapping_id', '=', mappingId)
      .orderBy('source.scim_user_id')
      .execute()
  const child = () =>
    db.selectFrom('auth.organization').select('name').where('id', '=', childId).executeTakeFirst()
  const mapping = () =>
    db
      .selectFrom('scim_team_mappings')
      .select(['live_child_organization_id', 'retired_at'])
      .where('id', '=', mappingId)
      .executeTakeFirstOrThrow()
  const localMemberships = () =>
    db
      .selectFrom('auth.member')
      .select(['role', 'userId'])
      .where('organizationId', '=', childId)
      .orderBy('userId')
      .execute()
  const audit = (updates: number, retired = false) =>
    assertAudit(db, {
      organizationId,
      actorType: 'scim_token',
      actorId: tokenId,
      targetId: id,
      targetType: 'scim_group',
      actions: [
        'scim_group.created',
        ...Array<string>(updates).fill('scim_group.updated'),
        ...(retired ? ['scim_group.deleted'] : []),
      ],
    })
  const read = async (expectedName: string, members: string[]) => {
    const response = await request(path)
    expect(response.status).toBe(200)
    const group = (await response.json()) as {
      id: string
      externalId: string
      displayName: string
      members?: { value: string }[]
    }
    expect(group.id).toBe(id)
    expect(group.externalId).toBe(externalId)
    expect(group.displayName).toBe(expectedName)
    expect(group.members?.map(({ value }) => value) ?? []).toEqual([...members].sort())
  }
  await read(initialName, [])
  await audit(0)
  return {
    externalId,
    path,
    mappingId,
    childOwnerId,
    roster,
    read,
    child,
    mapping,
    localMemberships,
    audit,
  }
}

async function createRosterUser({ db, realm, organizationId, seen }: ScimScenario, role: Role) {
  const email = `scim-roster-${role}@example.test`
  const { id: userId } = await db
    .insertInto('auth.user')
    .values({ name: 'Membership Fixture', email, emailVerified: true })
    .returning('id')
    .executeTakeFirstOrThrow()
  const fixture = createFixtures(db)
  await fixture.member(userId, organizationId)
  const { id: linkedMemberId } = await db
    .selectFrom('auth.member')
    .select('id')
    .where('organizationId', '=', organizationId)
    .where('userId', '=', userId)
    .executeTakeFirstOrThrow()
  const externalId = await realm.createUser({
    username: email,
    email,
    firstName: 'Membership',
    lastName: 'Fixture',
  })
  await seen({
    method: 'POST',
    path: '/Users',
    status: 201,
    response: expect.objectContaining({ userName: email }),
  })
  // Start the Group admission scenario with the parent's already-claimed User.
  const { id: scimId } = await db
    .updateTable('scim_users')
    .set({ linked_user_id: userId, linked_member_id: linkedMemberId })
    .where('organization_id', '=', organizationId)
    .where('external_id', '=', externalId)
    .returning('id')
    .executeTakeFirstOrThrow()
  return { externalId, scimId, userId, role }
}

async function changeMembership(
  { capture, realm, seen }: ScimScenario,
  group: Group,
  user: Awaited<ReturnType<typeof createRosterUser>>,
  member: boolean,
  status: 200 | 403 = 200,
) {
  const since = capture.entries.length
  await realm.setGroupMembership(user.externalId, group.externalId, member)
  await seen(
    {
      method: 'PATCH',
      path: groupPath,
      status,
      request: expect.objectContaining({
        Operations: [
          {
            op: member ? 'add' : 'remove',
            path: 'members',
            value: [{ value: expect.stringMatching(/^user-\d+$/) }],
          },
        ],
      }),
      ...(status === 403 && { response: expect.objectContaining({ scimType: 'mutability' }) }),
    },
    since,
  )
}

export async function acceptGroups(scenario: ScimScenario) {
  const { db, realm, organizationId, childId, tokenId, seen, request, notices } = scenario
  const group = await activateGroup(scenario)
  const localMembers = await group.localMemberships()
  await realm.updateGroup(group.externalId, renamedName)
  await seen({
    method: 'PATCH',
    path: groupPath,
    status: 200,
    response: expect.objectContaining({ displayName: renamedName }),
  })
  await group.read(renamedName, [])
  await group.audit(1)

  const member = await createRosterUser(scenario, 'member')
  await changeMembership(scenario, group, member, true)
  const managed = [
    { scimId: member.scimId, userId: member.userId, role: 'member', suspended_at: null },
  ]
  expect(await group.roster()).toEqual(managed)
  await group.read(renamedName, [member.scimId])
  await group.audit(2)

  // With PATCH advertised the plugin uses it for every Group update; exercise PUT directly.
  const replaced = await request(group.path, {
    method: 'PUT',
    body: JSON.stringify({ schemas: [groupSchema], displayName: replacementName }),
  })
  expect(replaced.status).toBe(200)
  await replaced.body?.cancel()
  await group.read(replacementName, [member.scimId])
  expect(await group.roster()).toEqual(managed)
  await group.audit(3)

  await changeMembership(scenario, group, member, false)
  await group.read(replacementName, [])
  expect(await group.roster()).toEqual([])
  expect(await group.localMemberships()).toEqual(localMembers)
  await group.audit(4)
  await changeMembership(scenario, group, member, true)
  expect(await group.roster()).toEqual(managed)
  await group.audit(5)

  await realm.deleteGroup(group.externalId)
  await seen({ method: 'DELETE', path: groupPath, status: 204 })
  expect(await group.roster()).toEqual([])
  expect(await group.localMemberships()).toEqual(localMembers)
  expect(await group.child()).toEqual({ name: replacementName })
  expect(await group.mapping()).toEqual({
    live_child_organization_id: null,
    retired_at: expect.any(Date),
  })
  const gone = await request(group.path)
  expect(gone.status).toBe(404)
  await gone.body?.cancel()
  const repeated = await request(group.path, { method: 'DELETE' })
  expect(repeated.status).toBe(404)
  await repeated.body?.cancel()

  const actor = { organizationId, actorType: 'scim_token', actorId: tokenId } as const
  await group.audit(5, true)
  await assertAudit(db, {
    ...actor,
    targetId: group.mappingId,
    targetType: 'scim_mapping',
    actions: ['scim_mapping.unlinked'],
  })
  await assertAudit(db, {
    organizationId: childId,
    actorType: 'system',
    actorId: 'scim-group-retirement',
    targetId: group.mappingId,
    targetType: 'scim_mapping',
    actions: ['scim_mapping.unlinked'],
  })
  await assertAudit(db, {
    ...actor,
    organizationId: childId,
    targetId: group.mappingId,
    targetType: 'scim_mapping',
    actions: [],
  })
  expect(notices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ organizationId, mappingId: group.mappingId, action: 'unlinked' }),
      expect.objectContaining({
        organizationId: childId,
        userId: group.childOwnerId,
        mappingId: group.mappingId,
        action: 'unlinked',
      }),
    ]),
  )
}

export async function acceptGroupProtections(scenario: ScimScenario) {
  const { db, realm, organizationId, childId, tokenId, request, seen, capture, notices } = scenario
  const group = await activateGroup(scenario, true)
  const privileged = await Promise.all([
    createRosterUser(scenario, 'admin'),
    createRosterUser(scenario, 'owner'),
  ])
  for (const person of privileged) {
    await changeMembership(scenario, group, person, true)
    // Fixture setup for a subsequent local promotion of this managed member.
    await db
      .updateTable('auth.member')
      .set({ role: person.role })
      .where('organizationId', '=', childId)
      .where('userId', '=', person.userId)
      .execute()
  }
  const roster = privileged
    .map(({ scimId, userId, role }) => ({ scimId, userId, role, suspended_at: null }))
    .sort((a, b) => a.scimId.localeCompare(b.scimId))
  expect(await group.roster()).toEqual(roster)
  const localMembers = await group.localMemberships()

  for (const person of privileged) {
    await changeMembership(scenario, group, person, false, 403)
    const sinceDisable = capture.entries.length
    await realm.updateUser(person.externalId, { enabled: false })
    await seen(
      {
        method: 'PATCH',
        path: expect.stringMatching(/^\/Users\/user-\d+$/),
        request: expect.objectContaining({
          Operations: expect.arrayContaining([{ op: 'replace', path: 'active', value: false }]),
        }),
        status: 403,
        response: expect.objectContaining({ scimType: 'mutability' }),
      },
      sinceDisable,
    )
    const sinceDelete = capture.entries.length
    await realm.deleteUser(person.externalId)
    await seen(
      {
        method: 'DELETE',
        path: expect.stringMatching(/^\/Users\/user-\d+$/),
        status: 403,
        response: expect.objectContaining({ scimType: 'mutability' }),
      },
      sinceDelete,
    )
    const user = await request(`/Users/${person.scimId}`)
    expect(user.status).toBe(200)
    expect((await user.json()).active).toBe(true)
    await assertAudit(db, {
      organizationId,
      actorType: 'scim_token',
      actorId: tokenId,
      targetId: person.scimId,
      targetType: 'scim_user',
      actions: ['scim_user.created'],
    })
  }

  // These requests have no equivalent in the plugin's normal PATCH-based Group sync.
  const put = await request(group.path, {
    method: 'PUT',
    body: JSON.stringify({ schemas: [groupSchema], displayName: replacementName, members: [] }),
  })
  expect(put.status).toBe(403)
  expect((await put.json()).scimType).toBe('mutability')
  const demote = await request(group.path, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: [patchSchema],
      Operations: [{ op: 'replace', path: 'members.roles', value: ['member'] }],
    }),
  })
  expect(demote.status).toBe(403)
  expect((await demote.json()).scimType).toBe('mutability')

  await realm.deleteGroup(group.externalId)
  await seen({
    method: 'DELETE',
    path: groupPath,
    status: 403,
    response: expect.objectContaining({ scimType: 'mutability' }),
  })
  await group.read(
    initialName,
    privileged.map(({ scimId }) => scimId),
  )
  expect(await group.roster()).toEqual(roster)
  expect(await group.localMemberships()).toEqual(localMembers)
  expect(await group.mapping()).toEqual({ live_child_organization_id: childId, retired_at: null })
  expect(notices).toEqual([])
  await group.audit(2)
}
