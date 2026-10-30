import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from './i18n/store.ts'
import { fakeApi, json, ME, organizations, profile, renderApp, signedIn } from './test/fake-api.tsx'
import { booking, eventType, schedule } from './test/fixtures.ts'

function expectCardMarkup(table: HTMLElement, variant: string, labels: string[]) {
  expect(table.parentElement?.className).toBe('table-container')
  expect(table.classList.contains(`table-${variant}`)).toBe(true)
  const row = table.querySelector('tbody tr')
  expect(row).not.toBeNull()
  expect(row?.querySelector('th[scope="row"]')?.getAttribute('data-label')).toBeTruthy()
  const values = Array.from(row?.querySelectorAll('td[data-label]') ?? [])
  expect(values.map((cell) => cell.getAttribute('data-label'))).toEqual(labels)
  for (const value of values) {
    // Anonymous text or multiple children would become extra grid items after the label.
    expect(value.children).toHaveLength(1)
    expect(value.firstElementChild?.classList.contains('table-value')).toBe(true)
    expect(value.childNodes).toHaveLength(1)
  }
}

/**
 * Which cells of a row (by position) may break long user content anywhere, which keep a short
 * value on one line, and which columns shrink to that value. Action cells always shrink.
 */
function expectCellKinds(
  table: HTMLElement,
  kinds: { userContent: number[]; nowrap: number[]; fit: number[] },
) {
  const cells = Array.from(table.querySelectorAll('tbody tr:first-child > *'))
  const headers = Array.from(table.querySelectorAll('thead th'))
  const indexes = (test: (cell: Element) => boolean) =>
    cells.map((cell, index) => (test(cell) ? index : -1)).filter((index) => index >= 0)
  expect(indexes((cell) => cell.classList.contains('user-content'))).toEqual(kinds.userContent)
  expect(indexes((cell) => cell.classList.contains('nowrap'))).toEqual(kinds.nowrap)
  expect(
    indexes((cell) => cell.classList.contains('fit') || cell.classList.contains('actions')),
  ).toEqual(kinds.fit)
  for (const cell of cells) {
    // Breaking anywhere and never breaking contradict each other.
    expect(cell.classList.contains('user-content') && cell.classList.contains('nowrap')).toBe(false)
  }
  for (const [index, header] of headers.entries()) {
    // Headers break only between words, and a shrunk column's header shrinks with it.
    expect(header.classList.contains('user-content')).toBe(false)
    expect(header.classList.contains('fit')).toBe(kinds.fit.includes(index))
  }
}

const longName = '会议'.repeat(100)
const longEmail = `${'invitee'.repeat(20)}@example.test`

describe.each(['en', 'zh-CN'] as const)('table card markup in %s', (language) => {
  const zh = language === 'zh-CN'

  it('keeps the booking title, date, invitee and status available in both layouts', async () => {
    chooseLanguage(language)
    const data = booking()
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/bookings': () =>
        json(200, {
          data: [
            booking({
              title: longName,
              attendees: data.attendees.map((attendee) => ({ ...attendee, email: longEmail })),
              status: 'cancelled',
              rescheduledToId: 'b0000000-0000-7000-8000-000000000002',
            }),
          ],
          nextCursor: null,
        }),
    })
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: longName })
    expectCardMarkup(
      screen.getByRole('table'),
      'bookings',
      zh ? ['时间', '受邀人', '状态'] : ['When', 'Invitee', 'Status'],
    )
    // When and status shrink to their one-line values; title and invitee take the rest.
    expectCellKinds(screen.getByRole('table'), { userContent: [1, 2], nowrap: [], fit: [0, 3] })
    const when = screen.getByRole('table').querySelector('td.booking-when')
    expect(when?.querySelectorAll('time > .nowrap')).toHaveLength(2)
    expect(screen.getByText(longEmail)).toBeDefined()
    expect(
      screen.getByRole('link', { name: zh ? '查看改期后的预约' : 'View rescheduled booking' }),
    ).toBeDefined()
  })

  it('groups the event link and copy button and protects the duration', async () => {
    chooseLanguage(language)
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/event-types': () =>
        json(200, { data: [eventType({ title: longName, durationMinutes: 1439 })] }),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    })
    renderApp('/app/event-types')
    await screen.findByRole('rowheader', { name: longName })
    const table = screen.getByRole('table')
    expectCardMarkup(
      table,
      'event-types',
      zh
        ? ['时长', '预约链接', '状态', '配置检查']
        : ['Duration', 'Booking link', 'Status', 'Configuration checks'],
    )
    // Duration, status and the edit button shrink; the title and link may break anywhere.
    expectCellKinds(table, { userContent: [0, 2], nowrap: [1], fit: [1, 3, 5] })
    expect(table.querySelector('td[data-label]')?.classList.contains('nowrap')).toBe(true)
    expect(table.querySelector('td[data-label]')?.textContent).toBe(
      zh ? '23 小时 59 分钟' : '23 h 59 min',
    )
    expect(table.querySelector('thead th:nth-child(2)')?.classList.contains('nowrap')).toBe(true)
  })

  it('labels API key metadata and keeps revocation reachable', async () => {
    chooseLanguage(language)
    fakeApi({
      ...signedIn,
      ...organizations(),
      'GET /api/auth/api-key/list': () =>
        json(200, {
          apiKeys: [
            {
              id: 'key-1',
              name: longName,
              start: 'hm_Test',
              enabled: true,
              createdAt: '2026-10-01T09:00:00Z',
              expiresAt: null,
              lastRequest: null,
              metadata: { organizationId: ME.organization.id },
            },
          ],
          total: 1,
        }),
    })
    renderApp('/app/api-keys')
    await screen.findByRole('rowheader', { name: longName })
    expectCardMarkup(
      screen.getByRole('table'),
      'api-keys',
      zh
        ? ['密钥', '组织', '创建时间', '上次使用', '到期时间']
        : ['Key', 'Organization', 'Created', 'Last used', 'Expires'],
    )
    // Key prefix, dates and the revoke button shrink; the name and organization may break.
    expectCellKinds(screen.getByRole('table'), {
      userContent: [0, 2],
      nowrap: [1],
      fit: [1, 3, 4, 5, 6],
    })
    expect(screen.getByRole('button', { name: new RegExp(zh ? '撤销' : 'Revoke') })).toBeDefined()
  })

  it('applies the same labeled card pattern to the daily activity table', async () => {
    chooseLanguage(language)
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        json(200, {
          startDate: '2026-03-29',
          endDate: '2026-03-29',
          timeZone: 'UTC',
          totals: { created: 1, rescheduled: 0, cancelled: 0 },
          data: [{ date: '2026-03-29', created: 1, rescheduled: 0, cancelled: 0 }],
        }),
    })
    renderApp('/app/analytics')
    const table = await screen.findByRole('table')
    expectCardMarkup(
      table,
      'analytics',
      zh ? ['新建预约', '改期', '取消'] : ['Bookings created', 'Reschedules', 'Cancellations'],
    )
    // Four short columns: every value stays on one line and auto layout spaces them.
    expectCellKinds(table, { userContent: [], nowrap: [0, 1, 2, 3], fit: [] })
  })
})
