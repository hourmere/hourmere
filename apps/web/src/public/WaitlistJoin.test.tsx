import { registeredLocales } from '@hourmere/core/language'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commonCatalogues } from '../i18n/common.ts'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes, slotsAnswer } from '../test/public-fixtures.ts'
import { waitlistWindow } from './waitlist-window.ts'

const clock = vi.hoisted(() => ({ now: Date.parse('2026-11-01T04:30:00Z') }))
vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  now: () => clock.now,
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
}))
beforeEach(() => {
  clock.now = Date.parse('2026-11-01T04:30:00Z')
})
const enabled = { ...EVENT, waitlist: { enabled: true as const } }
const consent = /I agree to receive waitlist emails/
const success = 'Check your email to confirm'
async function showNovember() {
  const user = userEvent.setup()
  // Empty calendars retain the normal bounded advance. Choose the desired visible
  // range explicitly before consenting to a waitlist window.
  await screen.findByRole('heading', { name: 'January 2027' })
  await user.click(screen.getByRole('button', { name: 'Previous month' }))
  await screen.findByRole('heading', { name: 'December 2026' })
  await user.click(screen.getByRole('button', { name: 'Previous month' }))
  await screen.findByRole('heading', { name: 'November 2026' })
  return user
}
async function openForm() {
  const user = await showNovember()
  await user.click(await screen.findByRole('button', { name: 'Join the waitlist' }))
  return user
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'ada@example.invalid')
  await user.click(screen.getByLabelText(consent))
}

