import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import styles from '../styles.css?raw'
import { fakeApi, json, later, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { initialActivityFilters } from './Analytics.tsx'
import { shapeBookingActions } from './BookingActionCharts.tsx'

const result = {
  startDate: '2026-03-29',
  endDate: '2026-03-30',
  timeZone: 'Europe/Berlin',
  totals: { created: 4, rescheduled: 2, cancelled: 1, noShows: 3 },
  data: [
    { date: '2026-03-29', created: 4, rescheduled: 2, cancelled: 0, noShows: 1 },
    { date: '2026-03-30', created: 0, rescheduled: 0, cancelled: 1, noShows: 2 },
  ],
}
const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams)

describe('booking action chart data', () => {
  it('keeps every date in order, shares the highest action count and excludes no-shows', () => {
    const days = result.data.map((day) => ({ ...day, noShows: 99 }))
    const { maxCount, series } = shapeBookingActions(days)
    expect(maxCount).toBe(4)
    expect(series.map(({ action }) => action)).toEqual(['created', 'rescheduled', 'cancelled'])
    expect(series.map(({ points }) => points.map(({ date }) => date))).toEqual([
      ['2026-03-29', '2026-03-30'],
      ['2026-03-29', '2026-03-30'],
      ['2026-03-29', '2026-03-30'],
    ])
    expect(series.map(({ points }) => points.map(({ count }) => count))).toEqual([
      [4, 0],
      [2, 0],
      [0, 1],
    ])
  })

  it('returns an empty scale for no rows and for an API zero-filled range', () => {
    expect(shapeBookingActions([]).maxCount).toBe(0)
    expect(
      shapeBookingActions([{ date: '2026-03-29', created: 0, rescheduled: 0, cancelled: 0 }])
        .maxCount,
    ).toBe(0)
  })
})

