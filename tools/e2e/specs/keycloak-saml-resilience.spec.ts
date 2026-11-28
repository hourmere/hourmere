import type { Page } from '@playwright/test'
import {
  button,
  clickPrivate,
  completeSamlCeremony,
  expectSignedOut,
  fillPrivate,
  proveMailbox,
  readFixtureApi,
  samlClient,
  samlSignInUrl,
  signInAtKeycloak,
  signInThroughSaml,
  signOut,
  submitKeycloakLogin,
  switchToFixtureTeam,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'
import { openMailboxSession, providerName } from '../keycloak/recovery.ts'

const setupPath = '/app/settings/sso'

test.use({ protocol: 'saml' })

async function verifyRotationWrite(page: Page, app: KeycloakFixture) {
  await proveMailbox(page, app, app.idp.linked.email)
  await button(page, 'Continue').click()
}

async function activateProvider(page: Page, app: KeycloakFixture, action: 'Enable' | 'Disable') {
  await button(page, `${action} provider ${providerName}`).click()
  await page
    .getByRole('group', { name: `${action} this provider?`, exact: true })
    .getByRole('button', { name: `${action} provider`, exact: true })
    .click()
  await verifyRotationWrite(page, app)
}

async function replaceCertificates(page: Page, app: KeycloakFixture, certificates: string[]) {
  await button(page, `Edit ${providerName}`).click()
  const form = page.getByRole('form', { name: 'Edit provider' })
  for (const [index, certificate] of certificates.entries()) {
    if (index) await form.getByRole('button', { name: 'Add signing certificate' }).click()
    await fillPrivate(form.getByLabel(`Signing certificate ${index + 1}`), certificate)
  }
  await clickPrivate(form.getByRole('button', { name: 'Save changes' }))
  await verifyRotationWrite(page, app)
}

test.describe('signing-certificate rotation', () => {
  test.use({ keyRotation: true })

  test('a switched Keycloak signer requires an explicitly tested overlapping certificate list', async ({
    page,
    context,
    keycloak: app,
  }) => {
    const client = samlClient(app)
    await client.setSignAssertions(true)
    await signInThroughSaml(page, app)
    await signOut(page, app)
    await context.clearCookies()

    await app.idp.rotateSigningKey()
    const original = client.signingCertificates
    const advertised = await client.readSigningCertificates()
    const added = advertised.filter((certificate) => !original.includes(certificate))
    expect(added.length, 'Keycloak publishes one new signing certificate').toBe(1)

    await page.goto(samlSignInUrl(app))
    await signInAtKeycloak(page, app)
    await expect(page.getByRole('alert')).toHaveText(
      'You could not be signed in. Please try again.',
    )
    await expectSignedOut(page, app)
    const failures = await app.db
      .selectFrom('audit_events')
      .select('details')
      .where('action', '=', 'sso_authentication.failed')
      .where('target_id', '=', app.providerId)
      .execute()
    expect(failures).toMatchObject([{ details: { method: 'saml', reason: 'signature_invalid' } }])
    await context.clearCookies()

    // The team is in optional mode so its owner can work on a disabled provider draft.
    await openMailboxSession(page, app)
    await switchToFixtureTeam(page, app)
    await page.goto(`${app.url}${setupPath}`)
    await activateProvider(page, app, 'Disable')
    await expect(page.getByText('Revision 1 · Disabled', { exact: true })).toBeVisible()

    await replaceCertificates(page, app, [...original, ...added])
    await expect(page.getByText('Revision 2 · Disabled', { exact: true })).toBeVisible()
    await expect(button(page, `Enable provider ${providerName}`)).toBeDisabled()

    await button(page, `Test provider ${providerName}`).click()
    await verifyRotationWrite(page, app)
    await clickPrivate(
      page.getByRole('link', { name: 'Continue to identity provider', exact: true }),
    )
    await submitKeycloakLogin(page, app, app.idp.linked.username)
    const completion = await completeSamlCeremony(page, app)
    expect(completion.status()).toBe(303)
    expect((await completion.headerValue('location')) === '/app/settings').toBe(true)

    await page.goto(`${app.url}${setupPath}`)
    await expect(page.getByText('Current revision passed its test.', { exact: true })).toBeVisible()
    await activateProvider(page, app, 'Enable')
    await expect(page.getByText('Revision 2 · Enabled', { exact: true })).toBeVisible()
    await replaceCertificates(page, app, added)
    await expect(page.getByText('Revision 3 · Enabled', { exact: true })).toBeVisible()
    const rotations = await app.db
      .selectFrom('audit_events')
      .select(['organization_id', 'details'])
      .where('action', '=', 'sso_provider.certificate_rotated')
      .where('target_id', '=', app.providerId)
      .orderBy('id')
      .execute()
    expect(rotations).toMatchObject(
      [2, 3].map((revision) => ({ organization_id: app.teamId, details: { revision } })),
    )

    await signOut(page, app)
    await context.clearCookies()
    await signInThroughSaml(page, app)
  })
})

test.describe('SAML logout and deprovisioning', () => {
  test.use({ enforced: true })

  test('upstream logout and disable preserve an existing Hourmere proof but block new authentication', async ({
    page,
    keycloak: app,
  }) => {
    await samlClient(app).setSignAssertions(true)
    await signInThroughSaml(page, app)

    expect(await app.idp.linkedSessionCount()).toBeGreaterThan(0)
    await app.idp.logoutLinkedUser()
    expect(await app.idp.linkedSessionCount()).toBe(0)
    const team = () => readFixtureApi(page, `${app.url}/api/v1/me`)
    let response = await team()
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ organization: { id: app.teamId } })

    await app.idp.disableLinkedUser()
    response = await team()
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ organization: { id: app.teamId } })
    await signOut(page, app)
    await page.goto(samlSignInUrl(app))
    await signInAtKeycloak(page, app)
    await expect(page.getByText('Account is disabled, contact your administrator.')).toBeVisible()
    await expectSignedOut(page, app)
    expect((await app.account(app.idp.linked.email)).sessionCount).toBe(0)
  })
})
