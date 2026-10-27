import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import {
  booking,
  EVENT,
  eventRoutes,
  managed,
  slotsAnswer,
  TOKEN,
} from '../test/public-fixtures.ts'

const env = vi.hoisted(() => ({
  zone: 'Asia/Shanghai',
  now: Date.parse('2026-11-01T04:30:00Z'),
}))
vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => env.zone,
  preferredLocale: () => 'en-US',
  now: () => env.now,
}))

const START = '2026-11-11T00:00:00Z'
const EVENT_IN_LA = { ...EVENT, host: { ...EVENT.host, timeZone: 'America/Los_Angeles' } }
const STORAGE_KEY = 'hourmere-visitor-time-zone'
const plain = (value: string | null | undefined) =>
  (value ?? '').replace(/[\u2009\u202f\u00a0]/g, ' ')

beforeEach(() => {
  env.zone = 'Asia/Shanghai'
  window.history.replaceState(null, '', '/')
})

async function chooseDay(user: ReturnType<typeof userEvent.setup>, date: string) {
  const button = await waitFor(() => {
    const day = document.querySelector<HTMLButtonElement>(`[data-day="${date}"]`)
    expect(day?.disabled).toBe(false)
    return day as HTMLButtonElement
  })
  await user.click(button)
}

async function pickZone(user: ReturnType<typeof userEvent.setup>, zone: string) {
  await user.click(screen.getByRole('button', { name: /Time zone/ }))
  await user.type(screen.getByRole('combobox', { name: 'Search time zones' }), zone)
  await user.click(within(screen.getByRole('listbox', { name: 'Time zones' })).getByRole('option'))
}

function hostZoneLabel() {
  return screen.findByText((_, element) => element?.classList.contains('host-time-zone') ?? false)
}

