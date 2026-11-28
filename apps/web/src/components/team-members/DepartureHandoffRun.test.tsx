import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { bookingPath } from '../../paths.ts'
import { fakeApi, json, later } from '../../test/fake-api.tsx'
import { DepartureHandoffRunForBooking } from './DepartureHandoffRun.tsx'

const TEAM = '00000000-0000-7000-8000-000000000010'
const VIEWER = '00000000-0000-7000-8000-000000000011'
const FORMER_HOST = '00000000-0000-7000-8000-000000000012'
const RUN = '00000000-0000-7000-8000-000000000013'
const NEXT_RUN = '00000000-0000-7000-8000-000000000017'
const SOURCE = '00000000-0000-7000-8000-000000000014'
const REPLACEMENT = '00000000-0000-7000-8000-000000000015'
const PRIVATE_EMAIL = 'guest@example.test'
const BOOKING = `GET /api/v1/team/bookings/${SOURCE}`
const START = 'POST /api/v1/team/bookings/handoff-runs'
const READ = `GET /api/v1/team/bookings/handoff-runs/${RUN}`
const CONTROL = `POST /api/v1/team/bookings/handoff-runs/${RUN}/control`
const start = 'Start automatic handoff for this departed member'

const host = { userId: FORMER_HOST, name: 'Former host', isCurrentMember: false, timeZone: 'UTC' }
const detail = {
  id: SOURCE,
  hosts: [host],
  departureHandoffEnabled: true,
  attendees: [{ name: 'Guest', email: PRIVATE_EMAIL, timeZone: 'UTC', isBooker: true }],
  start: '2026-12-01T09:00:00Z',
  end: '2026-12-01T09:30:00Z',
  status: 'confirmed',
  isRescheduled: false,
  cancelledAt: null,
  eventType: null,
} as const satisfies Schemas['TeamAdminBookingDetail']

function receipt(state: Schemas['DepartureHandoffRun']['state'] = 'running') {
  return {
    id: RUN,
    departingUserId: FORMER_HOST,
    state,
    failureCode: null,
    items: [
      {
        sourceBookingId: SOURCE,
        offerId: '00000000-0000-7000-8000-000000000016',
        version: 2,
        outcome: state === 'completed' ? 'applied' : state === 'stopped' ? 'stopped' : 'pending',
        replacementBookingId: state === 'completed' ? REPLACEMENT : null,
      },
    ],
  } satisfies Schemas['DepartureHandoffRun']
}

function panel({ viewer = VIEWER, reload = () => {} } = {}) {
  return render(
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <DepartureHandoffRunForBooking
          organizationId={TEAM}
          viewerUserId={viewer}
          bookingId={SOURCE}
          onReload={reload}
        />
      </InterfaceScope>
    </MemoryRouter>,
  )
}

afterEach(() => sessionStorage.clear())

it.each([
  { ...detail, departureHandoffEnabled: undefined },
  { ...detail, hosts: [{ ...host, isCurrentMember: true }] },
  { ...detail, hosts: [{ ...host, isCurrentMember: null }] },
])('hides the run before and unless the loaded detail permits it', async (booking) => {
  const response = later()
  const api = fakeApi({ [BOOKING]: () => response.response })
  panel()
  await waitFor(() => expect(api.to(BOOKING)).toHaveLength(1))
  expect(screen.queryByRole('region', { name: 'Automatic handoff' })).toBeNull()
  await response.answer(json(200, booking))
  expect(screen.queryByRole('region', { name: 'Automatic handoff' })).toBeNull()
  expect(api.calls).toHaveLength(1)
})

