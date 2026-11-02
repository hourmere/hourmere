import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import type { EventType, Schedule } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, OTHER_SCHEDULE_ID, schedule } from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const CREATED_ID = 'e0000000-0000-7000-8000-000000000002'
const CREATE_ROUTE = 'POST /api/v1/event-types'
const PATCH_ROUTE = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
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
const TEAM_ROUTE = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
const MEMBER_ROUTE = 'GET /api/auth/organization/get-active-member'
type TeamCheck = Schemas['TeamReadinessPage']['eventTypes']['data'][number]

function teamPage(
  events: EventType[] = [eventType()],
  overrides: Partial<TeamCheck> = {},
): Schemas['TeamReadinessPage'] {
  return {
    organizationId: TEAM.organization.id,
    members: { data: [], nextCursor: null },
    eventTypes: {
      data: events.map((event) => ({
        eventTypeId: event.id,
        enablement: 'enabled',
        activation: 'not_applicable',
        summary: 'checks_passed',
        completeness: 'complete',
        evaluatedAt: '2026-10-30T12:00:00.000Z',
        reasonCodes: [],
        fixKinds: [],
        ...overrides,
      })),
      nextCursor: null,
    },
  }
}

const location = () => screen.getByTestId('location').textContent
const title = () => screen.getByLabelText<HTMLInputElement>('Title', { exact: true })
const share = () => screen.getByRole('region', { name: 'View and share' })
const bookingUrl = (slug = 'intro-call') => `${window.location.origin}/ada/${slug}`

/** Saved records are read back after create, as they are by the real editor route. */
function server(initial: EventType[] = [eventType()], overrides: Routes = {}, me = ME) {
  let list = [...initial]
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
    'GET /api/v1/event-types': () => json(200, { data: list }),
    [TEAM_ROUTE]: () => json(200, teamPage(list)),
    ...Object.fromEntries(
      [EVENT_TYPE_ID, CREATED_ID].map((id) => [
        `GET /api/v1/event-types/${id}`,
        () => {
          const saved = list.find((item) => item.id === id)
          return saved ? json(200, saved) : json(404, { error: 'event_type_not_found' })
        },
      ]),
    ),
    [CREATE_ROUTE]: ({ body }) => {
      const created = eventType({
        ...(body as Partial<EventType>),
        id: CREATED_ID,
        organizationId: me.organization.id,
        ownerUserId: me.organization.personal ? me.user.id : null,
      })
      list = [...list, created]
      return json(201, created)
    },
    [PATCH_ROUTE]: ({ body }) => {
      const saved = list.find((item) => item.id === EVENT_TYPE_ID) as EventType
      const updated = { ...saved, ...(body as Partial<EventType>) }
      list = list.map((item) => (item.id === updated.id ? updated : item))
      return json(200, updated)
    },
    ...overrides,
  })
}

async function openExisting() {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
}

async function openNew() {
  renderApp('/app/event-types/new')
  await screen.findByRole('heading', { name: 'New event type', level: 1 })
}

function expectNoShareActions(region: HTMLElement = share()) {
  expect(within(region).queryByRole('link', { name: /View booking page/ })).toBeNull()
  expect(within(region).queryByRole('button', { name: 'Copy booking link' })).toBeNull()
}

function expectShareHashTargets() {
  const links = share().querySelectorAll<HTMLAnchorElement>('a[href^="#"]')
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) {
    expect(document.getElementById(link.hash.slice(1))).not.toBeNull()
  }
}

function teamRole(role: 'owner' | 'member'): Routes {
  return {
    [MEMBER_ROUTE]: () =>
      json(200, {
        id: 'membership-1',
        organizationId: TEAM.organization.id,
        userId: TEAM.user.id,
        role,
        createdAt: '2026-10-01T09:00:00.000Z',
      }),
  }
}

