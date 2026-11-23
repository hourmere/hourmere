import type { Page } from '@playwright/test'
import { createFixtures } from '../../../packages/scheduling/src/testing.ts'
import { runCli } from '../../cli/src/cli.ts'
import {
  button,
  clickPrivate,
  expectMailboxCannotEnterTeam,
  expectSession,
  isAuthorization,
  signInAtKeycloak,
  signInUrl,
  signOut,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

const eventsPath = '/api/v1/event-types'
const delegationPath = '/api/v1/team/sso/delegations'

async function createTeamKey(page: Page, app: KeycloakFixture) {
  const response = await page.request.post(`${app.url}/api/auth/api-key/create`, {
    headers: { origin: app.url },
    maxRedirects: 0,
    data: {
      name: 'Fixture CLI and MCP key',
      metadata: { organizationId: app.teamId, scope: 'read' },
    },
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

test.describe('an enforced Keycloak team', () => {
  test.use({ enforced: true })

  test('refuses a mailbox session at the team boundary and admits the same owner through OIDC', async ({
    page,
    keycloak: app,
  }) => {
    const eventId = await createFixtures(app.db).eventType(app.teamId, null, {
      title: 'Private Keycloak team event',
      hosts: [{ userId: app.linkedUserId }],
    })
    await page.goto(signInUrl(app))
    await expectMailboxCannotEnterTeam(page, app)
    const personal = await page.request.get(`${app.url}${eventsPath}`)
    expect(personal.status()).toBe(200)
    expect(await personal.json()).toEqual({ data: [] })
    await signOut(page, app)

    await page.goto(signInUrl(app))
    await signInAtKeycloak(page, app)
    await expectSession(page, app, app.linkedUserId, false)
    const team = await page.request.get(`${app.url}${eventsPath}`)
    expect(team.status()).toBe(200)
    expect(await team.json()).toMatchObject({ data: [{ id: eventId, organizationId: app.teamId }] })
  })

  test('binds a CLI and MCP lease only after fresh Keycloak login and revokes it for both transports', async ({
    page,
    context,
    keycloak: app,
  }) => {
    const eventId = await createFixtures(app.db).eventType(app.teamId, null, {
      title: 'Delegated Keycloak team event',
      hosts: [{ userId: app.linkedUserId }],
    })
    await page.goto(signInUrl(app))
    await signInAtKeycloak(page, app)
    await expectSession(page, app, app.linkedUserId, false)
    const credential = await createTeamKey(page, app)
    await expectAgentDenial(app, credential.key)

    await page.goto(`${app.url}/app/api-keys`)
    const [challenge] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${app.url}${delegationPath}`),
      button(page, 'Bind SSO delegation').click(),
    ])
    expect(challenge.status()).toBe(403)
    expect(await challenge.json()).toMatchObject({
      error: 'sso_reauthentication_required',
      proofMethods: ['sso'],
    })

    await button(page, 'Start SSO verification').click()
    await button(page, 'Continue').click()
    await expect(page.getByRole('alert')).toHaveText(
      'Could not confirm your SSO sign-in. Finish signing in or start SSO verification again.',
    )
    expect(app.tokenExchanges()).toEqual(['issued'])
    await expectAgentDenial(app, credential.key)

    // The same BrowserContext already holds a Keycloak session from the first sign-in.
    const [identityProvider, request] = await Promise.all([
      context.waitForEvent('page'),
      context.waitForEvent('request', {
        predicate: (request) => isAuthorization(new URL(request.url()), app),
      }),
      clickPrivate(page.getByRole('link', { name: /^Open identity provider/ })),
    ])
    const parameters = new URL(request.url()).searchParams
    expect(parameters.getAll('prompt')).toEqual(['login'])
    expect(parameters.getAll('max_age')).toEqual(['0'])
    try {
      await submitKeycloakLogin(identityProvider, app, app.idp.linked.username)
      await expect(
        identityProvider.getByRole('heading', { name: 'Account', exact: true }),
      ).toBeVisible()
    } finally {
      await identityProvider.close()
    }
    await button(page, 'Continue').click()
    await expect(page.getByText('SSO delegation bound.', { exact: true })).toBeVisible()
    expect(app.tokenExchanges()).toEqual(['issued', 'issued'])

    const lease = await app.db
      .selectFrom('sso_delegation_bindings')
      .select(['created_at', 'expires_at'])
      .where('api_key_id', '=', credential.id)
      .executeTakeFirstOrThrow()
    const proof = await app.db
      .selectFrom('sso_browser_proofs')
      .select('expires_at')
      .where('organization_id', '=', app.teamId)
      .where('user_id', '=', app.linkedUserId)
      .executeTakeFirstOrThrow()
    expect(lease.expires_at.getTime()).toBeGreaterThan(proof.expires_at.getTime())
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
  })
})
