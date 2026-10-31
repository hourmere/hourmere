import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { App } from '../App.tsx'
import { PATHS } from '../paths.ts'
import {
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const TEAM_ME = {
  ...ME,
  organization: { ...ME.organization, name: 'Example team', personal: false },
}
const scrollIntoView = vi.fn()
let originalScroll: PropertyDescriptor | undefined
let focus: MockInstance<HTMLElement['focus']>

beforeEach(() => {
  focus = vi.spyOn(HTMLElement.prototype, 'focus')
  originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView.mockClear(),
  })
})

afterEach(() => {
  vi.useRealTimers()
  if (originalScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

function teamServer() {
  return {
    ...signedInAs(TEAM_ME),
    ...emptyTeamLists,
    ...profile(PROFILE),
    'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
  }
}

function renderSettingsNavigation() {
  return render(
    <MemoryRouter initialEntries={[PATHS.settings]}>
      <App />
      <nav aria-label="Test navigation">
        <Link to={PATHS.apiKeys}>Open keys page</Link>
        <Link to={PATHS.settings}>Open settings top</Link>
        <Link to={`${PATHS.settings}#team-members`}>Open members section</Link>
      </nav>
    </MemoryRouter>,
  )
}

function expectMembersDestination() {
  const section = screen.getByRole('region', { name: 'Team members' })
  const heading = within(section).getByRole('heading', { name: 'Team members' })
  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' })
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(section)
  expect(document.activeElement).toBe(heading)
  expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
  expect(heading.getAttribute('tabindex')).toBe('-1')
}

describe('team members settings destination', () => {
  it('scrolls and focuses the section after delayed session loading while members are still loading', async () => {
    const session = later()
    const members = later()
    fakeApi({
      ...teamServer(),
      'GET /api/v1/me': () => session.response.then((response) => response.clone()),
      'GET /api/auth/organization/list-members': () => members.response,
    })
    renderApp(`${PATHS.settings}#team-members`)
    expect(screen.queryByRole('heading', { name: 'Team members' })).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
    await session.answer(json(200, TEAM_ME))
    await screen.findByText('Loading team members…')
    await waitFor(expectMembersDestination)
    await members.answer(json(200, { members: [], total: 0 }))
    await screen.findByText('No team members found.')
    expectMembersDestination()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('keeps the heading focused after SPA route focus and repeats on same-page anchor navigation', async () => {
    const user = userEvent.setup()
    fakeApi(teamServer())
    renderSettingsNavigation()
    await screen.findByRole('heading', { name: 'Team members' })
    await within(screen.getByRole('region', { name: 'Account' })).findByText('Owner')
    await screen.findByText('No team members found.')
    expect(scrollIntoView).not.toHaveBeenCalled()
    await user.click(screen.getByRole('link', { name: 'Open keys page' }))
    await screen.findByRole('heading', { name: 'API keys', level: 1 })
    focus.mockClear()
    await user.click(screen.getByRole('link', { name: 'Open members section' }))
    await screen.findByRole('heading', { name: 'Team members' })
    await waitFor(expectMembersDestination)
    expect(focus.mock.contexts).toContain(screen.getByRole('main'))
    expect(scrollIntoView).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('link', { name: 'Open settings top' }))
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Open settings top' }))
    await user.click(screen.getByRole('link', { name: 'Open members section' }))
    await waitFor(expectMembersDestination)
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('link', { name: 'Open members section' }))
    await waitFor(expectMembersDestination)
    expect(scrollIntoView).toHaveBeenCalledTimes(3)
  })

  it('cancels pending scroll and focus when navigation changes before the destination is applied', async () => {
    fakeApi(teamServer())
    renderSettingsNavigation()
    await screen.findByText('No team members found.')
    await screen.findByText('No pending invitations on this page.')
    const top = screen.getByRole('link', { name: 'Open settings top' })
    top.focus()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('link', { name: 'Open members section' }))
    fireEvent.click(top)
    act(() => vi.runOnlyPendingTimers())
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(top)
  })

  it('leaves ordinary settings navigation and other hash targets alone', async () => {
    fakeApi(teamServer())
    renderApp(`${PATHS.settings}#account-heading`)
    await screen.findByRole('heading', { name: 'Team members' })
    await screen.findByText('No team members found.')
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(screen.getByRole('heading', { name: 'Team members' }))
  })
})
