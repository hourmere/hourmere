import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { PATHS } from '../../paths.ts'
import {
  emptyAccount,
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'

const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000019',
    slug: 'team-example',
    name: 'Example team',
    personal: false,
  },
}
const ID = '00000000-0000-7000-8000-000000000030'
const DOMAIN = '00000000-0000-7000-8000-000000000031'
const POLICY = 'GET /api/v1/team/sso/policy'
const USE = 'POST /api/v1/team/sso/recovery/use'
const PROVIDERS = 'GET /api/v1/team/sso/providers'
const SEND = 'POST /api/auth/sso/mailbox-proof/send'
const CONSUME = 'POST /api/auth/sso/mailbox-proof/consume'
const UPDATE = `PATCH /api/v1/team/sso/providers/${ID}`
const TEST = `POST /api/v1/team/sso/providers/${ID}/test`
const ACTIVATE = `POST /api/v1/team/sso/providers/${ID}/activation`
const TURN_OFF = 'PUT /api/v1/team/sso/policy'
const NOMINATION = '#ssoRecoveryEnrollment=00000000-0000-7000-8000-000000000032'
const PROVIDER_URL = 'https://identity.example.test/authorize'
const POLICY_DATA = {
  admission: 'invitation_only',
  policyRevision: 7,
  requireSso: true,
  trustGeneration: 2,
} satisfies Schemas['SsoPolicy']
const RECOVERY_TEAM = {
  id: TEAM.organization.id,
  displayName: TEAM.organization.name,
  policyRevision: POLICY_DATA.policyRevision,
}
const SECOND_RECOVERY_TEAM = {
  id: '00000000-0000-7000-8000-000000000039',
  displayName: 'Second team',
  policyRevision: 11,
}
const PROVIDER = {
  id: ID,
  protocol: 'oidc',
  clientId: 'client-id',
  issuer: 'https://identity.example.test',
  displayName: 'Example IdP',
  revision: 4,
  enabled: true,
  testStatus: 'failed',
  validationStatus: 'unknown',
  domains: [{ id: DOMAIN, generation: 2, name: 'example.test', status: 'verified' }],
  createdAt: '2026-10-01T09:00:00.000Z',
} satisfies Schemas['SsoProviderPage']['data'][number]
const UNAVAILABLE = 'SSO recovery is unavailable in this team.'
const START = 'Start recovery'
const AGAIN = 'Verify again to continue recovery'
const TOKEN = 'T'.repeat(43)
const attemptId = (step: number) => `00000000-0000-7000-8000-00000000005${step}`

const enabledInstance = () => json(200, { ssoOidcEnabled: true, ssoSamlEnabled: false })

const enabled: Routes = {
  ...signedInAs(TEAM),
  'GET /api/v1/instance': enabledInstance,
  [POLICY]: () => json(200, POLICY_DATA),
}

const personalRecovery: Routes = {
  ...signedInAs({ ...ME, ssoRecoveryTeams: [RECOVERY_TEAM] }),
  ...emptyAccount,
  'GET /api/v1/instance': enabledInstance,
}

async function verify(step: number) {
  const proof = await screen.findByRole('region', {
    name: 'Confirm your identity before changing SSO settings.',
  })
  const continueButton = within(proof).getByRole('button', { name: 'Continue' })
  expect(continueButton.hasAttribute('disabled')).toBe(true)
  await userEvent.click(within(proof).getByRole('button', { name: 'Send verification email' }))
  const input = await within(proof).findByLabelText('Email verification link')
  expect(document.activeElement).toBe(input)
  await userEvent.type(
    input,
    `${window.location.origin}${PATHS.mailboxProof}#attempt=${attemptId(step)}&token=${TOKEN}`,
  )
  await userEvent.click(within(proof).getByRole('button', { name: 'Verify email link' }))
  await within(proof).findByText('Email verification complete.')
  await userEvent.click(continueButton)
}

