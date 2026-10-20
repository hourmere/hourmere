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
    expect(value.firstElementChild?.className).toBe('table-value')
    expect(value.childNodes).toHaveLength(1)
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
      zh ? ['时长', '预约链接', '状态'] : ['Duration', 'Booking link', 'Status'],
    )
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
  })
})
