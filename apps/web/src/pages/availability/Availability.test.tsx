import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schedule } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { browserLocale } from '../../test/browser-locale.ts'
import {
  fakeApi,
  json,
  later,
  profile,
  type Routes,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'
import { OTHER_SCHEDULE_ID, SCHEDULE_ID, schedule } from '../../test/fixtures.ts'
import { todayIn } from './weekly-hours.ts'

const location = () => screen.getByTestId('location').textContent
const input = (name: string) => screen.getByLabelText<HTMLInputElement>(name)
const NEW_ID = 'c0000000-0000-7000-8000-000000000009'

type Override = { date: string; intervals: { start: string; end: string }[] }

/** The schedule endpoints over in-memory schedules and overrides. */
function scheduleServer(
  initial: Schedule[] = [schedule()],
  { overrides: initialOverrides = [] as Override[], extra = {} as Routes } = {},
) {
  let list = [...initial]
  let overrides = [...initialOverrides]
  const one = (id: string): Routes => ({
    [`GET /api/v1/schedules/${id}`]: () => {
      const found = list.find((s) => s.id === id)
      return found ? json(200, found) : json(404, { error: 'schedule_not_found' })
    },
    [`PATCH /api/v1/schedules/${id}`]: ({ body }) => {
      const change = body as Partial<Schedule>
      list = list.map((s) =>
        s.id === id ? { ...s, ...change } : change.isDefault ? { ...s, isDefault: false } : s,
      )
      return json(
        200,
        list.find((s) => s.id === id),
      )
    },
    [`DELETE /api/v1/schedules/${id}`]: () => {
      list = list.filter((s) => s.id !== id)
      return new Response(null, { status: 204 })
    },
    [`GET /api/v1/schedules/${id}/overrides`]: () => json(200, { data: overrides }),
  })
  const api = fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: list }),
    'POST /api/v1/schedules': ({ body }) => {
      const input = body as Schedule
      const created = schedule({
        ...input,
        id: NEW_ID,
        isDefault: list.length === 0 || Boolean(input.isDefault),
      })
      list = [...list, created]
      return json(201, created)
    },
    ...one(SCHEDULE_ID),
    ...one(OTHER_SCHEDULE_ID),
    ...one(NEW_ID),
    ...extra,
  })
  return {
    ...api,
    setOverrides: (next: Override[]) => {
      overrides = next
    },
  }
}

const evenings = schedule({
  id: OTHER_SCHEDULE_ID,
  name: 'Evenings',
  timeZone: 'America/New_York',
  isDefault: false,
  weeklyHours: {
    monday: [{ start: '18:00', end: '21:00' }],
    saturday: [{ start: '10:00', end: '12:00' }],
  },
})

describe('the availability page', () => {
  it('lists schedules with their hours, the default first marked', async () => {
    scheduleServer([schedule(), evenings])
    renderApp('/app/availability')
    const list = await screen.findByRole('region', { name: 'Your schedules' })
    const items = within(list).getAllByRole('listitem')
    const [work, eve] = items.map((li) => within(li))
    expect(work?.getByRole('heading').textContent).toBe('Working hoursDefault')
    expect(work?.getByText('Mon–Fri 09:00–17:00')).toBeDefined()
    expect(work?.getByText('Europe/Berlin')).toBeDefined()
    expect(work?.queryByRole('button', { name: /Make default/ })).toBeNull()
    expect(eve?.getByText('Mon 18:00–21:00 · Sat 10:00–12:00')).toBeDefined()
    expect(eve?.getByText('America/New York')).toBeDefined()
  })

  it('makes another schedule the default', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule(), evenings])
    renderApp('/app/availability')
    await user.click(await screen.findByRole('button', { name: 'Make default: Evenings' }))
    expect(await screen.findByText('“Evenings” is now your default schedule.')).toBeDefined()
    expect(api.to(`PATCH /api/v1/schedules/${OTHER_SCHEDULE_ID}`).map((c) => c.body)).toEqual([
      { isDefault: true },
    ])
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Edit Evenings' }))
    await screen.findByRole('button', { name: 'Make default: Working hours' })
  })

  it('starts people without a schedule on their working hours', async () => {
    scheduleServer([])
    renderApp('/app/availability')
    expect(await screen.findByText(/You have no schedule yet/)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Set your weekly hours' }).getAttribute('href')).toBe(
      '/app/availability/new',
    )
    expect(
      screen.getByRole('link', { name: 'Set your weekly hours' }).classList.contains('button'),
    ).toBe(true)
  })
})

