import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import { type Call, fakeApi, json, later, type Routes, renderApp } from '../test/fake-api.tsx'
import { booking, managed, NEW_TOKEN, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'
import { parseManageFragment } from './ManageBookingPage.tsx'
import publicStyles from './public.css?raw'

const env = vi.hoisted(() => ({
  zone: 'America/New_York',
  locale: 'en-US',
  now: Date.parse('2026-11-01T04:30:00Z'),
}))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => env.zone,
  preferredLocale: () => env.locale,
  now: () => env.now,
}))

beforeEach(() => {
  env.zone = 'America/New_York'
  env.locale = 'en-US'
  env.now = Date.parse('2026-11-01T04:30:00Z')
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
})

const plain = (text: string | null | undefined) => (text ?? '').replace(/[   ]/g, ' ')

/** Check the real spacing rule because jsdom does not calculate pixel layout. */
function expectStandardMargin(element: HTMLElement, side: 'marginTop' | 'marginBottom') {
  const sheet = document.createElement('style')
  sheet.textContent = publicStyles.replace(/^@import[^;]+;/m, '')
  document.head.append(sheet)
  try {
    expect(getComputedStyle(element)[side]).toBe('var(--space-3)')
  } finally {
    sheet.remove()
  }
}

const bookerIn = (timeZone: string) => ({
  name: 'Grace Hopper',
  email: 'grace@example.com',
  timeZone,
  locale: null,
  isBooker: true,
})

/** Opens the app the way a browser opens an emailed link: the real address bar and history. */
function openLink(url: string) {
  window.history.replaceState(null, '', url)
  return render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  )
}

/** The manage endpoints over one booking, answering only to the tokens it was given. */
function manageServer(
  initial = managed(),
  { slots = ['2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'], more = {} as Routes } = {},
) {
  let current = initial
  const tokens = new Map([[TOKEN, () => current]])
  const lookup = (call: Call) => tokens.get(call.headers.get('x-manage-token') ?? '')?.()
  const notFound = () => json(404, { error: 'booking_not_found', message: 'No such booking' })
  return fakeApi({
    'GET /api/v1/bookings/manage': (call) => {
      const found = lookup(call)
      return found ? json(200, found) : notFound()
    },
    'GET /api/v1/bookings/manage/slots': (call) =>
      lookup(call) ? slotsAnswer(slots)(call) : notFound(),
    'POST /api/v1/bookings/manage/cancel': (call) => {
      const found = lookup(call)
      if (!found) return notFound()
      if (found.status === 'cancelled') return json(409, { error: 'booking_cancelled' })
      current = {
        ...found,
        status: 'cancelled',
        cancelledAt: '2026-11-01T04:31:00.000Z',
        cancelReason: (call.body as { reason?: string } | undefined)?.reason ?? null,
      }
      return json(200, booking(current))
    },
    'POST /api/v1/bookings/manage/reschedule': (call) => {
      const found = lookup(call)
      if (!found) return notFound()
      const start = (call.body as { start: string }).start
      const moved = managed({
        id: '01900000-0000-7000-8000-0000000000b2',
        start,
        end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
        rescheduledFromId: found.id,
      })
      current = { ...found, status: 'cancelled', cancelledAt: '2026-11-01T04:31:00.000Z' }
      tokens.set(NEW_TOKEN, () => moved)
      return json(200, { booking: booking(moved), manageToken: NEW_TOKEN })
    },
    ...more,
  })
}

