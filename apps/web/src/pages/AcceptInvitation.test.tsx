import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { signInPath } from '../next-path.ts'
import {
  emptyAccount,
  emptyTeamLists,
  fakeApi,
  instance,
  json,
  later,
  ME,
  type Routes,
  renderApp,
  signedIn,
  signedOut,
} from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))

const id = '00000000-0000-7000-8000-000000000010'
const path = `/app/join?invitationId=${id}`
const identityRoute = 'GET /api/auth/get-session'
const lookupRoute = 'GET /api/auth/organization/get-invitation'
const acceptRoute = 'POST /api/auth/organization/accept-invitation'
const listRoute = 'GET /api/auth/organization/list'
const switchRoute = 'POST /api/auth/organization/set-active'
const invitation = {
  id,
  email: ME.user.email,
  role: 'member',
  organizationId: '00000000-0000-7000-8000-000000000011',
  inviterId: '00000000-0000-7000-8000-000000000012',
  status: 'pending',
  expiresAt: '2030-01-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  organizationName: 'Team Alpha',
  organizationSlug: 'alpha',
  inviterEmail: 'owner@example.invalid',
}
const team = {
  id: invitation.organizationId,
  name: invitation.organizationName,
  slug: invitation.organizationSlug,
  logo: null,
  createdAt: invitation.createdAt,
}
const teamMe: Schemas['Me'] = {
  ...ME,
  organization: { id: team.id, name: team.name, slug: team.slug, personal: false },
}
const membership = {
  id: '00000000-0000-7000-8000-000000000013',
  organizationId: team.id,
  userId: ME.user.id,
  role: 'member',
  createdAt: invitation.createdAt,
}
const acceptance = () =>
  json(200, { invitation: { ...invitation, status: 'accepted' }, member: membership })
const session = (user = ME.user, emailVerified = true) =>
  json(200, { user: { ...user, emailVerified } })
const location = () => screen.getByTestId('location').textContent
const joinButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Join team' })
const noJoinButton = () => expect(screen.queryByRole('button', { name: 'Join team' })).toBeNull()

function server(overrides: Routes = {}) {
  const state = { me: ME }
  const api = fakeApi({
    ...signedIn,
    ...emptyAccount,
    ...emptyTeamLists,
    'GET /api/v1/me': () => json(200, state.me),
    [identityRoute]: () => session(state.me.user),
    [lookupRoute]: () => json(200, invitation),
    [listRoute]: () => json(200, [ME.organization]),
    [acceptRoute]: () => {
      state.me = teamMe
      return acceptance()
    },
    [switchRoute]: () => {
      state.me = teamMe
      return json(200, team)
    },
    'GET /api/auth/organization/get-active-member': () => json(200, membership),
    ...overrides,
  })
  return { api, state }
}

