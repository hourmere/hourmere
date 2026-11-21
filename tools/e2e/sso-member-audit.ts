import { spaceCjkBoundaries } from '@hourmere/core/language'
import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as englishAdmin } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { common as englishPublic } from '../../apps/web/src/i18n/catalogues/en/common.ts'
import { admin as chineseAdmin } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { common as chinesePublic } from '../../apps/web/src/i18n/catalogues/zh-CN/common.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import type { FixtureApp } from './fixtures.ts'

export const ssoMemberAuditPages = [
  { id: 'sso-sign-in', title: 'Sign-in with a team SSO link' },
  { id: 'sso-mailbox-send', title: 'Request verification for SSO sign-in' },
  { id: 'sso-mailbox-link', title: 'Paste the SSO mailbox verification link' },
  { id: 'sso-mailbox-confirm', title: 'Confirm the SSO mailbox verification link' },
  { id: 'sso-mailbox-confirmed', title: 'Email link verification completed' },
  { id: 'sso-mailbox-paste-fallback', title: 'Email link confirmation with paste only' },
  { id: 'sso-mailbox-proven', title: 'Continue after SSO mailbox verification' },
  { id: 'sso-mailbox-outcome', title: 'Generic SSO sign-in outcome' },
  { id: 'sso-mailbox-stale', title: 'Unavailable SSO mailbox verification' },
  { id: 'sso-member-settings', title: 'Team member sign-in settings' },
  { id: 'sso-member-link', title: 'Consent to link a team sign-in method' },
  { id: 'sso-member-unlink', title: 'Consent to remove a team sign-in method' },
  { id: 'sso-member-proof', title: 'Mailbox verification before linking team SSO' },
  { id: 'sso-member-authorization', title: 'Continue to the identity provider' },
  { id: 'sso-member-confirm', title: 'Confirm the team SSO link after authorization' },
  { id: 'sso-member-stale', title: 'Unavailable team SSO link request' },
  { id: 'sso-member-unavailable', title: 'Team member sign-in settings unavailable' },
  { id: 'sso-member-loading', title: 'Reloading team member sign-in settings' },
  { id: 'sso-member-error', title: 'Team member sign-in settings reload error' },
] as const

export type SsoMemberAuditPageId = (typeof ssoMemberAuditPages)[number]['id']

export function isSsoMemberAuditPage(id: string): id is SsoMemberAuditPageId {
  return ssoMemberAuditPages.some((entry) => entry.id === id)
}

export function isSsoMemberSettingsAuditPage(id: SsoMemberAuditPageId) {
  return id.startsWith('sso-member-')
}

const activeMocks = new WeakMap<Page, { release: () => Promise<void>; loading: boolean }>()

export async function leaveSsoMemberAudit(page: Page, origin: string) {
  const mocks = activeMocks.get(page)
  if (!mocks) return
  if (mocks.loading) await page.goto(`${origin}/favicon.svg`)
  await mocks.release()
  activeMocks.delete(page)
}

type Schemas = components['schemas']
type MeSso = Schemas['MeSso']
const englishCopy = { ...englishPublic, ...englishAdmin }
const chineseCopy = { ...chinesePublic, ...chineseAdmin }
type CopyKey = keyof typeof englishCopy & keyof typeof chineseCopy

const linkedProvider = {
  id: '72900000-0000-7000-8000-000000000001',
  displayName: 'SyntheticLinkedIdentityProvider'.repeat(2),
  revision: 4,
} satisfies MeSso['providers'][number]
const provider = {
  id: '72900000-0000-7000-8000-000000000002',
  displayName: 'SyntheticUnlinkedIdentityProvider'.repeat(2),
  revision: 5,
} satisfies MeSso['providers'][number]
const link = {
  id: '72900000-0000-7000-8000-000000000003',
  providerId: linkedProvider.id,
  generation: 3,
} satisfies MeSso['links'][number]
const attemptId = '72900000-0000-7000-8000-000000000004'
const expiresAt = '2030-01-07T10:10:00.000Z'
const authorizationUrl = 'https://identity.hourmere.invalid/authorize'
// Synthetic responses only. The fixture server follows the production hard-off switches.
const syntheticLinkToken = 'A'.repeat(43)

