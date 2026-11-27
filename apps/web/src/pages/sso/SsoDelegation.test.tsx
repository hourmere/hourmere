import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ApiKey } from '../../api/auth.ts'
import type { Schemas } from '../../api/client.ts'
import {
  ApiKeysPage,
  AppShell,
  ConnectedAppsPage,
  RequireSession,
  SessionLayout,
} from '../../lazy-pages.tsx'
import { PATHS } from '../../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  organizations,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'

beforeAll(() =>
  resolveLazy(SessionLayout, RequireSession, AppShell, ApiKeysPage, ConnectedAppsPage),
)

const team = {
  id: '00000000-0000-7000-8000-0000000000d1',
  name: 'Engineering',
  slug: 'engineering',
  personal: false,
}
const provider = {
  id: '00000000-0000-7000-8000-0000000000d2',
  displayName: 'Engineering identity',
  revision: 3,
}
const viewer: Schemas['Me'] = {
  ...ME,
  organization: team,
  sso: {
    requireSso: true,
    attempts: [],
    providers: [provider],
    proofs: [],
    links: [
      {
        id: '00000000-0000-7000-8000-0000000000d3',
        providerId: provider.id,
        generation: 2,
      },
    ],
  },
}
const withoutSso = { ...ME, organization: team }
const samlViewer: Schemas['Me'] = {
  ...viewer,
  sso: viewer.sso && {
    ...viewer.sso,
    providers: [{ ...provider, protocol: 'saml' }],
    links: viewer.sso.links.map((link) => ({ ...link, protocol: 'saml' })),
  },
}
const key: ApiKey = {
  id: '00000000-0000-7000-8000-0000000000d4',
  name: 'Team scanner',
  start: 'hm_Test',
  createdAt: '2026-11-01T00:00:00Z',
  enabled: true,
  expiresAt: null,
  lastRequest: null,
  metadata: { organizationId: team.id.toUpperCase(), scope: 'read' },
}
const personalKey: ApiKey = {
  ...key,
  id: '00000000-0000-7000-8000-0000000000d5',
  name: 'Personal key',
  metadata: { organizationId: ME.organization.id, scope: 'read' },
}
const connection = {
  id: '00000000-0000-7000-8000-0000000000d6',
  credentialId: '00000000-0000-7000-8000-0000000000d7',
  organizationName: team.name,
  clientName: 'Connected assistant',
  clientId: 'assistant-example',
  createdAt: '2026-11-01T00:00:00Z',
}
const attemptId = '00000000-0000-7000-8000-0000000000d8'
const binding = {
  id: '00000000-0000-7000-8000-0000000000d9',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
}
const getKeys = 'GET /api/auth/api-key/list'
const getConnections = 'GET /api/v1/mcp-oauth/connections'
const getPolicy = 'GET /api/v1/team/sso/policy'
const bind = 'POST /api/v1/team/sso/delegations'
const revoke = `DELETE /api/v1/team/sso/delegations/${binding.id}`
const stepUp = 'POST /api/auth/sign-in/sso'
const policy = {
  admission: 'invitation_only',
  policyRevision: 7,
  requireSso: true,
  trustGeneration: 5,
}
const providerUrl = 'https://id.example.test/authorize?state=synthetic'

function showCredentials(path: string, routes: Routes, me = viewer) {
  const requests = fakeApi({
    ...signedInAs(me),
    ...organizations([team, ME.organization]),
    'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: true, ssoSamlEnabled: false }),
    [getKeys]: () => json(200, { apiKeys: [key, personalKey], total: 2 }),
    [getConnections]: () => json(200, { data: [connection] }),
    ...routes,
  })
  const user = userEvent.setup()
  renderApp(path)
  return { requests, user }
}

