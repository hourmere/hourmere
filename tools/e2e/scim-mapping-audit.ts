import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import type { FixtureApp } from './fixtures.ts'

export const scimMappingAuditPages = [
  { id: 'scim-mapping-loading', title: 'Loading SCIM team mappings' },
  { id: 'scim-mapping-unavailable', title: 'SCIM team mappings without permission' },
  { id: 'scim-mapping-load-error', title: 'SCIM team mappings load error' },
  { id: 'scim-mapping-empty', title: 'Empty SCIM team mapping list' },
  { id: 'scim-mapping-list', title: 'Suspended SCIM team mapping' },
  { id: 'scim-mapping-link-form', title: 'Prepare a SCIM link request' },
  { id: 'scim-mapping-shared', title: 'Paste and review a shared SCIM approval request' },
  { id: 'scim-mapping-link-review', title: 'Review a SCIM link request' },
  { id: 'scim-mapping-unlink-review', title: 'Review a SCIM unlink request' },
  { id: 'scim-mapping-mailbox-proof', title: 'Approve a SCIM mapping with mailbox proof' },
  { id: 'scim-mapping-sso-proof', title: 'Approve a SCIM mapping with team SSO' },
  { id: 'scim-mapping-approval', title: 'SCIM mapping owner approval recorded' },
  { id: 'scim-mapping-denial', title: 'SCIM mapping finalization denied' },
  { id: 'scim-mapping-applied', title: 'SCIM mapping operation applied' },
] as const

export type ScimMappingAuditPageId = (typeof scimMappingAuditPages)[number]['id']

export function isScimMappingAuditPage(id: string): id is ScimMappingAuditPageId {
  return scimMappingAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()
const collection = '/api/v1/scim/team-mappings'
const attemptId = '62300000-0000-4000-8000-000000000001'
const childOrganizationId = '62300000-0000-4000-8000-000000000002'
const connectionId = '62300000-0000-4000-8000-000000000003'
const mappingId = '62300000-0000-4000-8000-000000000004'
const providerId = '62300000-0000-4000-8000-000000000005'
const linkId = '62300000-0000-4000-8000-000000000006'
const externalId = 'SyntheticCrossTeamDirectoryGroupSelector'.repeat(5)
type Schemas = components['schemas']
type Key = keyof typeof english & keyof typeof chinese

export async function leavePendingScimMappingAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

async function mockScimMappingAudit(page: Page, app: FixtureApp, state: ScimMappingAuditPageId) {
  const { teamOrganizationId } = await app.auditState()
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    scimResourcesEnabled: true,
    ssoOidcEnabled: state === 'scim-mapping-sso-proof',
    ssoSamlEnabled: false,
    signIn: { email: true, google: false, microsoft: false },
  }
  const mapping: Schemas['ScimTeamMapping'] = {
    id: mappingId,
    parentOrganizationId: teamOrganizationId,
    childOrganizationId,
    connectionId,
    externalId,
    state: 'suspended',
  }
  let applied = false
  const mappings = async (route: Route) => {
    if ((await route.request().headerValue('x-expected-organization-id')) !== teamOrganizationId)
      return route.fulfill({ status: 409, json: { error: 'organization_context_changed' } })
    if (route.request().method() === 'POST') {
      if (state !== 'scim-mapping-applied')
        return route.fulfill({ status: 403, json: { error: 'scim_mapping_access_denied' } })
      applied = true
      return route.fulfill({ status: 201, json: { mappingId, generation: 1 } })
    }
    if (state === 'scim-mapping-loading') return
    if (state === 'scim-mapping-unavailable')
      return route.fulfill({ status: 403, json: { error: 'scim_mapping_access_denied' } })
    if (state === 'scim-mapping-load-error') return route.abort()
    const showMapping =
      applied || state === 'scim-mapping-list' || state === 'scim-mapping-unlink-review'
    return route.fulfill({
      json: {
        mappings: showMapping ? [applied ? { ...mapping, state: 'pending' } : mapping] : [],
        connectionId,
        linkGeneration: 0,
      } satisfies Schemas['ScimTeamMappingList'],
    })
  }
  const approval = async (route: Route) => {
    const input = route.request().postDataJSON() as { intentId: string; proofAttemptId?: string }
    if (state === 'scim-mapping-approval' && input.proofAttemptId === attemptId)
      return route.fulfill({ json: { intentId: input.intentId } })
    return route.fulfill({
      status: 403,
      json: {
        error: 'sso_reauthentication_required',
        attemptId,
        expiresAt: '2030-01-07T10:05:00.000Z',
        proofMethods: [instance.ssoOidcEnabled ? 'sso' : 'mailbox'],
      } satisfies Schemas['SsoFreshProofChallenge'],
    })
  }
  const mocks: [string, (route: Route) => Promise<void>][] = [
    ['/api/v1/instance', (route) => route.fulfill({ json: instance })],
    [collection, mappings],
    [`${collection}/consent`, approval],
    [
      '/api/auth/sso/mailbox-proof/send',
      (route) => route.fulfill({ status: 202, json: { status: 'queued' } }),
    ],
    [
      '/api/auth/sso/mailbox-proof/consume',
      (route) => route.fulfill({ json: { status: 'proven' } }),
    ],
  ]
  if (instance.ssoOidcEnabled) {
    mocks.push(
      [
        '/api/v1/me',
        async (route) => {
          const response = await route.fetch()
          const me = (await response.json()) as Schemas['Me']
          return route.fulfill({
            response,
            json: {
              ...me,
              sso: {
                requireSso: true,
                providers: [{ id: providerId, displayName: 'Synthetic directory', revision: 1 }],
                links: [{ id: linkId, providerId, generation: 1 }],
                attempts: [],
                proofs: [],
              },
            } satisfies Schemas['Me'],
          })
        },
      ],
      [
        '/api/auth/sign-in/sso',
        (route) =>
          route.fulfill({
            json: { url: 'https://identity.hourmere.invalid/example', redirect: true },
          }),
      ],
    )
  }
  for (const [path, handler] of mocks) await page.route(app.url + path, handler)
  return async () => {
    for (const [path, handler] of mocks) await page.unroute(app.url + path, handler)
  }
}

