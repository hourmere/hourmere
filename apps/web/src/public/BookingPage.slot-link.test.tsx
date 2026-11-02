import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { type Call, fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import {
  ALL_QUESTIONS,
  booking,
  EVENT,
  eventRoutes,
  slot,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'

const env = vi.hoisted(() => ({
  zone: 'America/New_York',
  now: Date.parse('2026-11-01T04:30:00Z'),
}))
vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => env.zone,
  preferredLocale: () => 'en-US',
  now: () => env.now,
}))

const START = '2026-11-02T14:00:00.000Z'
const NEXT = '2026-11-02T15:00:00.000Z'
const API = '/api/v1/public/ada/intro'
const UNAVAILABLE = 'That time is no longer available. Please pick another one.'
const REMOVED = 'This meeting length is no longer offered. Please choose a time again.'
const UNKNOWN = 'We could not check this time. Please try again.'
const hint = (start = START, duration = 30) =>
  `?${new URLSearchParams({ start, durationMinutes: String(duration) })}`
const query = (call: Call) => new URL(call.path, 'http://x').searchParams
const exact = (call: Call) =>
  query(call).get('start') === START && query(call).get('end') === slot(START).end
const selected = () => screen.findByRole('heading', { name: 'Your details' })
const picker = () => screen.findByRole('heading', { name: 'Pick a time' })
const plain = (value: string | null | undefined) =>
  (value ?? '').replace(/[\u2009\u202f\u00a0]/g, ' ')

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  env.zone = 'America/New_York'
  env.now = Date.parse('2026-11-01T04:30:00Z')
})

function Navigation() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <>
      <button type="button" onClick={() => navigate(hint(NEXT))}>
        Next link
      </button>
      <button type="button" onClick={() => navigate('/ada/intro')}>
        Plain page
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Forward
      </button>
      <output data-testid="location">{location.pathname + location.search}</output>
    </>
  )
}
function navigateApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Navigation />
    </MemoryRouter>,
  )
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Your name'), 'Grace Hopper')
  await user.type(screen.getByLabelText('Email'), 'grace@example.invalid')
}

