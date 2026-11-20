import type { Page, Route } from '@playwright/test'
import type { components, operations } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const ssoSetupAuditPages = [
  { id: 'sso-providers', title: 'Team identity providers' },
  { id: 'sso-providers-empty', title: 'Empty identity provider list' },
  { id: 'sso-provider-create', title: 'Create an OIDC provider' },
  { id: 'sso-provider-replace-secret', title: 'Edit a provider and replace its secret' },
  { id: 'sso-provider-retire', title: 'Confirm retiring an identity provider' },
  { id: 'sso-domains', title: 'Team DNS verification' },
  { id: 'sso-domain-challenge', title: 'One-time DNS TXT record' },
  { id: 'sso-domain-retire', title: 'Confirm retiring a domain' },
  { id: 'sso-setup-loading', title: 'Loading SSO settings' },
  { id: 'sso-setup-forbidden', title: 'SSO settings without permission' },
  { id: 'sso-setup-error', title: 'SSO settings load error' },
  { id: 'sso-setup-conflict', title: 'SSO settings revision conflict' },
] as const

export type SsoSetupAuditPageId = (typeof ssoSetupAuditPages)[number]['id']

export function isSsoSetupAuditPage(id: string): id is SsoSetupAuditPageId {
  return ssoSetupAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingSsoSetupAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

type Schemas = components['schemas']
type Provider = Schemas['SsoProviderPage']['data'][number]
type Challenge =
  operations['createSsoDomainChallenge']['responses'][201]['content']['application/json']
type Key = keyof typeof english & keyof typeof chinese

const domain: Provider['domains'][number] = {
  id: '72900000-0000-4000-8000-000000000001',
  name: 'international-research-and-cross-organization-scheduling.hourmere.invalid',
  generation: 2,
  status: 'verified',
}
const provider: Provider = {
  id: '72900000-0000-4000-8000-000000000002',
  protocol: 'oidc',
  revision: 4,
  enabled: false,
  displayName: 'SyntheticIdentityProvider'.repeat(4),
  issuer: `https://identity.hourmere.invalid/${'syntheticIssuer'.repeat(6)}`,
  clientId: 'SyntheticSchedulingClient'.repeat(4),
  createdAt: AUDIT_NOW,
  validationStatus: 'unknown',
  testStatus: 'not_tested',
  domains: [domain],
}
const challengeDomain = 'synthetic-cross-organization-domain-verification.hourmere.invalid'
const challenge: Challenge = {
  domain: {
    id: '72900000-0000-4000-8000-000000000003',
    name: challengeDomain,
    generation: 1,
    status: 'pending',
  },
  txtName: `_hourmere-sso.${challengeDomain}`,
  txtValue: 'synthetic-dns-challenge-for-layout-audit-only',
  expiresAt: '2030-01-08T10:00:00.000Z',
}

/** Supply synthetic responses through the browser client while the fixture server stays hard-off. */
async function mockSsoSetupAudit(page: Page, app: FixtureApp, state: SsoSetupAuditPageId) {
  const { teamOrganizationId } = await app.auditState()
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    ssoOidcEnabled: true,
    ssoSamlEnabled: false,
    signIn: { email: true, google: false, microsoft: false },
  }
  const collection = (url: URL) =>
    url.origin === app.url && url.pathname === '/api/v1/team/sso/providers'
  const expectedOrganization = async (route: Route) =>
    (await route.request().headerValue('x-expected-organization-id')) === teamOrganizationId
  const list = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.abort()
    if (!(await expectedOrganization(route)))
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    if (state === 'sso-setup-loading') return
    if (state === 'sso-setup-error') return route.abort()
    if (state === 'sso-setup-forbidden')
      return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
    return route.fulfill({
      json: {
        data: state === 'sso-providers-empty' ? [] : [provider],
        nextCursor: null,
      } satisfies Schemas['SsoProviderPage'],
    })
  }
  const patches = async (route: Route) => {
    if (route.request().method() !== 'PATCH' || state !== 'sso-setup-conflict') return route.abort()
    if (!(await expectedOrganization(route)))
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    return route.fulfill({ status: 409, json: { error: 'sso_configuration_changed' } })
  }
  const challenges = async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST' || state !== 'sso-domain-challenge') return route.abort()
    const body = request.postDataJSON() as { domain?: string }
    if (!(await expectedOrganization(route)) || body.domain !== challengeDomain)
      return route.abort()
    return route.fulfill({ status: 201, headers: { 'cache-control': 'no-store' }, json: challenge })
  }
  const mocks: [string | ((url: URL) => boolean), (route: Route) => Promise<void>][] = [
    [`${app.url}/api/v1/instance`, (route) => route.fulfill({ json: instance })],
    [collection, list],
    [`${app.url}/api/v1/team/sso/providers/${provider.id}`, patches],
    [`${app.url}/api/v1/team/sso/domains`, challenges],
  ]
  for (const [url, handler] of mocks) await page.route(url, handler)
  return {
    collection,
    release: async () => {
      for (const [url, handler] of mocks) await page.unroute(url, handler)
    },
  }
}

