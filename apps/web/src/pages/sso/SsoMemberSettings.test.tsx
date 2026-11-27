import { BroadcastChannel } from 'node:worker_threads'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App.tsx'
import type { Schemas } from '../../api/client.ts'
import { PATHS } from '../../paths.ts'
import { selectAdminLanguage } from '../../test/account-menu.ts'
import {
  type Call,
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  organizations,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { openMailboxProofChannel } from './member-protocol.ts'

const team = {
  id: '00000000-0000-7000-8000-000000000041',
  name: 'First team',
  slug: 'first-team',
  personal: false,
}
const provider = {
  id: '00000000-0000-7000-8000-000000000042',
  displayName: 'Company identity',
  revision: 3,
}
const samlProvider = { ...provider, protocol: 'saml' as const }
const linked = {
  id: '00000000-0000-7000-8000-000000000043',
  providerId: provider.id,
  generation: 7,
}
const samlLink = { ...linked, protocol: 'saml' as const }
const proofAttemptId = '00000000-0000-7000-8000-000000000044'
const callbackId = '00000000-0000-7000-8000-000000000045'
const anotherAttemptId = '00000000-0000-7000-8000-000000000046'
const token = 'synthetic-mailbox-token'
const authorization = 'https://id.example.test/authorize?state=synthetic'
const linkPath = `/api/v1/team/sso/providers/${provider.id}/link`
const startLink = `POST ${linkPath}`
const unlink = `DELETE ${linkPath}`
const sendEmail = 'POST /api/auth/sso/mailbox-proof/send'
const consumeEmail = 'POST /api/auth/sso/mailbox-proof/consume'
const complete = 'POST /api/auth/sso/oidc/complete'
const proofHeading = 'Confirm your identity before changing SSO settings.'
const finishHeading = 'Confirm your SSO link'
const memberHeading = 'Your team sign-in'
const empty: Schemas['MeSso'] = {
  providers: [],
  links: [],
  attempts: [],
  proofs: [],
  requireSso: false,
}
const teamMe: Schemas['Me'] = {
  ...ME,
  organization: team,
  sso: { ...empty, providers: [provider] },
}

function CurrentHash() {
  return <output data-testid="current-hash">{useLocation().hash}</output>
}

function showSettings({
  viewer = teamMe,
  enabled = true,
  samlEnabled = false,
  hash = '',
  routes = {},
}: {
  viewer?: Schemas['Me']
  enabled?: boolean
  samlEnabled?: boolean
  hash?: string
  routes?: Routes
} = {}) {
  const requests = fakeApi({
    ...signedInAs(viewer),
    ...emptyTeamLists,
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, { ssoOidcEnabled: enabled, ssoSamlEnabled: samlEnabled }),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { organizationId: team.id, userId: viewer.user.id, role: 'member' }),
    ...routes,
  })
  const user = userEvent.setup()
  render(
    <MemoryRouter initialEntries={[`${PATHS.settings}${hash}`]}>
      <App />
      <CurrentHash />
    </MemoryRouter>,
  )
  return { requests, user }
}

function mailboxChallenge() {
  return json(403, {
    error: 'sso_reauthentication_required',
    attemptId: proofAttemptId,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    proofMethods: ['mailbox'],
  } satisfies Schemas['SsoFreshProofChallenge'])
}

function callbackViewer(change?: Partial<Schemas['MeSso']['attempts'][number]>): Schemas['Me'] {
  return {
    ...teamMe,
    sso: {
      ...empty,
      providers: [provider],
      attempts: [
        {
          id: callbackId,
          providerId: provider.id,
          phase: 'completion',
          mailboxProven: true,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          ...change,
        },
      ],
    },
  }
}

const mailRoutes: Routes = {
  [sendEmail]: () => json(202, { status: 'queued' }),
  [consumeEmail]: () => json(200, { status: 'proven' }),
}

type User = ReturnType<typeof userEvent.setup>

