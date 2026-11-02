import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import * as formatting from '../../format.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { offsetAt, wallTime } from '../../public/time.ts'
import styles from '../../styles.css?raw'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import bookingStyles from './team-bookings.css?raw'

const PAGE = '/app/team/bookings'
const LIST = 'GET /api/v1/team/bookings'
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}
function booking(
  overrides: Partial<Schemas['TeamAdminBooking']> = {},
): Schemas['TeamAdminBooking'] {
  return {
    id: 'b0000000-0000-7000-8000-000000000001',
    eventType: {
      id: 'e0000000-0000-7000-8000-000000000001',
      title: 'Global sync',
      publicBookingPath: null,
    },
    status: 'confirmed',
    isRescheduled: false,
    start: '2030-03-04T23:45:00.000Z',
    end: '2030-03-05T00:15:00.000Z',
    cancelledAt: null,
    hosts: [
      {
        userId: 'a0000000-0000-7000-8000-000000000001',
        name: 'Liam LA',
        timeZone: 'America/Los_Angeles',
        isCurrentMember: true,
      },
      {
        userId: 'a0000000-0000-7000-8000-000000000002',
        name: 'Berta Berlin',
        timeZone: 'Europe/Berlin',
        isCurrentMember: true,
      },
    ],
    attendees: [
      {
        name: 'Ivy Invitee',
        email: 'team-booking-invitee@example.test',
        timeZone: 'Asia/Shanghai',
        isBooker: true,
      },
    ],
    ...overrides,
  }
}
function server(overrides: Routes = {}, current = booking()) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile({ ...PROFILE, timeZone: 'America/New_York' }),
    [LIST]: () => json(200, { data: [current], nextCursor: null }),
    ...overrides,
  })
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture or rendered booking field')
  return value
}
const detail = () => screen.getByRole('region', { name: 'Team booking details' })
const displayed = (term: string) =>
  within(detail()).getByText(term, { selector: 'dt' }).nextElementSibling
async function openDetail(title = 'Global sync') {
  await userEvent.setup().click(await screen.findByRole('button', { name: title }))
}
const copy = [
  {
    locale: 'en',
    hosts: 'Hosts',
    invitee: 'Invitee',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
    rescheduled: 'Rescheduled',
    zone: 'Times are in America/New York, your time zone.',
  },
  {
    locale: 'zh-CN',
    hosts: '主持人',
    invitee: '受邀人',
    confirmed: '已确认',
    cancelled: '已取消',
    rescheduled: '已改期',
    zone: '时间使用以下时区：America/New York（你的时区）。',
  },
] as const

