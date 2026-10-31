import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import {
  EVENT_TYPE_ID,
  eventType,
  OTHER_SCHEDULE_ID,
  SCHEDULE_ID,
  schedule,
} from '../../test/fixtures.ts'

type SelfCheck = Schemas['SelfReadinessPage']['eventTypes']['data'][number]
type Signal = SelfCheck['signals'][number]
type TeamCheck = Schemas['TeamReadinessPage']['eventTypes']['data'][number]

const NOW = '2026-10-30T12:00:00.000Z'
const TEAM = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Design team',
    slug: 'design-team',
    personal: false,
  },
}
const SELF_ROUTE = 'GET /api/v1/readiness/self'
const TEAM_ROUTE = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
const PATCH_ROUTE = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
const DIRTY = 'Save your changes to check the updated event type.'
const title = () => screen.getByLabelText<HTMLInputElement>('Title', { exact: true })
const readiness = () => screen.getByRole('region', { name: 'Saved event checks' })

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'effective_event_schedule',
    state: 'satisfied',
    reasonCode: null,
    checkedAt: NOW,
    ownerKind: 'member_self',
    fixKind: null,
    ...overrides,
  }
}

function selfCheck(overrides: Partial<SelfCheck> = {}): SelfCheck {
  return {
    subject: { kind: 'event_type', id: EVENT_TYPE_ID, organizationId: ME.organization.id },
    audience: 'self_detail',
    scope: 'configuration_and_cached_sync',
    availability: 'not_checked',
    enablement: 'enabled',
    activation: 'not_applicable',
    evaluatedAt: NOW,
    completeness: 'complete',
    summary: 'checks_passed',
    signals: [signal()],
    details: { schedules: [], calendars: [] },
    ...overrides,
  }
}

function selfPage(check: SelfCheck = selfCheck()): Schemas['SelfReadinessPage'] {
  return {
    member: selfCheck({
      subject: { kind: 'member', id: ME.user.id, organizationId: ME.organization.id },
      enablement: 'not_applicable',
    }),
    eventTypes: { data: [check], nextCursor: null },
  }
}

function teamCheck(overrides: Partial<TeamCheck> = {}): TeamCheck {
  return {
    eventTypeId: EVENT_TYPE_ID,
    enablement: 'enabled',
    activation: 'not_applicable',
    summary: 'checks_passed',
    completeness: 'complete',
    evaluatedAt: NOW,
    reasonCodes: [],
    fixKinds: [],
    ...overrides,
  }
}

function teamPage(check: TeamCheck = teamCheck()): Schemas['TeamReadinessPage'] {
  return {
    organizationId: TEAM.organization.id,
    members: { data: [], nextCursor: null },
    eventTypes: { data: [check], nextCursor: null },
  }
}

function server(initial: EventType = eventType(), overrides: Routes = {}, me = ME) {
  let saved = initial
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () =>
      json(200, {
        data: [schedule(), schedule({ id: OTHER_SCHEDULE_ID, name: 'Evenings', isDefault: false })],
      }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: ME.user.name }], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [PATCH_ROUTE]: ({ body }) => {
      saved = { ...saved, ...(body as Partial<EventType>) }
      return json(200, saved)
    },
    'POST /api/v1/event-types': ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
    [SELF_ROUTE]: () => json(200, selfPage()),
    [TEAM_ROUTE]: () => json(200, teamPage()),
    ...overrides,
  })
}

async function open() {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
}

async function save() {
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
}

