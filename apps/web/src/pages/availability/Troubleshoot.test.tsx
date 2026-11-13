import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, later, profile, renderApp, signedIn } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'
import { todayIn } from './Troubleshoot.tsx'
import * as model from './troubleshoot-model.ts'

const route = `GET /api/v1/event-types/${EVENT_TYPE_ID}/availability-troubleshooting`
const TEAM_EVENT = 'e0000000-0000-7000-8000-000000000002'
const teamRoute = `GET /api/v1/event-types/${TEAM_EVENT}/availability-troubleshooting`
const day = '2030-11-04'
const query = (path: string) => Object.fromEntries(new URL(path, 'http://x').searchParams)

const slot = (time: string, status: 'available' | 'unavailable', reasons: object[] = []) => {
  const start = `${day}T${time}:00Z`
  const end = new Date(Date.parse(start) + 30 * 60_000).toISOString().replace('.000', '')
  return { start, end, status, reasons }
}
const whole = (code: string, time: string, extra: object = {}) => {
  const s = slot(time, 'unavailable')
  return { code, start: s.start, end: s.end, ...extra }
}
const personal = {
  eventTypeId: EVENT_TYPE_ID,
  date: day,
  timeZone: 'UTC',
  durationMinutes: null,
  rangeStart: `${day}T00:00:00Z`,
  rangeEnd: '2030-11-05T00:00:00Z',
  hosts: [],
  slots: [
    slot('08:00', 'unavailable', [whole('outside_working_hours', '08:00')]),
    slot('08:30', 'unavailable', [whole('outside_working_hours', '08:30')]),
    slot('09:00', 'available'),
    slot('09:30', 'unavailable', [whole('calendar_busy', '09:30')]),
    slot('10:00', 'unavailable', [
      { code: 'buffer_after', start: `${day}T10:15:00Z`, end: `${day}T10:30:00Z` },
    ]),
    slot('10:30', 'unavailable', [whole('daily_limit', '10:30'), whole('host_conflict', '10:30')]),
    slot('11:00', 'unavailable', [whole('a_future_reason', '11:00')]),
  ],
}
const team = {
  ...personal,
  eventTypeId: TEAM_EVENT,
  hosts: [
    { userId: 'u-avery', name: 'Avery Owner' },
    { userId: 'u-blake', name: 'Blake Member' },
  ],
  slots: [
    slot('09:00', 'unavailable', [
      whole('calendar_busy', '09:00', { hostUserId: 'u-blake' }),
      whole('host_conflict', '09:00', { hostUserId: 'u-removed' }),
      whole('collective_member_unavailable', '09:00'),
    ]),
  ],
}
const events = {
  'GET /api/v1/event-types': () =>
    json(200, {
      data: [
        eventType(),
        eventType({ id: TEAM_EVENT, title: 'Team sync', ownerUserId: null, slug: 'team-sync' }),
      ],
    }),
}

async function check(user: ReturnType<typeof userEvent.setup>, eventTitle = 'Intro call') {
  await user.selectOptions(await screen.findByLabelText('Event type'), eventTitle)
  const date = screen.getByLabelText('Date')
  await user.clear(date)
  await user.type(date, day)
  await user.click(screen.getByRole('button', { name: 'Check this day' }))
}