async function mockMemberSso(page: Page, app: FixtureApp, id: SsoMemberAuditPageId) {
  const instance: Schemas['Instance'] = {
    hostedSignupUrl: 'https://hourmere.com',
    publicUrl: app.url,
    ssoOidcEnabled: true,
    ssoSamlEnabled: false,
    signIn: { email: true, google: false, microsoft: false },
  }
  const routes: [string, (route: Route) => Promise<void>][] = [
    ['/api/v1/instance', (route) => route.fulfill({ json: instance })],
  ]
  const teamOrganizationId = isSsoMemberSettingsAuditPage(id)
    ? (await app.auditState()).teamOrganizationId
    : null
  const linkProof = id === 'sso-member-proof' || id === 'sso-member-authorization'
  const denied =
    id === 'sso-member-unavailable' || id === 'sso-member-loading' || id === 'sso-member-error'
  let refuseLink = false
  if (teamOrganizationId) {
    // Read the seeded team session before intercepting /me. A page focus refresh can be
    // cancelled while navigating between audit states, so its route must be handled immediately.
    const response = await page.request.get(`${app.url}/api/v1/me`)
    if (!response.ok()) throw new Error('Could not read the synthetic audit member')
    const me = (await response.json()) as Schemas['Me']
    if (me.organization.id !== teamOrganizationId)
      throw new Error('Synthetic audit member was outside the fixture team')
    const attempts: MeSso['attempts'] =
      id === 'sso-member-confirm'
        ? [
            {
              id: attemptId,
              expiresAt,
              mailboxProven: true,
              phase: 'completion',
              providerId: provider.id,
            },
          ]
        : []
    const member = {
      ...me,
      sso: {
        providers: [provider, linkedProvider],
        links: [link],
        attempts,
        proofs: [],
        requireSso: false,
      },
    } satisfies Schemas['Me']
    routes.push([
      '/api/v1/me',
      async (route) => {
        if (refuseLink && id === 'sso-member-loading') return
        if (refuseLink && id === 'sso-member-error') return route.abort()
        return route.fulfill({ json: member })
      },
    ])
    if (linkProof || denied) {
      routes.push([
        `/api/v1/team/sso/providers/${provider.id}/link`,
        (route) => {
          const request = route.request()
          if (
            request.method() !== 'POST' ||
            request.headers()['x-expected-organization-id'] !== teamOrganizationId
          )
            return route.abort()
          if (denied) {
            refuseLink = true
            return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
          }
          if (
            request.postDataJSON()?.proofAttemptId === attemptId &&
            id === 'sso-member-authorization'
          )
            return route.fulfill({ json: { url: authorizationUrl, redirect: true } })
          return route.fulfill({
            status: 403,
            json: {
              error: 'sso_reauthentication_required',
              attemptId,
              expiresAt,
              proofMethods: ['mailbox'],
            } satisfies Schemas['SsoFreshProofChallenge'],
          })
        },
      ])
    }
  }
  if (linkProof || ['sso-mailbox-link', 'sso-mailbox-proven', 'sso-mailbox-outcome'].includes(id))
    routes.push([
      '/api/auth/sso/mailbox-proof/send',
      (route) => {
        const request = route.request()
        if (
          request.method() !== 'POST' ||
          request.postDataJSON()?.attemptId !== attemptId ||
          (teamOrganizationId &&
            request.headers()['x-expected-organization-id'] !== teamOrganizationId)
        )
          return route.abort()
        return route.fulfill({ status: 202, json: { status: 'queued' } })
      },
    ])
  if (
    id === 'sso-mailbox-confirmed' ||
    id === 'sso-mailbox-proven' ||
    id === 'sso-mailbox-outcome' ||
    id === 'sso-member-authorization'
  )
    routes.push([
      '/api/auth/sso/mailbox-proof/consume',
      (route) => {
        const request = route.request()
        if (
          request.method() !== 'POST' ||
          (teamOrganizationId &&
            request.headers()['x-expected-organization-id'] !== teamOrganizationId)
        )
          return route.abort()
        const body = request.postDataJSON()
        if (body?.attemptId !== attemptId || body?.token !== syntheticLinkToken)
          return route.abort()
        return route.fulfill({ json: { status: 'proven' } })
      },
    ])
  if (id === 'sso-mailbox-outcome')
    routes.push([
      '/api/auth/sso/oidc/complete',
      (route) => {
        const request = route.request()
        if (request.method() !== 'POST' || request.postDataJSON()?.attemptId !== attemptId)
          return route.abort()
        return route.fulfill({ json: { status: 'link_required' } })
      },
    ])

  for (const [path, handler] of routes) await page.route(app.url + path, handler)
  return async () => {
    for (const [path, handler] of routes) await page.unroute(app.url + path, handler)
  }
}

