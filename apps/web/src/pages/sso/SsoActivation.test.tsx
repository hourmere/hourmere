import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { PATHS } from '../../paths.ts'
import {
  type Call,
  fakeApi,
  json,
  later,
  ME,
  organizations,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import type { SsoProvider } from './setup.ts'

const team = {
  id: '00000000-0000-7000-8000-000000000050',
  name: 'Engineering',
  slug: 'engineering',
  personal: false,
}
const me: Schemas['Me'] = { ...ME, organization: team }
const domain = {
  id: '00000000-0000-7000-8000-000000000052',
  name: 'example.com',
  generation: 2,
  status: 'verified',
}
const draft: SsoProvider = {
  id: '00000000-0000-7000-8000-000000000051',
  protocol: 'oidc',
  revision: 4,
  enabled: false,
  displayName: 'Draft identity',
  issuer: 'https://draft.example.com',
  clientId: 'draft',
  createdAt: '2026-11-01T00:00:00Z',
  validationStatus: 'unknown',
  testStatus: 'unknown',
  domains: [domain],
}
const enabled: SsoProvider = {
  ...draft,
  id: '00000000-0000-7000-8000-000000000053',
  enabled: true,
  displayName: 'Team identity',
  issuer: 'https://team-id.example.com',
  testStatus: 'passed',
}
const unlinked: SsoProvider = {
  ...enabled,
  id: '00000000-0000-7000-8000-000000000054',
  displayName: 'Other identity',
  links: [{ id: '00000000-0000-7000-8000-000000000055', generation: 1 }],
}
const saml: SsoProvider = {
  ...enabled,
  id: '00000000-0000-7000-8000-000000000056',
  protocol: 'saml',
  displayName: 'SAML identity',
}
const policy: Schemas['SsoPolicy'] = {
  admission: 'jit',
  policyRevision: 7,
  requireSso: false,
  trustGeneration: 3,
}
const collection = '/api/v1/team/sso/providers'
const getProviders = `GET ${collection}`
const getPolicy = 'GET /api/v1/team/sso/policy'
const putPolicy = 'PUT /api/v1/team/sso/policy'
const testProvider = `POST ${collection}/${draft.id}/test`
const activateProvider = `POST ${collection}/${draft.id}/activation`
const sendEmail = 'POST /api/auth/sso/mailbox-proof/send'
const consumeEmail = 'POST /api/auth/sso/mailbox-proof/consume'
const stepUp = 'POST /api/auth/sign-in/sso'
const proofAttemptId = '00000000-0000-7000-8000-000000000057'
const ownLinkId = '00000000-0000-7000-8000-000000000058'
const memberLinkId = '00000000-0000-7000-8000-000000000059'
const removeLink = `DELETE ${collection}/${enabled.id}/links/${memberLinkId}`
const linkInventory = {
  ...enabled,
  links: [
    { id: ownLinkId, generation: 1 },
    { id: memberLinkId, generation: 4 },
  ],
}
const linkedMe: Schemas['Me'] = {
  ...me,
  sso: {
    requireSso: false,
    attempts: [],
    providers: [{ id: enabled.id, displayName: enabled.displayName, revision: enabled.revision }],
    proofs: [],
    links: [{ id: ownLinkId, providerId: enabled.id, generation: 1 }],
  },
}
const adminRole: Routes = {
  'GET /api/auth/organization/get-active-member': () =>
    json(200, { id: 'membership-1', organizationId: team.id, userId: me.user.id, role: 'admin' }),
}
const token = 'test-only-mailbox-token'
const idpUrl = 'https://oidc.example.com/authorize?state=example'
const proofHeading = 'Confirm your identity before changing SSO settings.'
const page = (...data: SsoProvider[]) => json(200, { data, nextCursor: null })

function showSso(routes: Routes, viewer = me) {
  const requests = fakeApi({
    ...signedInAs(viewer),
    'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: true, ssoSamlEnabled: false }),
    [getProviders]: () => page(draft),
    [getPolicy]: () => json(200, policy),
    ...routes,
  })
  const user = userEvent.setup()
  renderApp(PATHS.sso)
  return { requests, user }
}

function challenge(...proofMethods: string[]) {
  return json(403, {
    error: 'sso_reauthentication_required',
    attemptId: proofAttemptId,
    proofMethods,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  } satisfies Schemas['SsoFreshProofChallenge'])
}

function expectTeamWrites(calls: Call[], bodies: unknown[]) {
  expect(calls.map(({ body }) => body)).toEqual(bodies)
  for (const { headers } of calls) {
    expect(headers.get('X-Expected-Organization-Id')).toBe(team.id)
    expect(headers.get('Authorization')).toBeNull()
  }
}

async function confirm(user: ReturnType<typeof userEvent.setup>, label: string, question: string) {
  await user.click(await screen.findByRole('button', { name: label }))
  const group = screen.getByRole('group', { name: question })
  const cancel = within(group).getByRole('button', { name: 'Cancel' })
  expect(document.activeElement).toBe(cancel)
  await user.click(within(group).getByRole('button', { name: label }))
}

function mailboxLink(attempt = proofAttemptId) {
  return `${window.location.origin}/app/mailbox-proof#attempt=${attempt}&token=${token}`
}

async function openMailboxPrompt(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: proofHeading })
  await user.click(screen.getByRole('button', { name: 'Send verification email' }))
  return screen.findByLabelText('Email verification link')
}

