import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler, StrictMode, useRef } from 'react'
import { BrowserRouter, Link, MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import type { Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS } from '../paths.ts'
import { emptyAccount, fakeApi, json, later, ME, type Routes, signedIn } from '../test/fake-api.tsx'

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T12:00:00Z')))

const id = '00000000-0000-7000-8000-000000000010'
const invitationPath = `${PATHS.join}?invitationId=${id}`
const acceptRoute = 'POST /api/auth/organization/accept-invitation'
const lookupRoute = 'GET /api/auth/organization/get-invitation'
const listRoute = 'GET /api/auth/organization/list'
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
const teamMe: Schemas['Me'] = {
  ...ME,
  organization: {
    id: invitation.organizationId,
    name: invitation.organizationName,
    slug: invitation.organizationSlug,
    personal: false,
  },
}
const member = {
  id: '00000000-0000-7000-8000-000000000013',
  organizationId: invitation.organizationId,
  userId: ME.user.id,
  role: 'member',
  createdAt: invitation.createdAt,
}
const acceptance = () => json(200, { invitation: { ...invitation, status: 'accepted' }, member })
const joinedText = 'You joined Team Alpha.'

function server(overrides: Routes = {}) {
  const state = { me: ME }
  const api = fakeApi({
    ...signedIn,
    ...emptyAccount,
    'GET /api/v1/me': () => json(200, state.me),
    'GET /api/auth/get-session': () =>
      json(200, { user: { ...state.me.user, emailVerified: true } }),
    [lookupRoute]: () => json(200, invitation),
    [listRoute]: () => json(200, [ME.organization]),
    [acceptRoute]: () => {
      state.me = teamMe
      return acceptance()
    },
    'POST /api/auth/organization/set-active': () => {
      state.me = teamMe
      return json(200, teamMe.organization)
    },
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { ...member, organizationId: state.me.organization.id, userId: state.me.user.id }),
    ...overrides,
  })
  return { api, state }
}

function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="notice-location">
        {location.pathname + location.search + location.hash}
      </output>
      <output data-testid="notice-location-key">{location.key}</output>
      <output data-testid="notice-location-state">{JSON.stringify(location.state)}</output>
      <Link to={PATHS.eventTypes}>Inspect event types</Link>
      <Link to={`${PATHS.eventTypes}?view=all`}>Change query</Link>
      <Link to={`${PATHS.eventTypes}#events`}>Change hash</Link>
      <Link to={PATHS.availability}>Leave invitation</Link>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  )
}

// A missing handoff consumption can loop synchronously inside act(), starving timer-based
// timeouts. Bound commits as well as the ordinary findBy/waitFor deadlines below.
function BoundedApp() {
  const commits = useRef(0)
  return (
    <Profiler
      id="invitation-notice"
      onRender={() => {
        expect(++commits.current, 'The join handoff must settle after consumption').toBeLessThan(80)
        // Inspect every commit: a duplicate shell alert may disappear during consumption.
        const confirmations = screen
          .queryAllByRole('alert')
          .filter((alert) =>
            [joinedText, '你已加入 Team Alpha。'].includes(alert.textContent ?? ''),
          )
        expect(
          confirmations,
          'Join confirmations use status, including during handoff',
        ).toHaveLength(0)
      }}
    >
      <App />
    </Profiler>
  )
}

function renderInvitation() {
  return render(
    <MemoryRouter initialEntries={[invitationPath]}>
      <BoundedApp />
      <Navigation />
    </MemoryRouter>,
  )
}

async function join() {
  await userEvent.click(await screen.findByRole('button', { name: 'Join team' }))
  await screen.findByRole('heading', { name: 'Event types', level: 1 })
}

async function joinedNotice() {
  await waitFor(() => expect(screen.queryByText(joinedText)).not.toBeNull(), { timeout: 1000 })
  const status = screen.getByText(joinedText)
  expect(status.getAttribute('role')).toBe('status')
  return status.closest('.notice') as HTMLElement
}

