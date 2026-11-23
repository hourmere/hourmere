import type { Locator, Page } from '@playwright/test'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

const returnPath = '/app/event-types'
const callbackRoute = '/api/auth/sso/callback/'
const mailboxProofPath = '/app/mailbox-proof'
const completePath = '/api/auth/sso/oidc/complete'
const invitationPath = '/api/auth/organization/accept-invitation'
const ssoLabel = 'Sign in with single sign-on'
const emailLinkLabel = 'Email me a sign-in link'
const mailboxSendLabel = 'Send verification email'
const mailboxProven = 'Email verification complete.'
const genericOutcome =
  'To continue, sign in with your usual method or use a current team invitation.'
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
    throw new Error('The browser could not submit the fixture authentication step')
  }
}

async function fillPrivate(input: Locator, value: string) {
  try {
    await input.fill(value)
  } catch {
    throw new Error('The browser could not fill a private fixture field')
  }
}

async function submitKeycloakLogin(page: Page, app: KeycloakFixture, username: string) {
  await page.locator('input[name="username"]').fill(username)
  await fillPrivate(page.locator('input[name="password"]'), app.idp.password)
  await clickPrivate(page.getByRole('button', { name: /^sign in$/i }))
}

async function signInAtKeycloak(
  page: Page,
  app: KeycloakFixture,
  username = app.idp.linked.username,
) {
  await clickPrivate(button(page, ssoLabel))
  await submitKeycloakLogin(page, app, username)
}

async function signInWithEmail(page: Page, app: KeycloakFixture, email: string) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await button(page, emailLinkLabel).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await openPrivateLink(page, await app.magicLink(email))
  await clickPrivate(button(page, 'Sign in to Hourmere'))
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
    organization: personal ? { personal } : { id: app.teamId, personal },
  })
}

async function expectSignedOut(page: Page, app: KeycloakFixture) {
  expect((await page.request.get(`${app.url}/api/v1/me`)).status()).toBe(401)
}

async function signOut(page: Page, app: KeycloakFixture) {
  await button(page, 'Sign out').click()
  await expect(button(page, emailLinkLabel)).toBeVisible()
  await expectSignedOut(page, app)
}

async function expectRefusal(page: Page, app: KeycloakFixture) {
  await expect(page.getByRole('alert')).toHaveText('You could not be signed in. Please try again.')
  const url = new URL(page.url())
  expect(url.origin === app.url && url.pathname === '/sign-in').toBe(true)
  await expectSignedOut(page, app)
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
  await signInWithEmail(page, app, app.personal.email)
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

async function openMemberSettings(page: Page, app: KeycloakFixture) {
  await page.goto(`${app.url}/sign-in`)
  await signInWithEmail(page, app, app.idp.linkable.email)
  await expectSession(page, app, app.linkableUserId, true)
  const space = page.getByRole('button', { name: /^Switch space/ })
  await space.click()
  await page.getByRole('menuitemradio', { name: app.teamName, exact: true }).click()
  await expect(space).toContainText(app.teamName)
  await page.goto(`${app.url}/app/settings`)
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  // Read the capabilities directly: the page's own response body is discarded on navigation.
  const instance = await page.request.get(`${app.url}/api/v1/instance`)
  expect(instance.status()).toBe(200)
  const capabilities = await instance.json()
  return capabilities
}

async function proveMailbox(page: Page, app: KeycloakFixture, email: string) {
  await button(page, mailboxSendLabel).click()
  const field = page.getByLabel('Email verification link', { exact: true })
  await expect(field).toBeEnabled()
  const link = await app.mailboxLink(email)
  await fillPrivate(field, link.href)
  await clickPrivate(button(page, 'Verify email link'))
  await expect(page.getByText(mailboxProven, { exact: true })).toBeVisible()
  return new URLSearchParams(link.hash.slice(1)).get('attempt')
}

async function beginAdmission(page: Page, app: KeycloakFixture, username: string) {
  await page.goto(signInUrl(app))
  const [callback] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.origin === app.url && url.pathname === `${callbackRoute}${app.providerId}`
    }),
    signInAtKeycloak(page, app, username),
  ])
  expect(callback.status()).toBe(302)
  const location = await callback.headerValue('location')
  const target = location && URL.canParse(location, app.url) ? new URL(location, app.url) : null
  expect(
    target !== null &&
      target.origin === app.url &&
      target.pathname === mailboxProofPath &&
      target.search === '' &&
      /^#attempt=[a-f0-9-]{36}$/.test(target.hash),
  ).toBe(true)
  await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible()
  await expect(button(page, mailboxSendLabel)).toBeEnabled()
  await expectSignedOut(page, app)
}