describe('viewing and sharing the saved event type', () => {
  it('opens the saved editor after creation and copies its full link with the keyboard', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = server([])
    await openNew()
    await user.type(title(), 'First call')
    expect(screen.queryByRole('region', { name: 'View and share' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Copy.*link/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create event type' }))

    await screen.findByRole('heading', { name: 'Edit “First call”', level: 1 })
    const heading = within(share()).getByRole('heading', { name: 'View and share' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.id).toBe('view-and-share')
    expect(location()).toBe(`/app/event-types/${CREATED_ID}`)
    const link = within(share()).getByRole('link', { name: /View booking page/ })
    expect(link.getAttribute('href')).toBe(bookingUrl('first-call'))
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')?.split(' ')).toContain('noopener')
    await user.tab()
    expect(document.activeElement).toBe(link)
    await user.tab()
    const copy = within(share()).getByRole('button', { name: 'Copy booking link' })
    expect(document.activeElement).toBe(copy)
    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe(bookingUrl('first-call'))
    expect(await within(share()).findByText('Copied')).toBeDefined()
    expect(api.to(CREATE_ROUTE)).toHaveLength(1)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('focuses sharing after an update and exposes the server’s saved slug', async () => {
    const user = userEvent.setup()
    const api = server([eventType()], {
      [PATCH_ROUTE]: ({ body }) =>
        json(200, eventType({ ...(body as Partial<EventType>), slug: 'saved-on-server' })),
    })
    await openExisting()
    await user.clear(screen.getByLabelText('Booking link'))
    await user.type(screen.getByLabelText('Booking link'), 'submitted-slug')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved.')

    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(share()).getByRole('heading', { name: 'View and share' }),
      ),
    )
    expect(
      within(share())
        .getByRole('link', { name: /View booking page/ })
        .getAttribute('href'),
    ).toBe(bookingUrl('saved-on-server'))
    await user.click(within(share()).getByRole('button', { name: 'Copy booking link' }))
    expect(await navigator.clipboard.readText()).toBe(bookingUrl('saved-on-server'))
    expect(api.to(PATCH_ROUTE)[0]?.body).toHaveProperty('slug', 'submitted-slug')
  })

  it('keeps an unsaved slug out of the published link and retains the leave reminder', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = server()
    await openExisting()
    await user.clear(screen.getByLabelText('Booking link'))
    await user.type(screen.getByLabelText('Booking link'), 'unsaved-private-draft')

    expect(
      within(share())
        .getByRole('link', { name: /View booking page/ })
        .getAttribute('href'),
    ).toBe(bookingUrl())
    expect(share().textContent).not.toContain('unsaved-private-draft')
    expect(share().textContent).toMatch(/saved version/i)
    await user.click(within(share()).getByRole('button', { name: 'Copy booking link' }))
    expect(await navigator.clipboard.readText()).toBe(bookingUrl())
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(location()).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(screen.getByLabelText<HTMLInputElement>('Booking link').value).toBe(
      'unsaved-private-draft',
    )
    expect(api.to(PATCH_ROUTE)).toHaveLength(0)
  })

  it.each([null, { ...PROFILE, handle: '' }, { ...PROFILE, handle: 'app' }])(
    'links a missing profile or handle to profile settings: %s',
    async (savedProfile) => {
      server([eventType()], profile(savedProfile))
      await openExisting()
      expectNoShareActions()
      expect(share().querySelector('a[href="/app/settings"]')).not.toBeNull()
      expect(share().textContent).toMatch(/profile|handle/i)
    },
  )

  it.each([
    ['no schedules', [], '/app/event-types#personal-setup-heading'],
    ['no default schedule', [schedule({ isDefault: false })], '/app/availability'],
    ['invalid default time zone', [schedule({ timeZone: 'Invalid/Zone' })], '/app/availability'],
    ['default with no hours', [schedule({ weeklyHours: {} })], '/app/availability'],
  ] satisfies [string, Schedule[], string][])(
    'explains %s and links to availability instead of advertising a link',
    async (_name, schedules, destination) => {
      server([eventType()], {
        'GET /api/v1/schedules': () => json(200, { data: schedules }),
      })
      await openExisting()
      expectNoShareActions()
      expect(share().querySelector(`a[href="${destination}"]`)).not.toBeNull()
      expect(share().textContent).toMatch(/availability|working hours|schedule/i)
    },
  )

  it.each([
    ['no default schedule', [schedule({ id: OTHER_SCHEDULE_ID, isDefault: false })]],
    [
      'an invalid default schedule',
      [schedule({ weeklyHours: {} }), schedule({ id: OTHER_SCHEDULE_ID, isDefault: false })],
    ],
  ] satisfies [string, Schedule[]][])(
    'shares a personal event using its valid explicit schedule despite %s',
    async (_name, schedules) => {
      server([eventType({ scheduleId: OTHER_SCHEDULE_ID })], {
        'GET /api/v1/schedules': () => json(200, { data: schedules }),
      })
      await openExisting()
      expect(
        within(share())
          .getByRole('link', { name: /View booking page/ })
          .getAttribute('href'),
      ).toBe(bookingUrl())
      expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
    },
  )

  it.each([
    [
      'invalid time zone',
      [schedule({ id: OTHER_SCHEDULE_ID, isDefault: false, timeZone: 'Invalid/Zone' })],
      `/app/availability/${OTHER_SCHEDULE_ID}`,
    ],
    [
      'no weekly hours',
      [schedule({ id: OTHER_SCHEDULE_ID, isDefault: false, weeklyHours: {} })],
      `/app/availability/${OTHER_SCHEDULE_ID}`,
    ],
    ['missing schedule', [], '/app/availability'],
  ] satisfies [string, Schedule[], string][])(
    'withholds a personal event using an explicit schedule with %s despite a valid default',
    async (_name, selectedSchedules, destination) => {
      server([eventType({ scheduleId: OTHER_SCHEDULE_ID })], {
        'GET /api/v1/schedules': () => json(200, { data: [schedule(), ...selectedSchedules] }),
      })
      await openExisting()
      expectNoShareActions()
      expect(
        within(share()).getByText(
          'Host availability needs attention before you share this event type.',
        ),
      ).toBeDefined()
      expect(
        within(share()).getByRole('link', { name: 'Review schedule' }).getAttribute('href'),
      ).toBe(destination)
    },
  )

  it.each([
    ['inactive', { isActive: false }, '#event-enablement'],
    ['hidden', { isHidden: true }, '#event-visibility'],
  ] as const)(
    'links a saved %s event to its exact editor control',
    async (_name, state, target) => {
      server([eventType(state)])
      await openExisting()
      expectNoShareActions()
      expect(share().querySelector(`a[href="${target}"]`)).not.toBeNull()
      expect(document.querySelector(target)).not.toBeNull()
    },
  )

  it('does not publish an inactive saved event just because the activation checkbox is a draft', async () => {
    const user = userEvent.setup()
    server([eventType({ isActive: false })])
    await openExisting()
    await user.click(screen.getByRole('checkbox', { name: 'Active: invitees can book it' }))
    expectNoShareActions()
    expect(share().querySelector('a[href="#event-enablement"]')).not.toBeNull()
  })

  it.each([
    ['inactive', 'Active: invitees can book it', '#event-enablement'],
    ['hidden', 'Hide from your booking page', '#event-visibility'],
  ] as const)(
    'shows the saved %s event’s repair after a successful create',
    async (_state, checkbox, target) => {
      const user = userEvent.setup()
      const api = server([])
      await openNew()
      await user.type(title(), 'New saved event')
      await user.click(screen.getByRole('checkbox', { name: checkbox }))
      await user.click(screen.getByRole('button', { name: 'Create event type' }))
      await screen.findByRole('heading', { name: 'Edit “New saved event”', level: 1 })
      expectNoShareActions()
      expect(share().querySelector(`a[href="${target}"]`)).not.toBeNull()
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(share()).getByRole('heading', { name: 'View and share' }),
        ),
      )
      expect(api.to(CREATE_ROUTE)).toHaveLength(1)
    },
  )

  it('saves a new round-robin pool without activation, then shares only after explicit activation', async () => {
    const user = userEvent.setup()
    const activationRoute = `POST /api/v1/event-types/${CREATED_ID}/round-robin/activate`
    const api = server(
      [],
      {
        [activationRoute]: () =>
          json(
            200,
            eventType({
              id: CREATED_ID,
              organizationId: TEAM.organization.id,
              ownerUserId: null,
              title: 'Team call',
              slug: 'team-call',
              schedulingType: 'round_robin',
              roundRobinActive: true,
            }),
          ),
      },
      TEAM,
    )
    await openNew()
    await user.type(title(), 'Team call')
    await user.selectOptions(screen.getByLabelText('Scheduling'), 'round_robin')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('heading', { name: 'Edit “Team call”', level: 1 })
    await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
      'Configuration checks passed',
    )

    expectNoShareActions()
    expect(share().textContent).toMatch(/activat/i)
    expect(share().querySelector('a[href="#round-robin-heading"]')).not.toBeNull()
    expectShareHashTargets()
    expect(api.to(activationRoute)).toHaveLength(0)
    expect(api.to(CREATE_ROUTE)[0]?.body).toMatchObject({ schedulingType: 'round_robin' })
    expect(api.to(CREATE_ROUTE)[0]?.body).not.toHaveProperty('roundRobinActive')
    await user.click(screen.getByRole('button', { name: 'Activate round robin' }))
    await screen.findByText('Round robin activated.')
    const expected = `${window.location.origin}/team/design-team/team-call`
    expect(
      (await within(share()).findByRole('link', { name: /View booking page/ })).getAttribute(
        'href',
      ),
    ).toBe(expected)
    await user.click(within(share()).getByRole('button', { name: 'Copy booking link' }))
    expect(await navigator.clipboard.readText()).toBe(expected)
    expect(api.to(activationRoute)).toHaveLength(1)
  })

  it('keeps the saved round-robin repair target when its draft changes scheduling type', async () => {
    const user = userEvent.setup()
    const api = server(
      [
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
        }),
      ],
      {},
      TEAM,
    )
    await openExisting()
    await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
      'Configuration checks passed',
    )
    await user.selectOptions(screen.getByLabelText('Scheduling'), 'collective')
    expectNoShareActions()
    expect(share().querySelector('a[href="#round-robin-heading"]')).not.toBeNull()
    expectShareHashTargets()
    const activation = screen.getByRole('region', { name: 'Round-robin activation' })
    expect(within(activation).getByText('Needs activation')).toBeDefined()
    expect(
      within(activation).getByRole<HTMLButtonElement>('button', { name: 'Activate round robin' })
        .disabled,
    ).toBe(true)
    expect(api.to(PATCH_ROUTE)).toHaveLength(0)
    expect(api.to(`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`)).toHaveLength(0)
  })

  it('keeps saved round-robin repair targets in the read-only host view without management actions', async () => {
    server(
      [
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
          hosts: [{ userId: '00000000-0000-7000-8000-000000000004' }],
        }),
      ],
      teamRole('member'),
      TEAM,
    )
    await openExisting()
    await within(screen.getByRole('region', { name: 'Hosts' })).findByText(
      'Only team owners and admins can change host assignments.',
    )
    expectNoShareActions()
    expect(share().querySelector('a[href="#round-robin-heading"]')).not.toBeNull()
    expectShareHashTargets()
    const activation = screen.getByRole('region', { name: 'Round-robin activation' })
    expect(within(activation).getByText('Needs activation')).toBeDefined()
    expect(within(activation).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Activate round robin' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use hosts’ default availability' })).toBeNull()
    expect(screen.queryByLabelText('Scheduling')).toBeNull()
  })

  it('withholds a team link when a saved host needs default availability', async () => {
    const user = userEvent.setup()
    const readiness = teamPage([eventType()], {
      summary: 'configuration_blocked',
      reasonCodes: ['default_schedule_required'],
      fixKinds: ['ask_member'],
    })
    server(
      [
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          hosts: [{ userId: '00000000-0000-7000-8000-000000000004' }],
        }),
      ],
      {
        [TEAM_ROUTE]: () => json(200, readiness),
      },
      TEAM,
    )
    await openExisting()
    await within(share()).findByText(
      'Host availability needs attention before you share this event type.',
    )
    expectNoShareActions()
    expect(share().textContent).toMatch(/host|availability|working hours/i)
    expect(share().querySelector('a[href="#hosts-heading"]')).not.toBeNull()
    expectShareHashTargets()
    await user.type(title(), ' unsaved')
    expectNoShareActions()
    expect(
      within(share()).getByText(
        'Host availability needs attention before you share this event type.',
      ),
    ).toBeDefined()
    expect(share().querySelector('a[href="#hosts-heading"]')).not.toBeNull()
    expectShareHashTargets()
  })

  it('keeps the saved team link copyable while configuration loads', async () => {
    const pending = later()
    const api = server(
      [eventType({ organizationId: TEAM.organization.id, ownerUserId: null })],
      { [TEAM_ROUTE]: () => pending.response },
      TEAM,
    )
    await openExisting()
    await waitFor(() => expect(api.to(TEAM_ROUTE)).toHaveLength(1))
    expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
    expect(within(share()).getByText('Checking configuration…')).toBeDefined()
    expect(share().querySelector('a[href="#saved-readiness-heading"]')).not.toBeNull()
    await pending.answer(json(200, teamPage()))
    expect(
      (await within(share()).findByRole('link', { name: /View booking page/ })).getAttribute(
        'href',
      ),
    ).toBe(`${window.location.origin}/team/design-team/intro-call`)
  })

  it.each([
    [503, 'View and share'],
    [403, 'View and share'],
    [503, 'Saved event checks'],
    [403, 'Saved event checks'],
  ] as const)(
    'recovers team sharing after readiness HTTP %i by retrying from %s',
    async (status, retryRegion) => {
      const user = userEvent.setup()
      const recovery = later()
      let attempts = 0
      const api = server(
        [eventType({ organizationId: TEAM.organization.id, ownerUserId: null })],
        {
          [TEAM_ROUTE]: () => {
            attempts += 1
            return attempts === 1
              ? json(status, {
                  error: status === 403 ? 'team_management_access_denied' : 'internal_error',
                })
              : recovery.response
          },
        },
        TEAM,
      )
      await openExisting()
      const message =
        status === 403
          ? 'Readiness checks are unavailable for this account.'
          : 'Configuration check failed'
      await waitFor(() => expect(share().textContent).toContain(message))
      expect(
        within(screen.getByRole('region', { name: 'Saved event checks' })).getByText(message),
      ).toBeDefined()
      expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
      expect(within(share()).queryByText('Configuration needs attention')).toBeNull()
      expect(share().querySelector('a[href="#saved-readiness-heading"]')).not.toBeNull()
      expectShareHashTargets()
      await user.click(
        within(screen.getByRole('region', { name: retryRegion })).getByRole('button', {
          name: 'Retry checks',
        }),
      )
      await waitFor(() => expect(api.to(TEAM_ROUTE)).toHaveLength(2))
      expect(within(share()).getByText('Checking configuration…')).toBeDefined()
      expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
      await recovery.answer(json(200, teamPage()))
      expect(
        (await within(share()).findByRole('link', { name: /View booking page/ })).getAttribute(
          'href',
        ),
      ).toBe(`${window.location.origin}/team/design-team/intro-call`)
      expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
    },
  )

  it('keeps a team link copyable when its completed readiness page omits the saved event', async () => {
    server(
      [eventType({ organizationId: TEAM.organization.id, ownerUserId: null })],
      { [TEAM_ROUTE]: () => json(200, teamPage([])) },
      TEAM,
    )
    await openExisting()
    await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
      'Configuration not checked',
    )
    expect(within(share()).getByRole('button', { name: 'Copy booking link' })).toBeDefined()
    expect(within(share()).getByText('Configuration not checked')).toBeDefined()
    expect(within(share()).queryByText('Configuration needs attention')).toBeNull()
    expect(share().querySelector('a[href="#saved-readiness-heading"]')).not.toBeNull()
  })

  it('links a saved team host configuration problem to the host editor', async () => {
    server(
      [eventType({ organizationId: TEAM.organization.id, ownerUserId: null })],
      {
        [TEAM_ROUTE]: () =>
          json(
            200,
            teamPage([eventType()], {
              summary: 'configuration_blocked',
              reasonCodes: ['host_configuration_required'],
              fixKinds: ['ask_member'],
            }),
          ),
      },
      TEAM,
    )
    await openExisting()
    await within(share()).findByText('Host settings need attention.')
    expectNoShareActions()
    expect(share().querySelector('a[href="#hosts-heading"]')).not.toBeNull()
    expectShareHashTargets()
  })

  it('keeps an activated round-robin pool shareable when only part of the pool lacks default hours', async () => {
    const user = userEvent.setup()
    server(
      [
        eventType({
          organizationId: TEAM.organization.id,
          ownerUserId: null,
          schedulingType: 'round_robin',
          roundRobinActive: true,
          hosts: [{ userId: ME.user.id }, { userId: '00000000-0000-7000-8000-000000000004' }],
        }),
      ],
      {
        [TEAM_ROUTE]: () =>
          json(
            200,
            teamPage([eventType()], {
              summary: 'partial_pool',
              reasonCodes: ['default_schedule_required'],
              fixKinds: ['ask_member'],
            }),
          ),
      },
      TEAM,
    )
    await openExisting()
    const link = await within(share()).findByRole('link', { name: /View booking page/ })
    const expected = `${window.location.origin}/team/design-team/intro-call`
    expect(link.getAttribute('href')).toBe(expected)
    await user.click(within(share()).getByRole('button', { name: 'Copy booking link' }))
    expect(await navigator.clipboard.readText()).toBe(expected)
  })

  it.each(['dependency_unavailable', 'check_failed'] as const)(
    'withholds an active pool link when default hours are missing alongside %s',
    async (summary) => {
      server(
        [
          eventType({
            organizationId: TEAM.organization.id,
            ownerUserId: null,
            schedulingType: 'round_robin',
            roundRobinActive: true,
          }),
        ],
        {
          [TEAM_ROUTE]: () =>
            json(
              200,
              teamPage([eventType()], {
                summary,
                reasonCodes: ['default_schedule_required', 'calendar_attention_required'],
                fixKinds: ['ask_member'],
              }),
            ),
        },
        TEAM,
      )
      await openExisting()
      await within(share()).findByText(
        'Host availability needs attention before you share this event type.',
      )
      expectNoShareActions()
      expect(share().querySelector('a[href="#hosts-heading"]')).not.toBeNull()
    },
  )

  it.each(['', 'app', 'Team', 'design team'])(
    'links an invalid team slug to settings without offering a public URL: %s',
    async (slug) => {
      server(
        [eventType({ organizationId: TEAM.organization.id, ownerUserId: null })],
        {},
        { ...TEAM, organization: { ...TEAM.organization, slug } },
      )
      await openExisting()
      await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
        'Configuration checks passed',
      )
      expectNoShareActions()
      expect(share().querySelector('a[href="/app/settings"]')).not.toBeNull()
      expect(share().textContent).toMatch(/team slug/i)
    },
  )

  it.each(
    (
      [
        ['individual', 0],
        ['individual', 2],
        ['collective', 1],
        ['collective', 9],
        ['round_robin', 0],
        ['round_robin', 9],
      ] as const
    ).flatMap(([schedulingType, count]) =>
      (['owner', 'member'] as const).map((role) => ({ schedulingType, count, role })),
    ),
  )(
    'withholds a $schedulingType team link with $count saved hosts in the $role host view',
    async ({ schedulingType, count, role }) => {
      server(
        [
          eventType({
            organizationId: TEAM.organization.id,
            ownerUserId: null,
            schedulingType,
            roundRobinActive: true,
            hosts: Array.from({ length: count }, (_, index) => ({
              userId: `00000000-0000-7000-8000-${String(index + 4).padStart(12, '0')}`,
            })),
          }),
        ],
        teamRole(role),
        TEAM,
      )
      await openExisting()
      if (role === 'owner') {
        await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
          'Configuration checks passed',
        )
      } else {
        await within(screen.getByRole('region', { name: 'Hosts' })).findByText(
          'Only team owners and admins can change host assignments.',
        )
        expect(screen.queryByLabelText('Scheduling')).toBeNull()
      }
      expectNoShareActions()
      expect(share().querySelector('a[href="#hosts-heading"]')).not.toBeNull()
      expectShareHashTargets()
    },
  )

  it('keeps a failed create as a guarded draft without published actions', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    server([], { [CREATE_ROUTE]: () => json(500, { error: 'internal_error' }) })
    await openNew()
    await user.type(title(), 'Keep this draft')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not save the event type.',
    )
    expect(title().value).toBe('Keep this draft')
    expect(title().matches(':disabled')).toBe(false)
    expect(location()).toBe('/app/event-types/new')
    expect(screen.queryByRole('region', { name: 'View and share' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Copy.*link/ })).toBeNull()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(title().value).toBe('Keep this draft')
  })

  it('withholds sharing and keeps the draft when saving detects a changed organization context', async () => {
    const user = userEvent.setup()
    server([eventType()], {
      [PATCH_ROUTE]: () => json(409, { error: 'organization_context_changed' }),
    })
    await openExisting()
    expect(within(share()).getByRole('link', { name: /View booking page/ })).toBeDefined()
    await user.type(title(), ' retained draft')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await within(share()).findByText('Your team context changed. Reload before making changes.')
    expectNoShareActions()
    expect(title().value).toBe('Intro call retained draft')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
  })

  it('does not redirect or focus sharing when a create succeeds after leaving', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const api = server([], { [CREATE_ROUTE]: () => pending.response })
    await openNew()
    await user.type(title(), 'Slow create')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await waitFor(() => expect(api.to(CREATE_ROUTE)).toHaveLength(1))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const handle = await screen.findByLabelText<HTMLInputElement>('Handle')
    await user.type(handle, '-draft')
    await pending.answer(
      json(201, eventType({ id: CREATED_ID, title: 'Slow create', slug: 'slow-create' })),
    )
    expect(location()).toBe('/app/settings')
    expect(handle.value).toBe('ada-draft')
    expect(screen.queryByRole('region', { name: 'View and share' })).toBeNull()
    expect(api.to(`GET /api/v1/event-types/${CREATED_ID}`)).toHaveLength(0)
  })

  it('does not overwrite a reopened editor or its share focus with a late update', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const api = server([eventType()], { [PATCH_ROUTE]: () => pending.response })
    await openExisting()
    await user.type(title(), ' old request')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.to(PATCH_ROUTE)).toHaveLength(1))
    await user.click(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Event types',
      }),
    )
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    await user.click(await screen.findByRole('link', { name: 'Edit Intro call' }))
    await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
    await user.type(title(), ' new draft')
    title().focus()
    await pending.answer(
      json(200, eventType({ title: 'Stale saved title', slug: 'stale-saved-link' })),
    )
    expect(title().value).toBe('Intro call new draft')
    expect(document.activeElement).toBe(title())
    expect(
      within(share())
        .getByRole('link', { name: /View booking page/ })
        .getAttribute('href'),
    ).toBe(bookingUrl())
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('offers the saved share actions and visible copy confirmation in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    server()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: '编辑“Intro call”', level: 1 })
    const region = screen.getByRole('region', { name: '查看与分享' })
    expect(
      within(region)
        .getByRole('link', { name: /查看预约页面/ })
        .getAttribute('href'),
    ).toBe(bookingUrl())
    await user.click(within(region).getByRole('button', { name: '复制预约链接' }))
    expect(await navigator.clipboard.readText()).toBe(bookingUrl())
    expect(await within(region).findByText('已复制')).toBeDefined()
  })
})