describe('public direct slot links', () => {
  it.each([
    ['personal', '/ada/intro', API, undefined, [30]],
    ['multiple durations', '/ada/intro', API, undefined, [30, 60]],
    [
      'team individual',
      '/team/alpha/intro',
      '/api/v1/public/teams/alpha/intro',
      'individual',
      [30],
    ],
    ['collective', '/team/alpha/intro', '/api/v1/public/teams/alpha/intro', 'collective', [30, 60]],
    ['round-robin', '/team/alpha/intro', '/api/v1/public/teams/alpha/intro', 'round_robin', [30]],
  ] as const)(
    'freshly checks %s with explicit length, ignores forged fields, and waits for submit',
    async (_label, page, apiPath, mode, lengths) => {
      const user = userEvent.setup()
      const minutes = lengths.length > 1 ? 60 : 30
      const api = fakeApi({
        [`GET ${apiPath}`]: () =>
          json(200, { ...EVENT, schedulingType: mode, allowedDurationsMinutes: lengths }),
        [`GET ${apiPath}/slots`]: (call) =>
          slotsAnswer([START], Number(query(call).get('durationMinutes')) || 30)(call),
        [`POST ${apiPath}/bookings`]: () =>
          json(201, { booking: booking(slot(START, minutes)), manageToken: TOKEN }),
      })
      renderApp(
        `${page}${hint(START, minutes)}&end=bad&hostId=forged&redirect=https://example.invalid&source=mcp&locale=de&timeZone=UTC`,
      )
      const heading = await selected()
      await waitFor(() => expect(document.activeElement).toBe(heading))
      expect(api.to(`GET ${apiPath}/slots`)).toHaveLength(1)
      expect(query(api.to(`GET ${apiPath}/slots`)[0] as Call).get('durationMinutes')).toBe(
        String(minutes),
      )
      expect(query(api.to(`GET ${apiPath}/slots`)[0] as Call).get('start')).toBe(START)
      expect(query(api.to(`GET ${apiPath}/slots`)[0] as Call).get('end')).toBe(
        slot(START, minutes).end,
      )
      expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
      expect(
        screen
          .getByText('The suggested time is selected. Review the details and confirm your booking.')
          .getAttribute('role'),
      ).toBe('status')
      expect(
        screen.getAllByText(/America\/New York/, { selector: '.chosen-time .muted' })[0],
      ).toBeDefined()
      await fill(user)
      await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      await screen.findByRole('heading', { name: 'You’re booked' })
      expect(api.to(`POST ${apiPath}/bookings`)[0]?.body).toMatchObject({
        start: START,
        durationMinutes: minutes,
        invitee: { timeZone: 'America/New_York' },
      })
      for (const key of ['hostId', 'end', 'source', 'redirect'])
        expect(api.to(`POST ${apiPath}/bookings`)[0]?.body).not.toHaveProperty(key)
    },
  )

  it('retains explicit singleton length when the host changes its default before final submit', async () => {
    const user = userEvent.setup()
    let changed = false
    const api = fakeApi({
      ...eventRoutes({ ...EVENT, allowedDurationsMinutes: [30] }, [START]),
      [`POST ${API}/bookings`]: ({ body }) => {
        changed = true
        // A real server rejects the removed explicit length rather than using its new default.
        return (body as { durationMinutes?: number }).durationMinutes === 30
          ? json(400, { error: 'invalid_duration' })
          : json(201, { booking: booking(slot(START, 60)) })
      },
      [`GET ${API}`]: () =>
        json(
          200,
          changed
            ? { ...EVENT, durationMinutes: 60, allowedDurationsMinutes: [60] }
            : { ...EVENT, allowedDurationsMinutes: [30] },
        ),
    })
    renderApp(`/ada/intro${hint()}`)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(REMOVED)
    expect(screen.queryByRole('heading', { name: 'You’re booked' })).toBeNull()
    expect(api.to(`POST ${API}/bookings`)[0]?.body).toHaveProperty('durationMinutes', 30)
    expect(screen.queryByLabelText('Your name')).toBeNull()
  })

  it.each(['taken', 'past', 'notice', 'window', 'grid', 'buffer', 'end-conflict', 'unreachable'])(
    'uses only the generic fallback for %s and retains a reachable date',
    async (reason) => {
      const start =
        reason === 'past'
          ? '2026-10-01T14:00:00.000Z'
          : reason === 'unreachable'
            ? '2030-06-15T14:00:00.000Z'
            : START
      const api = fakeApi({
        ...eventRoutes(EVENT, [NEXT]),
        [`GET ${API}/slots`]: (call) =>
          query(call).get('start') === start && query(call).get('end') === slot(start).end
            ? json(200, { data: reason === 'end-conflict' ? [slot(start, 15)] : [] })
            : slotsAnswer([NEXT])(call),
      })
      renderApp(`/ada/intro${hint(start)}`)
      const notice = await screen.findByText(UNAVAILABLE)
      expect(notice.getAttribute('role')).toBe('status')
      const heading = await picker()
      await waitFor(() => expect(document.activeElement).toBe(heading))
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
      if (start === START) await screen.findByRole('button', { name: '10:00 AM' })
      else expect(screen.queryByText('June 2030')).toBeNull()
    },
  )

  it('does not skip a valid offered time beyond the picker UI horizon', async () => {
    const start = '2030-06-15T14:00:00.000Z'
    fakeApi(eventRoutes(EVENT, [start]))
    renderApp(`/ada/intro${hint(start)}`)
    await selected()
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeDefined()
  })

  it('uses the safe specific duration fallback without substituting the default', async () => {
    const api = fakeApi(
      eventRoutes({ ...EVENT, durationMinutes: 60, allowedDurationsMinutes: [60] }, [START]),
    )
    renderApp(`/ada/intro${hint()}`)
    await screen.findByText(REMOVED)
    await picker()
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(api.to(`GET ${API}/slots`).some(exact)).toBe(false)
  })

  it('falls back safely for malformed input and never echoes the URL', async () => {
    fakeApi(eventRoutes(EVENT, [NEXT]))
    renderApp('/ada/intro?start=private-invalid-input&durationMinutes=30')
    await screen.findByText('We could not use the time details in this link. Please choose a time.')
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(screen.getByRole('main').textContent).not.toContain('private-invalid-input')
  })

  it.each(['initial', 'refresh', 'slots'])(
    'shows a neutral missing event page after a missing %s read',
    async (stage) => {
      let reads = 0
      fakeApi({
        ...eventRoutes(EVENT, [START]),
        [`GET ${API}`]: () =>
          ++reads >= (stage === 'initial' ? 1 : 2) && stage !== 'slots'
            ? json(404, { error: 'event_type_not_found' })
            : json(200, EVENT),
        [`GET ${API}/slots`]: () => json(404, { error: 'event_type_not_found' }),
      })
      renderApp(`/ada/intro${hint()}`)
      await screen.findByRole('heading', { name: 'This booking page doesn’t exist' })
      expect(screen.queryByText(UNAVAILABLE)).toBeNull()
    },
  )

  it.each([0, 401, 403, 429, 500, 503])(
    'keeps unknown slot errors (%s) retryable and never enables an unvalidated booking',
    async (status) => {
      const user = userEvent.setup()
      let fail = true
      fakeApi({
        ...eventRoutes(EVENT, [START]),
        [`GET ${API}/slots`]: (call) => {
          if (!fail) return slotsAnswer([START])(call)
          if (status === 0) throw new TypeError('offline')
          return json(status, {
            error: status === 503 ? 'calendar_sync_unavailable' : 'unauthorized',
          })
        },
      })
      renderApp(`/ada/intro${hint()}`)
      expect((await screen.findByText(UNKNOWN)).getAttribute('role')).toBe('status')
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      expect(screen.queryByText(UNAVAILABLE)).toBeNull()
      expect(screen.getByRole('main').textContent).not.toMatch(/setup|taken|no available/i)
      fail = false
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      await selected()
    },
  )

  it.each(['slots', 'metadata'])(
    'cancels delayed %s validation without late reselection, even after manual duration changes',
    async (stage) => {
      const user = userEvent.setup()
      const delayed = later()
      let reads = 0
      const api = fakeApi({
        ...eventRoutes({ ...EVENT, allowedDurationsMinutes: [30, 60] }, [START]),
        [`GET ${API}`]: () =>
          ++reads === 2 && stage === 'metadata'
            ? delayed.response
            : json(200, { ...EVENT, allowedDurationsMinutes: [30, 60] }),
        [`GET ${API}/slots`]: (call) =>
          exact(call) && stage === 'slots'
            ? delayed.response
            : slotsAnswer([NEXT], Number(query(call).get('durationMinutes')) || 30)(call),
      })
      renderApp(`/ada/intro${hint()}`)
      await screen.findByText('Checking the suggested time…')
      await waitFor(() =>
        expect(stage === 'slots' ? api.to(`GET ${API}/slots`).some(exact) : reads >= 2).toBe(true),
      )
      await user.click(screen.getByRole('button', { name: 'Change time' }))
      await picker()
      await user.click(screen.getByRole('radio', { name: '1 h' }))
      await delayed.answer(
        stage === 'slots' ? json(200, { data: [slot(START)] }) : json(200, EVENT),
      )
      expect(screen.queryByLabelText('Your name')).toBeNull()
      expect((screen.getByRole('radio', { name: '1 h' }) as HTMLInputElement).checked).toBe(true)
    },
  )

  it('preserves query on canonical redirects', async () => {
    fakeApi(eventRoutes(EVENT, [START]))
    renderApp(`/Ada/INTRO${hint()}`)
    await selected()
    expect(screen.getByTestId('location').textContent).toBe(`/ada/intro${hint()}`)
  })

  it('handles query-only, back/forward and plain navigation without losing drafts or reusing validation', async () => {
    const user = userEvent.setup()
    const api = fakeApi(eventRoutes(EVENT, [START, NEXT]))
    navigateApp(`/ada/intro${hint()}`)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Next link' }))
    await selected()
    await waitFor(() =>
      expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT),
    )
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await selected()
    expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(START)
    await user.click(screen.getByRole('button', { name: 'Forward' }))
    await selected()
    expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT)
    expect(api.to(`GET ${API}/slots`)).toHaveLength(4)
    await user.click(screen.getByRole('button', { name: 'Plain page' }))
    await picker()
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
  })

  it('ignores a late old query response after the new interval has selected', async () => {
    const user = userEvent.setup()
    const delayed = later()
    const api = fakeApi({
      ...eventRoutes(EVENT, [START, NEXT]),
      [`GET ${API}/slots`]: (call) =>
        exact(call) ? delayed.response : slotsAnswer([START, NEXT])(call),
    })
    navigateApp(`/ada/intro${hint()}`)
    await waitFor(() => expect(api.to(`GET ${API}/slots`).some(exact)).toBe(true))
    await user.click(screen.getByRole('button', { name: 'Next link' }))
    await selected()
    await user.type(screen.getByLabelText('Your name'), 'Draft')
    await delayed.answer(json(200, { data: [slot(START)] }))
    expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT)
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Draft')
    expect(document.activeElement).toBe(screen.getByLabelText('Your name'))
  })

  it('invalidates the initial event read on query navigation, including a late missing-event response', async () => {
    const user = userEvent.setup()
    const delayed = later()
    let reads = 0
    fakeApi({
      ...eventRoutes(EVENT, [START, NEXT]),
      [`GET ${API}`]: () => (++reads === 1 ? delayed.response : json(200, EVENT)),
    })
    navigateApp(`/ada/intro${hint()}`)
    await waitFor(() => expect(reads).toBe(1))
    await user.click(screen.getByRole('button', { name: 'Next link' }))
    await selected()
    await delayed.answer(json(404, { error: 'event_type_not_found' }))
    expect(document.querySelector('.chosen-time time')?.getAttribute('datetime')).toBe(NEXT)
    expect(screen.queryByRole('heading', { name: 'This booking page doesn’t exist' })).toBeNull()
  })

  it.each([401, 403, 429, 500])(
    'keeps initial metadata error %s neutral and retryable',
    async (status) => {
      const user = userEvent.setup()
      let fail = true
      fakeApi({
        ...eventRoutes(EVENT, [START]),
        [`GET ${API}`]: () =>
          fail
            ? json(status, { error: 'unauthorized', message: 'private diagnostic' })
            : json(200, EVENT),
      })
      renderApp(`/ada/intro${hint()}`)
      expect((await screen.findByText(UNKNOWN)).getAttribute('role')).toBe('status')
      expect(screen.getByRole('main').textContent).not.toContain('private diagnostic')
      fail = false
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      await selected()
    },
  )

  it('keeps all form drafts and manual choices after Change time and a generic submit race', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...eventRoutes(
        { ...EVENT, questions: ALL_QUESTIONS.slice(0, 1), allowedDurationsMinutes: [30, 60] },
        [START, NEXT],
      ),
      [`POST ${API}/bookings`]: () => json(409, { error: 'slot_taken' }),
    })
    renderApp(`/ada/intro${hint()}`)
    await fill(user)
    await user.type(screen.getByLabelText('Topic'), 'Compilers')
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    await user.type(screen.getByLabelText('Guest 1 name'), 'Guest')
    await user.type(screen.getByLabelText('Guest 1 email'), 'guest@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Change time' }))
    await picker()
    await user.click(await screen.findByRole('button', { name: '10:00 AM' }))
    expect((screen.getByLabelText('Topic') as HTMLInputElement).value).toBe('Compilers')
    expect((screen.getByLabelText('Guest 1 email') as HTMLInputElement).value).toBe(
      'guest@example.invalid',
    )
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(UNAVAILABLE)
    expect(screen.queryByText(/Someone else just booked/)).toBeNull()
    await user.click(await screen.findByRole('button', { name: '9:00 AM' }))
    expect((screen.getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper')
    expect(api.to(`POST ${API}/bookings`)).toHaveLength(1)
  })

  it('keeps lost-response idempotency retries on the same request', async () => {
    const user = userEvent.setup()
    let requests = 0
    const api = fakeApi({
      ...eventRoutes(EVENT, [START]),
      [`POST ${API}/bookings`]: () =>
        ++requests === 1
          ? Promise.reject(new TypeError('lost'))
          : json(200, { booking: booking(), manageToken: null }),
    })
    renderApp(`/ada/intro${hint()}`)
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByText(/Your booking is not confirmed yet/)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    const calls = api.to(`POST ${API}/bookings`)
    expect(calls[1]?.body).toEqual(calls[0]?.body)
    expect(calls[1]?.headers.get('idempotency-key')).toBe(calls[0]?.headers.get('idempotency-key'))
  })

  it.each([
    [
      '2027-03-14T06:30:00.000Z',
      'America/New_York',
      'GMT-05:00',
      'GMT-04:00',
      'Sunday, March 14, 2027',
    ],
    [
      '2027-11-07T05:30:00.000Z',
      'America/New_York',
      'GMT-04:00',
      'GMT-05:00',
      'Sunday, November 7, 2027',
    ],
    [
      '2027-03-28T00:30:00.000Z',
      'Europe/Berlin',
      'GMT+01:00',
      'GMT+02:00',
      'Sunday, March 28, 2027',
    ],
    [
      '2027-10-31T00:30:00.000Z',
      'Europe/Berlin',
      'GMT+02:00',
      'GMT+01:00',
      'Sunday, October 31, 2027',
    ],
    [
      '2027-06-15T14:30:00.000Z',
      'Asia/Tokyo',
      'GMT+09:00',
      'GMT+09:00',
      'Wednesday, June 16, 2027',
    ],
  ])(
    'displays both endpoint dates and offsets for %s in the invitee zone',
    async (start, zone, firstOffset, endOffset, endDate) => {
      env.zone = zone
      fakeApi(
        eventRoutes({ ...EVENT, durationMinutes: 60, allowedDurationsMinutes: [60] }, [start]),
      )
      renderApp(`/ada/intro${hint(start, 60)}`)
      await selected()
      const labels = document.querySelectorAll('.chosen-time time')
      expect(labels).toHaveLength(2)
      expect(plain(labels[1]?.textContent)).toContain(endDate)
      expect(labels[0]?.nextElementSibling?.textContent).toContain(firstOffset)
      expect(labels[1]?.nextElementSibling?.textContent).toContain(endOffset)
      expect(labels[1]?.getAttribute('datetime')).toBe(slot(start, 60).end)
      await userEvent.setup().click(screen.getByRole('button', { name: 'Change time' }))
      await picker()
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(start))
      expect(
        document.querySelector(`[data-day="${day}"]`)?.parentElement?.getAttribute('aria-selected'),
      ).toBe('true')
    },
  )

  it('preserves the invitee’s saved zone and language instead of consuming query hints', async () => {
    localStorage.setItem('hourmere-visitor-time-zone', 'Asia/Tokyo')
    chooseLanguage('zh-CN')
    fakeApi(eventRoutes(EVENT, [START]))
    renderApp(`/ada/intro${hint()}&locale=de&timeZone=UTC`)
    await screen.findByRole('heading', { name: '你的信息' })
    expect(document.querySelector('.chosen-time')?.textContent).toContain('Asia/Tokyo')
    expect(localStorage.getItem('hourmere-visitor-time-zone')).toBe('Asia/Tokyo')
  })

  it.each(['/embed/ada/intro', '/embed/team/alpha/intro'])(
    'ignores direct hints on %s',
    async (path) => {
      const base = path.includes('/team/') ? '/api/v1/public/teams/alpha/intro' : API
      const api = fakeApi({
        [`GET ${base}`]: () => json(200, EVENT),
        [`GET ${base}/slots`]: slotsAnswer([START]),
      })
      renderApp(`${path}${hint()}`)
      await picker()
      await screen.findByRole('button', { name: /November 2, available/ })
      expect(screen.queryByLabelText('Your name')).toBeNull()
      expect(api.to(`GET ${base}/slots`).some(exact)).toBe(false)
    },
  )

  it('ignores direct hints on one-time routes without resolving the ordinary address', async () => {
    const token = 'x'.repeat(43)
    const api = fakeApi({
      [`GET /api/v1/book/${token}`]: () =>
        json(200, { eventType: EVENT, prefill: { name: null, email: null } }),
      [`GET /api/v1/book/${token}/slots`]: slotsAnswer([START]),
    })
    renderApp(`/book/${token}${hint()}`)
    await picker()
    await screen.findByRole('button', { name: /November 2, available/ })
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(api.calls.some((call) => call.path.startsWith(API))).toBe(false)
  })

  it('preserves the existing waitlist suggestion and ignores appended direct hints', async () => {
    const token = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
    const api = fakeApi(eventRoutes(EVENT, [START, NEXT]))
    renderApp(
      `/ada/intro/waitlist/${token}/${encodeURIComponent(START)}/${env.now + 86400000}${hint(NEXT, 60)}`,
    )
    await selected()
    expect(document.querySelector('.chosen-time')?.textContent).toContain('9:00')
    expect(api.to(`GET ${API}/slots`)).toHaveLength(1)
    expect(query(api.to(`GET ${API}/slots`)[0] as Call).get('start')).toBe(START)
    expect(query(api.to(`GET ${API}/slots`)[0] as Call).has('durationMinutes')).toBe(false)
  })

  it('keeps malformed waitlist routes excluded through canonical redirects', async () => {
    const api = fakeApi(eventRoutes(EVENT, [START]))
    renderApp(`/Ada/INTRO/waitlist/bad/${encodeURIComponent(START)}/0${hint()}`)
    await picker()
    await screen.findByRole('button', { name: /November 2, available/ })
    expect(screen.getByTestId('location').textContent).toContain('/ada/intro/waitlist/bad/')
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(api.to(`GET ${API}/slots`).some(exact)).toBe(false)
  })
})
