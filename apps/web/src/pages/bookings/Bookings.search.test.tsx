import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Booking } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { BOOKING } from '../../limits.ts'
import { fakeApi, json, profile, type Routes, renderApp, signedIn } from '../../test/fake-api.tsx'
import { booking } from '../../test/fixtures.ts'
import { PAGE_SIZE, SEARCH_DELAY_MS } from './Bookings.tsx'

const location = () => screen.getByTestId('location').textContent ?? ''
const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-03-01T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())

const ada = booking({
  id: 'b0000000-0000-7000-8000-000000000001',
  title: 'Call with Ada',
  attendees: [
    {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      timeZone: 'UTC',
      locale: null,
      isBooker: true,
    },
  ],
})
const cancelled = booking({
  id: 'b0000000-0000-7000-8000-000000000002',
  title: 'Cancelled call',
  status: 'cancelled',
  cancelledAt: '2030-02-20T09:00:00.000Z',
})

/** The list endpoint answering with `answer` for each request's query. */
function server(
  answer: (q: Record<string, string>) => { data: Booking[]; nextCursor: string | null },
  routes: Routes = {},
) {
  return fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/bookings': ({ path }) => json(200, answer(query(path))),
    ...routes,
  })
}

describe('the cancelled bookings view', () => {
  it('lists cancelled bookings newest first and pages with the same filters', async () => {
    const user = userEvent.setup()
    const api = server((q) =>
      q.status !== 'cancelled'
        ? { data: [ada], nextCursor: null }
        : q.cursor
          ? {
              data: [booking({ ...cancelled, id: 'later', title: 'Older cancel' })],
              nextCursor: null,
            }
          : { data: [cancelled], nextCursor: 'cursor-1' },
    )
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Call with Ada' })
    const tab = screen.getByRole('link', { name: 'Cancelled' })
    expect(tab.getAttribute('href')).toBe('/app/bookings?tab=cancelled')
    await user.click(tab)
    const row = (await screen.findByRole('rowheader', { name: 'Cancelled call' })).closest('tr')
    expect(within(row as HTMLElement).getByText('Cancelled')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Cancelled' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('heading', { name: 'Cancelled bookings' })).toBeDefined()
    expect(screen.getByText(/Newest first\./)).toBeDefined()
    expect(location()).toBe('/app/bookings?tab=cancelled')
    await user.click(screen.getByRole('button', { name: 'Show more bookings' }))
    await screen.findByRole('rowheader', { name: 'Older cancel' })

    const calls = api.to('GET /api/v1/bookings').map((call) => query(call.path))
    expect(calls.slice(1)).toEqual([
      { status: 'cancelled', order: 'desc', limit: String(PAGE_SIZE) },
      { status: 'cancelled', order: 'desc', limit: String(PAGE_SIZE), cursor: 'cursor-1' },
    ])
  })

  it('says when there are no cancelled bookings', async () => {
    server(() => ({ data: [], nextCursor: null }))
    renderApp('/app/bookings?tab=cancelled')
    expect(await screen.findByText('No cancelled bookings.')).toBeDefined()
    // Sharing event types is the Upcoming tab's advice only.
    expect(screen.queryByRole('link', { name: 'event types' })).toBeNull()
  })

  it('exports cancelled bookings only, with the view’s order', async () => {
    server(() => ({ data: [cancelled], nextCursor: null }))
    renderApp('/app/bookings?tab=cancelled')
    await screen.findByRole('rowheader', { name: 'Cancelled call' })
    // The native details element is opened before its controls are used.
    fireEvent.click(screen.getByText('Export bookings as CSV'))
    screen.getByText('Export bookings as CSV').closest('details')?.setAttribute('open', '')
    fireEvent.change(screen.getByLabelText('Bookings starting at or after (UTC)'), {
      target: { value: '2030-01-01T00:00' },
    })
    fireEvent.change(screen.getByLabelText('Bookings starting before (UTC)'), {
      target: { value: '2030-04-01T00:00' },
    })
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('header\r\n', { headers: { 'content-type': 'text/csv' } }))
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn(() => 'blob:test')
        static override revokeObjectURL = vi.fn()
      },
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const button = screen.getByRole('button', { name: 'Download CSV' })
    fireEvent.click(button)
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled())
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/v1/bookings/export.csv')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      status: 'cancelled',
      order: 'desc',
      from: '2030-01-01T00:00:00.000Z',
      to: '2030-04-01T00:00:00.000Z',
    })
    expect(['endAfter', 'endTo', 'q'].some((name) => url.searchParams.has(name))).toBe(false)
  })
})

