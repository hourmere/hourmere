import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  AppShell,
  AvailabilityPage,
  RequireSession,
  SessionLayout,
  TroubleshootPage,
} from '../../lazy-pages.tsx'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  renderApp,
  signedIn,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'
import { resolveLazy } from '../../test/resolve-lazy.ts'
import { todayIn } from './Troubleshoot.tsx'
import * as model from './troubleshoot-model.ts'

// Route chunks load before rendering, as on a page visited earlier: a first render would
// otherwise suspend and spend the findBy* budget on React's fallback throttle.
beforeAll(() =>
  resolveLazy(SessionLayout, RequireSession, AppShell, TroubleshootPage, AvailabilityPage),
)

const route = `GET /api/v1/event-types/${EVENT_TYPE_ID}/availability-troubleshooting`
const TEAM_EVENT = 'e0000000-0000-7000-8000-000000000002'
const teamRoute = `GET /api/v1/event-types/${TEAM_EVENT}/availability-troubleshooting`
const day = '2030-11-04'
const TEAM_ME = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-0000000000aa',
    name: 'Team',
    slug: 'team',
    personal: false,
  },
}
const teamAs = (role: string) => ({
  ...signedInAs(TEAM_ME),
  'GET /api/auth/organization/get-active-member': () =>
    json(200, {
      id: 'membership-1',
      organizationId: TEAM_ME.organization.id,
      userId: TEAM_ME.user.id,
      role,
      createdAt: '2026-10-01T09:00:00.000Z',
    }),
})
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
    fakeApi({ ...teamAs('owner'), ...profile(), ...events, [teamRoute]: () => json(200, team) })
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
    fakeApi({ ...teamAs('admin'), ...profile(), ...events, [teamRoute]: () => json(200, team) })
    renderApp(`/app/availability/troubleshoot?eventTypeId=${TEAM_EVENT}`)
    expect(await screen.findByRole('heading', { name: '排查可预约时间', level: 1 })).toBeDefined()
    await user.click(await screen.findByRole('button', { name: '检查这一天' }))
    const list = await screen.findByRole('list', { name: '这一天的时间' })
    expect(within(list).getByText('Blake Member：')).toBeDefined()
    expect(within(list).getByText('已连接的日历显示这个时间忙碌。')).toBeDefined()
    expect(within(list).getByText('并非所有必需的主持人都有空。')).toBeDefined()
    expect(screen.getByText('1 个可能的时间中有 0 个可以预约。时间按 UTC 显示。')).toBeDefined()
  })

  it('offers ordinary team members only the event types they may troubleshoot', async () => {
    const api = fakeApi({ ...teamAs('member'), ...profile(), ...events })
    renderApp(`/app/availability/troubleshoot?eventTypeId=${TEAM_EVENT}`)
    const picker = (await screen.findByLabelText('Event type')) as HTMLSelectElement
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Intro call'])
    expect(picker.value).toBe(EVENT_TYPE_ID)
    expect(screen.getByTestId('troubleshoot-hidden-team-types').textContent).toBe(
      'Team event types are not listed: only team owners and admins can see why their times are unavailable.',
    )
    expect(api.to(teamRoute)).toHaveLength(0)
  })

  it('explains, in Chinese too, when a member has only team event types', async () => {
    chooseLanguage('zh-CN')
    fakeApi({
      ...teamAs('member'),
      ...profile(),
      'GET /api/v1/event-types': () =>
        json(200, { data: [eventType({ id: TEAM_EVENT, ownerUserId: null, title: 'Team sync' })] }),
    })
    renderApp('/app/availability/troubleshoot')
    expect((await screen.findByTestId('troubleshoot-hidden-team-types')).textContent).toBe(
      '未列出团队活动类型：只有团队所有者和管理员才能查看这些时间无法预约的原因。',
    )
    expect(screen.queryByLabelText('活动类型')).toBeNull()
    expect(document.body.textContent).not.toContain('暂无可检查的活动类型')
  })

  it('keeps team event types for owners and admins', async () => {
    for (const role of ['owner', 'admin', 'member,admin']) {
      fakeApi({ ...teamAs(role), ...profile(), ...events })
      const view = renderApp('/app/availability/troubleshoot')
      const picker = (await screen.findByLabelText('Event type')) as HTMLSelectElement
      expect(
        [...picker.options].map((option) => option.textContent),
        role,
      ).toContain('Team sync')
      expect(screen.queryByTestId('troubleshoot-hidden-team-types')).toBeNull()
      view.unmount()
    }
  })

  const hourly = (zone: string, rangeStart: string, starts: string[], minutes = 60) => ({
    ...personal,
    timeZone: zone,
    date: '2026-11-01',
    rangeStart,
    rangeEnd: zone === 'Asia/Tokyo' ? '2026-11-01T15:00:00Z' : '2026-11-02T05:00:00Z',
    slots: starts.map((start) => ({
      start,
      end: new Date(Date.parse(start) + minutes * 60_000).toISOString().replace('.000', ''),
      status: 'available',
      reasons: [],
    })),
  })

  it('names the zone on times around the autumn clock change in New York', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () =>
        json(
          200,
          hourly('America/New_York', '2026-11-01T04:00:00Z', [
            '2026-11-01T04:00:00Z',
            '2026-11-01T05:00:00Z',
            '2026-11-01T06:00:00Z',
          ]),
        ),
    })
    renderApp('/app/availability/troubleshoot')
    await check(user)
    const list = await screen.findByRole('list', { name: 'Times on this day' })
    const titles = [...list.querySelectorAll('.card-title')].map((title) =>
      title.firstChild?.textContent?.replace(/\s+/g, ' '),
    )
    expect(titles[0]).not.toMatch(/EDT|EST|GMT/)
    expect(titles[1]).toMatch(/^1:00 AM EDT – 1:00 AM EST$/)
    expect(titles[2]).toMatch(/^1:00 AM EST – 2:00 AM EST$/)
  })

  it('names the zone on the repeated hour in Chinese as well', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () =>
        json(
          200,
          hourly('America/New_York', '2026-11-01T04:00:00Z', [
            '2026-11-01T04:00:00Z',
            '2026-11-01T05:00:00Z',
          ]),
        ),
    })
    renderApp('/app/availability/troubleshoot')
    await user.click(await screen.findByRole('button', { name: '检查这一天' }))
    const list = await screen.findByRole('list', { name: '这一天的时间' })
    const titles = [...list.querySelectorAll('.card-title')].map(
      (title) => title.firstChild?.textContent ?? '',
    )
    expect(titles[0]).not.toMatch(/GMT|EDT|EST/)
    expect(titles[1]).toBe('GMT-4 01:00–GMT-5 01:00')
  })

  it.each([
    [
      'en',
      'Check this day',
      'Times on this day',
      '1:00 AM EDT – 1:30 AM EDT',
      '1:00 AM EST – 1:30 AM EST',
    ],
    ['zh-CN', '检查这一天', '这一天的时间', 'GMT-4 01:00–GMT-4 01:30', 'GMT-5 01:00–GMT-5 01:30'],
  ] as const)(
    'labels both occurrences of the repeated hour in a mixed-zone view (%s)',
    async (locale, button, listName, first, second) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      fakeApi({
        ...signedIn,
        ...profile(),
        ...events,
        [route]: () =>
          json(
            200,
            hourly(
              'America/New_York',
              '2026-11-01T04:00:00Z',
              ['2026-11-01T04:30:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z'],
              30,
            ),
          ),
      })
      renderApp('/app/availability/troubleshoot')
      await user.click(await screen.findByRole('button', { name: button }))
      const list = await screen.findByRole('list', { name: listName })
      const titles = [...list.querySelectorAll('.card-title')].map((title) =>
        title.firstChild?.textContent?.replace(/\s+/g, ' '),
      )
      expect(titles[0]).not.toMatch(/EDT|EST|GMT/)
      expect(titles[1]).toBe(first)
      expect(titles[2]).toBe(second)
    },
  )

  it('leaves times unchanged in a zone without clock changes', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      ...profile(),
      ...events,
      [route]: () =>
        json(
          200,
          hourly('Asia/Tokyo', '2026-10-31T15:00:00Z', [
            '2026-10-31T15:00:00Z',
            '2026-11-01T05:00:00Z',
            '2026-11-01T14:00:00Z',
          ]),
        ),
    })
    renderApp('/app/availability/troubleshoot')
    await check(user)
    const list = await screen.findByRole('list', { name: 'Times on this day' })
    const text = list.textContent ?? ''
    expect(text).not.toMatch(/JST|GMT|UTC/)
    expect(text).toContain('12:00 AM – 1:00 AM')
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
    `${source}; return { REASON_TEXT, reasonText, reasonHost, onlyOutsideHours, classifyFailure, zoneOffset, needsZoneLabel, troubleshootableEventTypes }`,
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
  const ny = 'America/New_York'
  expect(
    m.needsZoneLabel(
      ny,
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
      '2026-11-01T04:00:00Z',
      '2026-11-01T05:00:00Z',
    ),
  ).toBe(false)
  expect(
    m.needsZoneLabel(
      ny,
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
      '2026-11-01T05:00:00Z',
      '2026-11-01T06:00:00Z',
    ),
  ).toBe(true)
  expect(
    m.needsZoneLabel(
      ny,
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
      '2026-11-01T06:00:00Z',
      '2026-11-01T07:00:00Z',
    ),
  ).toBe(true)
  expect(
    m.needsZoneLabel(
      'Asia/Tokyo',
      '2026-10-31T15:00:00Z',
      '2026-11-01T15:00:00Z',
      '2026-11-01T05:00:00Z',
      '2026-11-01T06:00:00Z',
    ),
  ).toBe(false)
  // Spring: a time that crosses the change (1:00 AM EST – 3:00 AM EDT) by its end alone.
  expect(
    m.needsZoneLabel(
      ny,
      '2026-03-08T05:00:00Z',
      '2026-03-09T04:00:00Z',
      '2026-03-08T06:00:00Z',
      '2026-03-08T07:00:00Z',
    ),
  ).toBe(true)
  // The first occurrence of a repeated hour, though its offset equals the day start's.
  expect(
    m.needsZoneLabel(
      ny,
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
      '2026-11-01T05:00:00Z',
      '2026-11-01T05:30:00Z',
    ),
  ).toBe(true)
  expect(
    m.needsZoneLabel(
      ny,
      '2026-11-01T04:00:00Z',
      '2026-11-02T05:00:00Z',
      '2026-11-01T03:00:00Z',
      '2026-11-01T03:30:00Z',
    ),
  ).toBe(false)
  const types = [{ ownerUserId: 'me' }, { ownerUserId: null }, { ownerUserId: 'someone-else' }]
  const me = { userId: 'me', personalSpace: false }
  expect(m.troubleshootableEventTypes(types, me, ['member'])).toEqual({
    offered: [{ ownerUserId: 'me' }],
    hiddenTeamTypes: 1,
  })
  expect(m.troubleshootableEventTypes(types, me, ['admin']).offered).toHaveLength(2)
  expect(m.troubleshootableEventTypes(types, { ...me, personalSpace: true }, ['owner'])).toEqual({
    offered: [{ ownerUserId: 'me' }],
    hiddenTeamTypes: 1,
  })
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
    [
      'first occurrence of a repeated hour left unlabelled',
      '  return repeatsLocally(timeZone, start, offsets)\n',
      '  return false\n',
    ],
    ['clock-change end offset ignored', ' || zoneOffset(timeZone, end) !== day', ''],
    [
      'plain members offered team types',
      "teamRoles.some((role) => role === 'owner' || role === 'admin')",
      'teamRoles.length > 0',
    ],
    [
      'team types offered in a personal space',
      'const manager = !me.personalSpace && ',
      'const manager = ',
    ],
    ["other hosts' personal types offered", ': event.ownerUserId === me.userId,', ': true,'],
  ] as const)('kills: %s', (_name, before, after) => {
    expect(() => verifyModel(modelCopy([before, after]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