describe('public waitlist entry', () => {
  it.each([
    '/ada/intro',
    '/embed/ada/intro',
    '/team/FixtureTeam/intro',
    '/embed/team/FixtureTeam/intro',
  ])('joins an empty enabled range on %s without session or extra booking fields', async (path) => {
    const team = path.includes('/team/')
    const endpoint = team ? '/api/v1/public/teams/FixtureTeam/intro' : '/api/v1/public/ada/intro'
    const api = fakeApi({
      [`GET ${endpoint}`]: () => json(200, enabled),
      [`GET ${endpoint}/slots`]: slotsAnswer([]),
      [`POST ${endpoint}/waitlist`]: () => json(202, { accepted: true }),
      [`POST ${endpoint}/waitlist/resend`]: () => json(202, { accepted: true }),
    })
    renderApp(path)
    const user = await openForm()
    expect(screen.getByText(/Nothing is reserved/)).toBeDefined()
    expect(screen.getByText(/Unconfirmed requests expire after 24 hours/)).toBeDefined()
    expect(
      screen.getByText(
        'The host or the team’s owners and admins can see your email, name and requested period.',
      ),
    ).toBeDefined()
    expect(screen.getByLabelText(/Your name/).getAttribute('required')).toBeNull()
    expect(screen.queryByLabelText('Guests')).toBeNull()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByRole('heading', { name: success })
    expect(api.to(`POST ${endpoint}/waitlist`)[0]?.body).toEqual({
      email: 'ada@example.invalid',
      locale: 'en',
      consent: true,
      preferredWindow: {
        start: '2026-11-01T04:35:00.000Z',
        end: '2026-12-01T05:00:00.000Z',
        timeZone: 'America/New_York',
      },
    })
    expect(api.calls.some((call) => /\/me$|\/api\/auth/.test(call.path))).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Resend confirmation email' }))
    await screen.findByText(
      'Confirmation email requested. Check your email; sending limits may prevent delivery.',
    )
    expect(api.to(`POST ${endpoint}/waitlist/resend`)).toHaveLength(1)
  })

  it.each([false, undefined])('offers no join when enabled=%s', async (value) => {
    fakeApi({
      ...eventRoutes(EVENT, []),
      'GET /api/v1/public/ada/intro': () =>
        json(200, { ...EVENT, ...(value === false && { waitlist: { enabled: false } }) }),
    })
    renderApp('/ada/intro')
    await screen.findByText('No available times this month.')
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
  })
  it('offers an empty chosen day while other days remain available', async () => {
    fakeApi(eventRoutes(enabled, ['2026-11-02T14:00:00Z']))
    renderApp('/ada/intro')
    const user = userEvent.setup()
    await screen.findByText('1 day has available times this month.')
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /November 3, no times available/ }))
    await screen.findByRole('button', { name: 'Join the waitlist' })
    await user.click(screen.getByRole('button', { name: /November 2, available/ }))
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
    expect(screen.getByRole('list', { name: /^Times on/ })).toBeDefined()
  })
  it('offers no join while loading or when availability fails', async () => {
    const pending = later()
    fakeApi({
      ...eventRoutes(enabled, []),
      'GET /api/v1/public/ada/intro/slots': () => pending.response,
    })
    renderApp('/ada/intro')
    await screen.findByText('Loading available times…')
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
    await pending.answer(json(503, { error: 'calendar_sync_unavailable' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
  })
  it('does not offer ranges beyond the 62-day limit', async () => {
    fakeApi(eventRoutes(enabled, []))
    renderApp('/ada/intro')
    const user = await showNovember()
    await screen.findByRole('button', { name: 'Join the waitlist' })
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Next month' }))
    await screen.findByRole('heading', { name: 'February 2027' })
    await waitFor(() => expect(screen.getByText('No available times this month.')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
  })
  it('announces and links validation errors and requires consent', async () => {
    const api = fakeApi(eventRoutes(enabled, []))
    renderApp('/ada/intro')
    const user = await openForm()
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    const alert = screen.getByRole('alert')
    expect(document.activeElement).toBe(alert)
    expect(
      within(alert).getByText('Agree to receive waitlist emails before joining.'),
    ).toBeDefined()
    const email = screen.getByLabelText('Email')
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')).not.toBeNull()
    expect(screen.getByLabelText(consent).getAttribute('aria-invalid')).toBe('true')
    expect(api.to('POST /api/v1/public/ada/intro/waitlist')).toHaveLength(0)
    await user.click(within(alert).getByRole('link', { name: 'Enter an email address.' }))
    expect(document.activeElement).toBe(email)
  })
  it('keeps responses neutral and has no automatic retry or resend', async () => {
    const api = fakeApi({
      ...eventRoutes(enabled, []),
      'POST /api/v1/public/ada/intro/waitlist': () =>
        json(409, {
          error: 'availability_changed',
          message: 'private@example.invalid active entry',
        }),
    })
    renderApp('/ada/intro')
    const user = await openForm()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByText(
      'The waitlist is unavailable for this period. Check available times and try again.',
    )
    expect(document.body.textContent).not.toContain('private@example.invalid')
    expect(api.to('POST /api/v1/public/ada/intro/waitlist')).toHaveLength(1)
    expect(api.calls.filter((call) => call.path.endsWith('/resend'))).toHaveLength(0)
  })
  it('rejects an expired displayed range instead of silently changing consent', async () => {
    const api = fakeApi(eventRoutes(enabled, []))
    renderApp('/ada/intro')
    const user = await openForm()
    await fill(user)
    clock.now += 6 * 60_000
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByText(
      'The waitlist is unavailable for this period. Check available times and try again.',
    )
    expect(api.to('POST /api/v1/public/ada/intro/waitlist')).toHaveLength(0)
  })
  it('prevents duplicate submissions while a join is in flight', async () => {
    const pending = later()
    const api = fakeApi({
      ...eventRoutes(enabled, []),
      'POST /api/v1/public/ada/intro/waitlist': () => pending.response,
    })
    renderApp('/ada/intro')
    const user = await openForm()
    await fill(user)
    const form = screen.getByLabelText('Email').closest('form')
    if (!form) throw new Error('Expected waitlist form')
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(api.to('POST /api/v1/public/ada/intro/waitlist')).toHaveLength(1))
    await pending.answer(json(202, { accepted: true }))
    await screen.findByRole('heading', { name: success })
  })
  it('reloads availability and asks for fresh consent when the displayed window expires', async () => {
    const api = fakeApi({
      ...eventRoutes(enabled, []),
      'POST /api/v1/public/ada/intro/waitlist': () => json(202, { accepted: true }),
    })
    renderApp('/ada/intro')
    const user = await openForm()
    await fill(user)
    clock.now += 6 * 60_000
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    await user.click(await screen.findByRole('button', { name: 'Join the waitlist' }))
    expect((screen.getByLabelText(consent) as HTMLInputElement).checked).toBe(false)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByRole('heading', { name: success })
    expect(api.to('POST /api/v1/public/ada/intro/waitlist')).toHaveLength(1)
  })
  it('uses the default meeting length for waitlist consent', async () => {
    fakeApi(eventRoutes({ ...enabled, allowedDurationsMinutes: [30, 60] }, []))
    renderApp('/ada/intro')
    const user = await showNovember()
    await screen.findByRole('button', { name: 'Join the waitlist' })
    await user.click(screen.getByRole('radio', { name: '1 h' }))
    await screen.findByText('No available times this month.')
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).toBeNull()
    expect(
      screen.getByText('To join the waitlist, choose the default meeting length (30 min).'),
    ).toBeDefined()
    await user.click(screen.getByRole('radio', { name: '30 min' }))
    await screen.findByRole('button', { name: 'Join the waitlist' })
  })
})

describe('waitlist boundaries and public locales', () => {
  it.each([
    ['2027-03-14', 23],
    ['2026-11-01', 25],
  ] as const)('uses real elapsed hours for New York %s', (day, hours) => {
    const range = waitlistWindow(
      { year: 2026, month: 11 },
      day,
      'America/New_York',
      Date.parse(day) - 86_400_000,
    )
    expect(range).not.toBeNull()
    expect((Date.parse(range?.end ?? '') - Date.parse(range?.start ?? '')) / 3_600_000).toBe(hours)
  })
  it('clips future windows, refuses past ones and invalid zones', () => {
    const now = Date.parse('2026-11-01T00:00Z')
    expect(waitlistWindow({ year: 2027, month: 2 }, null, 'UTC', now)).toBeNull()
    expect(waitlistWindow({ year: 2026, month: 10 }, null, 'UTC', now)).toBeNull()
    expect(waitlistWindow({ year: 2026, month: 11 }, null, 'Bad/Zone', now)).toBeNull()
    expect(waitlistWindow({ year: 2027, month: 1 }, null, 'UTC', now)?.end).toBe(
      new Date(now + 62 * 86_400_000).toISOString(),
    )
  })
  it('translates every added public string in all shipped locales', () => {
    const keys = [
      'Join the waitlist',
      'No available times in this period.',
      'Check your email to confirm',
      'If a time opens, everyone eligible may be notified. Nothing is reserved; the first successful booking wins.',
      'I agree to receive waitlist emails for this period. I can leave using the link in any waitlist email.',
      'The host or the team’s owners and admins can see your email, name and requested period.',
      'Leaving clears your contact details. We keep hashed (non-readable) records for 2 days to prevent abuse and for up to 64 days to avoid repeat notifications.',
      'You can stay on the waitlist until {date}. Unconfirmed requests expire after 24 hours.',
      'If your request can be accepted, we will send a confirmation link. Sending limits may prevent delivery. Submitting the join form again does not resend the confirmation email.',
      'Confirmation email requested. Check your email; sending limits may prevent delivery.',
      'Too many requests from your network. Try again in {duration}.',
      '{count} second',
      '{count} seconds',
      '{count} minute',
      '{count} minutes',
      '{count} hour',
      '{count} hours',
      'The waitlist is unavailable for this period. Check available times and try again.',
      'Resend confirmation email',
    ]
    for (const { code } of registeredLocales)
      for (const key of keys) {
        const value = commonCatalogues[`./catalogues/${code}/common.ts`]?.[key]
        expect(value, `${code}: ${key}`).toBeTypeOf('string')
        if (code !== 'en' && !key.startsWith('{count}')) expect(value).not.toBe(key)
        expect(value?.match(/\{\w+\}/g)?.sort() ?? []).toEqual(key.match(/\{\w+\}/g)?.sort() ?? [])
        if (code === 'zh-CN') expect(value).not.toContain('您')
      }
  })
})
