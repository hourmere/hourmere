import { ensurePersonalOrganization } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { expect } from '@playwright/test'
import { SCIM_ERROR_SCHEMA } from '../../../apps/server/src/scim.ts'
import { SCIM_URN } from '../../../apps/server/src/scim-discovery.ts'
import { assertAudit, type ScimScenario } from './scim-fixture.ts'

const person = {
  username: 'scim-alex@example.test',
  email: 'scim-alex@example.test',
  firstName: 'Alex',
  lastName: 'Fixture',
}
const patchName = 'Avery'
const putName = 'Jordan'
const putUsername = 'scim-jordan@example.test'
const patchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const userResource = expect.stringMatching(/^\/Users\/user-\d+$/)
const privileged = (['owner', 'admin'] as const).map((role) => ({
  role,
  profile: {
    username: `scim-${role}@example.test`,
    email: `scim-${role}@example.test`,
    firstName: role === 'owner' ? 'Taylor' : 'Morgan',
    lastName: 'Fixture',
  },
}))

export const scimUserLiterals = [
  ...Object.values(person),
  `${person.firstName} ${person.lastName}`,
  patchName,
  `${patchName} ${person.lastName}`,
  putName,
  putUsername,
  `${putName} ${person.lastName}`,
  ...privileged.flatMap(({ profile }) => [
    ...Object.values(profile),
    `${profile.firstName} ${profile.lastName}`,
  ]),
]

type Profile = typeof person
type ProtectedRole = 'owner' | 'admin'

function userAudit(
  { db, organizationId, tokenId }: ScimScenario,
  targetId: string,
  actions: Parameters<typeof assertAudit>[1]['actions'],
) {
  return assertAudit(db, {
    organizationId,
    targetId,
    actorType: 'scim_token',
    actorId: tokenId,
    targetType: 'scim_user',
    actions,
  })
}

