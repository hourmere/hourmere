import type { Page } from '@playwright/test'
import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { expect, test } from '../fixtures.ts'

const ssoLabel = 'Sign in with single sign-on'
const missingProviderId = '00000000-0000-7000-8000-000000000007'

async function getJson(page: Page, url: string, teamId?: string) {
  let response: Awaited<ReturnType<Page['request']['get']>>
  try {
    response = await page.request.get(url, {
      headers: teamId ? { 'X-Expected-Organization-Id': teamId } : {},
    })
  } catch {
    throw new Error('Could not read the fixture API')
  }
  expect(response.status()).toBe(200)
  return response.json()
}

async function openSignIn(page: Page, url: string) {
  const [instance] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/instance'),
    page.goto(url),
  ])
  expect(instance.status()).toBe(200)
  await expect(
    page.getByRole('button', { name: 'Email me a sign-in link', exact: true }),
  ).toBeVisible()
}

test.use({ ssoOptOut: true })

test('upgrading an unconfigured team adds SSO entry points and preserves existing team access', async ({
  page,
  context,
  app,
}) => {
  const oidcSignIn = new URL(`/sign-in?sso=${missingProviderId}`, app.url)
  const samlSignIn = new URL(oidcSignIn)
  samlSignIn.searchParams.set('saml', '1')
  const ssoSignIn = page.getByRole('button', { name: ssoLabel, exact: true })
  const identityProviders = page.getByRole('link', { name: 'Identity providers', exact: true })
  const domainSettings = page.getByRole('link', { name: 'SSO domains', exact: true })
  const instanceUrl = `${app.url}/api/v1/instance`

  expect(await getJson(page, instanceUrl)).toMatchObject({
    ssoOidcEnabled: false,
    ssoSamlEnabled: false,
  })
  for (const url of [oidcSignIn, samlSignIn]) {
    await openSignIn(page, url.href)
    await expect(ssoSignIn).toHaveCount(0)
  }

  const { teamId } = await app.authorizeTeamSession()
  const readTeam = async (path: string) => getJson(page, `${app.url}/api/v1/${path}`, teamId)
  const [me, events, policy] = await Promise.all([
    readTeam('me'),
    readTeam('event-types'),
    readTeam('team/sso/policy'),
  ])
  expect(me).toMatchObject({ organization: { id: teamId } })
  expect(me).not.toHaveProperty('sso')
  expect(events).toMatchObject({
    data: expect.arrayContaining([expect.objectContaining({ title: 'Team fixture call' })]),
  })
  expect(policy).toMatchObject({ requireSso: false, admission: 'invitation_only' })
  await page.goto(`${app.url}/app/settings`)
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await expect(identityProviders).toHaveCount(0)
  await expect(domainSettings).toHaveCount(0)

  await app.restartWithDefaultSso()

  expect(await getJson(page, instanceUrl)).toMatchObject({
    ssoOidcEnabled: true,
    ssoSamlEnabled: true,
  })
  expect(await readTeam('me')).toEqual({
    ...(me as components['schemas']['Me']),
    sso: { attempts: [], links: [], proofs: [], providers: [], requireSso: false },
  })
  expect(await readTeam('event-types')).toEqual(events)
  expect(await readTeam('team/sso/policy')).toEqual(policy)
  await page.reload()
  await expect(identityProviders).toBeVisible()
  await expect(domainSettings).toBeVisible()
  await identityProviders.click()
  await expect(page.getByText('No identity providers yet.', { exact: true })).toBeVisible()

  await context.clearCookies()
  await openSignIn(page, `${app.url}/sign-in`)
  await expect(ssoSignIn).toHaveCount(0)
  for (const url of [oidcSignIn, samlSignIn]) {
    await openSignIn(page, url.href)
    await expect(ssoSignIn).toBeVisible()
    const [start] = await Promise.all([
      page.waitForResponse(`${app.url}/api/auth/sign-in/sso`),
      ssoSignIn.click(),
    ])
    expect(start.status()).toBe(404)
    expect(await start.json()).toEqual({ error: 'sso_not_found' })
  }
})