function useFixture(overrides: Routes = {}, requireGrantForPolicy = false) {
  let ceremonies = 0
  let latestAttempt = ''
  let grant = false
  let provider: Schemas['SsoProviderPage']['data'][number] = { ...PROVIDER }
  const api = fakeApi({
    ...enabled,
    [POLICY]: () =>
      requireGrantForPolicy && !grant
        ? json(403, { error: 'sso_required' })
        : json(200, POLICY_DATA),
    [USE]: ({ body }) => {
      const input = body as { expectedRevision: number; proofAttemptId?: string }
      expect(input.expectedRevision).toBe(POLICY_DATA.policyRevision)
      if (input.proofAttemptId) {
        expect(input.proofAttemptId).toBe(latestAttempt)
        grant = true
        return new Response(null, { status: 204 })
      }
      latestAttempt = attemptId(++ceremonies)
      return json(403, {
        error: 'sso_reauthentication_required',
        attemptId: latestAttempt,
        proofMethods: ['mailbox'],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
    },
    [SEND]: () => json(202, { status: 'queued' }),
    [CONSUME]: ({ body }) => {
      expect(body).toEqual({ attemptId: latestAttempt, token: TOKEN })
      return json(200, { status: 'proven' })
    },
    [PROVIDERS]: () =>
      grant
        ? json(200, { data: [provider], nextCursor: null })
        : json(403, { error: 'sso_required' }),
    [UPDATE]: ({ body }) => {
      expect(grant).toBe(true)
      expect(body).toEqual({
        displayName: PROVIDER.displayName,
        expectedRevision: 4,
        oidc: { clientSecret: 'new test secret' },
      })
      provider = { ...provider, revision: 5, testStatus: 'unknown' }
      grant = false
      return json(200, { provider })
    },
    [TEST]: ({ body }) => {
      expect(grant).toBe(true)
      expect(body).toEqual({ expectedRevision: 5 })
      grant = false
      return json(200, { url: PROVIDER_URL })
    },
    [ACTIVATE]: ({ body }) => {
      expect(grant).toBe(true)
      expect(provider.testStatus).toBe('passed')
      expect(body).toEqual({ expectedRevision: 5, enabled: true })
      grant = false
      return json(200, { provider })
    },
    [TURN_OFF]: ({ body }) => {
      expect(grant).toBe(true)
      expect(body).toEqual({ expectedRevision: 7, admission: 'invitation_only', requireSso: false })
      grant = false
      return json(200, { ...POLICY_DATA, policyRevision: 8, requireSso: false })
    },
    ...overrides,
  })
  return {
    ...api,
    finishProviderTest() {
      provider = { ...provider, testStatus: 'passed' }
    },
  }
}

describe('SSO recovery while hard-off', () => {
  it.each([
    [PATHS.settings + NOMINATION, 'Settings'],
    [PATHS.eventTypes, 'Event types'],
    [PATHS.sso, 'Page not found'],
    [PATHS.ssoRecovery, 'Page not found'],
  ])('has no entry or SSO request from %s', async (path, heading) => {
    const api = fakeApi({
      // Off, the server lists no recovery team and no summary unless SSO state is stored.
      ...signedInAs(TEAM),
      ...emptyAccount,
      ...emptyTeamLists,
      'GET /api/v1/instance': () =>
        json(200, {
          ssoOidcEnabled: false,
          ssoSamlEnabled: false,
          termsUrl: 'https://example.test/terms',
        }),
    })
    renderApp(path)
    await screen.findByRole('heading', { name: heading, level: 1 })
    await screen.findByRole('link', { name: 'Terms of service' })
    expect(screen.queryByRole('link', { name: 'SSO recovery' })).toBeNull()
    expect(screen.queryByRole('button', { name: /start recovery|accept nomination/i })).toBeNull()
    expect(api.calls.filter(({ path }) => /\/sso(?:[/?]|$)/.test(path))).toEqual([])
  })

  it.each([json(200, {}), json(503, { error: 'unavailable' })])(
    'makes no SSO request when capability discovery is inconclusive',
    async (response) => {
      const api = fakeApi({
        ...signedInAs(TEAM),
        'GET /api/v1/instance': () => response.clone(),
      })
      renderApp(PATHS.ssoRecovery)
      await screen.findByRole('heading', { name: 'Page not found' })
      expect(api.calls.filter(({ path }) => /\/sso(?:[/?]|$)/.test(path))).toEqual([])
    },
  )
})

describe('SSO recovery with the capability present', () => {
  it('starts and completes recovery from ordinary personal settings without switching spaces', async () => {
    const api = useFixture(personalRecovery, true)
    renderApp(PATHS.settings)
    await userEvent.click(await screen.findByRole('link', { name: 'SSO recovery' }))
    await screen.findByRole('heading', { name: 'SSO recovery for Example team' })
    await userEvent.click(await screen.findByRole('button', { name: START }))
    expect(api.to(POLICY)).toHaveLength(0)
    expect(api.to(PROVIDERS)).toHaveLength(0)

    await verify(1)
    await userEvent.click(await screen.findByRole('button', { name: 'Stop requiring SSO' }))
    const confirmation = screen.getByRole('group', {
      name: 'Stop requiring single sign-on for this team?',
    })
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Stop requiring SSO' }))
    await screen.findByText('Single sign-on is now optional for this team.')
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    for (const operation of [USE, SEND, CONSUME, POLICY, PROVIDERS, TURN_OFF]) {
      const requests = api.to(operation)
      expect(requests.length).toBeGreaterThan(0)
      for (const { headers } of requests) {
        expect(headers.get('x-expected-organization-id')).toBe(RECOVERY_TEAM.id)
      }
    }
  })

  it('offers each discovered team when the current team membership read is blocked', async () => {
    const api = fakeApi({
      ...signedInAs({ ...TEAM, ssoRecoveryTeams: [RECOVERY_TEAM, SECOND_RECOVERY_TEAM] }),
      ...emptyAccount,
      ...emptyTeamLists,
      'GET /api/v1/instance': enabledInstance,
      'GET /api/auth/organization/get-active-member': () => json(403, { code: 'SSO_REQUIRED' }),
      [USE]: () =>
        json(403, {
          error: 'sso_reauthentication_required',
          attemptId: attemptId(1),
          proofMethods: ['mailbox'],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
    })
    renderApp(PATHS.settings)
    await userEvent.click(await screen.findByRole('link', { name: 'SSO recovery' }))
    await screen.findByRole('heading', { name: 'SSO recovery for Example team' })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Team to recover' }), [
      SECOND_RECOVERY_TEAM.id,
    ])
    await screen.findByRole('heading', { name: 'SSO recovery for Second team' })
    await userEvent.click(screen.getByRole('button', { name: START }))
    await screen.findByRole('button', { name: 'Send verification email' })
    expect(api.to(POLICY)).toHaveLength(0)
    expect(api.to(USE)).toHaveLength(1)
    expect(api.to(USE)[0]?.headers.get('x-expected-organization-id')).toBe(SECOND_RECOVERY_TEAM.id)
    expect(api.to(USE)[0]?.body).toEqual({ expectedRevision: SECOND_RECOVERY_TEAM.policyRevision })
  })

  it('shows a stale discovered revision and only restarts after an explicit refresh and start', async () => {
    let revision = RECOVERY_TEAM.policyRevision
    const api = fakeApi({
      ...signedInAs(ME),
      'GET /api/v1/me': () =>
        json(200, { ...ME, ssoRecoveryTeams: [{ ...RECOVERY_TEAM, policyRevision: revision }] }),
      'GET /api/v1/instance': enabledInstance,
      [USE]: ({ body }) => {
        if ((body as { expectedRevision: number }).expectedRevision !== revision)
          return json(409, { error: 'sso_configuration_changed' })
        return json(403, {
          error: 'sso_reauthentication_required',
          attemptId: attemptId(1),
          proofMethods: ['mailbox'],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
      },
    })
    renderApp(PATHS.ssoRecovery)
    const start = await screen.findByRole('button', { name: START })
    revision += 1
    await userEvent.click(start)
    expect((await screen.findByRole('alert')).textContent).toBe(
      'These SSO settings changed. Reload before trying again.',
    )
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    expect(api.to(USE).map(({ body }) => body)).toEqual([
      { expectedRevision: RECOVERY_TEAM.policyRevision },
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Reload settings' }))
    const retry = await screen.findByRole('button', { name: START })
    expect(api.to(USE)).toHaveLength(1)
    expect(api.to(POLICY)).toHaveLength(0)
    expect(api.to(SEND)).toHaveLength(0)
    await userEvent.click(retry)
    await screen.findByRole('button', { name: 'Send verification email' })
    expect(api.to(USE).map(({ body }) => body)).toEqual([
      { expectedRevision: RECOVERY_TEAM.policyRevision },
      { expectedRevision: revision },
    ])
  })

  it('clears the recovery action when refreshing a stale revision finds no eligible team', async () => {
    let eligible = true
    const api = fakeApi({
      ...signedInAs(ME),
      'GET /api/v1/me': () =>
        json(200, eligible ? { ...ME, ssoRecoveryTeams: [RECOVERY_TEAM] } : ME),
      'GET /api/v1/instance': enabledInstance,
      [USE]: () => json(409, { error: 'sso_configuration_changed' }),
    })
    renderApp(PATHS.ssoRecovery)
    await userEvent.click(await screen.findByRole('button', { name: START }))
    const reload = await screen.findByRole('button', { name: 'Reload settings' })
    eligible = false
    await userEvent.click(reload)
    expect((await screen.findByRole('alert')).textContent).toBe(UNAVAILABLE)
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    expect(api.to(USE)).toHaveLength(1)
    expect(api.to(POLICY)).toHaveLength(0)
  })

  it.each(['admin', 'member', 'other-team', 'personal'])(
    'does not load recovery for %s context',
    async (context) => {
      const api = fakeApi({
        ...enabled,
        ...(context === 'personal' ? signedInAs(ME) : {}),
        'GET /api/v1/instance': enabledInstance,
        'GET /api/auth/organization/get-active-member': () =>
          json(200, {
            id: 'member-id',
            organizationId: context === 'other-team' ? ME.organization.id : TEAM.organization.id,
            userId: TEAM.user.id,
            role: context === 'other-team' ? 'owner' : context,
          }),
      })
      renderApp(PATHS.ssoRecovery)
      expect((await screen.findByRole('alert')).textContent).toBe(UNAVAILABLE)
      expect(api.to(POLICY)).toHaveLength(0)
      expect(api.to(USE)).toHaveLength(0)
    },
  )

  it('shows neutral loading and refuses a policy 403 without offering repair', async () => {
    const policy = later()
    const api = fakeApi({ ...enabled, [POLICY]: () => policy.response })
    renderApp(PATHS.ssoRecovery)
    await waitFor(() => expect(api.to(POLICY)).toHaveLength(1))
    expect(screen.getByRole('status', { name: 'Loading SSO recovery…' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    await policy.answer(json(403, { error: 'team_management_access_denied' }))
    expect((await screen.findByRole('alert')).textContent).toBe(UNAVAILABLE)
    expect(screen.queryByText('Single sign-on is optional for this team.')).toBeNull()
    expect(api.to(USE)).toHaveLength(0)
    expect(api.to(PROVIDERS)).toHaveLength(0)
  })

  it('reloads after a network error without showing an empty recovery state', async () => {
    let attempts = 0
    const api = fakeApi({
      ...enabled,
      [POLICY]: () =>
        ++attempts === 1 ? json(503, { error: 'unavailable' }) : json(200, POLICY_DATA),
    })
    renderApp(PATHS.ssoRecovery)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load SSO recovery.')
    expect(screen.queryByRole('button', { name: START })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: START })
    expect(api.to(POLICY)).toHaveLength(2)
    expect(api.to(USE)).toHaveLength(0)
  })

  it('honors a denial from recovery use before loading providers or sending email', async () => {
    const api = fakeApi({
      ...enabled,
      [USE]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(PATHS.ssoRecovery)
    await userEvent.click(await screen.findByRole('button', { name: START }))
    expect((await screen.findByRole('alert')).textContent).toBe(UNAVAILABLE)
    expect(api.to(USE)[0]?.headers.get('x-expected-organization-id')).toBe(TEAM.organization.id)
    expect(api.to(PROVIDERS)).toHaveLength(0)
    expect(api.to(SEND)).toHaveLength(0)
  })

  it('takes one new mailbox ceremony per update, test and reactivation from personal space', async () => {
    const api = useFixture(personalRecovery, true)
    renderApp(PATHS.ssoRecovery)
    const start = await screen.findByRole('button', { name: START })
    expect(api.to(USE)).toHaveLength(0)
    expect(api.to(PROVIDERS)).toHaveLength(0)
    await userEvent.click(start)
    await verify(1)

    const edit = await screen.findByRole('button', { name: 'Edit Example IdP' })
    expect(screen.queryByRole('button', { name: /retire|disable|require sso$/i })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Enable provider Example IdP' }).hasAttribute('disabled'),
    ).toBe(true)
    await userEvent.click(edit)
    await userEvent.click(screen.getByRole('button', { name: 'Replace client secret' }))
    await userEvent.type(screen.getByLabelText('New client secret'), 'new test secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Provider saved. Verify again to test the current revision.')
    expect(screen.queryByRole('button', { name: 'Test provider Example IdP' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: AGAIN }))
    await verify(2)
    expect(
      (await screen.findByRole('button', { name: 'Enable provider Example IdP' })).hasAttribute(
        'disabled',
      ),
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Test provider Example IdP' }))
    const handoff = await screen.findByRole('link', {
      name: 'Continue to identity provider (opens in a new tab)',
    })
    expect(handoff.getAttribute('href')).toBe(PROVIDER_URL)
    expect(handoff.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('button', { name: 'Enable provider Example IdP' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check provider test result' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: AGAIN }))
    await verify(3)
    const refresh = await screen.findByRole('button', { name: 'Check provider test result' })
    const enable = screen.getByRole('button', { name: 'Enable provider Example IdP' })
    expect(enable.hasAttribute('disabled')).toBe(true)
    api.finishProviderTest()
    await userEvent.click(refresh)
    await waitFor(() => expect(enable.hasAttribute('disabled')).toBe(false))
    expect(enable.hasAttribute('disabled')).toBe(false)
    await userEvent.click(enable)
    await screen.findByText('The current provider revision is enabled.')
    expect(api.to(SEND)).toHaveLength(3)
    expect(api.to(CONSUME)).toHaveLength(3)
    expect(api.to(USE).map(({ body }) => body)).toEqual(
      [1, 2, 3].flatMap((step) => [
        { expectedRevision: POLICY_DATA.policyRevision },
        { expectedRevision: POLICY_DATA.policyRevision, proofAttemptId: attemptId(step) },
      ]),
    )
    for (const operation of [UPDATE, TEST, ACTIVATE, USE, POLICY, PROVIDERS, SEND, CONSUME]) {
      expect(
        api
          .to(operation)
          .every(
            ({ headers }) => headers.get('x-expected-organization-id') === TEAM.organization.id,
          ),
      ).toBe(true)
    }
  })

  it('can stop requiring SSO while preserving the existing admission policy', async () => {
    const api = useFixture()
    renderApp(PATHS.ssoRecovery)
    await userEvent.click(await screen.findByRole('button', { name: START }))
    await verify(1)
    await userEvent.click(await screen.findByRole('button', { name: 'Stop requiring SSO' }))
    const confirmation = screen.getByRole('group', {
      name: 'Stop requiring single sign-on for this team?',
    })
    expect(api.to(TURN_OFF)).toHaveLength(0)
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Stop requiring SSO' }))
    await screen.findByText('Single sign-on is now optional for this team.')
    expect(api.to(TURN_OFF)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: AGAIN })).toBeNull()
  })
})