describe('the invitation landing confirmation', () => {
  it.each([
    ['en', 'Join team', 'Event types', joinedText, 'Review default availability', 'Dismiss'],
    ['zh-CN', '加入团队', '活动类型', '你已加入 Team Alpha。', '检查默认可预约时间', '关闭提示'],
  ] as const)(
    'keeps the joined team confirmation with an accessible next step in %s',
    async (language, joinLabel, heading, message, nextStep, dismiss) => {
      chooseLanguage(language)
      const { api } = server()
      renderInvitation()
      await userEvent.click(await screen.findByRole('button', { name: joinLabel }))
      await screen.findByRole('heading', { name: heading, level: 1 })
      await waitFor(() => expect(screen.queryByText(message)).not.toBeNull(), { timeout: 1000 })
      const status = screen.getByText(message)
      expect(status.getAttribute('role')).toBe('status')
      const notice = status.closest('.notice') as HTMLElement
      expect(notice.classList.contains('alert-info')).toBe(true)
      expect(within(notice).getByRole('link', { name: nextStep }).getAttribute('href')).toBe(
        PATHS.availability,
      )
      expect(within(notice).getByRole('button', { name: dismiss })).toBeDefined()
      expect(screen.getByTestId('notice-location').textContent).toBe(PATHS.eventTypes)
      expect(screen.getByTestId('notice-location-state').textContent).toBe('null')
      expect(api.to(acceptRoute)).toHaveLength(1)
      expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    },
  )

  it('keeps the consumed notice when React checks effects in StrictMode', async () => {
    server()
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[invitationPath]}>
          <BoundedApp />
        </MemoryRouter>
      </StrictMode>,
    )
    await join()
    await joinedNotice()
  })

  it('dismisses the notice while keeping the joined space and landing page', async () => {
    server()
    renderInvitation()
    await join()
    await userEvent.click(within(await joinedNotice()).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(joinedText)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
    expect(screen.getByRole('button', { name: /Switch space.*Team Alpha/ })).toBeDefined()
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(screen.queryByText(joinedText)).toBeNull())
  })

  it('opens the existing availability page and never revives the notice when going back', async () => {
    server()
    renderInvitation()
    await join()
    await userEvent.click(
      within(await joinedNotice()).getByRole('link', { name: 'Review default availability' }),
    )
    await screen.findByRole('heading', { name: 'Availability', level: 1 })
    expect(screen.queryByText(joinedText)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(screen.queryByText(joinedText)).toBeNull()
  })

  it.each([
    ['Change query', `${PATHS.eventTypes}?view=all`],
    ['Change hash', `${PATHS.eventTypes}#events`],
  ])('clears the notice on %s and keeps it gone on history return', async (link, destination) => {
    server()
    renderInvitation()
    await join()
    await joinedNotice()
    await userEvent.click(screen.getByRole('link', { name: link }))
    expect(screen.getByTestId('notice-location').textContent).toBe(destination)
    expect(screen.queryByText(joinedText)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('notice-location').textContent).toBe(PATHS.eventTypes)
    expect(screen.queryByText(joinedText)).toBeNull()
  })

  it('clears the notice on a deliberate navigation to the same address', async () => {
    server()
    renderInvitation()
    await join()
    await joinedNotice()
    const oldKey = screen.getByTestId('notice-location-key').textContent
    await userEvent.click(screen.getByRole('link', { name: 'Inspect event types' }))
    expect(screen.getByTestId('notice-location').textContent).toBe(PATHS.eventTypes)
    expect(screen.getByTestId('notice-location-key').textContent).not.toBe(oldKey)
    expect(screen.queryByText(joinedText)).toBeNull()
  })

  it('does not survive an app reload with the browser URL and history entry preserved', async () => {
    const previousUrl = window.location.href
    const previousState: unknown = window.history.state
    window.history.replaceState(null, '', invitationPath)
    const { api } = server()
    try {
      const mounted = render(
        <BrowserRouter>
          <BoundedApp />
        </BrowserRouter>,
      )
      await join()
      await joinedNotice()
      const landingUrl = window.location.href
      const landingState: unknown = window.history.state
      expect(window.location.pathname).toBe(PATHS.eventTypes)
      expect(window.location.search).toBe('')
      expect(JSON.stringify(landingState)).not.toContain('Team Alpha')
      mounted.unmount()
      render(
        <BrowserRouter>
          <BoundedApp />
        </BrowserRouter>,
      )
      await screen.findByRole('heading', { name: 'Event types', level: 1 })
      expect(window.location.href).toBe(landingUrl)
      expect(window.history.state).toEqual(landingState)
      expect(screen.queryByText(joinedText)).toBeNull()
      expect(api.to(acceptRoute)).toHaveLength(1)
    } finally {
      window.history.replaceState(previousState, '', previousUrl)
    }
  })

  it.each(['organization', 'user'] as const)(
    'drops the confirmation when the signed-in %s changes and does not revive it on return',
    async (changed) => {
      const { api, state } = server()
      renderInvitation()
      await join()
      await joinedNotice()
      state.me =
        changed === 'organization'
          ? {
              ...teamMe,
              organization: { ...teamMe.organization, id: 'another-team', name: 'Team Beta' },
            }
          : { ...teamMe, user: { ...ME.user, id: 'another-user', name: 'Grace' } }
      act(() => window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
      await waitFor(() => expect(screen.queryByText(joinedText)).toBeNull())
      state.me = teamMe
      act(() => window.dispatchEvent(new Event('focus')))
      await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(4))
      await screen.findByRole('heading', { name: 'Event types', level: 1 })
      expect(screen.queryByText(joinedText)).toBeNull()
    },
  )

  it('does not describe an existing member opening their team as a new join', async () => {
    const { api } = server({ [listRoute]: () => json(200, [ME.organization, teamMe.organization]) })
    renderInvitation()
    await userEvent.click(await screen.findByRole('button', { name: 'Go to team' }))
    await screen.findByText('You have no event types yet. Create one to start taking bookings.')
    expect(screen.queryByText(joinedText)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Review default availability' })).toBeNull()
    expect(api.to(acceptRoute)).toHaveLength(0)
  })

  it.each([
    ['wrong account', 403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'],
    ['unavailable invitation', 400, 'INVITATION_NOT_FOUND'],
  ])('never carries a success notice from a %s branch', async (_, status, code) => {
    const { api } = server({ [lookupRoute]: () => json(status, { code }) })
    renderInvitation()
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('link', { name: 'Inspect event types' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(screen.queryByText(joinedText)).toBeNull()
    expect(api.to(acceptRoute)).toHaveLength(0)
  })

  it('carries success after a failed confirmation is retried without accepting twice', async () => {
    let reads = 0
    const { api } = server({
      'GET /api/v1/me': () =>
        ++reads === 1
          ? json(200, ME)
          : reads === 2
            ? json(503, { error: 'internal_error' })
            : json(200, teamMe),
    })
    renderInvitation()
    await userEvent.click(await screen.findByRole('button', { name: 'Join team' }))
    await screen.findByRole('alert')
    expect(screen.getByTestId('notice-location').textContent).toBe(invitationPath)
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await joinedNotice()
    expect(api.to(acceptRoute)).toHaveLength(1)
    expect(api.to('GET /api/v1/me')).toHaveLength(3)
  })

  it('does not publish late acceptance confirmation after the invitee leaves the invitation', async () => {
    const confirmation = later()
    let reads = 0
    const { api } = server({
      'GET /api/v1/me': () =>
        ++reads === 1 ? json(200, ME) : reads === 2 ? confirmation.response : json(200, teamMe),
    })
    renderInvitation()
    await userEvent.click(await screen.findByRole('button', { name: 'Join team' }))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(2))
    await userEvent.click(screen.getByRole('link', { name: 'Leave invitation' }))
    await screen.findByRole('heading', { name: 'Availability', level: 1 })
    await confirmation.answer(json(200, teamMe))
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(3))
    expect(screen.getByTestId('notice-location').textContent).toBe(PATHS.availability)
    expect(screen.queryByText(joinedText)).toBeNull()
    await userEvent.click(screen.getByRole('link', { name: 'Inspect event types' }))
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    expect(screen.queryByText(joinedText)).toBeNull()
  })
})