function storedUser(db: Db, id: string) {
  return db
    .selectFrom('scim_users')
    .select(['id', 'linked_user_id', 'linked_member_id', 'given_name', 'active', 'retired_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

async function provision(scenario: ScimScenario, profile: Profile) {
  const { db, realm, organizationId, connectionId, seen, capture } = scenario
  const since = capture.entries.length
  const keycloakId = await realm.createUser(profile)
  await seen(
    {
      method: 'POST',
      path: '/Users',
      request: expect.objectContaining({ userName: profile.username }),
      status: 201,
      response: expect.objectContaining({ userName: profile.username, active: true }),
    },
    since,
  )
  const entry = await db
    .selectFrom('scim_users')
    .select(['id', 'active', 'linked_user_id'])
    .where('organization_id', '=', organizationId)
    .where('connection_id', '=', connectionId)
    .where('external_id', '=', keycloakId)
    .executeTakeFirstOrThrow()
  expect(entry).toEqual({ id: expect.any(String), active: true, linked_user_id: null })
  await userAudit(scenario, entry.id, ['scim_user.created'])
  return { keycloakId, id: entry.id, path: `/Users/${entry.id}` }
}

async function seedAccount(db: Db, profile: Profile) {
  return db
    .insertInto('auth.user')
    .values({
      name: `${profile.firstName} ${profile.lastName}`,
      email: profile.email,
      emailVerified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

async function seedMember(
  { db, organizationId }: ScimScenario,
  profile: Profile,
  role: ProtectedRole,
) {
  const account = await seedAccount(db, profile)
  return db
    .insertInto('auth.member')
    .values({ userId: account.id, organizationId, role, createdAt: new Date() })
    .returning(['id', 'userId', 'role'])
    .executeTakeFirstOrThrow()
}

async function issuedInvitation(db: Db, userId: string) {
  const claim = await db
    .selectFrom('scim_user_claims')
    .select(['id', 'invitation_id'])
    .where('scim_user_id', '=', userId)
    .executeTakeFirstOrThrow()
  if (!claim.invitation_id)
    throw new Error('SCIM User creation did not issue the fixture invitation')
  return { claimId: claim.id, invitationId: claim.invitation_id }
}

function invitationAudit(
  { db, organizationId, tokenId }: ScimScenario,
  invitationId: string,
  actions: string[],
) {
  return assertAudit(db, {
    organizationId,
    actorType: 'scim_token',
    actorId: tokenId,
    targetId: invitationId,
    targetType: 'invitation',
    actions,
  })
}

async function acceptInvitation(scenario: ScimScenario, userId: string) {
  const { db, organizationId, signIn, sessionRequest } = scenario
  const { claimId, invitationId } = await issuedInvitation(db, userId)
  await invitationAudit(scenario, invitationId, ['membership.invited'])
  const account = await seedAccount(db, person)
  const personalId = await ensurePersonalOrganization(db, account.id)
  const session = await signIn(account.id, personalId)
  const accepted = await sessionRequest(session, '/api/auth/organization/accept-invitation', {
    method: 'POST',
    body: JSON.stringify({ invitationId }),
  })
  expect(accepted.status).toBe(200)
  const member = await db
    .selectFrom('auth.member')
    .select(['id', 'userId', 'role'])
    .where('organizationId', '=', organizationId)
    .where('userId', '=', account.id)
    .executeTakeFirstOrThrow()
  expect(member.role).toBe('member')
  expect(await storedUser(db, userId)).toMatchObject({
    linked_user_id: account.id,
    linked_member_id: member.id,
  })
  const claim = await db
    .selectFrom('scim_user_claims')
    .select(['completed_at', 'invalidated_at'])
    .where('id', '=', claimId)
    .executeTakeFirstOrThrow()
  expect(claim).toEqual({ completed_at: expect.any(Date), invalidated_at: null })
  const actor = {
    organizationId,
    actorType: 'user',
    actorId: account.id,
    credentialType: 'session',
    credentialId: session.id,
  } as const
  await assertAudit(db, {
    ...actor,
    targetId: invitationId,
    targetType: 'invitation',
    actions: ['membership.accepted'],
  })
  await assertAudit(db, {
    ...actor,
    targetId: userId,
    targetType: 'scim_user',
    actions: ['scim_user.claimed'],
  })
  return { member, personalId }
}

async function seedLink(db: Db, id: string, member: { id: string; userId: string }) {
  // Fixture state for an already-proven account link. Re-admission is exercised separately.
  await db
    .updateTable('scim_users')
    .set({ linked_user_id: member.userId, linked_member_id: member.id })
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

function liveBlock(db: Db, id: string) {
  return db
    .selectFrom('scim_membership_blocks')
    .select(['id', 'source', 'kind'])
    .where('scim_user_id', '=', id)
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
}

function putBody(profile: Profile, extra: object) {
  return JSON.stringify({ schemas: [SCIM_URN.user], userName: profile.username, ...extra })
}

async function expectPrivilegeRefusal(response: Response) {
  expect(response.status).toBe(403)
  expect(response.headers.get('content-type')).toBe('application/scim+json')
  const { status, scimType, schemas } = await response.json()
  expect(status === '403' && scimType === 'mutability' && schemas?.[0] === SCIM_ERROR_SCHEMA).toBe(
    true,
  )
}

export async function acceptUsers(scenario: ScimScenario) {
  const { db, realm, organizationId, capture, seen, signIn, sessionRequest } = scenario
  const user = await provision(scenario, person)
  const { member, personalId } = await acceptInvitation(scenario, user.id)
  const teamSession = await signIn(member.userId, organizationId)
  const personalSession = await signIn(member.userId, personalId)
  const readMe = (session: typeof teamSession) => sessionRequest(session, '/api/v1/me')

  await seen({
    method: 'GET',
    path: '/ServiceProviderConfig',
    status: 200,
    response: expect.objectContaining({ patch: { supported: true } }),
  })
  await seen({
    method: 'GET',
    path: '/Users',
    query: expect.objectContaining({ filter: `userName eq "${person.username}"` }),
    status: 200,
  })

  let since = capture.entries.length
  await realm.updateUser(user.keycloakId, { firstName: patchName })
  await seen(
    {
      method: 'PATCH',
      path: userResource,
      status: 200,
      response: expect.objectContaining({
        name: expect.objectContaining({ givenName: patchName }),
      }),
    },
    since,
  )
  const updated = { action: 'scim_user.updated', details: { operations: Array(6).fill('replace') } }
  await userAudit(scenario, user.id, ['scim_user.created', updated])

  expect((await readMe(teamSession)).status).toBe(200)
  for (const enabled of [false, true]) {
    since = capture.entries.length
    await realm.updateUser(user.keycloakId, { enabled })
    await seen(
      {
        method: 'PATCH',
        path: userResource,
        request: expect.objectContaining({
          Operations: expect.arrayContaining([{ op: 'replace', path: 'active', value: enabled }]),
        }),
        status: 200,
        response: expect.objectContaining({ active: enabled }),
      },
      since,
    )
    expect(await storedUser(db, user.id)).toEqual({
      id: user.id,
      linked_user_id: member.userId,
      linked_member_id: member.id,
      given_name: patchName,
      active: enabled,
      retired_at: null,
    })
    const block = await liveBlock(db, user.id)
    if (enabled) expect(block).toBeUndefined()
    else expect(block).toEqual({ id: expect.any(String), source: 'scim', kind: 'suspension' })
    expect((await readMe(teamSession)).status).toBe(401)
    expect((await readMe(personalSession)).status).toBe(200)
    await userAudit(scenario, user.id, [
      'scim_user.created',
      updated,
      'scim_user.credentials_revoked',
      'scim_user.deactivated',
      ...(enabled ? ['scim_user.reactivated'] : []),
    ])
  }
  expect((await readMe(await signIn(member.userId, organizationId))).status).toBe(200)
}

async function acceptProtectedUsers(scenario: ScimScenario) {
  const { db, realm, request, seen, capture } = scenario
  for (const { role, profile } of privileged) {
    const member = await seedMember(scenario, profile, role)
    const user = await provision(scenario, profile)
    await seedLink(db, user.id, member)
    const before = await storedUser(db, user.id)

    let since = capture.entries.length
    await realm.updateUser(user.keycloakId, { enabled: false })
    await seen(
      {
        method: 'PUT',
        path: userResource,
        request: expect.objectContaining({ userName: profile.username, active: false }),
        status: 403,
        response: { schemas: [SCIM_ERROR_SCHEMA], status: '403', scimType: 'mutability' },
      },
      since,
    )

    // Keycloak's User mapper has no roles or entitlements, so send those writes directly.
    await expectPrivilegeRefusal(
      await request(user.path, { method: 'PUT', body: putBody(profile, { roles: [] }) }),
    )
    for (const operation of [
      { op: 'replace', path: 'roles', value: [] },
      { op: 'add', path: 'roles', value: [{ value: role === 'owner' ? 'admin' : 'owner' }] },
    ]) {
      await expectPrivilegeRefusal(
        await request(user.path, {
          method: 'PATCH',
          body: JSON.stringify({ schemas: [patchSchema], Operations: [operation] }),
        }),
      )
    }

    since = capture.entries.length
    await realm.deleteUser(user.keycloakId)
    await seen(
      {
        method: 'DELETE',
        path: userResource,
        status: 403,
        response: { schemas: [SCIM_ERROR_SCHEMA], status: '403', scimType: 'mutability' },
      },
      since,
    )
    expect(await storedUser(db, user.id)).toEqual(before)
    expect(await liveBlock(db, user.id)).toBeUndefined()
    expect(
      await db
        .selectFrom('auth.member')
        .select(['id', 'userId', 'role'])
        .where('id', '=', member.id)
        .executeTakeFirst(),
    ).toEqual(member)
    await userAudit(scenario, user.id, ['scim_user.created'])
  }
}

export async function acceptUserPutAndDelete(scenario: ScimScenario) {
  const { db, realm, request, seen, capture } = scenario
  const user = await provision(scenario, person)
  const { claimId, invitationId } = await issuedInvitation(db, user.id)
  await invitationAudit(scenario, invitationId, ['membership.invited'])

  let since = capture.entries.length
  await realm.updateUser(user.keycloakId, { firstName: putName, username: putUsername })
  await seen(
    {
      method: 'GET',
      path: userResource,
      status: 200,
      response: expect.objectContaining({
        name: expect.objectContaining({ givenName: person.firstName }),
      }),
    },
    since,
  )
  await seen(
    {
      method: 'PUT',
      path: userResource,
      request: expect.objectContaining({ userName: putUsername, active: true }),
      status: 200,
      response: expect.objectContaining({
        userName: putUsername,
        name: expect.objectContaining({ givenName: putName }),
      }),
    },
    since,
  )
  const renamed = await request(user.path)
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toMatchObject({ id: user.id, userName: putUsername })
  await userAudit(scenario, user.id, ['scim_user.created', 'scim_user.updated'])

  since = capture.entries.length
  await realm.deleteUser(user.keycloakId)
  await seen({ method: 'DELETE', path: userResource, status: 204 }, since)
  expect((await request(user.path)).status).toBe(404)
  expect(await storedUser(db, user.id)).toEqual({
    id: user.id,
    active: false,
    given_name: putName,
    linked_user_id: null,
    linked_member_id: null,
    retired_at: expect.any(Date),
  })
  const retiredClaim = await db
    .selectFrom('scim_user_claims')
    .select('invalidated_at')
    .where('id', '=', claimId)
    .executeTakeFirstOrThrow()
  expect(retiredClaim.invalidated_at).toEqual(expect.any(Date))
  const invitation = await db
    .selectFrom('auth.invitation')
    .select('status')
    .where('id', '=', invitationId)
    .executeTakeFirstOrThrow()
  expect(invitation.status).toBe('canceled')
  await invitationAudit(scenario, invitationId, [
    'membership.invited',
    'membership.invitation_cancelled',
  ])
  await userAudit(scenario, user.id, [
    'scim_user.created',
    'scim_user.updated',
    'scim_user.retired',
  ])

  await acceptProtectedUsers(scenario)
}