describe('availability troubleshooting page', () => {
  it('explains each time of the chosen day in plain words, hiding plain off-hours times', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () => json(200, personal),
    })
    renderApp('/app/availability/troubleshoot')
    expect(
      await screen.findByRole('heading', { name: 'Troubleshoot availability', level: 1 }),
    ).toBeDefined()
    await check(user)
    const list = await screen.findByRole('list', { name: 'Times on this day' })
    expect(
      screen.getByText('1 of 7 possible times can be booked. Times are shown in UTC.'),
    ).toBeDefined()
    expect(screen.getByText('2 times outside the available hours are hidden.')).toBeDefined()
    const items = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === list)
    expect(items).toHaveLength(5)
    expect(within(items[0] as HTMLElement).getByText('Bookable')).toBeDefined()
    expect(within(list).getByText('A connected calendar shows this time as busy.')).toBeDefined()
    expect(
      within(list).getByText('The buffer after the meeting overlaps another commitment.'),
    ).toBeDefined()
    expect(within(list).getByText(/\(affects 10:15/)).toBeDefined()
    expect(
      within(list).getByText('The daily booking limit for this event type has been reached.'),
    ).toBeDefined()
    expect(within(list).getByText('Another booking already takes this time.')).toBeDefined()
    // A code this page does not know reads neutrally, never as a guessed cause.
    expect(within(list).getByText('Another scheduling rule applies.')).toBeDefined()
    expect(document.body.textContent).not.toContain('a_future_reason')
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Hide times that are only outside the available hours',
      }),
    )
    expect(within(list).getAllByText(/Outside the available hours/)).toHaveLength(2)
    const call = api.to(route)[0]
    expect(query(call?.path ?? '')).toEqual({ date: day, timeZone: 'Europe/Berlin' })
  })

  it('names team hosts only from the response and never shows raw ids', async () => {
    const user = userEvent.setup()
    fakeApi({ ...signedIn, ...profile(), ...events, [teamRoute]: () => json(200, team) })
    renderApp(`/app/availability/troubleshoot?eventTypeId=${TEAM_EVENT}`)
    expect(((await screen.findByLabelText('Event type')) as HTMLSelectElement).value).toBe(
      TEAM_EVENT,
    )
    await user.click(screen.getByRole('button', { name: 'Check this day' }))
    const list = await screen.findByRole('list', { name: 'Times on this day' })
    expect(within(list).getByText('Blake Member:')).toBeDefined()
    expect(within(list).getByText('A team host:')).toBeDefined()
    expect(within(list).getByText('Not every required host is free.')).toBeDefined()
    expect(document.body.textContent).not.toMatch(/u-blake|u-removed/)
  })

  it.each([
    [404, { error: 'event_type_not_found', message: 'event_type_not_found' }],
    [403, { error: 'insufficient_scope', message: 'This API key does not allow this operation.' }],
  ])('shows %s as an access state, never as missing setup', async (status, body) => {
    const user = userEvent.setup()
    fakeApi({ ...signedIn, ...profile(), ...events, [route]: () => json(status, body) })
    renderApp('/app/availability/troubleshoot')
    await check(user)
    expect(await screen.findByTestId('troubleshoot-no-access')).toBeDefined()
    expect(document.body.textContent).not.toMatch(
      /set up|Set your|no schedule|not configured|missing|weekly hours/i,
    )
    expect(screen.queryByRole('list', { name: 'Times on this day' })).toBeNull()
  })

  it('treats unreadable calendars as temporary and offers a retry', async () => {
    const user = userEvent.setup()
    let answer = 409
    fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () =>
        answer === 409
          ? json(409, { error: 'calendar_sync_unavailable', message: 'Try again shortly.' })
          : json(200, personal),
    })
    renderApp('/app/availability/troubleshoot')
    await check(user)
    expect(
      await screen.findByText(
        'Connected calendars could not be read just now, so this day cannot be explained yet. Try again shortly.',
      ),
    ).toBeDefined()
    expect(document.body.textContent).not.toMatch(/calendar_busy|is busy|not connected/i)
    answer = 200
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Times on this day' })).toBeDefined()
  })

  it('shows loading, then a server error with retry, without inventing reasons', async () => {
    const user = userEvent.setup()
    const pending = later()
    fakeApi({ ...signedIn, ...profile(), ...events, [route]: () => pending.response })
    renderApp('/app/availability/troubleshoot')
    await check(user)
    expect(await screen.findByText('Checking this day…')).toBeDefined()
    expect(screen.queryByTestId('troubleshoot-no-access')).toBeNull()
    await pending.answer(json(500, { error: 'internal_error' }))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(/Could not check this day\./)).toBeDefined()
    expect(screen.queryByTestId('troubleshoot-no-access')).toBeNull()
  })

  it('validates the date before asking the server', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () => json(200, personal),
    })
    renderApp('/app/availability/troubleshoot')
    await user.clear(await screen.findByLabelText('Date'))
    await user.click(screen.getByRole('button', { name: 'Check this day' }))
    expect((await screen.findAllByText('Enter a valid date.')).length).toBeGreaterThan(0)
    expect(api.to(route)).toHaveLength(0)
  })

  it('reads naturally in Chinese with full-width punctuation', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    fakeApi({ ...signedIn, ...profile(), ...events, [teamRoute]: () => json(200, team) })
    renderApp(`/app/availability/troubleshoot?eventTypeId=${TEAM_EVENT}`)
    expect(await screen.findByRole('heading', { name: '排查可预约时间', level: 1 })).toBeDefined()
    await user.click(await screen.findByRole('button', { name: '检查这一天' }))
    const list = await screen.findByRole('list', { name: '这一天的时间' })
    expect(within(list).getByText('Blake Member：')).toBeDefined()
    expect(within(list).getByText('已连接的日历显示这个时间忙碌。')).toBeDefined()
    expect(within(list).getByText('并非所有必需的主持人都有空。')).toBeDefined()
    expect(screen.getByText('1 个可能的时间中有 0 个可以预约。时间按 UTC 显示。')).toBeDefined()
  })

  it('is linked from the availability page', async () => {
    fakeApi({ ...signedIn, 'GET /api/v1/schedules': () => json(200, { data: [] }) })
    renderApp('/app/availability')
    const link = await screen.findByRole('link', { name: 'Troubleshoot availability' })
    expect(link.getAttribute('href')).toBe('/app/availability/troubleshoot')
  })

  it('defaults the date to today in the profile time zone', () => {
    expect(todayIn('Asia/Tokyo', new Date('2030-11-03T16:00:00Z'))).toBe('2030-11-04')
    expect(todayIn('America/Los_Angeles', new Date('2030-11-03T16:00:00Z'))).toBe('2030-11-03')
    expect(todayIn('Not/AZone', new Date('2030-11-03T16:00:00Z'))).toBe('2030-11-03')
  })
})