describe('creating a schedule', () => {
  it('starts from 9 to 5 on weekdays in the profile’s zone, and saves the week', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([])
    renderApp('/app/availability/new')
    await screen.findByRole('heading', { name: 'New schedule', level: 1 })
    expect(screen.getByText('Your first schedule is your default schedule.')).toBeDefined()
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Time zone' }).value).toBe(
      'Europe/Berlin',
    )
    expect(input('Monday, hours 1, from').value).toBe('09:00')
    expect(input('Friday, hours 1, until').value).toBe('17:00')
    expect(screen.getByRole('checkbox', { name: 'Saturday' })).toHaveProperty('checked', false)

    await user.clear(input('Name'))
    await user.type(input('Name'), 'Office')
    await user.click(screen.getByRole('button', { name: 'Add hours on Monday' }))
    expect(document.activeElement).toBe(input('Monday, hours 2, from'))
    expect(input('Monday, hours 2, from').value).toBe('18:00')
    // An end of 00:00 is midnight at the end of the day.
    fireEvent.change(input('Monday, hours 2, until'), { target: { value: '00:00' } })
    await user.click(screen.getByRole('checkbox', { name: 'Saturday' }))
    fireEvent.change(input('Saturday, hours 1, from'), { target: { value: '10:00' } })
    fireEvent.change(input('Saturday, hours 1, until'), { target: { value: '12:30' } })
    await user.click(screen.getByRole('checkbox', { name: 'Friday' }))
    await user.click(screen.getByRole('button', { name: 'Remove Tuesday, hours 1' }))
    expect(screen.getAllByText('No hours: unavailable.')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    expect(await screen.findByRole('heading', { name: 'Edit “Office”', level: 1 })).toBeDefined()
    expect(location()).toBe(`/app/availability/${NEW_ID}`)
    expect(screen.getByText('Created “Office”.')).toBeDefined()
    const nine = [{ start: '09:00', end: '17:00' }]
    expect(api.to('POST /api/v1/schedules').map((c) => c.body)).toEqual([
      {
        name: 'Office',
        timeZone: 'Europe/Berlin',
        weeklyHours: {
          monday: [...nine, { start: '18:00', end: '24:00' }],
          tuesday: [],
          wednesday: nine,
          thursday: nine,
          friday: [],
          saturday: [{ start: '10:00', end: '12:30' }],
          sunday: [],
        },
      },
    ])
  })

  it('can make a further schedule the default', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()])
    renderApp('/app/availability/new')
    await user.click(await screen.findByRole('checkbox', { name: 'Make this my default schedule' }))
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await screen.findByText('Created “Working hours”.')
    expect(api.to('POST /api/v1/schedules')[0]?.body).toMatchObject({ isDefault: true })
  })

  it('refuses overlapping hours and hours that end before they start', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([])
    renderApp('/app/availability/new')
    await screen.findByRole('heading', { name: 'New schedule', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Add hours on Monday' }))
    fireEvent.change(input('Monday, hours 2, from'), { target: { value: '16:00' } })
    fireEvent.change(input('Monday, hours 2, until'), { target: { value: '19:00' } })
    fireEvent.change(input('Wednesday, hours 1, until'), { target: { value: '08:00' } })
    fireEvent.change(input('Thursday, hours 1, from'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))

    const summary = await screen.findByRole('alert')
    expect(document.activeElement).toBe(summary)
    expect(
      within(summary)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Monday: These hours overlap: 09:00–17:00 and 16:00–19:00.',
      'Wednesday, hours 1, until: End after the start time.',
      'Thursday, hours 1, from: Enter a start time.',
    ])
    // The overlap is described on both of Monday's ranges.
    for (const name of ['Monday, hours 1, from', 'Monday, hours 2, until']) {
      expect(input(name).getAttribute('aria-invalid')).toBe('true')
      expect(input(name).getAttribute('aria-describedby')).toContain('day-monday-error')
    }
    expect(api.to('POST /api/v1/schedules')).toHaveLength(0)

    // Touching ranges are fine (the server joins them).
    fireEvent.change(input('Monday, hours 2, from'), { target: { value: '17:00' } })
    fireEvent.change(input('Wednesday, hours 1, until'), { target: { value: '17:00' } })
    fireEvent.change(input('Thursday, hours 1, from'), { target: { value: '09:00' } })
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    await screen.findByText('Created “Working hours”.')
  })

  it('refuses a time zone that is not in the list', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([])
    renderApp('/app/availability/new')
    const zone = await screen.findByRole('combobox', { name: 'Time zone' })
    await user.clear(zone)
    await user.type(zone, 'Mars/Olympus')
    await user.click(screen.getByRole('button', { name: 'Create schedule' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Time zone: Choose a time zone from the list, e.g. Europe/Berlin.',
    )
    expect(api.to('POST /api/v1/schedules')).toHaveLength(0)
  })

  it.each([
    [
      json(400, {
        error: 'invalid_weekly_hours',
        message: 'weeklyHours.tuesday has overlapping intervals 09:00–12:00 and 11:00–13:00',
      }),
      'Tuesday',
      'These hours overlap: 09:00–12:00 and 11:00–13:00.',
    ],
    [
      json(400, {
        error: 'invalid_time_zone',
        message: 'timeZone is not a known IANA time zone: "Europe/Berlin"',
      }),
      'Time zone',
      'This is not a time zone the server knows. Choose one from the list.',
    ],
    [
      json(400, {
        error: 'invalid_schedule',
        message: 'name must be one line of 1–100 characters',
      }),
      'Name',
      'Use one line of up to 100 characters.',
    ],
  ])('shows the server refusing it at the field (%#)', async (response, label, message) => {
    const user = userEvent.setup()
    scheduleServer([], { extra: { 'POST /api/v1/schedules': () => response } })
    renderApp('/app/availability/new')
    await user.click(await screen.findByRole('button', { name: 'Create schedule' }))
    const summary = await screen.findByRole('alert')
    expect(within(summary).getByRole('link').textContent).toBe(`${label}: ${message}`)
  })
})

