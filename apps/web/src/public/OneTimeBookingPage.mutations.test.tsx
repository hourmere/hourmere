import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as language from '@hourmere/core/language'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import * as router from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import * as client from '../api/client.ts'
import * as errors from '../api/errors.ts'
import * as conferenceNotice from '../components/ConferenceNotice.tsx'
import * as emailHint from '../components/EmailDeliveryHint.tsx'
import * as zonePicker from '../components/TimeZonePicker.tsx'
import * as format from '../format.ts'
import * as hooks from '../hooks.ts'
import * as duration from '../i18n/duration.ts'
import * as formatting from '../i18n/formatting.ts'
import * as runtime from '../i18n/runtime.tsx'
import * as translate from '../i18n/translate.ts'
import { fakeApi, json, type Routes } from '../test/fake-api.tsx'
import { booking, EVENT, slot } from '../test/public-fixtures.ts'
import * as calendar from './AddToCalendar.tsx'
import * as publicApi from './api.ts'
import * as details from './BookingDetails.tsx'
import * as form from './BookingForm.tsx'
import type { OneTimeBookingPage } from './BookingPage.tsx'
import * as calendarDates from './calendar.ts'
import * as description from './EventDescription.tsx'
import * as embed from './embed-context.ts'
import * as env from './env.ts'
import * as layout from './PublicLayout.tsx'
import * as paths from './paths.ts'
import * as picker from './SlotPicker.tsx'
import * as slotLink from './slot-link.ts'
import * as time from './time.ts'
import * as validation from './validation.ts'
import * as visitorZone from './visitor-time-zone.ts'
import * as waitlistJoin from './WaitlistJoin.tsx'
import * as waitlistLink from './waitlist-link.ts'
import * as waitlistWindow from './waitlist-window.ts'

const TOKEN = 'pAtH_0123456789abcdefghijklmnopqrstuvwxyzAB'
const BASE = `/api/v1/book/${TOKEN}`
const PAGE = `/book/${TOKEN}`
const UNAVAILABLE = 'This booking link is unavailable'
const START = '2026-11-02T14:00:00Z'
const source = readFileSync('apps/web/src/public/BookingPage.tsx', 'utf8')
const apiSource = readFileSync('apps/web/src/public/api.ts', 'utf8')

