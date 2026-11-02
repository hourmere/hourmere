import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
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

const ID = 'a0000000-0000-7000-8000-000000000001'
const ID2 = 'a0000000-0000-7000-8000-000000000002'
const TOKEN_MARKER = 'synthetic-one-time-capability-marker'
const URL_ONCE = `https://example.test/book/${TOKEN_MARKER}`
const BASE = `/api/v1/event-types/${EVENT_TYPE_ID}/one-time-links`
const GET = `GET ${BASE}`
const POST = `POST ${BASE}`
const DELETE = `DELETE ${BASE}/${ID}`
const TEAM = {
  ...ME,
  organization: { ...ME.organization, id: '00000000-0000-7000-8000-000000000003', personal: false },
}

function link(
  overrides: Partial<Schemas['OneTimeBookingLink']> = {},
): Schemas['OneTimeBookingLink'] {
  return {
    id: ID,
    organizationId: ME.organization.id,
    eventTypeId: EVENT_TYPE_ID,
    creatorUserId: ME.user.id,
    creatorDisplayName: ME.user.name,
    expiresAt: null,
    prefill: { name: null, email: null },
    state: 'active',
    bookingId: null,
    usedAt: null,
    revokedAt: null,
    createdAt: '2030-03-01T00:00:00.000Z',
    updatedAt: '2030-03-01T00:00:00.000Z',
    ...overrides,
  }
}

function server(overrides: Routes = {}, me = ME) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: null }),
    'GET /api/v1/event-types': () => json(200, { data: [eventType()] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
      json(
        200,
        eventType({
          organizationId: me.organization.id,
          ownerUserId: me.organization.personal ? ME.user.id : null,
        }),
      ),
    [GET]: () => json(200, { data: [], nextAfter: null }),
    [POST]: () => json(201, { ...link(), url: URL_ONCE }),
    [DELETE]: () => json(200, link({ state: 'revoked' })),
    ...overrides,
  })
}

const region = () => screen.getByRole('region', { name: 'One-time links' })
const create = () => within(region()).getByRole('button', { name: 'Create one-time link' })

async function open(user: ReturnType<typeof userEvent.setup>) {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await user.click(await screen.findByRole('button', { name: 'Manage one-time links' }))
  await within(region()).findByRole('heading', { name: 'Existing one-time links' })
}

function capabilityInDom() {
  return document.body.innerHTML.includes(TOKEN_MARKER)
}