describe('editing a schedule', () => {
  it('saves changed hours and time zone', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule(), evenings])
    renderApp(`/app/availability/${OTHER_SCHEDULE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Evenings”', level: 1 })
    expect(screen.getByRole('checkbox', { name: 'Tuesday' })).toHaveProperty('checked', false)
    const zone = screen.getByRole('combobox', { name: 'Time zone' })
    await user.clear(zone)
    await user.type(zone, 'tokyo')
    await user.keyboard('{Enter}')
    expect((zone as HTMLInputElement).value).toBe('Asia/Tokyo')
    fireEvent.change(input('Monday, hours 1, until'), { target: { value: '22:00' } })
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Saved.')).toBeDefined()
    expect(api.to(`PATCH /api/v1/schedules/${OTHER_SCHEDULE_ID}`).map((c) => c.body)).toEqual([
      {
        name: 'Evenings',
        timeZone: 'Asia/Tokyo',
        weeklyHours: {
          monday: [{ start: '18:00', end: '22:00' }],
          tuesday: [],
          wednesday: [],
          thursday: [],
          friday: [],
          saturday: [{ start: '10:00', end: '12:00' }],
          sunday: [],
        },
      },
    ])
  })

  it('shows an end of the day as 00:00 and keeps it at 24:00', async () => {
    const user = userEvent.setup()
    const late = schedule({ weeklyHours: { sunday: [{ start: '20:00', end: '24:00' }] } })
    const api = scheduleServer([late])
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    expect((await screen.findByLabelText<HTMLInputElement>('Sunday, hours 1, until')).value).toBe(
      '00:00',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/schedules/${SCHEDULE_ID}`)[0]?.body).toMatchObject({
      weeklyHours: { sunday: [{ start: '20:00', end: '24:00' }], monday: [] },
    })
  })

  it('makes it the default from its page', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule(), evenings])
    renderApp(`/app/availability/${OTHER_SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Make default' }))
    expect(await screen.findByText('“Evenings” is now your default schedule.')).toBeDefined()
    expect(api.to(`PATCH /api/v1/schedules/${OTHER_SCHEDULE_ID}`)[0]?.body).toEqual({
      isDefault: true,
    })
    expect(screen.getByText(/Event types use this schedule unless/)).toBeDefined()
  })

  it('says when the schedule does not exist', async () => {
    scheduleServer([])
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    expect(await screen.findByRole('heading', { name: 'Schedule not found' })).toBeDefined()
  })
})

describe('deleting a schedule', () => {
  it('keeps the default while there are others, as the API requires', async () => {
    scheduleServer([schedule(), evenings])
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await screen.findByRole('region', { name: 'Delete this schedule' })
    expect(within(section).queryByRole('button')).toBeNull()
    expect(section.textContent).toContain('first make another schedule the default')
  })

  it('deletes another schedule after confirmation', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule(), evenings])
    renderApp(`/app/availability/${OTHER_SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Delete schedule' }))
    await user.click(
      within(screen.getByRole('group', { name: /Delete “Evenings”/ })).getByRole('button', {
        name: 'Delete schedule',
      }),
    )
    expect(await screen.findByText('Deleted “Evenings”.')).toBeDefined()
    expect(location()).toBe('/app/availability')
    expect(api.to(`DELETE /api/v1/schedules/${OTHER_SCHEDULE_ID}`)).toHaveLength(1)
  })

  it('deletes the last schedule, warning what that means', async () => {
    const user = userEvent.setup()
    scheduleServer([schedule()])
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await screen.findByRole('region', { name: 'Delete this schedule' })
    expect(section.textContent).toContain('without it, your event types offer no times')
    await user.click(within(section).getByRole('button', { name: 'Delete schedule' }))
    await user.click(within(section).getByRole('button', { name: 'Delete schedule' }))
    expect(await screen.findByText(/You have no schedule yet/)).toBeDefined()
  })

  it('shows the API refusing to delete the default', async () => {
    const user = userEvent.setup()
    scheduleServer([schedule()], {
      extra: {
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}`]: () =>
          json(409, {
            error: 'schedule_is_default',
            message: 'Make another schedule the default before deleting this one',
          }),
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await screen.findByRole('region', { name: 'Delete this schedule' })
    await user.click(within(section).getByRole('button', { name: 'Delete schedule' }))
    await user.click(within(section).getByRole('button', { name: 'Delete schedule' }))
    expect((await within(section).findByRole('alert')).textContent).toBe(
      'Could not delete the schedule. Make another schedule the default before deleting this one',
    )
    expect(location()).toBe(`/app/availability/${SCHEDULE_ID}`)
  })
})

describe('date overrides', () => {
  it.each(['fa-IR', 'th-TH'])(
    'uses Gregorian override labels and notices for browser locale %s',
    async (locale) => {
      browserLocale(locale)
      const user = userEvent.setup()
      scheduleServer([schedule()], {
        overrides: [{ date: '2030-12-24', intervals: [] }],
        extra: {
          [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () =>
            new Response(null, { status: 204 }),
        },
      })
      renderApp(`/app/availability/${SCHEDULE_ID}`)
      const date = new Intl.DateTimeFormat(locale, {
        calendar: 'gregory',
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date('2030-12-24T00:00:00Z'))
      const section = await screen.findByRole('region', { name: 'Date overrides' })
      await within(section).findByText(date)
      await user.click(within(section).getByRole('button', { name: `Remove override: ${date}` }))
      await user.click(within(section).getByRole('button', { name: 'Save removals' }))
      expect(await within(section).findByText(`Removed the override for ${date}.`)).toBeDefined()
    },
  )

  const overridesSection = () => screen.findByRole('region', { name: 'Date overrides' })

  it.each([
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ])(
    'protects override hours without a date (cleared: %s, hidden: %s, edited: %s)',
    async (clearDate, hideHours, editHours) => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const api = scheduleServer([schedule()], {
        extra: {
          [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: ({ body }) =>
            json(201, { date: '2030-12-24', ...(body as object) }),
        },
      })
      renderApp(`/app/availability/${SCHEDULE_ID}`)
      const section = await overridesSection()
      await within(section).findByText('No upcoming date overrides.')
      await user.click(within(section).getByRole('radio', { name: 'Other hours' }))
      if (editHours) {
        fireEvent.change(within(section).getByLabelText('That date, hours 1, until'), {
          target: { value: '12:00' },
        })
      }
      const date = within(section).getByLabelText('Date')
      if (clearDate) {
        fireEvent.change(date, { target: { value: '2030-12-24' } })
        fireEvent.change(date, { target: { value: '' } })
      }
      if (hideHours) {
        await user.click(within(section).getByRole('radio', { name: 'Unavailable all day' }))
      }
      const back = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Availability',
      })
      expect(fireEvent.click(back)).toBe(false)
      expect(confirm).toHaveBeenCalledOnce()
      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(api.to('POST /api/auth/sign-out')).toHaveLength(0)
      const reload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(reload)
      expect(reload.defaultPrevented).toBe(true)
      fireEvent.change(date, { target: { value: '2030-12-24' } })
      await user.click(within(section).getByRole('button', { name: 'Save override' }))
      await within(section).findByText(/Added the override for/)
      confirm.mockClear()
      await user.click(back)
      expect(await screen.findByRole('heading', { name: 'Availability', level: 1 })).toBeDefined()
      expect(confirm).not.toHaveBeenCalled()
      expect(location()).toBe('/app/availability')
    },
  )

  it.each([
    ['Pacific/Kiritimati', '2030-01-01T10:30:00Z', '2030-01-02'],
    ['Pacific/Honolulu', '2030-01-01T00:30:00Z', '2029-12-31'],
  ])('uses today in %s for the query and date input', async (timeZone, now, today) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    try {
      const api = scheduleServer([schedule({ timeZone })])
      renderApp(`/app/availability/${SCHEDULE_ID}`)
      const section = await overridesSection()
      await within(section).findByText('No upcoming date overrides.')
      expect(api.to(`GET /api/v1/schedules/${SCHEDULE_ID}/overrides`)[0]?.path).toBe(
        `/api/v1/schedules/${SCHEDULE_ID}/overrides?from=${today}`,
      )
      expect(within(section).getByLabelText('Date').getAttribute('min')).toBe(today)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists upcoming overrides from today in the schedule’s zone', async () => {
    const api = scheduleServer([schedule()], {
      overrides: [
        { date: '2030-12-24', intervals: [] },
        { date: '2030-12-31', intervals: [{ start: '09:00', end: '12:00' }] },
      ],
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    expect(
      await within(section).findByText('Unavailable all day', { selector: 'li span' }),
    ).toBeDefined()
    expect(within(section).getByText('09:00–12:00')).toBeDefined()
    expect(within(section).getByText(/24 Dec 2030|Dec 24, 2030/)).toBeDefined()
    expect(api.to(`GET /api/v1/schedules/${SCHEDULE_ID}/overrides`)[0]?.path).toBe(
      `/api/v1/schedules/${SCHEDULE_ID}/overrides?from=${todayIn('Europe/Berlin')}`,
    )
  })

  it('adds a day off', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], {
      extra: {
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: ({ body }) =>
          json(201, { date: '2030-12-24', ...(body as object) }),
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await within(section).findByText('No upcoming date overrides.')
    fireEvent.change(within(section).getByLabelText('Date'), { target: { value: '2030-12-24' } })
    api.setOverrides([{ date: '2030-12-24', intervals: [] }])
    await user.click(within(section).getByRole('button', { name: 'Save override' }))
    expect(
      await within(section).findByText(/Added the override for .*: Unavailable all day\./),
    ).toBeDefined()
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`)[0]?.body).toEqual({
      intervals: [],
    })
    expect(
      await within(section).findByText('Unavailable all day', { selector: 'li span' }),
    ).toBeDefined()
    expect(within(section).getByLabelText<HTMLInputElement>('Date').value).toBe('')
  })

  it('adds other hours on a date, checking them first', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-31', intervals: [] }],
      extra: {
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`]: ({ body }) =>
          json(200, { date: '2030-12-31', ...(body as object) }),
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await within(section).findByText('Unavailable all day', { selector: 'li span' })
    await user.click(within(section).getByRole('button', { name: 'Save override' }))
    expect((await within(section).findByRole('alert')).textContent).toContain(
      'Date: Choose a date.',
    )

    fireEvent.change(within(section).getByLabelText('Date'), { target: { value: '2030-12-31' } })
    expect(within(section).getByText(/saving replaces it/)).toBeDefined()
    await user.click(within(section).getByRole('radio', { name: 'Other hours' }))
    await user.click(within(section).getByRole('button', { name: 'Add hours on That date' }))
    fireEvent.change(within(section).getByLabelText('That date, hours 2, from'), {
      target: { value: '12:00' },
    })
    fireEvent.change(within(section).getByLabelText('That date, hours 2, until'), {
      target: { value: '18:00' },
    })
    await user.click(within(section).getByRole('button', { name: 'Save override' }))
    expect((await within(section).findByRole('alert')).textContent).toContain(
      'These hours overlap: 09:00–17:00 and 12:00–18:00.',
    )
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`)).toHaveLength(0)

    fireEvent.change(within(section).getByLabelText('That date, hours 1, until'), {
      target: { value: '11:00' },
    })
    await user.click(within(section).getByRole('button', { name: 'Save override' }))
    expect(
      await within(section).findByText(/Replaced the override for .*: 09:00–11:00, 12:00–18:00\./),
    ).toBeDefined()
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`)[0]?.body).toEqual({
      intervals: [
        { start: '09:00', end: '11:00' },
        { start: '12:00', end: '18:00' },
      ],
    })
  })

  it('removes an override', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
      extra: {
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () =>
          new Response(null, { status: 204 }),
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    const remove = await within(section).findByRole('button', { name: /Remove override: / })
    api.setOverrides([])
    await user.click(remove)
    expect(api.to(`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`)).toHaveLength(0)
    expect(within(section).getByText('Removal pending save')).toBeDefined()
    await user.click(within(section).getByRole('button', { name: 'Save removals' }))
    expect(await within(section).findByText('No upcoming date overrides.')).toBeDefined()
    expect(within(section).getByText(/Removed the override for /)).toBeDefined()
    expect(document.activeElement).toBe(
      within(section).getByRole('heading', { name: 'Date overrides' }),
    )
    expect(api.to(`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`)).toHaveLength(1)
  })

  it('keeps removals unsaved until an explicit save, with undo and navigation protection', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    const remove = await within(section).findByRole('button', { name: /Remove override:/ })
    await user.click(remove)
    expect(within(section).getByText('Unsaved date override removals')).toBeDefined()
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
    const reload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(reload)
    expect(reload.defaultPrevented).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(location()).toBe(`/app/availability/${SCHEDULE_ID}`)
    await user.click(within(section).getByRole('button', { name: /Undo removal:/ }))
    expect(within(section).queryByRole('button', { name: 'Save removals' })).toBeNull()
    const restored = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(restored)
    expect(restored.defaultPrevented).toBe(false)
  })

  it('keeps failed removals for retry without repeating successful deletes', async () => {
    const user = userEvent.setup()
    let fail = true
    const api = scheduleServer([schedule()], {
      overrides: [
        { date: '2030-12-24', intervals: [] },
        { date: '2030-12-31', intervals: [] },
      ],
      extra: {
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () => {
          api.setOverrides([{ date: '2030-12-31', intervals: [] }])
          return new Response(null, { status: 204 })
        },
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`]: () => {
          if (fail) return json(503, { error: 'service_unavailable', message: 'Try again later.' })
          api.setOverrides([])
          return new Response(null, { status: 204 })
        },
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    const removes = await within(section).findAllByRole('button', { name: /Remove override:/ })
    for (const remove of removes) await user.click(remove)
    await user.click(within(section).getByRole('button', { name: 'Save removals' }))
    expect((await within(section).findByRole('alert')).textContent).toContain(
      'Saved removals are kept; try again for the remaining dates.',
    )
    expect(within(section).getByText('Unsaved date override removals')).toBeDefined()
    await within(section).findByRole('button', { name: /Undo removal:/ })
    const reload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(reload)
    expect(reload.defaultPrevented).toBe(true)
    fail = false
    await user.click(within(section).getByRole('button', { name: 'Save removals' }))
    await within(section).findByText('No upcoming date overrides.')
    expect(api.to(`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`)).toHaveLength(1)
    expect(api.to(`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`)).toHaveLength(2)
    const saved = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(saved)
    expect(saved.defaultPrevented).toBe(false)
  })

  it('uses separate explicit save actions for schedule details and override drafts', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await user.click(await within(section).findByRole('button', { name: /Remove override:/ }))
    await user.type(input('Name'), ' 2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PATCH /api/v1/schedules/${SCHEDULE_ID}`)).toHaveLength(1)
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(within(section).getByText('Unsaved date override removals')).toBeDefined()
    expect(
      screen.getByText(
        'Save schedule details and weekly hours here. Save date overrides in their section below.',
      ),
    ).toBeDefined()
    expect(screen.queryByText(/They are saved right away/)).toBeNull()
  })

  it('locks both override actions during a removal save and does not send duplicate deletes', async () => {
    const user = userEvent.setup()
    const remove = later()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
      extra: {
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () => remove.response,
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-31`]: ({ body }) =>
          json(201, { date: '2030-12-31', ...(body as object) }),
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await user.click(await within(section).findByRole('button', { name: /Remove override:/ }))
    fireEvent.change(within(section).getByLabelText('Date'), { target: { value: '2030-12-31' } })
    const save = within(section).getByRole('button', { name: 'Save removals' })
    await user.click(save)
    expect(save.matches(':disabled')).toBe(true)
    expect(document.activeElement).toBe(
      within(section).getByRole('heading', { name: 'Date overrides' }),
    )
    expect(within(section).getByLabelText('Date').matches(':disabled')).toBe(true)
    expect(
      within(section)
        .getByRole('button', { name: /Undo removal:/ })
        .matches(':disabled'),
    ).toBe(true)
    fireEvent.submit(
      within(section)
        .getByRole('button', { name: 'Save override' })
        .closest('form') as HTMLFormElement,
    )
    await user.click(save)
    expect(api.calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(api.to(`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`)).toHaveLength(1)
    api.setOverrides([])
    await remove.answer(new Response(null, { status: 204 }))
    await within(section).findByText('No upcoming date overrides.')
    expect(within(section).getByLabelText('Date').matches(':disabled')).toBe(false)
  })

  it('locks removal actions during an override save, then keeps a saved replacement', async () => {
    const user = userEvent.setup()
    const save = later()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
      extra: {
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () => save.response,
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await user.click(await within(section).findByRole('button', { name: /Remove override:/ }))
    fireEvent.change(within(section).getByLabelText('Date'), { target: { value: '2030-12-24' } })
    await user.click(within(section).getByRole('button', { name: 'Save override' }))
    expect(
      within(section).getByRole('button', { name: 'Save removals' }).matches(':disabled'),
    ).toBe(true)
    expect(
      within(section)
        .getByRole('button', { name: /Undo removal:/ })
        .matches(':disabled'),
    ).toBe(true)
    await user.click(within(section).getByRole('button', { name: 'Save removals' }))
    expect(api.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    await save.answer(json(200, { date: '2030-12-24', intervals: [] }))
    await within(section).findByText(/Replaced the override for/)
    expect(within(section).queryByRole('button', { name: 'Save removals' })).toBeNull()
    expect(await within(section).findByRole('button', { name: /Remove override:/ })).toBeDefined()
    const saved = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(saved)
    expect(saved.defaultPrevented).toBe(false)
  })

  it('treats an already removed override as a saved removal', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], {
      overrides: [{ date: '2030-12-24', intervals: [] }],
      extra: {
        [`DELETE /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () => {
          api.setOverrides([])
          return json(404, { error: 'schedule_override_not_found' })
        },
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await overridesSection()
    await user.click(await within(section).findByRole('button', { name: /Remove override:/ }))
    await user.click(within(section).getByRole('button', { name: 'Save removals' }))
    await within(section).findByText('No upcoming date overrides.')
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(within(section).queryByRole('button', { name: 'Save removals' })).toBeNull()
  })

  it('waits for the schedule to exist', async () => {
    scheduleServer([])
    renderApp('/app/availability/new')
    const section = await overridesSection()
    expect(section.textContent).toContain('Create the schedule first')
  })
})

