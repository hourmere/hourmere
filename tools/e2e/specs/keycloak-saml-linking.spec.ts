import {
  SAML_COMPLETE_PATH,
  samlServiceProviderUrls,
} from '../../../apps/server/src/sso-saml-state.ts'
import {
  button,
  completeSamlCeremony,
  expectSession,
  expectSignedOut,
  openMemberSettings,
  samlClient,
  samlSignInUrl,
  signInAtKeycloak,
  signOut,
  startMemberLink,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, test } from '../keycloak/fixture.ts'

test.use({ protocol: 'saml', oidcEnabled: false })

test.describe('with SAML injected into the fixture', () => {
  test.use({ samlEnabled: true })

  test('a team member proves their Hourmere mailbox and consents to a Keycloak SAML link', async ({
    page,
    context,
    keycloak: app,
  }) => {
    await samlClient(app).setSignAssertions(true)
    const { email, subject, username } = app.idp.linkable
    const capabilities = await openMemberSettings(page, app)
    expect(capabilities).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: true })
    const before = await app.account(email)
    expect(before).toMatchObject({
      userId: app.linkableUserId,
      teamRole: 'member',
      linkedSubjects: [],
      sessionCount: 1,
      personalSpace: true,
    })

    await startMemberLink(page, app, email)
    const { acsUrl } = samlServiceProviderUrls(app.url, app.providerId)
    const [acs] = await Promise.all([
      page.waitForResponse((response) => response.url() === acsUrl),
      submitKeycloakLogin(page, app, username),
    ])
    expect(acs.status()).toBe(303)
    await expect(button(page, 'Link account')).toBeVisible()
    const consent = new URL(page.url())
    expect(
      consent.origin === app.url &&
        consent.pathname === SAML_COMPLETE_PATH &&
        consent.searchParams.get('intent') === 'link',
      'The SAML link must wait for same-origin consent',
    ).toBe(true)
    expect(await app.account(email)).toEqual(before)

    const completion = await completeSamlCeremony(page, app, 'Link account')
    expect(completion.status()).toBe(303)
    expect((await completion.headerValue('location')) === '/app/settings').toBe(true)
    await expect(button(page, 'Unlink account (Fixture Keycloak)')).toBeVisible()
    expect(await app.account(email)).toEqual({ ...before, linkedSubjects: [subject] })

    await signOut(page, app)
    await context.clearCookies()
    await page.goto(samlSignInUrl(app))
    await signInAtKeycloak(page, app, username)
    await expect(button(page, 'Continue')).toBeVisible()
    await expectSignedOut(page, app)
    expect((await completeSamlCeremony(page, app)).status()).toBe(303)
    await expectSession(page, app, app.linkableUserId, false)
  })
})

test('without injection the same seeded fixture offers no SAML link entry', async ({
  page,
  keycloak: app,
}) => {
  const capabilities = await openMemberSettings(page, app)
  expect(capabilities).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: false })
  await expect(page.getByRole('heading', { name: 'Your team sign-in' })).toHaveCount(0)
  await expect(button(page, 'Link account (Fixture Keycloak)')).toHaveCount(0)
  const link = await page.evaluate(
    async ({ providerId, teamId }) => {
      const response = await fetch(`/api/v1/team/sso/providers/${providerId}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Expected-Organization-Id': teamId },
        body: '{}',
      })
      return { status: response.status, disabled: (await response.json()).error === 'sso_disabled' }
    },
    { providerId: app.providerId, teamId: app.teamId },
  )
  expect(link).toEqual({ status: 404, disabled: true })
  expect((await app.account(app.idp.linkable.email)).linkedSubjects).toEqual([])
})
