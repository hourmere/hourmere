import { readFileSync } from 'node:fs'
import * as language from '@hourmere/core/language'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as react from 'react'
import * as router from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as conferenceNotice from '../components/ConferenceNotice.tsx'
import * as emailHint from '../components/EmailDeliveryHint.tsx'
import * as formComponents from '../components/forms.tsx'
import * as zonePicker from '../components/TimeZonePicker.tsx'
import * as format from '../format.ts'
import * as hooks from '../hooks.ts'
import * as duration from '../i18n/duration.ts'
import * as formatting from '../i18n/formatting.ts'
import * as runtime from '../i18n/runtime.tsx'
import * as translate from '../i18n/translate.ts'
import { compileSourceCopy } from '../test/compile-source-copy.ts'
import { type Call, fakeApi, json, later, type Routes } from '../test/fake-api.tsx'
import { booking, EVENT, slot, slotsAnswer } from '../test/public-fixtures.ts'
import * as calendar from './AddToCalendar.tsx'
import * as publicApi from './api.ts'
import * as details from './BookingDetails.tsx'
import * as form from './BookingForm.tsx'
import type { BookingPage, OneTimeBookingPage } from './BookingPage.tsx'
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

const source = readFileSync('apps/web/src/public/BookingPage.tsx', 'utf8')
const API = '/api/v1/public/ada/intro'
const START = '2026-11-02T14:00:00.000Z'
const NEXT = '2026-11-02T15:00:00.000Z'
const NOW = Date.parse('2026-11-01T04:30:00Z')
const UNAVAILABLE = 'That time is no longer available. Please pick another one.'
const CHECKING = 'Checking the suggested time…'
const UNKNOWN = 'We could not check this time. Please try again.'
const TOKEN = 'x'.repeat(43)
let zone = 'America/New_York'
type Pages = { BookingPage: typeof BookingPage; OneTimeBookingPage: typeof OneTimeBookingPage }
const hint = (start = START, durationMinutes = 30) =>
  `?${new URLSearchParams({ start, durationMinutes: String(durationMinutes) })}`
const query = (call: Call) => new URL(call.path, 'http://x').searchParams
const exact = (call: Call) =>
  query(call).get('start') === START && query(call).get('end') === slot(START).end

beforeEach(() => {
  zone = 'America/New_York'
  window.history.replaceState(null, '', '/')
})

/** Execute changed production copies; leave repository source untouched. */
function compile<T>(file: string, text: string, dependencies: Record<string, unknown>): T {
  const code = compileSourceCopy(file, text, {
    loader: 'tsx',
    format: 'cjs',
    jsxFactory: 'reactRuntime.createElement',
    jsxFragment: 'reactRuntime.Fragment',
  })
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

function pageCopy(text = source): Pages {
  return compile<Pages>('apps/web/src/public/BookingPage.tsx', text, {
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
      now: () => NOW,
      detectTimeZone: () => zone,
      preferredLocale: () => 'en-US',
    },
    './PublicLayout.tsx': layout,
    './paths.ts': paths,
    './SlotPicker.tsx': picker,
    './slot-link.ts': slotLink,
    './time.ts': time,
    './validation.ts': validation,
    './visitor-time-zone.ts': visitorZone,
    './WaitlistJoin.tsx': waitlistJoin,
    './waitlist-link.ts': waitlistLink,
    './waitlist-window.ts': waitlistWindow,
  })
}

function mutate(before: string, after: string) {
  expect(source.split(before), 'mutation must match exactly once').toHaveLength(2)
  return source.replace(before, after)
}

async function killed(assertion: (text: string) => Promise<void>, before: string, after: string) {
  await assertion(source)
  await expect(assertion(mutate(before, after))).rejects.toMatchObject({
    name: 'AssertionError',
  })
  await assertion(source)
}

function Navigation() {
  const navigate = router.useNavigate()
  const location = router.useLocation()
  return (
    <>
      <button type="button" onClick={() => navigate(hint(NEXT))}>
        Next link
      </button>
      <output data-testid="location">{location.pathname + location.search}</output>
    </>
  )
}