async function verifyEmail(user: ReturnType<typeof userEvent.setup>, link: HTMLElement) {
  await user.clear(link)
  await user.click(link)
  await user.paste(mailboxLink())
  await user.click(screen.getByRole('button', { name: 'Verify email link' }))
  const next = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Continue',
  })
  await waitFor(() => expect(next.disabled).toBe(false))
  return next
}

describe('SSO provider activation', () => {
  it('starts a test only on a disabled OIDC draft and exposes the returned authorization URL', async () => {
    const { requests, user } = showSso({
      [getProviders]: () => page(draft, enabled, saml),
      [testProvider]: () => json(200, { url: idpUrl, attemptId: proofAttemptId }),
    })

    // The first visit loads the signed-in shell and lazy settings route before fetching providers.
    const test = await screen.findByRole(
      'button',
      { name: `Test provider ${draft.displayName}` },
      { timeout: 3000 },
    )
    expect(screen.getAllByRole('button', { name: /^Test provider / })).toEqual([test])
    expect(requests.to(testProvider)).toHaveLength(0)
    expect(requests.to(activateProvider)).toHaveLength(0)

    await user.click(test)
    const link = await screen.findByRole('link', { name: 'Continue to identity provider' })
    expect(link.getAttribute('href')).toBe(idpUrl)
    expectTeamWrites(requests.to(testProvider), [{ expectedRevision: draft.revision }])
    await user.click(test)
    await screen.findByRole('link', { name: 'Continue to identity provider' })
    expectTeamWrites(requests.to(testProvider), [
      { expectedRevision: draft.revision },
      { expectedRevision: draft.revision },
    ])
    expect(requests.to(activateProvider)).toHaveLength(0)
  })

  it('requires a passed current-revision receipt and verified domain to offer provider activation', async () => {
    const passed = { ...draft, testStatus: 'passed' }
    const noDomain = {
      ...passed,
      id: unlinked.id,
      displayName: 'Unverified identity',
      domains: [{ ...domain, status: 'unknown' }],
    }
    const { requests, user } = showSso({
      [getProviders]: () => page(draft, noDomain),
    })

    await screen.findByRole('button', { name: `Test provider ${draft.displayName}` })
    expect(screen.getByText(/Verification unknown/)).toBeDefined()
    expect(screen.queryByText(/Verify an associated domain/)).toBeNull()
    for (const provider of [draft, noDomain]) {
      const action = screen.getByRole<HTMLButtonElement>('button', {
        name: `Enable provider ${provider.displayName}`,
      })
      expect(action.disabled).toBe(true)
      await user.click(action)
    }
    expect(requests.to(activateProvider)).toHaveLength(0)
  })

  it('enables the displayed provider revision only after the owner confirms', async () => {
    const passed = { ...draft, testStatus: 'passed' }
    let current = passed
    const { requests, user } = showSso({
      [getProviders]: () => page(current),
      [activateProvider]: () => {
        current = { ...passed, enabled: true }
        return json(200, { provider: current })
      },
    })

    await user.click(
      await screen.findByRole('button', { name: `Enable provider ${draft.displayName}` }),
    )
    const confirmation = within(screen.getByRole('group', { name: 'Enable this provider?' }))
    expect(document.activeElement).toBe(confirmation.getByRole('button', { name: 'Cancel' }))
    expect(requests.to(activateProvider)).toHaveLength(0)
    await user.click(confirmation.getByRole('button', { name: 'Enable provider' }))
    await screen.findByRole('button', { name: `Disable provider ${draft.displayName}` })

    expectTeamWrites(requests.to(activateProvider), [
      { expectedRevision: draft.revision, enabled: true },
    ])
  })

  it('lets an administrator test a draft without offering owner-only activation or enforcement', async () => {
    const { requests } = showSso({
      [getProviders]: () => page({ ...draft, testStatus: 'passed' }, enabled),
      ...adminRole,
    })

    await screen.findByRole('button', { name: `Test provider ${draft.displayName}` })
    expect(
      screen.queryByRole('button', { name: /enable provider|disable provider|require sso/i }),
    ).toBeNull()
    expect(requests.to(activateProvider)).toHaveLength(0)
    expect(requests.to(putPolicy)).toHaveLength(0)
  })
})

