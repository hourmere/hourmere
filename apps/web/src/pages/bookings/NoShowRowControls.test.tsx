import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Booking } from '../../api/resources.ts'
import { AppShell, BookingsPage, RequireSession, SessionLayout } from '../../lazy-pages.tsx'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'
import { booking } from '../../test/fixtures.ts'
import { resolveLazy } from '../../test/resolve-lazy.ts'
import { NoShowRowControls } from './NoShowAttendees.tsx'

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, BookingsPage))

const PAST = '/app/bookings?tab=past'
const GRACE = '00000000-0000-7000-8000-0000000000a1'
const ALAN = '00000000-0000-7000-8000-0000000000a2'
const grace = {
  id: GRACE,
  name: 'Grace Hopper',
  email: 'grace@example.com',
  timeZone: 'America/New_York',
  locale: 'en',
  isBooker: true,
  noShowMarkedAt: null,
  noShowMarkedBy: null,
}
const alan = { ...grace, id: ALAN, name: 'Alan Turing', email: 'alan@example.com', isBooker: false }

let next = 0
function held(over: Partial<Booking> = {}): Booking {
  next += 1
  return booking({
    id: `b0000000-0000-7000-8000-0000000001${String(next).padStart(2, '0')}`,
    start: '2020-01-01T10:00:00.000Z',
    end: '2020-01-01T10:30:00.000Z',
    canManageNoShow: true,
    attendees: [grace],
    ...over,
  })
}
const route = (b: Booking, attendee = GRACE) =>
  `PATCH /api/v1/bookings/${b.id}/attendees/${attendee}/no-show`
const marker = (attendeeId: string, noShow: boolean) =>
  json(200, {
    attendeeId,
    noShowMarkedAt: noShow ? '2020-01-01T10:05:00.000Z' : null,
    noShowMarkedBy: ME.user.id,
  })
const echo: Routes[string] = ({ path, body }) =>
  marker(path.split('/')[6] ?? '', (body as { noShow: boolean }).noShow)

function list(bookings: Booking[], routes: Routes = {}) {
  const api = fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/bookings': () => json(200, { data: bookings, nextCursor: null }),
    ...routes,
  })
  renderApp(PAST)
  return api
}
async function row(title: string) {
  const header = await screen.findByRole('rowheader', { name: title })
  const tr = header.closest('tr')
  if (!tr) throw new Error(`Missing row ${title}`)
  return within(tr)
}

