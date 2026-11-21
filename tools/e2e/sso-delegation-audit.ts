import type { Page, Route } from '@playwright/test'
import type { components, paths } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const ssoDelegationAuditPages = [
  { id: 'sso-delegation-active', title: 'SSO delegation with a visible expiration date' },
  { id: 'sso-delegation-api-key', title: 'API key with an active SSO delegation' },
  { id: 'sso-delegation-revoke', title: 'Confirm revoking SSO delegation' },
  { id: 'sso-delegation-step-up', title: 'Verify team SSO to bind a delegation' },
  { id: 'sso-delegation-forbidden', title: 'SSO delegation without policy access' },
] as const

export type SsoDelegationAuditPageId = (typeof ssoDelegationAuditPages)[number]['id']

export function isSsoDelegationAuditPage(id: string): id is SsoDelegationAuditPageId {
  return ssoDelegationAuditPages.some((entry) => entry.id === id)
}

type Schemas = components['schemas']
type Connections =
  paths['/api/v1/mcp-oauth/connections']['get']['responses'][200]['content']['application/json']
type MessageKey = keyof typeof english & keyof typeof chinese

const provider = {
  id: '72900000-0000-4000-8000-000000000061',
  displayName: 'SyntheticResearchIdentityProvider'.repeat(2),
  revision: 4,
}
const credentialId = '72900000-0000-4000-8000-000000000062'
const expiresAt = '2030-01-12T13:45:00.000Z'
const binding = { id: '72900000-0000-4000-8000-000000000063', expiresAt }
const connection = {
  id: '72900000-0000-4000-8000-000000000064',
  clientId: 'synthetic-audit-mcp-client',
  clientName: 'Synthetic Audit Connection',
  organizationName: 'Synthetic Audit Team',
  createdAt: AUDIT_NOW,
  credentialId,
}
const policy: Schemas['SsoPolicy'] = {
  requireSso: true,
  admission: 'invitation_only',
  policyRevision: 3,
  trustGeneration: 5,
}
const challenge: Schemas['SsoFreshProofChallenge'] = {
  error: 'sso_reauthentication_required',
  attemptId: '72900000-0000-4000-8000-000000000065',
  expiresAt: '2030-01-07T10:10:00.000Z',
  proofMethods: ['sso'],
}

export async function openSsoDelegationAuditPage(
  page: Page,
  app: FixtureApp,
  id: SsoDelegationAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = (key: MessageKey) => (locale === 'zh-CN' ? chinese[key] : english[key])
  const { teamOrganizationId } = await app.auditState()
  const apiKey = id === 'sso-delegation-api-key'
  const bound = apiKey || id === 'sso-delegation-active' || id === 'sso-delegation-revoke'
  const path = apiKey ? PATHS.apiKeys : PATHS.connectedApps
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    ssoOidcEnabled: true,
    ssoSamlEnabled: false,
    signIn: { email: true, google: false, microsoft: false },
  }
  const scoped = (route: Route, method: 'GET' | 'POST') =>
    route.request().method() === method &&
    route.request().headers()['x-expected-organization-id'] === teamOrganizationId
  const mocks: [string, (route: Route) => Promise<void>][] = [
    ['/api/v1/instance', (route) => route.fulfill({ json: instance })],
    [
      '/api/v1/me',
      async (route) => {
        const response = await route.fetch()
        if (!response.ok()) return route.fulfill({ response })
        const caller = (await response.json()) as Schemas['Me']
        if (caller.organization.id !== teamOrganizationId) return route.abort()
        return route.fulfill({
          response,
          json: {
            ...caller,
            sso: {
              requireSso: true,
              providers: [provider],
              links: [
                {
                  id: '72900000-0000-4000-8000-000000000066',
                  providerId: provider.id,
                  generation: 2,
                },
              ],
              attempts: [],
              proofs: [],
            },
          } satisfies Schemas['Me'],
        })
      },
    ],
    [
      '/api/v1/mcp-oauth/connections',
      (route) =>
        route.fulfill({
          json: {
            data: [{ ...connection, ...(bound ? { ssoDelegation: binding } : {}) }],
          } satisfies Connections,
        }),
    ],
    [
      '/api/v1/team/sso/policy',
      (route) => {
        if (!scoped(route, 'GET')) return route.abort()
        if (id === 'sso-delegation-forbidden')
          return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
        return route.fulfill({ json: policy })
      },
    ],
    [
      '/api/v1/team/sso/delegations',
      (route) => {
        if (!scoped(route, 'POST') || id !== 'sso-delegation-step-up') return route.abort()
        const body = route.request().postDataJSON()
        if (
          body.credentialKind !== 'oauth_grant' ||
          body.credentialId !== credentialId ||
          body.expectedTrustGeneration !== policy.trustGeneration ||
          body.proofAttemptId
        )
          return route.abort()
        return route.fulfill({ status: 403, json: challenge })
      },
    ],
  ]
  if (apiKey) {
    const key = {
      id: credentialId,
      name: 'Synthetic audit key',
      start: null,
      enabled: true,
      createdAt: AUDIT_NOW,
      expiresAt: null,
      lastRequest: null,
      metadata: { organizationId: teamOrganizationId, scope: 'read' },
      ssoDelegation: binding,
    }
    mocks.push([
      '/api/auth/api-key/list?sortBy=createdAt&sortDirection=desc',
      (route) => route.fulfill({ json: { apiKeys: [key] } }),
    ])
  }
  for (const [endpoint, handler] of mocks) await page.route(app.url + endpoint, handler)
  try {
    await page.goto(app.url + path)
    const main = page.getByRole('main')
    const button = (key: MessageKey) => main.getByRole('button', { name: copy(key), exact: true })
    await main.getByRole('heading', { name: copy('SSO delegation'), exact: true }).waitFor()
    if (bound) {
      await main.locator(`time[datetime="${expiresAt}"]`).waitFor()
      if (id === 'sso-delegation-revoke') {
        await button('Revoke SSO delegation').press('Enter')
        await main
          .getByRole('group', { name: copy('Revoke this SSO delegation?'), exact: true })
          .getByRole('button', { name: copy('Revoke SSO delegation'), exact: true })
          .waitFor()
      }
    } else {
      await button('Bind SSO delegation').press('Enter')
      if (id === 'sso-delegation-step-up') await button('Start SSO verification').waitFor()
      else
        await main
          .getByText(copy('Could not verify this team’s SSO policy.'), { exact: true })
          .waitFor()
    }
    return path
  } finally {
    for (const [endpoint, handler] of mocks) await page.unroute(app.url + endpoint, handler)
  }
}
