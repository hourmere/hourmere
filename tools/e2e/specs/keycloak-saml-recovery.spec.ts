import type { Page } from '@playwright/test'
import {
  completeSamlCeremony,
  openPrivateLink,
  samlClient,
  signInThroughSaml,
  signOut,
  submitKeycloakLogin,
} from '../keycloak/browser.ts'
import { expect, type KeycloakFixture, test } from '../keycloak/fixture.ts'
import {
  expectTeamDataDenied,
  openMailboxSession,
  openRecoveryPage,
  recoverByEmail,
  seedRecoveryOwner,
} from '../keycloak/recovery.ts'

test.use({
  protocol: 'saml',
  enforced: true,
  brokenProvider: true,
})

async function recover(page: Page, app: KeycloakFixture) {
  await openRecoveryPage(page, app)
  await recoverByEmail(page, app)
}

async function repairRequest(
  page: Page,
  app: KeycloakFixture,
  action: 'update' | 'test' | 'activation',
  body: { expectedRevision: number; enabled?: boolean; saml?: { signingCertificates: string[] } },
) {
  // The recovery page collects mailbox proof. Its repair controls only render OIDC providers.
  // Send the SAML repair requests from the same browser, preserving session and binding cookies.
  const providerPath = `/api/v1/team/sso/providers/${app.providerId}`
  return page.evaluate(
    async ({ path, method, teamId, body }) => {
      const response = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Expected-Organization-Id': teamId,
        },
        body: JSON.stringify(body),
      })
      const { error, provider, url } = await response.json().catch(() => ({}))
      return {
        status: response.status,
        error,
        provider: provider && {
          id: provider.id,
          protocol: provider.protocol,
          enabled: provider.enabled,
          revision: provider.revision,
          testStatus: provider.testStatus,
        },
        url: typeof url === 'string' ? url : undefined,
      }
    },
    {
      path: action === 'update' ? providerPath : `${providerPath}/${action}`,
      method: action === 'update' ? 'PATCH' : 'POST',
      teamId: app.teamId,
      body,
    },
  )
}

function expectRepairDenied({ status, error }: Awaited<ReturnType<typeof repairRequest>>) {
  expect(status).toBe(403)
  expect(error).toBe('team_management_access_denied')
}

test('break-glass repairs the SAML pin and spends a new mailbox grant on each write', async ({
  page,
  context,
  keycloak: app,
}) => {
  const client = samlClient(app)
  await client.setSignAssertions(true)
  await seedRecoveryOwner(app)
  await openMailboxSession(page, app)
  await expectTeamDataDenied(page, app)

  const update = { expectedRevision: 1, saml: { signingCertificates: client.signingCertificates } }
  const testInput = { expectedRevision: 2 }
  const activation = { ...testInput, enabled: true }
  expectRepairDenied(await repairRequest(page, app, 'update', update))

  await recover(page, app)
  await expectTeamDataDenied(page, app)
  const updated = await repairRequest(page, app, 'update', update)
  expect(updated.status).toBe(200)
  const repaired = { id: app.providerId, protocol: 'saml', revision: 2 }
  expect(updated.provider).toEqual({ ...repaired, enabled: false, testStatus: 'unknown' })
  expectRepairDenied(await repairRequest(page, app, 'test', testInput))

  await recover(page, app)
  const untested = await repairRequest(page, app, 'activation', activation)
  expect(untested.status).toBe(409)
  expect(untested.error).toBe('sso_test_required')
  const started = await repairRequest(page, app, 'test', testInput)
  expect(started.status).toBe(200)
  const authorization = started.url && URL.parse(started.url)
  const endpoint = new URL(client.ssoEndpoint)
  if (
    !authorization ||
    authorization.origin !== endpoint.origin ||
    authorization.pathname !== endpoint.pathname
  )
    throw new Error('The SAML provider test did not authorize at the owned Keycloak endpoint')
  await openPrivateLink(page, authorization)
  await submitKeycloakLogin(page, app, app.idp.linked.username)
  const completed = await completeSamlCeremony(page, app)
  expect(completed.status()).toBe(303)
  expect((await completed.headerValue('location')) === '/app/settings').toBe(true)
  await expectTeamDataDenied(page, app)
  expectRepairDenied(await repairRequest(page, app, 'activation', activation))

  await recover(page, app)
  const activated = await repairRequest(page, app, 'activation', activation)
  expect(activated.status).toBe(200)
  expect(activated.provider).toEqual({ ...repaired, enabled: true, testStatus: 'passed' })
  expectRepairDenied(await repairRequest(page, app, 'activation', activation))
  await expectTeamDataDenied(page, app)
  const uses = await app.db
    .selectFrom('audit_events')
    .select('id')
    .where('organization_id', '=', app.teamId)
    .where('action', '=', 'sso_recovery.used')
    .execute()
  expect(uses).toHaveLength(3)

  await signOut(page, app)
  await context.clearCookies()
  await signInThroughSaml(page, app)
})