async function continueAdmission(page: Page, app: KeycloakFixture, status: number) {
  const [completion] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${app.url}${completePath}`),
    button(page, 'Continue').click(),
  ])
  expect(completion.status()).toBe(status)
  await expect(page.getByText(genericOutcome, { exact: true })).toBeVisible()
  await expectSignedOut(page, app)
  return completion
}

async function mailboxPromptText(page: Page) {
  return ((await page.getByRole('main').textContent()) ?? '').replace(/\s+/g, ' ').trim()
}

const noAccount = {
  userId: null,
  teamRole: null,
  linkedSubjects: [],
  sessionCount: 0,
  personalSpace: false,
}

test('a team member proves their Hourmere mailbox and explicitly links Keycloak', async ({
  page,
  context,
  keycloak: app,
}) => {
  const { email, subject, username } = app.idp.linkable
  await openMemberSettings(page, app)
  const before = await app.account(email)
  expect(before).toMatchObject({
    userId: app.linkableUserId,
    teamRole: 'member',
    linkedSubjects: [],
    sessionCount: 1,
    personalSpace: true,
  })

  await button(page, 'Link account (Fixture Keycloak)').click()
  await button(page, 'Link account').click()
  const authorize = page.getByRole('link', { name: 'Continue to identity provider', exact: true })
  await expect(button(page, 'Continue')).toBeDisabled()
  await expect(authorize).toHaveCount(0)
  expect(app.tokenExchanges()).toEqual([])
  await proveMailbox(page, app, email)
  await button(page, 'Continue').click()
  await clickPrivate(authorize)
  await submitKeycloakLogin(page, app, username)
  await expect(page.getByRole('heading', { name: 'Confirm your SSO link' })).toBeVisible()
  expect(await app.account(email)).toEqual(before)
  await button(page, 'Confirm link').click()
  await expect(page.getByText('Sign-in method linked.', { exact: true })).toBeVisible()
  expect(await app.account(email)).toEqual({ ...before, linkedSubjects: [subject] })
  expect(app.tokenExchanges()).toEqual(['issued'])

  await signOut(page, app)
  await context.clearCookies()
  await page.goto(signInUrl(app))
  await signInAtKeycloak(page, app, username)
  await expectSession(page, app, app.linkableUserId, false)
  expect(app.tokenExchanges()).toEqual(['issued', 'issued'])
})

test('unlinked subjects get the same prompt and a matching verified IdP email grants no account', async ({
  page,
  context,
  keycloak: app,
}) => {
  const { sameEmail, unverified } = app.idp
  const owner = await app.account(sameEmail.email)
  expect(owner).toMatchObject({
    userId: app.linkedUserId,
    linkedSubjects: [app.idp.linked.subject],
    sessionCount: 0,
  })
  await beginAdmission(page, app, sameEmail.username)
  const mailboxPrompt = await mailboxPromptText(page)
  expect(mailboxPrompt.includes(sameEmail.email), 'The prompt must omit the mailbox').toBe(false)
  await expect(button(page, 'Continue')).toHaveCount(0)
  expect(await app.account(sameEmail.email)).toEqual(owner)

  // Even the mailbox holder must sign in independently and explicitly link an existing account.
  await proveMailbox(page, app, sameEmail.email)
  const existing = await continueAdmission(page, app, 200)
  expect((await existing.json()).status === 'link_required').toBe(true)
  expect(await app.account(sameEmail.email)).toEqual(owner)

  await context.clearCookies()
  await beginAdmission(page, app, unverified.username)
  expect((await mailboxPromptText(page)) === mailboxPrompt, 'The mailbox prompts must match').toBe(
    true,
  )
  expect(await app.account(unverified.email)).toEqual(noAccount)
  expect(app.tokenExchanges()).toEqual(['issued', 'issued'])
})

test('a proved Keycloak recipient explicitly accepts a pending invitation on closed signup', async ({
  page,
  keycloak: app,
}) => {
  const { email, subject, username } = app.idp.invited
  await beginAdmission(page, app, username)
  expect(await app.account(email)).toEqual(noAccount)
  const attemptId = await proveMailbox(page, app, email)
  const waiting = await continueAdmission(page, app, 409)
  expect((await waiting.json()).error === 'sso_invitation_required').toBe(true)
  expect(await app.invitationStatus()).toBe('pending')
  expect(await app.account(email)).toEqual(noAccount)

  if (!attemptId) throw new Error('The fixture mailbox link had no admission attempt')
  // Exercise the existing explicit acceptance endpoint in the browser that holds the proof.
  const status = await page.evaluate(
    async ({ invitationId, attemptId, path }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hourmere-Sso-Attempt': attemptId,
        },
        body: JSON.stringify({ invitationId }),
      })
      return response.status
    },
    { invitationId: app.invitationId, attemptId, path: invitationPath },
  )
  expect(status).toBe(200)
  expect(await app.invitationStatus()).toBe('accepted')
  const admitted = await app.account(email)
  expect(admitted).toMatchObject({
    teamRole: 'member',
    linkedSubjects: [subject],
    sessionCount: 1,
    personalSpace: true,
  })
  if (!admitted.userId) throw new Error('Invitation acceptance did not create a fixture account')
  await page.goto(`${app.url}${returnPath}`)
  await expectSession(page, app, admitted.userId, false)
  expect(app.tokenExchanges()).toEqual(['issued'])
})

test.describe('JIT team admission', () => {
  test.use({ admission: 'jit' })

  test.describe('open signup', () => {
    test.use({ signupMode: 'open' })

    test('a new Keycloak subject joins as a member after Hourmere mailbox proof', async ({
      page,
      keycloak: app,
    }) => {
      const { email, subject, username } = app.idp.unverified
      await beginAdmission(page, app, username)
      expect(await app.account(email)).toEqual(noAccount)
      await proveMailbox(page, app, email)
      expect(await app.account(email)).toEqual(noAccount)
      await button(page, 'Continue').click()
      await expect(button(page, 'Sign out')).toBeVisible()
      const admitted = await app.account(email)
      expect(admitted).toMatchObject({
        teamRole: 'member',
        linkedSubjects: [subject],
        sessionCount: 1,
        personalSpace: true,
      })
      if (!admitted.userId) throw new Error('JIT admission did not create a fixture account')
      await expectSession(page, app, admitted.userId, false)
      expect(app.tokenExchanges()).toEqual(['issued'])
    })
  })

  test('closed signup refuses a proved Keycloak mailbox without a current invitation', async ({
    page,
    keycloak: app,
  }) => {
    const { email, username } = app.idp.unverified
    await beginAdmission(page, app, username)
    await proveMailbox(page, app, email)
    const refused = await continueAdmission(page, app, 403)
    expect((await refused.json()).error === 'signup_disabled').toBe(true)
    expect(await app.account(email)).toEqual(noAccount)
    expect(app.tokenExchanges()).toEqual(['issued'])
  })
})

test.describe('with the OIDC setting off', () => {
  test.use({ oidcEnabled: false })

  test('the same seeded fixture offers no SSO sign-in, link, or admission entry', async ({
    page,
    keycloak: app,
  }) => {
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

    await page.goto(`${app.url}${mailboxProofPath}#attempt=${app.providerId}`)
    await expect(
      page.getByText('Identity verification is unavailable.', { exact: true }),
    ).toBeVisible()
    await expect(button(page, mailboxSendLabel)).toHaveCount(0)
    await expect(button(page, 'Continue')).toHaveCount(0)

    const capabilities = await openMemberSettings(page, app)
    expect(capabilities).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: false })
    await expect(page.getByRole('heading', { name: 'Your team sign-in' })).toHaveCount(0)
    await expect(button(page, 'Link account (Fixture Keycloak)')).toHaveCount(0)
    const link = await page.request.post(
      `${app.url}/api/v1/team/sso/providers/${app.providerId}/link`,
      {
        headers: { origin: app.url, 'X-Expected-Organization-Id': app.teamId },
        data: {},
      },
    )
    expect(link.status()).toBe(404)
    expect((await link.json()).error === 'sso_disabled').toBe(true)
    const complete = await page.request.post(`${app.url}${completePath}`, {
      headers: { origin: app.url },
      data: { attemptId: app.providerId },
    })
    expect(complete.status()).toBe(404)
    expect((await complete.json()).error === 'sso_disabled').toBe(true)
    expect(app.tokenExchanges()).toEqual([])
  })
})
