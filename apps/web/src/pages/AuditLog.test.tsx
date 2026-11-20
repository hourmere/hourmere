import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { AppShell, AuditLogPage, RequireSession, SessionLayout } from '../lazy-pages.tsx'
import {
  fakeApi,
  json,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'
import { resolveLazy } from '../test/resolve-lazy.ts'

beforeAll(() => resolveLazy(SessionLayout, RequireSession, AppShell, AuditLogPage))

const PAGE = '/app/audit-log'
const EVENTS = 'GET /api/v1/audit-events'
const SETTINGS = 'GET /api/v1/audit-log/settings'
const SAVE = 'PUT /api/v1/audit-log/settings'
const TEAM: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Research team',
    slug: 'research-team',
    personal: false,
  },
}
const LONG_ID = `key_${'a1b2c3d4'.repeat(12)}`

const event = (over: Partial<Schemas['AuditEvent']> = {}): Schemas['AuditEvent'] => ({
  id: '42',
  occurredAt: '2026-11-12T17:04:05.123456Z',
  action: 'api_key.created',
  actor: { type: 'user', id: ME.user.id },
  credential: {
    type: 'api_key',
    apiKeyId: LONG_ID,
    apiKeyScope: 'full',
    oauthClientId: null,
    oauthGrantId: null,
  },
  target: { type: 'api_key', id: 'target-key-7' },
  details: { name: 'Deploy bot', scopes: ['read', 'write'] },
  requestId: 'request-1',
  ...over,
})

const retention = (
  over: Partial<Schemas['AuditLogSettings']> = {},
): Schemas['AuditLogSettings'] => ({
  retention: 'instance',
  retentionDays: null,
  instanceRetentionDays: 365,
  effectiveRetentionDays: 365,
  canChangeRetention: true,
  ...over,
})

const query = (path: string | undefined) =>
  Object.fromEntries(new URL(path ?? '', 'http://x').searchParams)

function setup({
  me = ME,
  timeZone = 'America/Los_Angeles' as string | null,
  events = (() => json(200, { data: [event()], nextCursor: null })) as Routes[string],
  settings = (() => json(200, retention())) as Routes[string],
  extra = {} as Routes,
} = {}) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(timeZone === null ? null : { ...PROFILE, timeZone }),
    [EVENTS]: events,
    [SETTINGS]: settings,
    ...extra,
  })
}

async function openPage() {
  renderApp(PAGE)
  await screen.findByRole('heading', { name: 'Audit log', level: 1 })
}