describe('answers that arrive after leaving or editing on', () => {
  it('does not leave the page the person went to when a create finishes late', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const create = later()
    scheduleServer([], { extra: { 'POST /api/v1/schedules': () => create.response } })
    renderApp('/app/availability/new')
    await user.click(await screen.findByRole('button', { name: 'Create schedule' }))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await user.type(await screen.findByLabelText('Handle'), '-l')
    await create.answer(json(201, schedule({ id: NEW_ID })))

    expect(location()).toBe('/app/settings')
    expect(input('Handle').value).toBe('ada-l')
  })

  it('does not leave the page the person went to when a delete finishes late', async () => {
    const user = userEvent.setup()
    const remove = later()
    scheduleServer([schedule(), evenings], {
      extra: { [`DELETE /api/v1/schedules/${OTHER_SCHEDULE_ID}`]: () => remove.response },
    })
    renderApp(`/app/availability/${OTHER_SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Delete schedule' }))
    await user.click(
      within(screen.getByRole('group', { name: /Delete “Evenings”/ })).getByRole('button', {
        name: 'Delete schedule',
      }),
    )
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await user.type(await screen.findByLabelText('Handle'), '-l')
    await remove.answer(new Response(null, { status: 204 }))

    expect(location()).toBe('/app/settings')
    expect(input('Handle').value).toBe('ada-l')
  })

  it('locks the weekly hours while saving, so no edit is overwritten', async () => {
    const user = userEvent.setup()
    const save = later()
    scheduleServer([schedule()], {
      extra: { [`PATCH /api/v1/schedules/${SCHEDULE_ID}`]: () => save.response },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await screen.findByRole('heading', { name: 'Edit “Working hours”', level: 1 })
    await user.type(input('Name'), ' 2')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(document.activeElement?.textContent).toBe('Saving…')
    expect(input('Name').matches(':disabled')).toBe(true)
    expect(input('Monday, hours 1, from').matches(':disabled')).toBe(true)
    await user.type(input('Name'), ' more')
    expect(input('Name').value).toBe('Working hours 2')

    await save.answer(json(200, schedule({ name: 'Working hours 2' })))
    expect(screen.getByText('Saved.')).toBeDefined()
    expect(input('Name').matches(':disabled')).toBe(false)
    expect(input('Name').value).toBe('Working hours 2')
  })

  it('locks the override form while saving it', async () => {
    const user = userEvent.setup()
    const save = later()
    scheduleServer([schedule()], {
      extra: {
        [`PUT /api/v1/schedules/${SCHEDULE_ID}/overrides/2030-12-24`]: () => save.response,
      },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const section = await screen.findByRole('region', { name: 'Date overrides' })
    await within(section).findByText('No upcoming date overrides.')
    fireEvent.change(within(section).getByLabelText('Date'), { target: { value: '2030-12-24' } })
    const button = within(section).getByRole('button', { name: 'Save override' })
    await user.click(button)
    expect(within(section).getByLabelText('Date').matches(':disabled')).toBe(true)
    expect(document.activeElement).toBe(button)
    expect(button.textContent).toBe('Saving…')
    // A second press does not send it again.
    await user.click(button)
    await save.answer(json(201, { date: '2030-12-24', intervals: [] }))
    expect(within(section).getByLabelText('Date').matches(':disabled')).toBe(false)
  })
})

describe('Chinese schedule names', () => {
  it('uses resource-name wording and wrapped quotes on the schedule editor', async () => {
    chooseLanguage('zh-CN')
    scheduleServer()
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const heading = await screen.findByRole('heading', { name: '编辑“Working hours”', level: 1 })
    expect(screen.getByRole('heading', { name: '名称和时区' })).toBeDefined()
    expect(screen.getByLabelText('名称')).toBeDefined()
    expect(heading.querySelectorAll('.cjk-quote')).toHaveLength(2)
  })
})

describe('schedule editor layout and accessible controls', () => {
  it('uses shared page headers on the schedule list and editor', async () => {
    const user = userEvent.setup()
    scheduleServer()
    renderApp('/app/availability')
    const heading = await screen.findByRole('heading', { name: 'Availability', level: 1 })
    expect(heading.closest('.page-header')).not.toBeNull()
    await user.click(await screen.findByRole('link', { name: 'Edit Working hours' }))
    const editor = await screen.findByRole('heading', { name: 'Edit “Working hours”', level: 1 })
    expect(editor.closest('.page-header')).not.toBeNull()
  })

  it('keeps a time range in one compact row with a named icon remove control', async () => {
    scheduleServer()
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const remove = await screen.findByRole('button', { name: 'Remove Monday, hours 1' })
    expect(remove.classList.contains('button-icon')).toBe(true)
    expect(remove.querySelector('[aria-hidden="true"]')?.textContent).toBe('×')
    const row = remove.closest('.interval-row')
    expect(row?.querySelectorAll('input[type="time"]')).toHaveLength(2)
    expect(input('Monday, hours 1, from').closest('.interval-row')).toBe(row)
    expect(input('Monday, hours 1, until').closest('.interval-row')).toBe(row)
    expect(row?.lastElementChild).toBe(remove)
  })
})

describe('availability loading skeleton', () => {
  it('keeps the page header and app navigation visible while schedules load', async () => {
    const loading = later()
    scheduleServer([], { extra: { 'GET /api/v1/schedules': () => loading.response } })
    renderApp('/app/availability')
    await screen.findByRole('heading', { name: 'Availability', level: 1 })
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined()
    const skeleton = screen.getByRole('status', { name: 'Loading schedules…' })
    expect(skeleton.classList.contains('page-skeleton')).toBe(true)
    expect(skeleton.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3)
    await loading.answer(json(200, { data: [] }))
    expect(screen.queryByRole('status', { name: 'Loading schedules…' })).toBeNull()
    expect(screen.getByText(/You have no schedule yet/)).toBeDefined()
  })
})

it('keeps the schedule editor inside the app shell while its skeleton loads', async () => {
  const loading = later()
  scheduleServer([schedule()], {
    extra: { [`GET /api/v1/schedules/${SCHEDULE_ID}`]: () => loading.response },
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  const skeleton = await screen.findByRole('status', { name: 'Loading…' })
  expect(skeleton.classList.contains('page-skeleton')).toBe(true)
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined()
  await loading.answer(json(200, schedule()))
  expect(screen.getByRole('heading', { name: 'Edit “Working hours”', level: 1 })).toBeDefined()
})