describe('no-show controls in the host bookings list', () => {
  it('marks and clears an attendee from the row without opening the booking', async () => {
    const one = held()
    const api = list([one], { [route(one)]: echo })
    const user = userEvent.setup()
    const cells = await row('Intro call')
    const location = screen.getByTestId('location').textContent
    expect(cells.queryByText('No-show')).toBeNull()

    await user.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect(await cells.findByText('No-show')).toBeTruthy()
    expect(cells.getByRole('button', { name: 'Clear no-show for Grace Hopper' })).toBeTruthy()
    expect(screen.getByText('No-show mark updated.').getAttribute('role')).toBe('status')

    await user.click(cells.getByRole('button', { name: 'Clear no-show for Grace Hopper' }))
    expect(
      await cells.findByRole('button', { name: 'Mark Grace Hopper as a no-show' }),
    ).toBeTruthy()
    expect(cells.queryByText('No-show')).toBeNull()

    expect(screen.getByTestId('location').textContent).toBe(location)
    const calls = api.to(route(one))
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v1/bookings/${one.id}/attendees/${GRACE}/no-show`,
      `/api/v1/bookings/${one.id}/attendees/${GRACE}/no-show`,
    ])
    expect(calls.map((call) => call.body)).toEqual([{ noShow: true }, { noShow: false }])
    expect(calls.map((call) => call.headers.get('x-expected-organization-id'))).toEqual([
      ME.organization.id,
      ME.organization.id,
    ])
  })

  it('offers no action on ineligible bookings but keeps historical marks visible', async () => {
    list([
      held({ title: 'Future call', start: '2999-01-01T10:00:00Z', end: '2999-01-01T10:30:00Z' }),
      held({ title: 'Cancelled call', status: 'cancelled', cancelledAt: '2020-01-01T09:00:00Z' }),
      held({ title: 'Imported call', source: 'import' }),
      held({ title: 'Not allowed call', canManageNoShow: false }),
      held({
        title: 'Marked cancelled call',
        status: 'cancelled',
        cancelledAt: '2020-01-01T11:00:00Z',
        attendees: [{ ...grace, noShowMarkedAt: '2020-01-01T10:05:00Z' }],
      }),
    ])
    await row('Future call')
    expect(screen.queryByRole('button', { name: /no-show/ })).toBeNull()
    for (const title of ['Future call', 'Cancelled call', 'Imported call', 'Not allowed call']) {
      expect((await row(title)).queryByRole('list', { name: 'No-shows' })).toBeNull()
    }
    const marked = await row('Marked cancelled call')
    expect(marked.getByRole('list', { name: 'No-shows' })).toBeTruthy()
    expect(marked.getByText('No-show')).toBeTruthy()
  })

  it('gives each attendee their own named control', async () => {
    const both = held({ attendees: [grace, alan] })
    const api = list([both], { [route(both, ALAN)]: echo })
    const cells = await row('Intro call')
    const lines = within(cells.getByRole('list', { name: 'No-shows' })).getAllByRole('listitem')
    expect(lines.map((line) => line.textContent)).toEqual([
      'Grace Hopper Mark no-show',
      'Alan Turing Mark no-show',
    ])
    await userEvent.click(cells.getByRole('button', { name: 'Mark Alan Turing as a no-show' }))
    await cells.findByRole('button', { name: 'Clear no-show for Alan Turing' })
    expect(within(lines[1] as HTMLElement).getByText('No-show')).toBeTruthy()
    expect(within(lines[0] as HTMLElement).queryByText('No-show')).toBeNull()
    expect(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' })).toBeTruthy()
    expect(api.to(route(both, GRACE))).toHaveLength(0)
    expect(api.to(route(both, ALAN)).map((call) => call.body)).toEqual([{ noShow: true }])
  })

  it('keeps the previous state and explains a failed update in the row', async () => {
    const one = held()
    list([one], { [route(one)]: () => json(500, { error: 'internal_error' }) })
    const cells = await row('Intro call')
    await userEvent.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect((await cells.findByRole('alert')).textContent).toBe(
      'Could not update the no-show mark. Refresh the booking and try again.',
    )
    expect(cells.queryByText('No-show')).toBeNull()
    expect(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' })).toBeTruthy()
    expect(screen.queryByText('No-show mark updated.')).toBeNull()
  })

  it('disables every row after the team context changes', async () => {
    const one = held()
    const two = held({ title: 'Second call' })
    const api = list([one, two], {
      [route(one)]: () => json(409, { error: 'organization_context_changed' }),
    })
    const cells = await row('Intro call')
    await userEvent.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
    expect(
      await screen.findByText('Your team context changed. Reload before making changes.'),
    ).toBeTruthy()
    const buttons = screen.getAllByRole('button', { name: 'Mark Grace Hopper as a no-show' })
    expect(buttons).toHaveLength(2)
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(buttons[1] as HTMLElement)
    expect(api.to(route(two))).toHaveLength(0)
    expect(cells.queryByText('No-show')).toBeNull()
  })

  it('sends one request while an update is in flight', async () => {
    const one = held()
    const answer = later()
    const api = list([one], { [route(one)]: () => answer.response })
    const cells = await row('Intro call')
    const button = cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await answer.answer(marker(GRACE, true))
    expect(await cells.findByText('No-show')).toBeTruthy()
    expect(api.to(route(one))).toHaveLength(1)
  })

  it('disables a control clicked before its pending-write subscription is attached', async () => {
    // A page that renders outside act() (a fetch answer) commits before its passive effects
    // run, and the shared pending-write store only subscribes in one of those effects.
    const one = held()
    const answer = later()
    const api = fakeApi({ [route(one)]: () => answer.response })
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      env.IS_REACT_ACT_ENVIRONMENT = false
      const committed = new Promise<HTMLButtonElement>((resolve) => {
        new MutationObserver(() => {
          const button = container.querySelector('button')
          if (button) resolve(button)
        }).observe(container, { childList: true, subtree: true })
      })
      root.render(
        <NoShowRowControls
          booking={one}
          expectedOrganizationId={ME.organization.id}
          onChanged={() => {}}
        />,
      )
      const button = await committed
      env.IS_REACT_ACT_ENVIRONMENT = true
      act(() => button.click())
      expect(button.disabled).toBe(true)
      act(() => button.click())
      await answer.answer(marker(GRACE, true))
      expect(api.to(route(one))).toHaveLength(1)
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true
      act(() => root.unmount())
      container.remove()
    }
  })
})

it('keeps a saved row mark when an already pending next page arrives', async () => {
  const one = held()
  const two = held({ title: 'Next call' })
  const pending = later()
  list([one], {
    'GET /api/v1/bookings': ({ path }) =>
      new URL(path, 'http://test').searchParams.has('cursor')
        ? pending.response
        : json(200, { data: [one], nextCursor: 'next-page' }),
    [route(one)]: echo,
  })
  const cells = await row('Intro call')
  await userEvent.click(screen.getByRole('button', { name: 'Show more bookings' }))
  await userEvent.click(cells.getByRole('button', { name: 'Mark Grace Hopper as a no-show' }))
  await cells.findByRole('button', { name: 'Clear no-show for Grace Hopper' })
  await pending.answer(json(200, { data: [two], nextCursor: null }))
  await row('Next call')
  expect(cells.getByText('No-show')).toBeTruthy()
  expect(cells.getByRole('button', { name: 'Clear no-show for Grace Hopper' })).toBeTruthy()
})