describe('Team SSO enforcement', () => {
  it.each([
    [
      'sso_recovery_required',
      'A current owner must accept recovery enrollment before you can require SSO.',
    ],
    [
      'sso_test_required',
      'A team owner must pass a test of the current version of an enabled OIDC provider.',
    ],
    ['sso_domain_unverified', 'An enabled OIDC provider with a verified domain is required.'],
    ['sso_disabled', 'Could not change the team’s SSO enforcement.'],
  ])('uses the server decision for %s', async (error, message) => {
    const { requests, user } = showSso({
      [getProviders]: () => page(error === 'sso_disabled' ? saml : enabled),
      [putPolicy]: () =>
        json(error === 'sso_disabled' ? 404 : 409, { error, message: 'Internal details' }),
    })

    await confirm(user, 'Require SSO', 'Require single sign-on for this team?')
    await screen.findByText(message)
    expect(screen.queryByText('Internal details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop requiring SSO' })).toBeNull()
    expectTeamWrites(requests.to(putPolicy), [
      { expectedRevision: policy.policyRevision, requireSso: true, admission: policy.admission },
    ])
    expect(requests.to(sendEmail)).toHaveLength(0)
  })

  it.each([403, 503])('stays neutral while policy loads and then answers %s', async (status) => {
    const pending = later()
    const { requests } = showSso({
      [getProviders]: () => page(enabled),
      [getPolicy]: () => pending.response,
    })
    await waitFor(() => expect(requests.to(getPolicy)).toHaveLength(1))
    const controls = /require sso|requiring sso/i
    expect(screen.getByText('Loading SSO enforcement…').getAttribute('role')).toBe('status')
    expect(screen.queryByRole('button', { name: controls })).toBeNull()
    expect(screen.queryByLabelText('Admission policy')).toBeNull()
    expect(screen.queryByText(/recovery enrollment|pass a test/i)).toBeNull()

    await pending.answer(json(status, { error: 'not_available', message: 'Internal details' }))
    const message =
      status === 403
        ? 'SSO enforcement is unavailable in this team.'
        : 'Could not load SSO enforcement.'
    expect(screen.getByText(message).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('button', { name: controls })).toBeNull()
    expect(screen.queryByLabelText('Admission policy')).toBeNull()
    expect(screen.queryByText(/recovery enrollment|pass a test/i)).toBeNull()
    expect(screen.queryByText('Internal details')).toBeNull()
    expect(requests.to(putPolicy)).toHaveLength(0)
  })

  it('lets an administrator change admission after fresh proof, preserving enforcement', async () => {
    const expected = {
      expectedRevision: policy.policyRevision,
      requireSso: false,
      admission: 'invitation_only',
    }
    const { requests, user } = showSso({
      ...adminRole,
      [putPolicy]: ({ body }) =>
        Object.hasOwn(body as object, 'proofAttemptId')
          ? json(200, {
              ...policy,
              admission: expected.admission,
              policyRevision: policy.policyRevision + 1,
            })
          : challenge('mailbox'),
      [sendEmail]: () => json(202, { status: 'queued' }),
      [consumeEmail]: () => json(200, { status: 'proven' }),
    })

    const admission = await screen.findByLabelText<HTMLSelectElement>('Admission policy')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save admission policy' })
    expect(save.disabled).toBe(true)
    await user.selectOptions(admission, expected.admission)
    expect(requests.to(putPolicy)).toHaveLength(0)
    await user.click(save)
    const next = await verifyEmail(user, await openMailboxPrompt(user))
    await user.click(next)
    await screen.findByText('Admission policy saved.')
    expect(admission.value).toBe(expected.admission)
    expect(save.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Require SSO' })).toBeNull()
    expectTeamWrites(requests.to(putPolicy), [expected, { ...expected, proofAttemptId }])
  })

  it('preserves a future admission mode without offering policy writes', async () => {
    const { requests } = showSso({
      [getPolicy]: () => json(200, { ...policy, admission: 'future_mode' }),
    })
    await screen.findByText('The team’s admission policy is unavailable.')
    expect(screen.queryByLabelText('Admission policy')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Require SSO' })).toBeNull()
    expect(requests.to(putPolicy)).toHaveLength(0)
  })

  it('shows the verified-domain requirement when enabling just-in-time admission is refused', async () => {
    const { requests, user } = showSso({
      [getPolicy]: () => json(200, { ...policy, admission: 'invitation_only' }),
      [putPolicy]: () => json(409, { error: 'sso_domain_unverified' }),
    })
    await user.selectOptions(await screen.findByLabelText('Admission policy'), 'jit')
    await user.click(screen.getByRole('button', { name: 'Save admission policy' }))
    await screen.findByText('Verify a team domain before enabling just-in-time admission.')
    expectTeamWrites(requests.to(putPolicy), [
      { expectedRevision: policy.policyRevision, requireSso: false, admission: 'jit' },
    ])
  })
})

describe('Team identity link retirement', () => {
  it('retires only the selected link generation after consent and fresh proof', async () => {
    const expected = { expectedLinkGeneration: 4 }
    const { requests, user } = showSso(
      {
        [getProviders]: () => page(linkInventory),
        [removeLink]: ({ body }) =>
          Object.hasOwn(body as object, 'proofAttemptId')
            ? new Response(null, { status: 204 })
            : challenge('mailbox'),
        [sendEmail]: () => json(202, { status: 'queued' }),
        [consumeEmail]: () => json(200, { status: 'proven' }),
      },
      linkedMe,
    )
    const selection = await screen.findByLabelText('Identity link')
    expect(within(selection).queryByRole('option', { name: ownLinkId })).toBeNull()
    await user.selectOptions(selection, memberLinkId)
    expect(requests.to(removeLink)).toHaveLength(0)
    await confirm(user, 'Retire identity link', 'Retire this identity link?')
    const next = await verifyEmail(user, await openMailboxPrompt(user))
    await user.click(next)
    await screen.findByText('Identity link retired.')
    expect(screen.queryByRole('option', { name: memberLinkId })).toBeNull()
    expect(screen.getByText(/To link again after retirement/)).toBeDefined()
    expectTeamWrites(requests.to(removeLink), [expected, { ...expected, proofAttemptId }])
  })

  it('explains a denied owner-link retirement without leaking the server message', async () => {
    const { requests, user } = showSso(
      {
        ...adminRole,
        [getProviders]: () => page(linkInventory),
        [removeLink]: () =>
          json(403, { error: 'team_management_access_denied', message: 'Private target details' }),
      },
      linkedMe,
    )
    await user.selectOptions(await screen.findByLabelText('Identity link'), memberLinkId)
    await confirm(user, 'Retire identity link', 'Retire this identity link?')
    await screen.findByText(
      'Could not retire this identity link. Only another team owner can retire an owner’s identity link.',
    )
    expect(screen.queryByText('Private target details')).toBeNull()
    expect(screen.queryByText('Identity link retired.')).toBeNull()
    expect(screen.queryByLabelText('Identity link')).toBeNull()
    expect(screen.queryByRole('heading', { name: proofHeading })).toBeNull()
    expectTeamWrites(requests.to(removeLink), [{ expectedLinkGeneration: 4 }])
  })

  it('keeps the link state unknown when a scoped summary is absent', async () => {
    const { requests } = showSso({ [getProviders]: () => page(enabled) }, linkedMe)
    await screen.findByText('Identity links are unavailable.')
    expect(screen.queryByLabelText('Identity link')).toBeNull()
    expect(screen.queryByText('There are no other identity links for this provider.')).toBeNull()
    expect(requests.to(removeLink)).toHaveLength(0)
  })
})

describe('Fresh SSO administration proof', () => {
  it('queues and consumes the bound mailbox link before retrying the same test intent', async () => {
    const { requests, user } = showSso({
      [testProvider]: ({ body }) =>
        body && typeof body === 'object' && 'proofAttemptId' in body
          ? json(200, { url: idpUrl, attemptId: proofAttemptId })
          : challenge('mailbox'),
      [sendEmail]: () => json(202, { status: 'queued' }),
      [consumeEmail]: () => json(200, { status: 'proven' }),
    })

    await user.click(
      await screen.findByRole('button', { name: `Test provider ${draft.displayName}` }),
    )
    await screen.findByRole('heading', { name: proofHeading })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true)
    expect(requests.to(sendEmail)).toHaveLength(0)
    expect(requests.to(consumeEmail)).toHaveLength(0)
    const link = await openMailboxPrompt(user)
    expectTeamWrites(requests.to(sendEmail), [{ attemptId: proofAttemptId }])
    await user.click(link)
    await user.paste(mailboxLink(enabled.id))
    await user.click(screen.getByRole('button', { name: 'Verify email link' }))
    expect(requests.to(consumeEmail)).toHaveLength(0)

    const next = await verifyEmail(user, link)
    expectTeamWrites(requests.to(consumeEmail), [{ attemptId: proofAttemptId, token }])
    expect(requests.to(testProvider)).toHaveLength(1)
    await user.click(next)
    await screen.findByRole('link', { name: 'Continue to identity provider' })
    expectTeamWrites(requests.to(testProvider), [
      { expectedRevision: draft.revision },
      { expectedRevision: draft.revision, proofAttemptId },
    ])
  })

  it.each([
    { protocol: 'OIDC', flags: { ssoOidcEnabled: true, ssoSamlEnabled: false }, provider: enabled },
    { protocol: 'SAML', flags: { ssoOidcEnabled: false, ssoSamlEnabled: true }, provider: saml },
  ])(
    'uses the viewer’s linked $protocol provider and handles mailbox fallback on the same policy attempt',
    async ({ flags, provider }) => {
      const enforcing = { ...policy, requireSso: true }
      let policyState = enforcing
      let writes = 0
      const { requests, user } = showSso(
        {
          'GET /api/v1/instance': () => json(200, flags),
          [getProviders]: () => page(draft, enabled, unlinked, saml),
          [getPolicy]: () => json(200, policyState),
          [putPolicy]: () => {
            writes += 1
            if (writes === 1) return challenge('sso')
            if (writes === 2) return challenge('mailbox')
            policyState = {
              ...enforcing,
              requireSso: false,
              policyRevision: policy.policyRevision + 1,
            }
            return json(200, policyState)
          },
          [stepUp]: () => json(200, { url: idpUrl, redirect: true }),
          [sendEmail]: () => json(202, { status: 'queued' }),
          [consumeEmail]: () => json(200, { status: 'proven' }),
        },
        {
          ...me,
          sso: {
            requireSso: true,
            attempts: [],
            links: [
              { id: proofAttemptId, providerId: enabled.id, generation: 1 },
              { id: draft.id, providerId: saml.id, generation: 1, protocol: 'saml' },
            ],
            proofs: [],
            providers: [enabled, unlinked, saml].map(({ id, displayName, revision }) => ({
              id,
              displayName,
              revision,
            })),
          },
        },
      )

      await confirm(user, 'Stop requiring SSO', 'Stop requiring single sign-on for this team?')
      await screen.findByRole('heading', { name: proofHeading })
      expect(screen.queryByRole('button', { name: 'Send verification email' })).toBeNull()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(
        true,
      )
      const options = screen.getAllByRole('option')
      expect(options.map((option) => option.textContent)).toContain(provider.displayName)
      expect(options.map((option) => option.textContent)).not.toContain(unlinked.displayName)
      const unavailable = flags.ssoSamlEnabled ? enabled : saml
      expect(options.map((option) => option.textContent)).not.toContain(unavailable.displayName)
      await user.selectOptions(screen.getByLabelText('Identity provider'), provider.id)
      expect(requests.to(stepUp)).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: 'Start SSO verification' }))
      const idp = await screen.findByRole('link', {
        name: 'Open identity provider (opens in a new tab)',
      })
      expect(idp.getAttribute('href')).toBe(idpUrl)
      expect(idp.getAttribute('target')).toBe('_blank')
      expectTeamWrites(requests.to(stepUp), [
        {
          attemptId: proofAttemptId,
          providerId: provider.id,
          intent: 'step_up',
          returnTo: '/app/settings',
        },
      ])
      await user.click(idp)
      await user.click(screen.getByRole('button', { name: 'Continue' }))

      const link = await openMailboxPrompt(user)
      const next = await verifyEmail(user, link)
      await user.click(next)
      await screen.findByRole('button', { name: 'Require SSO' })
      const change = {
        expectedRevision: policy.policyRevision,
        requireSso: false,
        admission: policy.admission,
      }
      expectTeamWrites(requests.to(putPolicy), [
        change,
        { ...change, proofAttemptId },
        { ...change, proofAttemptId },
      ])
      expect(requests.to(stepUp)).toHaveLength(1)
      expect(requests.to(sendEmail).map(({ body }) => body)).toEqual([
        { attemptId: proofAttemptId },
      ])
    },
  )

  it('discards pending proof when switching to another team', async () => {
    const otherTeam = { ...team, id: unlinked.id, name: 'Other team', slug: 'other-team' }
    let active = me
    const { requests, user } = showSso({
      ...organizations([team, otherTeam]),
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: active.organization.id, userId: me.user.id, role: 'owner' }),
      'POST /api/auth/organization/set-active': () => {
        active = { ...me, organization: otherTeam }
        return json(200, otherTeam)
      },
      [getProviders]: ({ headers }) =>
        headers.get('X-Expected-Organization-Id') === team.id ? page(draft) : page(),
      [testProvider]: () => challenge('mailbox'),
      [sendEmail]: () => json(202, { status: 'queued' }),
    })

    await user.click(
      await screen.findByRole('button', { name: `Test provider ${draft.displayName}` }),
    )
    await openMailboxPrompt(user)
    await user.click(screen.getByRole('button', { name: /^Switch space/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Other team/ }))
    await screen.findByText('No identity providers yet.')

    expect(screen.queryByRole('heading', { name: proofHeading })).toBeNull()
    expect(screen.queryByLabelText('Email verification link')).toBeNull()
    expectTeamWrites(requests.to(testProvider), [{ expectedRevision: draft.revision }])
    expect(requests.to(consumeEmail)).toHaveLength(0)
  })
})
