import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as conferenceUrl from '@hourmere/core/conference-url'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import * as react from 'react'
import * as router from 'react-router'
import { describe, expect, it } from 'vitest'
import * as policy from '../api/booking-policy.ts'
import * as client from '../api/client.ts'
import * as errors from '../api/errors.ts'
import type { Booking } from '../api/resources.ts'
import * as breakable from '../components/BreakableText.tsx'
import * as conference from '../components/ConferenceNotice.tsx'
import * as copyButton from '../components/CopyButton.tsx'
import * as forms from '../components/forms.tsx'
import * as conflict from '../components/OrganizationContextConflict.tsx'
import * as pageHeader from '../components/PageHeader.tsx'
import * as flash from '../flash.ts'
import * as format from '../format.ts'
import * as hooks from '../hooks.ts'
import * as formatting from '../i18n/formatting.ts'
import * as runtime from '../i18n/runtime.tsx'
import * as translate from '../i18n/translate.ts'
import * as limits from '../limits.ts'
import * as bookingFormat from '../pages/bookings/booking-format.ts'
import * as calendarCopy from '../pages/bookings/CalendarCopyNotice.tsx'
import * as noShow from '../pages/bookings/NoShowAttendees.tsx'
import * as reschedule from '../pages/bookings/RescheduleBooking.tsx'
import * as paths from '../paths.ts'
import { fakeApi, json } from '../test/fake-api.tsx'
import { booking, managed } from '../test/public-fixtures.ts'
import * as text from '../text.ts'
import * as unsaved from '../unsaved-changes.tsx'
import * as calendar from './AddToCalendar.tsx'
import * as publicApi from './api.ts'
import * as publicDetails from './BookingDetails.tsx'
import * as publicEnv from './env.ts'
import * as ics from './ics.ts'
import * as publicLayout from './PublicLayout.tsx'
import * as publicPaths from './paths.ts'
import * as publicPicker from './SlotPicker.tsx'
import * as publicTime from './time.ts'
import * as publicValidation from './validation.ts'
import * as visitorZone from './visitor-time-zone.ts'

