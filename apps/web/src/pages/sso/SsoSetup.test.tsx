import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import {
  AppShell,
  EventTypesPage,
  RequireSession,
  SessionLayout,
  SettingsPage,
  SignInPage,
  SsoSetupPage,
} from '../../lazy-pages.tsx'
import { PATHS } from '../../paths.ts'
import {
  emptyAccount,
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  renderApp,
  signedInAs,
  signedOut,
} from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'

beforeAll(() =>
  resolveLazy(
    SessionLayout,
    RequireSession,
    AppShell,
    SettingsPage,
    EventTypesPage,
    SignInPage,
    SsoSetupPage,
  ),
)

const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000019',
    slug: 'team-example',
    name: 'Example team',
    personal: false,
  },
}
const INVENTORY = 'GET /api/v1/team/sso/providers'
const POLICY = 'GET /api/v1/team/sso/policy'
const policy = () =>
  json(200, {
    admission: 'invitation_only',
    policyRevision: 1,
    requireSso: false,
    trustGeneration: 1,
  } satisfies Schemas['SsoPolicy'])
const ENABLED = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const EMPTY = { data: [], nextCursor: null }
const TERMS = 'https://example.test/terms'

afterEach(() => vi.unstubAllEnvs())

const activationControl =
  /test provider|enable provider|disable provider|requiring sso|require sso/i
const ssoPath = /(?:^|\/)sso(?:\/|\?|$)/

describe('SSO setup while hard-off', () => {
  it.each([PATHS.settings, PATHS.eventTypes, PATHS.sso, PATHS.ssoDomainSettings, PATHS.signIn])(
    'never enters the SSO network path from %s',
    async (path) => {
      vi.stubEnv('SSO_OIDC_ENABLED', 'true')
      vi.stubEnv('SSO_SAML_ENABLED', 'true')
      const instance = later()
      const api = fakeApi({
        ...emptyAccount,
        ...emptyTeamLists,
        ...(path === PATHS.signIn ? signedOut : signedInAs(TEAM)),
        'GET /api/v1/instance': () => instance.response.then((response) => response.clone()),
      })
      renderApp(path)
      await waitFor(() => expect(api.to('GET /api/v1/instance').length).toBeGreaterThan(0))
      const ssoCalls = () => api.calls.filter(({ path }) => ssoPath.test(path))
      expect(screen.queryByRole('button', { name: activationControl })).toBeNull()
      expect(ssoCalls()).toEqual([])
      await instance.answer(
        json(200, {
          ssoOidcEnabled: false,
          ssoSamlEnabled: false,
          termsUrl: TERMS,
          signIn: { email: true, google: false, microsoft: false },
        }),
      )
      await screen.findByRole('link', { name: 'Terms of service' })
      const heading = {
        [PATHS.settings]: 'Settings',
        [PATHS.eventTypes]: 'Event types',
        [PATHS.sso]: 'Page not found',
        [PATHS.ssoDomainSettings]: 'Page not found',
        [PATHS.signIn]: 'Sign in to Hourmere',
      }[path]
      await screen.findByRole('heading', { name: heading, level: 1 })
      expect(
        screen.queryByRole('link', { name: /single sign-on|identity providers|sso domains/i }),
      ).toBeNull()
      expect(screen.queryByRole('button', { name: /single sign-on|sso/i })).toBeNull()
      expect(screen.queryByRole('button', { name: activationControl })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'SSO enforcement' })).toBeNull()
      expect(screen.queryByLabelText('Admission policy')).toBeNull()
      expect(screen.queryByLabelText('Identity link')).toBeNull()
      expect(ssoCalls()).toEqual([])
    },
  )

  it.each([json(200, {}), json(503, { error: 'unavailable' })])(
    'fails closed when capability discovery does not confirm SSO',
    async (response) => {
      const api = fakeApi({
        ...signedInAs(TEAM),
        'GET /api/v1/instance': () => response.clone(),
      })
      renderApp(PATHS.sso)
      await screen.findByRole('heading', { name: 'Page not found', level: 1 })
      expect(screen.queryByRole('button', { name: activationControl })).toBeNull()
      expect(api.calls.filter(({ path }) => ssoPath.test(path))).toEqual([])
    },
  )
})