describe('accept invitation entry', () => {
  it('routes signed-out visitors to the safe sign-in flow without fetching invitation details', async () => {
    const api = fakeApi(signedOut)
    renderApp(path)
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe(signInPath(path))
    expect(
      screen.getByText(/Sign in with the email address that received this invitation/),
    ).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Email' }).value).toBe('')
    expect(api.to(identityRoute)).toHaveLength(0)
    expect(api.to(lookupRoute)).toHaveLength(0)
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.calls.some((call) => call.path.startsWith('/api/v1/public/'))).toBe(false)
  })

  it('shows the team and signed-in account without joining on load, focus or language changes', async () => {
    const user = userEvent.setup()
    const pending = later()
    const { api } = server({ [acceptRoute]: () => pending.response })
    renderApp(path)
    await screen.findByRole('heading', { name: 'Invitation to join Team Alpha' })
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(document.title).toBe('Accept invitation · Hourmere')
    expect(screen.getByText(ME.user.email).closest('p')?.textContent).toContain('Signed in as')
    expect(joinButton().disabled).toBe(false)
    expect(api.to(lookupRoute)[0]?.path).toBe(`/api/auth/organization/get-invitation?id=${id}`)
    expect(screen.queryByText(invitation.inviterEmail)).toBeNull()
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByRole('button', { name: '加入团队' })).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.to(switchRoute)).toHaveLength(0)
    expect(location()).toBe(path)
  })

  it('joins only once after confirmation, then lands in the confirmed team context', async () => {
    const pending = later()
    const { api, state } = server({ [acceptRoute]: () => pending.response })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    const button = joinButton()
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => expect(api.to(acceptRoute)).toHaveLength(1))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Accepting…' }).disabled).toBe(
      true,
    )
    expect(api.to(acceptRoute)[0]?.body).toEqual({ invitationId: id })
    state.me = teamMe
    await pending.answer(acceptance())
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(location()).toBe('/app/event-types')
    const switcher = await screen.findByRole('button', {
      name: /Switch space.*Team Alpha.*Member/,
    })
    expect(within(switcher).getByText(team.name)).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to(switchRoute)).toHaveLength(0)
    expect(api.to('GET /api/v1/me')).toHaveLength(2)
  })

  it.each(['', '?invitationId=not-a-uuid', `?invitationId=${id}&invitationId=${id}`])(
    'refuses missing, malformed and duplicate identifiers %s without a lookup',
    async (query) => {
      const { api } = server()
      renderApp(`/app/join${query}`)
      expect((await screen.findByRole('alert')).textContent).toContain(
        'This invitation is unavailable.',
      )
      expect(api.to(identityRoute)).toHaveLength(0)
      expect(api.to(lookupRoute)).toHaveLength(0)
      expect(api.to(acceptRoute)).toHaveLength(0)
      expect(screen.getByRole('link', { name: 'Go to Hourmere' }).getAttribute('href')).toBe('/app')
    },
  )

  it('blocks an unverified client identity before reading or accepting an invitation', async () => {
    const { api } = server({ [identityRoute]: () => session(ME.user, false) })
    renderApp(path)
    await waitFor(() => expect(api.to(identityRoute)).toHaveLength(1))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(api.to(lookupRoute)).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('Confirm your email address')
    noJoinButton()
    expect(screen.getByRole('button', { name: 'Change account' })).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(location()).toBe(path)
  })

  it.each([
    { ...ME.user, id: '00000000-0000-7000-8000-000000000099' },
    { ...ME.user, email: 'another@example.invalid' },
  ])('refuses an identity that does not match the displayed caller (%#)', async (user) => {
    const { api } = server({ [identityRoute]: () => session(user) })
    renderApp(path)
    await screen.findByRole('alert')
    noJoinButton()
    expect(api.to(lookupRoute)).toHaveLength(0)
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(location()).toBe(path)
  })

  it('shows the invited address when a permitted details response identifies another account and never joins', async () => {
    const { api } = server({
      [lookupRoute]: () => json(200, { ...invitation, email: 'invited@example.invalid' }),
    })
    renderApp(path)
    await screen.findByRole('alert')
    expect(screen.getByRole('main').textContent).toContain('invited@example.invalid')
    expect(screen.getByRole('main').textContent).toContain(ME.user.email)
    noJoinButton()
    expect(screen.getByRole('button', { name: 'Change account' })).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.to(switchRoute)).toHaveLength(0)
  })

  it('accepts whole-address case differences', async () => {
    const { api } = server({
      [lookupRoute]: () => json(200, { ...invitation, email: ME.user.email.toUpperCase() }),
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it.each(['ada+team@example.com', 'a.da@example.com'])(
    'does not treat the invitation alias %s as the signed-in email',
    async (email) => {
      const { api } = server({ [lookupRoute]: () => json(200, { ...invitation, email }) })
      renderApp(path)
      await screen.findByRole('alert')
      noJoinButton()
      expect(api.to(acceptRoute)).toHaveLength(0)
    },
  )

  it.each([
    [403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', 'Use the exact email address'],
    [403, 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION', 'Confirm your email address'],
    [400, 'INVITATION_NOT_FOUND', 'This invitation is unavailable.'],
    [404, 'INVITATION_NOT_FOUND', 'This invitation is unavailable.'],
  ] as const)(
    'explains unavailable or forbidden lookup %s %s without echoing server prose',
    async (status, code, message) => {
      const { api } = server({
        [lookupRoute]: () => json(status, { code, message: 'private server prose' }),
      })
      renderApp(path)
      expect((await screen.findByRole('alert')).textContent).toContain(message)
      expect(screen.getByRole('main').textContent).not.toContain('private server prose')
      noJoinButton()
      expect(api.to(acceptRoute)).toHaveLength(0)
    },
  )

  it.each([
    { status: 'canceled' },
    { status: 'rejected' },
    { status: 'accepted' },
    { expiresAt: '2000-01-01T00:00:00Z' },
    { expiresAt: 'not-a-date' },
  ])(
    'offers owner recovery for an unusable details response (%#) without a sign-in loop',
    async (change) => {
      const { api } = server({ [lookupRoute]: () => json(200, { ...invitation, ...change }) })
      renderApp(path)
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Ask the team owner for a new invitation.',
      )
      noJoinButton()
      expect(screen.getByRole('link', { name: 'Go to Hourmere' }).getAttribute('href')).toBe('/app')
      expect(location()).toBe(path)
      expect(api.to(acceptRoute)).toHaveLength(0)
      expect(api.to(switchRoute)).toHaveLength(0)
    },
  )

  it('changes account, preserves email-link callbacks, and returns without joining after sign-in', async () => {
    const user = userEvent.setup()
    const wrongUser = {
      ...ME.user,
      id: '00000000-0000-7000-8000-000000000099',
      email: 'other@example.invalid',
    }
    let current: Schemas['Me'] | null = { ...ME, user: wrongUser }
    let returned = false
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/me': () => (current ? json(200, current) : json(401, { error: 'unauthorized' })),
      [identityRoute]: () => session(current?.user ?? ME.user),
      [lookupRoute]: () =>
        returned
          ? json(200, invitation)
          : json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
      'POST /api/auth/sign-out': () => {
        current = null
        return json(200, { success: true })
      },
      'POST /api/auth/sign-in/magic-link': () => json(200, { status: true }),
    })
    renderApp(path)
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Change account' }))
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe(signInPath(path))
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(1)
    await user.type(screen.getByRole('textbox', { name: 'Email' }), ME.user.email)
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    await screen.findByRole('heading', { name: 'Check your email' })
    expect(api.to('POST /api/auth/sign-in/magic-link')[0]?.body).toEqual({
      email: ME.user.email,
      callbackURL: path,
      errorCallbackURL: signInPath(path),
    })
    current = ME
    returned = true
    act(() => window.dispatchEvent(new Event('focus')))
    await screen.findByRole('button', { name: 'Join team' })
    expect(location()).toBe(path)
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.to(switchRoute)).toHaveLength(0)
  })

  it.each([
    ['google', 'Continue with Google'],
    ['microsoft', 'Sign in with Microsoft'],
  ] as const)(
    'keeps the invitation in %s callbacks after changing accounts',
    async (provider, name) => {
      const user = userEvent.setup()
      const { api } = server({
        ...instance({ google: true, microsoft: true }),
        [lookupRoute]: () => json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
        'POST /api/auth/sign-out': () => json(200, { success: true }),
        'POST /api/auth/sign-in/social': () =>
          json(200, { url: 'https://provider.invalid/sign-in' }),
      })
      renderApp(path)
      await screen.findByRole('alert')
      await user.click(screen.getByRole('button', { name: 'Change account' }))
      await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
      await user.click(await screen.findByRole('button', { name }))
      await waitFor(() => expect(goTo).toHaveBeenCalledWith('https://provider.invalid/sign-in'))
      expect(api.to('POST /api/auth/sign-in/social')[0]?.body).toEqual({
        provider,
        callbackURL: path,
        errorCallbackURL: signInPath(path),
      })
      expect(api.to(acceptRoute)).toHaveLength(0)
    },
  )

  it('keeps the invitation and signed-in account when sign-out fails', async () => {
    const { api } = server({
      [lookupRoute]: () => json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
      'POST /api/auth/sign-out': () => json(503, { code: 'SERVER_UNAVAILABLE' }),
    })
    renderApp(path)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Change account' }))
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Change account' }).disabled,
      ).toBe(false),
    )
    expect(location()).toBe(path)
    expect(screen.getByRole('main').textContent).toContain(ME.user.email)
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(1)
    expect(api.to(acceptRoute)).toHaveLength(0)
  })

  it('retains the invitation after the session expires during lookup', async () => {
    server({ [lookupRoute]: () => json(401, { message: 'Not authenticated' }) })
    renderApp(path)
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(location()).toBe(signInPath(path))
  })

  it('keeps a sign-up refusal in the invitation sign-in flow with an owner recovery step', async () => {
    const api = fakeApi(signedOut)
    renderApp(`${signInPath(path)}&error=SIGNUP_DISABLED`)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This Hourmere instance does not accept new accounts for that email address.',
    )
    expect(screen.getByRole('main').textContent).toMatch(/team owner/)
    expect(screen.getByRole('button', { name: 'Email me a sign-in link' })).toBeDefined()
    await waitFor(() => expect(location()).toBe(signInPath(path)))
    expect(api.to(identityRoute)).toHaveLength(0)
    expect(api.to(lookupRoute)).toHaveLength(0)
    expect(api.to(acceptRoute)).toHaveLength(0)
  })

  it('offers an existing member a deliberate path to the team without another acceptance', async () => {
    const { api } = server({ [listRoute]: () => json(200, [ME.organization, team]) })
    renderApp(path)
    await screen.findByText('You are already a member of Team Alpha.')
    noJoinButton()
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.to(switchRoute)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Go to team' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(location()).toBe('/app/event-types')
    expect(api.to(switchRoute).map((call) => call.body)).toEqual([{ organizationId: team.id }])
    expect(api.to(switchRoute)[0]?.headers.get('X-Expected-Organization-Id')).toBeNull()
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(
      await screen.findByRole('button', { name: /Switch space.*Team Alpha.*Member/ }),
    ).toBeDefined()
  })

  it('recovers an already-member acceptance refusal by reading memberships and never posting acceptance again', async () => {
    let reads = 0
    const { api } = server({
      [listRoute]: () => json(200, ++reads === 1 ? [ME.organization] : [ME.organization, team]),
      [acceptRoute]: () => json(409, { code: 'INVITATION_RECIPIENT_ALREADY_MEMBER' }),
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await screen.findByRole('button', { name: 'Go to team' })
    noJoinButton()
    expect(api.to(acceptRoute)).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Go to team' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to(switchRoute)).toHaveLength(1)
  })

  it('never repeats a failed acceptance automatically and only rechecks after a lost response', async () => {
    let reads = 0
    const { api } = server({
      [lookupRoute]: () =>
        ++reads === 1 ? json(200, invitation) : json(400, { code: 'INVITATION_NOT_FOUND' }),
      [acceptRoute]: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await screen.findByText(
      'Could not confirm acceptance. Check the invitation status before trying again.',
    )
    noJoinButton()
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('This invitation is unavailable.'),
    )
    expect(api.to(lookupRoute)).toHaveLength(2)
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it('recovers a mail-failed invitation refusal after lookup through reads without joining or switching', async () => {
    let unavailable = false
    const { api } = server({
      [lookupRoute]: () =>
        unavailable
          ? json(400, { code: 'INVITATION_NOT_FOUND', message: 'private failure details' })
          : json(200, invitation),
      [acceptRoute]: () => {
        unavailable = true
        return json(400, {
          code: 'INVITATION_NOT_FOUND',
          message: 'private failure details',
        })
      },
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    expect(api.to(acceptRoute)).toHaveLength(0)
    await userEvent.click(joinButton())
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Ask the team owner for a new invitation.',
    )
    noJoinButton()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(api.to(acceptRoute)).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await waitFor(() => expect(api.to(lookupRoute)).toHaveLength(2))
    await screen.findByRole('alert')
    noJoinButton()
    expect(screen.getByRole('main').textContent).not.toContain('private failure details')
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to(switchRoute)).toHaveLength(0)
    expect(location()).toBe(path)
  })

  it.each([
    [
      'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
      'Confirm your email address',
    ],
    ['ORGANIZATION_MEMBERSHIP_LIMIT_REACHED', 'This team cannot accept more members.'],
  ])('explains acceptance refusal %s', async (code, message) => {
    server({ [acceptRoute]: () => json(403, { code }) })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    expect((await screen.findByRole('alert')).textContent).toContain(message)
  })

  it.each(['organization', 'user', 'personal'] as const)(
    'keeps success blocked when confirmation identifies a foreign %s and retries only the read',
    async (mismatch) => {
      let reads = 0
      const wrong =
        mismatch === 'organization'
          ? { ...teamMe, organization: { ...teamMe.organization, id: 'other-team' } }
          : mismatch === 'user'
            ? { ...teamMe, user: { ...ME.user, id: 'another-user' } }
            : { ...teamMe, organization: { ...teamMe.organization, personal: true } }
      const { api } = server({
        'GET /api/v1/me': () => json(200, ++reads === 1 ? ME : reads === 2 ? wrong : teamMe),
      })
      renderApp(path)
      await screen.findByRole('button', { name: 'Join team' })
      await userEvent.click(joinButton())
      await waitFor(() =>
        expect(screen.queryByText('Could not check your session. Please reload.')).not.toBeNull(),
      )
      await screen.findByRole('button', { name: 'Try again' })
      expect(screen.getByText('You joined Team Alpha.')).toBeDefined()
      expect(location()).toBe(path)
      expect(screen.queryByRole('link', { name: 'Go to team' })).toBeNull()
      noJoinButton()
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await screen.findByRole('heading', { name: 'Event types', level: 1 })
      expect(api.to(acceptRoute)).toHaveLength(1)
      expect(api.to(switchRoute)).toHaveLength(0)
      expect(api.to('GET /api/v1/me')).toHaveLength(3)
    },
  )

  it('waits for confirmed session context before navigation and retries only the read after failure', async () => {
    let reads = 0
    const context = later()
    const { api } = server({
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? context.response : json(200, teamMe),
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await screen.findByText('You joined Team Alpha.')
    expect(location()).toBe(path)
    expect(screen.queryByRole('link', { name: 'Go to team' })).toBeNull()
    await context.answer(json(500, { error: 'internal_error' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to(switchRoute)).toHaveLength(0)
    expect(api.to('GET /api/v1/me')).toHaveLength(3)
  })

  it('ignores late old context and defers background checks during the acceptance handoff', async () => {
    const background = later()
    const acceptancePending = later()
    const confirmation = later()
    let reads = 0
    const { api } = server({
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? background.response : confirmation.response,
      [acceptRoute]: () => acceptancePending.response,
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Join team' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await userEvent.click(joinButton())
    await background.answer(json(200, ME))
    act(() => window.dispatchEvent(new Event('focus')))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(api.to('GET /api/v1/me')).toHaveLength(2)
    await acceptancePending.answer(acceptance())
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(api.to('GET /api/v1/me')).toHaveLength(3)
    await confirmation.answer(json(200, teamMe))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(
      await screen.findByRole('button', { name: /Switch space.*Team Alpha.*Member/ }),
    ).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it('refreshes shared organization context after leaving the page during acceptance without navigating', async () => {
    const pending = later()
    const { api, state } = server({
      [acceptRoute]: () => pending.response,
      'POST /api/v1/mcp-oauth/request': () => json(400, { error: 'invalid_request' }),
    })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Link to="/oauth/authorize?client_id=synthetic">Leave invitation</Link>
        <Link to="/app/settings">Inspect organization</Link>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await userEvent.click(screen.getByRole('link', { name: 'Leave invitation' }))
    await screen.findByRole('heading', { name: 'Connect an AI app' })
    state.me = teamMe
    await pending.answer(acceptance())
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    expect(screen.queryByText('You joined Team Alpha.')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Connect an AI app' })).toBeDefined()
    await userEvent.click(screen.getByRole('link', { name: 'Inspect organization' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(team.name)
  })

  it('does not replace a newer deliberate switch when an old invitation confirmation arrives after leaving', async () => {
    const confirmation = later()
    const otherTeam = {
      ...team,
      id: '00000000-0000-7000-8000-000000000099',
      name: 'Team Beta',
      slug: 'beta',
    }
    const otherMe: Schemas['Me'] = {
      ...ME,
      organization: { ...otherTeam, personal: false },
    }
    let reads = 0
    const { api, state } = server({
      'GET /api/v1/me': () => (++reads === 2 ? confirmation.response : json(200, state.me)),
      [listRoute]: () => json(200, [ME.organization, otherTeam]),
      [switchRoute]: () => {
        state.me = otherMe
        return json(200, otherTeam)
      },
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { ...membership, organizationId: state.me.organization.id }),
    })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Link to="/app/settings">Leave invitation</Link>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await userEvent.click(screen.getByRole('link', { name: 'Leave invitation' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    await userEvent.click(screen.getByRole('button', { name: /Switch space Personal/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Team Beta' }))
    await waitFor(() =>
      expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(otherTeam.name),
    )
    await confirmation.answer(json(200, teamMe))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(4))
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeDefined()
    expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(otherTeam.name)
    expect(api.to(switchRoute).map((call) => call.body)).toEqual([{ organizationId: otherTeam.id }])
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it('releases the invitation handoff after leaving so focus can refresh while acceptance is still pending', async () => {
    const pending = later()
    const otherMe: Schemas['Me'] = {
      ...teamMe,
      organization: {
        id: '00000000-0000-7000-8000-000000000099',
        name: 'Team Beta',
        slug: 'beta',
        personal: false,
      },
    }
    const { api, state } = server({
      [acceptRoute]: () => pending.response,
      [listRoute]: () => json(200, [ME.organization, otherMe.organization]),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { ...membership, organizationId: state.me.organization.id }),
    })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Link to="/app/settings">Leave invitation</Link>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Join team' })
    await userEvent.click(joinButton())
    await userEvent.click(screen.getByRole('link', { name: 'Leave invitation' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    state.me = otherMe
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await waitFor(() =>
      expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(
        otherMe.organization.name,
      ),
    )
    expect(api.to(acceptRoute)).toHaveLength(1)
    await pending.answer(acceptance())
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
    expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(
      otherMe.organization.name,
    )
  })

  it('localizes invitation guidance and errors', async () => {
    chooseLanguage('zh-CN')
    server({
      [lookupRoute]: () => json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
    })
    renderApp(path)
    expect((await screen.findByRole('alert')).textContent).toContain(
      '请使用收到此邀请的完整邮箱地址',
    )
    expect(screen.getByRole('button', { name: '切换账号' })).toBeDefined()
  })
})
