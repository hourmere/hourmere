import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler, useRef, useState } from 'react'
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router'
import { describe, expect, it } from 'vitest'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { msg } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { type Me, type Notice, SessionProvider, useSession } from '../session.tsx'
import { fakeApi, json, ME, signedIn } from '../test/fake-api.tsx'
import { JoinedTeamNotice } from './JoinedTeamNotice.tsx'

const teamMe: Me = {
  ...ME,
  organization: { id: 'joined-team', name: 'Team Alpha', slug: 'alpha', personal: false },
}
const message = 'You joined Team Alpha.'
const handoff: Notice = {
  message: msg('You joined {team}.', { team: teamMe.organization.name }),
  path: PATHS.eventTypes,
  joinedTeam: { userId: teamMe.user.id, organizationId: teamMe.organization.id },
}

function identity(me: Me) {
  return `${me.user.id}:${me.organization.id}:${me.organization.personal}`
}

function NoticePage({ initialNotice }: { initialNotice: Notice }) {
  const { state, notice, setNotice, refresh } = useSession()
  const [shown, setShown] = useState(true)
  const location = useLocation()
  const navigate = useNavigate()
  if (state.status !== 'signed-in') return <p>Loading session</p>
  return (
    <>
      <output data-testid="current-identity">{identity(state.me)}</output>
      <output data-testid="shared-join-notice">{JSON.stringify(notice)}</output>
      <output data-testid="notice-location">{location.pathname + location.hash}</output>
      {/* Keep this page mounted across /me changes to exercise the notice's own binding. */}
      <div data-testid="notice-page">{shown && <JoinedTeamNotice />}</div>
      <button type="button" onClick={() => setNotice(initialNotice)}>
        Publish join handoff
      </button>
      <button type="button" onClick={() => void refresh()}>
        Refresh session
      </button>
      <button type="button" onClick={() => setShown((previous) => !previous)}>
        Toggle notice
      </button>
      <Link to={`${PATHS.eventTypes}#next`}>Navigate</Link>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  )
}

function BoundedNoticePage({ initialNotice }: { initialNotice: Notice }) {
  const commits = useRef(0)
  return (
    <Profiler
      id="joined-notice"
      onRender={() => {
        // A retained handoff can synchronously loop in an effect, starving timer timeouts.
        expect(++commits.current, 'The join handoff must settle after consumption').toBeLessThan(80)
      }}
    >
      <NoticePage initialNotice={initialNotice} />
    </Profiler>
  )
}

async function open(initialMe = teamMe, initialNotice = handoff) {
  const state = { me: initialMe }
  fakeApi({
    ...signedIn,
    'GET /api/v1/me': () => json(200, state.me),
  })
  render(
    <InterfaceScope surface="admin">
      <MemoryRouter initialEntries={[PATHS.eventTypes]}>
        <SessionProvider>
          <BoundedNoticePage initialNotice={initialNotice} />
        </SessionProvider>
      </MemoryRouter>
    </InterfaceScope>,
  )
  await screen.findByText(identity(initialMe))
  await userEvent.click(screen.getByRole('button', { name: 'Publish join handoff' }))
  return state
}

async function refreshAs(state: { me: Me }, me: Me) {
  state.me = me
  await userEvent.click(screen.getByRole('button', { name: 'Refresh session' }))
  await waitFor(() => expect(screen.getByTestId('current-identity').textContent).toBe(identity(me)))
}

describe('the joined team notice through the session provider', () => {
  it('confirms the team with a status announcement, a next step and a working dismiss action', async () => {
    await open()
    const status = screen.queryByText(message)
    expect(status).not.toBeNull()
    expect(status?.getAttribute('role')).toBe('status')
    expect(
      screen.getByRole('link', { name: 'Review default availability' }).getAttribute('href'),
    ).toBe(PATHS.availability)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.getByTestId('current-identity').textContent).toBe(identity(teamMe))
  })

  it('consumes the pending handoff and cannot replay it after the notice remounts', async () => {
    await open()
    expect(screen.getByText(message)).toBeDefined()
    expect(screen.getByTestId('shared-join-notice').textContent).toBe('null')
    await userEvent.click(screen.getByRole('button', { name: 'Toggle notice' }))
    expect(screen.queryByText(message)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Toggle notice' }))
    expect(screen.queryByText(message)).toBeNull()
  })

  it('clears local confirmation on navigation and cannot revive it on history return', async () => {
    await open()
    expect(screen.getByText(message)).toBeDefined()
    await userEvent.click(screen.getByRole('link', { name: 'Navigate' }))
    expect(screen.getByTestId('notice-location').textContent).toBe(`${PATHS.eventTypes}#next`)
    expect(screen.queryByText(message)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByTestId('notice-location').textContent).toBe(PATHS.eventTypes)
    expect(screen.queryByText(message)).toBeNull()
  })

  it.each([
    ['user', { ...teamMe, user: { ...teamMe.user, id: 'another-user' } }],
    ['team', { ...teamMe, organization: { ...teamMe.organization, id: 'another-team' } }],
    [
      'personal-space flag',
      { ...teamMe, organization: { ...teamMe.organization, personal: true } },
    ],
  ] as const)(
    'drops a consumed notice when the %s changes without a page remount and keeps it gone on return',
    async (_, changedMe) => {
      const state = await open()
      const page = screen.getByTestId('notice-page')
      expect(screen.getByText(message)).toBeDefined()
      await refreshAs(state, changedMe)
      expect(screen.getByTestId('notice-page')).toBe(page)
      expect(screen.queryByText(message)).toBeNull()
      await refreshAs(state, teamMe)
      expect(screen.getByTestId('notice-page')).toBe(page)
      expect(screen.queryByText(message)).toBeNull()
    },
  )

  it.each([
    ['another user', { ...teamMe, user: { ...teamMe.user, id: 'another-user' } }, handoff],
    [
      'another team',
      { ...teamMe, organization: { ...teamMe.organization, id: 'another-team' } },
      handoff,
    ],
    [
      'a personal space',
      { ...teamMe, organization: { ...teamMe.organization, personal: true } },
      handoff,
    ],
    ['another landing page', teamMe, { ...handoff, path: PATHS.availability }],
  ] as const)(
    'discards a pending handoff for %s without showing its message',
    async (_, initialMe, initialNotice) => {
      await open(initialMe, initialNotice)
      expect(screen.queryByText(message)).toBeNull()
      expect(screen.getByTestId('shared-join-notice').textContent).toBe('null')
    },
  )
})