describe('SSO setup while the setting is off for a team with stored SSO state', () => {
  it.each(['oidc', 'saml'])(
    'keeps read and trust-reducing controls for stored %s',
    async (protocol) => {
      // Off, the server still sends the summary because this team has stored SSO state.
      const stored: Schemas['Me'] = {
        ...TEAM,
        sso: { requireSso: true, providers: [], attempts: [], links: [], proofs: [] },
      }
      const domain = {
        id: '00000000-0000-7000-8000-000000000011',
        name: 'login.example.com',
        generation: 2,
        status: 'verified',
      }
      const provider = {
        id: '00000000-0000-7000-8000-000000000012',
        protocol,
        revision: 3,
        enabled: true,
        displayName: 'Example identity',
        issuer: 'https://identity.example.com',
        clientId: protocol === 'oidc' ? 'hourmere-web' : null,
        validationStatus: 'unknown',
        testStatus: 'passed',
        createdAt: '2026-10-01T00:00:00Z',
        domains: [domain],
      }
      const api = fakeApi({
        ...signedInAs(stored),
        ...emptyTeamLists,
        'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: false, ssoSamlEnabled: false }),
        [INVENTORY]: () => json(200, { data: [provider], nextCursor: null }),
        [POLICY]: () =>
          json(200, {
            admission: 'invitation_only',
            policyRevision: 2,
            requireSso: true,
            trustGeneration: 1,
          } satisfies Schemas['SsoPolicy']),
      })
      renderApp(PATHS.settings)
      const region = await screen.findByRole('region', { name: 'Single sign-on' })
      await userEvent.click(within(region).getByRole('link', { name: 'Identity providers' }))
      await screen.findByRole('heading', { name: 'Single sign-on', level: 1 })
      await screen.findByText(/Single sign-on is turned off on this instance\./)
      await screen.findByRole('heading', { name: 'Example identity' })
      expect(screen.getByRole('button', { name: 'Retire provider Example identity' })).toBeDefined()
      expect(
        screen.getByRole('button', { name: 'Disable provider Example identity' }),
      ).toBeDefined()
      for (const name of [
        'Add provider',
        'Add SAML provider',
        'Edit Example identity',
        'Test provider Example identity',
        'Enable provider Example identity',
        'Require SSO',
        'Save admission policy',
      ])
        expect(screen.queryByRole('button', { name }), name).toBeNull()
      expect(screen.queryByRole('link', { name: 'Download service provider metadata' })).toBeNull()

      await userEvent.click(screen.getByRole('link', { name: 'SSO domains' }))
      await screen.findByRole('heading', { name: 'login.example.com' })
      expect(screen.getByRole('button', { name: 'Retire domain login.example.com' })).toBeDefined()
      for (const name of [
        'Generate DNS challenge',
        'Verify domain login.example.com',
        'Rotate challenge for login.example.com',
      ])
        expect(screen.queryByRole('button', { name }), name).toBeNull()
      // Only the two reads were made: nothing that adds trust is even attempted.
      expect(
        api.calls.filter(({ path }) => ssoPath.test(path)).map(({ method }) => method),
      ).toEqual(expect.arrayContaining(['GET']))
      expect(api.calls.filter(({ method }) => method !== 'GET')).toEqual([])
    },
  )
})

