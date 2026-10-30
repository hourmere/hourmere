import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
beforeEach(() => vi.mocked(goTo).mockClear())

const calendar: Schemas['CalendarConnection']['calendars'][number] = {
  id: 'c0000000-0000-7000-8000-000000000001',
  name: 'Work calendar',
  timeZone: null,
  isPrimary: false,
  checkConflicts: true,
  accessRole: 'owner',
  lastSyncedAt: '2026-10-16T12:00:00Z',
  syncError: 'provider_unavailable',
}
const connection: Schemas['CalendarConnection'] = {
  id: 'a0000000-0000-7000-8000-000000000001',
  provider: 'google',
  accountEmail: 'original@example.test',
  status: 'active',
  syncAuthorized: true,
  lastError: null,
  createdAt: '2026-10-16T10:00:00Z',
  updatedAt: '2026-10-16T10:00:00Z',
  calendars: [calendar],
}
const messages = [
  {
    locale: 'en',
    retry: 'Retry synchronization',
    retrying: 'Synchronizing busy times…',
    failure:
      'Synchronization failed. Booking times stay unavailable until synchronization recovers.',
    providerFailure: 'Google Calendar could not be reached. Try again shortly.',
    success: 'Latest synchronization of selected conflict calendars succeeded.',
    notReady: 'Synchronization is not ready for selected calendars yet.',
    notReadyDetail:
      'Synchronization is not ready yet. Booking times stay unavailable until it completes.',
    notice: 'Busy times synchronized for this calendar.',
    refresh: 'Refresh calendar list',
    destination: 'Stop writing bookings here',
    reconnect: 'Reconnect Google Calendar',
    write: 'Write new bookings here',
    tryAgain: 'Try again',
    loadFailure: 'Something went wrong on our side. Try again in a moment.',
    empty: 'No calendar accounts connected yet.',
  },
  {
    locale: 'zh-CN',
    retry: '重试同步',
    retrying: '正在同步忙碌时段…',
    failure: '同步失败。在同步恢复之前，相关时间将保持不可预约。',
    providerFailure: '无法连接 Google 日历。请稍后重试。',
    success: '所选冲突检查日历的最近一次同步已成功。',
    notReady: '所选日历的同步数据尚未就绪。',
    notReadyDetail: '同步数据尚未就绪。同步完成前，相关时间将保持不可预约。',
    notice: '此日历的忙碌时段已同步。',
    refresh: '刷新日历列表',
    destination: '停止向此日历写入预约',
    reconnect: '重新连接 Google 日历',
    write: '将新预约写入此日历',
    tryAgain: '重试',
    loadFailure: '服务端发生错误。请稍后重试。',
    empty: '尚未连接日历账号。',
  },
] as const

