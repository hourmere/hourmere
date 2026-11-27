import type { Page, Request, Response } from '@playwright/test'
import {
  SAML_COMPLETE_PATH,
  samlServiceProviderUrls,
} from '../../../apps/server/src/sso-saml-state.ts'
import {
  button,
  clickPrivate,
  completeSamlCeremony,
  emailLinkLabel,
  expectSession,
  expectSignedOut,
  returnPath,
  samlClient,
  samlSignInUrl,
  ssoLabel,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

const refusal = { status: 303, location: '/sign-in?error=unable_to_create_session' }

test.use({ protocol: 'saml', oidcEnabled: false })

function callbackFields(request: Request) {
  const fields = new URLSearchParams(request.postData() ?? '')
  if (request.method() !== 'POST' || fields.size !== 2) {
    throw new Error('Keycloak did not submit the SAML POST binding')
  }
  const relayState = fields.get('RelayState')
  const response = fields.get('SAMLResponse')
  if (!relayState || !response) throw new Error('The SAML form is missing a required field')
  return { fields, relayState, response }
}

async function signInAtSamlKeycloak(page: Page, app: KeycloakFixture) {
  await page.goto(samlSignInUrl(app))
  const signOn = new URL(`${app.idp.issuer}/protocol/saml`)
  const [redirect] = await Promise.all([
    page.waitForRequest((request) => {
      const url = new URL(request.url())
      return url.origin === signOn.origin && url.pathname === signOn.pathname
    }),
    clickPrivate(button(page, ssoLabel)),
  ])
  const query = new URL(redirect.url()).searchParams
  const relayState = query.get('RelayState')
  expect(redirect.method()).toBe('GET')
  expect(Boolean(query.get('SAMLRequest'))).toBe(true)
  if (!relayState || !/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(relayState)) {
    throw new Error('The redirect did not contain an opaque RelayState')
  }

  const { acsUrl } = samlServiceProviderUrls(app.url, app.providerId)
  const [acs] = await Promise.all([
    page.waitForResponse((response) => response.url() === acsUrl),
    submitKeycloakLogin(page, app, app.idp.linked.username),
  ])
  const callback = callbackFields(acs.request())
  expect(callback.relayState === relayState, 'Keycloak must return the issued RelayState').toBe(
    true,
  )
  return { acs, fields: callback.fields }
}

async function expectRefusal(page: Page, app: KeycloakFixture, acs: Response) {
  expect(acs.status()).toBe(refusal.status)
  expect((await acs.headerValue('location')) === refusal.location).toBe(true)
  await expect(page.getByRole('alert')).toHaveText('You could not be signed in. Please try again.')
  await expectSignedOut(page, app)
  expect((await app.account(app.idp.linked.email)).sessionCount).toBe(0)
}

async function failures(app: KeycloakFixture, action: string) {
  return app.db
    .selectFrom('audit_events')
    .select('details')
    .where('target_id', '=', app.providerId)
    .where('action', '=', action)
    .execute()
}

async function expectPending(page: Page, app: KeycloakFixture, acs: Response) {
  expect(acs.status()).toBe(303)
  const location = await acs.headerValue('location')
  const target = location && URL.canParse(location, app.url) ? new URL(location, app.url) : null
  expect(
    target !== null &&
      target.origin === app.url &&
      target.pathname === SAML_COMPLETE_PATH &&
      target.searchParams.size === 1 &&
      /^[a-f0-9-]{36}$/.test(target.searchParams.get('attemptId') ?? '') &&
      target.hash === '',
    'ACS must stage only a same-origin completion',
  ).toBe(true)
  await expect(button(page, 'Continue')).toBeVisible()
  await expectSignedOut(page, app)
  expect((await app.account(app.idp.linked.email)).sessionCount).toBe(0)
}

async function completeSignIn(page: Page, app: KeycloakFixture) {
  const completion = await completeSamlCeremony(page, app)
  expect(completion.status()).toBe(303)
  expect((await completion.request().headerValue('origin')) === app.url).toBe(true)
  expect((await completion.headerValue('location')) === returnPath).toBe(true)
  await expectSession(page, app, app.linkedUserId, false)
  expect((await app.account(app.idp.linked.email)).sessionCount).toBe(1)
}

function changeFirstCharacter(value: string) {
  return `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`
}

/** Damage the first signature value in the genuine fixture response without printing XML. */
function tamperSignature(response: string) {
  const xml = Buffer.from(response, 'base64').toString('utf8')
  const tampered = xml.replace(
    /(<(?:[\w.-]+:)?SignatureValue>\s*)([A-Za-z0-9+/])/,
    (_match, prefix, first) => `${prefix}${changeFirstCharacter(first)}`,
  )
  if (tampered === xml) throw new Error('Keycloak did not return a SAML signature')
  return Buffer.from(tampered).toString('base64')
}

test.describe('with SAML injected into the fixture', () => {
  test.use({ samlEnabled: true })

  test('Keycloak document-only signing is refused while signed assertions allow SAML completion', async ({
    page,
    context,
    keycloak: app,
  }) => {
    const client = samlClient(app)
    expect(await client.signingSettings()).toEqual({ signDocuments: true, signAssertions: false })
    const documentSigned = await signInAtSamlKeycloak(page, app)
    await expectRefusal(page, app, documentSigned.acs)
    expect(await failures(app, 'sso_authentication.failed')).toEqual([
      { details: expect.objectContaining({ method: 'saml', reason: 'signature_invalid' }) },
    ])

    await client.setSignAssertions(true)
    expect(await client.signingSettings()).toEqual({ signDocuments: true, signAssertions: true })
    await context.clearCookies()
    const assertionSigned = await signInAtSamlKeycloak(page, app)
    await expectPending(page, app, assertionSigned.acs)
    await completeSignIn(page, app)
  })

  test('another Hourmere process refuses a changed RelayState, a damaged signature, and a duplicate ACS delivery', async ({
    page,
    keycloak: app,
  }) => {
    await samlClient(app).setSignAssertions(true)
    const { acsUrl } = samlServiceProviderUrls(app.url, app.providerId)
    const results: Awaited<ReturnType<KeycloakFixture['postSamlToPeer']>>[] = []
    await page.route(
      (url) => url.href === acsUrl,
      async (route) => {
        try {
          const { fields, relayState, response } = callbackFields(route.request())
          const separator = relayState.indexOf('.') + 1
          const wrongRelay = new URLSearchParams(fields)
          wrongRelay.set(
            'RelayState',
            relayState.slice(0, separator) + changeFirstCharacter(relayState.slice(separator)),
          )
          results.push(await app.postSamlToPeer(wrongRelay))
          const wrongSignature = new URLSearchParams(fields)
          wrongSignature.set('SAMLResponse', tamperSignature(response))
          results.push(await app.postSamlToPeer(wrongSignature))
        } finally {
          // Keycloak's unmodified browser POST still reaches the original in-process server.
          await route.continue()
        }
      },
      { times: 1 },
    )

    const signed = await signInAtSamlKeycloak(page, app)
    expect(results).toHaveLength(2)
    for (const { status, location } of results) {
      expect(status).toBe(refusal.status)
      expect(location === refusal.location).toBe(true)
    }
    expect(await failures(app, 'sso_authentication.failed')).toEqual([
      { details: expect.objectContaining({ method: 'saml', reason: 'signature_invalid' }) },
    ])
    await expectPending(page, app, signed.acs)
    const replay = await app.postSamlToPeer(signed.fields)
    expect(replay.status).toBe(refusal.status)
    expect(replay.location === refusal.location).toBe(true)
    expect(await failures(app, 'sso_authentication.replay_rejected')).toEqual([
      { details: expect.objectContaining({ method: 'saml' }) },
    ])
    await completeSignIn(page, app)
  })
})

test('without injection the same fixture offers no SAML sign-in', async ({
  page,
  keycloak: app,
}) => {
  const [instance] = await Promise.all([
    page.waitForResponse((response) => response.url() === `${app.url}/api/v1/instance`),
    page.goto(samlSignInUrl(app)),
  ])
  expect(instance.status()).toBe(200)
  expect(await instance.json()).toMatchObject({ ssoOidcEnabled: false, ssoSamlEnabled: false })
  await expect(button(page, emailLinkLabel)).toBeVisible()
  await expect(button(page, ssoLabel)).toHaveCount(0)
  const start = await page.request.post(`${app.url}/api/auth/sign-in/sso`, {
    headers: { origin: app.url },
    data: { providerId: app.providerId, intent: 'sign_in', returnTo: returnPath },
  })
  expect(start.status()).toBe(404)
  expect(await start.json()).toMatchObject({ error: 'sso_disabled' })
})