describe('the invitee’s manage page', () => {
  it('keeps rescheduling at the view width with a current-booking card and no cancellation action', async () => {
    const user = userEvent.setup()
    const api = manageServer()
    renderApp(`/booking#token=${TOKEN}`)
    await screen.findByRole('heading', { name: 'Your booking' })
    expect(screen.getByRole('main').classList.contains('public-main-wide')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    const heading = await screen.findByRole('heading', { name: 'Pick a new time' })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByRole('main').classList.contains('public-main-wide')).toBe(true)
    const summary = screen.getByRole('complementary', { name: 'Current booking' })
    expect(summary.closest('.booking-layout')).not.toBeNull()
    expect(within(summary).getByRole('heading', { name: 'Intro call' })).toBeDefined()
    expect(within(summary).getByText('Ada Lovelace')).toBeDefined()
    expect(summary.nextElementSibling?.classList.contains('booking-main')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
    await user.click(await screen.findByRole('button', { name: /November 3, available/ }))
    await user.click(screen.getByRole('button', { name: '10:00 AM' }))
    await screen.findByRole('heading', { name: 'Move your booking?' })
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pick another time' }))
    await user.click(screen.getByRole('button', { name: 'Keep the current time' }))
    expect(await screen.findByRole('button', { name: 'Cancel booking' })).toBeDefined()
    expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(0)
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(0)
  })

  it.each(['pending', 'failed'] as const)(
    'withholds delivery advice while a rescheduled invitation is %s',
    async (status) => {
      const user = userEvent.setup()
      manageServer(managed(), {
        more: {
          'POST /api/v1/bookings/manage/reschedule': () =>
            json(200, {
              booking: booking({
                start: '2026-11-03T15:00:00.000Z',
                end: '2026-11-03T15:30:00.000Z',
                location: { kind: 'google_meet', autoCreate: true },
                conference: {
                  provider: 'google_meet',
                  status,
                  errorCode: status === 'failed' ? 'provider_unavailable' : null,
                },
              }),
              manageToken: NEW_TOKEN,
            }),
        },
      })
      renderApp(`/booking#token=${TOKEN}&action=reschedule`)
      await user.click(await screen.findByRole('button', { name: /November 3, available/ }))
      await user.click(screen.getByRole('button', { name: '10:00 AM' }))
      await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
      await screen.findByText('Your booking is moved to the new time.')
      expect(screen.queryByText(/Didn’t get the email/)).toBeNull()
    },
  )

  it('reads the token from the fragment, removes it from the address bar and sends it as a header', async () => {
    const api = manageServer()
    openLink(`/booking#token=${TOKEN}`)
    const entries = window.history.length

    expect(await screen.findByRole('heading', { name: 'Your booking' })).toBeDefined()
    expect(screen.queryByText(/Didn’t get the email/)).toBeNull()
    const calendarNote = screen.getByText(
      'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
    )
    expect(calendarNote.nextElementSibling).toBe(
      screen.getByRole('button', { name: 'Cancel booking' }).parentElement,
    )
    // Gone from the address bar (and so from bookmarks and any Referer), replaced rather than
    // pushed: no history entry keeps it either.
    expect(window.location.pathname).toBe('/booking')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.history.length).toBe(entries)
    const [call] = api.to('GET /api/v1/bookings/manage')
    expect(call?.headers.get('x-manage-token')).toBe(TOKEN)
    for (const c of api.calls) expect(c.path).not.toContain(TOKEN)

    // The booking, in the visitor's zone, with the event and host the API names.
    expect(screen.getByText('Intro call')).toBeDefined()
    expect(screen.getByText('Ada Lovelace')).toBeDefined()
    expect(plain(screen.getByText(/Monday, November 2, 2026/).parentElement?.textContent)).toMatch(
      /9:00 – 9:30 AM \(America\/New York, GMT-05:00\)/,
    )
    expect(screen.getByText('Grace Hopper (grace@example.com)')).toBeDefined()
    // Nothing on the page links anywhere with the token.
    for (const link of document.querySelectorAll('a')) {
      expect(link.getAttribute('href') ?? '').not.toContain(TOKEN)
    }
  })

  it('cancels, with an optional reason, when the email link asks for it', async () => {
    const user = userEvent.setup()
    const api = manageServer()
    openLink(`/booking#token=${TOKEN}&action=cancel`)

    const heading = await screen.findByRole('heading', { name: 'Cancel this booking?' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(window.location.hash).toBe('')
    const reason = screen.getByLabelText(/Reason/)
    await user.type(reason, 'Something came up.')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))

    expect(await screen.findByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.getByText('Your booking is cancelled.')).toBeDefined()
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    expect(screen.getByText('Something came up.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
    expect(
      screen.queryByText(/Accepting or declining the calendar invitation does not cancel/),
    ).toBeNull()
    const [call] = api.to('POST /api/v1/bookings/manage/cancel')
    expect(call?.body).toEqual({ reason: 'Something came up.' })
    expect(call?.headers.get('x-manage-token')).toBe(TOKEN)
  })

  it.each(['en', 'zh-CN'] as const)(
    'localizes the structured current booking summary in %s',
    async (language) => {
      localStorage.setItem('hourmere-language', language)
      manageServer({
        ...managed(),
        eventType: { title: 'ICS test', durationMinutes: 30 },
        hosts: [{ name: 'Test Host' }],
      })
      renderApp(`/booking#token=${TOKEN}&action=reschedule`)
      const summary = await screen.findByRole('complementary', {
        name: language === 'en' ? 'Current booking' : '当前预约',
      })
      expect(within(summary).getByRole('heading', { name: 'ICS test' })).toBeDefined()
      expect(within(summary).getByText('Test Host')).toBeDefined()
      expect(within(summary).getByText(language === 'en' ? 'When' : '时间')).toBeDefined()
    },
  )

  describe.each(['en', 'zh-CN'] as const)('past and in-progress copy in %s', (language) => {
    it('keeps a server refusal authoritative when the local clock is before the start', async () => {
      const user = userEvent.setup()
      localStorage.setItem('hourmere-language', language)
      const api = manageServer(managed(), {
        more: {
          'POST /api/v1/bookings/manage/cancel': () => {
            env.now = Date.parse('2026-11-02T13:59:59Z')
            return json(409, { error: 'booking_in_past' })
          },
        },
      })
      renderApp(`/booking#token=${TOKEN}&action=cancel`)
      await user.click(
        await screen.findByRole('button', {
          name: language === 'en' ? 'Cancel booking' : '取消预约',
        }),
      )
      expect(
        await screen.findByText(
          language === 'en'
            ? 'This meeting has already started, so it can’t be changed.'
            : '此会议已开始，无法更改。',
        ),
      ).toBeDefined()
      expect(
        screen.queryByRole('button', { name: language === 'en' ? 'Reschedule' : '改期' }),
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: language === 'en' ? 'Cancel booking' : '取消预约' }),
      ).toBeNull()
      expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(1)
    })

    it('updates a server-refused started message after the meeting ends and language changes', async () => {
      const user = userEvent.setup()
      const initialLanguage = language === 'en' ? 'zh-CN' : 'en'
      localStorage.setItem('hourmere-language', initialLanguage)
      const api = manageServer(managed(), {
        more: {
          'POST /api/v1/bookings/manage/cancel': () => {
            env.now = Date.parse('2026-11-02T14:29:59Z')
            return json(409, { error: 'booking_in_past' })
          },
        },
      })
      renderApp(`/booking#token=${TOKEN}&action=cancel`)
      await user.click(
        await screen.findByRole('button', {
          name: initialLanguage === 'en' ? 'Cancel booking' : '取消预约',
        }),
      )
      expect(
        await screen.findByText(
          initialLanguage === 'en'
            ? 'This meeting has already started, so it can’t be changed.'
            : '此会议已开始，无法更改。',
        ),
      ).toBeDefined()
      env.now += 1000
      await user.selectOptions(
        screen.getByRole('combobox', {
          name: initialLanguage === 'en' ? 'Interface language' : '界面语言',
        }),
        language,
      )
      expect(screen.getByText(language === 'en' ? 'Ended' : '已结束')).toBeDefined()
      expect(
        screen.getByText(language === 'en' ? 'This meeting has ended.' : '此会议已结束。'),
      ).toBeDefined()
      expect(screen.queryByText(language === 'en' ? /already started/ : /此会议已开始/)).toBeNull()
      expect(
        screen.queryByRole('button', { name: language === 'en' ? 'Cancel booking' : '取消预约' }),
      ).toBeNull()
      expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(1)
      expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
    })

    it.each(['start', 'end'] as const)(
      'uses the fresh time after a language rerender crosses the meeting %s',
      async (boundary) => {
        const user = userEvent.setup()
        const initialLanguage = language === 'en' ? 'zh-CN' : 'en'
        localStorage.setItem('hourmere-language', initialLanguage)
        env.now = Date.parse(boundary === 'start' ? '2026-11-02T13:59:59Z' : '2026-11-02T14:29:59Z')
        const api = manageServer()
        renderApp(`/booking#token=${TOKEN}`)
        expect(
          await screen.findByText(initialLanguage === 'en' ? 'Confirmed' : '已确认'),
        ).toBeDefined()
        env.now += 1000
        await user.selectOptions(
          screen.getByRole('combobox', {
            name: initialLanguage === 'en' ? 'Interface language' : '界面语言',
          }),
          language,
        )
        const ended = boundary === 'end'
        const message = ended
          ? language === 'en'
            ? 'This meeting has ended.'
            : '此会议已结束。'
          : language === 'en'
            ? 'This meeting has already started, so it can’t be changed here.'
            : '此会议已开始，无法在此更改。'
        expect(screen.getByText(message)).toBeDefined()
        expect(
          screen.getByText(
            ended
              ? language === 'en'
                ? 'Ended'
                : '已结束'
              : language === 'en'
                ? 'Confirmed'
                : '已确认',
          ),
        ).toBeDefined()
        expect(
          screen.queryByRole('button', { name: language === 'en' ? 'Reschedule' : '改期' }),
        ).toBeNull()
        expect(
          screen.queryByRole('button', { name: language === 'en' ? 'Cancel booking' : '取消预约' }),
        ).toBeNull()
        expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(1)
      },
    )

    it.each(['', '&action=reschedule', '&action=cancel'])(
      'describes an ended booking consistently for a link with %s',
      async (action) => {
        localStorage.setItem('hourmere-language', language)
        env.now = Date.parse('2026-11-02T14:30:00Z')
        manageServer()
        renderApp(`/booking#token=${TOKEN}${action}`)
        expect(await screen.findByText(language === 'en' ? 'Ended' : '已结束')).toBeDefined()
        expect(
          screen.getByText(language === 'en' ? 'This meeting has ended.' : '此会议已结束。'),
        ).toBeDefined()
        expect(
          screen.queryByText(language === 'en' ? /already started/ : /此会议已开始/),
        ).toBeNull()
        expect(screen.queryByText(language === 'en' ? 'Confirmed' : '已确认')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
      },
    )

    it.each(['', '&action=reschedule'])(
      'keeps the started message and confirmed status until the end for %s',
      async (action) => {
        localStorage.setItem('hourmere-language', language)
        env.now = Date.parse('2026-11-02T14:29:59Z')
        manageServer()
        renderApp(`/booking#token=${TOKEN}${action}`)
        expect(await screen.findByText(language === 'en' ? 'Confirmed' : '已确认')).toBeDefined()
        const message = action
          ? language === 'en'
            ? 'This meeting has already started, so it can’t be changed.'
            : '此会议已开始，无法更改。'
          : language === 'en'
            ? 'This meeting has already started, so it can’t be changed here.'
            : '此会议已开始，无法在此更改。'
        expect(screen.getByText(message)).toBeDefined()
        expect(screen.queryByText(language === 'en' ? 'Ended' : '已结束')).toBeNull()
        expect(
          screen.queryByText(language === 'en' ? 'This meeting has ended.' : '此会议已结束。'),
        ).toBeNull()
      },
    )

    it.each(['2026-11-02T14:29:59Z', '2026-11-02T14:30:00Z'])(
      'uses the current meeting state when a pending action reaches %s',
      async (now) => {
        const user = userEvent.setup()
        localStorage.setItem('hourmere-language', language)
        const api = manageServer(managed(), {
          more: {
            'POST /api/v1/bookings/manage/cancel': () => {
              env.now = Date.parse(now)
              return json(409, { error: 'booking_in_past' })
            },
          },
        })
        renderApp(`/booking#token=${TOKEN}&action=cancel`)
        await user.click(
          await screen.findByRole('button', {
            name: language === 'en' ? 'Cancel booking' : '取消预约',
          }),
        )
        const ended = now === '2026-11-02T14:30:00Z'
        const message = ended
          ? language === 'en'
            ? 'This meeting has ended.'
            : '此会议已结束。'
          : language === 'en'
            ? 'This meeting has already started, so it can’t be changed.'
            : '此会议已开始，无法更改。'
        expect(await screen.findByText(message)).toBeDefined()
        expect(
          screen.getByText(
            ended
              ? language === 'en'
                ? 'Ended'
                : '已结束'
              : language === 'en'
                ? 'Confirmed'
                : '已确认',
          ),
        ).toBeDefined()
        expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(1)
        expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
        expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
      },
    )
  })

  it('starts in the booker’s stored time zone and lets them change it without shifting a slot', async () => {
    const user = userEvent.setup()
    const api = manageServer(
      managed({
        attendees: [
          {
            name: 'Guest',
            email: 'guest@example.com',
            timeZone: 'Asia/Tokyo',
            locale: null,
            isBooker: false,
          },
          bookerIn('Europe/London'),
        ],
      }),
    )
    renderApp(`/booking#token=${TOKEN}`)

    await screen.findByRole('heading', { name: 'Your booking' })
    expect(plain(screen.getByText(/Monday, November 2, 2026/).parentElement?.textContent)).toMatch(
      /2:00 – 2:30 PM \(Europe\/London, GMT\+00:00\)/,
    )
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    expect(await screen.findByRole('button', { name: /Europe\/London/ })).toBeDefined()
    await user.click(screen.getByRole('button', { name: /Europe\/London/ }))
    await user.type(screen.getByRole('combobox', { name: 'Search time zones' }), 'Berlin')
    await user.click(screen.getByRole('option', { name: /Europe\/Berlin/ }))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '4:00 PM' }))
    expect(plain(screen.getByText(/Tuesday, November 3, 2026/).textContent)).toMatch(
      /4:00 – 4:30 PM/,
    )
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))

    expect(await screen.findByText('Your booking is moved to the new time.')).toBeDefined()
    expect(
      screen.getByText(
        'Didn’t get the email? Check spam or junk and add the sender to your contacts.',
      ),
    ).toBeDefined()
    expect(api.to('POST /api/v1/bookings/manage/reschedule')[0]?.body).toEqual({
      start: '2026-11-03T15:00:00.000Z',
    })
    expect(
      screen.getByText(
        (_, node) =>
          node?.className === 'muted' && /Europe\/Berlin, GMT\+01:00/.test(node.textContent ?? ''),
      ),
    ).toBeDefined()
  })

  it.each(['missing booker', 'empty zone', 'unknown zone'])(
    'falls back to the browser time zone for %s',
    async (scenario) => {
      env.zone = 'Europe/Berlin'
      manageServer(
        managed({
          attendees:
            scenario === 'missing booker'
              ? []
              : [bookerIn(scenario === 'unknown zone' ? 'Unknown/Zone' : '')],
        }),
      )
      renderApp(`/booking#token=${TOKEN}`)

      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Your booking' })).not.toBeNull(),
      )
      expect(
        plain(screen.getByText(/Monday, November 2, 2026/).parentElement?.textContent),
      ).toMatch(/3:00 – 3:30 PM \(Europe\/Berlin, GMT\+01:00\)/)
    },
  )

  it('checks the reason’s length before sending it', async () => {
    const user = userEvent.setup()
    const api = manageServer()
    renderApp(`/booking#token=${TOKEN}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }))
    const reason = screen.getByLabelText(/Reason/)
    await user.click(reason)
    await user.paste('x'.repeat(1001))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect(screen.getByText('Use at most 1000 characters.')).toBeDefined()
    expect(api.to('POST /api/v1/bookings/manage/cancel')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Keep booking' }))
    expect(await screen.findByRole('heading', { name: 'Your booking' })).toBeDefined()
  })

  it('reschedules with the slot picker and shows the new link once', async () => {
    const user = userEvent.setup()
    const api = manageServer()
    openLink(`/booking#token=${TOKEN}&action=reschedule`)

    const title = await screen.findByRole('heading', { name: 'Pick a new time' })
    await waitFor(() => expect(document.activeElement).toBe(title))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '11:00 AM' }))
    expect(await screen.findByRole('heading', { name: 'Move your booking?' })).toBeDefined()
    expect(plain(screen.getByText(/Tuesday, November 3, 2026/).textContent)).toMatch(
      /11:00 – 11:30 AM/,
    )
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))

    expect(await screen.findByText('Your booking is moved to the new time.')).toBeDefined()
    expect(plain(screen.getByText(/Tuesday, November 3, 2026/).parentElement?.textContent)).toMatch(
      /11:00 – 11:30 AM/,
    )
    const link = screen.getByLabelText<HTMLInputElement>(/Your link to change or cancel/)
    expect(link.value).toBe(`${window.location.origin}/booking#token=${NEW_TOKEN}`)
    expect(window.location.href).not.toContain(NEW_TOKEN)
    const calendarNote = screen.getByText(
      'Accepting or declining the calendar invitation does not cancel the booking. To cancel, use “Cancel booking” here.',
    )
    expect(calendarNote.previousElementSibling).toBe(
      screen.getByRole('region', { name: 'Save your link to change or cancel' }),
    )
    expectStandardMargin(calendarNote, 'marginTop')

    const [slots] = api.to('GET /api/v1/bookings/manage/slots')
    expect(slots?.headers.get('x-manage-token')).toBe(TOKEN)
    const [moved] = api.to('POST /api/v1/bookings/manage/reschedule')
    expect(moved?.body).toEqual({ start: '2026-11-03T16:00:00.000Z' })

    // From now on the page manages the new booking, with its own token.
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }))
    await screen.findByRole('heading', { name: 'Cancelled booking' })
    const [cancel] = api.to('POST /api/v1/bookings/manage/cancel')
    expect(cancel?.headers.get('x-manage-token')).toBe(NEW_TOKEN)
    // Every network request across read, slots, move and cancel keeps both secrets in headers.
    expect(new Set(api.calls.map((call) => call.path.split('?')[0]))).toEqual(
      new Set([
        '/api/v1/bookings/manage',
        '/api/v1/bookings/manage/slots',
        '/api/v1/bookings/manage/reschedule',
        '/api/v1/bookings/manage/cancel',
        '/api/v1/instance',
      ]),
    )
    for (const call of api.calls.filter((call) => call.path !== '/api/v1/instance')) {
      expect([TOKEN, NEW_TOKEN]).toContain(call.headers.get('x-manage-token'))
      for (const secret of [TOKEN, NEW_TOKEN]) {
        expect(call.path).not.toContain(secret)
        expect(JSON.stringify(call.body) ?? '').not.toContain(secret)
      }
    }
  })

  it('goes back to the picker when the new time was just taken', async () => {
    const user = userEvent.setup()
    let taken = false
    const api = manageServer(managed(), {
      more: {
        'POST /api/v1/bookings/manage/reschedule': () => {
          taken = true
          return json(409, { error: 'slot_taken', message: 'Someone else just booked this time' })
        },
        'GET /api/v1/bookings/manage/slots': (call) =>
          slotsAnswer(
            taken ? ['2026-11-03T15:00:00Z'] : ['2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'],
          )(call),
      },
    })
    renderApp(`/booking#token=${TOKEN}`)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '11:00 AM' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm new time' }))
    expect(await screen.findByText(/Someone else just booked that time/)).toBeDefined()
    await waitFor(() => expect(api.to('GET /api/v1/bookings/manage/slots')).toHaveLength(2))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    expect(
      within(screen.getByRole('list', { name: /^Times on/ }))
        .getAllByRole('button')
        .map((b) => plain(b.textContent)),
    ).toEqual(['10:00 AM'])
  })

  // When the answer to a reschedule is lost, the booking may have moved anyway. Tokens from
  // emails follow a booking to its new time (moving again would move it twice); the token the
  // booking API returned stays with the old, now cancelled booking. So the page never retries:
  // it asks how the booking is now.
  it.each([
    [
      'it moved, seen through an emailed token that follows it',
      () => managed({ start: '2026-11-03T16:00:00.000Z', end: '2026-11-03T16:30:00.000Z' }),
      'Your booking is moved to the new time.',
    ],
    [
      'it moved, seen through the booking’s own token',
      () => managed({ status: 'cancelled', cancelledAt: '2026-11-01T04:31:00.000Z' }),
      /now shows the booking as cancelled: if it was moved, the email about the new time has its link/,
    ],
    ['it did not move', () => managed(), /Your booking was not moved/],
  ])('never retries a reschedule whose answer was lost (%s)', async (_, after, message) => {
    const user = userEvent.setup()
    let posted = false
    const api = manageServer(managed(), {
      more: {
        'GET /api/v1/bookings/manage': () => json(200, posted ? after() : managed()),
        'POST /api/v1/bookings/manage/reschedule': () => {
          posted = true
          throw new TypeError('Failed to fetch')
        },
      },
    })
    renderApp(`/booking#token=${TOKEN}`)
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }))
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '11:00 AM' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm new time' }))

    expect(await screen.findByText(message)).toBeDefined()
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(1)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(
      after().status === 'cancelled' ? 3 : 2,
    )
    expect(screen.queryByRole('button', { name: 'Confirm new time' })).toBeNull()
  })

  it('follows a raced predecessor after a lost reschedule response without submitting again', async () => {
    const user = userEvent.setup()
    const moved = managed({
      id: '01900000-0000-7000-8000-0000000000b2',
      start: '2026-11-03T16:00:00.000Z',
      end: '2026-11-03T16:30:00.000Z',
      rescheduledFromId: managed().id,
    })
    let posted = false
    let afterReads = 0
    const api = manageServer(managed(), {
      more: {
        'GET /api/v1/bookings/manage': () =>
          json(
            200,
            !posted
              ? managed()
              : afterReads++ === 0
                ? managed({ status: 'cancelled', cancelledAt: '2026-11-01T04:31:00.000Z' })
                : moved,
          ),
        'POST /api/v1/bookings/manage/reschedule': () => {
          posted = true
          throw new TypeError('Failed to fetch')
        },
      },
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '11:00 AM' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm new time' }))
    expect(await screen.findByText('Your booking is moved to the new time.')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Your booking' })).toBeDefined()
    expect(document.querySelector('time')?.dateTime).toBe(moved.start)
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(1)
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(3)
  })

  it.each([
    ['reschedule', 'Confirm new time'],
    ['cancel', 'Cancel booking'],
  ] as const)(
    'shows the booking again, without retrying, when a %s finds it just changed',
    async (action, button) => {
      const user = userEvent.setup()
      const moved = managed({ start: '2026-11-04T14:00:00.000Z', end: '2026-11-04T14:30:00.000Z' })
      let changed = false
      const answer = () => {
        changed = true
        return json(409, {
          error: 'booking_changed',
          message: 'This booking was moved again while the request waited; try again',
        })
      }
      const api = manageServer(managed(), {
        more: {
          'GET /api/v1/bookings/manage': () => json(200, changed ? moved : managed()),
          'POST /api/v1/bookings/manage/reschedule': answer,
          'POST /api/v1/bookings/manage/cancel': answer,
        },
      })
      renderApp(`/booking#token=${TOKEN}&action=${action}`)
      if (action === 'reschedule') {
        await user.click(
          await screen.findByRole('button', { name: 'Tuesday, November 3, available' }),
        )
        await user.click(screen.getByRole('button', { name: '11:00 AM' }))
      }
      await user.click(await screen.findByRole('button', { name: button }))

      expect(await screen.findByText(/This booking just changed/)).toBeDefined()
      expect(
        plain(screen.getByText(/Wednesday, November 4, 2026/).parentElement?.textContent),
      ).toMatch(/9:00 – 9:30 AM/)
      expect(api.to(`POST /api/v1/bookings/manage/${action}`)).toHaveLength(1)
      expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
    },
  )

  it('sends one reschedule at a time', async () => {
    const user = userEvent.setup()
    let answer: (response: Response) => void = () => {}
    const api = manageServer(managed(), {
      more: {
        'POST /api/v1/bookings/manage/reschedule': () =>
          new Promise<Response>((resolve) => {
            answer = resolve
          }),
      },
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    await user.click(screen.getByRole('button', { name: '11:00 AM' }))
    const confirm = await screen.findByRole('button', { name: 'Confirm new time' })
    await user.click(confirm)
    const busy = screen.getByRole<HTMLButtonElement>('button', { name: 'Moving…' })
    expect(busy.disabled).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Pick another time' }).disabled,
    ).toBe(true)
    await user.click(busy)
    expect(api.to('POST /api/v1/bookings/manage/reschedule')).toHaveLength(1)
    answer(
      json(200, {
        booking: booking({ start: '2026-11-03T16:00:00.000Z', end: '2026-11-03T16:30:00.000Z' }),
        manageToken: NEW_TOKEN,
      }),
    )
    expect(await screen.findByText('Your booking is moved to the new time.')).toBeDefined()
  })

  it('explains links that do not work, and pages opened without one', async () => {
    fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(404, { error: 'booking_not_found', message: 'No such booking' }),
    })
    openLink('/booking#token=nope')
    expect(await screen.findByRole('heading', { name: 'This link doesn’t work' })).toBeDefined()
    expect(window.location.hash).toBe('')
  })

  it('starts over when another link (or the same one again) is opened in the tab', async () => {
    const other = managed({ id: '01900000-0000-7000-8000-0000000000b9', title: 'Deep dive' })
    const api = fakeApi({
      'GET /api/v1/bookings/manage': ({ headers }) =>
        json(
          200,
          headers.get('x-manage-token') === NEW_TOKEN
            ? { ...other, eventType: { title: 'Deep dive', durationMinutes: 60 } }
            : managed(),
        ),
    })
    openLink(`/booking#token=${TOKEN}`)
    expect(await screen.findByText('Intro call')).toBeDefined()
    const open = async (url: string) => {
      // Flush both the link navigation and the router's fragment-clearing update before
      // opening another link. Booking text can appear while that update is still pending.
      await act(async () => {
        window.history.pushState(null, '', url)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect(window.location.hash).toBe('')
    }
    await open(`/booking#token=${NEW_TOKEN}`)
    expect(await screen.findByText('Deep dive')).toBeDefined()
    await open(`/booking#token=${TOKEN}`)
    expect(await screen.findByText('Intro call')).toBeDefined()
    await open(`/booking#token=${TOKEN}`)
    await waitFor(() => expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(4))
    expect(await screen.findByText('Intro call')).toBeDefined()
    expect(
      api.to('GET /api/v1/bookings/manage').map((c) => c.headers.get('x-manage-token')),
    ).toEqual([TOKEN, NEW_TOKEN, TOKEN, TOKEN])
  })

  it.each(['#token=', '#action=cancel', '#other=unknown'])(
    'clears a previous booking when a new fragment has no token (%s)',
    async (fragment) => {
      const api = manageServer()
      openLink(`/booking#token=${TOKEN}`)
      await screen.findByText('Intro call')
      act(() => {
        window.history.pushState(null, '', `/booking${fragment}`)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await screen.findByRole('heading', { name: 'Open your booking link' })
      expect(screen.queryByText('Intro call')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
      expect(window.location.hash).toBe('')
      expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(1)
      act(() => {
        window.history.pushState(null, '', `/booking#token=${TOKEN}`)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await screen.findByText('Intro call')
      expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(2)
    },
  )

  it('ignores a slow old-booking response after a tokenless fragment clears it', async () => {
    const pending = later()
    const api = fakeApi({ 'GET /api/v1/bookings/manage': () => pending.response })
    openLink(`/booking#token=${TOKEN}`)
    await screen.findByText('Loading your booking…')
    act(() => {
      window.history.pushState(null, '', '/booking#token=')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: 'Open your booking link' })
    await pending.answer(json(200, managed()))
    expect(screen.queryByText('Intro call')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Open your booking link' })).toBeDefined()
    expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(1)
  })

  it('excludes the original instant from new times, regardless of its ISO spelling', async () => {
    const user = userEvent.setup()
    manageServer(managed({ start: '2026-11-02T09:00:00-05:00' }), {
      slots: ['2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z'],
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(await screen.findByRole('button', { name: 'Monday, November 2, available' }))
    const times = within(screen.getByRole('list', { name: /^Times on/ }))
    expect(times.queryByRole('button', { name: '9:00 AM' })).toBeNull()
    await user.click(times.getByRole('button', { name: '10:00 AM' }))
    expect(await screen.findByRole('heading', { name: 'Move your booking?' })).toBeDefined()
  })

  it('does not mark a day available when only the original time remains', async () => {
    const user = userEvent.setup()
    manageServer(managed(), { slots: ['2026-11-02T14:00:00Z', '2026-11-03T15:00:00Z'] })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    const originalDay = await screen.findByRole('button', {
      name: 'Monday, November 2, no times available',
    })
    expect(originalDay.getAttribute('aria-disabled')).toBe('true')
    await user.click(originalDay)
    expect(screen.queryByRole('list', { name: /^Times on/ })).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Tuesday, November 3, available' }))
    expect(screen.getByRole('button', { name: '10:00 AM' })).toBeDefined()
  })

  it('asks for the link when there is none, without asking the server', async () => {
    fakeApi({})
    openLink('/booking')
    expect(await screen.findByRole('heading', { name: 'Open your booking link' })).toBeDefined()
  })

  it('offers no changes to a cancelled booking or one that has started', async () => {
    manageServer(managed({ status: 'cancelled', cancelledAt: '2026-10-30T10:00:00.000Z' }))
    openLink(`/booking#token=${TOKEN}&action=reschedule`)
    expect(await screen.findByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
    expect(screen.getByText('This booking is cancelled, so it can’t be changed.')).toBeDefined()
    expect(
      screen.queryByText(/Accepting or declining the calendar invitation does not cancel/),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull()
  })

  it('says when a meeting has already started', async () => {
    env.now = Date.parse('2026-11-02T14:10:00Z')
    manageServer()
    openLink(`/booking#token=${TOKEN}`)
    expect(
      await screen.findByText('This meeting has already started, so it can’t be changed here.'),
    ).toBeDefined()
    expect(
      screen.queryByText(/Accepting or declining the calendar invitation does not cancel/),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull()
  })

  it('shows the booking as it is when it changed elsewhere', async () => {
    const user = userEvent.setup()
    let cancelledElsewhere = false
    manageServer(managed(), {
      more: {
        'POST /api/v1/bookings/manage/cancel': () => {
          cancelledElsewhere = true
          return json(409, {
            error: 'booking_cancelled',
            message: 'This booking is already cancelled',
          })
        },
        'GET /api/v1/bookings/manage': () =>
          json(
            200,
            managed(
              cancelledElsewhere
                ? { status: 'cancelled', cancelledAt: '2026-11-01T04:00:00.000Z' }
                : {},
            ),
          ),
      },
    })
    renderApp(`/booking#token=${TOKEN}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect(await screen.findByText('This booking was already cancelled.')).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Cancelled booking' })).toBeDefined()
  })

  it('offers a long meeting at the month boundary for rescheduling, in a zone behind UTC', async () => {
    const user = userEvent.setup()
    env.zone = 'Pacific/Pago_Pago'
    env.now = Date.parse('2026-11-20T00:00:00Z')
    const long = {
      ...managed({
        start: '2026-11-24T09:00:00.000Z',
        end: '2026-11-24T17:00:00.000Z',
        attendees: [bookerIn(env.zone)],
      }),
      eventType: { title: 'Workshop', durationMinutes: 480 },
    }
    manageServer(long, {
      more: { 'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-12-01T09:00:00Z'], 480) },
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await user.click(await screen.findByRole('button', { name: 'Monday, November 30, available' }))
    expect(
      within(screen.getByRole('list', { name: /^Times on/ }))
        .getAllByRole('button')
        .map((b) => plain(b.textContent)),
    ).toEqual(['10:00 PM'])
  })

  it('shows the booking in the Gregorian calendar whatever the locale’s default', async () => {
    env.locale = 'fa-IR'
    manageServer()
    renderApp(`/booking#token=${TOKEN}`)
    expect(await screen.findByText(/دوشنبه ۲ نوامبر ۲۰۲۶/)).toBeDefined()
    expect(document.body.textContent).not.toMatch(/آبان|۱۴۰۵/)
  })

  it('parses the fragment strictly', () => {
    expect(parseManageFragment(`#token=${TOKEN}&action=cancel`)).toEqual({
      token: TOKEN,
      action: 'cancel',
    })
    expect(parseManageFragment('#token=abc&action=delete')).toEqual({ token: 'abc', action: null })
    expect(parseManageFragment('')).toEqual({ token: null, action: null })
  })
})