describe('one-time links in the saved event editor', () => {
  it('loads metadata only after opening and presents the empty state', async () => {
    const user = userEvent.setup()
    const api = server()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await screen.findByRole('heading', { name: 'One-time links' })
    expect(api.to(GET)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Manage one-time links' }))
    await screen.findByText(
      'No one-time links yet. Create one above to share this event privately.',
    )
    expect(api.to(GET)).toHaveLength(1)
    expect(api.to(GET)[0]?.path).toContain('limit=25')
    expect(
      screen.getByRole('button', { name: 'Close one-time links' }).getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it.each([
    ['current member name', 'Grace Hopper', 'Grace Hopper'],
    ['permitted manager email fallback', 'grace@example.test', 'grace@example.test'],
    ['unavailable or former member', null, 'Unknown member'],
  ] as const)(
    'shows the safe creator label for %s without a raw user id',
    async (_case, label, expected) => {
      const user = userEvent.setup()
      const creatorUserId = 'b0000000-0000-7000-8000-000000000001'
      server({
        [GET]: () =>
          json(200, {
            data: [link({ creatorUserId, creatorDisplayName: label })],
            nextAfter: null,
          }),
      })
      await open(user)
      const attribution = await within(region()).findByText('Created by')
      expect(attribution.nextElementSibling?.textContent).toBe(expected)
      expect(region().textContent).not.toContain(creatorUserId)
    },
  )

  it('creates with optional prefill and exact elapsed expiry, and copies the URL only from its dialog', async () => {
    const user = userEvent.setup()
    const logs = ['log', 'warn', 'error', 'info'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    )
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const api = server()
    await open(user)
    await user.selectOptions(screen.getByLabelText('Link expiry (optional)'), '24')
    await user.type(screen.getByLabelText('Prefilled invitee name (optional)'), 'Grace Hopper')
    await user.type(
      screen.getByLabelText('Prefilled invitee email (optional)'),
      'grace@example.test',
    )
    const before = Date.now()
    await user.click(create())
    const dialog = await screen.findByRole('dialog', { name: 'Copy your one-time link' })
    const after = Date.now()
    const request = api.to(POST)[0]
    const body = request?.body as { expiresAt: string; prefill: { name: string; email: string } }
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 86_400_000)
    expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(after + 86_400_000)
    expect(body.prefill).toEqual({ name: 'Grace Hopper', email: 'grace@example.test' })
    expect(request?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(request?.headers.get('Idempotency-Key')?.length).toBeGreaterThanOrEqual(32)
    const input = within(dialog).getByLabelText<HTMLInputElement>('One-time booking URL')
    expect(input.value === URL_ONCE).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(dialog.getAttribute('aria-describedby')).toBe(
      within(dialog).getByText(
        'Link created. Copy and save it privately now. After you close this dialog, the URL cannot be shown again.',
      ).id,
    )
    await user.click(within(dialog).getByRole('button', { name: 'Copy one-time link' }))
    expect((await navigator.clipboard.readText()) === URL_ONCE).toBe(true)
    expect(await within(dialog).findByText('Copied')).toBeDefined()
    const privateDialog = dialog
    await user.click(within(dialog).getByRole('button', { name: 'Close and forget URL' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(capabilityInDom()).toBe(false)
    expect(privateDialog.isConnected).toBe(false)
    expect(document.activeElement).toBe(create())
    expect(within(region()).getByText('Created by').nextElementSibling?.textContent).toBe(
      ME.user.name,
    )
    expect(within(region()).queryByRole('button', { name: 'Copy one-time link' })).toBeNull()
    expect(storage.mock.calls.some((call) => JSON.stringify(call).includes(TOKEN_MARKER))).toBe(
      false,
    )
    expect(logs.some((log) => JSON.stringify(log.mock.calls).includes(TOKEN_MARKER))).toBe(false)
  })

  it.each(['2030-03-10T09:30:00.000Z', '2030-11-03T08:30:00.000Z'])(
    'uses a 24-hour elapsed expiry across daylight-saving boundaries at %s',
    async (now) => {
      const user = userEvent.setup()
      const api = server()
      await open(user)
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
      await user.selectOptions(screen.getByLabelText('Link expiry (optional)'), '24')
      await user.click(create())
      await screen.findByRole('dialog')
      const body = api.to(POST)[0]?.body as { expiresAt: string }
      expect(Date.parse(body.expiresAt) - Date.parse(now)).toBe(86_400_000)
    },
  )

  it('traps keyboard focus and Escape clears the copy-once dialog', async () => {
    const user = userEvent.setup()
    server()
    await open(user)
    await user.click(create())
    const dialog = await screen.findByRole('dialog')
    const url = within(dialog).getByLabelText('One-time booking URL')
    const done = within(dialog).getByRole('button', { name: 'Close and forget URL' })
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(done)
    await user.tab()
    expect(document.activeElement).toBe(url)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(capabilityInDom()).toBe(false)
    expect(document.activeElement).toBe(create())
  })

  it('omits empty optional fields and forgets a dismissed URL after reopening', async () => {
    const user = userEvent.setup()
    const api = server()
    await open(user)
    await user.click(create())
    await screen.findByRole('dialog')
    expect(api.to(POST)[0]?.body).toEqual({})
    // Native modal cancel follows the same dismissal path as the keyboard handler.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(capabilityInDom()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Close one-time links' }))
    await user.click(screen.getByRole('button', { name: 'Manage one-time links' }))
    await screen.findByText(
      'No one-time links yet. Create one above to share this event privately.',
    )
    expect(capabilityInDom()).toBe(false)
  })

  it('ignores a late create response after closing the section', async () => {
    const user = userEvent.setup()
    const pending = later()
    const api = server({ [POST]: () => pending.response })
    await open(user)
    await user.click(create())
    await waitFor(() => expect(api.to(POST)).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Close one-time links' }))
    await pending.answer(json(201, { ...link(), url: URL_ONCE }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(capabilityInDom()).toBe(false)
  })

  it('never reflects server prose that contains a capability and reuses the retry key after uncertainty', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = server({
      [POST]: () =>
        ++attempts === 1
          ? Promise.reject(new TypeError('Network failure'))
          : json(409, { error: 'one_time_link_already_created', message: URL_ONCE }),
    })
    await open(user)
    await user.click(create())
    await screen.findByText('Could not update one-time links. Try again.')
    await user.click(create())
    await screen.findByText(
      'This request already created a link, but its URL cannot be retrieved. Review the list and revoke it if needed, then start a new request.',
    )
    expect(api.to(POST)[0]?.headers.get('Idempotency-Key')).toBe(
      api.to(POST)[1]?.headers.get('Idempotency-Key'),
    )
    expect(capabilityInDom()).toBe(false)
    expect((create() as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Start a new request' }))
    await user.click(create())
    await screen.findByText(
      'This request already created a link, but its URL cannot be retrieved. Review the list and revoke it if needed, then start a new request.',
    )
    expect(api.to(POST)[2]?.headers.get('Idempotency-Key')).not.toBe(
      api.to(POST)[1]?.headers.get('Idempotency-Key'),
    )
  })

  it('shows a neutral access error rather than an empty list when list access is denied', async () => {
    const user = userEvent.setup()
    server({ [GET]: () => json(403, { error: 'insufficient_role', message: URL_ONCE }) })
    await open(user)
    await screen.findByText('Could not load one-time links. Your access may have changed.')
    expect(screen.queryByText(/No one-time links yet/)).toBeNull()
    expect(capabilityInDom()).toBe(false)
  })

  it('lists safe metadata and terminal states, including the consuming booking', async () => {
    const user = userEvent.setup()
    const bookingId = 'b0000000-0000-7000-8000-000000000001'
    server({
      [GET]: () =>
        json(200, {
          data: [
            { ...link(), token: TOKEN_MARKER, tokenHash: TOKEN_MARKER, url: URL_ONCE },
            link({
              id: ID2,
              state: 'used',
              prefill: { name: 'Grace', email: 'grace@example.test' },
              bookingId,
              usedAt: '2030-03-02T00:00:00.000Z',
            }),
            link({ id: 'a0000000-0000-7000-8000-000000000003', state: 'expired' }),
            link({ id: 'a0000000-0000-7000-8000-000000000004', state: 'revoked' }),
          ],
          nextAfter: null,
        }),
    })
    await open(user)
    await within(region()).findByText('Used')
    for (const state of ['Active', 'Used', 'Expired', 'Revoked'])
      expect(within(region()).getByText(state)).toBeDefined()
    expect(within(region()).getByText(bookingId)).toBeDefined()
    expect(within(region()).getByText('grace@example.test')).toBeDefined()
    expect(within(region()).getAllByText('Created by')).toHaveLength(4)
    expect(within(region()).getAllByRole('button', { name: /Revoke one-time link/ })).toHaveLength(
      1,
    )
    expect(capabilityInDom()).toBe(false)
  })

  it('requires revoke confirmation, supports cancel/Escape, and sends the bound organization', async () => {
    const user = userEvent.setup()
    const api = server({ [GET]: () => json(200, { data: [link()], nextAfter: null }) })
    await open(user)
    const revoke = await within(region()).findByRole('button', {
      name: `Revoke one-time link ${ID}`,
    })
    await user.click(revoke)
    const confirm = screen.getByRole('group', {
      name: 'Revoke this one-time link? It will stop accepting new bookings.',
    })
    expect(api.to(DELETE)).toHaveLength(0)
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /Revoke this one-time link/ })).toBeNull()
    const restored = screen.getByRole('button', { name: `Revoke one-time link ${ID}` })
    expect(document.activeElement).toBe(restored)
    await user.click(restored)
    await user.click(
      within(screen.getByRole('group', { name: /Revoke this one-time link/ })).getByRole('button', {
        name: 'Revoke link',
      }),
    )
    await within(region()).findByText('Revoked')
    expect(api.to(DELETE)).toHaveLength(1)
    expect(api.to(DELETE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Existing one-time links' }),
    )
    expect(within(region()).queryByRole('button', { name: /Revoke one-time link/ })).toBeNull()
  })

  it('reports an already-used revoke race without implying the booking was cancelled', async () => {
    const user = userEvent.setup()
    server({
      [GET]: () => json(200, { data: [link()], nextAfter: null }),
      [DELETE]: () => json(200, link({ state: 'used', usedAt: '2030-03-02T00:00:00.000Z' })),
    })
    await open(user)
    await user.click(await screen.findByRole('button', { name: `Revoke one-time link ${ID}` }))
    await user.click(
      within(screen.getByRole('group', { name: /Revoke this one-time link/ })).getByRole('button', {
        name: 'Revoke link',
      }),
    )
    await screen.findByText('This link was already used. Its booking is unchanged.')
    expect(within(region()).queryByText('Link revoked.')).toBeNull()
  })

  it('clears the dialog on a changed team context and keeps the original organization on writes', async () => {
    const user = userEvent.setup()
    const api = server(
      {
        [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () =>
          json(409, { error: 'organization_context_changed' }),
      },
      TEAM,
    )
    await open(user)
    expect(
      screen.getByText(
        'These links belong to the team and remain with it when their creator leaves.',
      ),
    ).toBeDefined()
    await user.click(create())
    const dialog = await screen.findByRole('dialog')
    expect(api.to(POST)[0]?.headers.get('X-Expected-Organization-Id')).toBe(TEAM.organization.id)
    // The editor can be updated by a context refusal while this dialog is displayed.
    fireEvent.submit(document.querySelector('form.editor') as HTMLFormElement)
    await waitFor(() => expect(dialog.isConnected).toBe(false))
    expect(capabilityInDom()).toBe(false)
    expect(within(region()).getByRole('status').textContent).toBe(
      'Your team context changed. Reload before making changes.',
    )
  })

  it('paginates safe metadata without losing newly created rows', async () => {
    const user = userEvent.setup()
    let reads = 0
    const api = server({
      [GET]: () =>
        json(
          200,
          ++reads === 1
            ? { data: [link()], nextAfter: ID }
            : { data: [link({ id: ID2, state: 'expired' })], nextAfter: null },
        ),
    })
    await open(user)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    await within(region()).findByText('Expired')
    expect(api.to(GET)[1]?.path).toContain(`after=${ID}`)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(within(region()).getAllByText('Link ID')).toHaveLength(2)
  })

  it('provides Chinese controls, shown-once warning and revoke confirmation', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    server()
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    await user.click(await screen.findByRole('button', { name: '管理一次性链接' }))
    await user.click(screen.getByRole('button', { name: '创建一次性链接' }))
    const dialog = await screen.findByRole('dialog', { name: '复制你的一次性链接' })
    expect(
      within(dialog).getByText(
        '链接已创建。请立即复制并妥善保管。关闭此对话框后，将无法再次显示网址。',
      ),
    ).toBeDefined()
    await user.click(within(dialog).getByRole('button', { name: '关闭并清除网址' }))
    await user.click(screen.getByRole('button', { name: `撤销一次性链接 ${ID}` }))
    expect(
      screen.getByRole('group', { name: '撤销此一次性链接？撤销后将不再接受新预约。' }),
    ).toBeDefined()
    expect(capabilityInDom()).toBe(false)
  })
})
