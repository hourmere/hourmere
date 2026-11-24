import { expect } from '@playwright/test'
import { assertAudit, type ScimScenario, tokenPath } from './scim-fixture.ts'

const discovery = '/ServiceProviderConfig'
const user = {
  username: 'credential-fixture@example.test',
  email: 'credential-fixture@example.test',
  firstName: 'Credential',
  lastName: 'Fixture',
}
const syncedName = 'Rotated'
export const scimCredentialLiterals = [
  ...Object.values(user),
  'Credential Fixture',
  syncedName,
  'Rotated Fixture',
]

export async function acceptCredentialLifecycle({
  db,
  organizationId,
  childId,
  ownerId,
  ownerSession,
  tokenId,
  credential,
  connectionId,
  realm,
  configureTarget,
  capture,
  seen,
  requestAs,
  sessionRequest,
  readIssuedCredential,
}: ScimScenario) {
  await configureTarget()
  const keycloakId = await realm.createUser(user)
  await seen({ method: 'POST', path: '/Users', status: 201 })
  const token = `${tokenPath(organizationId)}/${tokenId}`
  const headers = { 'x-expected-organization-id': organizationId }
  const rotate = async (overlapSeconds: number) =>
    readIssuedCredential(
      await sessionRequest(ownerSession, `${token}/rotate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ overlapSeconds }),
      }),
      200,
    )
  const probe = async (bearer: string, status: number, org = organizationId) => {
    const response = await requestAs(org, bearer, '/Users')
    expect(response.status).toBe(status)
    if (status === 401) {
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(await response.json()).toMatchObject({ status: '401' })
    } else {
      expect(await response.json()).toMatchObject({ totalResults: 1 })
    }
  }

  const replacement = await rotate(0)
  expect(replacement.token).toMatchObject({ id: tokenId, previousValidUntil: null })
  await probe(credential, 401)
  await probe(replacement.secret, 200)
  await probe(replacement.secret, 401, childId)

  const since = capture.entries.length
  await realm.updateUser(keycloakId, { firstName: 'Stale credential' })
  await seen({ status: 401 }, since)
  expect(
    await db
      .selectFrom('scim_users')
      .select('given_name')
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ given_name: user.firstName })

  const overlapping = await rotate(3600)
  expect(overlapping.token.id).toBe(tokenId)
  expect(overlapping.token.previousValidUntil).toEqual(expect.any(String))
  await probe(replacement.secret, 200)
  await probe(overlapping.secret, 200)

  // The plugin resolves the fixture's per-realm file vault when next sending a request.
  await realm.replaceTargetCredential(overlapping.secret)
  const switched = capture.entries.length
  await realm.updateUser(keycloakId, { firstName: syncedName })
  await seen(
    {
      method: 'PATCH',
      path: expect.stringMatching(/^\/Users\/user-\d+$/),
      status: 200,
      response: expect.objectContaining({
        name: expect.objectContaining({ givenName: syncedName }),
      }),
    },
    switched,
  )

  const revoke = () => sessionRequest(ownerSession, token, { method: 'DELETE', headers })
  expect((await revoke()).status).toBe(200)
  for (const bearer of [credential, replacement.secret, overlapping.secret])
    await probe(bearer, 401)
  const revoked = capture.entries.length
  await realm.updateUser(keycloakId, { firstName: 'Revoked credential' })
  await seen({ status: 401 }, revoked)
  expect(
    await db
      .selectFrom('scim_users')
      .select('given_name')
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ given_name: syncedName })
  expect((await revoke()).status).toBe(200)
  expect(
    await db
      .selectFrom('scim_token_connections')
      .select('connection_id')
      .where('token_id', '=', tokenId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ connection_id: connectionId })

  const listed = await sessionRequest(ownerSession, tokenPath(organizationId))
  expect(listed.status).toBe(200)
  const text = await listed.text()
  expect(/"secret"|token_hash|previous_token_hash/.test(text)).toBe(false)
  for (const bearer of [credential, replacement.secret, overlapping.secret])
    expect(text.includes(bearer), 'Token metadata exposed a bearer').toBe(false)

  await assertAudit(db, {
    organizationId,
    targetId: tokenId,
    targetType: 'scim_token',
    actorType: 'user',
    actorId: ownerId,
    credentialType: 'session',
    credentialId: ownerSession.id,
    actions: [
      'scim_token.created',
      'scim_token.rotated',
      'scim_token.rotated',
      'scim_token.revoked',
    ],
  })
}

export async function acceptRateLimits({
  organizationId,
  childId,
  childOwnerId,
  ownerSession,
  credential,
  requestAs,
  signIn,
  sessionRequest,
  readIssuedCredential,
}: ScimScenario) {
  const issue = async (org: string, session: typeof ownerSession) =>
    readIssuedCredential(
      await sessionRequest(session, tokenPath(org), {
        method: 'POST',
        headers: { 'x-expected-organization-id': org },
        body: JSON.stringify({ name: 'Keycloak rate limit fixture' }),
      }),
      201,
    )
  const alternate = await issue(organizationId, ownerSession)
  const other = await issue(childId, await signIn(childOwnerId, childId))
  const addresses = ['192.0.2.10', '192.0.2.11', '192.0.2.12', '192.0.2.13'] as const
  const probe = (ip: string, bearer: string | null, org = organizationId) =>
    requestAs(org, bearer, discovery, { headers: { 'x-forwarded-for': ip } })
  const status = async (response: Response, expected: number) => {
    expect(response.status).toBe(expected)
    if (expected !== 429) {
      await response.arrayBuffer()
      return
    }
    const retry = Number(response.headers.get('retry-after'))
    expect(retry).toBeGreaterThan(0)
    expect(retry).toBeLessThanOrEqual(60)
    expect(response.headers.get('content-type')).toBe('application/scim+json')
    expect(await response.json()).toMatchObject({ status: '429' })
  }

  for (let index = 0; index < 120; index++) await status(await probe(addresses[0], null), 401)
  await status(await probe(addresses[0], null), 429)
  await status(await probe(addresses[0], credential), 429)

  for (let index = 0; index < 60; index++) {
    await status(await probe(addresses[1], credential), 200)
    await status(await probe(addresses[2], alternate.secret), 200)
  }
  // This source has never made a request; the organization is over budget across both tokens.
  await status(await probe(addresses[3], alternate.secret), 429)
  await status(await probe(addresses[3], other.secret, childId), 200)
}
