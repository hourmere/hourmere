import { spaceCjkBoundaries } from '@hourmere/core/language'
import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const ssoRecoveryAuditPages = [
  { id: 'sso-recovery-start', title: 'Start SSO recovery' },
  { id: 'sso-recovery-loading', title: 'Loading SSO recovery' },
  { id: 'sso-recovery-forbidden', title: 'SSO recovery without permission' },
  { id: 'sso-recovery-error', title: 'SSO recovery load error' },
  { id: 'sso-recovery-mailbox', title: 'Verify a mailbox for SSO recovery' },
  { id: 'sso-recovery-repair', title: 'Repair SSO identity providers' },
  { id: 'sso-recovery-edit', title: 'Edit a broken SSO provider' },
  { id: 'sso-recovery-test', title: 'Continue a recovery test at the identity provider' },
  { id: 'sso-recovery-nominate', title: 'Confirm a recovery nomination' },
  { id: 'sso-recovery-nominated', title: 'Recovery nomination sent with expiry' },
  { id: 'sso-recovery-accept', title: 'Consent to a recovery nomination' },
  { id: 'sso-recovery-accepted', title: 'Recovery nomination accepted' },
  { id: 'sso-recovery-nomination-unavailable', title: 'Unavailable recovery nomination' },
] as const

export type SsoRecoveryAuditPageId = (typeof ssoRecoveryAuditPages)[number]['id']

export function isSsoRecoveryAuditPage(id: string): id is SsoRecoveryAuditPageId {
  return ssoRecoveryAuditPages.some((entry) => entry.id === id)
}

const activeMocks = new WeakMap<Page, { release: () => Promise<void>; loading: boolean }>()

export async function leaveSsoRecoveryAudit(page: Page, origin: string) {
  const mocks = activeMocks.get(page)
  if (!mocks) return
  if (mocks.loading) await page.goto(`${origin}/favicon.svg`)
  await mocks.release()
  activeMocks.delete(page)
}

type Schemas = components['schemas']
type MessageKey = keyof typeof english & keyof typeof chinese
type RouteMock = [string, (route: Route) => Promise<void>]

const provider = {
  id: '72900000-0000-4000-8000-000000000041',
  protocol: 'oidc',
  revision: 4,
  enabled: true,
  displayName: 'InternationalSchedulingIdentityProvider'.repeat(2),
  issuer: `https://identity.hourmere.invalid/${'syntheticissuer'.repeat(6)}`,
  clientId: 'synthetic-recovery-client',
  createdAt: AUDIT_NOW,
  validationStatus: 'unknown',
  testStatus: 'not_tested',
  domains: [
    {
      id: '72900000-0000-4000-8000-000000000042',
      name: 'international-research-and-cross-organization-scheduling.hourmere.invalid',
      generation: 1,
      status: 'verified',
    },
  ],
} satisfies Schemas['SsoProviderPage']['data'][number]
const enrollmentId = '72900000-0000-4000-8000-000000000043'
const attemptId = '72900000-0000-4000-8000-000000000044'
const nomineeName = 'SyntheticSecondTeamOwnerForRecovery'.repeat(2)
const nomineeId = '72900000-0000-4000-8000-000000000045'
const proofExpires = '2030-01-07T10:10:00.000Z'
const nominationExpires = '2030-01-10T10:00:00.000Z'
const syntheticToken = 'A'.repeat(43)
const policyRevision = 7
const paths = {
  instance: '/api/v1/instance',
  policy: '/api/v1/team/sso/policy',
  providers: '/api/v1/team/sso/providers',
  recovery: '/api/v1/team/sso/recovery',
  sendProof: '/api/auth/sso/mailbox-proof/send',
  consumeProof: '/api/auth/sso/mailbox-proof/consume',
} as const

