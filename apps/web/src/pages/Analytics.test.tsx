import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import styles from '../styles.css?raw'
import { fakeApi, json, later, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { initialActivityFilters } from './Analytics.tsx'

const result = {
  startDate: '2026-03-29',
  endDate: '2026-03-30',
  timeZone: 'Europe/Berlin',
  totals: { created: 4, rescheduled: 2, cancelled: 1 },
  data: [
    { date: '2026-03-29', created: 4, rescheduled: 2, cancelled: 0 },
    { date: '2026-03-30', created: 0, rescheduled: 0, cancelled: 1 },
  ],
}
const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams)

describe('booking activity page', () => {
  it('defaults to 30 date labels in the chosen local zone, without browser Temporal', () => {
    expect(initialActivityFilters('America/Los_Angeles', new Date('2026-03-01T01:00:00Z'))).toEqual(
      { startDate: '2026-01-30', endDate: '2026-02-28', timeZone: 'America/Los_Angeles' },
    )
    expect(initialActivityFilters('unknown', new Date('2026-03-01T01:00:00Z')).timeZone).toBe('UTC')
  })
  it('shows action definitions, count-only totals and an accessible daily table', async () => {
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () => json(200, result),
    })
    renderApp('/app/analytics')
    const table = await screen.findByRole('table', { name: 'Daily booking activity' })
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['2026-03-29', '2026-03-30'])
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
  it('keeps each Chinese report date together when the heading wraps on narrow screens', async () => {
    chooseLanguage('zh-CN')
    fakeApi({
      ...signedIn,
      ...profile(),
      'GET /api/v1/analytics/bookings': () =>
        json(200, { ...result, startDate: '2026-09-21', endDate: '2026-10-20' }),
    })
    renderApp('/app/analytics')
    const heading = await screen.findByRole('heading', { name: '2026-09-21 至 2026-10-20' })
    expect([...heading.querySelectorAll('.nowrap')].map((date) => date.textContent)).toEqual([
      '2026-09-21',
      '2026-10-20',
    ])
    expect(styles).toMatch(/\.nowrap\s*\{\s*white-space: nowrap;/)
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
          totals: { created: 0, rescheduled: 0, cancelled: 0 },
          data: [],
        }),
    })
    renderApp('/app/analytics')
    await screen.findByText('No booking activity was recorded in this range.')
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
    await delayed.answer(json(500, { error: 'internal_error' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
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
