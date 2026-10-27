import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import styles from '../styles.css?raw'
import { fakeApi, json, later, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { schedule } from '../test/fixtures.ts'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
const connection: Schemas['CalendarConnection'] = {
  id: 'a0000000-0000-7000-8000-000000000001',
  provider: 'google',
  accountEmail: 'calendar@example.com',
  status: 'active',
  syncAuthorized: false,
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  calendars: [
    {
      id: 'c0000000-0000-7000-8000-000000000001',
      name: 'Work calendar',
      timeZone: null,
      isPrimary: true,
      checkConflicts: false,
      accessRole: 'owner',
      lastSyncedAt: null,
      syncError: null,
    },
  ],
}
const list = (
  data = [connection],
  googleEnabled = true,
  microsoftEnabled = false,
  destinationCalendarId: string | null = null,
) => ({
  'GET /api/v1/calendar-connections': () =>
    json(200, { data, googleEnabled, microsoftEnabled, destinationCalendarId }),
})
const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=fake-state'
const definition = (container: HTMLElement, label: string) => {
  const value = within(container).getByText(label, { selector: 'dt' }).nextElementSibling
  expect(value?.tagName).toBe('DD')
  return value as HTMLElement
}

describe('the calendars page', () => {
  it('puts connected accounts before connection options and their permission disclosures', async () => {
    fakeApi({ ...signedIn, ...profile(), ...list([connection], true, true) })
    renderApp('/app/calendars')
    const accounts = await screen.findByRole('region', { name: 'Connected accounts' })
    for (const provider of ['Google', 'Microsoft']) {
      const options = screen.getByRole('region', { name: `Connect ${provider} Calendar` })
      expect(accounts.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
  })

  it.each(['needs_reauth', 'revoked', 'permissions_missing'] as const)(
    'identifies the account that needs reconnection for %s even when its calendar last synchronized',
    async (failure) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list([
          {
            ...connection,
            syncAuthorized: true,
            calendars: [
              { ...calendar, checkConflicts: true, lastSyncedAt: '2026-10-16T12:00:00Z' },
            ],
          },
          {
            ...connection,
            id: 'a0000000-0000-7000-8000-000000000002',
            accountEmail: 'reconnect@example.com',
            status: failure === 'permissions_missing' ? 'active' : failure,
            lastError: failure === 'permissions_missing' ? failure : null,
            syncAuthorized: true,
            calendars: [
              {
                ...calendar,
                id: 'c0000000-0000-7000-8000-000000000002',
                checkConflicts: true,
                lastSyncedAt: '2026-10-16T12:00:00Z',
              },
            ],
          },
        ]),
      })
      renderApp('/app/calendars')
      const healthy = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      const reconnect = screen
        .getByRole('heading', { name: 'reconnect@example.com' })
        .closest('article') as HTMLElement
      expect(within(healthy).getByText('Connected')).toBeDefined()
      expect(definition(healthy, 'Busy-time sync').textContent).toBe(
        'Selected conflict calendars synchronized.',
      )
      expect(within(reconnect).getByText('Reconnect required')).toBeDefined()
      expect(definition(reconnect, 'Busy-time sync').textContent).toBe(
        'Paused until you reconnect this account.',
      )
      expect(within(reconnect).getByRole('alert').textContent).toContain(
        'account again to restore it.',
      )
    },
  )

  it.each(['google', 'microsoft'] as const)(
    'links a retained %s account to its disabled-provider explanation when reconnection is unavailable',
    async (provider) => {
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              provider,
              status: 'needs_reauth',
              syncAuthorized: provider === 'google',
            },
          ],
          false,
          false,
        ),
      })
      renderApp('/app/calendars')
      const article = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      const link = within(article).getByRole('link', {
        name: 'Review calendar connection options',
      })
      const targetId =
        provider === 'google'
          ? 'calendar-connection-options'
          : 'microsoft-calendar-connection-options'
      expect(link.getAttribute('href')).toBe(`#${targetId}`)
      const target = document.getElementById(targetId)
      expect(target?.getAttribute('tabindex')).toBe('-1')
      expect(target?.textContent).toBe(
        `${provider === 'google' ? 'Google' : 'Microsoft'} Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.`,
      )
      for (const name of [
        'Connect Google Calendar',
        'Connect Microsoft Calendar',
        'Enable calendar synchronization',
      ])
        expect(screen.queryByRole('button', { name })).toBeNull()
    },
  )

  it.each([
    {
      name: 'a failed selection beside a successful and a waiting calendar',
      failed: true,
      waiting: true,
      selected: true,
      expected: 'Synchronization needs attention. Review the failed calendars below.',
    },
    {
      name: 'a waiting selection beside a successful calendar',
      failed: false,
      waiting: true,
      selected: true,
      expected: 'Waiting for the first synchronization on selected calendars.',
    },
    {
      name: 'successful selections beside an unused failed calendar',
      failed: false,
      waiting: false,
      selected: true,
      expected: 'Selected conflict calendars synchronized.',
    },
    {
      name: 'no selected conflict calendars',
      failed: false,
      waiting: false,
      selected: false,
      expected: 'No calendars selected for conflict checks.',
    },
  ])('summarizes $name without masking incomplete synchronization', async (state) => {
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list([
        {
          ...connection,
          syncAuthorized: true,
          calendars: [
            {
              ...calendar,
              checkConflicts: state.selected,
              lastSyncedAt: '2026-10-16T12:00:00Z',
            },
            {
              ...calendar,
              id: 'c0000000-0000-7000-8000-000000000002',
              name: 'Failed calendar',
              checkConflicts: state.failed,
              lastSyncedAt: '2026-10-16T12:00:00Z',
              syncError: 'provider_unavailable',
            },
            {
              ...calendar,
              id: 'c0000000-0000-7000-8000-000000000003',
              name: 'Waiting calendar',
              checkConflicts: state.waiting,
              lastSyncedAt: null,
            },
          ],
        },
      ]),
    })
    renderApp('/app/calendars')
    const article = (await screen.findByRole('heading', { name: 'calendar@example.com' })).closest(
      'article',
    ) as HTMLElement
    expect(definition(article, 'Busy-time sync').textContent).toBe(state.expected)
    if (state.failed || state.waiting)
      expect(definition(article, 'Busy-time sync').textContent).not.toBe(
        'Selected conflict calendars synchronized.',
      )
    expect(within(article).queryAllByText(/^Last synchronized:/)).toHaveLength(
      Number(state.selected),
    )
    const failure = within(article).queryByText(
      'Synchronization failed. Booking times stay unavailable until synchronization recovers.',
    )
    if (state.failed) expect(failure).not.toBeNull()
    else expect(failure).toBeNull()
    if (state.waiting)
      expect(
        within(article).getByText(
          'Waiting for the first synchronization. Booking times stay unavailable until it completes.',
        ),
      ).toBeDefined()
  })

  it.each(['en', 'zh-CN'] as const)(
    'limits a successful sync notice to its calendar while another selected calendar remains failed in %s',
    async (locale) => {
      const user = userEvent.setup()
      let synced = false
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      const failedId = 'c0000000-0000-7000-8000-000000000002'
      const requests = fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale }),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: false,
            destinationCalendarId: null,
            data: [
              {
                ...connection,
                syncAuthorized: true,
                calendars: [
                  {
                    ...calendar,
                    checkConflicts: true,
                    lastSyncedAt: synced ? '2026-10-16T12:00:00Z' : null,
                  },
                  {
                    ...calendar,
                    id: failedId,
                    name: 'Failed calendar',
                    isPrimary: false,
                    checkConflicts: true,
                    lastSyncedAt: '2026-10-16T10:00:00Z',
                    syncError: 'provider_unavailable',
                  },
                ],
              },
            ],
          }),
        [`POST /api/v1/calendars/${calendar.id}/sync`]: () => {
          synced = true
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const initialArticle = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      const successfulCalendar = within(initialArticle).getAllByRole('listitem')[0] as HTMLElement
      await user.click(
        within(successfulCalendar).getByRole('button', {
          name: locale === 'en' ? 'Sync now' : '立即同步',
        }),
      )
      await screen.findByText(locale === 'en' ? /^Last synchronized:/ : /^上次同步：/)
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(
        locale === 'en' ? 'Busy times synchronized for this calendar.' : '此日历的忙碌时段已同步。',
      )
      expect(
        screen.queryByText(locale === 'en' ? 'Busy times synchronized.' : '忙闲时间已同步。'),
      ).toBeNull()
      const article = screen
        .getByRole('heading', { name: 'calendar@example.com' })
        .closest('article') as HTMLElement
      expect(
        definition(article, locale === 'en' ? 'Busy-time sync' : '忙碌时段同步').textContent,
      ).toBe(
        locale === 'en'
          ? 'Synchronization needs attention. Review the failed calendars below.'
          : '同步需要处理，请查看下方同步失败的日历。',
      )
      const failedCalendar = within(article)
        .getByRole('heading', { name: 'Failed calendar' })
        .closest('li') as HTMLElement
      expect(
        within(failedCalendar).getByText(
          locale === 'en'
            ? 'Synchronization failed. Booking times stay unavailable until synchronization recovers.'
            : '同步失败。在同步恢复之前，相关时间将保持不可预约。',
        ),
      ).toBeDefined()
      expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(1)
      expect(requests.to(`POST /api/v1/calendars/${failedId}/sync`)).toHaveLength(0)
    },
  )

  it('does not present historical synchronization as available when Google is disabled', async () => {
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list(
        [
          {
            ...connection,
            syncAuthorized: true,
            calendars: [
              { ...calendar, checkConflicts: true, lastSyncedAt: '2026-10-16T12:00:00Z' },
            ],
          },
        ],
        false,
      ),
    })
    renderApp('/app/calendars')
    const article = (await screen.findByRole('heading', { name: 'calendar@example.com' })).closest(
      'article',
    ) as HTMLElement
    expect(definition(article, 'Busy-time sync').textContent).toBe('Unavailable on this instance.')
    expect(within(article).getByRole('button', { name: 'Sync now' }).matches(':disabled')).toBe(
      true,
    )
  })

  it.each(['en', 'zh-CN'] as const)(
    'keeps a calendar-list provider failure visible without calling for new authorization in %s',
    async (locale) => {
      fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale }),
        ...list([{ ...connection, syncAuthorized: true, lastError: 'provider_unavailable' }]),
      })
      renderApp('/app/calendars')
      const article = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      expect(within(article).getByRole('alert').textContent).toBe(
        locale === 'en'
          ? 'The calendar provider could not be reached. Try refreshing the calendar list again.'
          : '无法连接日历服务，请重试刷新日历列表。',
      )
      expect(
        within(article).queryByText(locale === 'en' ? 'Reconnect required' : '需要重新连接'),
      ).toBeNull()
      expect(
        within(article)
          .getByRole('button', {
            name: locale === 'en' ? 'Refresh calendar list' : '刷新日历列表',
          })
          .matches(':disabled'),
      ).toBe(false)
    },
  )

  it.each([
    ['google', false, 'Not enabled — calendar list only.'],
    ['microsoft', false, 'Not available — calendar list only.'],
    ['microsoft', true, 'Not available — calendar list only.'],
  ] as const)(
    'keeps %s list-only capability explicit when sync authorization is %s',
    async (provider, syncAuthorized, expected) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              provider,
              syncAuthorized,
              calendars: [{ ...calendar, lastSyncedAt: '2026-10-16T12:00:00Z' }],
            },
          ],
          true,
          true,
        ),
      })
      renderApp('/app/calendars')
      const article = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      expect(definition(article, 'Busy-time sync').textContent).toBe(expected)
      expect(within(article).queryByRole('button', { name: 'Sync now' })).toBeNull()
      expect(within(article).queryByRole('button', { name: 'Write new bookings here' })).toBeNull()
      expect(within(article).queryByRole('checkbox')).toBeNull()
      if (provider === 'microsoft') {
        expect(within(article).getByText(/lists calendars only/)).toBeDefined()
        expect(
          within(article).queryByRole('button', { name: 'Enable calendar synchronization' }),
        ).toBeNull()
      } else expect(within(article).getByText(/calendar-list access only/)).toBeDefined()
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'shows each calendar conflict and booking purpose separately from its controls in %s',
    async (locale) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      const calendars = [
        { ...calendar, name: 'Busy calendar', checkConflicts: true, accessRole: 'reader' },
        {
          ...calendar,
          id: 'c0000000-0000-7000-8000-000000000002',
          name: 'Booking calendar',
          isPrimary: false,
        },
        {
          ...calendar,
          id: 'c0000000-0000-7000-8000-000000000003',
          name: 'Unused calendar',
          isPrimary: false,
        },
      ]
      fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale }),
        ...list(
          [{ ...connection, syncAuthorized: true, calendars }],
          true,
          false,
          calendars[1]?.id,
        ),
      })
      renderApp('/app/calendars')
      const article = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      const summary = article.querySelector('.calendar-account-summary') as HTMLElement
      const conflictLabel = locale === 'en' ? 'Conflict checks' : '冲突检查'
      const bookingsLabel = locale === 'en' ? 'New bookings' : '新预约'
      expect(definition(summary, conflictLabel).textContent).toBe(
        locale === 'en' ? '1 selected' : '已选择 1 个日历',
      )
      expect(definition(summary, bookingsLabel).textContent).toBe('Booking calendar')
      const items = within(article).getAllByRole('listitem')
      expect(items).toHaveLength(3)
      for (const [index, item] of items.entries()) {
        const purpose = item.querySelector('.calendar-purpose') as HTMLElement
        expect(purpose.closest('fieldset')).toBeNull()
        expect(definition(purpose, conflictLabel).textContent).toBe(
          locale === 'en'
            ? index === 0
              ? 'Selected for conflict checks'
              : 'Not used for conflict checks'
            : index === 0
              ? '已选为冲突检查日历'
              : '不用于冲突检查',
        )
        expect(definition(purpose, bookingsLabel).textContent).toBe(
          locale === 'en'
            ? index === 1
              ? 'Selected for new bookings'
              : 'Not a booking destination'
            : index === 1
              ? '已选为新预约写入目标'
              : '不写入新预约',
        )
        const write = within(item).queryByRole('button', {
          name: locale === 'en' ? 'Write new bookings here' : '将新预约写入此日历',
        })
        if (index === 0) expect(write).toBeNull()
        if (index === 2) expect(write).not.toBeNull()
      }
      const bookingItem = items[1] as HTMLElement
      expect(
        within(bookingItem).getByRole('button', {
          name: locale === 'en' ? 'Stop writing bookings here' : '停止向此日历写入预约',
        }),
      ).toBeDefined()
    },
  )

  it.each([
    ['calendar became read-only', 'reader', true, 'active', true, null],
    ['synchronization access was removed', 'owner', false, 'active', true, null],
    ['account requires reconnection', 'owner', true, 'needs_reauth', true, null],
    ['provider is disabled', 'owner', true, 'active', false, null],
    ['write permission was removed', 'owner', true, 'active', true, 'permissions_missing'],
  ] as const)(
    'marks a retained booking destination unavailable when %s and keeps local clearing available',
    async (_reason, accessRole, syncAuthorized, status, googleEnabled, lastError) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              syncAuthorized,
              status,
              lastError,
              calendars: [{ ...calendar, accessRole }],
            },
          ],
          googleEnabled,
          false,
          calendar.id,
        ),
      })
      renderApp('/app/calendars')
      const article = (
        await screen.findByRole('heading', { name: 'calendar@example.com' })
      ).closest('article') as HTMLElement
      const summary = article.querySelector('.calendar-account-summary') as HTMLElement
      expect(definition(summary, 'New bookings').textContent).toContain(calendar.name)
      expect(
        within(definition(summary, 'New bookings')).getByText('Unavailable for new bookings'),
      ).toBeDefined()
      const item = within(article).getByRole('listitem')
      const purpose = item.querySelector('.calendar-purpose') as HTMLElement
      expect(definition(purpose, 'New bookings').textContent).toBe(
        'Selected for new bookings — unavailable',
      )
      expect(
        within(item)
          .getByRole('button', { name: 'Stop writing bookings here' })
          .matches(':disabled'),
      ).toBe(false)
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'explains a Google calendar zone mismatch using the default schedule rather than the profile in %s',
    async (locale) => {
      const user = userEvent.setup()
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, timeZone: 'Asia/Shanghai' }),
        ...list(
          [{ ...connection, calendars: [{ ...calendar, timeZone: 'America/New_York' }] }],
          true,
          false,
          calendar.id,
        ),
        'GET /api/v1/schedules': () =>
          json(200, {
            data: [
              schedule({ timeZone: 'America/New_York', isDefault: false }),
              schedule({ timeZone: 'America/Los_Angeles' }),
            ],
          }),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      if (locale === 'zh-CN')
        await user.selectOptions(screen.getByLabelText('Interface language'), locale)
      const notice = document.querySelector('.calendar-list .alert-info')
      expect(notice?.textContent).toMatchSnapshot()
      expect(notice?.textContent).not.toContain('_')
      expect(notice?.textContent).not.toContain('Asia/Shanghai')
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  it.each([
    ['reader calendar in another zone', 'reader', 'this', false],
    ['owned non-destination calendar in another zone', 'owner', 'other', false],
    ['owned destination calendar in another zone', 'owner', 'this', true],
    ['no selected destination', 'owner', null, false],
  ] as const)(
    'limits the zone notice to an owned booking destination: %s',
    async (_name, accessRole, selected, expected) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      const otherId = 'c0000000-0000-7000-8000-000000000002'
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              syncAuthorized: true,
              calendars: [
                { ...calendar, accessRole, timeZone: 'America/New_York' },
                {
                  ...calendar,
                  id: otherId,
                  name: 'Other calendar',
                  isPrimary: false,
                  timeZone: 'America/Los_Angeles',
                },
              ],
            },
          ],
          true,
          false,
          selected === 'this' ? calendar.id : selected === 'other' ? otherId : null,
        ),
        'GET /api/v1/schedules': () =>
          json(200, { data: [schedule({ timeZone: 'America/Los_Angeles' })] }),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      const notices = document.querySelectorAll('.calendar-list .alert-info')
      expect(notices).toHaveLength(expected ? 1 : 0)
      if (expected) expect(notices[0]?.closest('li')?.textContent).toContain('Work calendar')
    },
  )

  it.each([
    ['matching zones', 'google', 'America/New_York', 'America/New_York', false],
    ['renamed matching zones', 'google', 'Asia/Calcutta', 'Asia/Kolkata', false],
    ['unknown calendar zone', 'google', null, 'America/Los_Angeles', false],
    ['Microsoft calendar', 'microsoft', 'America/New_York', 'America/Los_Angeles', false],
    ['no default schedule', 'google', 'America/New_York', null, false],
    ['unavailable schedules', 'google', 'America/New_York', 'America/Los_Angeles', true],
  ] as const)(
    'omits the zone notice for %s and keeps calendar controls available',
    async (_name, provider, timeZone, scheduleZone, unavailable) => {
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [
            {
              ...connection,
              provider,
              syncAuthorized: true,
              calendars: [{ ...calendar, timeZone }],
            },
            ...(!timeZone || provider === 'microsoft'
              ? [
                  {
                    ...connection,
                    id: 'a0000000-0000-7000-8000-000000000002',
                    accountEmail: 'other@example.com',
                    syncAuthorized: true,
                    calendars: [{ ...calendar, timeZone: scheduleZone }],
                  },
                ]
              : []),
          ],
          true,
          false,
          calendar.id,
        ),
        'GET /api/v1/schedules': () =>
          unavailable
            ? json(503, { error: 'internal_error' })
            : json(200, { data: scheduleZone ? [schedule({ timeZone: scheduleZone })] : [] }),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      expect(document.querySelector('.calendar-list .alert-info')).toBeNull()
      expect(
        screen
          .getAllByRole('checkbox', { name: 'Check this calendar for conflicts' })[0]
          ?.matches(':disabled'),
      ).toBe(false)
    },
  )

  it('uses a shared introduction and an optional calendar empty state with booking and connection next steps', async () => {
    fakeApi({ ...signedIn, ...profile(), ...list([]) })
    renderApp('/app/calendars')
    await screen.findByText('No calendar accounts connected yet.')
    expect(
      screen
        .getByRole('heading', { name: 'Calendars', level: 1 })
        .closest('.page-intro')
        ?.querySelector('.lede'),
    ).not.toBeNull()
    const action = screen.getByRole('link', { name: 'Review calendar connection options' })
    expect(action.closest('.empty-actions')).not.toBeNull()
    expect(action.getAttribute('href')).toBe('#calendar-connection-options')
    const empty = action.closest('.empty') as HTMLElement
    expect(empty.textContent).toContain(
      'Connecting a calendar is optional. Basic booking works without one. Set up an event type to start taking bookings.',
    )
    expect(
      within(empty).getByRole('link', { name: 'Set up event types' }).getAttribute('href'),
    ).toBe('/app/event-types')
    expect(
      document
        .querySelector('#calendar-connection-options')
        ?.contains(screen.getByRole('button', { name: 'Connect Google Calendar' })),
    ).toBe(true)
  })

  it.each(['en', 'zh-CN'] as const)(
    'keeps basic booking and its next step available when no calendar provider is configured in %s',
    async (locale) => {
      const user = userEvent.setup()
      fakeApi({ ...signedIn, ...profile(), ...list([], false, false) })
      renderApp('/app/calendars')
      await screen.findByText('No calendar accounts connected yet.')
      if (locale === 'zh-CN')
        await user.selectOptions(screen.getByLabelText('Interface language'), locale)
      const empty = document.querySelector('.empty') as HTMLElement
      expect(empty.textContent).toContain(
        locale === 'en' ? 'Basic booking works without one.' : '不连接日历也能使用基础预约。',
      )
      expect(within(empty).getAllByRole('link')).toHaveLength(1)
      expect(
        within(empty)
          .getByRole('link', { name: locale === 'en' ? 'Set up event types' : '设置活动类型' })
          .getAttribute('href'),
      ).toBe('/app/event-types')
      expect(
        within(empty).queryByRole('link', {
          name: locale === 'en' ? 'Review calendar connection options' : '查看日历连接选项',
        }),
      ).toBeNull()
      expect(empty.textContent).not.toContain(
        locale === 'en' ? 'Connect a calendar account to get started.' : '连接日历账号以开始使用。',
      )
    },
  )

  it.each([
    [true, false],
    [false, true],
  ])(
    'keeps connection guidance when Google=%s or Microsoft=%s is configured',
    async (google, microsoft) => {
      fakeApi({ ...signedIn, ...profile(), ...list([], google, microsoft) })
      renderApp('/app/calendars')
      await screen.findByText('No calendar accounts connected yet.')
      const empty = document.querySelector('.empty') as HTMLElement
      expect(empty.textContent).toContain('Connecting a calendar is optional.')
      expect(
        within(empty).getByRole('link', { name: 'Set up event types' }).getAttribute('href'),
      ).toBe('/app/event-types')
      expect(
        within(empty).getByRole('link', { name: 'Review calendar connection options' }),
      ).toBeDefined()
    },
  )
  it('wraps account emails at address separators while preserving the visible address', async () => {
    fakeApi({ ...signedIn, ...profile(), ...list() })
    renderApp('/app/calendars')
    const heading = await screen.findByRole('heading', { name: 'calendar@example.com' })
    expect(heading.textContent).toBe('calendar@example.com')
    expect(heading.querySelectorAll('wbr')).toHaveLength(2)
  })

  it.each([404, 503, 'network'] as const)(
    'keeps calendar controls available after an unrelated profile failure: %s',
    async (failure) => {
      const user = userEvent.setup()
      let recovered = false
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      const requests = fakeApi({
        ...signedIn,
        ...list([{ ...connection, syncAuthorized: true }]),
        'GET /api/v1/profile': () => {
          if (recovered) return json(200, PROFILE)
          if (failure === 'network') throw new TypeError('Failed to fetch')
          return json(failure, { error: 'unexpected_profile_error' })
        },
        [`PATCH /api/v1/calendars/${calendar.id}`]: () => new Response(null, { status: 204 }),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      const hint = screen.getByText(
        'Could not load your profile. Try again before choosing where new bookings are written.',
      ).parentElement as HTMLElement
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Create profile' })).toBeNull()
      const write = screen.getByRole('button', { name: 'Write new bookings here' })
      expect(write.matches(':disabled')).toBe(true)
      expect(write.getAttribute('aria-describedby')).toBe(hint.id)
      await user.click(write)
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      const conflict = screen.getByRole('checkbox', { name: 'Check this calendar for conflicts' })
      expect(conflict.matches(':disabled')).toBe(false)
      await user.click(conflict)
      expect(requests.to(`PATCH /api/v1/calendars/${calendar.id}`)).toHaveLength(1)
      recovered = true
      await user.click(within(hint).getByRole('button', { name: 'Try again' }))
      await vi.waitFor(() => expect(write.matches(':disabled')).toBe(false))
      expect(screen.queryByText(/Could not load your profile/)).toBeNull()
      expect(write.getAttribute('aria-describedby')).toBeNull()
    },
  )

  it.each([404, 503, 'network'] as const)(
    'allows clearing the existing booking destination after a profile failure: %s',
    async (failure) => {
      const user = userEvent.setup()
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      let destination: string | null = calendar.id
      const requests = fakeApi({
        ...signedIn,
        'GET /api/v1/profile': () => {
          if (failure === 'network') throw new TypeError('Failed to fetch')
          return json(failure, { error: 'unexpected_profile_error' })
        },
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: false,
            destinationCalendarId: destination,
            data: [
              {
                ...connection,
                syncAuthorized: true,
                calendars: [
                  calendar,
                  {
                    ...calendar,
                    id: 'c0000000-0000-7000-8000-000000000002',
                    name: 'Other calendar',
                    isPrimary: false,
                  },
                ],
              },
            ],
          }),
        'PUT /api/v1/calendar-destination': () => {
          destination = null
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      const stop = screen.getByRole('button', { name: 'Stop writing bookings here' })
      expect(stop.matches(':disabled')).toBe(false)
      expect(stop.getAttribute('aria-describedby')).toBeNull()
      const write = screen.getByRole('button', { name: 'Write new bookings here' })
      expect(write.matches(':disabled')).toBe(true)
      expect(write.getAttribute('aria-describedby')).toBe('calendar-profile-hint')
      await user.click(write)
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      await user.click(stop)
      await vi.waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Stop writing bookings here' })).toBeNull(),
      )
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(1)
      expect(requests.to('PUT /api/v1/calendar-destination')[0]?.body).toEqual({ calendarId: null })
      for (const button of screen.getAllByRole('button', { name: 'Write new bookings here' }))
        expect(button.matches(':disabled')).toBe(true)
      expect(screen.getByText(/Could not load your profile/)).toBeDefined()
      expect(screen.queryByRole('link', { name: 'Create profile' })).toBeNull()
    },
  )

  it.each([404, 503] as const)(
    'hides profile setup and availability hints before any calendar is connected: %s',
    async (status) => {
      fakeApi({
        ...signedIn,
        ...list([]),
        'GET /api/v1/profile': () =>
          json(status, { error: status === 404 ? 'profile_not_found' : 'internal_error' }),
      })
      renderApp('/app/calendars')
      await screen.findByText('No calendar accounts connected yet.')
      expect(document.getElementById('calendar-profile-hint')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Create profile' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeDefined()
    },
  )

  it('localizes the unavailable-profile hint without claiming a profile is missing', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...list([{ ...connection, syncAuthorized: true }]),
      'GET /api/v1/profile': () => json(503, { error: 'internal_error' }),
    })
    renderApp('/app/calendars')
    await screen.findByRole('heading', { name: 'calendar@example.com' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(screen.getByText('无法加载个人资料。请重试后再选择用于写入新预约的日历。')).toBeDefined()
    expect(screen.queryByRole('link', { name: '创建个人资料' })).toBeNull()
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined()
  })

  it.each([
    ['en', 'Sign in again, then start a new calendar connection.'],
    ['zh-CN', '请重新登录，然后开始新的日历连接。'],
  ] as const)(
    'keeps calendar session callback guidance contextual in %s',
    async (locale, message) => {
      const user = userEvent.setup()
      fakeApi({ ...signedIn, ...list([]) })
      renderApp('/app/calendars?connection=session_required')
      await screen.findByText('No calendar accounts connected yet.')
      if (locale === 'zh-CN')
        await user.selectOptions(
          screen.getByRole('combobox', { name: 'Interface language' }),
          locale,
        )
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(message)
    },
  )

  it.each([
    ['en', 'Create profile', 'Create a profile before choosing where new bookings are written.'],
    ['zh-CN', '创建个人资料', '请先创建个人资料，再选择用于写入新预约的日历。'],
  ] as const)(
    'guides a host without a profile to Settings in %s before writing bookings',
    async (language, createLabel, hint) => {
      const user = userEvent.setup()
      const requests = fakeApi({
        ...signedIn,
        ...list([{ ...connection, syncAuthorized: true }]),
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      if (language === 'zh-CN')
        await user.selectOptions(
          screen.getByRole('combobox', { name: 'Interface language' }),
          language,
        )
      const link = screen.getByRole('link', { name: createLabel })
      expect(link.getAttribute('href')).toBe('/app/settings#profile-heading')
      const destination = screen.getByRole('button', {
        name: language === 'en' ? 'Write new bookings here' : '将新预约写入此日历',
      })
      expect(destination.matches(':disabled')).toBe(true)
      expect(screen.getByText(hint).contains(link)).toBe(true)
      expect(destination.getAttribute('aria-describedby')).toBe(screen.getByText(hint).id)
      await user.click(destination)
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      await user.click(link)
      expect(await screen.findByRole('button', { name: createLabel })).toBeDefined()
      expect(screen.getByTestId('location').textContent).toBe('/app/settings')
    },
  )

  it('separates calendars within one connected account with individual borders', async () => {
    const first = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list([
        {
          ...connection,
          syncAuthorized: true,
          calendars: [
            first,
            { ...first, id: 'c0000000-0000-7000-8000-000000000002', name: 'Other calendar' },
          ],
        },
      ]),
    })
    const sheet = document.createElement('style')
    sheet.textContent = styles
    document.head.append(sheet)
    try {
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      const items = screen.getByText('Work calendar (primary)').closest('ul') as HTMLUListElement
      expect(within(items).getAllByRole('listitem')).toHaveLength(2)
      for (const item of within(items).getAllByRole('listitem')) {
        const style = getComputedStyle(item)
        expect(style.borderTopStyle).toBe('solid')
        expect(style.borderTopWidth).toBe('1px')
      }
    } finally {
      sheet.remove()
    }
  })

  it.each([
    ['en', 'Create your profile in Settings first.'],
    ['zh-CN', '请先在“设置”中创建个人资料。'],
  ] as const)(
    'localizes a stale missing-profile refusal by code in %s and refreshes the hint',
    async (language, expected) => {
      const user = userEvent.setup()
      let hasProfile = true
      fakeApi({
        ...signedIn,
        ...list([{ ...connection, syncAuthorized: true }]),
        'GET /api/v1/profile': () =>
          hasProfile ? json(200, PROFILE) : json(404, { error: 'profile_not_found' }),
        'PUT /api/v1/calendar-destination': () => {
          hasProfile = false
          return json(404, {
            error: 'profile_not_found',
            message: 'Changed server prose, unrelated to any translation key.',
          })
        },
      })
      renderApp('/app/calendars')
      await screen.findByRole('heading', { name: 'calendar@example.com' })
      if (language === 'zh-CN')
        await user.selectOptions(
          screen.getByRole('combobox', { name: 'Interface language' }),
          language,
        )
      await user.click(
        screen.getByRole('button', {
          name: language === 'en' ? 'Write new bookings here' : '将新预约写入此日历',
        }),
      )
      expect((await screen.findByRole('alert')).textContent).toBe(expected)
      const createLabel = language === 'en' ? 'Create profile' : '创建个人资料'
      expect(await screen.findByRole('link', { name: createLabel })).toBeDefined()
      expect(document.body.textContent).not.toContain('Changed server prose')
    },
  )

  it.each([
    ['en', 'Check this calendar for conflicts', 'Write new bookings here', false],
    ['en', 'Check this calendar for conflicts', 'Stop writing bookings here', true],
    ['zh-CN', '检查此日历的冲突', '将新预约写入此日历', false],
    ['zh-CN', '检查此日历的冲突', '停止向此日历写入预约', true],
  ] as const)(
    'keeps calendar names literal and %s controls in separate wrapping rows: %s, %s',
    async (language, conflictLabel, writeLabel, destination) => {
      const user = userEvent.setup()
      const name = `Settings-${'long-calendar-name'.repeat(8)}`
      const calendar = {
        ...(connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>),
        name,
      }
      fakeApi({
        ...signedIn,
        ...profile(),
        ...list(
          [{ ...connection, syncAuthorized: true, calendars: [calendar] }],
          true,
          false,
          destination ? calendar.id : null,
        ),
      })
      const sheet = document.createElement('style')
      sheet.textContent = styles
      document.head.append(sheet)
      try {
        renderApp('/app/calendars')
        await screen.findByRole('heading', { name: 'calendar@example.com' })
        if (language === 'zh-CN')
          await user.selectOptions(
            screen.getByRole('combobox', { name: 'Interface language' }),
            language,
          )
        const group = screen.getByRole('group', {
          name: `${name}${language === 'en' ? ' (primary)' : '（主日历）'}`,
        })
        const label = within(group).getByRole('checkbox').closest('label') as HTMLLabelElement
        expect(label.textContent).toBe(conflictLabel)
        const write = within(group).getByText(writeLabel)
        expect(group.contains(label)).toBe(true)
        expect(label.contains(within(group).getByRole('checkbox'))).toBe(true)
        expect(label.contains(write)).toBe(false)
        expect(group.parentElement?.textContent?.split(name)).toHaveLength(2)
        expect(getComputedStyle(group).display).toBe('grid')
        expect(getComputedStyle(group).gridTemplateColumns).toBe('minmax(0, 1fr)')
        expect(getComputedStyle(write).maxWidth).toBe('100%')
        expect(getComputedStyle(write).whiteSpace).toBe('normal')
        expect(getComputedStyle(write).overflowWrap).toBe('anywhere')
      } finally {
        sheet.remove()
      }
    },
  )

  it('translates Microsoft callback and disconnect notices with the provider kept literal', async () => {
    const user = userEvent.setup()
    const microsoft = { ...connection, provider: 'microsoft' as const }
    fakeApi({
      ...signedIn,
      ...list([microsoft], false, true),
      [`DELETE /api/v1/calendar-connections/${connection.id}`]: () =>
        new Response(null, { status: 204 }),
    })
    renderApp('/app/calendars?connection=connected&provider=microsoft')
    await screen.findByRole('heading', { name: 'calendar@example.com' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface language' }), 'zh-CN')
    expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(
      'Microsoft 日历已连接。日历列表已就绪。',
    )
    await user.click(screen.getByRole('button', { name: '断开连接：calendar@example.com' }))
    const group = screen.getByRole('group', { name: /断开 calendar@example.com？/ })
    await user.click(within(group).getByRole('button', { name: '断开账号连接' }))
    await vi.waitFor(() =>
      expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(
        'Microsoft 日历已断开连接。保存的凭据和本地日历数据已删除。',
      ),
    )
  })

  it('prompts the host to reconnect an active account with a writeback permissions failure', async () => {
    fakeApi({
      ...signedIn,
      ...list([{ ...connection, syncAuthorized: true, lastError: 'permissions_missing' }]),
    })
    renderApp('/app/calendars')
    const article = (await screen.findByRole('heading', { name: 'calendar@example.com' })).closest(
      'article',
    ) as HTMLElement
    expect(within(article).queryByRole('alert')?.textContent).toContain(
      'account again to restore it.',
    )
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toBeDefined()
  })

  it('connects Microsoft separately and exposes only its available calendar-list actions', async () => {
    const user = userEvent.setup()
    const microsoft: Schemas['CalendarConnection'] = {
      ...connection,
      id: 'b0000000-0000-7000-8000-000000000001',
      provider: 'microsoft',
      accountEmail: 'outlook@example.com',
    }
    const microsoftUrl =
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fake-microsoft-state'
    const requests = fakeApi({
      ...signedIn,
      ...list([microsoft], false, true),
      'POST /api/v1/calendar-connections/microsoft/authorize': () =>
        json(200, { authorizationUrl: microsoftUrl }),
    })
    renderApp('/app/calendars')
    const article = (await screen.findByRole('heading', { name: 'outlook@example.com' })).closest(
      'article',
    ) as HTMLElement
    expect(within(article).getByText(/lists calendars only/)).toBeDefined()
    expect(
      within(article).queryByRole('button', { name: 'Enable calendar synchronization' }),
    ).toBeNull()
    expect(within(article).queryByRole('checkbox')).toBeNull()
    expect(within(article).queryByRole('button', { name: /Write new bookings/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect Microsoft Calendar' }))
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(microsoftUrl))
    expect(requests.to('POST /api/v1/calendar-connections/microsoft/authorize')[0]?.body).toEqual(
      {},
    )
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
  })

  it.each([
    'https://attacker.example/authorize',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://login.microsoftonline.com/other/oauth2/v2.0/authorize',
  ])('refuses an unexpected Microsoft authorization URL: %s', async (authorizationUrl) => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...list([], false, true),
      'POST /api/v1/calendar-connections/microsoft/authorize': () =>
        json(200, { authorizationUrl }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Connect Microsoft Calendar' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not connect Microsoft Calendar.',
    )
    expect(goTo).not.toHaveBeenCalled()
  })

  it('names a successful Microsoft callback without rendering arbitrary provider text', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=connected&provider=microsoft')
    expect(
      await screen.findByText('Microsoft Calendar connected. Your calendar list is ready.'),
    ).toBeDefined()
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )
  })
  it.each([
    ['Connect Google Calendar', 'needs_reauth'],
    ['Enable calendar synchronization', 'active'],
  ] as const)(
    'explains permissions and revocation before %s redirects to Google',
    async (action, status) => {
      const user = userEvent.setup()
      vi.mocked(goTo).mockClear()
      const requests = fakeApi({
        ...signedIn,
        ...list([{ ...connection, status }]),
        'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
      })
      renderApp('/app/calendars')
      expect(await screen.findByText('Work calendar (primary)')).toBeDefined()
      const section = screen.getByRole('region', { name: 'Connect Google Calendar' })
      const disclosure = within(section).getByText(/Google will ask for your email/)
      expect(disclosure.textContent).toContain('calendar list')
      expect(disclosure.textContent).toContain('check busy times on selected calendars')
      expect(disclosure.textContent).toContain('create one private copy of each new booking')
      expect(disclosure.textContent).toContain('the calendar you own and select')
      expect(disclosure.textContent).toContain(
        'Automatic Google Meet adds a link only when you enable it',
      )
      expect(disclosure.textContent).toContain('not event titles or descriptions')
      expect(disclosure.textContent).toContain('optional and separate from signing in')
      expect(within(section).getByText(/Disconnect deletes/).textContent).toContain(
        'deletes stored credentials and local calendar data',
      )
      const revoke = within(section).getByRole('link', { name: 'Google Account connections' })
      expect(revoke.getAttribute('href')).toBe('https://myaccount.google.com/connections')
      expect(revoke.getAttribute('rel')).toContain('noreferrer')
      const button = screen.getByRole('button', { name: action })
      const descriptionId = button.getAttribute('aria-describedby')
      expect(descriptionId).toBeTruthy()
      expect(document.getElementById(descriptionId as string)?.contains(disclosure)).toBe(true)
      expect(disclosure.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()
      await user.click(button)
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
        access: 'sync',
      })
    },
  )

  it('localizes Google calendar permissions and revocation in Simplified Chinese', async () => {
    fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: 'zh-CN' }),
      ...list(),
    })
    renderApp('/app/calendars')
    const section = await screen.findByRole('region', { name: '连接 Google 日历' })
    const disclosure = within(section).getByText(/Google 将请求你的邮箱/)
    expect(disclosure.textContent).toContain('读取所选日历的忙闲时间来检查冲突')
    expect(disclosure.textContent).toContain('为每个新预约创建一份私有副本')
    expect(disclosure.textContent).toContain('只有启用自动 Google Meet 时才会添加会议链接')
    expect(disclosure.textContent).toContain('不保存事件标题或描述')
    expect(disclosure.textContent).toContain('与登录相互独立')
    expect(
      within(section).getByText(
        (_, node) => node?.tagName === 'P' && /“断开连接”可删除/.test(node.textContent ?? ''),
      ).textContent,
    ).toContain('删除已存储的凭证和本地日历数据')
    expect(
      within(section).getByRole('link', { name: 'Google 账号连接' }).getAttribute('href'),
    ).toBe('https://myaccount.google.com/connections')
  })

  it.each([undefined, '', 'https://operator.example/privacy'])(
    'shows the pre-consent privacy link only when configured: %s',
    async (privacyPolicyUrl) => {
      fakeApi({
        ...signedIn,
        ...list([]),
        'GET /api/v1/instance': () =>
          json(200, {
            signIn: { email: true, google: false, microsoft: false },
            privacyPolicyUrl,
          }),
      })
      renderApp('/app/calendars')
      const section = await screen.findByRole('region', { name: 'Connect Google Calendar' })
      if (privacyPolicyUrl) {
        const privacy = await within(section).findByRole('link', { name: 'Privacy policy' })
        expect(privacy.getAttribute('href')).toBe(privacyPolicyUrl)
        expect(privacy.getAttribute('target')).toBe('_blank')
        expect(privacy.getAttribute('rel')).toContain('noreferrer')
        expect(
          privacy.compareDocumentPosition(
            within(section).getByRole('button', { name: 'Connect Google Calendar' }),
          ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      } else {
        await vi.waitFor(() =>
          expect(
            within(section)
              .getByRole('button', { name: 'Connect Google Calendar' })
              .matches(':disabled'),
          ).toBe(false),
        )
        expect(within(section).queryByRole('link', { name: 'Privacy policy' })).toBeNull()
      }
    },
  )

  it('waits for configured privacy information before allowing a Google redirect', async () => {
    const user = userEvent.setup()
    const instance = later()
    vi.mocked(goTo).mockClear()
    const requests = fakeApi({
      ...signedIn,
      ...list(),
      'GET /api/v1/instance': async () => (await instance.response).clone(),
      'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
    })
    renderApp('/app/calendars')
    const section = await screen.findByRole('region', { name: 'Connect Google Calendar' })
    for (const name of ['Connect Google Calendar', 'Enable calendar synchronization']) {
      const button = screen.getByRole('button', { name })
      expect(button.matches(':disabled')).toBe(true)
      await user.click(button)
    }
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
    expect(goTo).not.toHaveBeenCalled()
    await instance.answer(
      json(200, {
        signIn: { email: true, google: false, microsoft: false },
        privacyPolicyUrl: 'https://operator.example/privacy',
      }),
    )
    expect(within(section).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe(
      'https://operator.example/privacy',
    )
    const connect = within(section).getByRole('button', { name: 'Connect Google Calendar' })
    expect(connect.matches(':disabled')).toBe(false)
    await user.click(connect)
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
  })

  it.each([
    ['en', 'Connect Google Calendar'],
    ['en', 'Enable calendar synchronization'],
    ['zh-CN', '连接 Google 日历'],
  ] as const)(
    'blocks %s %s after privacy discovery fails and recovers through retry',
    async (locale, action) => {
      const user = userEvent.setup()
      const retry = later()
      let retrying = false
      vi.mocked(goTo).mockClear()
      const requests = fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale }),
        ...list(),
        'GET /api/v1/instance': async () =>
          retrying ? (await retry.response).clone() : json(503, { error: 'service_unavailable' }),
        'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
      })
      renderApp('/app/calendars')
      const chinese = locale === 'zh-CN'
      const section = await screen.findByRole('region', {
        name: chinese ? '连接 Google 日历' : 'Connect Google Calendar',
      })
      expect((await within(section).findByRole('alert')).textContent).toBe(
        chinese
          ? '无法加载隐私信息。请重试后再连接 Google 日历。'
          : 'Could not load privacy information. Try again before connecting Google Calendar.',
      )
      const names = chinese
        ? ['连接 Google 日历', '启用日历同步']
        : ['Connect Google Calendar', 'Enable calendar synchronization']
      for (const name of names) {
        const button = screen.getByRole('button', { name })
        expect(button.matches(':disabled')).toBe(true)
        await user.click(button)
      }
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      expect(goTo).not.toHaveBeenCalled()
      const discoveryCalls = requests.to('GET /api/v1/instance').length
      retrying = true
      await user.click(
        within(section).getByRole('button', { name: chinese ? '重试' : 'Try again' }),
      )
      await vi.waitFor(() =>
        expect(requests.to('GET /api/v1/instance')).toHaveLength(discoveryCalls + 1),
      )
      for (const name of names)
        expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(true)
      expect(goTo).not.toHaveBeenCalled()
      await retry.answer(
        json(200, {
          signIn: { email: true, google: false, microsoft: false },
          privacyPolicyUrl: 'https://operator.example/privacy',
        }),
      )
      expect(
        within(section)
          .getByRole('link', { name: chinese ? '隐私政策' : 'Privacy policy' })
          .getAttribute('href'),
      ).toBe('https://operator.example/privacy')
      expect(within(section).queryByRole('alert')).toBeNull()
      for (const name of names)
        expect(screen.getByRole('button', { name }).matches(':disabled')).toBe(false)
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: action }))
      await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
      expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
        access: 'sync',
      })
    },
  )

  it('shows a disabled instance without hiding existing connections', async () => {
    fakeApi({ ...signedIn, ...list([connection], false) })
    renderApp('/app/calendars')
    expect(
      await screen.findByText(/Google Calendar is not configured on this Hourmere instance/),
    ).toBeDefined()
    expect(screen.getByText('Work calendar (primary)')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disconnect calendar@example.com' })).toBeDefined()
  })

  it('turns callback results into fixed messages and removes the result from the URL', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=denied')
    expect(await screen.findByText(/cancelled authorization/)).toBeDefined()
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )
  })

  it('does not render arbitrary callback text', async () => {
    fakeApi({ ...signedIn, ...list([]) })
    renderApp('/app/calendars?connection=private-untrusted-provider-error')
    await screen.findByText('No calendar accounts connected yet.')
    expect(screen.getByRole('main').textContent).not.toContain('private-untrusted-provider-error')
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )
    expect(document.body.textContent).not.toContain('private-untrusted-provider-error')
  })

  it('asks before disconnecting and refreshes the list after deletion', async () => {
    const user = userEvent.setup()
    let connected = true
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: connected ? [connection] : [],
          googleEnabled: true,
          microsoftEnabled: false,
        }),
      [`DELETE /api/v1/calendar-connections/${connection.id}`]: () => {
        connected = false
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Disconnect calendar@example.com' }))
    const confirm = screen.getByRole('group', { name: /Disconnect calendar@example.com\?/ })
    expect(requests.to(`DELETE /api/v1/calendar-connections/${connection.id}`)).toHaveLength(0)
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect account' }))
    expect(await screen.findByText('No calendar accounts connected yet.')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Connected accounts' }))
    expect(
      screen.getByText(/Stored credentials and local calendar data were deleted/),
    ).toBeDefined()
  })

  it('reports a denied refresh and asks for reconnection', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...list(),
      [`POST /api/v1/calendar-connections/${connection.id}/refresh`]: () =>
        json(409, {
          error: 'google_calendar_needs_reauth',
          message: 'Reconnect Google Calendar to restore access.',
        }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Refresh calendar list' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Reconnect Google Calendar')
  })

  it('selects conflict calendars, synchronizes and saves an owned booking destination', async () => {
    const user = userEvent.setup()
    let enabled = false,
      synced = false,
      destination: string | null = null
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    const requests = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: false,
          destinationCalendarId: destination,
          data: [
            {
              ...connection,
              syncAuthorized: true,
              calendars: [
                {
                  ...calendar,
                  checkConflicts: enabled,
                  lastSyncedAt: synced ? '2026-10-16T12:00:00Z' : null,
                },
              ],
            },
          ],
        }),
      [`PATCH /api/v1/calendars/${calendar.id}`]: () => {
        enabled = true
        return new Response(null, { status: 204 })
      },
      [`POST /api/v1/calendars/${calendar.id}/sync`]: () => {
        synced = true
        return new Response(null, { status: 204 })
      },
      'PUT /api/v1/calendar-destination': () => {
        destination = calendar.id
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await user.click(
      await screen.findByRole('checkbox', { name: 'Check this calendar for conflicts' }),
    )
    expect(
      await screen.findByText(
        'Waiting for the first synchronization. Booking times stay unavailable until it completes.',
      ),
    ).toBeDefined()
    expect(requests.to(`PATCH /api/v1/calendars/${calendar.id}`)[0]?.body).toEqual({
      checkConflicts: true,
    })
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(await screen.findByText(/Last synchronized:/)).toBeDefined()
    expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(
      'Busy times synchronized for this calendar.',
    )
    await user.click(screen.getByRole('button', { name: 'Write new bookings here' }))
    expect(await screen.findByRole('button', { name: 'Stop writing bookings here' })).toBeDefined()
    expect(requests.to('PUT /api/v1/calendar-destination')[0]?.body).toEqual({
      calendarId: calendar.id,
    })
  })
  it('keeps a failed conflict selection unchecked and reports the server reason', async () => {
    const user = userEvent.setup()
    const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
    fakeApi({
      ...signedIn,
      ...list([{ ...connection, syncAuthorized: true }]),
      [`PATCH /api/v1/calendars/${calendar.id}`]: () =>
        json(409, {
          error: 'google_calendar_permissions_missing',
          message: 'Reconnect before enabling busy times.',
        }),
    })
    renderApp('/app/calendars')
    await user.click(
      await screen.findByRole('checkbox', { name: 'Check this calendar for conflicts' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Reconnect before enabling busy times.',
    )
    await vi.waitFor(() =>
      expect(
        (
          screen.getByRole('checkbox', {
            name: 'Check this calendar for conflicts',
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    )
  })

  it.each(['needs_reauth', 'revoked'] as const)(
    'allows local conflict deselection after access becomes %s',
    async (status) => {
      const user = userEvent.setup()
      let selected = true
      const calendar = connection.calendars[0] as NonNullable<(typeof connection.calendars)[0]>
      fakeApi({
        ...signedIn,
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: false,
            microsoftEnabled: false,
            destinationCalendarId: null,
            data: [
              {
                ...connection,
                status,
                syncAuthorized: false,
                calendars: [{ ...calendar, checkConflicts: selected }],
              },
            ],
          }),
        [`PATCH /api/v1/calendars/${calendar.id}`]: () => {
          selected = false
          return new Response(null, { status: 204 })
        },
      })
      renderApp('/app/calendars')
      const checkbox = (await screen.findByRole('checkbox', {
        name: 'Check this calendar for conflicts',
      })) as HTMLInputElement
      expect(checkbox.matches(':disabled')).toBe(false)
      await user.click(checkbox)
      await vi.waitFor(() =>
        expect(
          screen.queryByRole('checkbox', { name: 'Check this calendar for conflicts' }),
        ).toBeNull(),
      )
      expect(selected).toBe(false)
    },
  )

  it('does not follow a late authorization response after the person leaves', async () => {
    const user = userEvent.setup()
    let finish: (response: Response) => void = () => {}
    vi.mocked(goTo).mockClear()
    fakeApi({
      ...signedIn,
      ...profile(),
      ...list(),
      'POST /api/v1/calendar-connections/google/authorize': () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    })
    renderApp('/app/calendars')
    await user.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    await act(async () => {
      finish(json(200, { authorizationUrl }))
      await Promise.resolve()
    })
    expect(goTo).not.toHaveBeenCalled()
  })
})
