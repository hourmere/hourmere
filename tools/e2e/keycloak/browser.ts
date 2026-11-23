import type { Locator, Page } from '@playwright/test'
import { expect, type KeycloakFixture } from './fixture.ts'

export const returnPath = '/app/event-types'
export const ssoLabel = 'Sign in with single sign-on'
export const emailLinkLabel = 'Email me a sign-in link'
export const mailboxSendLabel = 'Send verification email'

export function button(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true })
}

export function signInUrl(app: KeycloakFixture) {
  const url = new URL('/sign-in', app.url)
  url.search = new URLSearchParams({ sso: app.providerId, next: returnPath }).toString()
  return url.href
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

/** Say where a sign-in stopped without printing query strings, cookies or form values. */
async function describeStrandedPage(page: Page, app: KeycloakFixture) {
  const url = new URL(page.url())
  const site = url.origin === app.url ? 'Hourmere' : 'the identity provider'
  const feedback = await page
    .locator('#input-error, #kc-error-message, .pf-m-error, [role="alert"]')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null)
  const form = await page
    .locator('input[name="password"]')
    .isVisible()
    .catch(() => false)
  const heading = await page
    .locator('h1, #kc-page-title')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null)
  const clip = (text: string | null) =>
    text ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : 'none'
  return `${site} ${url.pathname}; heading: ${clip(heading)}; feedback: ${clip(feedback)}; password field: ${form}`
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
  await expect(button(page, 'Sign out')).toBeVisible()
  const response = await page.request.get(`${app.url}/api/v1/me`)
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({
    user: { id: userId },
    principal: { kind: 'session' },
    organization: personal ? { personal } : { id: app.teamId, personal },
  })
}

export async function expectSignedOut(page: Page, app: KeycloakFixture) {
  expect((await page.request.get(`${app.url}/api/v1/me`)).status()).toBe(401)
}

export async function signOut(page: Page, app: KeycloakFixture) {
  await button(page, 'Sign out').click()
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
