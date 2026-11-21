import type { Locator, Page } from '@playwright/test'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

const returnPath = '/app/event-types'
const callbackRoute = '/api/auth/sso/callback/'
const ssoLabel = 'Sign in with single sign-on'
const emailLinkLabel = 'Email me a sign-in link'
const personalSignInLabels = ['Continue with Google', 'Sign in with Microsoft']

function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true })
}

function signInUrl(app: KeycloakFixture) {
  const url = new URL('/sign-in', app.url)
  url.search = new URLSearchParams({ sso: app.providerId, next: returnPath }).toString()
  return url.href
}

function isAuthorization(url: URL, { idp }: KeycloakFixture) {
  const authorize = new URL(`${idp.issuer}/protocol/openid-connect/auth`)
  return url.origin === authorize.origin && url.pathname === authorize.pathname
}

async function openPrivateLink(page: Page, url: URL) {
  try {
    await page.goto(url.href)
  } catch {
    throw new Error('The browser could not open the fixture sign-in link')
  }
}

async function clickPrivate(button: Locator) {
  try {
    await button.click()
  } catch {
    throw new Error('The browser could not submit the fixture sign-in step')
  }
}

async function signInAtKeycloak(page: Page, app: KeycloakFixture) {
  await clickPrivate(button(page, ssoLabel))
  await page.locator('input[name="username"]').fill(app.idp.linked.username)
  try {
    await page.locator('input[name="password"]').fill(app.idp.password)
  } catch {
    throw new Error('The Keycloak password field could not be filled')
  }
  await clickPrivate(page.getByRole('button', { name: /^sign in$/i }))
}

async function expectSession(page: Page, app: KeycloakFixture, userId: string, personal: boolean) {
  await expect
    .poll(() => {
      const url = new URL(page.url())
      return url.origin === app.url && url.pathname === returnPath
    })
    .toBe(true)
  await expect(button(page, 'Sign out')).toBeVisible()
  const response = await page.request.get(`${app.url}/api/v1/me`)
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({
    user: { id: userId },
    principal: { kind: 'session' },
    organization: { personal },
  })
}

async function signOut(page: Page, app: KeycloakFixture) {
  await button(page, 'Sign out').click()
  await expect(button(page, emailLinkLabel)).toBeVisible()
  expect((await page.request.get(`${app.url}/api/v1/me`)).status()).toBe(401)
}

async function expectRefusal(page: Page, app: KeycloakFixture) {
  await expect(page.getByRole('alert')).toHaveText('You could not be signed in. Please try again.')
  const url = new URL(page.url())
  expect(url.origin === app.url && url.pathname === '/sign-in').toBe(true)
  expect((await page.request.get(`${app.url}/api/v1/me`)).status()).toBe(401)
}

test('linked Keycloak sign-in coexists with personal email, Google and Microsoft sign-in', async ({
  page,
  keycloak: app,
}) => {
  await page.goto(signInUrl(app))
  await expect(button(page, emailLinkLabel)).toBeVisible()
  for (const label of personalSignInLabels) await expect(button(page, label)).toBeVisible()

  await signInAtKeycloak(page, app)
  await expectSession(page, app, app.linkedUserId, false)
  expect(app.tokenExchanges()).toEqual(['issued'])
  await signOut(page, app)

  await page.goto(signInUrl(app))
  await expect(button(page, ssoLabel)).toBeVisible()
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(app.personal.email)
  await button(page, emailLinkLabel).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await openPrivateLink(page, await app.magicLink(app.personal.email))
  await clickPrivate(button(page, 'Sign in to Hourmere'))
  await expectSession(page, app, app.personal.userId, true)

  for (const label of personalSignInLabels) {
    await signOut(page, app)
    await page.goto(signInUrl(app))
    await expect(button(page, ssoLabel)).toBeVisible()
    await clickPrivate(button(page, label))
    await expectSession(page, app, app.personal.userId, true)
  }
  expect(app.tokenExchanges()).toEqual(['issued'])
})

for (const field of ['state', 'nonce'] as const) {
  test(`Keycloak sign-in refuses a tampered ${field}`, async ({ page, keycloak: app }) => {
    await page.route(
      (url) => isAuthorization(url, app),
      async (route) => {
        const authorization = new URL(route.request().url())
        const original = authorization.searchParams.get(field)
        if (!original) throw new Error(`Keycloak authorization request has no ${field}`)
        // Change ciphertext while keeping the state envelope header and attempt ID.
        // Keycloak signs the changed nonce into its genuine ID token.
        const index = field === 'state' ? original.length - 2 : 0
        const replacement = original[index] === 'A' ? 'B' : 'A'
        authorization.searchParams.set(
          field,
          `${original.slice(0, index)}${replacement}${original.slice(index + 1)}`,
        )
        await route.continue({ url: authorization.href })
      },
      { times: 1 },
    )
    await page.goto(signInUrl(app))
    await signInAtKeycloak(page, app)
    await expectRefusal(page, app)
    // State fails before the exchange. Nonce fails after a successful real exchange.
    expect(app.tokenExchanges()).toEqual(field === 'state' ? [] : ['issued'])
  })
}

test('Keycloak sign-in refuses a used authorization code with consumed or fresh state', async ({
  page,
  keycloak: app,
}) => {
  await page.goto(signInUrl(app))
  const [incoming] = await Promise.all([
    page.waitForRequest((request) => {
      const url = new URL(request.url())
      return url.origin === app.url && url.pathname === `${callbackRoute}${app.providerId}`
    }),
    signInAtKeycloak(page, app),
  ])
  const original = new URL(incoming.url())
  if (!original.searchParams.get('code') || !original.searchParams.get('state'))
    throw new Error('Keycloak did not return an authorization code and state')
  await expectSession(page, app, app.linkedUserId, false)
  await signOut(page, app)

  await openPrivateLink(page, original)
  await expectRefusal(page, app)
  expect(app.tokenExchanges()).toEqual(['issued'])

  // Start a fresh browser-bound attempt, then return the used code with its new state.
  // The callback reaches the actual Keycloak token endpoint with its new PKCE verifier.
  await page.route(
    (url) => isAuthorization(url, app),
    async (route) => {
      const state = new URL(route.request().url()).searchParams.get('state')
      if (!state || state === original.searchParams.get('state'))
        throw new Error('The second sign-in did not start a fresh OIDC attempt')
      const replay = new URL(original)
      replay.searchParams.set('state', state)
      await route.fulfill({
        status: 302,
        headers: { location: replay.href, 'Cache-Control': 'no-store' },
      })
    },
    { times: 1 },
  )
  await page.goto(signInUrl(app))
  await clickPrivate(button(page, ssoLabel))
  await expectRefusal(page, app)
  expect(app.tokenExchanges()).toEqual(['issued', 'invalid_code'])
})

test.describe('without OIDC injection', () => {
  test.use({ oidcEnabled: false })

  test('the same seeded fixture offers only personal sign-in', async ({ page, keycloak: app }) => {
    await page.goto(signInUrl(app))
    await expect(button(page, emailLinkLabel)).toBeVisible()
    for (const label of personalSignInLabels) await expect(button(page, label)).toBeVisible()
    await expect(button(page, ssoLabel)).toHaveCount(0)
    const start = await page.request.post(`${app.url}/api/auth/sign-in/sso`, {
      headers: { origin: app.url },
      data: { providerId: app.providerId, intent: 'sign_in', returnTo: returnPath },
    })
    expect(start.status()).toBe(404)
    expect((await start.json()).error === 'sso_disabled').toBe(true)
    expect(app.tokenExchanges()).toEqual([])
  })
})
