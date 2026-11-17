import { brandPalette } from '@hourmere/core/brand-contrast'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { booking, EVENT, managed, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const BRAND = {
  name: 'Example organization',
  primaryColor: '#5c248a',
  logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
}
const START = '2026-11-02T14:00:00Z'
const ONE_TIME = 'pAtH_0123456789abcdefghijklmnopqrstuvwxyzAB'

beforeAll(async () => {
  await Promise.all([
    import('./BookingPage.tsx'),
    import('./HostPage.tsx'),
    import('./ManageBookingPage.tsx'),
    import('./Embed.tsx'),
  ])
})
beforeEach(() => window.history.replaceState(null, '', '/'))

function expectBrand() {
  const logo = screen.getByRole('img', { name: BRAND.name })
  expect(logo.getAttribute('src')).toBe(BRAND.logoDataUrl)
  expect(logo.getAttribute('width')).toBe('192')
  expect(logo.getAttribute('height')).toBe('64')
  const frame = screen.getByRole('main').parentElement as HTMLElement
  const palette = brandPalette(BRAND.primaryColor)
  expect(frame.classList.contains('public-branded')).toBe(true)
  expect(frame.style.getPropertyValue('--brand-light-accent')).toBe(palette?.light.accent)
  expect(frame.style.getPropertyValue('--brand-dark-focus')).toBe(palette?.dark.focus)
  expect(screen.getByRole('link', { name: 'Powered by Hourmere' })).toBeDefined()
  return logo
}

describe('organization branding on public pages', () => {
  it.each([
    ['/ada/intro', '/api/v1/public/ada/intro'],
    ['/team/Alpha/intro', '/api/v1/public/teams/Alpha/intro'],
    ['/embed/ada/intro', '/api/v1/public/ada/intro'],
    ['/embed/team/Alpha/intro', '/api/v1/public/teams/Alpha/intro'],
    [`/book/${ONE_TIME}`, `/api/v1/book/${ONE_TIME}`],
  ])(
    'renders the scoped brand at %s, including shared inline/popup embed content',
    async (path, api) => {
      const event = { ...EVENT, branding: BRAND }
      fakeApi({
        [`GET ${api}`]: () => json(200, path.startsWith('/book/') ? { eventType: event } : event),
        [`GET ${api}/slots`]: slotsAnswer([]),
      })
      renderApp(path)
      await screen.findByRole('heading', { name: 'Intro call' })
      const logo = expectBrand()
      fireEvent.error(logo)
      expect(logo.style.visibility).toBe('hidden')
      expect(logo.getAttribute('height')).toBe('64')
    },
  )

  it('renders the personal organization brand on the host page', async () => {
    fakeApi({
      'GET /api/v1/public/ada': () =>
        json(200, { host: EVENT.host, eventTypes: [EVENT], branding: BRAND }),
    })
    renderApp('/ada')
    await screen.findByRole('heading', { name: 'Ada Lovelace' })
    expectBrand()
  })

  it.each(['', '&action=reschedule', '&action=cancel'])(
    'keeps the booking organization brand on manage pages %s',
    async (action) => {
      fakeApi({
        'GET /api/v1/bookings/manage': () => json(200, { ...managed(), branding: BRAND }),
        'GET /api/v1/bookings/manage/slots': slotsAnswer([]),
      })
      renderApp(`/booking#token=${TOKEN}${action}`)
      await screen.findByRole('img', { name: BRAND.name })
      expectBrand()
    },
  )

  it('retains branding on read-only imported booking management', async () => {
    fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(200, { ...managed(), source: 'import', branding: BRAND }),
    })
    renderApp(`/booking#token=${TOKEN}`)
    await screen.findByText(
      'This imported booking is read-only and managed in the original system.',
    )
    expectBrand()
  })

  it('retains the brand through booking confirmation', async () => {
    const user = userEvent.setup()
    fakeApi({
      'GET /api/v1/public/ada/intro': () => json(200, { ...EVENT, branding: BRAND }),
      'GET /api/v1/public/ada/intro/slots': slotsAnswer([START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, { booking: booking(), manageToken: TOKEN }),
    })
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: 'Monday, November 2, available' }))
    await user.click(screen.getByRole('button', { name: '9:00 AM' }))
    await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
    await user.type(screen.getByLabelText('Email'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expectBrand()
  })

  it.each([
    undefined,
    { ...BRAND, primaryColor: 'not-a-color', logoDataUrl: 'https://external.example/logo.png' },
  ])('uses the default theme for absent or invalid stored branding', async (branding) => {
    fakeApi({
      'GET /api/v1/public/ada/intro': () => json(200, { ...EVENT, branding }),
      'GET /api/v1/public/ada/intro/slots': slotsAnswer([]),
    })
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    expect(screen.queryByRole('img', { name: BRAND.name })).toBeNull()
    const frame = screen.getByRole('main').parentElement as HTMLElement
    expect(frame.classList.contains('public-branded')).toBe(false)
    expect(frame.style.getPropertyValue('--brand-light-accent')).toBe('')
    expect(screen.getByRole('link', { name: 'Powered by Hourmere' })).toBeDefined()
  })
})