async function openConsent(user: User, action: 'Link' | 'Unlink', name = provider.displayName) {
  await user.click(await screen.findByRole('button', { name: `${action} account (${name})` }))
  const group = within(screen.getByRole('group', { name: `${action} this sign-in method?` }))
  const cancel = group.getByRole('button', { name: 'Cancel' })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  return group
}

async function openMailbox(user: User) {
  const heading = await screen.findByRole('heading', { name: proofHeading })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Send verification email' }))
  return screen.findByLabelText('Email verification link')
}

async function pasteMailboxLink(user: User, input: HTMLElement, id = proofAttemptId) {
  await user.click(input)
  await user.paste(`${window.location.origin}/app/mailbox-proof#attempt=${id}&token=${token}`)
  await user.click(screen.getByRole('button', { name: 'Verify email link' }))
}

function expectTeamWrites(calls: Call[], bodies: unknown[]) {
  expect(calls.map(({ body }) => body)).toEqual(bodies)
  for (const { headers } of calls) {
    expect(headers.get('X-Expected-Organization-Id')).toBe(team.id)
    expect(headers.get('Authorization')).toBeNull()
  }
}

describe('Member SSO settings', () => {
  it.each(['OIDC', 'SAML'])('proves the mailbox before %s linking', async (protocol) => {
    const samlEnabled = protocol === 'SAML'
    const { requests, user } = showSettings({
      enabled: !samlEnabled,
      samlEnabled,
      viewer: samlEnabled ? { ...teamMe, sso: { ...empty, providers: [samlProvider] } } : teamMe,
      routes: {
        ...mailRoutes,
        [startLink]: ({ body }) =>
          (body as { proofAttemptId?: string }).proofAttemptId === proofAttemptId
            ? json(200, { url: authorization, attemptId: callbackId })
            : mailboxChallenge(),
      },
    })

    const settings = await screen.findByRole('region', { name: memberHeading })
    expect(within(settings).getByText(/usual sign-in for your personal space/)).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Identity providers' })).toBeNull()
    expect(requests.to(startLink)).toHaveLength(0)
    const first = await openConsent(user, 'Link')
    await user.click(first.getByRole('button', { name: 'Cancel' }))
    expect(requests.to(startLink)).toHaveLength(0)
    const consent = await openConsent(user, 'Link')
    await user.click(consent.getByRole('button', { name: 'Link account' }))
    const input = await openMailbox(user)

    await pasteMailboxLink(user, input, anotherAttemptId)
    await within(settings).findByText(
      'Could not verify that link. Check the link or request a new email.',
    )
    expect(requests.to(consumeEmail)).toHaveLength(0)
    expect(requests.to(startLink)).toHaveLength(1)
    await pasteMailboxLink(user, input)
    await within(settings).findByText('Email verification complete.')
    expect(requests.to(startLink)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    const handoff = await screen.findByRole('link', { name: 'Continue to identity provider' })
    expect(handoff.getAttribute('href')).toBe(authorization)
    expectTeamWrites(requests.to(startLink), [{}, { proofAttemptId }])
    expectTeamWrites(requests.to(sendEmail), [{ attemptId: proofAttemptId }])
    expectTeamWrites(requests.to(consumeEmail), [{ attemptId: proofAttemptId, token }])
    expect(requests.to(complete)).toHaveLength(0)
  })

  it.each(['OIDC', 'SAML'])('unlinks the exact %s generation', async (protocol) => {
    const samlEnabled = protocol === 'SAML'
    let active = {
      ...teamMe,
      sso: {
        ...empty,
        providers: [samlEnabled ? samlProvider : provider],
        links: [samlEnabled ? samlLink : linked],
      },
    }
    const { requests, user } = showSettings({
      viewer: active,
      enabled: !samlEnabled,
      samlEnabled,
      routes: {
        ...mailRoutes,
        'GET /api/v1/me': () => json(200, active),
        [unlink]: ({ body }) => {
          if (!(body as { proofAttemptId?: string }).proofAttemptId) return mailboxChallenge()
          active = { ...active, sso: { ...active.sso, links: [] } }
          return new Response(null, { status: 204 })
        },
      },
    })

    const consent = await openConsent(user, 'Unlink')
    expect(requests.to(unlink)).toHaveLength(0)
    await user.click(consent.getByRole('button', { name: 'Unlink account' }))
    await pasteMailboxLink(user, await openMailbox(user))
    await screen.findByText('Email verification complete.')
    expect(requests.to(unlink)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Sign-in method unlinked.')
    await screen.findByRole('button', { name: `Link account (${provider.displayName})` })

    const target = { linkId: linked.id, expectedLinkGeneration: linked.generation }
    expectTeamWrites(requests.to(unlink), [target, { ...target, proofAttemptId }])
    expect(requests.to(startLink)).toHaveLength(0)
  })

  it('accepts confirmation from the email tab only for the pending attempt and still asks to continue', async () => {
    vi.stubGlobal('BroadcastChannel', BroadcastChannel)
    const { requests, user } = showSettings({
      routes: { ...mailRoutes, [startLink]: mailboxChallenge },
    })
    const consent = await openConsent(user, 'Link')
    await user.click(consent.getByRole('button', { name: 'Link account' }))
    await openMailbox(user)
    const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' })

    const sameBrowserEmail = (id: string) => {
      const hash = new URLSearchParams({ attempt: id, token: 'A'.repeat(43) })
      return within(renderApp(`${PATHS.mailboxProof}#${hash}`).container)
    }
    const unrelated = openMailboxProofChannel(anotherAttemptId)
    if (!unrelated) throw new Error('BroadcastChannel is unavailable')
    try {
      const heardUnrelated = new Promise<void>((resolve) => {
        unrelated.onmessage = () => resolve()
      })
      const otherEmail = sameBrowserEmail(anotherAttemptId)
      await user.click(await otherEmail.findByRole('button', { name: 'Verify email link' }))
      await heardUnrelated
      expect(next.disabled).toBe(true)

      const email = sameBrowserEmail(proofAttemptId)
      const confirm = await email.findByRole('button', { name: 'Verify email link' })
      expect(requests.to(consumeEmail)).toHaveLength(1)
      await user.click(confirm)
      await waitFor(() => expect(next.disabled).toBe(false))
      expect(requests.to(consumeEmail)).toHaveLength(2)
      expectTeamWrites(requests.to(startLink), [{}])
      expect(requests.to(complete)).toHaveLength(0)
    } finally {
      unrelated.close()
    }
  })

  it('scrubs the callback handle and only completes it after the member confirms', async () => {
    let active = callbackViewer()
    const { requests, user } = showSettings({
      viewer: active,
      hash: `#sso-link=${callbackId}`,
      routes: {
        'GET /api/v1/me': () => json(200, active),
        [complete]: () => {
          active = { ...active, sso: { ...empty, providers: [provider], links: [linked] } }
          return Object.defineProperties(new Response(null), {
            redirected: { value: true },
            url: { value: `${window.location.origin}${PATHS.settings}` },
          })
        },
      },
    })

    const heading = await screen.findByRole('heading', { name: finishHeading })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByTestId('current-hash').textContent).toBe('')
    expect(requests.to(complete)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm link' }))

    await screen.findByText('Sign-in method linked.')
    await screen.findByRole('button', { name: `Unlink account (${provider.displayName})` })
    expect(screen.queryByRole('heading', { name: finishHeading })).toBeNull()
    expect(requests.to(complete).map(({ body }) => body)).toEqual([{ attemptId: callbackId }])
    expect(requests.to(startLink)).toHaveLength(0)
  })

  it.each([
    { id: anotherAttemptId },
    { expiresAt: '2020-01-01T00:00:00Z' },
    { phase: 'authorization' },
    { mailboxProven: false },
    { providerId: anotherAttemptId },
  ])('keeps an ineligible or stale callback inert (%j)', async (change) => {
    const { requests } = showSettings({
      viewer: callbackViewer(change),
      hash: `#sso-link=${callbackId}`,
    })

    await screen.findByText('This SSO link request is unavailable. Start again.')
    expect(screen.getByTestId('current-hash').textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Confirm link' })).toBeNull()
    expect(requests.to(complete)).toHaveLength(0)
  })

  it('uses a neutral failure when the server rejects an apparently current callback', async () => {
    const { requests, user } = showSettings({
      viewer: callbackViewer(),
      hash: `#sso-link=${callbackId}`,
      routes: {
        [complete]: () =>
          json(400, { error: 'sso_oidc_completion_invalid', message: 'Internal details' }),
      },
    })

    await user.click(await screen.findByRole('button', { name: 'Confirm link' }))
    await screen.findByText('This SSO link request is unavailable. Start again.')
    expect(screen.queryByText('Internal details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm link' })).toBeNull()
    expect(requests.to(complete)).toHaveLength(1)
  })

  it('retains the explicit link confirmation when completion is rate limited', async () => {
    const { requests, user } = showSettings({
      viewer: callbackViewer(),
      hash: `#sso-link=${callbackId}`,
      routes: { [complete]: () => json(429, { error: 'rate_limited' }) },
    })

    const confirm = await screen.findByRole<HTMLButtonElement>('button', { name: 'Confirm link' })
    await user.click(confirm)
    await screen.findByText('Too many requests. Wait a minute and try again.')
    expect(confirm.disabled).toBe(false)
    expect(requests.to(complete)).toHaveLength(1)
    await user.click(confirm)
    expect(requests.to(complete).map(({ body }) => body)).toEqual([
      { attemptId: callbackId },
      { attemptId: callbackId },
    ])
  })

  it.each([
    // Off, the server sends no summary for a team without stored SSO state.
    { viewer: { ...ME, organization: team }, enabled: false },
    {
      // A hard-off protocol does not project a provider choice or stored SAML links.
      viewer: { ...teamMe, sso: empty },
      enabled: false,
    },
    { viewer: { ...ME, sso: teamMe.sso }, enabled: true },
  ])(
    'keeps ordinary account settings and omits member SSO outside enabled team sessions',
    async ({ viewer, enabled }) => {
      const instance = later()
      const { requests } = showSettings({
        viewer,
        hash: `#sso-link=${callbackId}`,
        routes: { 'GET /api/v1/instance': () => instance.response },
      })
      await screen.findByRole('heading', { name: 'Account' })
      expect(screen.queryByRole('heading', { name: memberHeading })).toBeNull()
      await instance.answer(json(200, { ssoOidcEnabled: enabled, ssoSamlEnabled: false }))
      expect(screen.getByRole('button', { name: 'Save display name' })).toBeDefined()
      expect(screen.queryByRole('heading', { name: memberHeading })).toBeNull()
      expect(screen.getByTestId('current-hash').textContent).toBe('')
      expect(requests.calls.filter(({ path }) => path.includes('/sso/'))).toEqual([])
    },
  )

  it.each([false, true])(
    'can unlink a saved SAML link while SAML is off (OIDC %s)',
    async (enabled) => {
      const oidc = { ...provider, id: anotherAttemptId, displayName: 'OIDC identity' }
      let active = {
        ...teamMe,
        sso: { ...empty, providers: enabled ? [oidc] : [], links: [samlLink] },
      }
      const { requests, user } = showSettings({
        enabled,
        viewer: active,
        routes: {
          ...mailRoutes,
          'GET /api/v1/me': () => json(200, active),
          [unlink]: ({ body }) => {
            if (!(body as { proofAttemptId?: string }).proofAttemptId) return mailboxChallenge()
            active = { ...active, sso: { ...active.sso, links: [] } }
            return new Response(null, { status: 204 })
          },
        },
      })
      const consent = await openConsent(user, 'Unlink', `Identity provider (${samlProvider.id})`)
      expect(screen.getByText(samlLink.id)).toBeDefined()
      expect(
        screen
          .queryAllByRole('button', { name: /^Link account/ })
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(enabled ? [`Link account (${oidc.displayName})`] : [])
      await user.click(consent.getByRole('button', { name: 'Unlink account' }))
      await pasteMailboxLink(user, await openMailbox(user))
      await screen.findByText('Email verification complete.')
      await user.click(screen.getByRole('button', { name: 'Continue' }))
      await waitFor(() => expect(screen.queryByText(samlLink.id)).toBeNull())

      const target = { linkId: samlLink.id, expectedLinkGeneration: samlLink.generation }
      expectTeamWrites(requests.to(unlink), [target, { ...target, proofAttemptId }])
      expect(requests.to(startLink)).toHaveLength(0)
    },
  )

  it('uses only native completion consent for an enabled SAML link', async () => {
    const viewer = callbackViewer()
    if (!viewer.sso) throw new Error('Missing test SSO projection')
    const { requests } = showSettings({
      enabled: false,
      samlEnabled: true,
      viewer: { ...viewer, sso: { ...viewer.sso, providers: [samlProvider] } },
      hash: `#sso-link=${callbackId}`,
    })
    await screen.findByText('This SSO link request is unavailable. Start again.')
    expect(screen.queryByRole('button', { name: 'Confirm link' })).toBeNull()
    expect(requests.to(complete)).toEqual([])
  })

  it('uses neutral unavailable and loading states when the SSO projection cannot be loaded', async () => {
    const reload = later()
    const initial = { ...ME, organization: team }
    let readCount = 0
    const { user } = showSettings({
      viewer: initial,
      routes: {
        'GET /api/v1/me': () => (++readCount === 1 ? json(200, initial) : reload.response),
      },
    })
    const settings = within(await screen.findByRole('region', { name: memberHeading }))
    expect(settings.getByRole('status').textContent).toBe(
      'Your team sign-in settings are unavailable.',
    )
    await user.click(settings.getByRole('button', { name: 'Try again' }))
    await settings.findByRole('status', { name: 'Loading SSO settings…' })
    expect(settings.queryByText('No team sign-in methods are available.')).toBeNull()
    await reload.answer(json(503, { error: 'unavailable' }))
    expect((await settings.findByRole('status')).textContent).toBe('Could not load SSO settings.')
  })

  it('uses neutral unavailable copy for 403 and offers no proof or additional write', async () => {
    const { requests, user } = showSettings({
      routes: { [startLink]: () => json(403, { error: 'forbidden', message: 'Internal details' }) },
    })
    const consent = await openConsent(user, 'Link')
    await user.click(consent.getByRole('button', { name: 'Link account' }))
    const settings = within(screen.getByRole('region', { name: memberHeading }))
    await settings.findByText('Your team sign-in settings are unavailable.')
    expect(settings.queryByText('No team sign-in methods are available.')).toBeNull()
    expect(settings.queryByText('Internal details')).toBeNull()
    expect(settings.queryByRole('button', { name: 'Send verification email' })).toBeNull()
    expectTeamWrites(requests.to(startLink), [{}])
    await selectAdminLanguage(user, 'zh-CN')
    expect(settings.getByRole('status').textContent).toBe('当前无法查看你的团队登录设置。')
  })

  it('discards the original mailbox challenge when switching teams', async () => {
    const other = { ...team, id: anotherAttemptId, name: 'Other team', slug: 'other-team' }
    let active = teamMe
    const { requests, user } = showSettings({
      routes: {
        ...organizations([team, other]),
        ...mailRoutes,
        'GET /api/v1/me': () => json(200, active),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: active.organization.id, userId: ME.user.id, role: 'member' }),
        'POST /api/auth/organization/set-active': () => {
          active = { ...teamMe, organization: other, sso: empty }
          return json(200, other)
        },
        [startLink]: () => mailboxChallenge(),
      },
    })

    const consent = await openConsent(user, 'Link')
    await user.click(consent.getByRole('button', { name: 'Link account' }))
    await openMailbox(user)
    await user.click(screen.getByRole('button', { name: /^Switch space/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Other team/ }))
    await screen.findByText('No team sign-in methods are available.')

    await waitFor(() => expect(screen.queryByRole('heading', { name: proofHeading })).toBeNull())
    expect(screen.queryByLabelText('Email verification link')).toBeNull()
    expectTeamWrites(requests.to(startLink), [{}])
    expect(requests.to(consumeEmail)).toHaveLength(0)
  })
})
