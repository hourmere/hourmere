import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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
  let version = 0
  const one = (id: string): Routes => ({
    [`GET /api/v1/schedules/${id}`]: () => {
      const found = list.find((s) => s.id === id)
      return found ? json(200, found) : json(404, { error: 'schedule_not_found' })
    },
    [`GET /api/v1/schedules/${id}/availability`]: () => {
      const found = list.find((s) => s.id === id)
      return found
        ? json(200, { schedule: found, overrides, version: String(version) })
        : json(404, { error: 'schedule_not_found' })
    },
    [`PUT /api/v1/schedules/${id}/availability`]: ({ body }) => {
      const {
        expectedVersion,
        overrides: nextOverrides,
        ...change
      } = body as Partial<Schedule> & { expectedVersion: string; overrides: Override[] }
      if (expectedVersion !== String(version)) return json(409, { error: 'schedule_conflict' })
      version++
      overrides = nextOverrides
      list = list.map((s) =>
        s.id === id ? { ...s, ...change } : change.isDefault ? { ...s, isDefault: false } : s,
      )
      return json(200, {
        schedule: list.find((s) => s.id === id),
        overrides,
        version: String(version),
      })
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
    expect(
      api.to(`PUT /api/v1/schedules/${OTHER_SCHEDULE_ID}/availability`).map((c) => c.body),
    ).toEqual([
      {
        expectedVersion: '0',
        overrides: [],
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
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)[0]?.body).toMatchObject({
      weeklyHours: { sunday: [{ start: '20:00', end: '24:00' }], monday: [] },
    })
  })

  it('makes it the default from its page', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule(), evenings])
    renderApp(`/app/availability/${OTHER_SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    await user.click(screen.getByRole('checkbox', { name: 'Make this my default schedule' }))
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(
      api.to(`PUT /api/v1/schedules/${OTHER_SCHEDULE_ID}/availability`)[1]?.body,
    ).toMatchObject({
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
  const answered = vi.fn()
  void loading.response.then(answered)
  const api = scheduleServer([schedule()], {
    extra: { [`GET /api/v1/schedules/${SCHEDULE_ID}/availability`]: () => loading.response },
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  // AdminLoading uses the same label before the session and lazy route are ready.
  await screen.findByRole('navigation', { name: 'Main' })
  await waitFor(() =>
    expect(api.to(`GET /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(1),
  )
  const skeleton = await within(screen.getByRole('main')).findByRole('status', {
    name: 'Loading…',
  })
  expect(skeleton.classList.contains('page-skeleton')).toBe(true)
  expect(skeleton.closest('[aria-busy="true"]')).toBeNull()
  expect(answered).not.toHaveBeenCalled()
  await loading.answer(json(200, { schedule: schedule(), overrides: [], version: '0' }))
  expect(screen.getByRole('heading', { name: 'Edit “Working hours”', level: 1 })).toBeDefined()
})

describe('override date labels', () => {
  it.each(['fa-IR', 'th-TH'])(
    'uses Gregorian override labels for browser locale %s',
    async (locale) => {
      browserLocale(locale)
      scheduleServer([schedule()], { overrides: [{ date: '2030-12-24', intervals: [] }] })
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
      expect(
        await within(section).findByRole('button', { name: `Remove override: ${date}` }),
      ).toBeDefined()
    },
  )
})

