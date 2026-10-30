import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
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
import { EVENT_TYPE_ID, eventType, SCHEDULE_ID, schedule } from '../../test/fixtures.ts'

type SelfCheck = Schemas['SelfReadinessPage']['eventTypes']['data'][number]
type Signal = SelfCheck['signals'][number]
type TeamCheck = Schemas['TeamReadinessPage']['eventTypes']['data'][number]

const NOW = '2026-10-28T12:00:00.000Z'
const SECOND_ID = 'e0000000-0000-7000-8000-000000000002'
const THIRD_ID = 'e0000000-0000-7000-8000-000000000003'
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
const teamRoute = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
const row = (title = 'Intro call') =>
  screen.getByRole('rowheader', { name: title }).closest('tr') as HTMLElement
const configuration = (title = 'Intro call', language: 'en' | 'zh-CN' = 'en') => {
  const label = language === 'en' ? 'Configuration checks' : '配置检查'
  const cell = row(title).querySelector<HTMLElement>(`[data-label="${label}"]`)
  expect(cell, `separate ${label} cell`).not.toBeNull()
  return cell as HTMLElement
}

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
    signals: [
      signal(),
      signal({ id: 'host_eligibility' }),
      signal({ id: 'conflict_calendar_selection', state: 'not_applicable' }),
      signal({ id: 'selected_calendar_sync', state: 'not_applicable' }),
      signal({ id: 'optional_conference_dependency', state: 'not_applicable' }),
      signal({ id: 'slot_observation', state: 'not_checked', checkedAt: null }),
    ],
    details: { schedules: [], calendars: [] },
    ...overrides,
  }
}

function selfPage(
  data: SelfCheck[] = [selfCheck()],
  nextCursor: string | null = null,
): Schemas['SelfReadinessPage'] {
  return {
    member: selfCheck({
      subject: {
        kind: 'member',
        id: 'd0000000-0000-7000-8000-000000000001',
        organizationId: ME.organization.id,
      },
      enablement: 'not_applicable',
      details: {
        schedules: [
          { id: SCHEDULE_ID, name: 'Working hours', timeZone: 'Europe/Berlin', isDefault: true },
        ],
        calendars: [],
      },
    }),
    eventTypes: { data, nextCursor },
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

function teamPage(
  data: TeamCheck[] = [teamCheck()],
  nextCursor: string | null = null,
): Schemas['TeamReadinessPage'] {
  return {
    organizationId: TEAM.organization.id,
    members: { data: [], nextCursor: null },
    eventTypes: { data, nextCursor },
  }
}

function server(events: EventType[] = [eventType()], overrides: Routes = {}, me = ME) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () => json(200, { data: events }),
    'GET /api/v1/readiness/self': () => json(200, selfPage()),
    [teamRoute]: () => json(200, teamPage()),
    ...overrides,
  })
}

async function open() {
  renderApp('/app/event-types')
  await screen.findByRole('rowheader', { name: 'Intro call' })
}

