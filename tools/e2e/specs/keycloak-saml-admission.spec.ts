import type { Page } from '@playwright/test'
import {
  SAML_COMPLETE_PATH,
  samlServiceProviderUrls,
} from '../../../apps/server/src/sso-saml-state.ts'
import {
  acceptFixtureInvitation,
  button,
  completeSamlCeremony,
  expectSession,
  expectSignedOut,
  genericOutcome,
  mailboxPromptText,
  mailboxProofPath,
  mailboxSendLabel,
  noAccount,
  proveMailbox,
  returnPath,
  samlClient,
  samlSignInUrl,
  signInAtKeycloak,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

test.use({ protocol: 'saml' })

async function beginAdmission(page: Page, app: KeycloakFixture, username: string) {
  await page.goto(samlSignInUrl(app))
  const { acsUrl } = samlServiceProviderUrls(app.url, app.providerId)
  const [acs] = await Promise.all([
    page.waitForResponse((response) => response.url() === acsUrl),
    signInAtKeycloak(page, app, username),
  ])
  expect(acs.request().method()).toBe('POST')
  expect(acs.status()).toBe(303)
  const location = await acs.headerValue('location')
  const target = location && URL.canParse(location, app.url) ? new URL(location, app.url) : null
  const fragment = new URLSearchParams(target?.hash.slice(1))
  const attemptId = fragment.get('attempt')
  if (
    target?.origin !== app.url ||
    target.pathname !== mailboxProofPath ||
    target.search !== '' ||
    fragment.size !== 2 ||
    fragment.get('saml') !== '1' ||
    !attemptId ||
    !/^[a-f0-9-]{36}$/.test(attemptId)
  ) {
    throw new Error('The ACS did not stage a same-origin SAML mailbox verification')
  }
  await expect(page.getByRole('heading', { name: 'Verify your email', exact: true })).toBeVisible()
  await expect(button(page, mailboxSendLabel)).toBeEnabled()
  await expect(button(page, 'Continue')).toHaveCount(0)
  await expectSignedOut(page, app)
  return attemptId
}

async function continueWithoutAdmission(page: Page, app: KeycloakFixture, status: number) {
  const completion = await completeSamlCeremony(page, app)
  expect(completion.status()).toBe(status)
  expect((await completion.request().headerValue('origin')) === app.url).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: genericOutcome })).toHaveText(
    genericOutcome,
  )
  await expectSignedOut(page, app)
}

async function admittedUser(app: KeycloakFixture, email: string, subject: string) {
  const account = await app.account(email)
  expect(account).toMatchObject({
    teamRole: 'member',
    linkedSubjects: [subject],
    sessionCount: 1,
    personalSpace: true,
  })
  if (!account.userId) throw new Error('SAML admission did not create a fixture account')
  return account.userId
}

test.describe('with the default SAML setting', () => {
  test.beforeEach(async ({ keycloak: app }) => {
    await samlClient(app).setSignAssertions(true)
  })

  test('unlinked SAML subjects see the same outcome whether their mailbox has an account', async ({
    page,
    context,
    keycloak: app,
  }) => {
    const { sameEmail, unverified } = app.idp
    const existing = await app.account(sameEmail.email)
    expect(existing).toMatchObject({
      userId: app.linkedUserId,
      linkedSubjects: [app.idp.linked.subject],
      sessionCount: 0,
    })

    await beginAdmission(page, app, sameEmail.username)
    const prompt = await mailboxPromptText(page)
    expect(prompt.includes(sameEmail.email), 'The prompt must omit the mailbox').toBe(false)
    await proveMailbox(page, app, sameEmail.email)
    await continueWithoutAdmission(page, app, 200)
    expect(await app.account(sameEmail.email)).toEqual(existing)

    await context.clearCookies()
    await beginAdmission(page, app, unverified.username)
    expect((await mailboxPromptText(page)) === prompt, 'The mailbox prompts must match').toBe(true)
    await proveMailbox(page, app, unverified.email)
    await continueWithoutAdmission(page, app, 409)
    expect(await app.account(unverified.email)).toEqual(noAccount)
  })

  test('an invited SAML subject explicitly accepts on closed signup after mailbox proof', async ({
    page,
    keycloak: app,
  }) => {
    const { email, subject, username } = app.idp.invited
    const attemptId = await beginAdmission(page, app, username)
    expect(await app.account(email)).toEqual(noAccount)
    await proveMailbox(page, app, email)

    await continueWithoutAdmission(page, app, 409)
    expect(await app.invitationStatus()).toBe('pending')
    expect(await app.account(email)).toEqual(noAccount)

    expect(await acceptFixtureInvitation(page, app, attemptId)).toBe(200)
    expect(await app.invitationStatus()).toBe('accepted')
    const userId = await admittedUser(app, email, subject)
    await page.goto(`${app.url}${returnPath}`)
    await expectSession(page, app, userId, false)
  })

  test.describe('JIT team admission', () => {
    test.use({ admission: 'jit' })

    test.describe('open signup', () => {
      test.use({ signupMode: 'open' })

      test('a new SAML subject joins as a member after Hourmere mailbox proof', async ({
        page,
        keycloak: app,
      }) => {
        const { email, subject, username } = app.idp.unverified
        const attemptId = await beginAdmission(page, app, username)
        const premature = await page.evaluate(
          async ({ path, attemptId }) => {
            const response = await fetch(path, {
              method: 'POST',
              body: new URLSearchParams({ attemptId }),
              redirect: 'manual',
            })
            return response.status
          },
          { path: SAML_COMPLETE_PATH, attemptId },
        )
        expect(premature).toBe(400)
        expect(await app.account(email)).toEqual(noAccount)
        await proveMailbox(page, app, email)
        expect(await app.account(email)).toEqual(noAccount)

        const completion = await completeSamlCeremony(page, app)
        expect(completion.status()).toBe(303)
        expect((await completion.headerValue('location')) === returnPath).toBe(true)
        const userId = await admittedUser(app, email, subject)
        await expectSession(page, app, userId, false)
      })
    })

    test('closed signup refuses a proved SAML mailbox without a current invitation', async ({
      page,
      keycloak: app,
    }) => {
      const { email, username } = app.idp.unverified
      await beginAdmission(page, app, username)
      await proveMailbox(page, app, email)
      await continueWithoutAdmission(page, app, 403)
      expect(await app.account(email)).toEqual(noAccount)
    })
  })
})

const testWithSamlOff = test.extend({ oidcEnabled: false, samlEnabled: false })

testWithSamlOff(
  'with the SAML setting off the seeded fixture offers no admission entry',
  async ({ page, keycloak: app }) => {
    await page.goto(`${app.url}${mailboxProofPath}#attempt=${app.providerId}&saml=1`)
    await expect(page.getByRole('status')).toHaveText('Identity verification is unavailable.')
    await expect(button(page, mailboxSendLabel)).toHaveCount(0)
    await expect(button(page, 'Continue')).toHaveCount(0)
    const complete = await page.request.post(`${app.url}${SAML_COMPLETE_PATH}`, {
      headers: { origin: app.url },
      form: { attemptId: app.providerId },
    })
    expect(complete.status()).toBe(404)
    expect((await complete.json()).error === 'sso_disabled').toBe(true)
    await expectSignedOut(page, app)
  },
)
