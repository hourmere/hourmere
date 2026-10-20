import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  renderApp,
  signedIn,
} from '../test/fake-api.tsx'
import { booking, eventType, schedule } from '../test/fixtures.ts'
import { BreakableText } from './BreakableText.tsx'
import { EmptyState } from './EmptyState.tsx'
import { PageHeader } from './PageHeader.tsx'

it('groups each admin title, lede and page action with the shared header', () => {
  render(
    <PageHeader title="Title" lede="Explanation">
      <a href="/next">Next step</a>
    </PageHeader>,
  )
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.closest('header')?.querySelector('.lede')?.textContent).toBe('Explanation')
  expect(heading.parentElement?.querySelector('a')?.getAttribute('href')).toBe('/next')
})

it('shows the next step with a shared empty list panel', () => {
  render(
    <EmptyState title="Nothing here" action={<a href="/create">Create</a>}>
      <p>Start here</p>
    </EmptyState>,
  )
  expect(
    screen.getByText('Nothing here').closest('.empty')?.querySelector('.empty-actions a')
      ?.textContent,
  ).toBe('Create')
})

it('inserts address/path break opportunities after separators without altering copied text', () => {
  const value = 'first.last@example.test/path/to/booking'
  const { container } = render(
    <a href={`mailto:${value}`}>
      <BreakableText>{value}</BreakableText>
    </a>,
  )
  expect(container.textContent).toBe(value)
  const breaks = container.querySelectorAll('wbr')
  expect(breaks.length).toBe(6)
  for (const boundary of breaks) expect(boundary.previousSibling?.textContent).toMatch(/[@./]$/)
})

describe.each(['en', 'zh-CN'] as const)('admin consistency in %s', (language) => {
  it('renders shell geometry before the session is known, then replaces it with the page', async () => {
    chooseLanguage(language)
    const pending = later()
    const api = fakeApi({ ...signedIn, ...profile(), 'GET /api/v1/me': () => pending.response })
    renderApp('/app/settings')
    await waitFor(() => expect(api.to('GET /api/v1/me')).toHaveLength(1))
    const banner = screen.queryByRole('banner')
    expect(banner).not.toBeNull()
    expect(banner?.className).toBe('topbar')
    expect(
      within(banner as HTMLElement).queryByRole('link', {
        name: language === 'en' ? 'Go to Hourmere' : '前往 Hourmere',
      }),
    ).not.toBeNull()
    const main = screen.getByRole('main')
    expect(main.querySelector('.page-skeleton')).not.toBeNull()
    expect(within(main).getByRole('status').getAttribute('aria-label')).toBe(
      language === 'en' ? 'Loading…' : '正在加载…',
    )
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    await pending.answer(json(200, ME))
    await screen.findByRole('heading', { name: language === 'en' ? 'Settings' : '设置', level: 1 })
    expect(screen.queryByRole('main')?.closest('[aria-busy="true"]')).toBeNull()
  })

  it('de-emphasizes inactive types and displays only copyable booking paths', async () => {
    chooseLanguage(language)
    const user = userEvent.setup()
    const slug = `intro-${'long-slug-'.repeat(12)}call`
    const handle = 'alexandria-review-very-long-booking-page-handle'
    fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, handle }),
      'GET /api/v1/event-types': () => json(200, { data: [eventType({ isActive: false, slug })] }),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    })
    renderApp('/app/event-types')
    const row = (await screen.findByRole('rowheader', { name: 'Intro call' })).closest(
      'tr',
    ) as HTMLElement
    expect(row.classList.contains('event-type-inactive')).toBe(true)
    const link = row.querySelector('.booking-link a') as HTMLAnchorElement
    expect(link.textContent).toContain(`/${handle}/${slug}`)
    expect(link.textContent).not.toContain(window.location.host)
    expect(link.title).toBe(`${window.location.origin}/${handle}/${slug}`)
    expect(link.querySelector('.booking-link-handle')?.textContent).toBe(`/${handle}`)
    expect(link.querySelector('.booking-link-slug')?.textContent).toBe(`/${slug}`)
    expect(link.classList.contains('booking-link-path')).toBe(true)
    // Chromium may honor <wbr> even under nowrap, defeating single-line ellipsis.
    expect(link.querySelector('wbr')).toBeNull()
    await user.click(
      within(row).getByRole('button', {
        name: language === 'en' ? 'Copy link for Intro call' : '复制链接：Intro call',
      }),
    )
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/${handle}/${slug}`)
  })

  it('places meeting summary before actions, then attendee and answer details', async () => {
    chooseLanguage(language)
    const item = booking({ start: '2099-11-02T14:00:00Z', end: '2099-11-02T14:30:00Z' })
    fakeApi({
      ...signedIn,
      ...profile(),
      [`GET /api/v1/bookings/${item.id}`]: () => json(200, item),
      [`GET /api/v1/event-types/${item.eventTypeId}`]: () => json(200, eventType()),
    })
    renderApp(`/app/bookings/${item.id}`)
    const reschedule = await screen.findByRole('button', {
      name: language === 'en' ? 'Reschedule' : '改期',
    })
    const cancel = screen.getByRole('button', {
      name: language === 'en' ? 'Cancel booking…' : '取消预约…',
    })
    const people = screen.getByRole('region', { name: language === 'en' ? 'People' : '人员' })
    const answers = screen.getByRole('region', { name: language === 'en' ? 'Answers' : '回答' })
    const when = screen.getByRole('region', { name: language === 'en' ? 'When' : '时间' })
    for (const action of [reschedule, cancel]) {
      expect(when.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(action.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(
        action.compareDocumentPosition(answers) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })

  it.each(['upcoming', 'past'] as const)(
    'uses the shared empty state for %s bookings',
    async (tab) => {
      chooseLanguage(language)
      fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
      })
      renderApp(`/app/bookings?tab=${tab}`)
      const title = await screen.findByText(
        tab === 'upcoming'
          ? language === 'en'
            ? 'No upcoming bookings.'
            : '没有即将到来的预约。'
          : language === 'en'
            ? 'No past bookings yet.'
            : '尚无过去的预约。',
      )
      expect(title.classList.contains('empty-title')).toBe(true)
      if (tab === 'upcoming') {
        const action = title.closest('.empty')?.querySelector('.empty-actions a')
        expect(action?.getAttribute('href')).toBe('/app/event-types')
        // The link sits inside one sentence; Chinese keeps its full-width comma unspaced.
        expect(action?.parentElement?.textContent).toBe(
          language === 'en'
            ? 'Share the links of your event types so people can book you.'
            : '分享你的活动类型，以便他人预约你。',
        )
        expect(action?.textContent).toBe(language === 'en' ? 'event types' : '活动类型')
      }
    },
  )

  it('uses the shared empty state to start a schedule', async () => {
    chooseLanguage(language)
    fakeApi({
      ...signedIn,
      'GET /api/v1/schedules': () => json(200, { data: [] }),
    })
    renderApp('/app/availability')
    const title = await screen.findByText(language === 'en' ? 'No schedules yet.' : '尚无日程。')
    expect(title.classList.contains('empty-title')).toBe(true)
    expect(title.closest('.empty')?.querySelector('.empty-actions a')?.getAttribute('href')).toBe(
      '/app/availability/new',
    )
  })
})
