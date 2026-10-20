import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Booking } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { browserLocale } from '../../test/browser-locale.ts'
import { fakeApi, json, profile, type Routes, renderApp, signedIn } from '../../test/fake-api.tsx'
import { BOOKING_ID, booking, EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'
import { PAGE_SIZE } from './Bookings.tsx'

const location = () => screen.getByTestId('location').textContent
const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams)

/** Bookings numbered from 1, a day apart, starting 2030-03-01 09:00 UTC. */
const numbered = (from: number, count: number): Booking[] =>
  Array.from({ length: count }, (_, i) => {
    const n = from + i
    const day = String(n).padStart(2, '0')
    return booking({
      id: `b0000000-0000-7000-8000-0000000000${day}`,
      title: `Call ${n}`,
      start: `2030-03-${day}T09:00:00.000Z`,
      end: `2030-03-${day}T09:30:00.000Z`,
    })
  })

describe('the bookings list', () => {
  it('keeps a meeting in progress Upcoming and moves ended meetings to Past', async () => {
    const user = userEvent.setup()
    const now = new Date()
    const inProgress = booking({
      title: 'In progress',
      start: new Date(now.getTime() - 60_000).toISOString(),
      end: new Date(now.getTime() + 60_000).toISOString(),
    })
    const ended = booking({
      id: 'b0000000-0000-7000-8000-000000000002',
      title: 'Ended',
      start: new Date(now.getTime() - 120_000).toISOString(),
      end: now.toISOString(),
    })
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) => {
        const q = query(path)
        return json(200, {
          data: [inProgress, ended].filter(
            (b) =>
              (!q.from || b.start >= q.from) &&
              (!q.to || b.start < q.to) &&
              (!q.endAfter || b.end > q.endAfter) &&
              (!q.endTo || b.end <= q.endTo),
          ),
          nextCursor: null,
        })
      },
    })
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'In progress' })
    expect(screen.queryByRole('rowheader', { name: 'Ended' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Past' }))
    await screen.findByRole('rowheader', { name: 'Ended' })
    expect(screen.queryByRole('rowheader', { name: 'In progress' })).toBeNull()
    const calls = api.to('GET /api/v1/bookings').map((c) => query(c.path))
    expect(calls[0]).toHaveProperty('endAfter')
    expect(calls[1]).toHaveProperty('endTo')
    expect(calls.every((q) => !q.from && !q.to)).toBe(true)
  })

  it.each(['fa-IR', 'th-TH'])(
    'uses Gregorian dates in the booking list for browser locale %s',
    async (locale) => {
      browserLocale(locale)
      const current = booking()
      fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/bookings': () => json(200, { data: [current], nextCursor: null }),
      })
      renderApp('/app/bookings')
      const row = (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr')
      expect(row?.textContent).toContain(
        new Intl.DateTimeFormat(locale, {
          calendar: 'gregory',
          timeZone: 'Europe/Berlin',
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date(current.start)),
      )
    },
  )

  it('shows the end date for an overnight booking in the list', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': () =>
        json(200, {
          data: [booking({ end: '2030-03-05T09:00:00.000Z' })],
          nextCursor: null,
        }),
    })
    renderApp('/app/bookings')
    const row = (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr')
    expect(row?.textContent).toMatch(/10:00\sAM – Mar 5, 2030, 10:00\sAM/)
  })
  it('lists upcoming bookings in the host’s time zone', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': () =>
        json(200, {
          data: [
            booking(),
            booking({
              id: 'b0000000-0000-7000-8000-000000000002',
              status: 'cancelled',
              title: 'Old plan',
            }),
          ],
          nextCursor: null,
        }),
    })
    renderApp('/app/bookings')
    const row = (await screen.findByRole('rowheader', { name: 'Intro call' })).closest('tr')
    const cells = within(row as HTMLElement)
    // 09:00 UTC is 10:00 in Berlin in March.
    expect(cells.getByText(/10:00\sAM – 10:30\sAM/)).toBeDefined()
    expect(cells.getByText(/Mar 4, 2030/)).toBeDefined()
    expect(cells.getByText('grace@example.com')).toBeDefined()
    expect(cells.getByText(/\+ 1 guest/)).toBeDefined()
    expect(cells.getByText('Confirmed')).toBeDefined()
    expect(cells.getByRole('link', { name: 'Intro call' }).getAttribute('href')).toBe(
      `/app/bookings/${BOOKING_ID}`,
    )
    const cancelled = screen.getByRole('rowheader', { name: 'Old plan' }).closest('tr')
    expect(within(cancelled as HTMLElement).getByText('Cancelled')).toBeDefined()
    expect(screen.getByText(/Times are in Europe\/Berlin, your time zone\./)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Upcoming' }).getAttribute('aria-current')).toBe('page')

    const [call] = api.to('GET /api/v1/bookings')
    const q = query(call?.path ?? '')
    expect(q.limit).toBe(String(PAGE_SIZE))
    expect(Date.parse(q.endAfter ?? '')).toBeLessThanOrEqual(Date.now())
    expect(q.endTo).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()
  })

  it.each([
    ['en', 'Rescheduled', 'View rescheduled booking', 'Cancelled', 'Confirmed'],
    ['zh-CN', '已改期', '查看改期后的预约', '已取消', '已确认'],
  ] as const)(
    'distinguishes rescheduled predecessors from cancellations in %s across pages',
    async (language, rescheduled, viewSuccessor, cancelled, confirmed) => {
      chooseLanguage(language)
      const successor = 'b0000000-0000-7000-8000-000000000002'
      fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/bookings': () =>
          json(200, {
            data: [
              booking({ title: 'Original time', status: 'cancelled', rescheduledToId: successor }),
              booking({
                id: 'b0000000-0000-7000-8000-000000000003',
                title: 'Cancelled meeting',
                status: 'cancelled',
                rescheduledToId: null,
              }),
              booking({
                id: 'b0000000-0000-7000-8000-000000000004',
                title: 'Current meeting',
                rescheduledToId: successor,
              }),
            ],
            nextCursor: 'successor-on-another-page',
          }),
      })
      renderApp('/app/bookings')
      const original = (await screen.findByRole('rowheader', { name: 'Original time' })).closest(
        'tr',
      ) as HTMLElement
      expect(within(original).getByText(rescheduled)).toBeDefined()
      expect(within(original).queryByText(cancelled)).toBeNull()
      expect(within(original).getByRole('link', { name: viewSuccessor }).getAttribute('href')).toBe(
        `/app/bookings/${successor}`,
      )
      const cancelledRow = screen
        .getByRole('rowheader', { name: 'Cancelled meeting' })
        .closest('tr') as HTMLElement
      expect(within(cancelledRow).getByText(cancelled)).toBeDefined()
      expect(within(cancelledRow).queryByRole('link', { name: viewSuccessor })).toBeNull()
      const currentRow = screen
        .getByRole('rowheader', { name: 'Current meeting' })
        .closest('tr') as HTMLElement
      expect(within(currentRow).getByText(confirmed)).toBeDefined()
      expect(within(currentRow).queryByRole('link', { name: viewSuccessor })).toBeNull()
    },
  )

  it('loads more with the cursor, keeping the same filters', async () => {
    const user = userEvent.setup()
    const pages: Record<string, { data: Booking[]; nextCursor: string | null }> = {
      first: { data: numbered(1, 2), nextCursor: 'cursor-1' },
      'cursor-1': { data: numbered(3, 2), nextCursor: 'cursor-2' },
      'cursor-2': { data: numbered(5, 1), nextCursor: null },
    }
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) => json(200, pages[query(path).cursor ?? 'first']),
    })
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Call 2' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('rowheader', { name: 'Call 4' })
    // Keyboard and screen reader users continue at the first new booking.
    await waitForFocus(screen.getByRole('link', { name: 'Call 3' }))
    expect(screen.getByText('Showing 4 bookings.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('rowheader', { name: 'Call 5' })
    expect(screen.getAllByRole('rowheader').map((th) => th.textContent)).toEqual([
      'Call 1',
      'Call 2',
      'Call 3',
      'Call 4',
      'Call 5',
    ])
    expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()

    const calls = api.to('GET /api/v1/bookings').map((c) => query(c.path))
    expect(calls.map((q) => q.cursor)).toEqual([undefined, 'cursor-1', 'cursor-2'])
    // Every page asks for the same range.
    expect(new Set(calls.map((q) => q.endAfter)).size).toBe(1)
    expect(calls.every((q) => q.limit === String(PAGE_SIZE))).toBe(true)
  })

  it('shows past bookings, newest first, before now', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) =>
        query(path).endTo
          ? json(200, {
              data: [
                booking({ start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T09:30:00.000Z' }),
              ],
              nextCursor: null,
            })
          : json(200, { data: [], nextCursor: null }),
    })
    renderApp('/app/bookings')
    expect(await screen.findByText('No upcoming bookings.')).toBeDefined()
    await user.click(screen.getByRole('link', { name: 'Past' }))
    expect(await screen.findByRole('rowheader', { name: 'Intro call' })).toBeDefined()
    expect(location()).toBe('/app/bookings?tab=past')
    expect(screen.getByRole('link', { name: 'Past' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText(/Newest first\./)).toBeDefined()
    const past = query(api.to('GET /api/v1/bookings')[1]?.path ?? '')
    expect(Date.parse(past.endTo ?? '')).toBeLessThanOrEqual(Date.now())
    expect(past.endAfter).toBeUndefined()
    expect(past.order).toBe('desc')
  })

  it('continues past pages newest first while keeping the same instant and direction', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) =>
        json(
          200,
          query(path).cursor
            ? { data: numbered(1, 1), nextCursor: null }
            : { data: numbered(2, 2).toReversed(), nextCursor: 'older-page' },
        ),
    })
    renderApp('/app/bookings?tab=past')
    await screen.findByRole('rowheader', { name: 'Call 3' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('rowheader', { name: 'Call 1' })
    expect(screen.getAllByRole('rowheader').map((row) => row.textContent)).toEqual([
      'Call 3',
      'Call 2',
      'Call 1',
    ])
    const calls = api.to('GET /api/v1/bookings').map((call) => query(call.path))
    expect(calls.map((q) => q.order)).toEqual(['desc', 'desc'])
    expect(calls[1]?.endTo).toBe(calls[0]?.endTo)
    expect(calls[1]?.cursor).toBe('older-page')
    expect(screen.queryByRole('button', { name: 'Show more bookings' })).toBeNull()
  })

  it('says when there are no past bookings, in the browser’s zone without a profile', async () => {
    fakeApi({
      ...signedIn,
      ...profile(null),
      'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    })
    renderApp('/app/bookings?tab=past')
    expect(await screen.findByText('No past bookings yet.')).toBeDefined()
    expect(screen.getByText(/this browser’s time zone/)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Set your time zone' }).getAttribute('href')).toBe(
      '/app/settings',
    )
  })

  it('keeps what it has when loading more fails', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) =>
        query(path).cursor
          ? json(500, { error: 'internal_error' })
          : json(200, { data: numbered(1, 1), nextCursor: 'next' }),
    })
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Call 1' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load more bookings/)
    expect(screen.getByRole('rowheader', { name: 'Call 1' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Show more bookings' })).toBeDefined()
  })

  it('starts each tab with its own first page after pagination', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': ({ path }) => {
        const q = query(path)
        if (q.endTo) return json(200, { data: [booking({ title: 'Past call' })], nextCursor: null })
        return json(
          200,
          q.cursor
            ? { data: numbered(2, 1), nextCursor: null }
            : { data: numbered(1, 1), nextCursor: 'next' },
        )
      },
    })
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Call 1' })
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('rowheader', { name: 'Call 2' })
    await user.click(screen.getByRole('link', { name: 'Past' }))
    await screen.findByRole('rowheader', { name: 'Past call' })
    expect(screen.queryByRole('rowheader', { name: 'Call 2' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Upcoming' }))
    await screen.findByRole('rowheader', { name: 'Call 1' })
    expect(screen.queryByRole('rowheader', { name: 'Call 2' })).toBeNull()
    expect(screen.queryByRole('rowheader', { name: 'Past call' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show more bookings' })).toBeDefined()
    expect(query(api.to('GET /api/v1/bookings').at(-1)?.path ?? '').cursor).toBeUndefined()
  })
})

describe('a booking', () => {
  it('localizes Chinese location, time zone, guest and multi-select punctuation', async () => {
    chooseLanguage('zh-CN')
    bookingServer(withAnswers)
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const when = await screen.findByRole('region', { name: '时间' })
    expect(when.textContent).toContain('电话会议：+14155550123')
    const people = screen.getByRole('region', { name: '人员' })
    expect(people.textContent).toContain('时区：America/New York（')
    expect(people.textContent).toContain('，当地时间）')
    expect(people.textContent).toContain('Alan Turing（alan@example.com）')
    const answers = within(screen.getByRole('region', { name: '回答' }))
    expect(answers.getAllByRole('definition').map((dd) => dd.textContent)).toEqual([
      'Acme',
      'Pro、Team',
      '是',
      'Old answer',
    ])
  })

  const withAnswers = booking({
    responses: { plan: ['Pro', 'Team'], company: 'Acme', agree: true, retired: 'Old answer' },
  })
  const asks = eventType({
    questions: [
      { id: 'company', label: 'Company', type: 'short_text', required: true },
      {
        id: 'plan',
        label: 'Plans',
        type: 'multi_select',
        required: false,
        options: ['Pro', 'Team'],
      },
      { id: 'agree', label: 'I agree', type: 'checkbox', required: true },
      { id: 'phone', label: 'Phone', type: 'phone', required: false },
    ],
  })

  function bookingServer(current: Booking, extra: Routes = {}) {
    let state = current
    return fakeApi({
      ...signedIn,
      ...profile(),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(200, state),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, asks),
      [`POST /api/v1/bookings/${BOOKING_ID}/cancel`]: ({ body }) => {
        const reason = (body as { reason?: string } | undefined)?.reason ?? null
        state = {
          ...state,
          status: 'cancelled',
          cancelledAt: '2030-02-02T10:00:00.000Z',
          cancelReason: reason,
        }
        return json(200, state)
      },
      ...extra,
    })
  }

  it.each([
    ['en', 'Rescheduled', 'View rescheduled booking', 'Cancelled'],
    ['zh-CN', '已改期', '查看改期后的预约', '已取消'],
  ] as const)(
    'labels the rescheduled predecessor and links its successor in %s detail',
    async (language, rescheduled, viewSuccessor, cancelled) => {
      chooseLanguage(language)
      const successor = 'b0000000-0000-7000-8000-000000000002'
      bookingServer(booking({ status: 'cancelled', rescheduledToId: successor }))
      renderApp(`/app/bookings/${BOOKING_ID}`)
      const heading = await screen.findByRole('heading', { level: 1 })
      expect(heading.textContent).toBe(`Intro call${rescheduled}`)
      expect(screen.queryByText(cancelled)).toBeNull()
      expect(screen.getByRole('link', { name: viewSuccessor }).getAttribute('href')).toBe(
        `/app/bookings/${successor}`,
      )
      expect(screen.queryByRole('button', { name: 'Cancel booking…' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Reschedule booking…' })).toBeNull()
    },
  )

  it.each([
    ['web', 'the booking page', '预约页面'],
    ['embed', 'an embedded booking page', '嵌入的预约页面'],
    ['api', 'an agent or script (API)', '代理或脚本（API）'],
    ['mcp', 'an AI agent (MCP)', 'AI 代理（MCP）'],
  ] as const)('localizes the %s source clause on a rescheduled booking', async (source, en, zh) => {
    const user = userEvent.setup()
    chooseLanguage('en')
    bookingServer(booking({ source, rescheduledFromId: 'b0000000-0000-7000-8000-000000000002' }))
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const when = await screen.findByRole('region', { name: 'When' })
    const booked = within(when).getByText('Booked').nextElementSibling
    expect(booked?.textContent?.endsWith(`, through ${en}`)).toBe(true)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(within(when).getByText('已预约').nextElementSibling).toBe(booked)
    expect(booked?.textContent?.endsWith(`，通过${zh}`)).toBe(true)
  })

  it.each(['fa-IR', 'th-TH'])(
    'uses Gregorian dates in booking detail for browser locale %s',
    async (locale) => {
      browserLocale(locale)
      const current = booking()
      bookingServer(current)
      renderApp(`/app/bookings/${BOOKING_ID}`)
      const when = await screen.findByRole('region', { name: 'When' })
      expect(when.textContent).toContain(
        new Intl.DateTimeFormat(locale, {
          calendar: 'gregory',
          timeZone: 'Europe/Berlin',
          dateStyle: 'full',
        }).format(new Date(current.start)),
      )
      const people = screen.getByRole('region', { name: 'People' })
      expect(people.textContent).toContain(
        new Intl.DateTimeFormat(locale, {
          calendar: 'gregory',
          timeZone: 'America/New_York',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(current.start)),
      )
    },
  )

  it('shows the host’s end date for an overnight booking in the detail', async () => {
    bookingServer(booking({ end: '2030-03-05T09:00:00.000Z' }))
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const when = await screen.findByRole('region', { name: 'When' })
    expect(when.textContent).toMatch(/10:00\sAM – Mar 5, 2030, 10:00\sAM/)
  })

  it('shows the invitee, guests, answers, location and times in the host’s zone', async () => {
    bookingServer(withAnswers)
    renderApp(`/app/bookings/${BOOKING_ID}`)
    expect(await screen.findByRole('heading', { name: 'Intro call', level: 1 })).toBeDefined()
    const when = screen.getByRole('region', { name: 'When' })
    expect(when.textContent).toMatch(/Monday, March 4, 2030/)
    expect(when.textContent).toMatch(/10:00\sAM – 10:30\sAM \(Europe\/Berlin\)/)
    expect(within(when).getByRole('link', { name: '+14155550123' }).getAttribute('href')).toBe(
      'tel:+14155550123',
    )
    expect(when.textContent).toContain('through the booking page')

    const people = screen.getByRole('region', { name: 'People' })
    expect(within(people).getByRole('link', { name: 'grace@example.com' })).toBeDefined()
    // The invitee's own zone, and the time there.
    expect(people.textContent).toMatch(
      /Time zone: America\/New York \(Mar 4, 2030, 4:00\sAM – Mar 4, 2030, 4:30\sAM there\)/,
    )
    expect(people.textContent).toContain('Alan Turing (alan@example.com)')

    const answers = within(screen.getByRole('region', { name: 'Answers' }))
    const terms = answers.getAllByRole('term').map((dt) => dt.textContent)
    // In the order of the questions; answers to questions no longer asked last, by id.
    expect(terms).toEqual(['Company', 'Plans', 'I agree', 'retired'])
    const values = answers.getAllByRole('definition').map((dd) => dd.textContent)
    expect(values).toEqual(['Acme', 'Pro, Team', 'Yes', 'Old answer'])
  })

  it('shows the date at both ends when the invitee’s local meeting crosses midnight', async () => {
    bookingServer(booking({ start: '2030-03-05T04:45:00.000Z', end: '2030-03-05T05:15:00.000Z' }))
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const people = await screen.findByRole('region', { name: 'People' })
    expect(people.textContent).toMatch(/Mar 4, 2030, 11:45\sPM – Mar 5, 2030, 12:15\sAM there/)
  })

  it('labels answers by id when the event type is gone', async () => {
    bookingServer(withAnswers, {
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
        json(404, { error: 'event_type_not_found' }),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const region = await screen.findByRole('region', { name: 'Answers' })
    expect(
      within(region)
        .getAllByRole('term')
        .map((dt) => dt.textContent),
    ).toEqual(['plan', 'company', 'agree', 'retired'])
  })

  it('is cancelled by the host with a reason', async () => {
    const user = userEvent.setup()
    const api = bookingServer(booking())
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const section = await screen.findByRole('region', { name: 'Cancel this booking' })
    await user.click(within(section).getByRole('button', { name: 'Cancel booking…' }))
    const reason = within(section).getByLabelText(/Reason/)
    await waitForFocus(reason)

    // Keeping it closes the form and goes back to the button.
    await user.click(within(section).getByRole('button', { name: 'Keep booking' }))
    await waitForFocus(within(section).getByRole('button', { name: 'Cancel booking…' }))
    expect(api.to(`POST /api/v1/bookings/${BOOKING_ID}/cancel`)).toHaveLength(0)

    await user.click(within(section).getByRole('button', { name: 'Cancel booking…' }))
    await user.type(within(section).getByLabelText(/Reason/), 'Sick, sorry.{Enter}Next week?')
    await user.click(within(section).getByRole('button', { name: 'Cancel booking' }))

    const status = await screen.findByText('The booking is cancelled.')
    expect(document.activeElement).toBe(status)
    expect(api.to(`POST /api/v1/bookings/${BOOKING_ID}/cancel`).map((c) => c.body)).toEqual([
      { reason: 'Sick, sorry.\nNext week?' },
    ])
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Intro callCancelled')
    expect(screen.getByText(/Reason: Sick, sorry\./)).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Cancel this booking' })).toBeNull()
  })

  it('is cancelled without a reason', async () => {
    const user = userEvent.setup()
    const api = bookingServer(booking())
    renderApp(`/app/bookings/${BOOKING_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText('The booking is cancelled.')
    expect(api.to(`POST /api/v1/bookings/${BOOKING_ID}/cancel`)[0]?.body).toEqual({})
  })

  it.each([
    [
      json(409, { error: 'booking_in_past', message: 'The booking has already started' }),
      'This booking has already started, so it can no longer be cancelled.',
    ],
    [
      json(500, { error: 'internal_error' }),
      'Could not cancel the booking. Something went wrong on our side. Try again in a moment.',
    ],
  ])('explains a refused cancellation (%#)', async (response, message) => {
    const user = userEvent.setup()
    bookingServer(booking(), { [`POST /api/v1/bookings/${BOOKING_ID}/cancel`]: () => response })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
  })

  it('checks the reason before sending, and shows the server refusing it', async () => {
    const user = userEvent.setup()
    const api = bookingServer(booking(), {
      [`POST /api/v1/bookings/${BOOKING_ID}/cancel`]: () =>
        json(400, { error: 'invalid_reason', message: 'reason must be …' }),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Cancel booking…' }))
    const reason = screen.getByLabelText(/Reason/)
    await user.click(reason)
    await user.paste('x'.repeat(1001))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    expect(document.getElementById('cancel-reason-error')?.textContent).toBe(
      'Error: Use at most 1000 characters (now 1001).',
    )
    expect(reason.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(reason)
    expect(api.to(`POST /api/v1/bookings/${BOOKING_ID}/cancel`)).toHaveLength(0)

    await user.clear(reason)
    await user.type(reason, 'Fine')
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await vi.waitFor(() =>
      expect(document.getElementById('cancel-reason-error')?.textContent).toBe(
        'Error: Use at most 1000 characters, without control characters other than tabs and line breaks.',
      ),
    )
  })

  it('offers no cancelling for a booking that has started or is cancelled', async () => {
    bookingServer(booking({ start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T09:30:00.000Z' }))
    renderApp(`/app/bookings/${BOOKING_ID}`)
    await screen.findByRole('heading', { name: 'Intro call', level: 1 })
    expect(screen.queryByRole('region', { name: 'Cancel this booking' })).toBeNull()
  })

  it('says when the booking does not exist', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(404, { error: 'booking_not_found' }),
    })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    expect(await screen.findByRole('heading', { name: 'Booking not found' })).toBeDefined()
  })
})

/** Focus moves after a render (setTimeout); waits for it. */
const waitForFocus = (element: HTMLElement) =>
  vi.waitFor(() => expect(document.activeElement).toBe(element))
