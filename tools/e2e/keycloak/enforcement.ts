import type { Page } from '@playwright/test'
import { SSO_DELEGATIONS_PATH } from '../../../apps/server/src/sso-delegation-proof.ts'
import { createFixtures } from '../../../packages/scheduling/src/testing.ts'
import { runCli } from '../../cli/src/cli.ts'
import { button, expectMailboxCannotEnterTeam, readFixtureApi, signOut } from './browser.ts'
import { expect, type KeycloakFixture } from './fixture.ts'

const eventsPath = '/api/v1/event-types'

async function createTeamKey(page: Page, app: KeycloakFixture) {
  const response = await page.request
    .post(`${app.url}/api/auth/api-key/create`, {
      headers: { origin: app.url },
      maxRedirects: 0,
      data: {
        name: 'Fixture CLI and MCP key',
        metadata: { organizationId: app.teamId, scope: 'read' },
      },
    })
    .catch(() => {
      throw new Error('The browser could not create a fixture API key')
    })
  expect(response.status()).toBe(200)
  const { id, key } = (await response.json().catch(() => {
    throw new Error('The API key creation response was unreadable')
  })) as { id?: string; key?: string }
  if (!id || !key) throw new Error('The fixture did not receive its new API key')
  return { id, key }
}

async function agentCatalog(app: KeycloakFixture, key: string) {
  let stdout = ''
  let stderr = ''
  const authorization = `Bearer ${key}`
  const [rest, mcp, cliExit] = await Promise.all([
    fetch(`${app.url}${eventsPath}`, { headers: { authorization }, redirect: 'manual' }),
    fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_event_types', arguments: {} },
      }),
      redirect: 'manual',
    }),
    runCli({
      argv: ['catalog'],
      env: { HOURMERE_URL: app.url, HOURMERE_API_KEY: key },
      stdin: (async function* () {})(),
      stdout: (line) => {
        stdout += line
      },
      stderr: (line) => {
        stderr += line
      },
    }),
  ])
  expect(rest.headers.has('location')).toBe(false)
  expect(mcp.headers.has('location')).toBe(false)
  expect(mcp.status).toBe(200)
  const [restBody, mcpBody] = await Promise.all([rest.text(), mcp.text()])
  expect(
    [restBody, mcpBody, stdout, stderr].some((output) => output.includes(key)),
    'Agent responses must omit the API key',
  ).toBe(false)
  const packet = mcpBody.split('\n').find((line) => line.startsWith('data: '))
  const { result } = JSON.parse(packet ? packet.slice(6) : mcpBody)
  const mcpFailed = result.isError === true
  return {
    rest: { status: rest.status, body: JSON.parse(restBody) },
    mcp: {
      failed: mcpFailed,
      body: mcpFailed ? JSON.parse(result.content[0].text) : result.structuredContent,
    },
    cli: { exit: cliExit, body: JSON.parse(stdout || stderr) },
  }
}

async function expectAgentDenial(app: KeycloakFixture, key: string) {
  const failure = { error: 'sso_required' }
  expect(await agentCatalog(app, key)).toMatchObject({
    rest: { status: 403, body: failure },
    mcp: { failed: true, body: failure },
    cli: { exit: 1, body: failure },
  })
}

async function createTeamEvent(app: KeycloakFixture, title: string) {
  return createFixtures(app.db).eventType(app.teamId, null, {
    title,
    hosts: [{ userId: app.linkedUserId }],
  })
}

type SignIn = (page: Page, app: KeycloakFixture) => Promise<void>

export async function expectEnforcedTeamAccess(
  page: Page,
  app: KeycloakFixture,
  signInUrl: string,
  signIn: SignIn,
) {
  const eventId = await createTeamEvent(app, 'Private Keycloak team event')
  await page.goto(signInUrl)
  await expectMailboxCannotEnterTeam(page, app)
  const personal = await readFixtureApi(page, `${app.url}${eventsPath}`)
  expect(personal.status()).toBe(200)
  expect(await personal.json()).toEqual({ data: [] })
  await signOut(page, app)

  await signIn(page, app)
  const team = await readFixtureApi(page, `${app.url}${eventsPath}`)
  expect(team.status()).toBe(200)
  expect(await team.json()).toMatchObject({ data: [{ id: eventId, organizationId: app.teamId }] })
}

export async function exerciseTeamDelegation(
  page: Page,
  app: KeycloakFixture,
  signIn: SignIn,
  verifyFreshLogin: () => Promise<void>,
) {
  const eventId = await createTeamEvent(app, 'Delegated Keycloak team event')
  await signIn(page, app)
  const credential = await createTeamKey(page, app)
  await expectAgentDenial(app, credential.key)

  await page.goto(`${app.url}/app/api-keys`)
  const [challenge] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${app.url}${SSO_DELEGATIONS_PATH}` &&
        response.request().method() === 'POST',
    ),
    button(page, 'Bind SSO delegation').click(),
  ])
  expect(challenge.status()).toBe(403)
  const { error, proofMethods } = await challenge.json()
  expect({ error, proofMethods }).toEqual({
    error: 'sso_reauthentication_required',
    proofMethods: ['sso'],
  })

  await button(page, 'Start SSO verification').click()
  await button(page, 'Continue').click()
  await expect(page.getByRole('alert')).toHaveText(
    'Could not confirm your SSO sign-in. Finish signing in or start SSO verification again.',
  )
  await expectAgentDenial(app, credential.key)
  await verifyFreshLogin()
  await button(page, 'Continue').click()
  await expect(page.getByText('SSO delegation bound.', { exact: true })).toBeVisible()

  const lease = await app.db
    .selectFrom('sso_delegation_bindings')
    .select(['created_at', 'expires_at', 'provider_id'])
    .where('api_key_id', '=', credential.id)
    .executeTakeFirstOrThrow()
  expect(lease.provider_id).toBe(app.providerId)
  // SAML can cap the delegation and the browser proof at an IdP session deadline.
  if (!app.idp.saml) {
    const proof = await app.db
      .selectFrom('sso_browser_proofs')
      .select('expires_at')
      .where('organization_id', '=', app.teamId)
      .where('user_id', '=', app.linkedUserId)
      .executeTakeFirstOrThrow()
    expect(lease.expires_at.getTime()).toBeGreaterThan(proof.expires_at.getTime())
  }
  expect(lease.expires_at.getTime() - lease.created_at.getTime()).toBeLessThanOrEqual(
    30 * 24 * 60 * 60 * 1000,
  )
  const catalog = { data: [{ id: eventId, organizationId: app.teamId }] }
  expect(await agentCatalog(app, credential.key)).toMatchObject({
    rest: { status: 200, body: catalog },
    mcp: { failed: false, body: catalog },
    cli: { exit: 0, body: catalog },
  })

  await button(page, 'Revoke SSO delegation').click()
  await page
    .getByRole('group', { name: 'Revoke this SSO delegation?', exact: true })
    .getByRole('button', { name: 'Revoke SSO delegation', exact: true })
    .click()
  await expect(page.getByText('SSO delegation revoked.', { exact: true })).toBeVisible()
  await expectAgentDenial(app, credential.key)
}