describe('cross-zone public booking details', () => {
  it.each([
    ['/ada/intro', 'en'],
    ['/embed/ada/intro', 'en'],
    ['/ada/intro', 'zh-CN'],
    ['/embed/ada/intro', 'zh-CN'],
  ])(
    'shows the profile zone and the same instant on the host’s local date on %s in %s',
    async (path, language) => {
      const user = userEvent.setup()
      localStorage.setItem('hourmere-language', language)
      fakeApi(eventRoutes(EVENT_IN_LA, [START]))
      renderApp(`${path}?language=${language}`)
      const chinese = language === 'zh-CN'
      const zone = await hostZoneLabel()
      expect(zone.firstElementChild?.textContent).toBe('America')
      expect(zone.querySelectorAll('wbr')).toHaveLength(1)
      expect(zone.querySelector('wbr')?.previousSibling?.textContent).toBe('/')
      expect(zone.lastElementChild?.textContent).toBe('Los Angeles')
      expect(zone.lastElementChild?.classList.contains('time-zone-segment')).toBe(true)
      await chooseDay(user, '2026-11-11')
      await user.click(screen.getByRole('button', { name: chinese ? '08:00' : '8:00 AM' }))
      if (chinese) {
        expect(zone.textContent).toMatchInlineSnapshot('"主持人的时区：America/Los Angeles"')
        expect(document.querySelector('.host-local-time')?.textContent).toMatchInlineSnapshot(
          '"主持人当地时间为 2026年11月10日星期二，16:00"',
        )
      } else {
        expect(zone.textContent).toMatchInlineSnapshot(`"Host's time zone: America/Los Angeles"`)
        expect(
          plain(document.querySelector('.host-local-time')?.textContent),
        ).toMatchInlineSnapshot(`"That's Tuesday, November 10, 2026, 4:00 PM for the host"`)
      }
      expect(document.querySelector('.host-local-time')?.classList.contains('user-content')).toBe(
        true,
      )
    },
  )

  it('shows the single host profile zone on an individual team page', async () => {
    fakeApi({
      'GET /api/v1/public/teams/crew/intro': () =>
        json(200, { ...EVENT_IN_LA, team: { name: 'Crew', slug: 'crew' } }),
      'GET /api/v1/public/teams/crew/intro/slots': slotsAnswer([START]),
    })
    renderApp('/team/crew/intro')
    expect((await hostZoneLabel()).textContent).toBe("Host's time zone: America/Los Angeles")
  })

  it('does not repeat the chosen time when the visitor and host share a zone', async () => {
    const user = userEvent.setup()
    env.zone = 'America/Los_Angeles'
    fakeApi(eventRoutes(EVENT_IN_LA, [START]))
    renderApp('/ada/intro')
    await hostZoneLabel()
    await chooseDay(user, '2026-11-10')
    await user.click(screen.getByRole('button', { name: '4:00 PM' }))
    expect(document.querySelector('.host-local-time')).toBeNull()
  })

  it.each([
    ['US/Pacific', 'America/Los_Angeles'],
    ['America/Los_Angeles', 'US/Pacific'],
  ])('does not repeat the host time for aliases %s and %s', async (visitorZone, hostZone) => {
    const user = userEvent.setup()
    env.zone = visitorZone
    fakeApi(
      eventRoutes({ ...EVENT_IN_LA, host: { ...EVENT_IN_LA.host, timeZone: hostZone } }, [START]),
    )
    renderApp('/ada/intro')
    await hostZoneLabel()
    await chooseDay(user, '2026-11-10')
    await user.click(screen.getByRole('button', { name: '4:00 PM' }))
    expect(screen.getByRole('heading', { name: 'Your details' })).toBeDefined()
    expect(document.querySelector('.host-local-time')).toBeNull()
  })

  it('keeps the details form usable when the host profile has an unknown zone', async () => {
    const user = userEvent.setup()
    fakeApi(
      eventRoutes({ ...EVENT_IN_LA, host: { ...EVENT_IN_LA.host, timeZone: 'Future/Unknown' } }, [
        START,
      ]),
    )
    renderApp('/ada/intro')
    expect((await hostZoneLabel()).textContent).toBe("Host's time zone: Future/Unknown")
    await chooseDay(user, '2026-11-11')
    await user.click(screen.getByRole('button', { name: '8:00 AM' }))
    expect(screen.getByRole('heading', { name: 'Your details' })).toBeDefined()
    expect(screen.getByLabelText('Your name')).toBeDefined()
    expect(document.querySelector('.host-local-time')).toBeNull()
  })

  it('lists collective host display names without inventing a single host’s zone or time', async () => {
    const user = userEvent.setup()
    fakeApi(
      eventRoutes(
        {
          ...EVENT_IN_LA,
          hosts: [
            { name: 'Ada', timeZone: 'America/Los_Angeles' },
            { name: 'Grace', timeZone: 'America/New_York' },
          ],
        },
        [START],
      ),
    )
    renderApp('/ada/intro')
    const required = await screen.findByText(/^Required hosts:/)
    expect(required.textContent).toMatchInlineSnapshot(
      '"Required hosts: Ada (America/Los Angeles), Grace (America/New York)"',
    )
    expect(screen.queryByText(/^Host's time zone:/)).toBeNull()
    await chooseDay(user, '2026-11-11')
    await user.click(screen.getByRole('button', { name: '8:00 AM' }))
    expect(document.querySelector('.host-local-time')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(required.textContent).toMatchInlineSnapshot(
      '"必选主持人：Ada（America/Los Angeles）、Grace（America/New York）"',
    )
  })

  it('waits for a round-robin assignment and displays its zone without underscores', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...eventRoutes({ ...EVENT_IN_LA, schedulingType: 'round_robin' }, [START]),
      'POST /api/v1/public/ada/intro/bookings': () =>
        json(201, {
          booking: booking({ assignedHost: { name: 'Grace', timeZone: 'America/New_York' } }),
          manageToken: TOKEN,
        }),
    })
    renderApp('/ada/intro')
    await screen.findByText('An available team member will be assigned when you book.')
    expect(screen.queryByText(/^Host's time zone:/)).toBeNull()
    await chooseDay(user, '2026-11-11')
    await user.click(screen.getByRole('button', { name: '8:00 AM' }))
    expect(document.querySelector('.host-local-time')).toBeNull()
    await user.type(screen.getByLabelText('Your name'), 'Invitee')
    await user.type(screen.getByLabelText('Email'), 'invitee@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    await screen.findByRole('heading', { name: 'You’re booked' })
    expect(screen.getByText('Grace (America/New York)').textContent).toMatchInlineSnapshot(
      '"Grace (America/New York)"',
    )
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByText('Grace（America/New York）').textContent).toMatchInlineSnapshot(
      '"Grace（America/New York）"',
    )
  })
})

describe('remembering explicit visitor zone choices', () => {
  it('remembers an explicit booking pick for the next visit and keeps the browser zone in the common group', async () => {
    const user = userEvent.setup()
    env.zone = 'Pacific/Honolulu'
    fakeApi(eventRoutes(EVENT_IN_LA, [START]))
    const first = renderApp('/ada/intro')
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'Pacific/Honolulu',
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    await pickZone(user, 'America/New York')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('America/New_York')
    first.unmount()
    renderApp('/ada/intro')
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'America/New York',
    )
    await user.click(screen.getByRole('button', { name: /Time zone/ }))
    const common = screen.getByRole('group', { name: 'Current and common time zones' })
    expect(
      within(common)
        .getAllByRole('option')
        .slice(0, 2)
        .map((option) => option.textContent),
    ).toMatchInlineSnapshot(`
      [
        "America/New YorkGMT-05:00",
        "Pacific/HonoluluGMT-10:00",
      ]
    `)
    expect(within(common).getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps a browser zone alias available when a different explicit choice is remembered', async () => {
    const user = userEvent.setup()
    env.zone = 'US/Eastern'
    localStorage.setItem(STORAGE_KEY, 'Pacific/Honolulu')
    fakeApi(eventRoutes(EVENT_IN_LA, [START]))
    renderApp('/ada/intro')
    await user.click(await screen.findByRole('button', { name: /Time zone/ }))
    const common = screen.getByRole('group', { name: 'Current and common time zones' })
    expect(within(common).getByRole('option', { name: /US\/Eastern/ })).toBeDefined()
    expect(within(common).getAllByRole('option')[0]?.textContent).toContain('Pacific/Honolulu')
  })

  it('retains the booking zone as the manage default when no explicit choice is remembered', async () => {
    fakeApi({
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer([START]),
    })
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'America/New York',
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('starts rescheduling in the booking zone and retains a new pick for the current view and future booking pages', async () => {
    const user = userEvent.setup()
    localStorage.setItem(STORAGE_KEY, 'Pacific/Honolulu')
    fakeApi({
      ...eventRoutes(EVENT_IN_LA, [START]),
      'GET /api/v1/bookings/manage': () => json(200, managed()),
      'GET /api/v1/bookings/manage/slots': slotsAnswer([START]),
    })
    const manage = renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'America/New York',
    )
    await pickZone(user, 'Europe/Paris')
    expect(screen.getByRole('button', { name: /Time zone/ }).textContent).toContain('Europe/Paris')
    await user.click(screen.getByRole('button', { name: 'Keep the current time' }))
    expect(screen.getByText(/Monday, November 2, 2026/).parentElement?.textContent).toContain(
      'Europe/Paris',
    )
    await user.click(screen.getByRole('button', { name: 'Reschedule' }))
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'Europe/Paris',
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe('Europe/Paris')
    manage.unmount()
    renderApp('/ada/intro')
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'Europe/Paris',
    )
  })

  it('loads each managed booking in its stored zone after a pick on another managed booking', async () => {
    const user = userEvent.setup()
    let timeZone = 'America/New_York'
    fakeApi({
      'GET /api/v1/bookings/manage': () =>
        json(
          200,
          managed({
            attendees: [
              {
                name: 'Grace Hopper',
                email: 'grace@example.com',
                timeZone,
                locale: 'en-US',
                isBooker: true,
              },
            ],
          }),
        ),
      'GET /api/v1/bookings/manage/slots': slotsAnswer([START]),
    })
    const first = renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    await screen.findByRole('button', { name: /Time zone/ })
    await pickZone(user, 'Europe/Paris')
    first.unmount()
    timeZone = 'Asia/Tokyo'
    renderApp(`/booking#token=${TOKEN}&action=reschedule`)
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'Asia/Tokyo',
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe('Europe/Paris')
  })

  it.each(['not/a-zone', '+08:00'])(
    'ignores invalid stored preference %s without persisting detection',
    async (zone) => {
      localStorage.setItem(STORAGE_KEY, zone)
      fakeApi(eventRoutes(EVENT_IN_LA, [START]))
      renderApp('/ada/intro')
      expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
        'Asia/Shanghai',
      )
      expect(localStorage.getItem(STORAGE_KEY)).toBe(zone)
    },
  )

  it('continues to pick a zone when storage reads and writes are blocked', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    fakeApi(eventRoutes(EVENT_IN_LA, [START]))
    renderApp('/ada/intro')
    expect((await screen.findByRole('button', { name: /Time zone/ })).textContent).toContain(
      'Asia/Shanghai',
    )
    await pickZone(user, 'Pacific/Honolulu')
    expect(screen.getByRole('button', { name: /Time zone/ }).textContent).toContain(
      'Pacific/Honolulu',
    )
  })
})