describe('saved event type readiness in the editor', () => {
  it('requests exactly one summary for the saved version only after the save returns', async () => {
    const user = userEvent.setup()
    const patch = later()
    let stored = eventType()
    const checkedTitles: string[] = []
    const api = server(stored, {
      [SELF_ROUTE]: () => {
        checkedTitles.push(stored.title)
        return json(200, selfPage())
      },
      [PATCH_ROUTE]: () => patch.response,
    })
    await open()
    await within(readiness()).findByText('Configuration checks passed')
    expect(api.to(SELF_ROUTE)).toHaveLength(1)
    await user.clear(title())
    await user.type(title(), 'Submitted title')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.to(PATCH_ROUTE)).toHaveLength(1))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true)
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(api.to(SELF_ROUTE)).toHaveLength(1)
    expect(checkedTitles).toEqual(['Intro call'])

    stored = eventType({ title: 'Saved server title' })
    await patch.answer(json(200, stored))
    await screen.findByText('Saved.')
    await within(readiness()).findByText('Configuration checks passed')
    expect(api.to(SELF_ROUTE)).toHaveLength(2)
    expect(checkedTitles).toEqual(['Intro call', 'Saved server title'])
    expect(title().value).toBe('Saved server title')
    expect(api.to(PATCH_ROUTE)[0]?.body).toHaveProperty('title', 'Submitted title')
  })

  it('refreshes the summary after save and keeps saved separate from configuration success', async () => {
    const user = userEvent.setup()
    const pending = later()
    let summaries = 0
    const api = server(eventType(), {
      [SELF_ROUTE]: () => (++summaries === 1 ? json(200, selfPage()) : pending.response),
      [PATCH_ROUTE]: ({ body }) =>
        json(200, eventType({ ...(body as Partial<EventType>), title: 'Saved server title' })),
    })
    await open()
    await within(readiness()).findByText('Configuration checks passed')
    await user.clear(title())
    await user.type(title(), 'Submitted title')
    await save()
    await waitFor(() => expect(api.to(SELF_ROUTE)).toHaveLength(2))
    expect(title().value).toBe('Saved server title')
    expect(within(readiness()).queryByText('Configuration checks passed')).toBeNull()
    expect(within(readiness()).getByText('Checking configuration…')).toBeDefined()
    await pending.answer(
      json(
        200,
        selfPage(
          selfCheck({
            summary: 'configuration_blocked',
            signals: [
              signal({
                state: 'configuration_blocker',
                reasonCode: 'default_schedule_required',
                fixKind: 'self_availability',
              }),
            ],
          }),
        ),
      ),
    )
    expect(within(readiness()).getByText('Working hours are missing.')).toBeDefined()
    expect(screen.getByText('Saved.')).toBeDefined()
    expect(readiness().querySelector('.badge-success')).toBeNull()
    expect(
      within(readiness()).getByText(
        'These checks describe your saved event type. Available times are confirmed when someone books.',
      ),
    ).toBeDefined()
    expect(api.to(PATCH_ROUTE)[0]?.body).toHaveProperty('title', 'Submitted title')
  })

  it.each(['en', 'zh-CN'] as const)(
    'marks further edits as unchecked after the saved summary passes in %s',
    async (language) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      const api = server()
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('heading', {
        name: language === 'en' ? 'Edit “Intro call”' : '编辑“Intro call”',
      })
      const region = screen.getByRole('region', {
        name: language === 'en' ? 'Saved event checks' : '保存后的配置检查',
      })
      const passed = language === 'en' ? 'Configuration checks passed' : '配置检查通过'
      await within(region).findByText(passed)
      expect(
        within(region).getByText(
          language === 'en'
            ? 'These checks describe your saved event type. Available times are confirmed when someone books.'
            : '这些检查对应你已保存的活动类型。实际可约时间将在预约时确认。',
        ),
      ).toBeDefined()
      const input = screen.getByLabelText<HTMLInputElement>(language === 'en' ? 'Title' : '标题', {
        exact: true,
      })
      await user.type(input, ' saved')
      await user.click(
        screen.getByRole('button', { name: language === 'en' ? 'Save changes' : '保存更改' }),
      )
      await within(region).findByText(passed)
      await user.type(input, ' draft')
      expect(
        within(region).getByText(
          language === 'en' ? DIRTY : '保存更改后，即可检查更新后的活动类型。',
        ),
      ).toBeDefined()
      expect(within(region).queryByText(passed)).toBeNull()
      expect(region.querySelector('.badge-success')).toBeNull()
      expect(input.value).toBe('Intro call saved draft')
      expect(api.to(SELF_ROUTE)).toHaveLength(2)
    },
  )

  it('ignores a late saved summary after further edits and never overwrites the draft', async () => {
    const user = userEvent.setup()
    const pending = later()
    let summaries = 0
    const api = server(eventType(), {
      [SELF_ROUTE]: () => (++summaries === 1 ? json(200, selfPage()) : pending.response),
    })
    await open()
    await within(readiness()).findByText('Configuration checks passed')
    await user.type(title(), ' saved')
    await save()
    await waitFor(() => expect(api.to(SELF_ROUTE)).toHaveLength(2))
    await user.type(title(), ' unsaved')
    expect(within(readiness()).getByText(DIRTY)).toBeDefined()
    await pending.answer(
      json(
        200,
        selfPage(
          selfCheck({
            summary: 'configuration_blocked',
            signals: [
              signal({
                state: 'configuration_blocker',
                reasonCode: 'default_schedule_required',
                fixKind: 'self_availability',
              }),
            ],
          }),
        ),
      ),
    )
    expect(title().value).toBe('Intro call saved unsaved')
    expect(within(readiness()).getByText(DIRTY)).toBeDefined()
    expect(within(readiness()).queryByText('Working hours are missing.')).toBeNull()
    expect(within(readiness()).queryByText('Configuration checks passed')).toBeNull()
    expect(api.to(PATCH_ROUTE)).toHaveLength(1)
  })

  it('keeps the form saveable after a summary failure and saves the next draft', async () => {
    const user = userEvent.setup()
    let summaries = 0
    const api = server(eventType({ isActive: false }), {
      [SELF_ROUTE]: () =>
        ++summaries === 2 ? json(503, { error: 'internal_error' }) : json(200, selfPage()),
    })
    await open()
    await within(readiness()).findByText('Configuration checks passed')
    await user.type(title(), ' first draft')
    await save()
    await within(readiness()).findByText('Configuration check failed')
    expect(title().value).toBe('Intro call first draft')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      false,
    )
    await user.type(title(), ' next draft')
    await save()
    await within(readiness()).findByText('Configuration checks passed')
    expect(title().value).toBe('Intro call first draft next draft')
    expect(api.to(PATCH_ROUTE).map((call) => call.body)).toEqual([
      expect.objectContaining({ title: 'Intro call first draft' }),
      expect.objectContaining({ title: 'Intro call first draft next draft' }),
    ])
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Active: invitees can book it' })
        .checked,
    ).toBe(false)
  })

  it.each([200, 503])(
    'does not restore a late %s summary after edits are reverted to the saved fields',
    async (status) => {
      const user = userEvent.setup()
      const pending = later()
      let summaries = 0
      const api = server(eventType(), {
        [SELF_ROUTE]: () => (++summaries === 1 ? json(200, selfPage()) : pending.response),
      })
      await open()
      await within(readiness()).findByText('Configuration checks passed')
      await user.type(title(), ' saved')
      await save()
      await waitFor(() => expect(api.to(SELF_ROUTE)).toHaveLength(2))
      await user.type(title(), ' unsaved')
      expect(title().value).toBe('Intro call saved unsaved')
      expect(within(readiness()).getByText(DIRTY)).toBeDefined()
      await user.clear(title())
      await user.type(title(), 'Intro call saved')
      expect(within(readiness()).getByText('Configuration not checked')).toBeDefined()
      await pending.answer(json(status, status === 200 ? selfPage() : { error: 'internal_error' }))
      expect(title().value).toBe('Intro call saved')
      expect(within(readiness()).getByText('Configuration not checked')).toBeDefined()
      expect(within(readiness()).queryByText('Configuration checks passed')).toBeNull()
      expect(api.to(PATCH_ROUTE)).toHaveLength(1)
    },
  )

  it('allows creating a disabled draft and opens its saved readiness problems', async () => {
    const user = userEvent.setup()
    const api = server(eventType(), {
      [SELF_ROUTE]: () =>
        json(
          200,
          selfPage(
            selfCheck({
              enablement: 'disabled',
              summary: 'disabled',
              signals: [
                signal({
                  state: 'configuration_blocker',
                  reasonCode: 'default_schedule_required',
                  fixKind: 'self_availability',
                }),
              ],
            }),
          ),
        ),
    })
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    await user.type(title(), 'Disabled draft')
    await user.click(screen.getByRole('checkbox', { name: 'Active: invitees can book it' }))
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('heading', { name: 'Edit “Disabled draft”', level: 1 })
    await within(readiness()).findByText('Working hours are missing.')
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      title: 'Disabled draft',
      isActive: false,
    })
    expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(
      within(readiness()).getByRole('link', { name: 'Review enablement' }).getAttribute('href'),
    ).toBe('#event-enablement')
  })

  it.each([
    ['self_availability', 'default_schedule_required', '/app/availability', 'Set working hours'],
    [
      'self_schedule',
      'default_schedule_required',
      `/app/availability/${SCHEDULE_ID}`,
      'Review schedule',
    ],
    ['self_calendars', 'calendar_attention_required', '/app/calendars', 'Review calendar sync'],
  ] as const)(
    'points a saved %s gap to the right next step',
    async (fixKind, reasonCode, target, label) => {
      server(eventType({ scheduleId: SCHEDULE_ID }), {
        [SELF_ROUTE]: () =>
          json(
            200,
            selfPage(
              selfCheck({
                summary: 'configuration_blocked',
                signals: [signal({ state: 'configuration_blocker', reasonCode, fixKind })],
              }),
            ),
          ),
      })
      await open()
      const link = await within(readiness()).findByRole('link', { name: label })
      expect(link.getAttribute('href')).toBe(target)
    },
  )

  it('links repairs to the saved schedule and hides them while a different schedule is a draft', async () => {
    const user = userEvent.setup()
    server(eventType({ scheduleId: SCHEDULE_ID }), {
      [SELF_ROUTE]: () =>
        json(
          200,
          selfPage(
            selfCheck({
              summary: 'configuration_blocked',
              signals: [
                signal({
                  state: 'configuration_blocker',
                  reasonCode: 'default_schedule_required',
                  fixKind: 'self_schedule',
                }),
              ],
            }),
          ),
        ),
    })
    await open()
    expect(
      (await within(readiness()).findByRole('link', { name: 'Review schedule' })).getAttribute(
        'href',
      ),
    ).toBe(`/app/availability/${SCHEDULE_ID}`)
    await user.selectOptions(screen.getByLabelText('Schedule'), OTHER_SCHEDULE_ID)
    expect(within(readiness()).getByText(DIRTY)).toBeDefined()
    expect(within(readiness()).queryByRole('link', { name: 'Review schedule' })).toBeNull()
  })

  it('gives an administrator coarse host repairs without another member’s private data or links', async () => {
    const other = '00000000-0000-7000-8000-000000000004'
    const privateSchedule = 'Private evening recovery hours'
    const privateCalendar = 'Private medical appointments'
    const privateEmail = 'private-member@hourmere.invalid'
    const privateCalendarId = 'private-calendar-identifier'
    const item = {
      ...teamCheck({
        summary: 'configuration_blocked',
        reasonCodes: [
          'default_schedule_required',
          'host_configuration_required',
          'calendar_attention_required',
        ],
        fixKinds: ['edit_event', 'ask_member'],
      }),
      fixKinds: [
        'edit_event',
        'ask_member',
        'self_schedule',
        'self_calendars',
      ] as TeamCheck['fixKinds'],
      // A team response must stay coarse even if an extra self-detail field is received.
      signals: [
        signal({
          state: 'configuration_blocker',
          reasonCode: 'default_schedule_required',
          fixKind: 'self_schedule',
        }),
        signal({
          id: 'selected_calendar_sync',
          state: 'dependency_unavailable',
          reasonCode: 'calendar_attention_required',
          fixKind: 'self_calendars',
        }),
      ],
      details: {
        schedules: [
          {
            id: OTHER_SCHEDULE_ID,
            name: privateSchedule,
            timeZone: 'Pacific/Auckland',
            isDefault: true,
          },
        ],
        calendars: [{ id: privateCalendarId, name: privateCalendar, accountEmail: privateEmail }],
      },
    }
    const api = server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        hosts: [{ userId: other }],
        scheduleId: OTHER_SCHEDULE_ID,
      }),
      {
        [TEAM_ROUTE]: () => json(200, teamPage(item)),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: TEAM.organization.id, userId: ME.user.id, role: 'admin' }),
        'GET /api/v1/event-type-hosts': () =>
          json(200, { data: [{ id: other, name: 'Grace' }], nextAfter: null }),
      },
      TEAM,
    )
    await open()
    await within(readiness()).findByText(
      'Ask the hosts to review their personal working hours and calendars.',
    )
    const checks = within(readiness())
    expect(checks.getByRole('link', { name: 'Review hosts' }).getAttribute('href')).toBe(
      '#hosts-heading',
    )
    for (const value of [
      privateSchedule,
      privateCalendar,
      privateEmail,
      privateCalendarId,
      'Pacific/Auckland',
      OTHER_SCHEDULE_ID,
    ]) {
      expect(readiness().textContent).not.toContain(value)
      expect(readiness().innerHTML).not.toContain(value)
    }
    expect(
      checks.queryAllByRole('link', { name: /schedule|calendar|working hours/i }),
    ).toHaveLength(0)
    expect(api.to(SELF_ROUTE)).toHaveLength(0)
    expect(api.to('GET /api/v1/calendar-connections')).toHaveLength(0)
    expect(api.to(`GET /api/v1/schedules/${OTHER_SCHEDULE_ID}`)).toHaveLength(0)
  })

  it('keeps enablement and round-robin activation as explicit next steps alongside host problems', async () => {
    const api = server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        schedulingType: 'round_robin',
        isActive: false,
      }),
      {
        [TEAM_ROUTE]: () =>
          json(
            200,
            teamPage(
              teamCheck({
                enablement: 'disabled',
                activation: 'inactive',
                summary: 'needs_activation',
                reasonCodes: ['activation_required', 'host_configuration_required'],
                fixKinds: ['edit_event', 'ask_member'],
              }),
            ),
          ),
      },
      TEAM,
    )
    await open()
    const checks = within(readiness())
    for (const [name, hash] of [
      ['Review enablement', 'event-enablement'],
      ['Review round-robin activation', 'round-robin-heading'],
      ['Review hosts', 'hosts-heading'],
    ]) {
      expect((await checks.findByRole('link', { name })).getAttribute('href')).toBe(`#${hash}`)
    }
    expect(checks.queryByText('Configuration checks passed')).toBeNull()
    expect(api.to(PATCH_ROUTE)).toHaveLength(0)
    expect(api.to(`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`)).toHaveLength(0)
  })

  it.each([false, true])(
    'offers meeting-setting repairs together with host repairs: %s',
    async (hasHostProblem) => {
      server(
        eventType({ organizationId: TEAM.organization.id, ownerUserId: null }),
        {
          [TEAM_ROUTE]: () =>
            json(
              200,
              teamPage(
                teamCheck({
                  summary: 'configuration_blocked',
                  reasonCodes: [
                    ...(hasHostProblem ? ['host_configuration_required' as const] : []),
                    'optional_feature_attention_required',
                  ],
                  fixKinds: ['edit_event'],
                }),
              ),
            ),
        },
        TEAM,
      )
      await open()
      const checks = within(readiness())
      expect(
        (await checks.findByRole('link', { name: 'Review meeting settings' })).getAttribute('href'),
      ).toBe('#location-heading')
      if (hasHostProblem) {
        expect(
          checks.getByRole('link', { name: 'Review event settings' }).getAttribute('href'),
        ).toBe('#hosts-heading')
      } else {
        expect(checks.queryByRole('link', { name: 'Review event settings' })).toBeNull()
      }
      expect(checks.queryByText('Configuration checks passed')).toBeNull()
    },
  )

  it('does not read team readiness or expose private repair hints for an ordinary member', async () => {
    const api = server(
      eventType({ organizationId: TEAM.organization.id, ownerUserId: null }),
      {
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { organizationId: TEAM.organization.id, userId: ME.user.id, role: 'member' }),
      },
      TEAM,
    )
    await open()
    await within(readiness()).findByText('Readiness checks are unavailable for this account.')
    expect(within(readiness()).queryByRole('link')).toBeNull()
    expect(within(readiness()).queryByRole('button', { name: 'Retry checks' })).toBeNull()
    expect(api.to(TEAM_ROUTE)).toHaveLength(0)
    expect(api.to(SELF_ROUTE)).toHaveLength(0)
  })

  it.each(['en', 'zh-CN'] as const)(
    'hides unavailable checks retry for API-key callers in %s',
    async (language) => {
      chooseLanguage(language)
      const api = server(
        eventType({ organizationId: TEAM.organization.id, ownerUserId: null }),
        {},
        { ...TEAM, principal: { kind: 'api_key', apiKeyId: 'synthetic-api-key' } },
      )
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const checks = await screen.findByRole('region', {
        name: language === 'en' ? 'Saved event checks' : '保存后的配置检查',
      })
      await within(checks).findByText(
        language === 'en'
          ? 'Readiness checks are unavailable for this account.'
          : '此账号无法使用就绪检查。',
      )
      expect(within(checks).queryByRole('button')).toBeNull()
      expect(api.to('GET /api/auth/organization/get-active-member')).toHaveLength(0)
      expect(api.to(TEAM_ROUTE)).toHaveLength(0)
    },
  )

  it('lets a checked manager retry a readiness permission failure', async () => {
    const user = userEvent.setup()
    let checks = 0
    const api = server(
      eventType({ organizationId: TEAM.organization.id, ownerUserId: null }),
      {
        [TEAM_ROUTE]: () =>
          ++checks === 1
            ? json(403, { error: 'team_management_access_denied' })
            : json(200, teamPage()),
      },
      TEAM,
    )
    await open()
    await within(readiness()).findByText('Readiness checks are unavailable for this account.')
    await user.click(within(readiness()).getByRole('button', { name: 'Retry checks' }))
    await within(readiness()).findByText('Configuration checks passed')
    expect(api.to(TEAM_ROUTE)).toHaveLength(2)
  })

  it.each(['individual', 'collective', 'round_robin'] as const)(
    'uses the shared team summary and host next step for %s scheduling',
    async (schedulingType) => {
      const peer = '00000000-0000-7000-8000-000000000004'
      const api = server(
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType,
          hosts:
            schedulingType === 'collective'
              ? [{ userId: ME.user.id }, { userId: peer }]
              : [{ userId: peer }],
        }),
        {
          [TEAM_ROUTE]: () =>
            json(
              200,
              teamPage(
                teamCheck({
                  activation: schedulingType === 'round_robin' ? 'inactive' : 'not_applicable',
                  summary:
                    schedulingType === 'round_robin' ? 'needs_activation' : 'configuration_blocked',
                  reasonCodes: ['default_schedule_required'],
                  fixKinds: ['ask_member'],
                }),
              ),
            ),
          'GET /api/v1/event-type-hosts': () =>
            json(200, {
              data: [
                { id: ME.user.id, name: 'Ada' },
                { id: peer, name: 'Grace' },
              ],
              nextAfter: null,
            }),
        },
        TEAM,
      )
      await open()
      const checks = within(readiness())
      await checks.findByText('Working hours are missing.')
      expect(checks.getByText('Configuration needs attention')).toBeDefined()
      expect(checks.getByRole('link', { name: 'Review hosts' }).getAttribute('href')).toBe(
        '#hosts-heading',
      )
      expect(checks.queryByText('Configuration checks passed')).toBeNull()
      if (schedulingType === 'round_robin')
        expect(
          checks.getByRole('link', { name: 'Review round-robin activation' }).getAttribute('href'),
        ).toBe('#round-robin-heading')
      else expect(checks.queryByRole('link', { name: 'Review round-robin activation' })).toBeNull()
      expect(api.to(TEAM_ROUTE)).toHaveLength(1)
      expect(api.to(SELF_ROUTE)).toHaveLength(0)
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'waits for the team role before denying round-robin management in %s',
    async (language) => {
      chooseLanguage(language)
      const membership = later()
      server(
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
        }),
        {
          'GET /api/auth/organization/get-active-member': () =>
            membership.response.then((response) => response.clone()),
        },
        TEAM,
      )
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const activation = await screen.findByRole('region', {
        name: language === 'en' ? 'Round-robin activation' : '轮询激活',
      })
      const denial =
        language === 'en'
          ? 'Only team owners and admins can change host assignments.'
          : '只有团队所有者和管理员可以修改主持人配置。'
      expect(within(activation).queryByText(denial)).toBeNull()
      expect(within(activation).queryByRole('button')).toBeNull()
      await membership.answer(
        json(200, { organizationId: TEAM.organization.id, userId: ME.user.id, role: 'member' }),
      )
      await within(activation).findByText(denial)
      expect(within(activation).queryByRole('button')).toBeNull()
    },
  )

  it('does not describe a failed role check as denied round-robin management', async () => {
    server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        schedulingType: 'round_robin',
      }),
      { 'GET /api/auth/organization/get-active-member': () => json(503, { error: 'unavailable' }) },
      TEAM,
    )
    await open()
    await screen.findByText('Could not load your team role.')
    const activation = screen.getByRole('region', { name: 'Round-robin activation' })
    expect(
      within(activation).queryByText('Only team owners and admins can change host assignments.'),
    ).toBeNull()
    expect(within(activation).queryByRole('button')).toBeNull()
  })

  it.each(['en', 'zh-CN'] as const)(
    'labels team enablement separately from round-robin bookability in %s',
    async (language) => {
      chooseLanguage(language)
      server(
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
        }),
        {},
        TEAM,
      )
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      await screen.findByRole('heading', {
        name: language === 'en' ? 'Edit “Intro call”' : '编辑“Intro call”',
        level: 1,
      })
      await within(
        screen.getByRole('region', {
          name: language === 'en' ? 'Saved event checks' : '保存后的配置检查',
        }),
      ).findByText(language === 'en' ? 'Configuration checks passed' : '配置检查通过')
      const checkbox = screen.queryByRole<HTMLInputElement>('checkbox', {
        name: language === 'en' ? 'Enable this event type' : '启用此活动类型',
      })
      expect(checkbox).not.toBeNull()
      expect(checkbox?.checked).toBe(true)
      expect(document.querySelector('.booking-link-path')).toBeNull()
      expect(
        screen.queryByRole('checkbox', {
          name: language === 'en' ? 'Active: invitees can book it' : '启用：允许受邀人预约',
        }),
      ).toBeNull()
      expect(screen.queryByRole('link', { name: /View booking page|查看预约页面/ })).toBeNull()
    },
  )

  it.each([
    { state: 'inactive', isActive: false, summary: 'checks_passed' },
    { state: 'no eligible hosts', isActive: true, summary: 'configuration_blocked' },
    { state: 'failed check with known missing hosts', isActive: true, summary: 'check_failed' },
  ] as const)('withholds a round-robin preview URL when $state', async ({ isActive, summary }) => {
    server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        schedulingType: 'round_robin',
        roundRobinActive: true,
        isActive,
      }),
      {
        [TEAM_ROUTE]: () =>
          json(
            200,
            teamPage(
              teamCheck({
                enablement: isActive ? 'enabled' : 'disabled',
                activation: 'active',
                summary,
                reasonCodes: isActive ? ['host_configuration_required'] : [],
                fixKinds: isActive ? ['ask_member'] : [],
              }),
            ),
          ),
      },
      TEAM,
    )
    await open()
    await within(readiness()).findByText(
      isActive ? 'Host settings need attention.' : 'Configuration checks passed',
    )
    expect(document.querySelector('.booking-link-path')).toBeNull()
    expect(screen.queryByRole('link', { name: /View booking page/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
  })

  it.each([
    {
      enablement: 'disabled',
      activation: 'active',
      summary: 'disabled',
      preview: 'This event type is inactive. Enable it and save before sharing.',
      repair: 'Review enablement',
    },
    {
      enablement: 'enabled',
      activation: 'inactive',
      summary: 'needs_activation',
      preview: 'Activate round robin to get a public booking link.',
      repair: 'Review round-robin activation',
    },
  ] as const)(
    'uses readiness $summary when the earlier saved event response is still active',
    async ({ enablement, activation, summary, preview, repair }) => {
      server(
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
          roundRobinActive: true,
          isActive: true,
        }),
        {
          [TEAM_ROUTE]: () => json(200, teamPage(teamCheck({ enablement, activation, summary }))),
        },
        TEAM,
      )
      await open()
      await within(readiness()).findByText('Configuration checks passed')
      expect(document.getElementById('booking-link-status')?.textContent).toBe(preview)
      expect(document.querySelector('.booking-link-path')).toBeNull()
      const share = screen.getByRole('region', { name: 'View and share' })
      expect(within(share).getByRole('link', { name: repair })).toBeDefined()
      expect(within(share).queryByText('Configuration not checked')).toBeNull()
      expect(within(share).queryByText('Configuration needs attention')).toBeNull()
      expect(within(share).queryByRole('button', { name: 'Copy booking link' })).toBeNull()
      expect(within(share).queryByRole('link', { name: /View booking page/ })).toBeNull()
    },
  )

  it.each(
    (['en', 'zh-CN'] as const).flatMap((language) =>
      (['member', 'api_key', 'loading', 'error'] as const).map((state) => ({ language, state })),
    ),
  )(
    'keeps an activated team link copyable with neutral $state readiness in $language',
    async ({ language, state }) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      const pending = later()
      const api = server(
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
          roundRobinActive: true,
        }),
        {
          [TEAM_ROUTE]: () =>
            state === 'loading' ? pending.response : json(503, { error: 'unavailable' }),
          ...(state === 'member' && {
            'GET /api/auth/organization/get-active-member': () =>
              json(200, {
                organizationId: TEAM.organization.id,
                userId: ME.user.id,
                role: 'member',
              }),
          }),
        },
        state === 'api_key'
          ? { ...TEAM, principal: { kind: 'api_key', apiKeyId: 'synthetic-api-key' } }
          : TEAM,
      )
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const checks = await screen.findByRole('region', {
        name: language === 'en' ? 'Saved event checks' : '保存后的配置检查',
      })
      const message =
        state === 'loading'
          ? language === 'en'
            ? 'Checking configuration…'
            : '正在检查配置…'
          : state === 'error'
            ? language === 'en'
              ? 'Configuration check failed'
              : '配置检查失败'
            : language === 'en'
              ? 'Readiness checks are unavailable for this account.'
              : '此账号无法使用就绪检查。'
      await within(checks).findByText(message)
      const preview = document.getElementById('booking-link-status') as HTMLElement
      expect(within(preview).getByText(message)).toBeDefined()
      expect(preview.textContent).not.toContain(
        language === 'en' ? 'Configuration needs attention' : '配置需要处理',
      )
      const hint = document.getElementById('slug-hint') as HTMLElement
      expect(hint.textContent).toBe(
        language === 'en'
          ? 'Lowercase letters, digits and hyphens. You can change this link.'
          : '使用小写字母、数字和连字符。你可以修改此链接。',
      )
      expect(hint.contains(preview)).toBe(false)
      expect(
        document.getElementById('slug')?.getAttribute('aria-describedby')?.split(' '),
      ).toContain('booking-link-status')
      expect(preview.querySelector('.booking-link-path')?.textContent).toBe(
        '/team/design-team/intro-call',
      )
      const share = screen.getByRole('region', {
        name: language === 'en' ? 'View and share' : '查看与分享',
      })
      expect(within(share).getByText(message)).toBeDefined()
      const link = within(share).getByRole('link', { name: /View booking page|查看预约页面/ })
      const url = `${window.location.origin}/team/design-team/intro-call`
      expect(link.getAttribute('href')).toBe(url)
      await user.click(
        within(share).getByRole('button', {
          name: language === 'en' ? 'Copy booking link' : '复制预约链接',
        }),
      )
      expect(await navigator.clipboard.readText()).toBe(url)
      if (state === 'member' || state === 'api_key') {
        expect(
          within(share).queryByRole('button', {
            name: language === 'en' ? 'Retry checks' : '重试检查',
          }),
        ).toBeNull()
        expect(api.to(TEAM_ROUTE)).toHaveLength(0)
      }
      if (state === 'loading') await pending.answer(json(200, teamPage()))
    },
  )

  it('keeps a blocked saved round-robin preview unavailable after editing the draft', async () => {
    const user = userEvent.setup()
    server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        schedulingType: 'round_robin',
        roundRobinActive: true,
      }),
      {
        [TEAM_ROUTE]: () =>
          json(
            200,
            teamPage(
              teamCheck({
                activation: 'active',
                summary: 'configuration_blocked',
                reasonCodes: ['host_configuration_required'],
                fixKinds: ['ask_member'],
              }),
            ),
          ),
      },
      TEAM,
    )
    await open()
    await within(readiness()).findByText('Host settings need attention.')
    await user.type(title(), ' draft')
    expect(within(readiness()).getByText(DIRTY)).toBeDefined()
    expect(document.querySelector('.booking-link-path')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
  })

  it('keeps a saved inactive round-robin preview unavailable after enabling the draft', async () => {
    const user = userEvent.setup()
    server(
      eventType({
        organizationId: TEAM.organization.id,
        ownerUserId: null,
        schedulingType: 'round_robin',
        roundRobinActive: true,
        isActive: false,
      }),
      {},
      TEAM,
    )
    await open()
    await within(readiness()).findByText('Configuration checks passed')
    await user.click(screen.getByRole('checkbox', { name: 'Enable this event type' }))
    expect(within(readiness()).getByText(DIRTY)).toBeDefined()
    expect(document.querySelector('.booking-link-path')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
  })

  it('links personal identity and meeting problems to existing repair destinations', async () => {
    server(eventType(), {
      [SELF_ROUTE]: () =>
        json(
          200,
          selfPage(
            selfCheck({
              summary: 'configuration_blocked',
              signals: [
                signal({
                  id: 'host_eligibility',
                  state: 'configuration_blocker',
                  reasonCode: 'host_configuration_required',
                  fixKind: 'self_profile',
                }),
                signal({
                  id: 'optional_conference_dependency',
                  state: 'configuration_blocker',
                  reasonCode: 'optional_feature_attention_required',
                  fixKind: 'event_editor',
                }),
              ],
            }),
          ),
        ),
    })
    await open()
    const checks = within(readiness())
    expect((await checks.findByRole('link', { name: 'Review profile' })).getAttribute('href')).toBe(
      '/app/settings',
    )
    const meetingTarget = checks
      .getByRole('link', { name: 'Review meeting settings' })
      .getAttribute('href')
    expect(meetingTarget).toBe('#location-heading')
    expect(document.querySelector(meetingTarget as string)).not.toBeNull()
    expect(document.getElementById('hosts')).toBeNull()
    expect(readiness().querySelector('a[href="#hosts"]')).toBeNull()
    expect(checks.queryByRole('link', { name: 'Review event settings' })).toBeNull()
  })
})