describe('the bookings search', () => {
  it('searches after a pause in typing, once, and announces the results', async () => {
    const user = userEvent.setup()
    const api = server((q) => ({
      data: q.q ? (q.q === 'Ada' ? [ada] : []) : [ada, cancelled],
      nextCursor: null,
    }))
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Cancelled call' })
    // A search landmark (<search>; jsdom's role table predates the element).
    const landmark = document.querySelector('search')
    const box = within(landmark as HTMLElement).getByRole('searchbox', {
      name: 'Search bookings',
    })
    expect(box.getAttribute('maxlength')).toBe(String(BOOKING.searchMaxLength))
    expect(box.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Invitee name or email, or event type.',
    )
    await user.type(box, 'Ada')
    // Typing alone sends nothing until the pause.
    expect(api.to('GET /api/v1/bookings')).toHaveLength(1)
    await waitFor(() => expect(location()).toBe('/app/bookings?q=Ada'))
    await waitFor(() =>
      expect(screen.queryByRole('rowheader', { name: 'Cancelled call' })).toBeNull(),
    )
    expect(await screen.findByText('Matching bookings: 1.')).toBeDefined()
    expect(screen.getByText('Matching bookings: 1.').getAttribute('role')).toBe('status')
    const calls = api.to('GET /api/v1/bookings').map((call) => query(call.path))
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ q: 'Ada', endAfter: expect.any(String), order: 'asc' })
    // Focus stays in the box while results change.
    expect(document.activeElement).toBe(box)

    // Tabs keep the search, and the search applies to the tab.
    expect(screen.getByRole('link', { name: 'Cancelled' }).getAttribute('href')).toBe(
      '/app/bookings?tab=cancelled&q=Ada',
    )
    await user.click(screen.getByRole('link', { name: 'Past' }))
    await waitFor(() => expect(location()).toBe('/app/bookings?tab=past&q=Ada'))
    await waitFor(() => expect(api.to('GET /api/v1/bookings')).toHaveLength(3))
    expect(query(api.to('GET /api/v1/bookings')[2]?.path ?? '')).toMatchObject({
      q: 'Ada',
      endTo: expect.any(String),
      order: 'desc',
    })
    expect(within(landmark as HTMLElement).getByRole<HTMLInputElement>('searchbox').value).toBe(
      'Ada',
    )
  })

  it('searches at once on Enter, trims the text, and clears with Escape', async () => {
    const user = userEvent.setup()
    const api = server((q) => ({ data: q.q ? [ada] : [ada, cancelled], nextCursor: null }))
    renderApp('/app/bookings')
    await screen.findByRole('rowheader', { name: 'Cancelled call' })
    const box = screen.getByRole('searchbox', { name: 'Search bookings' })
    await user.type(box, '  ada lovelace {Enter}')
    await waitFor(() => expect(location()).toBe('/app/bookings?q=ada+lovelace'))
    await screen.findByText('Matching bookings: 1.')
    // Enter ran the search; the pending pause adds no second request for the same text.
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    const searches = api
      .to('GET /api/v1/bookings')
      .map((call) => query(call.path).q)
      .filter(Boolean)
    expect(searches).toEqual(['ada lovelace'])
    // The trailing space typed before Enter stays in the box while the search matches.
    expect((box as HTMLInputElement).value).toBe('  ada lovelace ')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(location()).toBe('/app/bookings'))
    expect((box as HTMLInputElement).value).toBe('')
    await screen.findByRole('rowheader', { name: 'Cancelled call' })
    expect(query(api.to('GET /api/v1/bookings').at(-1)?.path ?? '').q).toBeUndefined()
  })

  it('explains an empty search and clears it from the empty state', async () => {
    const user = userEvent.setup()
    server((q) => ({ data: q.q ? [] : [ada], nextCursor: null }))
    renderApp('/app/bookings?tab=cancelled&q=nobody')
    expect(
      await screen.findByText('No bookings match your search.', { selector: 'p.empty-title' }),
    ).toBeDefined()
    expect(screen.getByText('Try another name, email address or event type.')).toBeDefined()
    expect(screen.queryByText('No cancelled bookings.')).toBeNull()
    // Announced after the list renders, in the page's lasting live region.
    expect(
      await screen.findByText('No bookings match your search.', { selector: '[role="status"]' }),
    ).toBeDefined()
    // The export has no search, so it waits until the search is cleared.
    expect(screen.queryByText('Export bookings as CSV')).toBeNull()
    expect(screen.getByText('Clear the search to export bookings as CSV.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(location()).toBe('/app/bookings?tab=cancelled'))
    await screen.findByRole('rowheader', { name: 'Call with Ada' })
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(screen.getByText('Export bookings as CSV')).toBeDefined()
  })

  it('says when more matching bookings are available and sends at most the bound', async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, n) =>
      booking({ id: `b0000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}` }),
    )
    const api = server(() => ({ data: page, nextCursor: 'more' }))
    renderApp(`/app/bookings?q=${'x'.repeat(BOOKING.searchMaxLength + 20)}`)
    expect(
      await screen.findByText(`Matching bookings shown: ${PAGE_SIZE}. More are available.`),
    ).toBeDefined()
    expect(query(api.to('GET /api/v1/bookings')[0]?.path ?? '').q).toBe(
      'x'.repeat(BOOKING.searchMaxLength),
    )
  })

  it('offers the cancelled view and search in Chinese', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    server((q) => ({ data: q.q ? [] : [], nextCursor: null }))
    renderApp('/app/bookings')
    await user.click(await screen.findByRole('link', { name: '已取消' }))
    expect(await screen.findByText('没有已取消的预约。')).toBeDefined()
    const box = screen.getByRole('searchbox', { name: '搜索预约' })
    expect(screen.getByText('受邀人姓名或邮箱，或活动类型。')).toBeDefined()
    await user.type(box, '王{Enter}')
    expect(
      await screen.findByText('没有符合搜索条件的预约。', { selector: 'p.empty-title' }),
    ).toBeDefined()
    expect(screen.getByText('请尝试其他姓名、邮箱地址或活动类型。')).toBeDefined()
    expect(screen.getByRole('button', { name: '清除搜索' })).toBeDefined()
    expect(screen.getByText('清除搜索后即可将预约导出为 CSV。')).toBeDefined()
  })
})