export async function openSsoMemberAuditPage(
  page: Page,
  app: FixtureApp,
  id: SsoMemberAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  const catalog = locale === 'zh-CN' ? chineseCopy : englishCopy
  const copy = (key: CopyKey) => catalog[key]
  const path = isSsoMemberSettingsAuditPage(id)
    ? PATHS.settings
    : id === 'sso-sign-in'
      ? PATHS.signIn
      : PATHS.mailboxProof
  const release = await mockMemberSso(page, app, id)
  try {
    const url = app.url + path + (id === 'sso-sign-in' ? `?sso=${provider.id}` : '')
    if (page.url() === url) await page.reload()
    else await page.goto(url)
    const main = page.getByRole('main')
    const heading = (key: CopyKey) => main.getByRole('heading', { name: copy(key), exact: true })
    const button = (key: CopyKey, name = '') => {
      const label = copy(key).replace('{name}', (marker, offset: number, template: string) =>
        locale === 'zh-CN'
          ? spaceCjkBoundaries(
              template.slice(0, offset),
              name,
              template.slice(offset + marker.length),
            )
          : name,
      )
      return main.getByRole('button', { name: label, exact: true })
    }
    const text = (key: CopyKey) => main.getByText(copy(key), { exact: true })
    async function startLink() {
      await button('Link account ({name})', provider.displayName).press('Enter')
      await button('Link account').press('Enter')
    }
    async function pasteAndVerify() {
      const fragment = new URLSearchParams({ attempt: attemptId, token: syntheticLinkToken })
      await main
        .getByLabel(copy('Email verification link'), { exact: true })
        .fill(`${app.url}${PATHS.mailboxProof}#${fragment}`)
      await button('Verify email link').press('Enter')
      await text('Email verification complete.').waitFor()
    }
    switch (id) {
      case 'sso-sign-in':
        await button('Sign in with single sign-on').waitFor()
        break
      case 'sso-mailbox-send':
      case 'sso-mailbox-link':
      case 'sso-mailbox-confirm':
      case 'sso-mailbox-confirmed':
      case 'sso-mailbox-paste-fallback':
      case 'sso-mailbox-proven':
      case 'sso-mailbox-outcome': {
        await heading('Verify your email').waitFor()
        const pasteFallback = id === 'sso-mailbox-paste-fallback'
        const emailLink =
          id === 'sso-mailbox-confirm' || id === 'sso-mailbox-confirmed' || pasteFallback
        await page.evaluate(
          ({ attemptId, token, pasteFallback }) => {
            if (pasteFallback)
              Object.defineProperty(window, 'BroadcastChannel', { value: undefined })
            window.location.hash = new URLSearchParams({
              attempt: attemptId,
              ...(token ? { token } : {}),
            }).toString()
          },
          { attemptId, token: emailLink ? syntheticLinkToken : '', pasteFallback },
        )
        await page.waitForFunction(() => !window.location.hash)
        if (pasteFallback) {
          await text(
            'Copy the link from your email and paste it into the tab where you requested verification.',
          ).waitFor()
        } else if (emailLink) {
          await button('Verify email link').waitFor()
          if (id === 'sso-mailbox-confirmed') {
            await button('Verify email link').press('Enter')
            await text('Email verification complete.').waitFor()
          }
        } else {
          await button('Send verification email').waitFor()
          if (id !== 'sso-mailbox-send') {
            await button('Send verification email').press('Enter')
            const input = main.getByLabel(copy('Email verification link'), { exact: true })
            await input.waitFor()
            if (id === 'sso-mailbox-proven' || id === 'sso-mailbox-outcome') await pasteAndVerify()
          }
        }
        if (id === 'sso-mailbox-outcome') {
          await button('Continue').press('Enter')
          await text(
            'To continue, sign in with your usual method or use a current team invitation.',
          ).waitFor()
        }
        break
      }
      case 'sso-mailbox-stale':
        await text('Could not verify that link. Check the link or request a new email.').waitFor()
        break
      case 'sso-member-settings':
      case 'sso-member-link':
      case 'sso-member-unlink':
      case 'sso-member-proof':
      case 'sso-member-authorization':
        await heading('Your team sign-in').waitFor()
        await button('Link account ({name})', provider.displayName).waitFor()
        await button('Unlink account ({name})', linkedProvider.displayName).waitFor()
        if (id === 'sso-member-unlink') {
          await button('Unlink account ({name})', linkedProvider.displayName).press('Enter')
          await button('Unlink account').waitFor()
        }
        if (id === 'sso-member-link') {
          await button('Link account ({name})', provider.displayName).press('Enter')
          await button('Link account').waitFor()
        }
        if (id === 'sso-member-proof' || id === 'sso-member-authorization') {
          await startLink()
          await button('Send verification email').press('Enter')
          await main.getByLabel(copy('Email verification link'), { exact: true }).waitFor()
          if (id === 'sso-member-authorization') {
            await pasteAndVerify()
            await button('Continue').press('Enter')
            await main
              .getByRole('link', { name: copy('Continue to identity provider'), exact: true })
              .waitFor()
          }
        }
        break
      case 'sso-member-confirm':
      case 'sso-member-stale':
        await heading('Your team sign-in').waitFor()
        await page.evaluate((id) => {
          window.location.hash = new URLSearchParams({ 'sso-link': id }).toString()
        }, attemptId)
        await heading('Confirm your SSO link').waitFor()
        if (id === 'sso-member-confirm') await button('Confirm link').waitFor()
        else await text('This SSO link request is unavailable. Start again.').waitFor()
        await page.waitForFunction(() => !window.location.hash)
        break
      case 'sso-member-unavailable':
      case 'sso-member-loading':
      case 'sso-member-error':
        await startLink()
        await text('Your team sign-in settings are unavailable.').waitFor()
        if (id !== 'sso-member-unavailable') {
          await button('Try again').press('Enter')
          if (id === 'sso-member-error') await text('Could not load SSO settings.').waitFor()
          else {
            await main
              .getByRole('status', { name: copy('Loading SSO settings…'), exact: true })
              .waitFor()
          }
        }
        break
    }
    // Axe can open and close a tab, which refreshes /me when this page regains focus.
    activeMocks.set(page, { release, loading: id === 'sso-member-loading' })
    return path
  } catch (cause) {
    await release()
    throw cause
  }
}
