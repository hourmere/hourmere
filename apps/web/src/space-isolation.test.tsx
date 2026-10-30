import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiKey } from './api/auth.ts'
import type { Me } from './session.tsx'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from './test/fake-api.tsx'
import { eventType, schedule } from './test/fixtures.ts'

const TEAM_A = {
  id: '00000000-0000-7000-8000-0000000000c1',
  name: 'Team A',
  slug: 'team-a',
  personal: false,
}
const TEAM_B = {
  id: '00000000-0000-7000-8000-0000000000c2',
  name: 'Team B',
  slug: 'team-b',
  personal: false,
}
const IN_A: Me = { ...ME, organization: TEAM_A }
const IN_B: Me = { ...ME, organization: TEAM_B }
const SECRET = 'hm_SyntheticSwitchSecretOnlyShownOnce0123456789abcdefghijklmnop'
const KEY: ApiKey = {
  id: '00000000-0000-7000-8000-0000000000a1',
  name: 'Team A agent',
  start: 'hm_Syn',
  enabled: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  expiresAt: null,
  lastRequest: null,
  metadata: { organizationId: TEAM_A.id },
}

function switchable(extra: Routes = {}) {
  let active = IN_A
  const api = fakeApi({
    ...signedInAs(IN_A),
    ...profile(),
    'GET /api/v1/me': () => json(200, active),
    'GET /api/auth/organization/list': () => json(200, [ME.organization, TEAM_A, TEAM_B]),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { organizationId: active.organization.id, userId: ME.user.id, role: 'owner' }),
    'POST /api/auth/organization/set-active': ({ body }) => {
      const { organizationId } = body as { organizationId: string | null }
      active = organizationId === TEAM_A.id ? IN_A : organizationId === TEAM_B.id ? IN_B : ME
      return json(200, active.organization.personal ? null : active.organization)
    },
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: ME.user.name }], nextAfter: null }),
    'GET /api/v1/event-types': () => json(200, { data: [] }),
    [`GET /api/v1/teams/${TEAM_B.id}/readiness`]: () =>
      json(200, {
        organizationId: TEAM_B.id,
        members: { data: [], nextCursor: null },
        eventTypes: { data: [], nextCursor: null },
      }),
    'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
    ...extra,
  })
  return { ...api, active: () => active, otherTabSwitch: (me: Me) => (active = me) }
}

async function chooseSpace(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /^Switch space/ }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(`^${name}`) }))
  await screen.findByRole('button', { name: new RegExp(`^Switch space ${name}`) })
}

