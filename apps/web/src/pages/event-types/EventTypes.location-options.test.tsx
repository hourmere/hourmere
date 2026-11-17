import '../../i18n/admin.ts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { type MessageKey, translateMessage } from '../../i18n/translate.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const accountId = '11111111-1111-4111-8111-111111111111'

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