// Mutation controls over an isolated copy of the plain-language model.
type Model = typeof model
function modelCopy(change?: [string, string]): Model {
  let source = readFileSync('apps/web/src/pages/availability/troubleshoot-model.ts', 'utf8')
  if (change) {
    expect(source, 'mutation must match source').toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(
    'RequestError',
    `${source}; return { REASON_TEXT, reasonText, reasonHost, onlyOutsideHours, classifyFailure }`,
  )(RequestError) as Model
}

function verifyModel(m: Model) {
  const error = (status: number, code: string) => new RequestError(status, code, code)
  expect(m.classifyFailure(error(404, 'event_type_not_found'))).toEqual({ kind: 'no_access' })
  expect(m.classifyFailure(error(403, 'insufficient_scope'))).toEqual({ kind: 'no_access' })
  expect(m.classifyFailure(error(409, 'calendar_sync_unavailable'))).toEqual({
    kind: 'calendars_unreadable',
  })
  expect(m.classifyFailure(error(500, 'internal_error'))).toEqual({ kind: 'error' })
  expect(m.classifyFailure(new Error('offline'))).toEqual({ kind: 'error' })
  expect(m.reasonText('calendar_busy')).toBe('A connected calendar shows this time as busy.')
  expect(m.reasonText('a_future_reason')).toBe('Another scheduling rule applies.')
  expect(m.reasonText('toString')).toBe('Another scheduling rule applies.')
  const hosts = [{ userId: 'u-1', name: 'Avery' }]
  const reason = { code: 'calendar_busy', start: 'a', end: 'b' }
  expect(m.reasonHost(reason, hosts)).toEqual({ kind: 'none' })
  expect(m.reasonHost({ ...reason, hostUserId: 'u-1' }, hosts)).toEqual({
    kind: 'named',
    name: 'Avery',
  })
  expect(m.reasonHost({ ...reason, hostUserId: 'u-2' }, hosts)).toEqual({ kind: 'unnamed' })
  const outside = { code: 'outside_working_hours', start: 'a', end: 'b' }
  const busy = { ...outside, code: 'calendar_busy' }
  const s = { start: 'a', end: 'b', status: 'unavailable' as const }
  expect(m.onlyOutsideHours({ ...s, reasons: [outside] })).toBe(true)
  expect(m.onlyOutsideHours({ ...s, reasons: [outside, busy] })).toBe(false)
  expect(m.onlyOutsideHours({ ...s, status: 'available', reasons: [] })).toBe(false)
  for (const code of [
    'past',
    'duration_not_offered',
    'outside_working_hours',
    'off_slot_grid',
    'minimum_notice',
    'booking_window',
    'calendar_busy',
    'buffer_before',
    'buffer_after',
    'daily_limit',
    'weekly_limit',
    'monthly_limit',
    'host_conflict',
    'collective_member_unavailable',
    'no_eligible_round_robin_host',
  ])
    expect(m.reasonText(code), code).not.toBe('Another scheduling rule applies.')
  expect(Object.keys(m.REASON_TEXT)).toHaveLength(15)
}

describe('troubleshooting model protections', () => {
  it('holds on the production module and an unchanged copy', () => {
    verifyModel(model)
    verifyModel(modelCopy())
  })
  it.each([
    [
      'denial shown as a validation problem',
      "if (error.status === 404 && error.code === 'event_type_not_found') return { kind: 'no_access' }",
      "if (error.status === 404 && error.code === 'event_type_not_found') return { kind: 'invalid', code: error.code }",
    ],
    [
      'scope denial shown as a server error',
      "  if (error.status === 403) return { kind: 'no_access' }\n",
      '',
    ],
    [
      'unreadable calendars shown as an error',
      "    return { kind: 'calendars_unreadable' }",
      "    return { kind: 'error' }",
    ],
    [
      'unknown codes guessed as off-hours',
      ": 'Another scheduling rule applies.'",
      ": 'Outside the available hours (weekly hours or a date override).'",
    ],
    [
      'inherited keys treated as known codes',
      'return Object.hasOwn(REASON_TEXT, code)',
      'return code in REASON_TEXT',
    ],
    [
      'unknown host shown by raw id',
      "{ kind: 'named', name: host.name } : { kind: 'unnamed' }",
      "{ kind: 'named', name: host.name } : { kind: 'named', name: reason.hostUserId }",
    ],
    [
      'mixed reasons hidden with off-hours times',
      "slot.reasons.every((reason) => reason.code === 'outside_working_hours')",
      "slot.reasons.some((reason) => reason.code === 'outside_working_hours')",
    ],
  ] as const)('kills: %s', (_name, before, after) => {
    expect(() => verifyModel(modelCopy([before, after]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