/** Observe even transient additions/removals without putting a capability in diagnostics. */
function watchFor(text: string) {
  let seen = false
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes, record.target]) {
        if (node.textContent?.includes(text)) seen = true
        if (node instanceof Element) {
          for (const input of node.querySelectorAll('input')) {
            if (input.value.includes(text)) seen = true
          }
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return {
    seen: () => seen,
    stop: () => observer.disconnect(),
  }
}

function expectNoSecret() {
  const exposed =
    document.body.textContent?.includes(SECRET) ||
    [...document.querySelectorAll('input')].some((input) => input.value.includes(SECRET))
  expect(Boolean(exposed)).toBe(false)
  expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
}

describe('team context isolation across page remounts', () => {
  it('does not render a slow team A read after switching to B or returning to A', async () => {
    const pending = later()
    let reads = 0
    const api = switchable({
      'GET /api/v1/event-types': () =>
        ++reads === 1
          ? pending.response
          : json(200, {
              data: [
                eventType({
                  organizationId: api.active().organization.id,
                  ownerUserId: null,
                  title: api.active().organization.id === TEAM_A.id ? 'Current A event' : 'B event',
                }),
              ],
            }),
    })
    renderApp('/app/event-types')
    await waitFor(() => expect(reads).toBe(1))
    await chooseSpace('Team B')
    await screen.findByRole('rowheader', { name: 'B event' })
    const watch = watchFor('Stale A event')
    try {
      await pending.answer(
        json(200, {
          data: [
            eventType({ organizationId: TEAM_A.id, ownerUserId: null, title: 'Stale A event' }),
          ],
        }),
      )
      expect(screen.getByRole('rowheader', { name: 'B event' })).toBeDefined()
      expect(screen.queryByText('Stale A event')).toBeNull()
      await chooseSpace('Team A')
      await screen.findByRole('rowheader', { name: 'Current A event' })
      expect(watch.seen()).toBe(false)
      expect(api.to('GET /api/v1/event-types')).toHaveLength(3)
    } finally {
      watch.stop()
    }
  })

  it('never restores a displayed one-time key after a team round trip', async () => {
    const api = switchable({
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [KEY], total: 1 }),
      'POST /api/auth/api-key/create': () => json(200, { ...KEY, key: SECRET }),
    })
    renderApp('/app/api-keys')
    await userEvent.type(await screen.findByLabelText('Name'), 'Team A agent')
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(screen.getByLabelText<HTMLInputElement>('New API key').value === SECRET).toBe(true)
    await chooseSpace('Team B')
    expectNoSecret()
    await screen.findByRole('region', { name: 'Create a key' })
    const watch = watchFor(SECRET)
    try {
      await chooseSpace('Team A')
      await screen.findByRole('rowheader', { name: KEY.name as string })
      expectNoSecret()
      expect(watch.seen()).toBe(false)
      expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1)
      expect(within(screen.getByRole('table')).getByRole('cell', { name: 'Team A' })).toBeDefined()
    } finally {
      watch.stop()
    }
  })

  it('discards a late API-key creation after a deliberate team switch', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = later()
    const api = switchable({ 'POST /api/auth/api-key/create': () => pending.response })
    renderApp('/app/api-keys')
    await userEvent.type(await screen.findByLabelText('Name'), 'Team A agent')
    const create = screen.getByRole('button', { name: 'Create key' })
    await userEvent.click(create)
    await userEvent.click(create)
    await chooseSpace('Team B')
    await screen.findByRole('region', { name: 'Create a key' })
    await userEvent.type(screen.getByLabelText('Name'), 'B draft')
    const watch = watchFor(SECRET)
    try {
      await pending.answer(json(200, { ...KEY, key: SECRET }))
      expectNoSecret()
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('B draft')
      await chooseSpace('Team A')
      await screen.findByRole('region', { name: 'Create a key' })
      expectNoSecret()
      expect(watch.seen()).toBe(false)
      expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1)
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
        name: 'Team A agent',
        metadata: { organizationId: TEAM_A.id },
      })
    } finally {
      watch.stop()
    }
  })

  it.each([201, 409])(
    'keeps a new team B draft when a team A save finishes with %i',
    async (status) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const pending = later()
      const api = switchable({ 'POST /api/v1/event-types': () => pending.response })
      renderApp('/app/event-types')
      await userEvent.click(await screen.findByRole('link', { name: 'New event type' }))
      await userEvent.type(await screen.findByLabelText('Title'), 'A saved event')
      const save = screen.getByRole('button', { name: 'Create event type' })
      await userEvent.click(save)
      await userEvent.click(save)
      await waitFor(() => expect(api.to('POST /api/v1/event-types')).toHaveLength(1))
      const oldTitle = screen.getByLabelText('Title')
      await chooseSpace('Team B')
      await waitFor(() => expect(oldTitle.isConnected).toBe(false))
      await userEvent.type(await screen.findByLabelText('Title'), 'B unsaved draft')
      const watch = watchFor('A saved event')
      try {
        await pending.answer(
          status === 201
            ? json(
                201,
                eventType({ title: 'A saved event', organizationId: TEAM_A.id, ownerUserId: null }),
              )
            : json(409, { error: 'organization_context_changed' }),
        )
        expect(screen.getByTestId('location').textContent).toBe('/app/event-types/new')
        expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('B unsaved draft')
        expect(screen.queryByRole('alert')).toBeNull()
        expect(watch.seen()).toBe(false)
        const writes = api.to('POST /api/v1/event-types')
        expect(writes).toHaveLength(1)
        expect(writes[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM_A.id)
      } finally {
        watch.stop()
      }
    },
  )

  it('loads the same personal availability after team switches without clearing it', async () => {
    const personalSchedule = schedule({ name: 'Shared personal hours' })
    const api = switchable({
      'GET /api/v1/schedules': () => json(200, { data: [personalSchedule] }),
    })
    renderApp('/app/availability')
    const hours = () => screen.findByRole('link', { name: 'Edit Shared personal hours' })
    await hours()
    await chooseSpace('Team B')
    await hours()
    expect(screen.getByText('Mon–Fri 09:00–17:00')).toBeDefined()
    api.otherTabSwitch(ME)
    fireEvent(window, new Event('focus'))
    await screen.findByRole('button', { name: /^Switch space Personal/ })
    await hours()
    await chooseSpace('Team A')
    await hours()
    expect(screen.queryByText('No schedules yet.')).toBeNull()
    expect(screen.getByText('Mon–Fri 09:00–17:00')).toBeDefined()
    expect(api.to('GET /api/v1/schedules')).toHaveLength(4)
    expect(
      api.calls.filter(
        (call) => call.method !== 'GET' && call.path.startsWith('/api/v1/schedules'),
      ),
    ).toHaveLength(0)
  })
})