/** Execute changed production copies; leave repository source untouched. */
function compile<T>(text: string, dependencies: Record<string, unknown>): T {
  const code = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { readFileSync } from 'node:fs'; import { transformSync } from 'esbuild'; process.stdout.write(transformSync(readFileSync(0, 'utf8'), { loader: 'tsx', format: 'cjs', jsxFactory: 'reactRuntime.createElement', jsxFragment: 'reactRuntime.Fragment' }).code)",
    ],
    { input: text, encoding: 'utf8' },
  )
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'reactRuntime', code)(
    (name: string) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected source import ${name}`)
      return dependencies[name]
    },
    module,
    module.exports,
    react,
  )
  return module.exports as T
}

function pageCopy(text = source): typeof OneTimeBookingPage {
  return compile<{ OneTimeBookingPage: typeof OneTimeBookingPage }>(text, {
    '@hourmere/core/language': language,
    react,
    'react-router': router,
    '../components/ConferenceNotice.tsx': conferenceNotice,
    '../components/EmailDeliveryHint.tsx': emailHint,
    '../components/TimeZonePicker.tsx': zonePicker,
    '../format.ts': format,
    '../hooks.ts': hooks,
    '../i18n/duration.ts': duration,
    '../i18n/formatting.ts': formatting,
    '../i18n/runtime.tsx': runtime,
    '../i18n/translate.ts': translate,
    './AddToCalendar.tsx': calendar,
    './api.ts': publicApi,
    './BookingDetails.tsx': details,
    './BookingForm.tsx': form,
    './calendar.ts': calendarDates,
    './EventDescription.tsx': description,
    './embed-context.ts': embed,
    './env.ts': {
      ...env,
      now: () => Date.parse('2026-11-01T04:30:00Z'),
      detectTimeZone: () => 'America/New_York',
      preferredLocale: () => 'en-US',
    },
    './PublicLayout.tsx': layout,
    './paths.ts': paths,
    './SlotPicker.tsx': picker,
    './slot-link.ts': slotLink,
    './time.ts': time,
    './validation.ts': validation,
    './visitor-time-zone.ts': visitorZone,
    './waitlist-link.ts': waitlistLink,
    './waitlist-window.ts': waitlistWindow,
    './WaitlistJoin.tsx': waitlistJoin,
  }).OneTimeBookingPage
}

function apiCopy(text = apiSource) {
  return compile<typeof publicApi>(text, {
    '../api/client.ts': client,
    '../api/errors.ts': errors,
    '../i18n/duration.ts': duration,
    '../i18n/translate.ts': translate,
  })
}

function mutate(text: string, before: string, after: string) {
  expect(text.split(before), 'mutation must match exactly once').toHaveLength(2)
  return text.replace(before, after)
}

function display(Page: typeof OneTimeBookingPage, path = PAGE) {
  return render(
    <runtime.InterfaceScope surface="public">
      <router.MemoryRouter initialEntries={[path]}>
        <router.Routes>
          <router.Route path="/book/:token?" element={<Page />} />
          <router.Route path="/embed/book/:token" element={<Page />} />
        </router.Routes>
      </router.MemoryRouter>
    </runtime.InterfaceScope>,
  )
}

function routes(overrides: Routes = {}): Routes {
  return {
    [`GET ${BASE}`]: () =>
      json(200, {
        eventType: EVENT,
        prefill: { name: 'Prefilled Visitor', email: 'prefilled@example.invalid' },
      }),
    [`GET ${BASE}/slots`]: () => json(200, { data: [slot(START)] }),
    [`POST ${BASE}/bookings`]: () => json(201, { booking: booking() }),
    ...overrides,
  }
}

async function pick() {
  await userEvent.click(
    await screen.findByRole('button', { name: 'Monday, November 2, available' }),
  )
  await userEvent.click(screen.getByRole('button', { name: '9:00 AM' }))
}

async function killed(
  assertion: (text: string) => Promise<void>,
  before: string,
  after: string,
  original = source,
) {
  await assertion(original)
  await expect(assertion(mutate(original, before, after))).rejects.toMatchObject({
    name: 'AssertionError',
  })
  await assertion(original)
}

describe('one-time public protection source-copy controls', () => {
  it.each([
    ['ordinary iframe', 'window.parent !== window', 'false'],
    ['dedicated embed route', "pathname.startsWith('/embed/')", 'false'],
  ])('detects removal of the %s refusal', async (mode, before, after) => {
    async function assertion(text: string) {
      const api = fakeApi(routes())
      const parent =
        mode === 'ordinary iframe'
          ? vi.spyOn(window, 'parent', 'get').mockReturnValue({} as Window)
          : undefined
      const view = display(
        pageCopy(text),
        mode === 'ordinary iframe' ? PAGE : `/embed/book/${TOKEN}`,
      )
      try {
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
        expect(api.calls.some((call) => call.path.startsWith(BASE))).toBe(false)
      } finally {
        view.unmount()
        parent?.mockRestore()
      }
    }
    await killed(assertion, before, after)
  })

  it('detects accepting a query token in place of the path token', async () => {
    async function assertion(text: string) {
      const api = fakeApi(routes())
      const view = display(pageCopy(text), `/book?token=${TOKEN}`)
      try {
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
        expect(api.calls.some((call) => call.path.startsWith(BASE))).toBe(false)
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      '  const { token } = useParams()',
      "  const token = useParams().token ?? new URLSearchParams(useLocation().search).get('token')",
    )
  })

  it('detects resolving a malformed path token', async () => {
    async function assertion(text: string) {
      const api = fakeApi({
        ...routes(),
        'GET /api/v1/book/malformed': () => json(200, { eventType: EVENT, prefill: {} }),
      })
      const view = display(pageCopy(text), '/book/malformed')
      try {
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
        expect(api.calls.some((call) => call.path.startsWith('/api/v1/book/'))).toBe(false)
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, '!/^[A-Za-z0-9_-]{43}$/.test(token)', 'false')
  })

  it.each([
    ['name', "name: prefill?.name ?? ''", "name: ''", 'Your name', 'Prefilled Visitor'],
    ['email', "email: prefill?.email ?? ''", "email: ''", 'Email', 'prefilled@example.invalid'],
  ])('detects removal of the editable %s prefill', async (_, before, after, label, value) => {
    async function assertion(text: string) {
      fakeApi(routes())
      const view = display(pageCopy(text))
      try {
        await pick()
        const input = screen.getByLabelText<HTMLInputElement>(label)
        expect(input.value).toBe(value)
        await userEvent.clear(input)
        await userEvent.type(input, label === 'Email' ? 'other@example.invalid' : 'Other visitor')
        expect(input.value).toBe(label === 'Email' ? 'other@example.invalid' : 'Other visitor')
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, before, after)
  })

  it('detects removal of the neutral resolution failure page', async () => {
    async function assertion(text: string) {
      fakeApi(routes({ [`GET ${BASE}`]: () => json(404, { error: 'one_time_link_not_found' }) }))
      const view = display(pageCopy(text))
      try {
        await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      "if (codeOf(state.error) === 'one_time_link_not_found') return <OneTimeLinkUnavailable />",
      'if (false) return <OneTimeLinkUnavailable />',
    )
  })

  it('detects removal of the neutral race-loser page after submission', async () => {
    async function assertion(text: string) {
      const api = fakeApi(
        routes({
          [`POST ${BASE}/bookings`]: () => json(404, { error: 'one_time_link_not_found' }),
        }),
      )
      const view = display(pageCopy(text))
      try {
        await pick()
        await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }))
        await waitFor(() => expect(api.to(`POST ${BASE}/bookings`)).toHaveLength(1))
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
        expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, " || code === 'one_time_link_not_found'", '')
  })

  it('detects removal of the neutral race-loser page while reading slots', async () => {
    async function assertion(text: string) {
      fakeApi(
        routes({ [`GET ${BASE}/slots`]: () => json(404, { error: 'one_time_link_not_found' }) }),
      )
      const view = display(pageCopy(text))
      try {
        await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
        expect(screen.queryByRole('heading', { name: UNAVAILABLE })).not.toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, "!signal.aborted && codeOf(err) === 'one_time_link_not_found'", 'false')
  })

  it('detects putting a capability into API query parameters', async () => {
    async function assertion(text: string) {
      const api = fakeApi({
        [`GET ${BASE}`]: () => json(200, { eventType: EVENT, prefill: {} }),
        'GET /api/v1/book/redacted': () => json(200, { eventType: EVENT, prefill: {} }),
      })
      await apiCopy(text).getOneTimeBookingPage(TOKEN, new AbortController().signal)
      expect(
        api.calls.every((call) => !new URL(call.path, 'http://x').search.includes(TOKEN)),
      ).toBe(true)
    }
    await killed(
      assertion,
      "api.GET('/api/v1/book/{token}', { params: { path: { token } }, signal })",
      "api.GET('/api/v1/book/{token}', { params: { path: { token: 'redacted' }, query: { token } }, signal })",
      apiSource,
    )
  })

  it('detects reflecting a capability from API error prose', async () => {
    async function assertion(text: string) {
      fakeApi({
        [`GET ${BASE}`]: () =>
          json(400, { error: 'invalid_request', message: `Invalid URL ${TOKEN}` }),
      })
      let error: unknown
      try {
        await apiCopy(text).getOneTimeBookingPage(TOKEN, new AbortController().signal)
      } catch (caught) {
        error = caught
      }
      expect(error instanceof Error).toBe(true)
      expect(error instanceof Error && error.message.includes(TOKEN)).toBe(false)
    }
    const before = apiSource.slice(
      apiSource.indexOf('    const safeError ='),
      apiSource.indexOf('    throw new PublicRequestError'),
    )
    await killed(assertion, before, '    const safeError = error\n', apiSource)
  })
})
