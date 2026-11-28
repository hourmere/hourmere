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
const storageKey = `hourmere:departure-handoff-run:${VIEWER}:${TEAM}:${FORMER_HOST}`

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

async function confirmStart(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole('dialog', { name: 'Start automatic handoff?' })
  await user.click(within(dialog).getByRole('button', { name: 'Start automatic handoff' }))
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
    [START]: ({ body }) => {
      const { runId } = body as { runId: string }
      if (runId !== RUN) return json(409, { error: 'handoff_run_rate_limited' })
      expect(sessionStorage.getItem(storageKey)).toBe(JSON.stringify({ id: RUN, started: false }))
      return submission.response
    },
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
  await user.keyboard('{Enter}')
  const startDialog = screen.getByRole('dialog', {
    name: 'Start automatic handoff?',
    description:
      'This run processes up to 10 fully approved bookings, with at least 10 seconds between bookings. You can pause or stop it.',
  })
  const cancelStart = within(startDialog).getByRole('button', { name: 'Cancel' })
  expect(document.activeElement).toBe(cancelStart)
  expect(api.to(START)).toHaveLength(0)
  await user.click(cancelStart)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(startButton)
  expect(api.to(START)).toHaveLength(0)
  expect(sessionStorage.getItem(storageKey)).toBeNull()
  await user.click(startButton)
  await confirmStart(user)
  await screen.findByText('Updating automatic handoff…')
  expect(startButton.getAttribute('aria-disabled')).toBe('true')
  await user.click(startButton)
  expect(screen.queryByRole('dialog')).toBeNull()
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
  const stopButton = screen.getByRole('button', { name: 'Stop' })
  await user.click(stopButton)
  const stopDialog = screen.getByRole('dialog', {
    name: 'Stop automatic handoff?',
    description:
      'Remaining bookings will not be processed. Their original bookings stay unchanged.',
  })
  const cancelStop = within(stopDialog).getByRole('button', { name: 'Cancel' })
  expect(document.activeElement).toBe(cancelStop)
  expect(api.to(CONTROL)).toHaveLength(2)
  await user.click(cancelStop)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(stopButton)
  expect(api.to(CONTROL)).toHaveLength(2)
  await user.click(stopButton)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(stopButton)
  expect(api.to(CONTROL)).toHaveLength(2)
  await user.click(stopButton)
  await user.click(
    within(screen.getByRole('dialog', { name: 'Stop automatic handoff?' })).getByRole('button', {
      name: 'Stop',
    }),
  )
  const region = screen.getByRole('region', { name: 'Automatic handoff' })
  await within(region).findByText('Stopped', { selector: '[role="status"] p' })
  expect(within(region).getByRole('list').textContent).toContain('Proposal version 2 · Stopped')
  expect(within(region).queryByRole('button', { name: 'Resume' })).toBeNull()
  expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull()
  await user.click(within(region).getByRole('button', { name: start }))
  await confirmStart(user)
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
  await confirmStart(user)
  await screen.findByRole('alert')
  view.unmount()
  panel()
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not confirm that automatic handoff started.',
  )
  await user.click(screen.getByRole('button', { name: start }))
  await confirmStart(user)
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
  await confirmStart(user)
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Wait at least one minute between starting handoff runs.',
  )
  await user.click(screen.getByRole('button', { name: start }))
  await confirmStart(user)
  await screen.findByText('Your team context changed. Reload before making changes.')
  expect(screen.queryByRole('button', { name: start })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh run receipt' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Reload team' }))
  expect(reload).toHaveBeenCalledOnce()
  expect(api.to(START)).toHaveLength(2)
})