it('binds queue writes to the opening team and recovers its receipt on reopening', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(RUN).mockReturnValueOnce(NEXT_RUN)
  const user = userEvent.setup()
  const submission = later()
  let state: Schemas['DepartureHandoffRun']['state'] = 'running'
  const api = fakeApi({
    [BOOKING]: () => json(200, detail),
    [START]: ({ body }) =>
      (body as { runId: string }).runId === RUN
        ? submission.response
        : json(409, { error: 'handoff_run_rate_limited' }),
    [READ]: () => json(200, receipt(state)),
    [CONTROL]: ({ body }) => {
      const action = (body as { action: 'pause' | 'resume' | 'stop' }).action
      state = { pause: 'paused', resume: 'running', stop: 'stopped' }[action] as typeof state
      return json(200, receipt(state))
    },
  })
  const view = panel()
  const startButton = await screen.findByRole('button', { name: start })
  startButton.focus()
  await user.keyboard('{Enter}{Enter}')
  await screen.findByText('Updating automatic handoff…')
  expect(startButton.getAttribute('aria-disabled')).toBe('true')
  expect(api.to(START)).toHaveLength(1)
  expect(api.to(START)[0]?.body).toEqual({ runId: RUN, departingUserId: FORMER_HOST })
  await submission.answer(json(200, receipt()))
  await screen.findByText('Running')
  expect(screen.queryByText(PRIVATE_EMAIL)).toBeNull()
  expect(screen.getByRole('link', { name: 'View original booking' }).getAttribute('href')).toBe(
    bookingPath(SOURCE),
  )

  await user.click(screen.getByRole('button', { name: 'Pause' }))
  await screen.findByText('Paused')
  view.unmount()
  const otherViewer = panel({ viewer: FORMER_HOST })
  await screen.findByRole('button', { name: start })
  expect(api.to(READ)).toHaveLength(0)
  otherViewer.unmount()
  panel()
  await screen.findByText('Paused')
  expect(api.to(READ)).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Resume' }))
  await screen.findByText('Running')
  await user.click(screen.getByRole('button', { name: 'Stop' }))
  const region = screen.getByRole('region', { name: 'Automatic handoff' })
  await within(region).findByText('Stopped', { selector: '[role="status"] p' })
  expect(within(region).getByRole('list').textContent).toContain('Proposal version 2 · Stopped')
  expect(within(region).queryByRole('button', { name: 'Resume' })).toBeNull()
  expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull()
  await user.click(within(region).getByRole('button', { name: start }))
  await within(region).findByRole('alert')
  expect(within(region).getByRole('list').textContent).toContain('Proposal version 2 · Stopped')
  await user.click(within(region).getByRole('button', { name: 'Refresh run receipt' }))
  await waitFor(() => expect(api.to(READ)).toHaveLength(2))
  expect(api.to(CONTROL).map(({ body }) => body)).toEqual([
    { action: 'pause' },
    { action: 'resume' },
    { action: 'stop' },
  ])
  for (const { headers } of api.calls) {
    expect(headers.get('X-Expected-Organization-Id')).toBe(TEAM)
    expect(headers.has('Authorization')).toBe(false)
  }
})

it('recovers an uncertain start with the same run ID and displays an applied item after refresh', async () => {
  const random = vi.spyOn(crypto, 'randomUUID').mockReturnValue(RUN)
  const user = userEvent.setup()
  let attempt = 0
  let refresh = 0
  const api = fakeApi({
    [BOOKING]: () => json(200, detail),
    [START]: () => (++attempt === 1 ? json(500, { error: 'unknown_error' }) : json(200, receipt())),
    [READ]: () =>
      ++refresh === 1
        ? json(404, { error: 'handoff_run_not_found' })
        : json(200, receipt('completed')),
  })
  const view = panel()
  await user.click(await screen.findByRole('button', { name: start }))
  await screen.findByRole('alert')
  view.unmount()
  panel()
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not confirm that automatic handoff started.',
  )
  await user.click(screen.getByRole('button', { name: start }))
  await screen.findByText('Running')
  expect(random).toHaveBeenCalledTimes(1)
  expect(api.to(START).map(({ body }) => body)).toEqual([
    { runId: RUN, departingUserId: FORMER_HOST },
    { runId: RUN, departingUserId: FORMER_HOST },
  ])
  await user.click(screen.getByRole('button', { name: 'Refresh run receipt' }))
  await screen.findByText('Completed')
  expect(screen.getByRole('link', { name: 'View replacement booking' }).getAttribute('href')).toBe(
    bookingPath(REPLACEMENT),
  )
})

it('reports the start cooldown and removes write actions when the team binding changes', async () => {
  const user = userEvent.setup()
  const reload = vi.fn()
  let attempt = 0
  const api = fakeApi({
    [BOOKING]: () => json(200, detail),
    [START]: () =>
      json(409, {
        error: ++attempt === 1 ? 'handoff_run_rate_limited' : 'organization_context_changed',
      }),
  })
  panel({ reload })
  await user.click(await screen.findByRole('button', { name: start }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Wait at least one minute between starting handoff runs.',
  )
  await user.click(screen.getByRole('button', { name: start }))
  await screen.findByText('Your team context changed. Reload before making changes.')
  expect(screen.queryByRole('button', { name: start })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh run receipt' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Reload team' }))
  expect(reload).toHaveBeenCalledOnce()
  expect(api.to(START)).toHaveLength(2)
})