describe('one availability save', () => {
  it('includes unsaved override rows and removals with weekly hours in one request', async () => {
    const user = userEvent.setup()
    const api = scheduleServer([schedule()], { overrides: [{ date: '2030-12-24', intervals: [] }] })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await user.click(
      await screen.findByRole('button', { name: 'Remove override: Tue, Dec 24, 2030' }),
    )
    await user.click(screen.getByRole('button', { name: 'Add a date override' }))
    fireEvent.change(input('Date'), { target: { value: '2030-12-31' } })
    fireEvent.change(input('Monday, hours 1, until'), { target: { value: '00:00' } })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`).map((c) => c.body)).toEqual([
      expect.objectContaining({
        expectedVersion: '0',
        overrides: [{ date: '2030-12-31', intervals: [] }],
        weeklyHours: expect.objectContaining({ monday: [{ start: '09:00', end: '24:00' }] }),
      }),
    ])
    expect(api.calls.filter((c) => ['PUT', 'PATCH', 'DELETE'].includes(c.method))).toHaveLength(1)
    const reload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(reload)
    expect(reload.defaultPrevented).toBe(false)
  })
  it('validates incomplete dates and overlapping date hours before any write', async () => {
    const user = userEvent.setup()
    const api = scheduleServer()
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Add a date override' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Choose a date')
    fireEvent.change(input('Date'), { target: { value: '2030-12-31' } })
    await user.click(screen.getByRole('checkbox', { name: 'Unavailable all day' }))
    await user.click(screen.getByRole('button', { name: 'Add hours on Tue, Dec 31, 2030' }))
    fireEvent.change(input('Tue, Dec 31, 2030, hours 2, from'), { target: { value: '16:00' } })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByRole('alert').textContent).toContain('These hours overlap')
    const overlap = within(screen.getByRole('alert')).getByRole('link', {
      name: /These hours overlap/,
    })
    await user.click(overlap)
    expect(document.activeElement).toBe(
      document.querySelector(overlap.getAttribute('href') ?? 'missing'),
    )
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(0)
  })
  it.each([409, 503])(
    'retains all drafts and dirty protection when the whole save fails (%s)',
    async (status) => {
      const user = userEvent.setup()
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      scheduleServer([schedule()], {
        extra: {
          [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
            json(status, { error: status === 409 ? 'schedule_conflict' : 'unavailable' }),
        },
      })
      renderApp(`/app/availability/${SCHEDULE_ID}`)
      await user.click(await screen.findByRole('button', { name: 'Add a date override' }))
      fireEvent.change(input('Date'), { target: { value: '2030-12-31' } })
      fireEvent.change(input('Monday, hours 1, until'), { target: { value: '18:00' } })
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      const alert = await screen.findByRole('alert')
      if (status === 409) expect(alert.textContent).toContain('changed in another tab')
      expect(input('Date').value).toBe('2030-12-31')
      expect(input('Monday, hours 1, until').value).toBe('18:00')
      const reload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(reload)
      expect(reload.defaultPrevented).toBe(true)
      await user.click(screen.getByRole('link', { name: 'Back to availability' }))
      expect(confirm).toHaveBeenCalledOnce()
      expect(location()).toBe(`/app/availability/${SCHEDULE_ID}`)
    },
  )
  it('warns only for changed values, including undoing removals and removing an empty new row', async () => {
    const user = userEvent.setup()
    scheduleServer([schedule()], { overrides: [{ date: '2030-12-24', intervals: [] }] })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await screen.findByRole('button', { name: 'Remove override: Tue, Dec 24, 2030' })
    const dirty = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(dirty()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Remove override: Tue, Dec 24, 2030' }))
    expect(dirty()).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Undo removal: Tue, Dec 24, 2030' }))
    expect(dirty()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Add a date override' }))
    expect(dirty()).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Remove override: 1' }))
    expect(dirty()).toBe(false)
  })
  it('locks the whole form during the single save and does not submit twice', async () => {
    const user = userEvent.setup()
    const save = later()
    const api = scheduleServer([schedule()], {
      extra: { [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () => save.response },
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    expect(input('Name').matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add a date override' }).matches(':disabled')).toBe(
      true,
    )
    await user.click(screen.getByRole('button', { name: 'Saving…' }))
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(1)
    await save.answer(json(200, { schedule: schedule(), overrides: [], version: '1' }))
    await screen.findByText('Saved.')
  })
})

describe('copying weekday hours', () => {
  it('replaces selected ranges, keeps the source independent and preserves midnight', async () => {
    const user = userEvent.setup()
    scheduleServer()
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    fireEvent.change(await screen.findByLabelText('Monday, hours 1, until'), {
      target: { value: '00:00' },
    })
    const opener = screen.getByRole('button', { name: 'Copy to… Copy hours from Monday' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('checkbox', { name: 'Monday' })).toBeNull()
    await user.click(within(dialog).getByRole('checkbox', { name: 'Tuesday' }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply copy' }))
    expect(document.activeElement).toBe(opener)
    expect(input('Tuesday, hours 1, until').value).toBe('00:00')
    fireEvent.change(input('Tuesday, hours 1, until'), { target: { value: '19:00' } })
    expect(input('Monday, hours 1, until').value).toBe('00:00')
    await user.click(screen.getByRole('button', { name: 'Copy to… Copy hours from Sunday' }))
    await user.click(screen.getByRole('button', { name: 'Weekdays' }))
    await user.click(screen.getByRole('button', { name: 'Apply copy' }))
    expect(screen.getByRole('checkbox', { name: 'Monday' })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: 'Friday' })).toHaveProperty('checked', false)
  })
  it('supports keyboard selection, cancel, all days and retains validation for copied overlaps', async () => {
    const user = userEvent.setup()
    const api = scheduleServer()
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    await user.click(await screen.findByRole('button', { name: 'Add hours on Monday' }))
    fireEvent.change(input('Monday, hours 2, from'), { target: { value: '16:00' } })
    const opener = screen.getByRole('button', { name: 'Copy to… Copy hours from Monday' })
    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    await user.keyboard('{Enter}')
    await user.keyboard('{Tab}{Tab} ')
    expect(screen.getByRole('dialog').querySelector('input')).toHaveProperty('checked', true)
    await user.click(screen.getByRole('button', { name: 'All days' }))
    await user.click(screen.getByRole('button', { name: 'Apply copy' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.getByRole('alert').textContent).toContain('Sunday: These hours overlap')
    expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(0)
  })
})

it('explains a conflicting save in Chinese and retains local changes', async () => {
  chooseLanguage('zh-CN')
  const user = userEvent.setup()
  scheduleServer([schedule()], {
    extra: {
      [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
        json(409, { error: 'schedule_conflict' }),
    },
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '本地时段' } })
  await user.click(screen.getByRole('button', { name: '保存更改' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('此日程已在其他标签页')
  expect(alert.textContent).not.toContain('This schedule changed')
  expect(input('名称').value).toBe('本地时段')
})

it('returns focus to the unavailable control when the final override interval is removed', async () => {
  const user = userEvent.setup()
  scheduleServer([schedule()], {
    overrides: [{ date: '2030-12-24', intervals: [{ start: '09:00', end: '17:00' }] }],
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  await user.click(await screen.findByRole('button', { name: 'Remove Tue, Dec 24, 2030, hours 1' }))
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Unavailable all day' }))
  expect(document.activeElement).toHaveProperty('checked', true)
})

it('keeps a long override history collapsed and read-only with add first at 320px', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('innerWidth', 320)
  const past = Array.from({ length: 60 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    intervals: [],
  }))
  const api = scheduleServer([schedule()], {
    overrides: [
      ...past,
      { date: '2030-12-25', intervals: [] },
      { date: '2030-12-24', intervals: [] },
    ],
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  const add = await screen.findByRole('button', { name: 'Add a date override' })
  const section = add.closest('section')
  if (!section) throw new Error('Missing override section')
  const history = section.querySelector('details')
  if (!history) throw new Error('Missing history disclosure')
  expect(history.open).toBe(false)
  expect(history.querySelectorAll('input, button')).toHaveLength(0)
  expect(history.querySelectorAll('li')).toHaveLength(60)
  expect(section.querySelector('button')).toBe(add)
  expect(
    Array.from(section.querySelectorAll('input[type="date"]')).map(
      (e) => (e as HTMLInputElement).value,
    ),
  ).toEqual(['2030-12-24', '2030-12-25'])
  expect(section.textContent).toContain('Times are in')
  expect(section.textContent).toContain('Central European Time')
  await user.click(add)
  const date = section.querySelector<HTMLInputElement>('input[type="date"]')
  if (!date) throw new Error('Missing new date')
  expect(date.min).toMatch(/^20\d\d-\d\d-\d\d$/)
  fireEvent.change(date, { target: { value: '2030-12-26' } })
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)[0]?.body).toMatchObject({
    overrides: expect.arrayContaining(past),
  })
  expect(section.querySelectorAll('input[type="date"]')).toHaveLength(3)
  // jsdom cannot measure overflow; this checks the collapsed structure and top action.
  vi.unstubAllGlobals()
})

it('reviews latest changes and reapplies the retained draft with the new version', async () => {
  const user = userEvent.setup()
  let reads = 0
  let writes = 0
  const api = scheduleServer([schedule()], {
    extra: {
      [`GET /api/v1/schedules/${SCHEDULE_ID}/availability`]: () =>
        json(200, {
          schedule: schedule({ name: ++reads === 1 ? 'Original' : 'Other client' }),
          overrides: [],
          version: reads === 1 ? '0' : 'new-version',
        }),
      [`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`]: ({ body }) =>
        ++writes === 1
          ? json(409, { error: 'schedule_conflict' })
          : json(200, {
              schedule: schedule({ name: 'My draft' }),
              overrides: (body as { overrides: Override[] }).overrides,
              version: 'saved-version',
            }),
    },
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'My draft' } })
  await user.click(screen.getByRole('button', { name: 'Add a date override' }))
  fireEvent.change(input('Date'), { target: { value: '2030-12-31' } })
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect((await screen.findByRole('alert')).textContent).toContain('API, MCP or CLI client')
  await user.click(screen.getByRole('button', { name: 'Review latest version' }))
  await screen.findByText(/Other client/)
  expect(
    screen
      .getByRole('region', { name: 'Latest saved version' })
      .classList.contains('availability-conflict'),
  ).toBe(true)
  expect(input('Name').value).toBe('My draft')
  expect(input('Date').value).toBe('2030-12-31')
  await user.click(screen.getByRole('button', { name: 'Apply my draft to this version' }))
  expect(input('Name').value).toBe('My draft')
  expect(input('Date').value).toBe('2030-12-31')
  expect(document.activeElement?.getAttribute('role')).toBe('status')
  expect(document.activeElement?.textContent).toBe(
    'Draft applied to the latest version. Save changes to submit it.',
  )
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)[1]?.body).toMatchObject({
    expectedVersion: 'new-version',
    name: 'My draft',
    overrides: [{ date: '2030-12-31', intervals: [] }],
  })
})

it('keeps out-of-range native date drafts renderable for validation', async () => {
  const user = userEvent.setup()
  const api = scheduleServer()
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  await user.click(await screen.findByRole('button', { name: 'Add a date override' }))
  fireEvent.change(input('Date'), { target: { value: '10000-01-01' } })
  expect(input('Date').value).toBe('10000-01-01')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Choose a date in the years 0001 to 9999.',
  )
  expect(api.to(`PUT /api/v1/schedules/${SCHEDULE_ID}/availability`)).toHaveLength(0)
})

it('keeps saved and newly added override rows in place until save', async () => {
  const user = userEvent.setup()
  scheduleServer([schedule()], {
    overrides: [
      { date: '2030-12-25', intervals: [] },
      { date: '2030-12-24', intervals: [] },
    ],
  })
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  const add = await screen.findByRole('button', { name: 'Add a date override' })
  const dates = () => screen.getAllByLabelText<HTMLInputElement>('Date')
  const saved = dates()
  expect(saved.map((field) => field.value)).toEqual(['2030-12-24', '2030-12-25'])
  if (!saved[0]) throw new Error('Missing saved row')
  fireEvent.change(saved[0], { target: { value: '2030-12-30' } })
  expect(dates()).toEqual(saved)
  await user.click(add)
  const firstNew = dates()[0]
  if (!firstNew) throw new Error('Missing first new row')
  expect(document.activeElement).toBe(firstNew)
  fireEvent.change(firstNew, { target: { value: '2030-12-31' } })
  expect(dates()).toEqual([firstNew, ...saved])
  expect(firstNew.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Date override 1')
  await user.click(add)
  const secondNew = dates()[1]
  if (!secondNew) throw new Error('Missing second new row')
  fireEvent.change(secondNew, { target: { value: '2030-12-29' } })
  expect(dates()).toEqual([firstNew, secondNew, ...saved])
  expect(document.activeElement).toBe(secondNew)
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(dates().map((field) => field.value)).toEqual([
    '2030-12-25',
    '2030-12-29',
    '2030-12-30',
    '2030-12-31',
  ])
})

it.each([
  {
    locale: 'en' as const,
    zone: 'Time zone',
    hint: 'Times are in Eastern Time.',
    from: 'Tue, Dec 24, 2030, hours 1, from',
    until: 'Tue, Dec 24, 2030, hours 1, until',
  },
  {
    locale: 'zh-CN' as const,
    zone: '时区',
    hint: '时间均按北美东部时间显示。',
    from: '2030年12月24日周二，时间段 1，从',
    until: '2030年12月24日周二，时间段 1，至',
  },
])(
  'localizes override zone hints and interval names in $locale',
  async ({ locale, zone, hint, from, until }) => {
    chooseLanguage(locale)
    scheduleServer([schedule({ timeZone: 'America/New_York' })], {
      overrides: [{ date: '2030-12-24', intervals: [{ start: '09:00', end: '17:00' }] }],
    })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    expect(await screen.findByText(hint)).toBeDefined()
    expect(input(from).value).toBe('09:00')
    expect(input(until).value).toBe('17:00')
    fireEvent.change(screen.getByRole('combobox', { name: zone }), { target: { value: 'Ame' } })
    expect(screen.getByText(hint)).toBeDefined()
    fireEvent.change(screen.getByRole('combobox', { name: zone }), {
      target: { value: 'Asia/Shanghai' },
    })
    const changedHint =
      locale === 'en' ? 'Times are in China Standard Time.' : '时间均按中国标准时间显示。'
    expect(screen.getByText(changedHint)).toBeDefined()
    fireEvent.change(screen.getByRole('combobox', { name: zone }), { target: { value: 'Asia/' } })
    expect(screen.getByText(changedHint)).toBeDefined()
  },
)

it('keeps an unsupported saved zone renderable for correction', async () => {
  scheduleServer([schedule({ timeZone: 'Future/Example_City' })])
  renderApp(`/app/availability/${SCHEDULE_ID}`)
  expect(await screen.findByText('Times are in Future/Example City.')).toBeDefined()
  expect(input('Time zone').value).toBe('Future/Example_City')
})
