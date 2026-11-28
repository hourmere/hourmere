// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, expect, it } from 'vitest'
import { EventTypesPage } from '../../lazy-pages.tsx'
import { resolveEventTypeEditor } from '../../test/event-type-editor.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'
import { resolveLazy } from '../../test/resolve-lazy.ts'

const team = {
  ...ME.organization,
  id: '00000000-0000-7000-8000-000000000003',
  name: 'Team',
  slug: 'team',
  personal: false,
}
const saved = eventType({ ownerUserId: null })

function server(role: string, permissions?: string[]) {
  const me = {
    ...ME,
    organization: team,
    ...(permissions && { teamManagementPermissions: permissions }),
  }
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { id: 'membership-1', userId: ME.user.id, organizationId: team.id, role }),
    'GET /api/v1/event-types': () => json(200, { data: [saved] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    'POST /api/v1/event-types': ({ body }) => json(201, { ...saved, ...(body as object) }),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: ({ body }) =>
      json(200, { ...saved, ...(body as object) }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () => json(200, { data: [] }),
  })
}

beforeAll(async () => {
  await resolveLazy(EventTypesPage)
  await resolveEventTypeEditor()
})

it.each(['owner', 'admin', 'member'])(
  'keeps the fixed %s catalogue markup byte-for-byte',
  async (role) => {
    server(role)
    renderApp('/app/event-types')
    await screen.findByRole('rowheader', { name: 'Intro call' })
    if (role === 'member')
      await screen.findByText('Readiness checks are unavailable for this account.')
    else {
      await screen.findByRole('switch', { name: 'Enable Intro call' })
      await screen.findByText('Configuration not checked')
    }
    const html = screen.getByRole('main').innerHTML
    // Digests of the rendered main element at the pre-change revision.
    expect(createHash('sha256').update(html).digest('hex')).toBe(
      role === 'member'
        ? '7b25b07e2d92126e9baee3f1ccf52fb9bb344440ae4d3f9658868e1e63068216'
        : '7d301d6c9b96b7d9581d2ae13434d243cd3a333080ad18a48113e6aef50129b6',
    )
  },
)

it('lets a custom Member update the event without sending unrelated notification or scheduling fields', async () => {
  const api = server('member', ['event_types.read', 'event_types.update'])
  const user = userEvent.setup()
  renderApp('/app/event-types')
  await user.click(await screen.findByRole('switch', { name: 'Enable Intro call' }))
  const patch = `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
  expect(api.to(patch)[0]?.body).toEqual({ isActive: !saved.isActive })
  expect(screen.queryByRole('link', { name: 'New event type' })).toBeNull()
  await user.click(screen.getByRole('link', { name: 'Edit Intro call' }))
  const title = await screen.findByRole('textbox', { name: 'Title' })
  await user.clear(title)
  await user.type(title, 'Team introduction')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(api.to(patch)[1]?.body).toEqual({ title: 'Team introduction' })
  expect(screen.queryByRole('button', { name: 'Manage one-time links' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Delete event type' })).toBeNull()
  expect(api.to(`GET /api/v1/teams/${team.id}/readiness`)).toHaveLength(0)
  expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
})

it('saves a notification-only grant while keeping general event details read-only', async () => {
  const api = server('member', ['event_types.read', 'event_notifications.update'])
  const user = userEvent.setup()
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  const title = await screen.findByRole('textbox', { name: 'Title' })
  expect(title.closest('fieldset[disabled]')).not.toBeNull()
  await user.click(screen.getByText('Reminders and follow-ups', { selector: 'summary' }))
  await user.click(screen.getByRole('checkbox', { name: 'SMS reminders' }))
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toEqual({
    smsRemindersEnabled: true,
  })
})

it('creates an individual event with an implied host for a create-only Member', async () => {
  const api = server('member', ['event_types.read', 'event_types.create'])
  const user = userEvent.setup()
  renderApp('/app/event-types/new')
  await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'New consultation')
  await user.click(screen.getByRole('button', { name: 'Create event type' }))
  await screen.findByRole('heading', { name: /Edit/ })
  const body = api.to('POST /api/v1/event-types')[0]?.body
  expect(body).toMatchObject({ title: 'New consultation' })
  for (const field of ['hosts', 'schedulingType', 'scheduleId', 'conferenceOrganizer']) {
    expect(body).not.toHaveProperty(field)
  }
  expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
})

it('lets a host-assignment grant change the current host pool without reading candidate data', async () => {
  const api = server('member', ['event_types.read', 'event_types.assign_hosts'])
  const user = userEvent.setup()
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await user.selectOptions(await screen.findByLabelText('Scheduling'), 'round_robin')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Saved.')
  expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]?.body).toMatchObject({
    schedulingType: 'round_robin',
    hosts: saved.hosts,
  })
  expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Activate round robin' })).toBeNull()
})

it('keeps an unrenewed Admin’s event catalogue readable and the direct editor read-only', async () => {
  const api = server('admin', ['event_types.read'])
  const user = userEvent.setup()
  renderApp('/app/event-types')
  const row = await screen.findByRole('rowheader', { name: 'Intro call' })
  expect(screen.queryByRole('switch', { name: 'Enable Intro call' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'New event type' })).toBeNull()
  expect(
    within(row.closest('tr') as HTMLElement).queryByRole('link', { name: 'Edit Intro call' }),
  ).toBeNull()
  await user.click(within(row).getByRole('link'))
  const title = await screen.findByRole('textbox', { name: 'Title' })
  expect(title.closest('fieldset[disabled]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Delete event type' })).toBeNull()
  expect(api.to(`GET /api/v1/teams/${team.id}/readiness`)).toHaveLength(0)
  expect(api.to('GET /api/v1/event-type-hosts')).toHaveLength(0)
  expect(api.to('GET /api/v1/branding')).toHaveLength(0)
})

it('uses an empty effective projection without falling back to the fixed Admin controls', async () => {
  const api = server('admin', [])
  renderApp('/app/event-types')
  await screen.findByText("You don't have permission to do that.")
  expect(screen.queryByRole('link', { name: 'New event type' })).toBeNull()
  expect(api.to('GET /api/v1/event-types')).toHaveLength(0)
})