describe('audit log page', () => {
  it('renders a redacted session target without an identifier', async () => {
    setup({
      events: () =>
        json(200, {
          data: [event({ action: 'session.revoked', target: { type: 'session', id: null } })],
          nextCursor: null,
        }),
    })
    await openPage()
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' })
    const target = table.querySelector('td[data-label="Target"]')
    expect(target?.textContent).toBe('session')
    expect(target?.querySelectorAll('code')).toHaveLength(1)
  })

  it('lists events in the profile time zone and names that zone', async () => {
    const api = setup({
      events: () =>
        json(200, {
          data: [
            event(),
            event({
              id: '41',
              occurredAt: '2026-11-12T08:00:00.000001Z',
              action: 'future.unknown_action',
              actor: { type: 'robot', id: null },
              credential: {
                type: 'mystery',
                apiKeyId: null,
                apiKeyScope: null,
                oauthClientId: 'client-9',
                oauthGrantId: null,
              },
              target: { type: 'thing', id: 'thing-1' },
              details: {},
            }),
          ],
          nextCursor: null,
        }),
    })
    await openPage()
    const table = await screen.findByRole('table', { name: 'Audit events, newest first' })
    expect(
      screen.getByText('Times are shown in America/Los_Angeles (your profile time zone).'),
    ).toBeDefined()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    const [first, second] = rows as [HTMLElement, HTMLElement]
    // 17:04 UTC is 09:04 in Los Angeles in November.
    const time = within(first).getByRole('rowheader')
    expect(time.textContent).toMatch(/\b9:04\b/)
    expect(time.textContent).not.toMatch(/17:04|5:04/)
    expect(time.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-12T17:04:05.123456Z')
    expect(within(second).getByRole('rowheader').textContent).toMatch(/\b12:00\b/)
    expect(within(first).getByText('You')).toBeDefined()
    expect(first.textContent).toContain('api_key.created')
    expect(first.textContent).toContain(LONG_ID)
    expect(first.textContent).toContain('full')
    expect(first.textContent).toContain('target-key-7')
    expect(first.textContent).toContain('Deploy bot')
    expect(first.textContent).toContain('["read","write"]')
    // Long IDs offer break opportunities instead of overflowing the table.
    expect(within(first).getByText(LONG_ID).closest('.user-content')).not.toBeNull()
    expect(second.textContent).toContain('future.unknown_action')
    expect(second.textContent).toContain('robot')
    expect(second.textContent).toContain('mystery')
    expect(second.textContent).toContain('client-9')
    expect(within(second).getByText('None')).toBeDefined()
    const [list] = api.to(EVENTS)
    expect(query(list?.path)).toEqual({ limit: '50' })
    expect(list?.headers.get('x-expected-organization-id')).toBe(ME.organization.id)
    expect(api.to(SETTINGS)[0]?.headers.get('x-expected-organization-id')).toBe(ME.organization.id)
  })

  it('falls back to UTC and says so when the profile zone is unknown', async () => {
    setup({ timeZone: 'Mars/Olympus_Mons' })
    await openPage()
    const table = await screen.findByRole('table')
    expect(screen.getByText('Times are shown in UTC.')).toBeDefined()
    expect(within(table).getAllByRole('rowheader')[0]?.textContent).toMatch(/\b5:04\b/)
  })

  it('sends local start and end days as instants, actor and action, and resets pagination', async () => {
    const api = setup({
      events: (call) =>
        json(200, {
          data: [event({ id: call.path.includes('cursor=') ? '2' : '1' })],
          nextCursor: 'cursor-2',
        }),
    })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(query(api.to(EVENTS).at(-1)?.path).cursor).toBe('cursor-2'))
    await screen.findByRole('button', { name: 'Previous page' })

    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: '2026-03-08' } })
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2026-11-01' } })
    const actorId = screen.getByLabelText(/^Actor ID/) as HTMLInputElement
    expect(actorId.disabled).toBe(true)
    await user.selectOptions(screen.getByLabelText('Actor'), 'api_key')
    expect(actorId.disabled).toBe(false)
    await user.type(actorId, '  key-1 ')
    await user.selectOptions(screen.getByLabelText('Action'), 'api_key.created')
    const before = api.to(EVENTS).length
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(api.to(EVENTS).length).toBe(before + 1))
    // Both days are included: the range ends at the start of the day after the end date.
    // 8 March starts at 08:00Z (still PST), 2 November at 08:00Z (PST again).
    expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({
      limit: '50',
      from: '2026-03-08T08:00:00Z',
      to: '2026-11-02T08:00:00Z',
      actorType: 'api_key',
      actorId: 'key-1',
      action: 'api_key.created',
    })
    await screen.findByRole('button', { name: 'Next page' })
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({ limit: '50' }))
  })

  it('uses the day after the end date across the spring clock change', async () => {
    const api = setup()
    await openPage()
    await screen.findByRole('table')
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2026-03-08' } })
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() =>
      expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({
        limit: '50',
        to: '2026-03-09T07:00:00Z',
      }),
    )
  })

  it('offers definition and execution workflow actions and filters for the selected action', async () => {
    const api = setup()
    await openPage()
    const group = await screen.findByRole('group', { name: 'Workflows' })
    expect(
      within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'workflow.created',
      'workflow.updated',
      'workflow.enabled',
      'workflow.disabled',
      'workflow.deleted',
      'workflow.previewed',
      'workflow.run_scheduled',
      'workflow.run_cancelled',
      'workflow.run_skipped',
      'workflow.email_attempted',
      'workflow.email_sent',
      'workflow.email_rejected',
      'workflow.email_delivery_unknown',
      'workflow.webhook_queued',
      'workflow.webhook_completed',
      'workflow.webhook_failed',
    ])
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Action'), 'workflow.webhook_failed')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() =>
      expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({
        limit: '50',
        action: 'workflow.webhook_failed',
      }),
    )
  })

  it('ignores an actor ID without an actor type and filters by a clicked actor', async () => {
    const api = setup({
      events: () =>
        json(200, {
          data: [event({ actor: { type: 'api_key', id: 'actor-key-5' } })],
          nextCursor: null,
        }),
    })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Show only this actor' }))
    await waitFor(() =>
      expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({
        limit: '50',
        actorType: 'api_key',
        actorId: 'actor-key-5',
      }),
    )
    expect((screen.getByLabelText('Actor') as HTMLSelectElement).value).toBe('api_key')
    await user.selectOptions(screen.getByLabelText('Actor'), '')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(query(api.to(EVENTS).at(-1)?.path)).toEqual({ limit: '50' }))
  })

  it('follows next and previous pages with their cursors', async () => {
    const api = setup({
      events: (call) => {
        const cursor = query(call.path).cursor
        if (!cursor) return json(200, { data: [event({ id: '3' })], nextCursor: 'c-2' })
        if (cursor === 'c-2')
          return json(200, {
            data: [event({ id: '2', action: 'webhook.created' })],
            nextCursor: 'c-3',
          })
        return json(200, {
          data: [event({ id: '1', action: 'webhook.deleted' })],
          nextCursor: null,
        })
      },
    })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await within(await screen.findByRole('table')).findByText('webhook.created')
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await within(await screen.findByRole('table')).findByText('webhook.deleted')
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    await within(await screen.findByRole('table')).findByText('webhook.created')
    expect(api.to(EVENTS).map((call) => query(call.path).cursor ?? null)).toEqual([
      null,
      'c-2',
      'c-3',
      'c-2',
    ])
  })

  it('refuses an end date before the start date without asking the server', async () => {
    const api = setup()
    await openPage()
    await screen.findByRole('table')
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: '2026-11-10' } })
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2026-11-09' } })
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(
      (await screen.findAllByText('The end date must be on or after the start date.')).length,
    ).toBeGreaterThan(0)
    expect(api.to(EVENTS)).toHaveLength(1)
  })

  it('explains an empty result and the retention that may have removed older events', async () => {
    setup({ events: () => json(200, { data: [], nextCursor: null }) })
    await openPage()
    await screen.findByText('No audit events match these filters.')
    expect(
      await screen.findByText(
        'Events older than 365 days may have been deleted by the retention setting.',
      ),
    ).toBeDefined()
  })

  it('does not mention deletion when events are kept forever', async () => {
    setup({
      events: () => json(200, { data: [], nextCursor: null }),
      settings: () =>
        json(200, retention({ instanceRetentionDays: null, effectiveRetentionDays: null })),
    })
    await openPage()
    await screen.findByText('No audit events match these filters.')
    await screen.findAllByText('Kept forever')
    expect(screen.queryByText(/may have been deleted/)).toBeNull()
  })

  it('offers a retry after a failed load', async () => {
    let fail = true
    const api = setup({
      events: () =>
        fail ? json(500, { error: 'internal' }) : json(200, { data: [event()], nextCursor: null }),
    })
    await openPage()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not load audit events.')
    fail = false
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('table')
    expect(api.to(EVENTS)).toHaveLength(2)
  })

  it('shows a neutral access message for members, never a setup problem', async () => {
    const denied = () =>
      json(403, { error: 'team_management_access_denied', message: 'Owners and admins only' })
    setup({ me: TEAM, events: denied, settings: denied })
    await openPage()
    await screen.findByText('Only owners and admins of this space can view its audit log.')
    const main = screen.getByRole('main').textContent ?? ''
    expect(main).not.toMatch(/configur|set up|not set|setup/i)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save retention' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Retention' })).toBeNull()
  })

  it('asks for a reload when the space changed', async () => {
    setup({
      events: () => json(409, { error: 'organization_context_changed', message: 'Changed' }),
    })
    await openPage()
    expect(
      (await screen.findAllByRole('alert')).some(
        (alert) => alert.textContent === 'Your space changed. Reload the page.',
      ),
    ).toBe(true)
  })

  it('explains filters the server rejected', async () => {
    setup({ events: () => json(400, { error: 'invalid_range', message: 'Bad range' }) })
    await openPage()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'These filters could not be used. Check the dates, actor and action, then apply them again.',
    )
  })

  it('renders the page in Chinese', async () => {
    chooseLanguage('zh-CN')
    setup({ events: () => json(200, { data: [], nextCursor: null }) })
    renderApp(PAGE)
    await screen.findByRole('heading', { name: '审计日志', level: 1 })
    await screen.findByText('没有符合这些筛选条件的审计事件。')
    expect(screen.getByText('时间以 America/Los_Angeles 显示（你的个人资料时区）。')).toBeDefined()
    expect(screen.getByRole('button', { name: '应用筛选' })).toBeDefined()
    expect(screen.getByRole('button', { name: '重置筛选' })).toBeDefined()
    expect(screen.getByText('超过 365 天的事件可能已按保留期限设置删除。')).toBeDefined()
    expect(screen.getAllByText('保留 365 天').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '审计日志' })).toBeDefined()
  })

  it('shows retention read-only to admins', async () => {
    setup({ settings: () => json(200, retention({ canChangeRetention: false })) })
    await openPage()
    await screen.findByText('Only owners can change retention.')
    expect(screen.queryByRole('button', { name: 'Save retention' })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByText('This space follows the instance default.')).toBeDefined()
    expect(
      screen.getByText(
        'Events older than the retention are deleted every hour. Events younger than 30 days are never deleted.',
      ),
    ).toBeDefined()
  })

  it.each([
    ['Keep forever', undefined, { retention: 'forever' }],
    ['Follow the instance default', undefined, { retention: 'instance' }],
    ['Keep for a number of days', '90', { retention: 'days', retentionDays: 90 }],
  ] as const)('lets owners save %s', async (choice, days, body) => {
    const saved = retention({
      retention: body.retention,
      retentionDays: body.retention === 'days' ? 90 : null,
      effectiveRetentionDays:
        body.retention === 'forever' ? null : body.retention === 'days' ? 90 : 365,
    })
    const api = setup({
      settings: () =>
        json(
          200,
          retention({ retention: 'days', retentionDays: 400, effectiveRetentionDays: 400 }),
        ),
      extra: { [SAVE]: () => json(200, saved) },
    })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: choice }))
    if (days) {
      const input = screen.getByLabelText(/^Number of days/)
      await user.clear(input)
      await user.type(input, days)
    }
    await user.click(screen.getByRole('button', { name: 'Save retention' }))
    await screen.findByText('Retention saved.')
    const [put] = api.to(SAVE)
    expect(put?.body).toEqual(body)
    expect(put?.headers.get('x-expected-organization-id')).toBe(ME.organization.id)
  })

  it.each(['29', '3651', '45.5', ''])('rejects %j days before saving', async (days) => {
    const api = setup({ extra: { [SAVE]: () => json(200, retention()) } })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Keep for a number of days' }))
    const input = screen.getByLabelText(/^Number of days/)
    await user.clear(input)
    if (days) await user.type(input, days)
    await user.click(screen.getByRole('button', { name: 'Save retention' }))
    await screen.findByText('Enter a whole number of days from 30 to 3650.')
    expect(api.to(SAVE)).toHaveLength(0)
  })

  it('tells an admin who tries to save that only owners can change retention', async () => {
    setup({
      extra: { [SAVE]: () => json(403, { error: 'insufficient_role', message: 'Owner only' }) },
    })
    await openPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('radio', { name: 'Keep forever' }))
    await user.click(screen.getByRole('button', { name: 'Save retention' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Only owners can change retention.')
  })
})

describe('audit log navigation', () => {
  it.each([
    ['a personal space', ME, 'owner', true],
    ['a team owner', TEAM, 'owner', true],
    ['a team admin', TEAM, 'admin', true],
    ['a team member', TEAM, 'member', false],
  ] as const)('decides the audit log link for %s', async (_name, me, role, shown) => {
    const api = fakeApi({
      ...signedInAs(me),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          id: 'membership-1',
          organizationId: me.organization.id,
          userId: me.user.id,
          role,
          createdAt: '2026-10-01T09:00:00.000Z',
        }),
      ...profile(),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
    })
    renderApp('/app/event-types')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await screen.findByRole('heading', { name: 'Event types', level: 1 })
    if (shown) {
      const link = await within(nav).findByRole('link', { name: 'Audit log' })
      expect(link.getAttribute('href')).toBe(PAGE)
    } else {
      // The role read has been answered and the navigation has settled.
      await waitFor(() =>
        expect(api.to('GET /api/auth/organization/get-active-member').length).toBeGreaterThan(0),
      )
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull()
    }
  })
})