function sourceCopy<T>(path: string, before: string, after: string): T {
  const original = readFileSync(path, 'utf8')
    .replace('function BookingView(', 'export function BookingView(')
    .replace('function ManageBooking({', 'export function ManageBooking({')
  expect(original.includes(before), 'mutation must match source').toBe(true)
  const code = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs';import {transformSync} from 'esbuild';process.stdout.write(transformSync(readFileSync(0,'utf8'),{loader:'tsx',format:'cjs',jsxFactory:'reactRuntime.createElement',jsxFragment:'reactRuntime.Fragment'}).code)",
    ],
    { input: original.replaceAll(before, after), encoding: 'utf8' },
  )
  const dependencies: Record<string, unknown> = {
    react,
    'react-router': router,
    '../../format.ts': format,
    '../../hooks.ts': hooks,
    '../../flash.ts': flash,
    '../../i18n/formatting.ts': formatting,
    '../../i18n/translate.ts': translate,
    '../../paths.ts': paths,
    '../../limits.ts': limits,
    '../../text.ts': text,
    '../../unsaved-changes.tsx': unsaved,
    '../../components/BreakableText.tsx': breakable,
    '../../components/PageHeader.tsx': pageHeader,
    '../../components/forms.tsx': forms,
    '../../components/ConferenceNotice.tsx': conference,
    './CalendarCopyNotice.tsx': calendarCopy,
    './booking-format.ts': bookingFormat,
    './RescheduleBooking.tsx': reschedule,
    './NoShowAttendees.tsx': noShow,
    '@hourmere/core/conference-url': conferenceUrl,
    '../api/booking-policy.ts': policy,
    '../../api/booking-policy.ts': policy,
    '../api/client.ts': client,
    '../../api/client.ts': client,
    '../api/errors.ts': errors,
    '../../api/errors.ts': errors,
    '../i18n/runtime.tsx': runtime,
    '../../i18n/runtime.tsx': runtime,
    '../components/CopyButton.tsx': copyButton,
    './ics.ts': ics,
    '../format.ts': format,
    '../hooks.ts': hooks,
    '../i18n/formatting.ts': formatting,
    '../i18n/translate.ts': translate,
    './AddToCalendar.tsx': calendar,
    './api.ts': publicApi,
    './BookingDetails.tsx': publicDetails,
    './env.ts': publicEnv,
    './PublicLayout.tsx': publicLayout,
    './paths.ts': publicPaths,
    './SlotPicker.tsx': publicPicker,
    './time.ts': publicTime,
    './validation.ts': publicValidation,
    './visitor-time-zone.ts': visitorZone,
    '../components/ConferenceNotice.tsx': conference,

    '../../components/OrganizationContextConflict.tsx': conflict,
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'reactRuntime', code)(
    (name: string) => {
      if (!Object.hasOwn(dependencies, name)) return {} // Imports used only by unrelated page wrappers.
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return module.exports as T
}
const imported = booking({ source: 'import' })
const event = {
  id: 'imported',
  title: 'Busy',
  start: Date.parse(imported.start),
  end: Date.parse(imported.end),
}

function verifyCalendar(module = calendar) {
  render(<module.AddToCalendar booking={imported} event={event} />)
  expect(screen.queryByRole('link', { name: 'Download .ics file' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Google Calendar' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Outlook' })).toBeNull()
}
function verifyManage(module = calendar) {
  render(
    <module.ManageLink
      booking={imported}
      token="synthetic-only"
      intro="Use this link to reschedule or cancel."
    />,
  )
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(document.querySelector('input[value*="#token="]')).toBeNull()
}
function verifyConference(module = conference) {
  render(
    <module.ConferenceNotice
      booking={{
        ...imported,
        conference: { provider: 'zoom', status: 'failed', errorCode: 'provider_unavailable' },
        conferenceCanRetry: true,
      }}
      host
    />,
  )
  expect(screen.queryByRole('region')).toBeNull()
}
function verifyCopy(module = calendarCopy) {
  render(
    <module.CalendarCopyNotice
      booking={{
        ...imported,
        calendarCopy: { status: 'failed', errorCode: 'provider_unavailable', canRetry: true },
      }}
      expectedOrganizationId="test"
      onChange={() => {}}
    />,
  )
  expect(screen.queryByRole('region')).toBeNull()
}

describe('imported browser capabilities', () => {
  it('detects removal of the stale public management read-only guard', async () => {
    async function verify(module: {
      ManageBooking: react.ComponentType<{ token: string; action: 'reschedule' }>
    }) {
      fakeApi({ 'GET /api/v1/bookings/manage': () => json(200, managed({ source: 'import' })) })
      const View = module.ManageBooking
      const view = render(
        <router.MemoryRouter>
          <View token="synthetic-only" action="reschedule" />
        </router.MemoryRouter>,
      )
      try {
        await waitFor(() =>
          expect(
            screen.queryByText(
              'This imported booking is read-only and managed in the original system.',
            ),
          ).not.toBeNull(),
        )
        expect(document.querySelector('form, .reschedule')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    const path = 'apps/web/src/public/ManageBookingPage.tsx'
    const before =
      "if (booking.source === 'import' || booking.managementPolicy === 'local_only_read_only')"
    type Copy = { ManageBooking: react.ComponentType<{ token: string; action: 'reschedule' }> }
    await verify(sourceCopy<Copy>(path, before, before))
    await expect(verify(sourceCopy<Copy>(path, before, 'if (false)'))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it.each(['RescheduleBooking', 'CancelBooking'])(
    'detects removal of the imported %s UI guard',
    (component) => {
      const path = 'apps/web/src/pages/bookings/BookingDetail.tsx'
      const before = `{!readOnly && !cancelled && !started && (\n        <${component}`
      const copy = sourceCopy<{
        BookingView: react.ComponentType<{
          booking: Booking
          questions: []
          timeZone: string
          fromProfile: boolean
          expectedOrganizationId: string
        }>
      }>(path, before, `{!cancelled && !started && (\n        <${component}`)
      const View = copy.BookingView
      render(
        <router.MemoryRouter>
          <unsaved.UnsavedChangesProvider>
            <View
              booking={{ ...imported, start: '2099-11-02T09:00:00Z', end: '2099-11-02T09:30:00Z' }}
              questions={[]}
              timeZone="UTC"
              fromProfile
              expectedOrganizationId="test"
            />
          </unsaved.UnsavedChangesProvider>
        </router.MemoryRouter>,
      )
      expect(() =>
        expect(
          screen.queryByRole('button', {
            name: component === 'CancelBooking' ? 'Cancel booking…' : 'Reschedule',
          }),
        ).toBeNull(),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    },
  )

  it('offers no ICS or calendar creation links', () => verifyCalendar())
  it('offers no new management link even with stale token data', () => verifyManage())
  it('offers no conference retry even with stale provider state', () => verifyConference())
  it('offers no calendar retry even with stale copy state', () => verifyCopy())
  it.each([
    [
      'ICS and calendar creation',
      'apps/web/src/public/AddToCalendar.tsx',
      'if (booking && isReadOnlyBooking(booking)) return null',
      'if (false) return null',
      verifyCalendar,
    ],
    [
      'management link',
      'apps/web/src/public/AddToCalendar.tsx',
      'if (booking && isReadOnlyBooking(booking)) return null',
      'if (false) return null',
      verifyManage,
    ],
    [
      'conference retry',
      'apps/web/src/components/ConferenceNotice.tsx',
      'if (readOnly || !current.conference) return null',
      'if (!current.conference) return null',
      verifyConference,
    ],
    [
      'calendar retry',
      'apps/web/src/pages/bookings/CalendarCopyNotice.tsx',
      'const state = isReadOnlyBooking(booking) ? undefined : booking.calendarCopy',
      'const state = booking.calendarCopy',
      verifyCopy,
    ],
  ] as const)('kills source-copy mutation of %s', (_, path, before, after, verify) => {
    cleanup()
    const copy = sourceCopy<typeof calendar & typeof calendarCopy & typeof conference>(
      path,
      before,
      after,
    )
    expect(() => verify(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