export async function openScimMappingAuditPage(
  page: Page,
  app: FixtureApp,
  state: ScimMappingAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const copy = (key: Key) => (locale === 'zh-CN' ? chinese[key] : english[key])
  const release = await mockScimMappingAudit(page, app, state)
  try {
    await page.goto(app.url + PATHS.settings)
    const panel = page.getByRole('region', { name: copy('SCIM team mappings'), exact: true })
    const button = (key: Key) => panel.getByRole('button', { name: copy(key), exact: true })
    const label = (key: Key) => panel.getByLabel(copy(key), { exact: true })
    const text = (key: Key) => panel.getByText(copy(key), { exact: true })
    const heading = (key: Key) => panel.getByRole('heading', { name: copy(key), exact: true })
    await heading('SCIM team mappings').waitFor()
    switch (state) {
      case 'scim-mapping-loading':
        await panel.getByRole('status', { name: copy('Loading SCIM team mappings…') }).waitFor()
        pending.set(page, release)
        break
      case 'scim-mapping-unavailable':
        await text('SCIM team mappings are unavailable in this team.').waitFor()
        break
      case 'scim-mapping-load-error':
        await text('Could not load SCIM team mappings.').waitFor()
        break
      case 'scim-mapping-empty':
        await text('No SCIM team mappings yet.').waitFor()
        break
      case 'scim-mapping-list':
        await text('Directory authority suspended').waitFor()
        break
      case 'scim-mapping-shared':
        await button('Open shared approval request').press('Enter')
        await label('Shared approval request').waitFor()
        break
      case 'scim-mapping-unlink-review':
        await button('Prepare unlink request').press('Enter')
        await heading('Review SCIM unlink request').waitFor()
        break
      default:
        await button('Prepare link request').press('Enter')
        await label('Child team ID').waitFor()
        if (state === 'scim-mapping-link-form') break
        await label('Child team ID').fill(childOrganizationId)
        await label('Child team link generation').fill('0')
        await label('Group external ID').fill(externalId)
        await button('Review request').press('Enter')
        await heading('Review SCIM link request').waitFor()
        if (state === 'scim-mapping-link-review') break
        if (state === 'scim-mapping-denial' || state === 'scim-mapping-applied') {
          await button('Apply link').press('Enter')
          await text(
            state === 'scim-mapping-applied'
              ? 'SCIM team mapping linked.'
              : 'Could not apply this request. Both owners must approve the same request before their verification expires.',
          ).waitFor()
          break
        }
        await button('Approve for this team').press('Enter')
        await heading('Confirm your identity to approve this SCIM mapping request.').waitFor()
        if (state === 'scim-mapping-sso-proof') {
          await button('Start SSO verification').press('Enter')
          await panel.locator('a[data-private]').waitFor()
          break
        }
        await button('Send verification email').press('Enter')
        await label('Email verification link').waitFor()
        if (state === 'scim-mapping-mailbox-proof') break
        await label('Email verification link').fill(
          `${app.url}${PATHS.mailboxProof}#attempt=${attemptId}&token=${'a'.repeat(43)}`,
        )
        await button('Verify email link').press('Enter')
        await text('Email verification complete.').waitFor()
        await button('Continue').press('Enter')
        await text(
          'Your approval is recorded. Either approving owner can apply the request once both have approved.',
        ).waitFor()
    }
    return PATHS.settings
  } finally {
    if (!pending.has(page)) await release()
  }
}