describe('booking activity page', () => {
  it('defaults to 30 date labels in the chosen local zone, without browser Temporal', () => {
    expect(initialActivityFilters('America/Los_Angeles', new Date('2026-03-01T01:00:00Z'))).toEqual(
      { startDate: '2026-01-30', endDate: '2026-02-28', timeZone: 'America/Los_Angeles' },
    )
    expect(initialActivityFilters('unknown', new Date('2026-03-01T01:00:00Z')).timeZone).toBe('UTC')
  })
  it('shows charts on one scale with exact values in the accessible daily table', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () => json(200, result),
    })
    renderApp('/app/analytics')
    const table = await screen.findByRole('table', { name: 'Daily booking activity' })
    const charts = screen.getByRole('region', { name: 'Booking actions over time' })
    expect(
      within(charts).getByText(
        'The charts share a count scale. See the daily table below for exact counts.',
      ),
    ).toBeDefined()
    const figures = within(charts).getAllByRole('figure')
    expect(figures.map((figure) => figure.querySelector('figcaption')?.textContent)).toEqual([
      'Bookings created',
      'Reschedules',
      'Cancellations',
    ])
    expect(figures.map((figure) => figure.querySelector('svg')?.getAttribute('viewBox'))).toEqual([
      '0 0 2 4',
      '0 0 2 4',
      '0 0 2 4',
    ])
    expect(figures.map((figure) => figure.querySelector('rect')?.getAttribute('height'))).toEqual([
      '4',
      '2',
      '1',
    ])
    expect(
      figures.every((figure) => figure.querySelector('svg')?.closest('[aria-hidden="true"]')),
    ).toBe(true)
    const heading = screen.getByRole('heading', { name: 'Booking activity', level: 1 })
    expect(heading.closest('.page-intro')?.querySelector('.lede')).not.toBeNull()
    const form = screen.getByRole('button', { name: 'Update report' }).closest('form')
    expect(form?.classList.contains('stack')).toBe(true)
    const start = screen.getByLabelText('Start date').closest('.field')
    const end = screen.getByLabelText('End date').closest('.field')
    expect(start?.parentElement).toBe(end?.parentElement)
    expect(start?.parentElement?.classList.contains('analytics-date-range')).toBe(true)
    const metrics = [...document.querySelectorAll('.metric-cards > div')]
    expect(
      metrics.map((card) => [
        card.querySelector('dt')?.textContent,
        card.querySelector('dd')?.textContent,
      ]),
    ).toEqual([
      ['Bookings created', '4'],
      ['Reschedules', '2'],
      ['Cancellations', '1'],
      ['No-shows', '3'],
    ])
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Date', 'Bookings created', 'Reschedules', 'Cancellations', 'No-shows'])
    expect(
      [...table.querySelectorAll('td[data-label="No-shows"]')].map((cell) => cell.textContent),
    ).toEqual(['1', '2'])
    expect(screen.getByText(/No-shows count each attendee currently marked/)).toBeDefined()
    expect(table.querySelector('caption')?.classList.contains('analytics-caption')).toBe(true)
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Mar 29, 2026', 'Mar 30, 2026'])
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) =>
          within(row)
            .getAllByRole('cell')
            .map((cell) => cell.textContent),
        ),
    ).toEqual([
      ['4', '2', '0', '1'],
      ['0', '0', '1', '2'],
    ])
    expect(
      screen.getByText(/Cancellations exclude the old booking withdrawn during a move/),
    ).toBeDefined()
    expect(
      screen.getByRole('link', { name: 'Booking activity' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(query(api.to('GET /api/v1/analytics/bookings')[0]?.path ?? '').timeZone).toBe(
      'Europe/Berlin',
    )
  })
  it.each([
    ['en', 'Start date', 'End date', 'Both dates are included, up to 90 local days.'],
    ['zh-CN', '开始日期', '结束日期', '包含起止日期，最多 90 个当地日历日。'],
  ] as const)(
    'describes both dates with one hint below their pair in %s',
    async (locale, startLabel, endLabel, hintText) => {
      chooseLanguage(locale)
      fakeApi({
        ...signedIn,
        ...profile(),
        'GET /api/v1/analytics/bookings': () => json(200, result),
      })
      renderApp('/app/analytics')
      const start = await screen.findByLabelText(startLabel)
      const end = screen.getByLabelText(endLabel)
      const hint = screen.getByText(hintText)
      expect(hint.id).not.toBe('')
      expect(start.getAttribute('aria-describedby')).toBe(hint.id)
      expect(end.getAttribute('aria-describedby')).toBe(hint.id)
      const pair = start.closest('.analytics-date-range')
      expect(pair?.contains(end)).toBe(true)
      expect(pair?.contains(hint)).toBe(false)
      expect(pair?.nextElementSibling).toBe(hint)
      expect(start.closest('.field')?.querySelector('.hint')).toBeNull()
      expect(end.closest('.field')?.querySelector('.hint')).toBeNull()
    },
  )
  it('keeps each Chinese report date together when the heading wraps on narrow screens', async () => {
    chooseLanguage('zh-CN')
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        json(200, { ...result, startDate: '2026-09-21', endDate: '2026-10-20' }),
    })
    renderApp('/app/analytics')
    const heading = await screen.findByRole('heading', { name: '2026年9月21日 至 2026年10月20日' })
    expect(
      [...heading.querySelectorAll('time.nowrap')].map((date) => date.getAttribute('datetime')),
    ).toEqual(['2026-09-21', '2026-10-20'])
    expect(styles).toMatch(/\.nowrap\s*\{\s*white-space: nowrap;/)
  })
  it('formats chart axes and table values with the selected locale and keeps the report day', async () => {
    chooseLanguage('zh-CN')
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        json(200, {
          ...result,
          timeZone: 'America/Los_Angeles',
          totals: { ...result.totals, created: 1200 },
          data: result.data.map((day) => ({ ...day, created: day.created * 300 })),
        }),
    })
    renderApp('/app/analytics')
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('rowheader', { name: '2026年3月29日' })).toBeDefined()
    expect(within(table).getByRole('cell', { name: '1,200' })).toBeDefined()
    const chart = screen.getAllByRole('figure')[0]
    expect(chart?.querySelector('.analytics-chart-counts span')?.textContent).toBe('1,200')
    expect(chart?.querySelector('.analytics-chart-dates span')?.textContent).toBe('3月29日')
  })
  it('treats a range with only no-shows as activity and tolerates older servers without the count', async () => {
    const zero = { created: 0, rescheduled: 0, cancelled: 0 }
    let noShows: number | undefined = 2
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        json(200, {
          ...result,
          totals: { ...zero, ...(noShows === undefined ? {} : { noShows }) },
          data: [],
        }),
    })
    const view = renderApp('/app/analytics')
    await screen.findByRole('table', { name: 'Daily booking activity' })
    expect(screen.getByText('No booking actions were recorded in this range.')).toBeDefined()
    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.queryByText('No booking activity was recorded in this range.')).toBeNull()
    expect(document.querySelectorAll('.metric-cards dd')[3]?.textContent).toBe('2')
    view.unmount()
    noShows = undefined
    renderApp('/app/analytics')
    await screen.findByRole('table', { name: 'Daily booking activity' })
    expect(screen.queryByText('No booking activity was recorded in this range.')).toBeNull()
    expect(document.querySelectorAll('.metric-cards dd')[3]?.textContent).toBe('—')
  })
  it('uses UTC before onboarding, displays zero activity and submits explicit valid filters', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(null),
      'GET /api/v1/analytics/bookings': ({ path }) =>
        json(200, {
          ...result,
          ...query(path),
          totals: { created: 0, rescheduled: 0, cancelled: 0, noShows: 0 },
          data: [
            { date: query(path).startDate, created: 0, rescheduled: 0, cancelled: 0, noShows: 0 },
          ],
        }),
    })
    renderApp('/app/analytics')
    await screen.findByText('No booking activity was recorded in this range.')
    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.getByRole('table', { name: 'Daily booking activity' })).toBeDefined()
    expect(query(api.to('GET /api/v1/analytics/bookings')[0]?.path ?? '').timeZone).toBe('UTC')
    await user.clear(screen.getByLabelText('Start date'))
    await user.type(screen.getByLabelText('Start date'), '2026-03-01')
    await user.clear(screen.getByLabelText('End date'))
    await user.type(screen.getByLabelText('End date'), '2026-03-31')
    await user.click(screen.getByRole('button', { name: 'Update report' }))
    await waitFor(() => expect(api.to('GET /api/v1/analytics/bookings')).toHaveLength(2))
    expect(query(api.to('GET /api/v1/analytics/bookings')[1]?.path ?? '')).toEqual({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      timeZone: 'UTC',
    })
  })
  it('refuses a range over 90 dates before fetching another report', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () => json(200, result),
    })
    renderApp('/app/analytics')
    await screen.findByRole('table')
    await user.clear(screen.getByLabelText('Start date'))
    await user.type(screen.getByLabelText('Start date'), '2026-01-01')
    await user.clear(screen.getByLabelText('End date'))
    await user.type(screen.getByLabelText('End date'), '2026-04-01')
    await user.click(screen.getByRole('button', { name: 'Update report' }))
    expect((await screen.findAllByText(/Choose at most 90 calendar days/)).length).toBeGreaterThan(
      0,
    )
    expect(api.to('GET /api/v1/analytics/bookings')).toHaveLength(1)
    const end = screen.getByLabelText('End date')
    const description = (end.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ')
    expect(description).toContain('Choose at most 90 calendar days')
    expect(description).toContain('Both dates are included, up to 90 local days.')
  })
  it('gives ordinary team members an explicit permission explanation without counts', async () => {
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () => json(403, { error: 'insufficient_role' }),
    })
    renderApp('/app/analytics')
    await screen.findByText(/Your current team role does not permit this report/)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Booking actions over time' })).toBeNull()
  })
  it('shows loading and recovers after a retry', async () => {
    const user = userEvent.setup()
    const delayed = later()
    let count = 0
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        ++count === 1 ? delayed.response : json(200, result),
    })
    renderApp('/app/analytics')
    await screen.findByText('Loading booking activity…')
    expect(screen.getByText('Loading booking activity…').closest('.page-skeleton')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Booking actions over time' })).toBeNull()
    await delayed.answer(json(500, { error: 'internal_error' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load booking activity.',
    )
    expect(screen.queryByRole('region', { name: 'Booking actions over time' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('region', { name: 'Booking actions over time' })).toBeDefined()
    await screen.findByRole('table')
  })
  it('does not replace a newer report with a stale response', async () => {
    const user = userEvent.setup()
    const delayed = later()
    let count = 0
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        ++count === 1 ? delayed.response : json(200, result),
    })
    renderApp('/app/analytics')
    await screen.findByText('Loading booking activity…')
    await user.click(screen.getByRole('button', { name: 'Update report' }))
    await screen.findByRole('table')
    await delayed.answer(json(200, { ...result, timeZone: 'America/New_York' }))
    expect(screen.queryByText(/Reporting time zone: America\/New_York/)).toBeNull()
    expect(screen.getByText(/Reporting time zone: Europe\/Berlin/)).toBeDefined()
  })
})