/** Browser routes supply synthetic responses while the real fixture server stays hard-off. */
async function mockRecovery(page: Page, app: FixtureApp, id: SsoRecoveryAuditPageId) {
  const { teamOrganizationId, userId } = await app.auditState()
  const nomination = id === 'sso-recovery-nominate' || id === 'sso-recovery-nominated'
  const acceptance =
    id === 'sso-recovery-accept' ||
    id === 'sso-recovery-accepted' ||
    id === 'sso-recovery-nomination-unavailable'
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    ssoOidcEnabled: true,
    ssoSamlEnabled: false,
    signIn: { email: true, google: false, microsoft: false },
  }
  const policy: Schemas['SsoPolicy'] = {
    requireSso: !nomination,
    admission: 'invitation_only',
    policyRevision,
    trustGeneration: 2,
  }
  let mailboxProven = false
  let grant = false
  const scoped = (route: Route, method: 'GET' | 'POST') =>
    route.request().method() === method &&
    route.request().headers()['x-expected-organization-id'] === teamOrganizationId
  const challenge = (route: Route) =>
    route.fulfill({
      status: 403,
      json: {
        error: 'sso_reauthentication_required',
        attemptId,
        expiresAt: proofExpires,
        proofMethods: ['mailbox'],
      } satisfies Schemas['SsoFreshProofChallenge'],
    })
  const mocks: RouteMock[] = [
    [paths.instance, (route) => route.fulfill({ json: instance })],
    [
      paths.policy,
      (route) => {
        if (!scoped(route, 'GET')) return route.abort()
        if (id === 'sso-recovery-loading') return Promise.resolve()
        if (id === 'sso-recovery-error')
          return route.fulfill({ status: 500, json: { error: 'internal_error' } })
        if (id === 'sso-recovery-forbidden')
          return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
        return route.fulfill({ json: policy })
      },
    ],
    [
      `${paths.providers}?*`,
      (route) => {
        if (!scoped(route, 'GET')) return route.abort()
        if (!grant) return route.fulfill({ status: 403, json: { error: 'sso_required' } })
        const data =
          id === 'sso-recovery-repair' ? [{ ...provider, testStatus: 'passed' }] : [provider]
        return route.fulfill({
          json: { data, nextCursor: null } satisfies Schemas['SsoProviderPage'],
        })
      },
    ],
    [
      `${paths.recovery}/use`,
      (route) => {
        const body = route.request().postDataJSON()
        if (!scoped(route, 'POST') || body?.expectedRevision !== policyRevision)
          return route.abort()
        if (!body.proofAttemptId) return challenge(route)
        if (body.proofAttemptId !== attemptId || !mailboxProven) return route.abort()
        grant = true
        return route.fulfill({ status: 204 })
      },
    ],
    [
      `${paths.providers}/${provider.id}/test`,
      (route) => {
        if (
          !scoped(route, 'POST') ||
          !grant ||
          route.request().postDataJSON()?.expectedRevision !== provider.revision
        )
          return route.abort()
        grant = false
        return route.fulfill({
          json: { url: 'https://identity.hourmere.invalid/authorize', redirect: true },
        })
      },
    ],
    [
      paths.sendProof,
      (route) => {
        if (!scoped(route, 'POST') || route.request().postDataJSON()?.attemptId !== attemptId)
          return route.abort()
        return route.fulfill({ status: 202, json: { status: 'queued' } })
      },
    ],
    [
      paths.consumeProof,
      (route) => {
        const body = route.request().postDataJSON()
        if (
          !scoped(route, 'POST') ||
          body?.attemptId !== attemptId ||
          body?.token !== syntheticToken
        )
          return route.abort()
        mailboxProven = true
        return route.fulfill({ json: { status: 'proven' } })
      },
    ],
  ]

  if (nomination) {
    const nominee = {
      id: '72900000-0000-4000-8000-000000000046',
      userId: nomineeId,
      organizationId: teamOrganizationId,
      role: 'owner',
      createdAt: AUDIT_NOW,
      user: { id: nomineeId, name: nomineeName, email: 'synthetic-owner@hourmere.invalid' },
    }
    const owner = {
      ...nominee,
      id: '72900000-0000-4000-8000-000000000047',
      userId,
      user: { id: userId, name: 'Synthetic host', email: 'synthetic-host@hourmere.invalid' },
    }
    mocks.push(
      [
        '/api/auth/organization/list-members?*',
        (route) => route.fulfill({ json: { members: [nominee, owner], total: 2 } }),
      ],
      [
        paths.recovery,
        (route) => {
          const body = route.request().postDataJSON()
          if (
            !scoped(route, 'POST') ||
            body?.ownerUserId !== nomineeId ||
            body?.expectedRevision !== policyRevision
          )
            return route.abort()
          if (!body.proofAttemptId) return challenge(route)
          if (body.proofAttemptId !== attemptId || !mailboxProven) return route.abort()
          return route.fulfill({
            status: 201,
            json: {
              enrollmentId,
              expiresAt: nominationExpires,
              policyRevision: policyRevision + 1,
            },
          })
        },
      ],
    )
  }

  if (acceptance)
    mocks.push([
      `${paths.recovery}/${enrollmentId}/accept`,
      (route) => {
        const body = route.request().postDataJSON()
        if (!scoped(route, 'POST') || body?.expectedRevision !== policyRevision)
          return route.abort()
        if (id === 'sso-recovery-nomination-unavailable')
          return route.fulfill({ status: 404, json: { error: 'sso_not_found' } })
        if (!body.proofAttemptId) return challenge(route)
        if (body.proofAttemptId !== attemptId || !mailboxProven) return route.abort()
        return route.fulfill({ status: 204 })
      },
    ])

  for (const [path, handler] of mocks) await page.route(app.url + path, handler)
  return {
    path: nomination || acceptance ? PATHS.settings : PATHS.ssoRecovery,
    fragment: acceptance
      ? new URLSearchParams({
          ssoRecoveryEnrollment: enrollmentId,
          organizationId: teamOrganizationId,
          expectedRevision: String(policyRevision),
        }).toString()
      : null,
    release: async () => {
      for (const [path, handler] of mocks) await page.unroute(app.url + path, handler)
    },
  }
}