describe('SSO credential delegation', () => {
  it.each([
    { path: PATHS.apiKeys, kind: 'api_key', credentialId: key.id, saml: false },
    {
      path: PATHS.connectedApps,
      kind: 'oauth_grant',
      credentialId: connection.credentialId,
      saml: false,
    },
    { path: PATHS.apiKeys, kind: 'api_key', credentialId: key.id, saml: true },
  ])(
    'binds the exact $kind credential after an explicit verification retry (SAML $saml)',
    async (credential) => {
      let ssoDelegation: typeof binding | undefined
      const { requests, user } = showCredentials(
        credential.path,
        {
          'GET /api/v1/instance': () =>
            json(200, {
              ssoOidcEnabled: !credential.saml,
              ssoSamlEnabled: credential.saml,
            }),
          [getKeys]: () =>
            json(200, { apiKeys: [{ ...key, ssoDelegation }, personalKey], total: 2 }),
          [getConnections]: () => json(200, { data: [{ ...connection, ssoDelegation }] }),
          [getPolicy]: () => json(200, policy),
          [bind]: ({ body }) => {
            if (!(body as { proofAttemptId?: string }).proofAttemptId)
              return json(403, {
                error: 'sso_reauthentication_required',
                attemptId,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                proofMethods: ['sso'],
              })
            ssoDelegation = binding
            return json(201, binding)
          },
          [stepUp]: () => json(200, { url: providerUrl, redirect: true }),
        },
        credential.saml ? samlViewer : viewer,
      )

      const section = within(await screen.findByRole('region', { name: 'SSO delegation' }))
      const choices = section.getByLabelText<HTMLSelectElement>('Credential')
      expect([...choices.options].map(({ value }) => value)).toEqual([credential.credentialId])
      expect(requests.to(getPolicy)).toHaveLength(0)
      await user.click(section.getByRole('button', { name: 'Bind SSO delegation' }))
      await section.findByText('Verify with single sign-on')
      await user.click(section.getByRole('button', { name: 'Start SSO verification' }))
      const handoff = await section.findByRole('link', { name: /Open identity provider/ })
      expect(handoff.getAttribute('href')).toBe(providerUrl)
      expect(requests.to(bind)).toHaveLength(1)
      await user.click(section.getByRole('button', { name: 'Continue' }))
      await section.findByText('SSO delegation bound.')
      const expiry = section.getByText(/SSO delegation expires/)
      expect(expiry.getAttribute('datetime')).toBe(binding.expiresAt)

      const target = {
        credentialKind: credential.kind,
        credentialId: credential.credentialId,
        expectedTrustGeneration: policy.trustGeneration,
      }
      expect(requests.to(bind).map(({ body }) => body)).toEqual([
        target,
        { ...target, proofAttemptId: attemptId },
      ])
      expect(requests.to(stepUp).map(({ body }) => body)).toEqual([
        { providerId: provider.id, intent: 'step_up', attemptId, returnTo: PATHS.settings },
      ])
      expect(requests.to(getPolicy)).toHaveLength(1)
      for (const call of [
        ...requests.to(getPolicy),
        ...requests.to(bind),
        ...requests.to(stepUp),
      ]) {
        expect(call.headers.get('X-Expected-Organization-Id')).toBe(team.id)
        expect(call.headers.get('Authorization')).toBeNull()
      }
    },
  )

  it('shows expiry and can revoke the owned binding without knowing policy or sign-in readiness', async () => {
    let current: typeof binding | undefined = binding
    const { requests, user } = showCredentials(
      PATHS.connectedApps,
      {
        [getConnections]: () => json(200, { data: [{ ...connection, ssoDelegation: current }] }),
        [revoke]: () => {
          current = undefined
          return new Response(null, { status: 204 })
        },
      },
      withoutSso,
    )
    const section = within(await screen.findByRole('region', { name: 'SSO delegation' }))
    expect(section.getByText(/SSO delegation expires/).getAttribute('datetime')).toBe(
      binding.expiresAt,
    )
    await user.click(section.getByRole('button', { name: 'Revoke SSO delegation' }))
    const confirm = within(section.getByRole('group', { name: 'Revoke this SSO delegation?' }))
    expect(requests.to(revoke)).toHaveLength(0)
    await user.click(confirm.getByRole('button', { name: 'Revoke SSO delegation' }))
    await section.findByText('SSO delegation revoked.')
    expect(section.queryByText(/SSO delegation expires/)).toBeNull()
    expect(section.getByText('Could not verify your team sign-in settings.')).toBeDefined()
    expect(requests.to(getPolicy)).toHaveLength(0)
    expect(requests.to(bind)).toHaveLength(0)
    expect(requests.to(revoke)).toHaveLength(1)
    expect(requests.to(revoke)[0]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
  })

  it.each([
    ['access is denied', () => json(403, { error: 'team_management_access_denied' })],
    ['policy cannot be read', () => json(503, { error: 'temporary_failure' })],
    ['the generation is unknown', () => json(200, { ...policy, trustGeneration: null })],
  ])('does not guess a trust generation when %s', async (_label, response) => {
    const { requests, user } = showCredentials(PATHS.connectedApps, { [getPolicy]: response })
    await user.click(await screen.findByRole('button', { name: 'Bind SSO delegation' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not verify this team’s SSO policy.',
    )
    expect(requests.to(bind)).toHaveLength(0)
    expect(requests.to(stepUp)).toHaveLength(0)
  })

  it.each([PATHS.apiKeys, PATHS.connectedApps])(
    'issues no SSO requests at %s while instance status is unknown or off',
    async (path) => {
      const instance = later()
      // Off, the server sends no SSO summary for a team without stored SSO state.
      const { sso: _sso, ...withoutSso } = viewer
      const { requests } = showCredentials(
        path,
        {
          'GET /api/v1/instance': () => instance.response,
          [getKeys]: () => json(200, { apiKeys: [{ ...key, ssoDelegation: binding }], total: 1 }),
          [getConnections]: () => json(200, { data: [{ ...connection, ssoDelegation: binding }] }),
        },
        withoutSso,
      )
      await screen.findByText(path === PATHS.apiKeys ? (key.name as string) : connection.clientName)
      expect(screen.queryByRole('region', { name: 'SSO delegation' })).toBeNull()
      await instance.answer(json(200, { ssoOidcEnabled: false, ssoSamlEnabled: false }))
      expect(screen.queryByRole('region', { name: 'SSO delegation' })).toBeNull()
      expect(requests.calls.filter(({ path }) => path.includes('/sso'))).toEqual([])
    },
  )

  it.each([PATHS.apiKeys, PATHS.connectedApps])(
    'offers only revocation at %s while the setting is off for a team with stored SSO state',
    async (path) => {
      const bound = path === PATHS.apiKeys
      const { requests } = showCredentials(path, {
        'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: false, ssoSamlEnabled: false }),
        // One credential still has a suspended delegation; the other has none to revoke.
        [getKeys]: () =>
          json(200, {
            apiKeys: [{ ...key, ssoDelegation: bound ? binding : undefined }],
            total: 1,
          }),
        [getConnections]: () => json(200, { data: [connection] }),
      })
      await screen.findByText(bound ? (key.name as string) : connection.clientName)
      if (bound) {
        const region = await screen.findByRole('region', { name: 'SSO delegation' })
        expect(within(region).getByRole('button', { name: 'Revoke SSO delegation' })).toBeDefined()
        expect(within(region).queryByRole('button', { name: 'Bind SSO delegation' })).toBeNull()
      } else expect(screen.queryByRole('region', { name: 'SSO delegation' })).toBeNull()
      expect(requests.calls.filter(({ path }) => path.includes('/sso'))).toEqual([])
    },
  )
})
