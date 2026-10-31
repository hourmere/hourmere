import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import {
  booking,
  EVENT,
  eventRoutes,
  managed,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const TARGET = 'https://host.example/thanks?campaign=welcome&booking_uid=public-uid'
const QUERY = '?redirectUrl=https%3A%2F%2Funtrusted.example%2F&allowEmbedParent=true'
const START = '2026-11-02T14:00:00Z'
const CONTINUE = 'Continue to host.example'

beforeEach(() => window.history.replaceState(null, '', '/'))

async function submitBooking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
  await user.click(screen.getByRole('button', { name: '9:00 AM' }))
  await user.type(screen.getByLabelText('Your name'), 'Grace Hopper')
  await user.type(screen.getByLabelText('Email'), 'grace@example.com')
  await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
}

function expectNoContinue() {
  expect(screen.queryByRole('link', { name: /^Continue to / })).toBeNull()
  expect(document.querySelector('a[href^="https://untrusted.example"]')).toBeNull()
}

describe('the saved booking success redirect', () => {
  it.each([
    { path: '/ada/intro', allowEmbedParent: false, target: null, context: 'this tab' },
    { path: '/embed/ada/intro', allowEmbedParent: false, target: '_blank', context: 'a new tab' },
    {
      path: '/embed/ada/intro',
      allowEmbedParent: true,
      target: '_top',
      context: 'the parent page',
    },
  ])(
    'offers an explicit Continue link at $path (parent opt-in $allowEmbedParent)',
    async ({ path, allowEmbedParent, target, context }) => {
      const user = userEvent.setup()
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      const api = fakeApi({
        ...eventRoutes(EVENT, [START]),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, {
            booking: booking(),
            manageToken: TOKEN,
            successRedirect: { url: TARGET, allowEmbedParent },
          }),
      })
      renderApp(path + QUERY)
      await screen.findByRole('heading', { name: 'Intro call' })
      expectNoContinue()
      await submitBooking(user)
      await screen.findByRole('heading', { name: 'You’re booked' })
      const link = screen.getByRole('link', { name: CONTINUE })
      expect(link.getAttribute('href')).toBe(TARGET)
      expect(link.getAttribute('target')).toBe(target)
      expect(link.getAttribute('rel')?.split(' ')).toEqual(
        expect.arrayContaining(['noopener', 'noreferrer']),
      )
      expect(link.tabIndex).toBe(0)
      expect(screen.getByText(`Opens the host’s website in ${context}.`)).toBeDefined()
      expect(
        document.getElementById(link.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toBe(`Opens the host’s website in ${context}.`)
      const savedLink = screen.getByRole('textbox', {
        name: 'Your link to change or cancel this booking',
      })
      const calendar = screen.getByRole('heading', { name: 'Add to your calendar' })
      for (const information of [calendar, savedLink])
        expect(
          information.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
      // Confirmation stays visible without any navigation or timer-driven hand-off.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(screen.getByRole('heading', { name: 'You’re booked' })).toBeDefined()
      expect(screen.getByTestId('location').textContent).toBe(path + QUERY)
      expect(open).not.toHaveBeenCalled()
      expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.path).toBe(
        '/api/v1/public/ada/intro/bookings',
      )
      expect(api.to('POST /api/v1/public/ada/intro/bookings')[0]?.body).not.toHaveProperty(
        'redirectUrl',
      )
      // The Continue action is reachable from the preceding private-booking controls.
      link.focus()
      expect(document.activeElement).toBe(link)
    },
  )

  it.each(['/ada/intro', '/embed/ada/intro'])(
    'keeps the normal confirmation when unset at %s, ignoring request query targets',
    async (path) => {
      const user = userEvent.setup()
      fakeApi({
        ...eventRoutes(EVENT, [START]),
        'POST /api/v1/public/ada/intro/bookings': () =>
          json(201, { booking: booking(), manageToken: TOKEN }),
      })
      renderApp(path + QUERY)
      await submitBooking(user)
      await screen.findByRole('heading', { name: 'You’re booked' })
      expectNoContinue()
      expect(screen.getByRole('heading', { name: 'Add to your calendar' })).toBeDefined()
      expect(
        screen.getByRole('textbox', { name: 'Your link to change or cancel this booking' }),
      ).toBeDefined()
    },
  )

  it('does not offer a target after a failed booking', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(503, {
          error: 'internal_error',
          successRedirect: { url: TARGET, allowEmbedParent: true },
        }),
    })
    renderApp(`/ada/intro${QUERY}`)
    await submitBooking(user)
    await screen.findByText('Something went wrong on our side. Try again in a moment.')
    expectNoContinue()
    expect(screen.queryByRole('heading', { name: 'You’re booked' })).toBeNull()
  })

  it('retains the server-supplied target on an idempotent replay without a manage token', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(200, {
          booking: booking(),
          manageToken: null,
          successRedirect: { url: TARGET, allowEmbedParent: false },
        }),
    })
    renderApp(`/ada/intro${QUERY}`)
    await submitBooking(user)
    expect((await screen.findByRole('link', { name: CONTINUE })).getAttribute('href')).toBe(TARGET)
    expect(
      screen.getByText(
        'This booking was already made by an earlier attempt, so its link can’t be shown again.',
      ),
    ).toBeDefined()
  })

  it('does not show a target on a cancelled replay', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(200, {
          booking: booking({ status: 'cancelled' }),
          manageToken: null,
          successRedirect: { url: TARGET, allowEmbedParent: true },
        }),
    })
    renderApp('/ada/intro')
    await submitBooking(user)
    await screen.findByRole('heading', { name: 'Cancelled booking' })
    expectNoContinue()
  })

  it('removes Continue when a protected conference refresh discovers cancellation', async () => {
    const user = userEvent.setup()
    const refreshed = later()
    const pending = booking({
      location: { kind: 'google_meet', autoCreate: true },
      conference: { provider: 'google_meet', status: 'pending', errorCode: null },
    })
    const api = fakeApi({
      ...eventRoutes(EVENT, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, {
          booking: pending,
          manageToken: TOKEN,
          successRedirect: { url: TARGET, allowEmbedParent: false },
        }),
      'GET /api/v1/bookings/manage': () => refreshed.response,
    })
    renderApp('/ada/intro')
    await submitBooking(user)
    await screen.findByRole('link', { name: CONTINUE })
    await waitFor(() => expect(api.to('GET /api/v1/bookings/manage')).toHaveLength(1), {
      timeout: 4000,
    })
    await refreshed.answer(json(200, { ...pending, status: 'cancelled' }))
    await screen.findByRole('heading', { name: 'Cancelled booking' })
    expectNoContinue()
  })

  it('does not offer Continue on the manage or cancellation views even if an unexpected response includes it', async () => {
    const user = userEvent.setup()
    fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(200, { ...managed(), successRedirect: { url: TARGET, allowEmbedParent: true } }),
      'POST /api/v1/bookings/manage/cancel': () =>
        json(200, {
          ...booking({ status: 'cancelled' }),
          successRedirect: { url: TARGET, allowEmbedParent: true },
        }),
    })
    renderApp(`/booking#token=${TOKEN}`)
    await screen.findByRole('heading', { name: 'Your booking' })
    expectNoContinue()
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByRole('heading', { name: 'Cancelled booking' })
    expectNoContinue()
  })

  it('translates the Continue link and context in every public language', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes(EVENT, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, {
          booking: booking(),
          manageToken: TOKEN,
          successRedirect: { url: TARGET, allowEmbedParent: false },
        }),
    })
    renderApp('/ada/intro')
    await submitBooking(user)
    await screen.findByRole('link', { name: CONTINUE })
    for (const [language, label, context] of [
      ['zh-CN', '继续前往 host.example', '将在当前标签页中打开主办者的网站。'],
      ['de', 'Weiter zu host.example', 'Öffnet die Website des Gastgebers in diesem Tab.'],
      ['fr', 'Continuer vers host.example', 'Ouvre le site de l’hôte dans cet onglet.'],
      ['es', 'Continuar a host.example', 'Abre el sitio web del anfitrión en esta pestaña.'],
      ['pt-BR', 'Continuar para host.example', 'Abre o site do anfitrião nesta aba.'],
    ] as const) {
      await selectPublicLanguage(user, language)
      expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe(TARGET)
      expect(screen.getByText(context)).toBeDefined()
      expect(
        screen.queryByText(
          'Keep your booking details and link before continuing to the host’s website.',
        ),
      ).toBeNull()
    }
  })

  it('does not offer Continue after rescheduling, even if an unexpected response includes it', async () => {
    const user = userEvent.setup()
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer(['2026-11-03T15:00:00Z']),
      'POST /api/v1/bookings/manage/reschedule': () =>
        json(200, {
          booking: booking({ start: '2026-11-03T15:00:00.000Z', end: '2026-11-03T15:30:00.000Z' }),
          manageToken: TOKEN,
          successRedirect: { url: TARGET, allowEmbedParent: true },
        }),
    })
    renderApp(`/booking#token=${TOKEN}`)
    await screen.findByRole('heading', { name: 'Your booking' })
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    await user.click(await screen.findByRole('button', { name: /November 3, available/ }))
    await user.click(screen.getByRole('button', { name: '10:00 AM' }))
    await user.click(screen.getByRole('button', { name: 'Confirm new time' }))
    await screen.findByText('Your booking is moved to the new time.')
    expectNoContinue()
  })
})
