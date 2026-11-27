import '../../i18n/admin.ts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { type MessageKey, translateMessage } from '../../i18n/translate.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const accountId = '11111111-1111-4111-8111-111111111111'

const microsoft = (writeAuthorized: boolean) => ({
  microsoftEnabled: true,
  destinationCalendarId: accountId,
  data: [
    {
      provider: 'microsoft',
      status: 'active',
      writeAuthorized,
      calendars: [{ id: accountId, accessRole: 'owner', available: true }],
    },
  ],
})

describe('Microsoft Teams location availability', () => {
  it.each([
    {
      name: 'no Microsoft connection',
      response: () => json(200, { microsoftEnabled: true, data: [] }),
      reason:
        'Connect a Microsoft 365 work or school calendar and select it for booking write-back.',
    },
    {
      name: 'read-only connection',
      response: () => json(200, microsoft(false)),
      reason: 'Reconnect Microsoft Calendar and allow calendar event writes to use Teams.',
    },
    {
      name: 'unauthorized readiness',
      response: () => json(403, { error: 'forbidden' }),
      reason: 'Could not verify Microsoft Teams availability for the host.',
    },
  ])('disables both selectors for $name and explains why', async ({ response, reason }) => {
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/calendar-connections': response,
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    const primary = await screen.findByLabelText('Where the meeting happens')
    expect(
      within(primary).getByRole<HTMLOptionElement>('option', { name: 'Microsoft Teams' }).disabled,
    ).toBe(true)
    expect(
      screen.getByRole('combobox', { name: 'Where the meeting happens', description: reason }),
    ).toBe(primary)
    await user.click(screen.getByText('Location options and conferencing', { selector: 'summary' }))
    const addition = screen.getByRole('combobox', {
      name: 'Add location option',
      description: reason,
    })
    expect(
      within(addition).getByRole<HTMLOptionElement>('option', { name: 'Microsoft Teams' }).disabled,
    ).toBe(true)
  })

  it('uses readiness for the signed-in team host and disables Teams for other hosts and collective scheduling', async () => {
    const memberId = '22222222-2222-4222-8222-222222222222'
    const otherHost = {
      id: '44444444-4444-4444-8444-444444444444',
      memberId: '55555555-5555-4555-8555-555555555555',
      name: 'Other team host',
    }
    const team = {
      ...ME,
      organization: {
        ...ME.organization,
        id: '33333333-3333-4333-8333-333333333333',
        personal: false,
      },
    }
    fakeApi({
      ...signedInAs(team),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      'GET /api/v1/event-type-hosts': () =>
        json(200, {
          data: [{ id: ME.user.id, memberId, name: ME.user.name }, otherHost],
          nextAfter: null,
        }),
      [`GET /api/v1/teams/${team.organization.id}/member-readiness`]: () =>
        json(200, {
          organizationId: team.organization.id,
          members: [memberId, otherHost.memberId].map((memberId) => ({
            memberId,
            health: { microsoftTeams: 'ready' },
          })),
        }),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    const primary = await screen.findByLabelText('Where the meeting happens')
    const teams = within(primary).getByRole<HTMLOptionElement>('option', {
      name: 'Microsoft Teams',
    })
    await waitFor(() => expect(teams.disabled).toBe(false))
    await user.click(screen.getByText('Hosts', { selector: 'summary' }))
    await user.click(await screen.findByRole('checkbox', { name: otherHost.name }))
    expect(teams.disabled).toBe(true)
    expect(
      screen.getByRole('combobox', {
        name: 'Where the meeting happens',
        description:
          'The assigned host must configure Microsoft Teams in their own signed-in session.',
      }),
    ).toBe(primary)
    await user.selectOptions(await screen.findByLabelText('Scheduling'), 'collective')
    expect(teams.disabled).toBe(true)
    expect(
      screen.getByRole('combobox', {
        name: 'Where the meeting happens',
        description: 'Microsoft Teams requires individual scheduling with one host.',
      }),
    ).toBe(primary)
  })

  it('makes a writable single-host option selectable and sends the Teams kind alone', async () => {
    chooseLanguage('zh-CN')
    const t = (key: MessageKey) => translateMessage('zh-CN', key)
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/calendar-connections': () => json(200, microsoft(true)),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      'POST /api/v1/event-types': () => json(201, eventType()),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    const primary = await screen.findByLabelText(t('Where the meeting happens'))
    expect(
      within(primary).getByRole<HTMLOptionElement>('option', { name: 'Microsoft Teams' }).disabled,
    ).toBe(false)
    await user.type(screen.getByLabelText(t('Title'), { exact: true }), 'Teams intro')
    await user.selectOptions(primary, 'microsoft_teams')
    await user.click(screen.getByRole('button', { name: t('Create event type') }))
    await waitFor(() =>
      expect(api.to('POST /api/v1/event-types')[0]?.body).toHaveProperty('location', {
        kind: 'microsoft_teams',
      }),
    )
  })
})

describe.each(['en', 'zh-CN'] as const)('location options editor in %s', (language) => {
  it('configures automatic providers added to an essentials-only create form', async () => {
    chooseLanguage(language)
    const t = (key: MessageKey) => translateMessage(language, key)
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/instance': () => json(200, { automaticGoogleMeet: true, automaticZoom: true }),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      'GET /api/v1/conference-connections': () =>
        json(200, {
          data: [{ id: accountId, displayName: 'My Zoom', mode: 'meetings', status: 'active' }],
        }),
      'POST /api/v1/event-types': () => json(201, eventType()),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    await user.type(await screen.findByLabelText(t('Title'), { exact: true }), 'Choose a location')
    await user.selectOptions(screen.getByLabelText(t('Where the meeting happens')), 'in_person')
    await user.type(screen.getByLabelText(t('Address')), '42 Main Street')
    await user.click(
      screen.getByText(t('Location options and conferencing'), { selector: 'summary' }),
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('Add location option') }),
      'zoom',
    )
    await user.click(screen.getByRole('button', { name: t('Add location option') }))
    // The create form looks up connected services once to pick its default location; adding
    // a Zoom option must not fetch them again.
    expect(api.to('GET /api/v1/conference-connections')).toHaveLength(1)
    await user.click(
      screen.getByRole('checkbox', { name: t('Create a unique Zoom meeting for each booking') }),
    )
    await user.click(screen.getByRole('button', { name: t('Create event type') }))
    expect(
      await screen.findByText(t('Choose your own authorized Zoom meetings account.')),
    ).toBeDefined()
    expect(api.to('POST /api/v1/event-types')).toHaveLength(0)
    await user.selectOptions(await screen.findByLabelText(t('Zoom meetings account')), accountId)
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('Add location option') }),
      'google_meet',
    )
    await user.click(screen.getByRole('button', { name: t('Add location option') }))
    await user.click(
      screen.getByRole('checkbox', {
        name: t('Create a unique Google Meet link for each booking'),
      }),
    )
    await user.click(screen.getByRole('button', { name: t('Create event type') }))
    await waitFor(() => expect(api.to('POST /api/v1/event-types')).toHaveLength(1))
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      zoomConnectionId: accountId,
      locations: [
        { kind: 'in_person', address: '42 Main Street' },
        { kind: 'zoom', autoCreate: true },
        { kind: 'google_meet', autoCreate: true },
      ],
    })
  })

  it('removes a seeded automatic default without changing the other choice or reusing its id', async () => {
    chooseLanguage(language)
    const t = (key: MessageKey) => translateMessage(language, key)
    const saved = eventType({
      location: { kind: 'google_meet', autoCreate: true },
      locations: [
        { id: 'connected-default', kind: 'google_meet', autoCreate: true, isDefault: true },
        { id: 'office', kind: 'in_person', address: '42 Main Street' },
      ],
    })
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    })
    const user = userEvent.setup()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const meet = await screen.findByRole('group', { name: t('Google Meet (provider label only)') })
    await user.click(within(meet).getByRole('button', { name: t('Remove location option') }))
    expect(screen.queryByRole('group', { name: t('Google Meet (provider label only)') })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: new RegExp(t('Location label')) }),
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: t('Add location option') }),
      'google_meet',
    )
    await user.click(screen.getByRole('button', { name: t('Add location option') }))
    await user.click(screen.getByRole('button', { name: t('Save changes') }))
    await waitFor(() =>
      expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1),
    )
    const body = api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body as {
      locations: { id: string }[]
    }
    expect(body.locations).toEqual([
      { id: 'office', kind: 'in_person', address: '42 Main Street' },
      { id: expect.any(String), kind: 'google_meet' },
    ])
    expect(body.locations[1]?.id).not.toBe('connected-default')
  })
})
