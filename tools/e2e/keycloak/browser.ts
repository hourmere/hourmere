import type { Locator, Page } from '@playwright/test'
import { SAML_COMPLETE_PATH } from '../../../apps/server/src/sso-saml-state.ts'
import { accountMenuButton, accountMenuPanel } from '../account-menu.ts'
import { describeStrandedPage, expect, type KeycloakFixture } from './fixture.ts'

export { describeStrandedPage }

export const returnPath = '/app/event-types'
export const ssoLabel = 'Sign in with single sign-on'
export const emailLinkLabel = 'Email me a sign-in link'
export const mailboxSendLabel = 'Send verification email'
export const mailboxProofPath = '/app/mailbox-proof'
const invitationPath = '/api/auth/organization/accept-invitation'
export const genericOutcome =
  'To continue, sign in with your usual method or use a current team invitation.'
export const noAccount = {
  userId: null,
  teamRole: null,
  linkedSubjects: [],
  sessionCount: 0,
  personalSpace: false,
}

export function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true })
}

export function signInUrl(app: KeycloakFixture) {
  const url = new URL('/sign-in', app.url)
  url.search = new URLSearchParams({ sso: app.providerId, next: returnPath }).toString()
  return url.href
}

export function samlSignInUrl(app: KeycloakFixture) {
  const url = new URL(signInUrl(app))
  url.searchParams.set('saml', '1')
  return url.href
}

export function samlClient(app: KeycloakFixture) {
  if (!app.idp.saml) throw new Error('The fixture has no SAML client')
  return app.idp.saml
}

export async function completeSamlCeremony(page: Page, app: KeycloakFixture, label = 'Continue') {
  const [completion] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${app.url}${SAML_COMPLETE_PATH}`,
    ),
    clickPrivate(button(page, label)),
  ])
  return completion
}

export function isAuthorization(url: URL, { idp }: KeycloakFixture) {
  const authorize = new URL(`${idp.issuer}/protocol/openid-connect/auth`)
  return url.origin === authorize.origin && url.pathname === authorize.pathname
}

export async function openPrivateLink(page: Page, url: URL) {
  try {
    await page.goto(url.href)
  } catch {
    throw new Error('The browser could not open the fixture sign-in link')
  }
}

export async function clickPrivate(button: Locator) {
  try {
    await button.click()
  } catch {
    throw new Error('The browser could not submit the fixture authentication step')
  }
}

export async function fillPrivate(input: Locator, value: string) {
  try {
    await input.fill(value)
  } catch {
    throw new Error('The browser could not fill a private fixture field')
  }
}

export async function submitKeycloakLogin(page: Page, app: KeycloakFixture, username: string) {
  const password = page.locator('input[name="password"]')
  await expect(password).toBeVisible()
  // On forced reauthentication Keycloak can already know the username from its session.
  const account = page.locator('input[name="username"]')
  if (await account.isVisible()) await account.fill(username)
  await fillPrivate(password, app.idp.password)
  await clickPrivate(page.getByRole('button', { name: /^sign in$/i }))
}

export async function signInAtKeycloak(
  page: Page,
  app: KeycloakFixture,
  username = app.idp.linked.username,
) {
  await clickPrivate(button(page, ssoLabel))
  await submitKeycloakLogin(page, app, username)
}

export async function signInWithEmail(page: Page, app: KeycloakFixture, email: string) {
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await button(page, emailLinkLabel).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await openPrivateLink(page, await app.magicLink(email))
  await clickPrivate(button(page, 'Sign in to Hourmere'))
}

async function readFixtureApi(page: Page, url: string) {
  try {
    return await page.request.get(url)
  } catch {
    // Playwright transport errors include the request headers.
    throw new Error('The browser could not read the fixture API')
  }
}

export async function expectSession(
  page: Page,
  app: KeycloakFixture,
  userId: string,
  personal: boolean,
) {
  try {
    await expect
      .poll(() => {
        const url = new URL(page.url())
        return url.origin === app.url && url.pathname === returnPath
      })
      .toBe(true)
  } catch {
    throw new Error(
      `The browser did not return to Hourmere: ${await describeStrandedPage(page, app)}`,
    )
  }
  await expect(accountMenuButton(page)).toBeVisible()
  const response = await readFixtureApi(page, `${app.url}/api/v1/me`)
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({
    user: { id: userId },
    principal: { kind: 'session' },
    organization: personal ? { personal } : { id: app.teamId, personal },
  })
}

export async function expectSignedOut(page: Page, app: KeycloakFixture) {
  expect((await readFixtureApi(page, `${app.url}/api/v1/me`)).status()).toBe(401)
}

export async function signOut(page: Page, app: KeycloakFixture) {
  await accountMenuButton(page).click()
  await accountMenuPanel(page).getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(button(page, emailLinkLabel)).toBeVisible()
  await expectSignedOut(page, app)
}

export async function proveMailbox(page: Page, app: KeycloakFixture, email: string) {
  await button(page, mailboxSendLabel).click()
  const field = page.getByLabel('Email verification link', { exact: true })
  await expect(field).toBeEnabled()
  const link = await app.mailboxLink(email)
  await fillPrivate(field, link.href)
  await clickPrivate(button(page, 'Verify email link'))
  await expect(page.getByText('Email verification complete.', { exact: true })).toBeVisible()
  return new URLSearchParams(link.hash.slice(1)).get('attempt')
}

export async function openMemberSettings(page: Page, app: KeycloakFixture) {
  await page.goto(`${app.url}/sign-in`)
  await signInWithEmail(page, app, app.idp.linkable.email)
  await expectSession(page, app, app.linkableUserId, true)
  const space = page.getByRole('button', { name: /^Switch space/ })
  await space.click()
  await page.getByRole('menuitemradio', { name: app.teamName, exact: true }).click()
  await expect(space).toContainText(app.teamName)
  await page.goto(`${app.url}/app/settings`)
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  const instance = await readFixtureApi(page, `${app.url}/api/v1/instance`)
  expect(instance.status()).toBe(200)
  return instance.json()
}

export async function startMemberLink(page: Page, app: KeycloakFixture, email: string) {
  await button(page, 'Link account (Fixture Keycloak)').click()
  await button(page, 'Link account').click()
  const authorize = page.getByRole('link', { name: 'Continue to identity provider', exact: true })
  await expect(button(page, 'Continue')).toBeDisabled()
  await expect(authorize).toHaveCount(0)
  await proveMailbox(page, app, email)
  await button(page, 'Continue').click()
  await clickPrivate(authorize)
}

export async function mailboxPromptText(page: Page) {
  return ((await page.getByRole('main').textContent()) ?? '').replace(/\s+/g, ' ').trim()
}

export async function acceptFixtureInvitation(
  page: Page,
  app: KeycloakFixture,
  attemptId: string | null,
) {
  if (!attemptId) throw new Error('The fixture mailbox link had no admission attempt')
  // Submit explicit acceptance from the same browser that holds the mailbox proof.
  return page.evaluate(
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
}

export async function expectMailboxCannotEnterTeam(page: Page, app: KeycloakFixture) {
  await signInWithEmail(page, app, app.idp.linked.email)
  await expectSession(page, app, app.linkedUserId, true)
  const response = await page.request.post(`${app.url}/api/auth/organization/set-active`, {
    headers: { origin: app.url },
    data: { organizationId: app.teamId },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(403)
  expect(response.headers().location).toBeUndefined()
  expect(await response.json()).toMatchObject({ code: 'SSO_REQUIRED', message: 'sso_required' })
  await expectSession(page, app, app.linkedUserId, true)
}
