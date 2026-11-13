import { readFileSync } from 'node:fs'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import { describe, expect, it, vi } from 'vitest'
import * as policy from '../../api/booking-policy.ts'
import * as client from '../../api/client.ts'
import * as errors from '../../api/errors.ts'
import * as breakable from '../../components/BreakableText.tsx'
import * as conflict from '../../components/OrganizationContextConflict.tsx'
import * as hooks from '../../hooks.ts'
import '../../i18n/admin.ts'
import * as runtime from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { compileSourceCopy } from '../../test/compile-source-copy.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { BOOKING_ID, booking as hostBooking } from '../../test/fixtures.ts'
import { NoShowAttendees } from './NoShowAttendees.tsx'

const attendee = {
  id: 'attendee',
  name: 'Visitor',
  email: 'visitor@example.com',
  noShowMarkedAt: null,
}
const booking = {
  id: 'booking',
  start: '2020-01-01T10:00:00Z',
  status: 'confirmed',
  canManageNoShow: true,
  attendees: [attendee],
}
const route = 'PATCH /api/v1/bookings/booking/attendees/attendee/no-show'
function display(
  props: Partial<react.ComponentProps<typeof NoShowAttendees>['booking']> = {},
  Component = NoShowAttendees,
) {
  return render(<Component booking={{ ...booking, ...props }} expectedOrganizationId="team" />)
}