describe.each(messages)('calendar acceptance in $locale', (copy) => {
  it('announces a retry in progress, preserves a repeated failure and reloads a later success', async () => {
    const user = userEvent.setup()
    const first = later()
    const second = later()
    let attempts = 0
    let recovered = false
    const requests = fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: true,
          destinationCalendarId: calendar.id,
          data: [
            {
              ...connection,
              calendars: [{ ...calendar, syncError: recovered ? null : calendar.syncError }],
            },
          ],
        }),
      [`POST /api/v1/calendars/${calendar.id}/sync`]: async () => {
        attempts += 1
        const response = await (attempts === 1 ? first.response : second.response)
        recovered = response.ok
        return response
      },
    })
    renderApp('/app/calendars')
    await screen.findByText(copy.failure)
    const originalReads = requests.to('GET /api/v1/calendar-connections').length
    const retry = screen.getByRole('button', { name: copy.retry })
    const controls = retry.closest('fieldset') as HTMLElement
    const live = retry.closest('li')?.querySelector('[aria-live="polite"]') as HTMLElement
    expect(live).not.toBeNull()
    expect(live.textContent).toBe('')
    expect(live.getAttribute('aria-atomic')).toBe('true')
    expect(controls.getAttribute('aria-busy')).not.toBe('true')
    expect(screen.getByRole('button', { name: copy.destination }).matches(':disabled')).toBe(false)
    expect(screen.getByRole('button', { name: copy.refresh }).matches(':disabled')).toBe(false)
    expect(screen.queryByRole('link', { name: copy.reconnect })).toBeNull()

    await user.click(retry)
    const progress = within(retry.closest('li') as HTMLElement).getByRole('status')
    expect(progress).toBe(live)
    expect(progress.textContent).toBe(copy.retrying)
    expect(progress.closest('[aria-busy="true"]')).toBeNull()
    expect(controls.getAttribute('aria-busy')).toBe('true')
    expect(retry.matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: copy.refresh }).matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: copy.destination }).matches(':disabled')).toBe(true)
    await user.click(retry)
    expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(1)
    await first.answer(json(503, { error: 'google_calendar_provider_unavailable' }))

    expect((await screen.findByRole('alert')).textContent).toBe(copy.providerFailure)
    await vi.waitFor(() =>
      expect(requests.to('GET /api/v1/calendar-connections').length).toBeGreaterThan(originalReads),
    )
    expect(await screen.findByText(copy.failure)).toBeDefined()
    const retryAgain = screen.getByRole('button', { name: copy.retry })
    expect(retryAgain.matches(':disabled')).toBe(false)
    expect(retryAgain.closest('fieldset')?.getAttribute('aria-busy')).not.toBe('true')
    expect(screen.queryByText(copy.retrying)).toBeNull()
    expect(live.textContent).toBe('')
    expect(document.querySelector('.calendar-controls[aria-busy="true"]')).toBeNull()
    expect(screen.queryByText(copy.notice)).toBeNull()
    expect(screen.getByRole('button', { name: copy.destination }).matches(':disabled')).toBe(false)

    const readsAfterFailure = requests.to('GET /api/v1/calendar-connections').length
    await user.click(retryAgain)
    expect(within(retryAgain.closest('li') as HTMLElement).getByRole('status').textContent).toBe(
      copy.retrying,
    )
    await second.answer(new Response(null, { status: 204 }))
    expect(await screen.findByText(copy.success)).toBeDefined()
    expect(within(screen.getByRole('main')).getByRole('status').textContent).toBe(copy.notice)
    expect(requests.to('GET /api/v1/calendar-connections').length).toBeGreaterThan(
      readsAfterFailure,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(copy.failure)).toBeNull()
    expect(screen.queryByText(copy.retrying)).toBeNull()
    expect(live.textContent).toBe('')
    expect(document.querySelector('.calendar-controls[aria-busy="true"]')).toBeNull()
    expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(2)
    expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
    expect(requests.to(`PATCH /api/v1/calendars/${calendar.id}`)).toHaveLength(0)
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
    expect(goTo).not.toHaveBeenCalled()
  })

  it('keeps failed calendar reads distinct from an empty account through repeated retries', async () => {
    const user = userEvent.setup()
    const retry = later()
    let reads = 0
    const requests = fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': async () => {
        reads += 1
        if (reads === 2) return retry.response
        if (reads < 3) return json(503, { error: 'internal_error' })
        return json(200, {
          googleEnabled: false,
          microsoftEnabled: false,
          destinationCalendarId: null,
          data: [],
        })
      },
    })
    renderApp('/app/calendars')
    expect((await screen.findByRole('alert')).textContent).toBe(copy.loadFailure)
    expect(screen.queryByText(copy.empty)).toBeNull()
    await user.click(screen.getByRole('button', { name: copy.tryAgain }))
    await vi.waitFor(() => expect(reads).toBe(2))
    expect(screen.queryByText(copy.empty)).toBeNull()
    expect(screen.queryByRole('button', { name: copy.write })).toBeNull()
    await retry.answer(json(503, { error: 'internal_error' }))
    expect((await screen.findByRole('alert')).textContent).toBe(copy.loadFailure)
    expect(screen.queryByText(copy.empty)).toBeNull()
    await user.click(screen.getByRole('button', { name: copy.tryAgain }))
    expect(await screen.findByText(copy.empty)).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(requests.to('GET /api/v1/calendar-connections')).toHaveLength(3)
    expect(requests.calls.filter((request) => request.method !== 'GET')).toHaveLength(0)
  })

  it('does not announce synchronization while a conflict selection is being saved', async () => {
    const user = userEvent.setup()
    const selection = later()
    const requests = fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: false,
          destinationCalendarId: null,
          data: [connection],
        }),
      [`PATCH /api/v1/calendars/${calendar.id}`]: () => selection.response,
    })
    renderApp('/app/calendars')
    const retry = await screen.findByRole('button', { name: copy.retry })
    const controls = retry.closest('fieldset') as HTMLElement
    await user.click(within(controls).getByRole('checkbox'))
    expect(retry.matches(':disabled')).toBe(true)
    expect(controls.getAttribute('aria-busy')).not.toBe('true')
    expect(within(controls).queryByRole('status')).toBeNull()
    expect(screen.queryByText(copy.retrying)).toBeNull()
    expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
    await selection.answer(new Response(null, { status: 204 }))
    expect(requests.to(`PATCH /api/v1/calendars/${calendar.id}`)[0]?.body).toEqual({
      checkConflicts: false,
    })
  })

  it('describes missing successful sync data after a reset without inventing an attempt in progress', async () => {
    const user = userEvent.setup()
    let reset = false
    const requests = fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: false,
          destinationCalendarId: null,
          data: [
            {
              ...connection,
              calendars: [
                {
                  ...calendar,
                  lastSyncedAt: reset ? null : calendar.lastSyncedAt,
                  syncError: null,
                },
              ],
            },
          ],
        }),
      [`POST /api/v1/calendar-connections/${connection.id}/refresh`]: () => {
        reset = true
        return new Response(null, { status: 204 })
      },
    })
    renderApp('/app/calendars')
    await screen.findByText(copy.success)
    await user.click(screen.getByRole('button', { name: copy.refresh }))
    expect(await screen.findByText(copy.notReady)).toBeDefined()
    const detail = screen.getByText(copy.notReadyDetail)
    const item = detail.closest('li') as HTMLElement
    expect(within(item).queryByRole('status')).toBeNull()
    expect(item.querySelector('[aria-live="polite"]')?.textContent).toBe('')
    expect(item.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.queryByText(copy.retrying)).toBeNull()
    expect(screen.queryByText(copy.success)).toBeNull()
    expect(requests.to(`POST /api/v1/calendars/${calendar.id}/sync`)).toHaveLength(0)
  })

  it('scopes calendars and recovery to the chosen account and starts a fresh authorization', async () => {
    const user = userEvent.setup()
    const second = {
      ...connection,
      id: 'a0000000-0000-7000-8000-000000000002',
      accountEmail: 'second@example.test',
      status: 'revoked' as const,
      calendars: [
        {
          ...calendar,
          id: 'c0000000-0000-7000-8000-000000000002',
          name: 'Second account calendar',
        },
      ],
    }
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-new'
    const oldUrl = 'https://untrusted.example/old-authorization'
    const requests = fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          googleEnabled: true,
          microsoftEnabled: true,
          destinationCalendarId: null,
          data: [{ ...connection, status: 'needs_reauth' }, second],
        }),
      'POST /api/v1/calendar-connections/google/authorize': () => json(200, { authorizationUrl }),
    })
    renderApp(
      `/app/calendars?connection=invalid_state&authorizationUrl=${encodeURIComponent(oldUrl)}&returnTo=${encodeURIComponent(oldUrl)}`,
    )
    const firstCard = (
      await screen.findByRole('heading', { name: connection.accountEmail as string })
    ).closest('article') as HTMLElement
    const secondCard = screen
      .getByRole('heading', { name: second.accountEmail })
      .closest('article') as HTMLElement
    expect(within(firstCard).getByRole('heading', { name: calendar.name })).toBeDefined()
    expect(within(firstCard).queryByRole('heading', { name: second.calendars[0]?.name })).toBeNull()
    expect(
      within(secondCard).getByRole('heading', { name: second.calendars[0]?.name }),
    ).toBeDefined()
    expect(within(secondCard).queryByRole('heading', { name: calendar.name })).toBeNull()
    for (const card of [firstCard, secondCard]) {
      for (const link of within(card).getAllByRole('link')) {
        const href = link.getAttribute('href') as string
        expect(href).toBe('#calendar-connection-options')
        expect(new URL(href, window.location.href).origin).toBe(window.location.origin)
        expect(document.getElementById(href.slice(1))).not.toBeNull()
      }
    }
    await user.click(within(firstCard).getByRole('link', { name: copy.reconnect }))
    const options = document.getElementById('calendar-connection-options') as HTMLElement
    expect(options.textContent).toContain(connection.accountEmail)
    expect(options.textContent).not.toContain(second.accountEmail)
    await user.click(within(secondCard).getByRole('link', { name: copy.reconnect }))
    expect(options.textContent).toContain(second.accountEmail)
    expect(options.textContent).not.toContain(connection.accountEmail)
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')).toHaveLength(0)
    expect(requests.calls.filter((request) => request.method !== 'GET')).toHaveLength(0)
    expect(goTo).not.toHaveBeenCalled()
    expect(screen.getByRole('main').textContent).not.toContain(oldUrl)
    await vi.waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/calendars'),
    )

    const authorize = within(options).getByRole('button', { name: copy.reconnect })
    const disclosure = document.getElementById(
      authorize.getAttribute('aria-describedby') ?? '',
    ) as HTMLElement
    expect(disclosure).not.toBeNull()
    expect(options.contains(disclosure)).toBe(true)
    expect(disclosure.compareDocumentPosition(authorize) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    await user.click(authorize)
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith(authorizationUrl))
    expect(requests.to('POST /api/v1/calendar-connections/google/authorize')[0]?.body).toEqual({
      access: 'sync',
    })
    expect(vi.mocked(goTo).mock.calls).toHaveLength(1)
  })

  it.each(['reader', 'writer', 'freeBusyReader'])(
    'withholds booking writes from a %s calendar even beside an eligible owned calendar',
    async (accessRole) => {
      const user = userEvent.setup()
      const owned = { ...calendar, syncError: null }
      const shared = {
        ...calendar,
        id: 'c0000000-0000-7000-8000-000000000002',
        name: 'Shared calendar',
        checkConflicts: false,
        accessRole,
      }
      const requests = fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale: copy.locale }),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            googleEnabled: true,
            microsoftEnabled: true,
            destinationCalendarId: null,
            data: [{ ...connection, calendars: [owned, shared] }],
          }),
        'PUT /api/v1/calendar-destination': () => new Response(null, { status: 204 }),
      })
      renderApp('/app/calendars')
      const sharedItem = (await screen.findByRole('heading', { name: shared.name })).closest(
        'li',
      ) as HTMLElement
      expect(within(sharedItem).queryByRole('button', { name: copy.write })).toBeNull()
      const ownedItem = screen
        .getByRole('heading', { name: owned.name })
        .closest('li') as HTMLElement
      const write = within(ownedItem).getByRole('button', { name: copy.write })
      expect(write.matches(':disabled')).toBe(false)
      expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(0)
      await user.click(write)
      await vi.waitFor(() =>
        expect(requests.to('PUT /api/v1/calendar-destination')).toHaveLength(1),
      )
      expect(requests.to('PUT /api/v1/calendar-destination')[0]?.body).toEqual({
        calendarId: owned.id,
      })
    },
  )
})
