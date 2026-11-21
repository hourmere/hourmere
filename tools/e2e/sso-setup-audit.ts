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
  { id: 'sso-provider-enable', title: 'Confirm enabling a tested provider' },
  { id: 'sso-enforcement-recovery-required', title: 'SSO enforcement blocked by recovery' },
  { id: 'sso-proof-mailbox', title: 'Fresh proof with a mailbox verification link' },
  { id: 'sso-proof-step-up', title: 'Fresh proof with an identity provider' },
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
const enabledProvider: Provider = {
  ...provider,
  id: '72900000-0000-4000-8000-000000000004',
  displayName: 'SyntheticLinkedIdentityProvider'.repeat(3),
  enabled: true,
  testStatus: 'passed',
}
const providerStates: Partial<Record<SsoSetupAuditPageId, Provider[]>> = {
  'sso-providers-empty': [],
  'sso-provider-enable': [{ ...provider, testStatus: 'passed' }],
  'sso-enforcement-recovery-required': [enabledProvider],
  'sso-proof-step-up': [provider, enabledProvider],
}
const proofAttemptId = '72900000-0000-4000-8000-000000000005'
const linkId = '72900000-0000-4000-8000-000000000006'
const proofExpires = '2030-01-07T10:10:00.000Z'
const authorizationUrl = 'https://identity.hourmere.invalid/authorize'
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
  const stepUp = state === 'sso-proof-step-up'
  const recoveryRequired = state === 'sso-enforcement-recovery-required'
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
  const contextChanged = (route: Route) =>
    route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
  const policy: Schemas['SsoPolicy'] = {
    requireSso: stepUp,
    admission: 'invitation_only',
    policyRevision: 2,
    trustGeneration: 1,
  }
  const list = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    if (state === 'sso-setup-loading') return
    if (state === 'sso-setup-error') return route.abort()
    if (state === 'sso-setup-forbidden')
      return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
    return route.fulfill({
      json: {
        data: providerStates[state] ?? [provider],
        nextCursor: null,
      } satisfies Schemas['SsoProviderPage'],
    })
  }
  const patches = async (route: Route) => {
    if (route.request().method() !== 'PATCH' || state !== 'sso-setup-conflict') return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
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
  const policies = async (route: Route) => {
    const request = route.request()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    if (request.method() === 'GET') return route.fulfill({ json: policy })
    if (request.method() !== 'PUT' || !recoveryRequired) return route.abort()
    const body =
      request.postDataJSON() as operations['setSsoPolicy']['requestBody']['content']['application/json']
    if (
      !body.requireSso ||
      body.expectedRevision !== policy.policyRevision ||
      body.admission !== policy.admission
    )
      return route.abort()
    return route.fulfill({ status: 409, json: { error: 'sso_recovery_required' } })
  }
  const testProvider = async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST' || (!stepUp && state !== 'sso-proof-mailbox'))
      return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    const body =
      request.postDataJSON() as operations['testSsoProvider']['requestBody']['content']['application/json']
    if (body.expectedRevision !== provider.revision || body.proofAttemptId) return route.abort()
    return route.fulfill({
      status: 403,
      json: {
        error: 'sso_reauthentication_required',
        attemptId: proofAttemptId,
        expiresAt: proofExpires,
        proofMethods: [stepUp ? 'sso' : 'mailbox'],
      } satisfies Schemas['SsoFreshProofChallenge'],
    })
  }
  const me = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.abort()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const caller = (await response.json()) as Schemas['Me']
    if (caller.organization.id !== teamOrganizationId) return contextChanged(route)
    const { id, displayName, revision } = enabledProvider
    return route.fulfill({
      response,
      json: {
        ...caller,
        sso: {
          requireSso: true,
          providers: [{ id, displayName, revision }],
          links: [{ id: linkId, providerId: id, generation: 1 }],
          attempts: [],
          proofs: [],
        },
      } satisfies Schemas['Me'],
    })
  }
  const signIn = async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST' || !stepUp) return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    const { providerId, intent, attemptId } = request.postDataJSON()
    if (providerId !== enabledProvider.id || intent !== 'step_up' || attemptId !== proofAttemptId)
      return route.abort()
    return route.fulfill({ json: { url: authorizationUrl, redirect: true } })
  }
  const sendProof = async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'POST' || state !== 'sso-proof-mailbox') return route.abort()
    if (!(await expectedOrganization(route))) return contextChanged(route)
    if (request.postDataJSON().attemptId !== proofAttemptId) return route.abort()
    return route.fulfill({ status: 202, json: { status: 'queued' } })
  }
  const mocks: [string | ((url: URL) => boolean), (route: Route) => Promise<void>][] = [
    [`${app.url}/api/v1/instance`, (route) => route.fulfill({ json: instance })],
    [collection, list],
    [`${app.url}/api/v1/team/sso/providers/${provider.id}`, patches],
    [`${app.url}/api/v1/team/sso/domains`, challenges],
    [`${app.url}/api/v1/team/sso/policy`, policies],
    [`${app.url}/api/v1/team/sso/providers/${provider.id}/test`, testProvider],
    [`${app.url}/api/auth/sign-in/sso`, signIn],
    [`${app.url}/api/auth/sso/mailbox-proof/send`, sendProof],
  ]
  if (stepUp) mocks.push([`${app.url}/api/v1/me`, me])
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
  const path = domains ? PATHS.ssoDomainSettings : PATHS.sso
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
      case 'sso-provider-enable':
        await button(copy('Enable provider {name}').replace('{name}', provider.displayName)).press(
          'Enter',
        )
        await main
          .getByRole('group', { name: copy('Enable this provider?'), exact: true })
          .getByRole('button', { name: copy('Enable provider'), exact: true })
          .waitFor()
        break
      case 'sso-enforcement-recovery-required':
        await button(copy('Require SSO')).press('Enter')
        await main
          .getByRole('group', { name: copy('Require single sign-on for this team?'), exact: true })
          .getByRole('button', { name: copy('Require SSO'), exact: true })
          .press('Enter')
        await text(
          'A current owner must accept recovery enrollment before you can require SSO.',
        ).waitFor()
        break
      case 'sso-proof-mailbox':
      case 'sso-proof-step-up':
        await button(copy('Test provider {name}').replace('{name}', provider.displayName)).press(
          'Enter',
        )
        await heading('Confirm your identity before changing SSO settings.').waitFor()
        if (state === 'sso-proof-mailbox') {
          await button(copy('Send verification email')).press('Enter')
          await main.getByLabel(copy('Email verification link'), { exact: true }).waitFor()
        } else {
          await button(copy('Start SSO verification')).press('Enter')
          await main
            .getByRole('link', {
              name: [copy('Open identity provider'), copy('(opens in a new tab)')].join(
                locale === 'zh-CN' ? '' : ' ',
              ),
              exact: true,
            })
            .waitFor()
        }
        break
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}