describe('admin no-show controls', () => {
  it('renders the controls on authenticated host booking details', async () => {
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
        json(
          200,
          hostBooking({
            eventTypeId: null,
            start: booking.start,
            canManageNoShow: true,
            attendees: [{ ...attendee, timeZone: 'UTC', locale: 'en', isBooker: true }],
          }),
        ),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    expect(await screen.findByRole('button', { name: 'Mark Visitor as a no-show' })).toBeTruthy()
  })

  it('hides no-show controls on confirmed paid host booking details', async () => {
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () =>
        json(
          200,
          hostBooking({
            eventTypeId: null,
            start: booking.start,
            canManageNoShow: false,
            attendees: [{ ...attendee, timeZone: 'UTC', locale: 'en', isBooker: true }],
          }),
        ),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    expect(await screen.findByText('Visitor')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark Visitor as a no-show' })).toBeNull()
  })

  it('detects removal of the paid-booking guard from the host projection', () => {
    const original = readFileSync('packages/scheduling/src/bookings.ts', 'utf8')
    const expression = original.match(/canManageNoShow:\s*([\s\S]*?),\n\s*}/)?.[1]
    if (!expression) throw new Error('Missing host no-show projection')
    const verify = (text: string) => {
      const canManageNoShow = new Function(
        'r',
        'imported',
        `
        const host = { now: () => Temporal.Instant.from('2026-11-01T10:00:00Z') };
        const toInstant = (date) => Temporal.Instant.from(date.toISOString());
        return ${text};
      `,
      )(
        {
          id: 'paid',
          status: 'confirmed',
          start_at: new Date(booking.start),
          payment_hold_expires_at: new Date(booking.start),
        },
        new Set(),
      )
      const view = display({ canManageNoShow })
      try {
        expect(screen.queryByRole('button')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    const guard = 'r.payment_hold_expires_at === null &&'
    expect(expression.split(guard)).toHaveLength(2)
    verify(expression)
    expect(() => verify(expression.replace(guard, ''))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verify(expression)
  })

  it.each([
    ['en', 'Mark Visitor as a no-show', 'Clear no-show for Visitor', 'No-show mark updated.'],
    ['zh-CN', '将 Visitor 标记为未出席', '清除 Visitor 的未出席标记', '未出席标记已更新。'],
  ] as const)(
    'marks and clears one attendee in %s with organization protection',
    async (locale, mark, clear, saved) => {
      chooseLanguage(locale)
      const api = fakeApi({
        [route]: ({ body }) =>
          json(200, {
            attendeeId: attendee.id,
            noShowMarkedAt: (body as { noShow: boolean }).noShow ? '2020-01-01T10:01:00Z' : null,
            noShowMarkedBy: 'host',
          }),
      })
      display({ attendees: [attendee, { ...attendee, id: 'guest', name: 'Guest' }] })
      await userEvent.click(screen.getByRole('button', { name: mark }))
      expect(screen.getByRole('status').textContent).toBe(saved)
      const guestRow = screen.getByText('Guest').closest('li')
      if (!guestRow) throw new Error('Missing guest row')
      expect(within(guestRow).queryByText(locale === 'en' ? 'No-show' : '未出席')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: clear }))
      expect(screen.getByRole('button', { name: mark })).toBeTruthy()
      expect(api.to(route).map((call) => call.body)).toEqual([{ noShow: true }, { noShow: false }])
      expect(
        api.to(route).every((call) => call.headers.get('x-expected-organization-id') === 'team'),
      ).toBe(true)
    },
  )

  it.each([
    { canManageNoShow: undefined },
    { canManageNoShow: false },
    { start: '2999-01-01T00:00:00Z' },
    { status: 'cancelled' },
    { source: 'import' },
    { managementPolicy: 'local_only_read_only' },
  ])('does not offer actions for ineligible booking %j', (props) => {
    display(props)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('allows marking strictly after the scheduled start across the DST fallback boundary', () => {
    const start = '2026-11-01T01:30:00-07:00'
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(start))
    const view = display({ start })
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()
    now.mockReturnValue(Date.parse(start) + 1)
    display({ start })
    expect(screen.getByRole('button', { name: 'Mark Visitor as a no-show' })).toBeTruthy()
  })

  it('preserves historical marks on cancelled bookings without actions', () => {
    display({
      status: 'cancelled',
      attendees: [{ ...attendee, noShowMarkedAt: '2020-01-01T10:01:00Z' }],
    })
    expect(screen.getByText('No-show')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the prior state after a server refusal and offers neutral recovery', async () => {
    fakeApi({ [route]: () => json(403, { error: 'forbidden' }) })
    display()
    await userEvent.click(screen.getByRole('button', { name: 'Mark Visitor as a no-show' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not update the no-show mark. Refresh the booking and try again.',
    )
    expect(screen.queryByText('No-show')).toBeNull()
  })
})

const source = readFileSync('apps/web/src/pages/bookings/NoShowAttendees.tsx', 'utf8')
function copy(text: string): typeof NoShowAttendees {
  const code = compileSourceCopy('apps/web/src/pages/bookings/NoShowAttendees.tsx', text, {
    loader: 'tsx',
    format: 'cjs',
    jsxFactory: 'reactRuntime.createElement',
  })
  const dependencies: Record<string, unknown> = {
    react,
    '../../api/booking-policy.ts': policy,
    '../../api/client.ts': client,
    '../../api/errors.ts': errors,
    '../../components/BreakableText.tsx': breakable,
    '../../components/OrganizationContextConflict.tsx': conflict,
    '../../hooks.ts': hooks,
    '../../i18n/runtime.tsx': runtime,
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'reactRuntime', code)(
    (name: string) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(name)
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return (module.exports as { NoShowAttendees: typeof NoShowAttendees }).NoShowAttendees
}

describe('no-show source-copy mutation controls', () => {
  it.each([
    ['permission', 'booking.canManageNoShow === true', { canManageNoShow: undefined }],
    ['import policy', '!isReadOnlyBooking(booking)', { source: 'import' }],
    ['cancellation', "booking.status === 'confirmed'", { status: 'cancelled' }],
    [
      'start boundary',
      'new Date(booking.start).getTime() < Date.now()',
      { start: '2999-01-01T00:00:00Z' },
    ],
  ] as const)('detects removal of %s guard', (_, before, props) => {
    function assertion(text: string) {
      const view = display(props, copy(text))
      try {
        expect(screen.queryByRole('button')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    expect(source.split(before)).toHaveLength(2)
    assertion(source)
    expect(() => assertion(source.replace(before, 'true'))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertion(source)
  })
})

it('detects removal of the expected-organization write protection', async () => {
  async function assertion(text: string) {
    const api = fakeApi({
      [route]: () =>
        json(200, {
          attendeeId: attendee.id,
          noShowMarkedAt: '2020-01-01T10:01:00Z',
          noShowMarkedBy: 'host',
        }),
    })
    const view = display({}, copy(text))
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Mark Visitor as a no-show' }))
      expect(api.to(route)[0]?.headers.get('x-expected-organization-id')).toBe('team')
    } finally {
      view.unmount()
    }
  }
  const before = "headers: { 'X-Expected-Organization-Id': expectedOrganizationId },"
  expect(source.split(before)).toHaveLength(2)
  await assertion(source)
  await expect(assertion(source.replace(before, 'headers: {},'))).rejects.toMatchObject({
    name: 'AssertionError',
  })
  await assertion(source)
})
