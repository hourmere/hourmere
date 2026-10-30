import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../App.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { signInPath } from '../next-path.ts'
import { fakeApi, json, later, ME, renderApp, signedIn, signedOut } from '../test/fake-api.tsx'

const id = '00000000-0000-7000-8000-000000000010'
const path = `/app/join?invitationId=${id}`
const lookupRoute = 'GET /api/auth/organization/get-invitation'
const acceptRoute = 'POST /api/auth/organization/accept-invitation'
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

describe('accept invitation entry', () => {
  it('routes signed-out visitors to the safe sign-in flow without fetching invitation details', async () => {
    const api = fakeApi(signedOut)
    renderApp(path)
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(screen.getByTestId('location').textContent).toBe(signInPath(path))
    expect(
      screen.getByText(/Sign in with the email address that received this invitation/),
    ).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Email' }).value).toBe('')
    expect(api.to(lookupRoute)).toHaveLength(0)
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(api.calls.some((call) => call.path.startsWith('/api/v1/public/'))).toBe(false)
  })

  it('looks up the invitation with query id, waits for explicit acceptance, and keeps success after active organization refresh', async () => {
    const user = userEvent.setup()
    let accepted = false
    const pending = later()
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/me': () =>
        json(
          200,
          accepted
            ? {
                ...ME,
                organization: {
                  id: invitation.organizationId,
                  name: 'Team Alpha',
                  slug: 'alpha',
                  personal: false,
                },
              }
            : ME,
        ),
      [lookupRoute]: () => json(200, invitation),
      [acceptRoute]: () => {
        accepted = true
        return pending.response
      },
    })
    renderApp(path)
    await waitFor(() => expect(api.to(lookupRoute)).toHaveLength(1))
    await screen.findByRole('heading', { name: 'Invitation to join Team Alpha' })
    expect(document.title).toBe('Accept invitation · Hourmere')
    expect(api.to(lookupRoute)[0]?.path).toBe(`/api/auth/organization/get-invitation?id=${id}`)
    expect(api.to(acceptRoute)).toHaveLength(0)
    expect(screen.queryByText(invitation.inviterEmail)).toBeNull()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Accept invitation' })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => expect(api.to(acceptRoute)).toHaveLength(1))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Accepting…' }).disabled).toBe(
      true,
    )
    expect(api.to(acceptRoute)[0]?.body).toEqual({ invitationId: id })
    await pending.answer(
      json(200, { invitation: { ...invitation, status: 'accepted' }, member: { id: 'member' } }),
    )
    await waitFor(() => expect(screen.queryByText('You joined Team Alpha.')).not.toBeNull())
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    expect(api.to(lookupRoute)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Go to Hourmere' }).getAttribute('href')).toBe('/app')
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByText('你已加入 Team Alpha。')).toBeDefined()
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it.each(['', '?invitationId=not-a-uuid', `?invitationId=${id}&invitationId=${id}`])(
    'refuses missing, malformed and duplicate identifiers %s without a lookup',
    async (query) => {
      const api = fakeApi(signedIn)
      renderApp(`/app/join${query}`)
      expect((await screen.findByRole('alert')).textContent).toContain(
        'This invitation is unavailable.',
      )
      expect(api.to(lookupRoute)).toHaveLength(0)
      expect(api.to(acceptRoute)).toHaveLength(0)
    },
  )

  it.each([
    [403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION', 'Use the exact email address'],
    [403, 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION', 'Confirm your email address'],
    [400, undefined, 'This invitation is unavailable.'],
    [404, 'INVITATION_NOT_FOUND', 'This invitation is unavailable.'],
  ] as const)(
    'recovers from unavailable or forbidden lookup %s %s without disclosing another address',
    async (status, code, message) => {
      const api = fakeApi({
        ...signedIn,
        [lookupRoute]: () => json(status, { code, message: 'private server prose' }),
      })
      renderApp(path)
      expect((await screen.findByRole('alert')).textContent).toContain(message)
      expect(screen.getByRole('main').textContent).not.toContain('private server prose')
      expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Change account' })).toBeDefined()
      expect(api.to(acceptRoute)).toHaveLength(0)
    },
  )

  it('changes account while retaining the original invitation', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      [lookupRoute]: () => json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
      'POST /api/auth/sign-out': () => json(200, { success: true }),
    })
    renderApp(path)
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Change account' }))
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(screen.getByTestId('location').textContent).toBe(signInPath(path))
    expect(api.to('POST /api/auth/sign-out')).toHaveLength(1)
    expect(api.to(acceptRoute)).toHaveLength(0)
  })

  it('retains the invitation after the session expires during lookup', async () => {
    fakeApi({ ...signedIn, [lookupRoute]: () => json(401, { message: 'Not authenticated' }) })
    renderApp(path)
    await screen.findByRole('heading', { name: 'Sign in to Hourmere' })
    expect(screen.getByTestId('location').textContent).toBe(signInPath(path))
  })

  it('never repeats a failed acceptance automatically and only rechecks after a lost response', async () => {
    const user = userEvent.setup()
    let reads = 0
    const api = fakeApi({
      ...signedIn,
      [lookupRoute]: () =>
        ++reads === 1 ? json(200, invitation) : json(400, { message: 'Invitation not found!' }),
      [acceptRoute]: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Accept invitation' })
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await screen.findByText(
      'Could not confirm acceptance. Check the invitation status before trying again.',
    )
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check invitation status' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('This invitation is unavailable.'),
    )
    expect(api.to(lookupRoute)).toHaveLength(2)
    expect(api.to(acceptRoute)).toHaveLength(1)
  })

  it.each([
    [
      'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
      'Confirm your email address',
    ],
    ['ORGANIZATION_MEMBERSHIP_LIMIT_REACHED', 'This team cannot accept more members.'],
  ])('explains acceptance refusal %s', async (code, message) => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      [lookupRoute]: () => json(200, invitation),
      [acceptRoute]: () => json(403, { code }),
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Accept invitation' })
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    expect((await screen.findByRole('alert')).textContent).toContain(message)
  })

  it('refreshes shared organization context after leaving the page during acceptance', async () => {
    const user = userEvent.setup()
    const pending = later()
    const api = fakeApi({
      ...signedIn,
      [lookupRoute]: () => json(200, invitation),
      [acceptRoute]: () => pending.response,
      'POST /api/v1/mcp-oauth/request': () => json(400, { error: 'invalid_request' }),
    })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Link to="/oauth/authorize?client_id=synthetic">Leave invitation</Link>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Accept invitation' })
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await user.click(screen.getByRole('link', { name: 'Leave invitation' }))
    await screen.findByRole('heading', { name: 'Connect an AI app' })
    await act(async () => pending.answer(json(200, { invitation, member: {} })))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    expect(screen.queryByText('You joined Team Alpha.')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Connect an AI app' })).toBeDefined()
  })

  it('waits for confirmed session context before offering navigation and retries only the read', async () => {
    const user = userEvent.setup()
    let reads = 0
    const context = later()
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? context.response : json(200, ME),
      [lookupRoute]: () => json(200, invitation),
      [acceptRoute]: () => json(200, { invitation, member: {} }),
    })
    renderApp(path)
    await screen.findByRole('button', { name: 'Accept invitation' })
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await screen.findByText('You joined Team Alpha.')
    expect(screen.getByRole('main').querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(screen.getByText('Loading…').getAttribute('role')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Go to Hourmere' })).toBeNull()
    await context.answer(json(500, { error: 'internal_error' }))
    await screen.findByRole('button', { name: 'Try again' })
    expect(screen.queryByRole('link', { name: 'Go to Hourmere' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: 'Go to Hourmere' })
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to('GET /api/v1/me')).toHaveLength(3)
  })

  it('localizes invitation guidance and errors', async () => {
    chooseLanguage('zh-CN')
    fakeApi({
      ...signedIn,
      [lookupRoute]: () => json(403, { code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION' }),
    })
    renderApp(path)
    expect((await screen.findByRole('alert')).textContent).toContain(
      '请使用收到此邀请的完整邮箱地址',
    )
    expect(screen.getByRole('button', { name: '切换账号' })).toBeDefined()
  })

  it('supersedes a pre-acceptance background check and ignores its late old organization', async () => {
    const user = userEvent.setup()
    const background = later()
    let reads = 0
    const teamMe = {
      ...ME,
      organization: {
        id: invitation.organizationId,
        name: 'Team Alpha',
        slug: 'alpha',
        personal: false,
      },
    }
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? background.response : json(200, teamMe),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          id: '00000000-0000-7000-8000-000000000013',
          organizationId: invitation.organizationId,
          userId: ME.user.id,
          role: 'member',
          createdAt: invitation.createdAt,
        }),
      [lookupRoute]: () => json(200, invitation),
      [acceptRoute]: () => json(200, { invitation, member: {} }),
    })
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Link to="/app/settings">Inspect organization</Link>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Accept invitation' })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
    await screen.findByRole('link', { name: 'Go to Hourmere' })
    await background.answer(json(200, ME))
    await user.click(screen.getByRole('link', { name: 'Inspect organization' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe('Team Alpha')
    const account = screen.getByRole('region', { name: 'Account' })
    await within(account).findByText('Member', { exact: true })
    // Both Settings and the shared selector confirm the current membership once.
    expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(2)
    expect(api.to(acceptRoute)).toHaveLength(1)
  })
})