describe('event type configuration checks', () => {
  it.each(['en', 'zh-CN'] as const)(
    'separates enabled, unlisted and configuration state from disabled complete configuration in %s',
    async (language) => {
      chooseLanguage(language)
      server(
        [
          eventType({ isHidden: true }),
          eventType({
            id: SECOND_ID,
            title: 'Disabled complete',
            slug: 'disabled',
            isActive: false,
          }),
        ],
        {
          'GET /api/v1/readiness/self': () =>
            json(
              200,
              selfPage([
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
                selfCheck({
                  subject: {
                    kind: 'event_type',
                    id: SECOND_ID,
                    organizationId: ME.organization.id,
                  },
                  enablement: 'disabled',
                  summary: 'disabled',
                }),
              ]),
            ),
        },
      )
      await open()
      await within(configuration('Intro call', language)).findByText(
        language === 'en' ? 'Configuration needs attention' : '配置需要处理',
      )
      const enabled = within(row())
      expect(enabled.getByText(language === 'en' ? 'Active' : '启用')).toBeDefined()
      expect(enabled.getByText(language === 'en' ? 'Unlisted' : '仅限链接')).toBeDefined()
      const disabled = within(row('Disabled complete'))
      expect(disabled.getByText(language === 'en' ? 'Inactive' : '未启用')).toBeDefined()
      expect(
        within(configuration('Disabled complete', language)).getByText(
          language === 'en' ? 'Configuration checks passed' : '配置检查通过',
        ),
      ).toBeDefined()
      expect(configuration('Intro call', language).querySelector('.badge-success')).toBeNull()
      expect(
        configuration('Disabled complete', language).querySelector('.badge-success'),
      ).not.toBeNull()
      expect(
        within(configuration('Intro call', language)).getByRole('link').getAttribute('href'),
      ).toBe('/app/availability')
      expect(
        screen.getByText(
          language === 'en'
            ? 'Configuration checks do not guarantee available times. Check the booking page for current availability.'
            : '配置检查不保证有可约时段。当前可约时间以预约页为准。',
        ),
      ).toBeDefined()
    },
  )

  it('keeps a known configuration gap visible even when the summary is disabled', async () => {
    server([eventType({ isActive: false })], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
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
          ]),
        ),
    })
    await open()
    await within(configuration()).findByText('Configuration needs attention')
    expect(within(row()).getByText('Inactive')).toBeDefined()
    expect(configuration().querySelector('.badge-success')).toBeNull()
  })

  it.each([
    { summary: 'not_checked', completeness: 'partial', state: 'not_checked', checkedAt: null },
    { summary: 'check_failed', completeness: 'partial', state: 'check_failed', checkedAt: NOW },
    { summary: 'checks_passed', completeness: 'partial', state: 'satisfied', checkedAt: NOW },
    { summary: 'checks_passed', completeness: 'complete', state: 'not_checked', checkedAt: null },
    { summary: 'checks_passed', completeness: 'complete', state: 'check_failed', checkedAt: NOW },
  ] as const)(
    'keeps $summary / $completeness / $state neutral and offers a retry',
    async (testCase) => {
      server([eventType()], {
        'GET /api/v1/readiness/self': () =>
          json(
            200,
            selfPage([
              selfCheck({
                summary: testCase.summary,
                completeness: testCase.completeness,
                signals: [
                  signal({
                    state: testCase.state,
                    checkedAt: testCase.checkedAt,
                    fixKind: 'retry_summary',
                  }),
                ],
              }),
            ]),
          ),
      })
      await open()
      await waitFor(() =>
        expect(
          within(configuration()).queryByRole('button', { name: 'Retry checks' }),
        ).not.toBeNull(),
      )
      expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
      expect(configuration().querySelector('.badge-success')).toBeNull()
      expect(within(row()).getByText('Active')).toBeDefined()
    },
  )

  it.each(['not_checked', 'check_failed'] as const)(
    'keeps an explicit %s summary neutral even if its signals look complete',
    async (summary) => {
      server([eventType()], {
        'GET /api/v1/readiness/self': () => json(200, selfPage([selfCheck({ summary })])),
      })
      await open()
      await within(configuration()).findByRole('button', { name: 'Retry checks' })
      expect(configuration().querySelector('.badge-success')).toBeNull()
      expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
    },
  )

  it.each(['configuration_blocked', 'dependency_unavailable'] as const)(
    'keeps a %s summary neutral if the reported issue is missing',
    async (summary) => {
      server([eventType()], {
        'GET /api/v1/readiness/self': () => json(200, selfPage([selfCheck({ summary })])),
      })
      await open()
      await within(configuration()).findByRole('button', { name: 'Retry checks' })
      expect(configuration().querySelector('.badge-success')).toBeNull()
      expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
    },
  )

  it('does not invent a configuration problem from empty weekly hours or no external calendars', async () => {
    const api = server([eventType({ maxBookingsPerDay: 1 })], {
      'GET /api/v1/schedules': () => json(200, { data: [schedule({ weeklyHours: {} })] }),
    })
    await open()
    await within(configuration()).findByText('Configuration checks passed')
    expect(configuration().textContent).not.toMatch(/Needs configuration|calendar attention/i)
    expect(api.calls.some((call) => /slots|calendar-connections/.test(call.path))).toBe(false)
    expect(api.to('GET /api/v1/readiness/self')).toHaveLength(1)
    expect(api.to(teamRoute)).toHaveLength(0)
    expect(
      screen.getByText(
        'Configuration checks do not guarantee available times. Check the booking page for current availability.',
      ),
    ).toBeDefined()
  })

  it('retains the calendar fix for a known unsupported conflict source while the result stays unknown', async () => {
    server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
            selfCheck({
              summary: 'not_checked',
              completeness: 'partial',
              signals: [
                signal({
                  id: 'selected_calendar_sync',
                  state: 'not_checked',
                  reasonCode: 'unsupported_conflict_provider',
                  checkedAt: null,
                  fixKind: 'self_calendars',
                }),
              ],
            }),
          ]),
        ),
    })
    await open()
    await within(configuration()).findByText('Selected calendars cannot provide conflict checks.')
    expect(
      within(configuration())
        .getByRole('link', { name: 'Review calendar sync' })
        .getAttribute('href'),
    ).toBe('/app/calendars')
    expect(within(configuration()).getByRole('button', { name: 'Retry checks' })).toBeDefined()
    expect(configuration().querySelector('.badge-success')).toBeNull()
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })

  it('leaves an event missing from a successful readiness page neutral instead of assuming success', async () => {
    server([eventType()], {
      'GET /api/v1/readiness/self': () => json(200, selfPage([])),
    })
    await open()
    await within(configuration()).findByRole('button', { name: 'Retry checks' })
    expect(configuration().querySelector('.badge-success')).toBeNull()
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })

  it('loads every readiness page using eventTypeCursor before judging later events', async () => {
    const pending = later()
    const api = server(
      [eventType(), eventType({ id: SECOND_ID, title: 'Second event', slug: 'second' })],
      {
        'GET /api/v1/readiness/self': ({ path }) =>
          new URL(path, window.location.origin).searchParams.has('eventTypeCursor')
            ? pending.response
            : json(200, selfPage([selfCheck()], EVENT_TYPE_ID)),
      },
    )
    await open()
    await waitFor(() => expect(api.to('GET /api/v1/readiness/self')).toHaveLength(2))
    expect(
      new URL(
        api.to('GET /api/v1/readiness/self')[1]?.path ?? '',
        window.location.origin,
      ).searchParams.get('eventTypeCursor'),
    ).toBe(EVENT_TYPE_ID)
    expect(configuration('Second event').querySelector('.badge-success')).toBeNull()
    await pending.answer(
      json(
        200,
        selfPage([
          selfCheck({
            subject: { kind: 'event_type', id: SECOND_ID, organizationId: ME.organization.id },
            summary: 'dependency_unavailable',
            signals: [
              signal({
                id: 'selected_calendar_sync',
                state: 'dependency_unavailable',
                reasonCode: 'sync_not_ready',
                fixKind: 'self_calendars',
              }),
            ],
          }),
        ]),
      ),
    )
    await within(configuration('Second event')).findByText('Calendar sync needs attention')
    expect(
      within(configuration('Intro call')).getByText('Configuration checks passed'),
    ).toBeDefined()
  })

  it('keeps the list usable after a readiness request fails and retries only the checks', async () => {
    const user = userEvent.setup()
    let recovered = false
    const api = server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        recovered ? json(200, selfPage()) : json(500, { error: 'internal_error' }),
    })
    await open()
    await within(configuration()).findByText('Configuration check failed')
    expect(within(row()).getByRole('link', { name: 'Edit Intro call' })).toBeDefined()
    expect(configuration().querySelector('.badge-success')).toBeNull()
    recovered = true
    await user.click(within(configuration()).getByRole('button', { name: 'Retry checks' }))
    await within(configuration()).findByText('Configuration checks passed')
    expect(api.to('GET /api/v1/readiness/self')).toHaveLength(2)
    expect(api.to('GET /api/v1/event-types')).toHaveLength(1)
  })

  it('allows a stalled configuration check to be retried and ignores its late response', async () => {
    const user = userEvent.setup()
    const pending = later()
    let attempts = 0
    server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        ++attempts === 1 ? pending.response : json(200, selfPage()),
    })
    await open()
    expect(within(configuration()).getByText('Checking configuration…')).toBeDefined()
    expect(configuration().querySelector('.badge-success')).toBeNull()
    await user.click(within(configuration()).getByRole('button', { name: 'Retry checks' }))
    await within(configuration()).findByText('Configuration checks passed')
    await pending.answer(json(500, { error: 'internal_error' }))
    expect(within(configuration()).getByText('Configuration checks passed')).toBeDefined()
    expect(within(configuration()).queryByText('Configuration check failed')).toBeNull()
  })

  it.each([
    ['event_editor', `/app/event-types/${EVENT_TYPE_ID}`],
    ['self_availability', '/app/availability'],
    ['self_schedule', '/app/availability'],
    ['self_calendars', '/app/calendars'],
    ['self_identity', '/sign-in'],
    ['self_profile', '/app/settings'],
    ['self_conferences', '/app/conferences'],
  ] as const)('links the %s fix to its own setting', async (fixKind, target) => {
    server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
            selfCheck({
              summary: 'configuration_blocked',
              signals: [
                signal({ state: 'configuration_blocker', reasonCode: 'fix_required', fixKind }),
              ],
            }),
          ]),
        ),
    })
    await open()
    const link = await within(configuration()).findByRole('link')
    expect(link.getAttribute('href')).toBe(target)
  })

  it('links an explicitly selected schedule directly to its editor', async () => {
    server([eventType({ scheduleId: SCHEDULE_ID })], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
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
          ]),
        ),
    })
    await open()
    const link = await within(configuration()).findByRole('link', { name: 'Review schedule' })
    expect(link.getAttribute('href')).toBe(`/app/availability/${SCHEDULE_ID}`)
  })

  it.each(['en', 'zh-CN'] as const)(
    'ignores unknown repair kinds while retaining known fixes and the event list in %s',
    async (language) => {
      chooseLanguage(language)
      server([eventType()], {
        'GET /api/v1/readiness/self': () =>
          json(
            200,
            selfPage([
              selfCheck({
                summary: 'configuration_blocked',
                signals: [
                  ...['future_fix', 'constructor', 'toString'].map((fixKind) =>
                    signal({
                      state: 'configuration_blocker',
                      reasonCode: 'future_configuration_required',
                      fixKind: fixKind as Signal['fixKind'],
                    }),
                  ),
                  signal({
                    state: 'configuration_blocker',
                    reasonCode: 'default_schedule_required',
                    fixKind: 'self_availability',
                  }),
                ],
              }),
            ]),
          ),
      })
      await open()
      const checks = within(configuration('Intro call', language))
      const link = await checks.findByRole('link', {
        name: language === 'en' ? 'Set working hours' : '设置工作时间',
      })
      expect(link.getAttribute('href')).toBe('/app/availability')
      expect(checks.getAllByRole('link')).toHaveLength(1)
      expect(
        checks.getByText(language === 'en' ? 'Configuration needs attention' : '配置需要处理', {
          selector: '.badge',
        }),
      ).toBeDefined()
      expect(
        checks.queryByText(language === 'en' ? 'Configuration checks passed' : '配置检查通过'),
      ).toBeNull()
    },
  )

  it('rejects personal readiness from a different organization', async () => {
    const body = selfPage()
    body.member.subject.organizationId = TEAM.organization.id
    server([eventType()], {
      'GET /api/v1/readiness/self': () => json(200, body),
    })
    await open()
    await within(configuration()).findByRole('button', { name: 'Retry checks' })
    expect(configuration().querySelector('.badge-success')).toBeNull()
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })

  it('rejects a personal event result from a different organization', async () => {
    server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
            selfCheck({
              subject: {
                kind: 'event_type',
                id: EVENT_TYPE_ID,
                organizationId: TEAM.organization.id,
              },
            }),
          ]),
        ),
    })
    await open()
    await within(configuration()).findByRole('button', { name: 'Retry checks' })
    expect(configuration().querySelector('.badge-success')).toBeNull()
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })

  it('stops a repeated cursor with a retryable failure rather than looping or claiming success', async () => {
    const api = server([eventType()], {
      'GET /api/v1/readiness/self': () => json(200, selfPage([selfCheck()], EVENT_TYPE_ID)),
    })
    await open()
    await within(configuration()).findByText('Configuration check failed')
    expect(api.to('GET /api/v1/readiness/self')).toHaveLength(2)
    expect(configuration().querySelector('.badge-success')).toBeNull()
  })

  it('offers distinct entries for simultaneous schedule, calendar and conference issues', async () => {
    server([eventType()], {
      'GET /api/v1/readiness/self': () =>
        json(
          200,
          selfPage([
            selfCheck({
              summary: 'configuration_blocked',
              signals: [
                signal({
                  state: 'configuration_blocker',
                  reasonCode: 'default_schedule_required',
                  fixKind: 'self_availability',
                }),
                signal({
                  id: 'selected_calendar_sync',
                  state: 'dependency_unavailable',
                  reasonCode: 'calendar_attention_required',
                  fixKind: 'self_calendars',
                }),
                signal({
                  id: 'optional_conference_dependency',
                  state: 'configuration_blocker',
                  reasonCode: 'optional_feature_attention_required',
                  fixKind: 'self_conferences',
                }),
              ],
            }),
          ]),
        ),
    })
    await open()
    await waitFor(() => expect(within(configuration()).getAllByRole('link')).toHaveLength(3))
    expect(
      within(configuration())
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(expect.arrayContaining(['/app/availability', '/app/calendars', '/app/conferences']))
  })
})