export async function openSsoRecoveryAuditPage(
  page: Page,
  app: FixtureApp,
  id: SsoRecoveryAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const { path, fragment, release } = await mockRecovery(page, app, id)
  const copy = (key: MessageKey, name = '') =>
    (locale === 'zh-CN' ? chinese[key] : english[key]).replace(
      '{name}',
      (placeholder, offset: number, template: string) =>
        locale === 'zh-CN'
          ? spaceCjkBoundaries(
              template.slice(0, offset),
              name,
              template.slice(offset + placeholder.length),
            )
          : name,
    )
  const main = page.getByRole('main')
  const heading = (key: MessageKey) => main.getByRole('heading', { name: copy(key), exact: true })
  const button = (key: MessageKey, name = '') =>
    main.getByRole('button', { name: copy(key, name), exact: true })
  const message = (key: MessageKey) => main.getByText(copy(key), { exact: true })
  const proof = async () => {
    await heading('Confirm your identity before changing SSO settings.').waitFor()
    await button('Send verification email').press('Enter')
    return main.getByLabel(copy('Email verification link'), { exact: true })
  }
  const finishProof = async () => {
    const entry = await proof()
    const proofFragment = new URLSearchParams({ attempt: attemptId, token: syntheticToken })
    await entry.fill(`${app.url}${PATHS.mailboxProof}#${proofFragment}`)
    await button('Verify email link').press('Enter')
    await message('Email verification complete.').waitFor()
    await button('Continue').press('Enter')
  }
  try {
    const url = app.url + path
    await Promise.all([
      id === 'sso-recovery-loading' &&
        page.waitForRequest(`${app.url}${paths.policy}`, { timeout: 10_000 }),
      new URL(page.url()).pathname === path ? page.reload() : page.goto(url),
    ])
    if (fragment) await page.evaluate((value) => (window.location.hash = value), fragment)
    if (path === PATHS.ssoRecovery) await heading('SSO recovery').waitFor()
    switch (id) {
      case 'sso-recovery-start':
        await button('Start recovery').waitFor()
        break
      case 'sso-recovery-loading':
        await main
          .getByRole('status', { name: copy('Loading SSO recovery…'), exact: true })
          .waitFor()
        break
      case 'sso-recovery-forbidden':
        await message('SSO recovery is unavailable in this team.').waitFor()
        break
      case 'sso-recovery-error':
        await message('Could not load SSO recovery.').waitFor()
        break
      case 'sso-recovery-mailbox':
        await button('Start recovery').press('Enter')
        await (await proof()).waitFor()
        break
      case 'sso-recovery-repair':
      case 'sso-recovery-edit':
      case 'sso-recovery-test': {
        await button('Start recovery').press('Enter')
        await finishProof()
        await heading('Repair identity providers').waitFor()
        if (id === 'sso-recovery-edit') {
          await button('Edit {name}', provider.displayName).press('Enter')
          await heading('Edit provider').waitFor()
          await button('Replace client secret').press('Enter')
          await main.getByLabel(copy('New client secret'), { exact: true }).waitFor()
        } else if (id === 'sso-recovery-test') {
          await button('Test provider {name}', provider.displayName).press('Enter')
          await main
            .getByRole('link', {
              name: [copy('Continue to identity provider'), copy('(opens in a new tab)')].join(
                locale === 'zh-CN' ? '' : ' ',
              ),
              exact: true,
            })
            .waitFor()
        } else {
          await button('Edit {name}', provider.displayName).waitFor()
          await button('Enable provider {name}', provider.displayName).waitFor()
          await button('Stop requiring SSO').waitFor()
        }
        break
      }
      case 'sso-recovery-nominate':
      case 'sso-recovery-nominated':
        await button('Nominate {name} for SSO recovery', nomineeName).press('Enter')
        await heading('Nominate a recovery owner').waitFor()
        if (id === 'sso-recovery-nominated') {
          await button('Send nomination').press('Enter')
          await finishProof()
          await message('Recovery nomination sent.').waitFor()
        } else await button('Send nomination').waitFor()
        break
      case 'sso-recovery-accept':
        await heading('Accept recovery nomination').waitFor()
        await button('Accept nomination').waitFor()
        break
      case 'sso-recovery-accepted':
        await button('Accept nomination').press('Enter')
        await finishProof()
        await message('You are now a recovery owner for this team.').waitFor()
        break
      case 'sso-recovery-nomination-unavailable':
        await button('Accept nomination').press('Enter')
        await message(
          'This recovery nomination is unavailable. Ask a team owner to send a new one.',
        ).waitFor()
        break
    }
    activeMocks.set(page, { release, loading: id === 'sso-recovery-loading' })
    return path
  } catch (error) {
    if (id === 'sso-recovery-loading') await page.goto(`${app.url}/favicon.svg`)
    await release()
    throw error
  }
}
