import type { Page } from '@playwright/test'
import {
  clickPrivate,
  expectSession,
  isAuthorization,
  signInAtKeycloak,
  signInUrl,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { exerciseTeamDelegation, expectEnforcedTeamAccess } from '../keycloak/enforcement.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'

async function signInThroughOidc(page: Page, app: KeycloakFixture) {
  await page.goto(signInUrl(app))
  await signInAtKeycloak(page, app)
  await expectSession(page, app, app.linkedUserId, false)
}

test.describe('an enforced Keycloak team', () => {
  test.use({ enforced: true })

  test('refuses a mailbox session at the team boundary and admits the same owner through OIDC', async ({
    page,
    keycloak: app,
  }) => {
    await expectEnforcedTeamAccess(page, app, signInUrl(app), signInThroughOidc)
  })

  test('binds a CLI and MCP lease only after fresh Keycloak login and revokes it for both transports', async ({
    page,
    context,
    keycloak: app,
  }) => {
    await exerciseTeamDelegation(page, app, signInThroughOidc, async () => {
      expect(app.tokenExchanges()).toEqual(['issued'])
      // The same BrowserContext already holds a Keycloak session from the first sign-in.
      const [identityProvider, request] = await Promise.all([
        context.waitForEvent('page'),
        context.waitForEvent('request', {
          predicate: (request) => isAuthorization(new URL(request.url()), app),
        }),
        clickPrivate(page.getByRole('link', { name: /^Open identity provider/ })),
      ])
      const parameters = new URL(request.url()).searchParams
      expect(parameters.getAll('prompt')).toEqual(['login'])
      expect(parameters.getAll('max_age')).toEqual(['0'])
      try {
        await submitKeycloakLogin(identityProvider, app, app.idp.linked.username)
        await expect(
          identityProvider.getByRole('heading', { name: 'Account', exact: true }),
        ).toBeVisible()
      } finally {
        await identityProvider.close()
      }
    })
    expect(app.tokenExchanges()).toEqual(['issued', 'issued'])
  })
})
