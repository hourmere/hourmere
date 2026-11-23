import { setTimeout as delay } from 'node:timers/promises'
import {
  button,
  clickPrivate,
  emailLinkLabel,
  expectMailboxCannotEnterTeam,
  expectSession,
  expectSignedOut,
  signInAtKeycloak,
  signInUrl,
  signOut,
  ssoLabel,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, test } from '../keycloak/fixture.ts'

test.use({ enforced: true })

test.describe('Keycloak signing keys', () => {
  test.use({ keyRotation: true })

  test('an enforced team accepts a new Keycloak signing key after a JWKS refresh', async ({
    page,
    context,
    keycloak: app,
  }) => {
    await page.goto(signInUrl(app))
    await signInAtKeycloak(page, app)
    await expectSession(page, app, app.linkedUserId, false)
    const [initialKey] = app.signingKeyIds()
    expect(app.signingKeyIds()).toHaveLength(1)
    expect(app.jwksRequests()).toBe(1)

    // The verifier rate-limits JWKS refreshes for 30 seconds, even for an unknown kid.
    // Advance the sign-in to Keycloak's form while the real cooldown elapses.
    const cooldown = delay(30_000)
    await app.idp.rotateSigningKey()
    await signOut(page, app)
    await context.clearCookies()
    await page.goto(signInUrl(app))
    await clickPrivate(button(page, ssoLabel))
    await expect(page.locator('input[name="username"]')).toBeVisible()
    await cooldown
    await submitKeycloakLogin(page, app, app.idp.linked.username)
    await expectSession(page, app, app.linkedUserId, false)
    expect(app.tokenExchanges()).toEqual(['issued', 'issued'])
    const [, rotatedKey] = app.signingKeyIds()
    expect(rotatedKey !== undefined && rotatedKey !== initialKey).toBe(true)
    expect(app.jwksRequests()).toBe(2)
  })
})

test('a Keycloak outage blocks new SSO access without admitting a mailbox session', async ({
  page,
  keycloak: app,
}) => {
  await page.goto(signInUrl(app))
  await signInAtKeycloak(page, app)
  await expectSession(page, app, app.linkedUserId, false)
  await app.idp.stop()
  // The issued team proof remains usable through the upstream outage.
  const live = await page.request.get(`${app.url}/api/v1/event-types`)
  expect(live.status()).toBe(200)
  await signOut(page, app)

  await page.goto(signInUrl(app))
  await clickPrivate(button(page, ssoLabel))
  await expect(page.getByRole('alert')).toHaveText(
    'Single sign-on is unavailable. Try again or use another sign-in method.',
  )
  await expectSignedOut(page, app)
  await expectMailboxCannotEnterTeam(page, app)
  expect(app.tokenExchanges()).toEqual(['issued'])
})

test.describe('without OIDC injection', () => {
  test.use({ oidcEnabled: false })

  test('the seeded team still enforces SSO when sign-in is hard-off', async ({
    page,
    keycloak: app,
  }) => {
    await page.goto(signInUrl(app))
    await expect(button(page, emailLinkLabel)).toBeVisible()
    await expect(button(page, 'Continue with Google')).toBeVisible()
    await expect(button(page, ssoLabel)).toHaveCount(0)
    const instance = await page.request.get(`${app.url}/api/v1/instance`)
    expect(instance.status()).toBe(200)
    expect(await instance.json()).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: false })
    await expectMailboxCannotEnterTeam(page, app)
    expect(app.tokenExchanges()).toEqual([])
  })
})