export async function openSsoSetupAuditPage(
  page: Page,
  app: FixtureApp,
  state: SsoSetupAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = (key: Key) => (locale === 'zh-CN' ? chinese[key] : english[key])
  const domains = state.startsWith('sso-domain')
  const path = domains ? PATHS.ssoDomains : PATHS.sso
  const { collection, release } = await mockSsoSetupAudit(page, app, state)
  try {
    await Promise.all([
      state === 'sso-setup-loading' &&
        page.waitForRequest((request) => collection(new URL(request.url()))),
      page.goto(app.url + path),
    ])
    const main = page.getByRole('main')
    const heading = (key: Key) => main.getByRole('heading', { name: copy(key), exact: true })
    const button = (name: string) => main.getByRole('button', { name, exact: true })
    const text = (key: Key) => main.getByText(copy(key), { exact: true })
    await heading(domains ? 'SSO domains' : 'Single sign-on').waitFor()
    switch (state) {
      case 'sso-setup-loading':
        await main
          .getByRole('status', { name: copy('Loading SSO settings…'), exact: true })
          .waitFor()
        pending.set(page, release)
        break
      case 'sso-setup-forbidden':
        await text('SSO settings are unavailable in this team.').waitFor()
        break
      case 'sso-setup-error':
        await text('Could not load SSO settings.').waitFor()
        break
      case 'sso-providers-empty':
        await text('No identity providers yet.').waitFor()
        break
      case 'sso-providers':
        await main.getByRole('heading', { name: provider.displayName, exact: true }).waitFor()
        break
      case 'sso-provider-create':
        await button(copy('Add provider')).press('Enter')
        await heading('Add OIDC provider').waitFor()
        break
      case 'sso-provider-replace-secret':
      case 'sso-setup-conflict':
        await button(copy('Edit {name}').replace('{name}', provider.displayName)).press('Enter')
        await heading('Edit provider').waitFor()
        if (state === 'sso-provider-replace-secret') {
          await button(copy('Replace client secret')).press('Enter')
          await main.getByLabel(copy('New client secret'), { exact: true }).waitFor()
        } else {
          await main.getByLabel(copy('Display name'), { exact: true }).fill('Synthetic edit')
          await button(copy('Save changes')).press('Enter')
          await text('These SSO settings changed. Reload before trying again.').waitFor()
          await button(copy('Reload settings')).waitFor()
        }
        break
      case 'sso-provider-retire':
        await button(copy('Retire provider {name}').replace('{name}', provider.displayName)).press(
          'Enter',
        )
        await button(copy('Retire provider')).waitFor()
        break
      case 'sso-domains':
        await main.getByText(domain.name, { exact: true }).waitFor()
        await main.getByLabel(copy('Domain name'), { exact: true }).waitFor()
        break
      case 'sso-domain-challenge':
        await main.getByLabel(copy('Domain name'), { exact: true }).fill(challengeDomain)
        await button(copy('Generate DNS challenge')).press('Enter')
        await heading('DNS TXT record').waitFor()
        await button(copy('Copy TXT value')).waitFor()
        break
      case 'sso-domain-retire':
        await button(copy('Retire domain {domain}').replace('{domain}', domain.name)).press('Enter')
        await main
          .getByRole('group', { name: copy('Retire domain?'), exact: true })
          .getByRole('button', { name: copy('Retire domain'), exact: true })
          .waitFor()
        break
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}
