import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

beforeEach(() => {
  chooseLanguage('en')
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }),
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }),
  })
})

function setup(routes: Routes = {}) {
  return fakeApi({
    ...signedInAs(ME),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () => json(200, { data: [eventType()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    ...routes,
  })
}

describe('new event location defaults', () => {
  it.each([
    [true, false, 'google_meet'],
    [false, true, 'zoom'],
    [true, true, 'google_meet'],
    [false, false, ''],
  ])('Meet %s, Zoom %s selects %s without automatic creation', async (meet, zoom, expected) => {
    const api = setup({
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: meet ? [{ provider: 'google', status: 'active', syncAuthorized: true }] : [],
        }),
      'GET /api/v1/conference-connections': () =>
        json(200, { data: zoom ? [{ provider: 'zoom', mode: 'meetings', status: 'active' }] : [] }),
      'POST /api/v1/event-types': ({ body }) => json(201, eventType(body as object)),
    })
    const user = userEvent.setup()
    renderApp('/app/event-types/new')
    expect(
      ((await screen.findByLabelText('Where the meeting happens')) as HTMLSelectElement).value,
    ).toBe(expected)
    await user.type(screen.getByLabelText('Title', { exact: true }), 'Default test')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await waitFor(() => expect(api.to('POST /api/v1/event-types')).toHaveLength(1))
    expect(api.to('POST /api/v1/event-types')[0]?.body).toMatchObject({
      location: expected ? { kind: expected } : null,
    })
  })

  it('does not infer a connection from unavailable discovery or an identity-only Zoom account', async () => {
    setup({
      'GET /api/v1/calendar-connections': () => json(403, { error: 'forbidden' }),
      'GET /api/v1/conference-connections': () =>
        json(200, { data: [{ provider: 'zoom', mode: 'identity', status: 'active' }] }),
    })
    renderApp('/app/event-types/new')
    expect(
      ((await screen.findByLabelText('Where the meeting happens')) as HTMLSelectElement).value,
    ).toBe('')
  })

  it('preserves the saved location while checking whether Teams can be selected', async () => {
    const api = setup({
      'GET /api/v1/calendar-connections': () =>
        json(200, { data: [{ provider: 'google', status: 'active', syncAuthorized: true }] }),
    })
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    expect(
      ((await screen.findByLabelText('Where the meeting happens')) as HTMLSelectElement).value,
    ).toBe('')
    expect(api.to('GET /api/v1/calendar-connections')).toHaveLength(1)
    expect(api.to('GET /api/v1/conference-connections')).toHaveLength(0)
  })
})

it('optimistically toggles, mutes the row, pins organization and rolls back a failed save', async () => {
  const pending = later()
  const api = setup({ [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => pending.response })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  const toggle = await screen.findByRole('switch', { name: 'Enable Intro call' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await user.click(toggle)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.closest('tr')?.className).toContain('event-type-inactive')
  expect((toggle as HTMLButtonElement).disabled).toBe(true)
  await waitFor(() => expect(api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1))
  const request = api.to(`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`)[0]
  expect(request?.body).toEqual({ isActive: false })
  expect(request?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
  await pending.answer(json(500, { error: 'internal_error' }))
  await screen.findByRole('alert')
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(toggle.closest('tr')?.className).not.toContain('event-type-inactive')
})

it('keeps a successful toggle and opens the copied event from the menu', async () => {
  const copyId = 'e0000000-0000-7000-8000-000000000002'
  let active = true
  const api = setup({
    'GET /api/v1/event-types': () => json(200, { data: [eventType({ isActive: active })] }),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => {
      active = false
      return json(200, eventType({ isActive: false }))
    },
    [`POST /api/v1/event-types/${EVENT_TYPE_ID}/duplicate`]: () =>
      json(201, eventType({ id: copyId, slug: 'intro-call-copy' })),
    [`GET /api/v1/event-types/${copyId}`]: () =>
      json(200, eventType({ id: copyId, slug: 'intro-call-copy' })),
  })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  await user.click(await screen.findByRole('switch', { name: 'Enable Intro call' }))
  await waitFor(() =>
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false),
  )
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await user.click(screen.getByRole('button', { name: 'More actions for Intro call' }))
  await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${copyId}`),
  )
  expect(
    api
      .to(`POST /api/v1/event-types/${EVENT_TYPE_ID}/duplicate`)[0]
      ?.headers.get('X-Expected-Organization-Id'),
  ).toBe(ME.organization.id)
})

it('navigates the menu by keyboard and requires a cancellable delete dialog', async () => {
  const api = setup({
    [`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`]: () => new Response(null, { status: 204 }),
  })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  const trigger = await screen.findByRole('button', { name: 'More actions for Intro call' })
  trigger.focus()
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Duplicate' }))
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Embed' }))
  await user.keyboard('{End}{Enter}')
  let dialog = screen.getByRole('dialog')
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(api.to(`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(0)
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  expect(document.activeElement).toBe(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
  await user.keyboard('{ArrowUp}{Enter}')
  dialog = screen.getByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Delete event type' }))
  await waitFor(() => expect(screen.queryByRole('switch')).toBeNull())
  expect(api.to(`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`)).toHaveLength(1)
})

it('does not navigate back to a copy after leaving the list while duplication is pending', async () => {
  const pending = later()
  setup({ [`POST /api/v1/event-types/${EVENT_TYPE_ID}/duplicate`]: () => pending.response })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  await user.click(await screen.findByRole('button', { name: 'More actions for Intro call' }))
  await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
  await user.click(screen.getByRole('link', { name: 'New event type' }))
  await screen.findByLabelText('Title', { exact: true })
  await pending.answer(json(201, eventType({ id: 'e0000000-0000-7000-8000-000000000002' })))
  expect(screen.getByTestId('location').textContent).toBe('/app/event-types/new')
})

it('refreshes authoritative list and readiness after a toggle instead of retaining an override', async () => {
  let changed = false
  const api = setup({
    'GET /api/v1/event-types': () =>
      json(200, {
        data: [eventType(changed ? { title: 'Updated remotely', isActive: false } : {})],
      }),
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => {
      changed = true
      return json(200, eventType({ isActive: false }))
    },
  })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  await user.click(await screen.findByRole('switch', { name: 'Enable Intro call' }))
  const refreshed = await screen.findByRole('switch', { name: 'Enable Updated remotely' })
  expect(refreshed.getAttribute('aria-checked')).toBe('false')
  expect(api.to('GET /api/v1/event-types')).toHaveLength(2)
  await waitFor(() => expect(api.to('GET /api/v1/readiness/self').length).toBeGreaterThan(1))
})

it('keeps member rows read-only while allowing the embed menu', async () => {
  const team = { ...ME, organization: { ...ME.organization, personal: false } }
  fakeApi({
    ...signedInAs(team),
    ...profile(),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { organizationId: team.organization.id, userId: team.user.id, role: 'member' }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () => json(200, { data: [eventType({ ownerUserId: null })] }),
  })
  const user = userEvent.setup()
  renderApp('/app/event-types')
  await user.click(await screen.findByRole('button', { name: 'More actions for Intro call' }))
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Embed' })).toBeTruthy()
})
