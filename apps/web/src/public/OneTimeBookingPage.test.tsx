import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { type Call, fakeApi, json, type Routes, renderApp } from '../test/fake-api.tsx'
import { booking, EVENT, slot, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'
import type { OneTimeBookingPage } from './api.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const LINK_TOKEN = 'pAtH_0123456789abcdefghijklmnopqrstuvwxyzAB'
const BASE = `/api/v1/book/${LINK_TOKEN}`
const PAGE = `/book/${LINK_TOKEN}`
const UNAVAILABLE = 'This booking link is unavailable'
const HINT = 'These details were filled in for convenience. You can change them.'
const START = '2026-11-02T14:00:00Z'
const PREFILL = { name: 'Prefilled Visitor', email: 'prefilled@example.invalid' }
const QUESTION = { id: 'topic', label: 'Topic', type: 'short_text', required: true } as const
const ONE_TIME_EVENT: OneTimeBookingPage['eventType'] = {
  title: EVENT.title,
  description: EVENT.description,
  durationMinutes: EVENT.durationMinutes,
  locations: EVENT.locations,
  location: EVENT.location,
  allowGuests: EVENT.allowGuests,
  host: EVENT.host,
  allowedDurationsMinutes: [30, 60],
  questions: [QUESTION],
}

beforeEach(() => window.history.replaceState(null, '', '/'))

function routes(overrides: Routes = {}): Routes {
  return {
    [`GET ${BASE}`]: () =>
      json(200, {
        eventType: ONE_TIME_EVENT,
        prefill: PREFILL,
      }),
    [`GET ${BASE}/slots`]: (call: Call) =>
      slotsAnswer(
        [START],
        Number(new URL(call.path, 'http://x').searchParams.get('durationMinutes')) || 30,
      )(call),
    [`POST ${BASE}/bookings`]: (call: Call) => {
      const body = call.body as { durationMinutes: number }
      return json(201, { booking: booking(slot(START, body.durationMinutes)), manageToken: TOKEN })
    },
    ...overrides,
  }
}

async function pick(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Monday, November 2, available' }))
  await user.click(screen.getByRole('button', { name: '9:00 AM' }))
}

describe('one-time public booking', () => {
  it('uses the token only in API paths, with editable prefill and the normal duration/questions/manage flow', async () => {
    const user = userEvent.setup()
    const api = fakeApi(routes())
    renderApp(`${PAGE}?token=ignored-query-value&utm_source=ignored`)
    await user.click(await screen.findByRole('radio', { name: '1 h' }))
    expect(document.head.innerHTML.includes('undefined')).toBe(false)
    expect(document.querySelector('link[rel="canonical"], meta[property="og:url"]')).toBeNull()
    await pick(user)
    const name = screen.getByLabelText<HTMLInputElement>('Your name')
    const email = screen.getByLabelText<HTMLInputElement>('Email')
    expect(name.value).toBe(PREFILL.name)
    expect(email.value).toBe(PREFILL.email)
    expect(name.readOnly || name.disabled || email.readOnly || email.disabled).toBe(false)
    expect(screen.getByText(HINT)).toBeDefined()
    await user.clear(name)
    await user.type(name, 'Different Visitor')
    await user.clear(email)
    await user.type(email, 'different@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(api.to(`POST ${BASE}/bookings`)).toHaveLength(0)
    await user.type(screen.getByLabelText('Topic'), 'Compiler design')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const sent = api.to(`POST ${BASE}/bookings`)[0]
    expect(sent?.body).toMatchObject({
      durationMinutes: 60,
      invitee: { name: 'Different Visitor', email: 'different@example.invalid' },
      responses: { topic: 'Compiler design' },
    })
    expect(screen.getByRole('link', { name: 'Cancel booking' }).getAttribute('href')).toMatch(
      /^\/booking#token=/,
    )
    expect(screen.getByRole('link', { name: 'Download .ics file' })).toBeDefined()
    for (const element of document.querySelectorAll('a[href]')) {
      const href = decodeURIComponent(element.getAttribute('href') ?? '')
      expect(href.includes(`/${EVENT.handle}/${EVENT.slug}`)).toBe(false)
      expect(href.includes('undefined')).toBe(false)
    }
    expect(api.calls.some((call) => call.path.includes('/api/v1/public/'))).toBe(false)
    for (const call of api.calls) {
      const url = new URL(call.path, 'http://x')
      expect(url.search.includes(LINK_TOKEN)).toBe(false)
      expect(JSON.stringify(call.body)?.includes(LINK_TOKEN) ?? false).toBe(false)
      expect(JSON.stringify([...call.headers]).includes(LINK_TOKEN)).toBe(false)
      expect(url.searchParams.has('token')).toBe(false)
      expect(url.pathname === '/api/v1/instance' || url.pathname.startsWith(BASE)).toBe(true)
    }
    for (const element of document.querySelectorAll('a, input, textarea, [role="alert"]'))
      expect(element.outerHTML.includes(LINK_TOKEN)).toBe(false)
  })

  it('retries the winning request with the same identity after a lost response and shows the replayed booking', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = fakeApi(
      routes({
        [`POST ${BASE}/bookings`]: () => {
          if (++attempts === 1) throw new TypeError('Failed to fetch')
          return json(200, { booking: booking() })
        },
      }),
    )
    renderApp(PAGE)
    await pick(user)
    await user.type(screen.getByLabelText('Topic'), 'Compiler design')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(screen.getByText(/This booking was already made by an earlier attempt/)).toBeDefined()
    const calls = api.to(`POST ${BASE}/bookings`)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body).toEqual(calls[1]?.body)
    expect(calls[0]?.headers.get('idempotency-key')).toBe(calls[1]?.headers.get('idempotency-key'))
    expect(api.to(`GET ${BASE}`)).toHaveLength(1)
    expect(screen.queryByRole('link', { name: 'Cancel booking' })).toBeNull()
  })

  it.each(['unknown', 'expired', 'revoked', 'used', 'inactive'])(
    'shows exactly the same neutral failure page for a %s link',
    async (state) => {
      const api = fakeApi({
        [`GET ${BASE}`]: () =>
          json(404, { error: 'one_time_link_not_found', message: `${state}: ${LINK_TOKEN}` }),
      })
      renderApp(PAGE)
      await screen.findByRole('heading', { name: UNAVAILABLE })
      expect(api.to(`GET ${BASE}`)).toHaveLength(1)
      expect(screen.getByRole('main').textContent).toBe(
        `${UNAVAILABLE}Contact the host for a new booking link.`,
      )
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      expect(screen.queryByText(/already used|expired|revoked/i)).toBeNull()
      expect(screen.getByRole('main').outerHTML.includes(LINK_TOKEN)).toBe(false)
    },
  )

  it.each(['slots', 'bookings'])(
    'replaces the whole flow with the neutral failure page when %s loses a race',
    async (endpoint) => {
      const user = userEvent.setup()
      fakeApi(
        routes({
          [`${endpoint === 'slots' ? 'GET' : 'POST'} ${BASE}/${endpoint}`]: () =>
            json(404, { error: 'one_time_link_not_found', message: 'Already used' }),
        }),
      )
      renderApp(PAGE)
      if (endpoint === 'bookings') {
        await pick(user)
        await user.type(screen.getByLabelText('Topic'), 'Compiler design')
        await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      }
      await screen.findByRole('heading', { name: UNAVAILABLE })
      expect(screen.queryByRole('grid')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Intro call' })).toBeNull()
      expect(screen.queryByText(/Already used/)).toBeNull()
    },
  )

  it.each(['/book', '/book?token=ignored-query-value', '/book/not-a-valid-capability'])(
    'does not resolve a missing or malformed path token at %s',
    async (path) => {
      const api = fakeApi({})
      renderApp(path)
      await screen.findByRole('heading', { name: UNAVAILABLE })
      expect(api.calls.every((call) => !call.path.startsWith('/api/v1/book/'))).toBe(true)
    },
  )

  it.each(['dedicated route', 'ordinary iframe'])(
    'refuses embedding through %s without reading the link or posting to the parent',
    async (mode) => {
      const postMessage = vi.fn()
      if (mode === 'ordinary iframe')
        vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
      const api = fakeApi(routes())
      renderApp(mode === 'dedicated route' ? `/embed/book/${LINK_TOKEN}` : PAGE)
      await screen.findByRole('heading', { name: UNAVAILABLE })
      expect(api.calls.every((call) => !call.path.startsWith('/api/v1/book/'))).toBe(true)
      expect(postMessage).not.toHaveBeenCalled()
    },
  )

  it('never reflects response prose containing a capability in recoverable errors', async () => {
    const user = userEvent.setup()
    let reads = 0
    const api = fakeApi(
      routes({
        [`GET ${BASE}`]: () =>
          ++reads === 1
            ? json(400, { error: 'unknown_error', message: `Bad path ${LINK_TOKEN}` })
            : json(200, { eventType: { ...ONE_TIME_EVENT, questions: [] }, prefill: PREFILL }),
        [`POST ${BASE}/bookings`]: () =>
          json(400, { error: 'unknown_error', message: `Bad path ${LINK_TOKEN}` }),
      }),
    )
    renderApp(PAGE)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent?.includes(LINK_TOKEN)).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await pick(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await waitFor(() => expect(api.to(`POST ${BASE}/bookings`)).toHaveLength(1))
    expect(
      within(screen.getByRole('main')).getByRole('alert').textContent?.includes(LINK_TOKEN),
    ).toBe(false)
  })

  it.each([
    ['en', UNAVAILABLE, 'Contact the host for a new booking link.'],
    ['zh-CN', '此预约链接不可用', '请联系主持人，获取新的预约链接。'],
    [
      'de',
      'Dieser Buchungslink ist nicht verfügbar',
      'Bitten Sie die gastgebende Person um einen neuen Buchungslink.',
    ],
    [
      'fr',
      'Ce lien de réservation n’est pas disponible',
      'Demandez un nouveau lien de réservation à l’hôte.',
    ],
    [
      'es',
      'Este enlace de reserva no está disponible',
      'Pida al anfitrión un nuevo enlace de reserva.',
    ],
    [
      'pt-BR',
      'Este link de agendamento está indisponível',
      'Peça um novo link de agendamento ao anfitrião.',
    ],
  ] as const)(
    'localizes the complete unavailable page in %s',
    async (language, heading, detail) => {
      chooseLanguage(language)
      fakeApi({ [`GET ${BASE}`]: () => json(404, { error: 'one_time_link_not_found' }) })
      renderApp(PAGE)
      await screen.findByRole('heading', { name: heading })
      expect(screen.getByText(detail)).toBeDefined()
    },
  )

  it.each([
    ['en', HINT],
    ['zh-CN', '这些信息已预先填写，方便你预约。你可以自行修改。'],
    [
      'de',
      'Diese Angaben wurden vorausgefüllt, um Ihnen die Buchung zu erleichtern. Sie können sie ändern.',
    ],
    [
      'fr',
      'Ces informations ont été préremplies pour vous faciliter la tâche. Vous pouvez les modifier.',
    ],
    ['es', 'Estos datos se han rellenado para facilitarle la reserva. Puede cambiarlos.'],
    ['pt-BR', 'Estes dados foram preenchidos para facilitar o agendamento. Você pode alterá-los.'],
  ] as const)('explains editable prefill naturally in %s', async (language, hint) => {
    chooseLanguage(language)
    fakeApi(routes())
    renderApp(PAGE)
    const day = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-day="2026-11-02"]')
      expect(button?.disabled).toBe(false)
      return button as HTMLButtonElement
    })
    await userEvent.click(day)
    const times = screen.getByRole('list', { name: /./ })
    await userEvent.click(within(times).getAllByRole('button')[0] as HTMLButtonElement)
    expect(screen.getByText(hint)).toBeDefined()
    expect(document.querySelector<HTMLInputElement>('[data-field="name"]')?.value).toBe(
      PREFILL.name,
    )
  })
})

it('loads one-time availability for the selected location', async () => {
  const api = fakeApi(
    routes({
      [`GET ${BASE}`]: () =>
        json(200, {
          eventType: {
            ...ONE_TIME_EVENT,
            locations: [
              { id: 'office', kind: 'in_person', label: 'Office' },
              { id: 'meet', kind: 'google_meet', label: 'Meet' },
            ],
          },
          prefill: PREFILL,
        }),
    }),
  )
  const user = userEvent.setup()
  renderApp(PAGE)
  await user.click(await screen.findByRole('radio', { name: 'Meet' }))
  await pick(user)
  expect(
    new URL(api.to(`GET ${BASE}/slots`).at(-1)?.path ?? '', 'http://x').searchParams.get(
      'locationOptionId',
    ),
  ).toBe('meet')
})