describe('team event type configuration checks', () => {
  it.each(['en', 'zh-CN'] as const)(
    'keeps round-robin enablement separate from activation and shows complete saved configuration in %s',
    async (language) => {
      chooseLanguage(language)
      const api = server(
        [
          eventType({ ownerUserId: null, schedulingType: 'round_robin', isHidden: true }),
          eventType({
            id: SECOND_ID,
            title: 'Active pool',
            slug: 'active-pool',
            ownerUserId: null,
            schedulingType: 'round_robin',
            roundRobinActive: true,
            isActive: false,
          }),
        ],
        {
          [teamRoute]: () =>
            json(
              200,
              teamPage([
                teamCheck({
                  summary: 'needs_activation',
                  activation: 'inactive',
                  reasonCodes: ['activation_required'],
                  fixKinds: ['edit_event'],
                }),
                teamCheck({
                  eventTypeId: SECOND_ID,
                  summary: 'disabled',
                  enablement: 'disabled',
                  activation: 'active',
                }),
              ]),
            ),
        },
        TEAM,
      )
      await open()
      await within(configuration('Intro call', language)).findByText(
        language === 'en' ? 'Configuration checks passed' : '配置检查通过',
      )
      expect(within(configuration('Intro call', language)).queryByRole('link')).toBeNull()
      expect(within(row()).getByText(language === 'en' ? 'Active' : '启用')).toBeDefined()
      expect(
        within(row()).getByText(language === 'en' ? 'Needs activation' : '待激活'),
      ).toBeDefined()
      expect(within(row()).getByText(language === 'en' ? 'Unlisted' : '仅限链接')).toBeDefined()
      const active = within(row('Active pool'))
      expect(active.getByText(language === 'en' ? 'Inactive' : '未启用')).toBeDefined()
      expect(
        active.getByText(language === 'en' ? 'Round robin activated' : '轮询已激活'),
      ).toBeDefined()
      expect(api.to(teamRoute)).toHaveLength(1)
      expect(api.to('GET /api/v1/readiness/self')).toHaveLength(0)
    },
  )

  it.each([
    ['default_schedule_required', false],
    ['calendar_attention_required', false],
    ['host_configuration_required', true],
    ['optional_feature_attention_required', true],
  ] as const)(
    'keeps event-setting repairs only when the inactive pool also has %s',
    async (reasonCode, needsEventSettings) => {
      server(
        [eventType({ ownerUserId: null, schedulingType: 'round_robin' })],
        {
          [teamRoute]: () =>
            json(
              200,
              teamPage([
                teamCheck({
                  summary: 'needs_activation',
                  activation: 'inactive',
                  reasonCodes: ['activation_required', reasonCode],
                  fixKinds: ['edit_event', 'ask_member'],
                }),
              ]),
            ),
        },
        TEAM,
      )
      await open()
      const checks = within(configuration())
      await checks.findByRole('link', { name: 'Review hosts' })
      expect(checks.queryByRole('link', { name: 'Review event settings' }) !== null).toBe(
        needsEventSettings,
      )
      expect(checks.queryByText('Configuration checks passed')).toBeNull()
      expect(checks.queryByText('Needs activation')).toBeNull()
      expect(within(row()).getByRole('link', { name: 'Needs activation' })).toBeDefined()
    },
  )

  it('keeps private member problems coarse and sends administrators to the event editor', async () => {
    server(
      [eventType({ ownerUserId: null })],
      {
        [teamRoute]: () =>
          json(
            200,
            teamPage([
              teamCheck({
                summary: 'configuration_blocked',
                reasonCodes: [
                  'default_schedule_required',
                  'host_configuration_required',
                  'calendar_attention_required',
                  'optional_feature_attention_required',
                ],
                fixKinds: ['edit_event', 'ask_member'],
              }),
            ]),
          ),
      },
      TEAM,
    )
    await open()
    await within(configuration()).findByText('Configuration needs attention')
    const checks = within(configuration())
    expect(
      checks.getByText('Ask the hosts to review their personal working hours and calendars.'),
    ).toBeDefined()
    expect(checks.getByRole('link', { name: 'Review event settings' }).getAttribute('href')).toBe(
      `/app/event-types/${EVENT_TYPE_ID}`,
    )
    expect(checks.getByRole('link', { name: 'Review hosts' }).getAttribute('href')).toBe(
      `/app/event-types/${EVENT_TYPE_ID}#hosts`,
    )
    expect(checks.queryByRole('link', { name: /calendar|availability/i })).toBeNull()
    expect(configuration().textContent).toContain('Calendar sync needs attention')
  })

  it('loads later team event pages without walking unrelated member pages', async () => {
    const api = server(
      [eventType({ ownerUserId: null }), eventType({ id: SECOND_ID, title: 'Later team event' })],
      {
        [teamRoute]: ({ path }) => {
          const cursor = new URL(path, window.location.origin).searchParams.get('eventTypeCursor')
          const page = cursor
            ? teamPage([teamCheck({ eventTypeId: SECOND_ID, summary: 'partial_pool' })])
            : teamPage([teamCheck()], EVENT_TYPE_ID)
          page.members.nextCursor = THIRD_ID
          return json(200, page)
        },
      },
      TEAM,
    )
    await open()
    await within(configuration('Later team event')).findByText('Some hosts need attention')
    expect(api.to(teamRoute)).toHaveLength(2)
    expect(
      api
        .to(teamRoute)
        .some((call) =>
          new URL(call.path, window.location.origin).searchParams.has('memberCursor'),
        ),
    ).toBe(false)
    expect(configuration('Later team event').querySelector('.badge-success')).toBeNull()
  })

  it('retries an unknown team result instead of accepting a green summary', async () => {
    const user = userEvent.setup()
    let recovered = false
    const api = server(
      [eventType({ ownerUserId: null })],
      {
        [teamRoute]: () =>
          json(
            200,
            teamPage([
              teamCheck(
                recovered
                  ? {}
                  : {
                      summary: 'checks_passed',
                      completeness: 'partial',
                      reasonCodes: ['check_not_performed'],
                      fixKinds: ['retry_summary'],
                    },
              ),
            ]),
          ),
      },
      TEAM,
    )
    await open()
    await within(configuration()).findByText('Configuration not checked')
    expect(configuration().querySelector('.badge-success')).toBeNull()
    recovered = true
    await user.click(within(configuration()).getByRole('button', { name: 'Retry checks' }))
    await within(configuration()).findByText('Configuration checks passed')
    expect(api.to(teamRoute)).toHaveLength(2)
  })

  it.each(['check_not_performed', 'check_failed'] as const)(
    'keeps the team reason %s neutral even if the summary looks complete',
    async (reason) => {
      server(
        [eventType({ ownerUserId: null })],
        {
          [teamRoute]: () =>
            json(
              200,
              teamPage([teamCheck({ reasonCodes: [reason], fixKinds: ['retry_summary'] })]),
            ),
        },
        TEAM,
      )
      await open()
      await within(configuration()).findByRole('button', { name: 'Retry checks' })
      expect(configuration().querySelector('.badge-success')).toBeNull()
      expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
    },
  )

  it('rejects a readiness response for a different team instead of showing its success', async () => {
    server(
      [eventType({ ownerUserId: null })],
      {
        [teamRoute]: () => json(200, { ...teamPage(), organizationId: ME.organization.id }),
      },
      TEAM,
    )
    await open()
    await within(configuration()).findByRole('button', { name: 'Retry checks' })
    expect(configuration().querySelector('.badge-success')).toBeNull()
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })

  it('ignores a late personal result after a focus refresh changes the team context', async () => {
    const pending = later()
    let active = ME
    server([eventType()], {
      'GET /api/v1/me': () => json(200, active),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          organizationId: active.organization.id,
          userId: active.user.id,
          role: 'owner',
        }),
      'GET /api/v1/event-types': () =>
        json(200, {
          data: [eventType({ ownerUserId: active.organization.personal ? ME.user.id : null })],
        }),
      'GET /api/v1/readiness/self': () => pending.response,
      [teamRoute]: () =>
        json(
          200,
          teamPage([
            teamCheck({
              summary: 'configuration_blocked',
              reasonCodes: ['host_configuration_required'],
              fixKinds: ['edit_event'],
            }),
          ]),
        ),
    })
    await open()
    active = TEAM
    await act(async () => fireEvent.focus(window))
    await waitFor(() =>
      expect(configuration().textContent).toContain('Configuration needs attention'),
    )
    await pending.answer(json(200, selfPage()))
    expect(configuration().textContent).toContain('Configuration needs attention')
    expect(within(configuration()).queryByText('Configuration checks passed')).toBeNull()
  })
})