function display(text: string, path = `/ada/intro${hint()}`, embedded = false) {
  const { BookingPage: Page, OneTimeBookingPage: OneTime } = pageCopy(text)
  window.history.replaceState(null, '', path)
  return render(
    <runtime.InterfaceScope surface="public">
      <embed.EmbeddedContext.Provider value={embedded}>
        <router.MemoryRouter initialEntries={[path]}>
          <router.Routes>
            <router.Route path="/:handle/:slug" element={<Page />} />
            <router.Route path="/embed/:handle/:slug" element={<Page />} />
            <router.Route
              path="/:handle/:slug/waitlist/:waitlistToken/:suggestedStart/:previewExpiresAt"
              element={<Page />}
            />
            <router.Route path="/book/:token" element={<OneTime />} />
          </router.Routes>
          <Navigation />
        </router.MemoryRouter>
      </embed.EmbeddedContext.Provider>
    </runtime.InterfaceScope>,
  )
}

function routes(overrides: Routes = {}): Routes {
  return {
    [`GET ${API}`]: () => json(200, EVENT),
    [`GET ${API}/slots`]: slotsAnswer([START, NEXT]),
    [`POST ${API}/bookings`]: () => json(201, { booking: booking() }),
    ...overrides,
  }
}

async function settled() {
  await screen.findByRole('heading', { name: EVENT.title })
  await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull())
}

async function fill() {
  await screen.findByRole('heading', { name: 'Your details' })
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Grace Hopper' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace@example.invalid' } })
}

