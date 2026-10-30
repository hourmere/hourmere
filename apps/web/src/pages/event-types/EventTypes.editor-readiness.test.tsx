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
const DIRTY = 'These unsaved changes have not been checked yet. Save to check the saved version.'
const title = () => screen.getByLabelText<HTMLInputElement>('Title', { exact: true })
const readiness = () => screen.getByRole('region', { name: 'Saved version readiness' })

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
        'These checks describe the saved version. Availability is confirmed when someone books.',
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
        name: language === 'en' ? 'Saved version readiness' : '已保存版本的就绪检查',
      })
      const passed = language === 'en' ? 'Configuration checks passed' : '配置检查通过'
      await within(region).findByText(passed)
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
          language === 'en' ? DIRTY : '尚未检查这些未保存的更改。保存后可检查已保存版本。',
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
    expect(checks.getByRole('link', { name: 'Review hosts' }).getAttribute('href')).toBe('#hosts')
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
      ['Review hosts', 'hosts'],
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
        ).toBe('#hosts')
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
    expect(api.to(TEAM_ROUTE)).toHaveLength(0)
    expect(api.to(SELF_ROUTE)).toHaveLength(0)
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