describe('team booking acceptance polish', () => {
  it.each(copy)(
    'lists all saved collective hosts and only the assigned round-robin host in $locale',
    async (text) => {
      chooseLanguage(text.locale)
      const collective = booking()
      const assigned = booking({
        id: 'b0000000-0000-7000-8000-000000000002',
        eventType: { ...required(collective.eventType), title: 'Support rotation' },
        hosts: [required(collective.hosts[1])],
      })
      server({
        ...profile({ ...PROFILE, locale: text.locale }),
        [LIST]: () => json(200, { data: [collective, assigned], nextCursor: null }),
      })
      const sheet = document.createElement('style')
      sheet.textContent = styles + bookingStyles
      document.head.append(sheet)
      try {
        renderApp(PAGE)
        const collectiveRow = required(
          (await screen.findByRole('button', { name: 'Global sync' })).closest('tr'),
        )
        const assignedRow = required(
          screen.getByRole('button', { name: 'Support rotation' }).closest('tr'),
        )
        expect(screen.getByRole('columnheader', { name: text.hosts })).toBeDefined()
        const hosts = required(collectiveRow.querySelector(`td[data-label="${text.hosts}"]`))
        expect(
          within(hosts as HTMLElement)
            .getAllByRole('listitem')
            .map((host) => host.textContent),
        ).toEqual(['Liam LA', 'Berta Berlin'])
        expect(assignedRow.querySelector(`td[data-label="${text.hosts}"]`)?.textContent).toBe(
          'Berta Berlin',
        )
        // The same field has a phone-card label and can wrap long display names.
        expect(getComputedStyle(required(hosts.querySelector('.table-value'))).overflowWrap).toBe(
          'anywhere',
        )
      } finally {
        sheet.remove()
      }
    },
  )

  it('shows names and useful details without raw booking, event or host IDs', async () => {
    const current = booking()
    server({}, current)
    renderApp(PAGE)
    await openDetail()
    for (const id of [
      current.id,
      required(current.eventType).id,
      ...current.hosts.map((host) => host.userId),
    ]) {
      expect(detail().textContent).not.toContain(id)
    }
    expect(displayed('Hosts')?.textContent).toContain('Liam LA')
    expect(displayed('Hosts')?.textContent).toContain('Berta Berlin')
    expect(displayed('Event')?.textContent).toBe('Global sync')
  })

  it('omits cancellation information for confirmed bookings even with a stale timestamp', async () => {
    server({}, booking({ cancelledAt: '2030-03-01T10:00:00.000Z' }))
    renderApp(PAGE)
    await openDetail()
    expect(displayed('Status')?.textContent).toBe('Confirmed')
    expect(within(detail()).queryByText('Cancelled', { selector: 'dt' })).toBeNull()
    expect(within(detail()).queryByText('Not set')).toBeNull()
    expect(detail().querySelector('time[datetime="2030-03-01T10:00:00.000Z"]')).toBeNull()
  })

  it.each(copy)(
    'uses the profile zone and personal-page wording in the list, details and cancellation in $locale',
    async (text) => {
      chooseLanguage(text.locale)
      vi.spyOn(formatting, 'browserTimeZone').mockReturnValue('America/Los_Angeles')
      server({ ...profile({ ...PROFILE, timeZone: 'America/New_York', locale: text.locale }) })
      renderApp(PAGE)
      await screen.findByRole('button', { name: 'Global sync' })
      expect(document.querySelector('.zone-note')?.textContent).toContain(text.zone)
      const row = required(screen.getByRole('button', { name: 'Global sync' }).closest('tr'))
      const format = formatting.zoned('America/New_York', text.locale)
      const current = booking()
      expect(row.querySelector('.booking-when time')?.textContent).toBe(
        `${format.date(current.start)} ${format.timeRange(current.start, current.end)}`,
      )
      await openDetail()
      const panel = screen.getByRole('region', {
        name: text.locale === 'en' ? 'Team booking details' : '团队预约详情',
      })
      const when = within(panel).getByText(text.locale === 'en' ? 'When' : '时间', {
        selector: 'dt',
      }).nextElementSibling
      expect(when?.textContent).toBe(
        `${format.dateTime(current.start)} – ${format.dateTime(current.end)}`,
      )
      await userEvent.setup().click(
        screen.getByRole('button', {
          name: text.locale === 'en' ? 'Cancel booking…' : '取消预约…',
        }),
      )
      const summary = screen.getByRole('region', {
        name: text.locale === 'en' ? 'Cancel this booking' : '取消此预约',
      })
      expect(summary.textContent).toContain(format.dateTimeRange(current.start, current.end))
      expect(summary.textContent).toContain(
        text.locale === 'en' ? 'Your time zone: America/New York' : '你的时区：America/New York',
      )
    },
  )

  it('reads and writes filter wall times in the profile zone across a day boundary', async () => {
    vi.spyOn(formatting, 'browserTimeZone').mockReturnValue('America/Los_Angeles')
    const api = server()
    renderApp(`${PAGE}?from=2030-03-05T00%3A00%3A00.000Z`)
    await screen.findByRole('button', { name: 'Global sync' })
    await userEvent.setup().click(screen.getByText('Filter bookings', { selector: 'summary' }))
    const from = screen.getByLabelText(/^Starts at or after/) as HTMLInputElement
    expect(from.value).toBe('2030-03-04T19:00')
    fireEvent.change(from, { target: { value: '2030-03-04T20:00' } })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
    expect(new URL(required(api.to(LIST)[1]).path, location.origin).searchParams.get('from')).toBe(
      '2030-03-05T01:00:00.000Z',
    )
    expect((screen.getByLabelText(/^Starts at or after/) as HTMLInputElement).value).toBe(
      '2030-03-04T20:00',
    )
  })

  const transitions = [
    ['America/New_York', '2030-03-10T02:30', '2030-03-10T07:30:00.000Z'],
    ['Europe/Berlin', '2026-03-29T02:30', '2026-03-29T01:30:00.000Z'],
    ['America/New_York', '2026-11-01T01:30', '2026-11-01T05:30:00.000Z'],
    ['Europe/Berlin', '2026-10-25T02:30', '2026-10-25T00:30:00.000Z'],
  ] as const

  it.each(transitions)(
    'converts %s filter time %s compatibly across offset transitions',
    async (timeZone, wall, expected) => {
      const api = server(profile({ ...PROFILE, timeZone }))
      renderApp(PAGE)
      await screen.findByRole('button', { name: 'Global sync' })
      await userEvent.setup().click(screen.getByText('Filter bookings', { selector: 'summary' }))
      fireEvent.change(screen.getByLabelText(/^Starts at or after/), { target: { value: wall } })
      await userEvent.setup().click(screen.getByRole('button', { name: 'Apply filters' }))
      await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
      expect(
        new URL(required(api.to(LIST)[1]).path, location.origin).searchParams.get('from'),
      ).toBe(expected)
    },
  )

  it.each([
    ['backward gap conversion', 'Math.max(...candidates)', 'Math.min(...candidates)'],
    ['later repeated time', 'Math.min(...exact)', 'Math.max(...exact)'],
  ])('detects %s in a source copy with a real assertion failure', async (_, before, after) => {
    const source = readFileSync('apps/web/src/pages/team-bookings/TeamBookings.tsx', 'utf8')
    const start = source.indexOf('function filterInstant(')
    const original = source.slice(start, source.indexOf('\nfunction instant(', start))
    expect(original).toContain(before)
    const compile = (copy: string) =>
      new Function('offsetAt', 'wallTime', `${stripTypeScriptTypes(copy)}; return filterInstant`)(
        offsetAt,
        wallTime,
      ) as (wall: string, zone: string) => string
    const verify = (filter: ReturnType<typeof compile>) => {
      for (const [zone, wall, expected] of transitions) expect(filter(wall, zone)).toBe(expected)
    }
    verify(compile(original))
    await expect(
      Promise.resolve().then(() => verify(compile(original.replace(before, after)))),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('uses the browser fallback and settings link only when the profile does not exist', async () => {
    vi.spyOn(formatting, 'browserTimeZone').mockReturnValue('Asia/Tokyo')
    server(profile(null))
    renderApp(PAGE)
    await screen.findByRole('button', { name: 'Global sync' })
    const note = required(document.querySelector('.zone-note'))
    expect(note.textContent).toBe(
      'Oldest first. Times are in Asia/Tokyo, this browser’s time zone. Set your time zone.',
    )
    expect(
      within(note as HTMLElement)
        .getByRole('link', { name: 'Set your time zone' })
        .getAttribute('href'),
    ).toBe('/app/settings')
  })

  it('keeps a profile-loading error neutral and retries instead of choosing the browser zone', async () => {
    const pending = later()
    let reads = 0
    const api = server({
      'GET /api/v1/profile': () =>
        ++reads === 2 ? pending.response : json(200, { ...PROFILE, timeZone: 'America/New_York' }),
    })
    renderApp(PAGE)
    await screen.findByRole('status', { name: 'Loading team bookings…' })
    expect(api.to(LIST)).toHaveLength(0)
    await pending.answer(json(500, { error: 'internal_error' }))
    await screen.findByText(/Could not load team bookings/)
    expect(document.body.textContent).not.toContain('this browser’s time zone')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: 'Global sync' })
    expect(document.querySelector('.zone-note')?.textContent).toContain(
      'America/New York, your time zone.',
    )
  })

  it.each(copy)(
    'distinguishes rescheduled withdrawals from actual cancellations without changing the API status in $locale',
    async (text) => {
      chooseLanguage(text.locale)
      const current = booking({
        status: 'cancelled',
        isRescheduled: true,
        cancelledAt: '2030-03-01T10:00:00.000Z',
      })
      server({
        ...profile({ ...PROFILE, locale: text.locale }),
        [LIST]: () =>
          json(200, {
            data: [
              current,
              booking({
                id: 'b0000000-0000-7000-8000-000000000002',
                eventType: { ...required(current.eventType), title: 'Cancelled meeting' },
                status: 'cancelled',
              }),
            ],
            nextCursor: null,
          }),
      })
      renderApp(`${PAGE}?tab=all`)
      const row = required(
        (await screen.findByRole('button', { name: 'Global sync' })).closest('tr'),
      )
      expect(row.querySelector('.badge')?.textContent).toBe(text.rescheduled)
      expect(row.querySelector('.badge-danger')).toBeNull()
      expect(
        screen
          .getByRole('button', { name: 'Cancelled meeting' })
          .closest('tr')
          ?.querySelector('.badge')?.textContent,
      ).toBe(text.cancelled)
      await openDetail()
      const panel = screen.getByRole('region', {
        name: text.locale === 'en' ? 'Team booking details' : '团队预约详情',
      })
      expect(within(panel).getByText(text.rescheduled, { selector: 'dd' })).toBeDefined()
      expect(within(panel).queryByText(text.cancelled, { selector: 'dt' })).toBeNull()
      expect(
        within(panel)
          .getByText(text.rescheduled, { selector: 'dt' })
          .nextElementSibling?.querySelector('time')?.dateTime,
      ).toBe(current.cancelledAt)
    },
  )

  it('prefers an email break after @ while preserving the full domain and copied address', async () => {
    server()
    const sheet = document.createElement('style')
    sheet.textContent = styles + bookingStyles
    document.head.append(sheet)
    try {
      renderApp(PAGE)
      const row = required(
        (await screen.findByRole('button', { name: 'Global sync' })).closest('tr'),
      )
      const email = required(row.querySelector('.team-booking-email'))
      expect(email.textContent).toBe('team-booking-invitee@example.test')
      expect(email.querySelectorAll('wbr')).toHaveLength(1)
      expect(email.querySelector('wbr')?.previousElementSibling?.textContent).toBe(
        'team-booking-invitee@',
      )
      const domain = required(email.querySelector('wbr')?.nextElementSibling)
      expect(domain.textContent).toBe('example.test')
      expect(getComputedStyle(domain).display).toBe('inline-block')
      expect(getComputedStyle(domain).maxWidth).toBe('100%')
      expect(getComputedStyle(domain).overflowWrap).toBe('anywhere')
      expect(getComputedStyle(email).overflowWrap).toBe('normal')
    } finally {
      sheet.remove()
    }
  })
})

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