describe('SSO setup in an enabled test instance', () => {
  it('offers setup from Settings without loading an inventory until the link is opened', async () => {
    const api = fakeApi({
      ...signedInAs(TEAM),
      ...emptyTeamLists,
      'GET /api/v1/instance': () => json(200, ENABLED),
      [INVENTORY]: () => json(200, EMPTY),
      [POLICY]: policy,
    })
    renderApp(PATHS.settings)
    const region = await screen.findByRole('region', { name: 'Single sign-on' })
    expect(api.to(INVENTORY)).toHaveLength(0)
    expect(api.to(POLICY)).toHaveLength(0)
    await userEvent.click(within(region).getByRole('link', { name: 'Identity providers' }))
    await screen.findByRole('heading', { name: 'Single sign-on', level: 1 })
    await screen.findByRole('button', { name: 'Add provider' })
    expect(api.to(INVENTORY)).toHaveLength(1)
    expect(api.to(INVENTORY)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      TEAM.organization.id,
    )
  })

  it.each(['member', 'other-team', 'personal'] as const)(
    'keeps the forms and API requests unavailable for a %s context',
    async (context) => {
      const me = context === 'personal' ? ME : TEAM
      const api = fakeApi({
        ...signedInAs(me),
        'GET /api/v1/instance': () => json(200, ENABLED),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, {
            id: 'membership-1',
            organizationId: context === 'other-team' ? ME.organization.id : TEAM.organization.id,
            userId: TEAM.user.id,
            role: context === 'member' ? 'member' : 'owner',
          }),
      })
      renderApp(PATHS.ssoDomainSettings)
      expect((await screen.findByRole('alert')).textContent).toBe(
        'SSO settings are unavailable in this team.',
      )
      expect(screen.queryByRole('button', { name: 'Generate DNS challenge' })).toBeNull()
      expect(api.to(INVENTORY)).toHaveLength(0)
    },
  )

  it.each([
    { status: 403, protocol: 'OIDC', flags: ENABLED },
    { status: 503, protocol: 'OIDC', flags: ENABLED },
    { status: 403, protocol: 'SAML', flags: { ssoOidcEnabled: false, ssoSamlEnabled: true } },
    { status: 503, protocol: 'SAML', flags: { ssoOidcEnabled: false, ssoSamlEnabled: true } },
  ])(
    'shows a neutral state when $protocol inventory loading ends with $status',
    async ({ status, flags }) => {
      const pending = later()
      fakeApi({
        ...signedInAs(TEAM),
        'GET /api/v1/instance': () => json(200, flags),
        [INVENTORY]: () => pending.response,
        [POLICY]: policy,
      })
      renderApp(PATHS.sso)
      await screen.findByRole('status', { name: 'Loading SSO settings…' })
      expect(screen.queryByText('No identity providers yet.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add SAML provider' })).toBeNull()
      await pending.answer(
        json(status, { error: 'inventory_error', message: 'Synthetic internal error' }),
      )
      expect((await screen.findByRole('alert')).textContent).toBe(
        status === 403
          ? 'SSO settings are unavailable in this team.'
          : 'Could not load SSO settings.',
      )
      expect(screen.queryByText('Synthetic internal error')).toBeNull()
      expect(screen.queryByText('No identity providers yet.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add SAML provider' })).toBeNull()
    },
  )

  it('keeps all cursor pages scoped to the same team and waits for the full inventory', async () => {
    const second = later()
    const api = fakeApi({
      ...signedInAs(TEAM),
      'GET /api/v1/instance': () => json(200, ENABLED),
      [INVENTORY]: ({ path }) =>
        path.includes('cursor=') ? second.response : json(200, { ...EMPTY, nextCursor: 'next' }),
      [POLICY]: policy,
    })
    renderApp(PATHS.sso)
    await waitFor(() => expect(api.to(INVENTORY)).toHaveLength(2))
    expect(screen.getByRole('status', { name: 'Loading SSO settings…' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull()
    expect(
      api.to(INVENTORY).map(({ headers }) => headers.get('X-Expected-Organization-Id')),
    ).toEqual([TEAM.organization.id, TEAM.organization.id])
    await second.answer(json(200, EMPTY))
    await screen.findByText('No identity providers yet.')
  })
})