describe('public direct-slot protection source-copy controls', () => {
  it.each([
    [
      'neutral direct-slot status',
      "noticeRole={directFlow ? 'status' : 'alert'}",
      'noticeRole="alert"',
    ],
    ['waitlist offer', 'renderWaitlist={', 'renderWaitlist={false &&'],
  ])('detects losing the %s after an unavailable direct slot', async (_name, before, after) => {
    async function assertion(text: string) {
      fakeApi(
        routes({
          [`GET ${API}`]: () => json(200, { ...EVENT, waitlist: { enabled: true } }),
          [`GET ${API}/slots`]: () => json(200, { data: [] }),
        }),
      )
      const view = display(text)
      try {
        await settled()
        await screen.findByText('No available times this month.')
        expect(screen.queryByText(UNAVAILABLE)?.getAttribute('role')).toBe('status')
        expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeNull()
        expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, before, after)
  })

  it('detects bypassing the fresh exact-interval availability read', async () => {
    async function assertion(text: string) {
      fakeApi(routes({ [`GET ${API}/slots`]: () => json(200, { data: [] }) }))
      const view = display(text)
      try {
        await settled()
        expect(screen.queryByText(UNAVAILABLE)).not.toBeNull()
        expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      `const slots = await eventSlots(
            handle,
            slug,
            team,
            intent.durationMinutes,
          )(intent.start, intent.end, controller.signal)`,
      'const slots = [{ start: intent.start, end: intent.end }]',
    )
  })

  it('detects matching only the start when the offered end differs', async () => {
    async function assertion(text: string) {
      fakeApi(routes({ [`GET ${API}/slots`]: () => json(200, { data: [slot(START, 15)] }) }))
      const view = display(text)
      try {
        await settled()
        expect(screen.queryByText(UNAVAILABLE)).not.toBeNull()
        expect(screen.queryByRole('heading', { name: 'Your details' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      `Date.parse(candidate.start) === Date.parse(intent.start) &&
              Date.parse(candidate.end) === Date.parse(intent.end)`,
      'Date.parse(candidate.start) === Date.parse(intent.start)',
    )
  })

  it('detects omitting the explicit singleton length from the exact availability request', async () => {
    async function assertion(text: string) {
      const api = fakeApi(routes())
      const view = display(text)
      try {
        await settled()
        const request = api.to(`GET ${API}/slots`).find(exact)
        expect(request).toBeDefined()
        expect(query(request as Call).get('durationMinutes')).toBe('30')
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      `            intent.durationMinutes,
          )(intent.start, intent.end, controller.signal)`,
      `            undefined,
          )(intent.start, intent.end, controller.signal)`,
    )
  })

  it('detects omitting the explicit singleton length from the final booking request', async () => {
    async function assertion(text: string) {
      const api = fakeApi(routes())
      const view = display(text)
      try {
        await fill()
        await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }))
        await waitFor(() => expect(api.to(`POST ${API}/bookings`)).toHaveLength(1))
        expect(api.to(`POST ${API}/bookings`)[0]?.body).toHaveProperty('durationMinutes', 30)
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      '...((hasDurationChoices || directFlow) && { durationMinutes })',
      '...(hasDurationChoices && { durationMinutes })',
    )
  })

  it('detects the cause-specific final-submit booking-race notice in a direct flow', async () => {
    async function assertion(text: string) {
      fakeApi(routes({ [`POST ${API}/bookings`]: () => json(409, { error: 'slot_taken' }) }))
      const view = display(text)
      try {
        await fill()
        await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }))
        await screen.findByRole('heading', { name: 'Pick a time' })
        expect(screen.queryByText(UNAVAILABLE)).not.toBeNull()
        expect(screen.queryByText(/Someone else just booked/)).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(assertion, "code === 'slot_taken' && !directFlow", "code === 'slot_taken'")
  })

  it.each([401, 403, 429, 500, 503])(
    'detects converting unknown HTTP %s validation into a claimed unavailable time',
    async (status) => {
      async function assertion(text: string) {
        fakeApi(
          routes({
            [`GET ${API}/slots`]: () => json(status, { error: 'calendar_sync_unavailable' }),
          }),
        )
        const view = display(text)
        try {
          await settled()
          expect(screen.queryByText(UNKNOWN)).not.toBeNull()
          expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeNull()
          expect(screen.queryByText(UNAVAILABLE)).toBeNull()
          expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
        } finally {
          view.unmount()
        }
      }
      await killed(
        assertion,
        "else setDirectState({ identity, status: 'error' })",
        "else done('That time is no longer available. Please pick another one.')",
      )
    },
  )

  it('detects dropping query intent on canonical case navigation', async () => {
    async function assertion(text: string) {
      fakeApi(routes())
      const view = display(text, `/Ada/INTRO${hint()}`)
      try {
        await settled()
        expect(screen.getByTestId('location').textContent).toBe(`/ada/intro${hint()}`)
        expect(screen.queryByRole('heading', { name: 'Your details' })).not.toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal production source for the mutation
      '${location.search}`}',
      '`}',
    )
  })

  it('detects canonical navigation dropping a malformed waitlist route into ordinary direct behavior', async () => {
    async function assertion(text: string) {
      const api = fakeApi(routes())
      const view = display(
        text,
        `/Ada/INTRO/waitlist/bad/${encodeURIComponent(START)}/${NOW + 86400000}${hint()}`,
      )
      try {
        await settled()
        expect(screen.getByTestId('location').textContent).toContain('/ada/intro/waitlist/bad/')
        expect(api.to(`GET ${API}/slots`).some(exact)).toBe(false)
        expect(screen.queryByRole('heading', { name: 'Your details' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      'params.waitlistToken !== undefined ? `/waitlist',
      'waitlist ? `/waitlist',
    )
  })

  it('detects ignoring query-only navigation', async () => {
    async function assertion(text: string) {
      fakeApi(routes())
      const view = display(text)
      try {
        await fill()
        await userEvent.click(screen.getByRole('button', { name: 'Next link' }))
        await waitFor(() =>
          expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT),
        )
        expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper')
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      '[embedded, params.waitlistToken, location.key, location.pathname, location.search]',
      '[embedded, params.waitlistToken, location.pathname]',
    )
  })

  it('detects retaining the first metadata request after query navigation before the form exists', async () => {
    async function assertion(text: string) {
      const delayed = later()
      let metadata = 0
      fakeApi(
        routes({
          [`GET ${API}`]: () => (++metadata === 1 ? delayed.response : json(200, EVENT)),
        }),
      )
      const view = display(text)
      try {
        await waitFor(() => expect(metadata).toBe(1))
        await userEvent.click(screen.getByRole('button', { name: 'Next link' }))
        await delayed.answer(json(404, { error: 'event_type_not_found' }))
        await waitFor(() =>
          expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT),
        )
        expect(screen.queryByRole('heading', { name: 'Your details' })).not.toBeNull()
        expect(screen.queryByText('This event is unavailable')).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      '[handle, slug, team, requestIdentity, retry]',
      '[handle, slug, team, retry]',
    )
  })

  it('detects a missing result guard when an old query response ignores fetch abort', async () => {
    async function assertion(text: string) {
      const delayed = later()
      const api = fakeApi(
        routes({
          [`GET ${API}/slots`]: (call) =>
            exact(call) ? delayed.response : slotsAnswer([NEXT])(call),
        }),
      )
      const view = display(text)
      try {
        await waitFor(() => expect(api.to(`GET ${API}/slots`).some(exact)).toBe(true))
        await userEvent.click(screen.getByRole('button', { name: 'Next link' }))
        await fill()
        await delayed.answer(json(200, { data: [slot(START)] }))
        expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT)
        expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper')
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      `)(intent.start, intent.end, controller.signal)
          if (controller.signal.aborted) return`,
      ')(intent.start, intent.end, controller.signal)',
    )
  })

  it.each(['metadata', 'slots'] as const)(
    'detects failing to cancel delayed %s after Change time and a manual duration edit',
    async (stage) => {
      async function assertion(text: string) {
        const delayed = later()
        let metadata = 0
        const event = { ...EVENT, allowedDurationsMinutes: [30, 60] }
        const api = fakeApi(
          routes({
            [`GET ${API}`]: () =>
              ++metadata === 2 && stage === 'metadata' ? delayed.response : json(200, event),
            [`GET ${API}/slots`]: (call) =>
              exact(call) && stage === 'slots'
                ? delayed.response
                : slotsAnswer([NEXT], Number(query(call).get('durationMinutes')) || 30)(call),
          }),
        )
        const view = display(text)
        try {
          await screen.findByText(CHECKING)
          await waitFor(() =>
            expect(
              stage === 'metadata' ? metadata >= 2 : api.to(`GET ${API}/slots`).some(exact),
            ).toBe(true),
          )
          await userEvent.click(screen.getByRole('button', { name: 'Change time' }))
          await screen.findByRole('heading', { name: 'Pick a time' })
          await userEvent.click(screen.getByRole('radio', { name: '1 h' }))
          await delayed.answer(
            stage === 'metadata' ? json(200, event) : json(200, { data: [slot(START)] }),
          )
          expect(screen.queryByRole('heading', { name: 'Your details' })).toBeNull()
          expect(screen.queryByLabelText('Your name')).toBeNull()
          expect((screen.getByRole('radio', { name: '1 h' }) as HTMLInputElement).checked).toBe(
            true,
          )
        } finally {
          view.unmount()
        }
      }
      await killed(
        assertion,
        `function dismissDirect() {
    directController.current?.abort()`,
        'function dismissDirect() {',
      )
    },
  )

  it.each(['embed', 'iframe'] as const)(
    'detects allowing direct preselection in an %s',
    async (mode) => {
      async function assertion(text: string) {
        const api = fakeApi(routes())
        const parent =
          mode === 'iframe'
            ? vi.spyOn(window, 'parent', 'get').mockReturnValue({} as Window)
            : undefined
        const view = display(
          text,
          `${mode === 'embed' ? '/embed' : ''}/ada/intro${hint()}`,
          mode === 'embed',
        )
        try {
          await settled()
          expect(screen.queryByRole('heading', { name: 'Your details' })).toBeNull()
          expect(api.to(`GET ${API}/slots`).some(exact)).toBe(false)
        } finally {
          view.unmount()
          parent?.mockRestore()
        }
      }
      await killed(
        assertion,
        mode === 'embed' ? '!embedded && !params.waitlistToken' : 'window.parent === window',
        mode === 'embed' ? '!params.waitlistToken' : 'true',
      )
    },
  )

  it('detects appended direct hints overriding a waitlist capability suggestion', async () => {
    async function assertion(text: string) {
      const event = { ...EVENT, allowedDurationsMinutes: [30, 60] }
      const api = fakeApi(
        routes({
          [`GET ${API}`]: () => json(200, event),
          [`GET ${API}/slots`]: (call) =>
            slotsAnswer([START, NEXT], Number(query(call).get('durationMinutes')) || 30)(call),
        }),
      )
      const waitlist = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
      const view = display(
        text,
        `/ada/intro/waitlist/${waitlist}/${encodeURIComponent(START)}/${NOW + 86400000}${hint(NEXT, 60)}`,
      )
      try {
        await screen.findByRole('heading', { name: 'Your details' })
        await settled()
        expect(api.to(`GET ${API}/slots`)).toHaveLength(1)
        expect(query(api.to(`GET ${API}/slots`)[0] as Call).has('durationMinutes')).toBe(false)
        expect(document.querySelector('.chosen-time')?.textContent).toContain('9:00')
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      '!embedded && !params.waitlistToken && window.parent === window',
      '!embedded && window.parent === window',
    )
  })

  it('detects adding ordinary direct-link behavior to a one-time capability flow', async () => {
    async function assertion(text: string) {
      const api = fakeApi(
        routes({
          [`GET /api/v1/book/${TOKEN}`]: () => json(200, { eventType: EVENT, prefill: {} }),
          [`GET /api/v1/book/${TOKEN}/slots`]: slotsAnswer([START]),
        }),
      )
      const view = display(text, `/book/${TOKEN}${hint()}`)
      try {
        await settled()
        expect(api.calls.some((call) => call.path.startsWith(API))).toBe(false)
        expect(screen.queryByRole('heading', { name: 'Your details' })).toBeNull()
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      'return <BookingFlow event={eventType} oneTimeToken={token} prefill={prefill} />',
      `return <BookingFlow event={eventType} oneTimeToken={token} prefill={prefill} handle="ada" slug="intro" directLink={{ identity: 'unsupported-capability', intent: parseSlotLink(window.location.search) }} />`,
    )
  })

  it('detects reusing the start offset for the end of a daylight-saving transition', async () => {
    async function assertion(text: string) {
      const start = '2027-03-14T06:30:00.000Z'
      fakeApi(
        routes({
          [`GET ${API}`]: () => json(200, { ...EVENT, durationMinutes: 60 }),
          [`GET ${API}/slots`]: slotsAnswer([start], 60),
        }),
      )
      const view = display(text, `/ada/intro${hint(start, 60)}`)
      try {
        await settled()
        const labels = document.querySelectorAll('.chosen-time time')
        expect(labels).toHaveLength(2)
        expect(labels[0]?.nextElementSibling?.textContent).toContain('GMT-05:00')
        expect(labels[1]?.nextElementSibling?.textContent).toContain('GMT-04:00')
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      'offset: offsetLabel(timeZone, Date.parse(instant)),',
      'offset: offsetLabel(timeZone, Date.parse(slot.start)),',
    )
  })

  it('detects omitting the end date when the interval crosses invitee midnight', async () => {
    async function assertion(text: string) {
      zone = 'Asia/Tokyo'
      const start = '2027-06-15T14:30:00.000Z'
      fakeApi(
        routes({
          [`GET ${API}`]: () => json(200, { ...EVENT, durationMinutes: 60 }),
          [`GET ${API}/slots`]: slotsAnswer([start], 60),
        }),
      )
      const view = display(text, `/ada/intro${hint(start, 60)}`)
      try {
        await settled()
        const labels = document.querySelectorAll('.chosen-time time')
        expect(labels).toHaveLength(2)
        expect(labels[0]?.textContent).toContain('Tuesday, June 15, 2027')
        expect(labels[1]?.textContent).toContain('Wednesday, June 16, 2027')
        expect(labels[1]?.getAttribute('datetime')).toBe(slot(start, 60).end)
      } finally {
        view.unmount()
      }
    }
    await killed(
      assertion,
      'date: formatDate(Date.parse(instant), timeZone, locale),',
      'date: formatDate(Date.parse(slot.start), timeZone, locale),',
    )
  })
})

it('detects dropping the selected location from slot availability', async () => {
  async function assertion(text: string) {
    const api = fakeApi(
      routes({
        [`GET ${API}`]: () =>
          json(200, {
            ...EVENT,
            locations: [
              { id: 'office', kind: 'in_person', label: 'Office' },
              { id: 'meet', kind: 'google_meet', label: 'Meet' },
            ],
          }),
      }),
    )
    const view = display(text, '/ada/intro')
    try {
      const choice = await screen.findByRole('radio', { name: 'Meet' })
      await userEvent.setup().click(choice)
      await waitFor(() => expect(api.to(`GET ${API}/slots`).length).toBeGreaterThan(1))
      expect(query(api.to(`GET ${API}/slots`).at(-1) as Call).get('locationOptionId')).toBe('meet')
    } finally {
      view.unmount()
    }
  }
  await killed(
    assertion,
    'eventSlots(handle, slug, team, duration, locationOptionId)',
    'eventSlots(handle, slug, team, duration)',
  )
})

it('detects rejecting formatted international phone input in the public form', () => {
  const original = readFileSync('apps/web/src/public/BookingForm.tsx', 'utf8')
  const before = "(values.inviteePhone ?? '').replace(/[ ().-]/g, '')"
  expect(original.split(before)).toHaveLength(2)
  const assertion = (text: string) => {
    const copied = compile<typeof form>('apps/web/src/public/BookingForm.tsx', text, {
      react,
      '../components/forms.tsx': formComponents,
      '../i18n/runtime.tsx': runtime,
      '../i18n/translate.ts': translate,
      './BookingDetails.tsx': details,
      './validation.ts': validation,
    })
    expect(
      copied.validateBookingForm(
        [],
        {
          name: 'Ada',
          email: 'ada@example.com',
          answers: {},
          guests: [],
          inviteePhone: '+1 (415) 555-0123',
        },
        [{ id: 'call', kind: 'phone', askInvitee: true }],
      ),
    ).toEqual({})
  }
  assertion(original)
  expect(() => assertion(original.replace(before, "values.inviteePhone ?? ''"))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
  assertion(original)
})

it('detects submitting phone separators instead of the normalized number', async () => {
  async function assertion(text: string) {
    const api = fakeApi(
      routes({
        [`GET ${API}`]: () =>
          json(200, { ...EVENT, locations: [{ id: 'call', kind: 'phone', askInvitee: true }] }),
      }),
    )
    const view = display(text)
    try {
      await fill()
      fireEvent.change(screen.getByLabelText('Your phone number'), {
        target: { value: '+1 (415) 555-0123' },
      })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm booking' }))
      await waitFor(() => expect(api.to(`POST ${API}/bookings`)).toHaveLength(1))
      expect(api.to(`POST ${API}/bookings`)[0]?.body).toHaveProperty('inviteePhone', '+14155550123')
    } finally {
      view.unmount()
    }
  }
  await killed(
    assertion,
    "inviteePhone: values.inviteePhone?.replace(/[ ().-]/g, ''),",
    'inviteePhone: values.inviteePhone,',
  )
})

it('detects keeping an unchecked time after changing the location', async () => {
  async function assertion(text: string) {
    fakeApi(
      routes({
        [`GET ${API}`]: () =>
          json(200, {
            ...EVENT,
            locations: [
              { id: 'office', kind: 'in_person', label: 'Office' },
              { id: 'meet', kind: 'google_meet', label: 'Meet' },
            ],
          }),
      }),
    )
    const view = display(text)
    try {
      await fill()
      await userEvent.setup().click(screen.getByRole('radio', { name: 'Meet' }))
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
    } finally {
      view.unmount()
    }
  }
  await killed(
    assertion,
    'selectedLocation(event.locations ?? [], next.locationOptionId)?.id !==\n                    locationOptionId',
    'false',
  )
})
