import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutEffect } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { RequireSession, SessionProvider, useMe, useSession } from '../../session.tsx'
import {
  type Routes as ApiRoutes,
  fakeApi,
  json,
  later,
  ME,
  signedIn,
} from '../../test/fake-api.tsx'
import { WebhookSettings } from './WebhookSettings.tsx'

const BASE = '/api/v1/webhooks'
const LIST = `GET ${BASE}`
const CREATE = `POST ${BASE}`
const INSTANCE = 'GET /api/v1/instance'
const ME_ROUTE = 'GET /api/v1/me'
const ORIGIN = 'https://receiver.example.test'
const PRIVATE_SUFFIX = '/private-delivery?synthetic-token=never-show'
const PRIVATE_URL = `${ORIGIN}${PRIVATE_SUFFIX}`
const SYNTHETIC_SECRET = 'synthetic-one-time-webhook-secret'
const ENDPOINT = {
  id: '00000000-0000-7000-8000-000000000070',
  organizationId: ME.organization.id,
  url: PRIVATE_URL,
  events: ['booking.created'],
  isActive: true,
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
}
const ENDPOINT_PATH = `${BASE}/${ENDPOINT.id}`
const PATCH = `PATCH ${ENDPOINT_PATH}`
const DELETE = `DELETE ${ENDPOINT_PATH}`
const ROTATE = `POST ${ENDPOINT_PATH}/rotate-secret`
const SECOND_SPACE = '00000000-0000-7000-8000-000000000080'
const EMPTY = 'No webhook endpoints yet.'
const ACCESS = 'Webhook endpoints are unavailable.'
const LOADING = 'Loading webhook endpoints…'
const CONFLICT = 'Your team context changed. Reload before making changes.'
const READ_ERROR = 'Could not load webhook endpoints.'
const WORKFLOWS_DISABLED = 'Workflow events are unavailable on this instance.'
const WEBHOOKS_DISABLED =
  'Creating webhooks and rotating signing secrets are unavailable on this instance.'
const LIMIT = 'This space can have up to ten webhook endpoints, including paused endpoints.'
const INVALID = 'Check the webhook settings and try again.'
const MISSING = 'This webhook endpoint is no longer available.'
const CREATE_UNKNOWN =
  'Creation could not be confirmed. Refresh the list and confirm the endpoint ID before rotating its secret.'
const ROTATE_UNKNOWN =
  'Rotation could not be confirmed. The previous secret may already have been replaced. Refresh the list before taking another action.'
const DELIVERY_PATH = `${ENDPOINT_PATH}/deliveries`
const DELIVERIES = `GET ${DELIVERY_PATH}`
const HISTORY_EMPTY = 'No deliveries retained in the last 30 days.'
const SECOND_ENDPOINT = { ...ENDPOINT, id: '00000000-0000-7000-8000-000000000071' }
const delivery = {
  id: '00000000-0000-7000-8000-000000000085',
  eventId: '00000000-0000-7000-8000-000000000086',
  bookingId: '00000000-0000-7000-8000-000000000087',
  eventType: 'booking.created',
  status: 'pending',
  attempts: 2,
  httpStatus: 503,
  lastError: 'http_error',
  createdAt: '2026-11-06T01:00:00Z',
  lastAttemptAt: '2026-11-06T02:00:00Z',
  deliveredAt: null,
} satisfies Schemas['WebhookDelivery']
const olderDelivery = {
  ...delivery,
  id: '00000000-0000-7000-8000-000000000084',
  eventType: 'booking.rescheduled',
  status: 'delivered',
  httpStatus: 204,
  lastError: null,
  deliveredAt: '2026-11-06T02:00:01Z',
} satisfies Schemas['WebhookDelivery']
const deliveryPage = (data: unknown[], nextAfter: string | null = null) =>
  json(200, { data, nextAfter })

type User = ReturnType<typeof userEvent.setup>

function ServerFixture({ onAccessDenied }: { onAccessDenied: () => void }) {
  const me = useMe()
  const { refresh } = useSession()
  return (
    <>
      <Link to="/other">Leave settings</Link>
      <button type="button" onClick={() => void refresh()}>
        Refresh session
      </button>
      <WebhookSettings
        organizationId={me.organization.id}
        userId={me.user.id}
        personal={me.organization.personal}
        onAccessDenied={onAccessDenied}
      />
    </>
  )
}

function HistoryObserver({ record }: { record: (value: unknown) => void }) {
  const location = useLocation()
  useLayoutEffect(() => record(location), [location, record])
  return null
}

function open(routes: ApiRoutes = {}) {
  const api = fakeApi({ ...signedIn, [LIST]: () => json(200, [ENDPOINT]), ...routes })
  const onAccessDenied = vi.fn()
  const user = userEvent.setup()
  const record = vi.fn()
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <HistoryObserver record={record} />
      <InterfaceScope surface="admin">
        <SessionProvider>
          <Routes>
            <Route element={<RequireSession />}>
              <Route path="/settings" element={<ServerFixture onAccessDenied={onAccessDenied} />} />
            </Route>
            <Route path="/sign-in" element={<h1>Sign-in destination</h1>} />
            <Route path="/other" element={<Link to="/settings">Return to settings</Link>} />
          </Routes>
        </SessionProvider>
      </InterfaceScope>
    </MemoryRouter>,
  )
  return { api, onAccessDenied, user, record }
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const findButton = (name: string) => screen.findByRole<HTMLButtonElement>('button', { name })
const checkbox = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name })
const destination = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Destination URL' })
const head = (name: string) => screen.getByRole('heading', { name })
const secretVisible = () => document.body.textContent?.includes(SYNTHETIC_SECRET) === true
const endpointVisible = () => document.body.textContent?.includes(ENDPOINT.id) === true
const secretValue = { secret: SYNTHETIC_SECRET }
const created = { webhook: ENDPOINT, ...secretValue }
const endpointError = (status: number, error: string) =>
  json(status, { error, message: PRIVATE_URL })

async function startCreate(user: User) {
  await user.click(await findButton('Add webhook'))
  expect(document.activeElement).toBe(head('Create webhook'))
  await user.type(destination(), PRIVATE_URL)
  await user.click(checkbox('Booking created'))
}

async function edit(user: User) {
  const opener = await findButton('Edit webhook')
  await user.click(opener)
  expect(document.activeElement).toBe(head('Edit webhook'))
  return opener
}

async function requestRotation(user: User) {
  await edit(user)
  await user.click(button('Rotate signing secret…'))
  await user.click(button('Rotate signing secret'))
}

function webhookRequests() {
  return vi
    .mocked(fetch)
    .mock.calls.flatMap(([request]) =>
      request instanceof Request && new URL(request.url).pathname.startsWith(BASE) ? [request] : [],
    )
}

function expectPrivateDataAbsent() {
  expect(document.body.innerHTML.includes(PRIVATE_SUFFIX)).toBe(false)
  for (const state of [localStorage, sessionStorage, window.history.state, window.location.href]) {
    const serialized = JSON.stringify(state) ?? ''
    expect(serialized.includes(PRIVATE_SUFFIX)).toBe(false)
    expect(serialized.includes(SYNTHETIC_SECRET)).toBe(false)
  }
}

function setVisibility(visibility: 'hidden' | 'visible') {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility)
  fireEvent(document, new Event('visibilitychange'))
}

const history = () => within(screen.getByRole('region', { name: 'Delivery history' }))

async function openHistory(user: User, endpointId = ENDPOINT.id) {
  const text = await screen.findByText(endpointId, { exact: true })
  const item = text.closest<HTMLElement>('li')
  if (!item) throw new Error('Endpoint should be in the webhook list')
  const opener = within(item).getByRole('button', { name: 'Delivery history' })
  await user.click(opener)
  expect(document.activeElement).toBe(head('Delivery history'))
  return opener
}

describe('webhook list and edits', () => {
  it('announces loading, offers a read retry and shows empty only after success', async () => {
    const first = later()
    let reads = 0
    const { api, user } = open({
      [LIST]: () => (++reads === 1 ? first.response : json(200, [])),
    })
    expect((await screen.findByText(LOADING)).closest('[role="status"]')).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
    await first.answer(endpointError(500, 'read_error'))
    expect((await screen.findByText(READ_ERROR)).closest('[role="alert"]')).toBeTruthy()
    expect(screen.queryByText(EMPTY)).toBeNull()
    expectPrivateDataAbsent()
    await user.click(button('Try again'))
    await screen.findByText(EMPTY)
    expect(api.to(LIST)).toHaveLength(2)
  })

  it('keeps same-origin destinations distinguishable and shows only plain origins', async () => {
    const second = {
      ...ENDPOINT,
      id: SECOND_SPACE,
      url: `${ORIGIN}/other-private-credential`,
      isActive: false,
    }
    const { user } = open({ [LIST]: () => json(200, [ENDPOINT, second]) })
    await screen.findByText(ENDPOINT.id)
    expect(screen.getByText(second.id)).toBeTruthy()
    expect(screen.getAllByText(ORIGIN)).toHaveLength(2)
    expect(screen.queryByRole('link', { name: ORIGIN })).toBeNull()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByText('Paused')).toBeTruthy()
    const [, opener] = screen.getAllByRole('button', { name: 'Edit webhook' })
    if (!opener) throw new Error('Second endpoint should have an edit control')
    expect(opener.getAttribute('aria-describedby')).toBeTruthy()
    await user.click(opener)
    expect(head('Edit webhook')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Destination URL' })).toBeNull()
    expectPrivateDataAbsent()
    expect(document.body.innerHTML.includes('other-private-credential')).toBe(false)
    await user.click(button('Close'))
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Edit webhook' })[1])
  })

  it('keeps pause/resume separate from subscription edits and leaves server URL policy authoritative', async () => {
    const { api, user } = open({
      [PATCH]: ({ body }) => {
        if (!body || typeof body !== 'object') return endpointError(400, 'invalid_request')
        if ('events' in body) return endpointError(400, 'invalid_webhook')
        return json(200, { ...ENDPOINT, ...body })
      },
    })
    await edit(user)
    await user.click(checkbox('Booking rescheduled'))
    await user.click(button('Save subscriptions'))
    await screen.findByText(INVALID)
    expect(checkbox('Booking rescheduled').checked).toBe(true)
    expectPrivateDataAbsent()
    await user.click(button('Pause webhook'))
    await user.click(await findButton('Resume webhook'))
    await findButton('Pause webhook')
    expect(api.to(PATCH).map(({ body }) => body)).toEqual([
      { events: ['booking.created', 'booking.rescheduled'] },
      { isActive: false },
      { isActive: true },
    ])
  })

  it('shows an unknown saved event neutrally without allowing it to be overwritten', async () => {
    const futureEvent = 'booking.future_unknown'
    const endpoint = { ...ENDPOINT, events: [...ENDPOINT.events, futureEvent] }
    const { api, user } = open({
      [LIST]: () => json(200, [endpoint]),
      [PATCH]: () => json(200, { ...endpoint, isActive: false }),
    })
    await screen.findByText(/Unknown event/)
    expect(screen.queryByText(futureEvent)).toBeNull()
    await edit(user)
    expect(
      screen.queryByRole<HTMLButtonElement>('button', { name: 'Save subscriptions' })?.disabled ??
        true,
    ).toBe(true)
    await user.click(button('Pause webhook'))
    await findButton('Resume webhook')
    expect(api.to(PATCH).map(({ body }) => body)).toEqual([{ isActive: false }])
  })

  it('can keep and remove a saved workflow event when workflows are unavailable', async () => {
    const endpoint = { ...ENDPOINT, events: [...ENDPOINT.events, 'workflow.executed'] }
    const { api, user } = open({
      [INSTANCE]: () => json(503, { error: 'unavailable' }),
      [LIST]: () => json(200, [endpoint]),
      [PATCH]: ({ body }) => json(200, { ...endpoint, ...(body as object) }),
    })
    await edit(user)
    expect(checkbox('Workflow executed').checked).toBe(true)
    await user.click(checkbox('Booking rescheduled'))
    await user.click(button('Save subscriptions'))
    await screen.findByText('Webhook endpoint updated.')
    await user.click(checkbox('Workflow executed'))
    await user.click(button('Save subscriptions'))
    await waitFor(() => expect(api.to(PATCH)).toHaveLength(2))
    expect(api.to(PATCH).map(({ body }) => body)).toEqual([
      {
        events: expect.arrayContaining([
          'booking.created',
          'workflow.executed',
          'booking.rescheduled',
        ]),
      },
      { events: ['booking.created', 'booking.rescheduled'] },
    ])
  })

  it('refreshes workflow availability after rejection and keeps the destination and booking choices', async () => {
    let instanceReads = 0
    const { api, user } = open({
      [INSTANCE]: () => json(200, { workflowsEnabled: ++instanceReads === 1 }),
      [CREATE]: () => endpointError(404, 'workflows_disabled'),
    })
    await startCreate(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Workflow executed' }))
    await user.click(button('Create webhook'))
    expect((await screen.findByText(WORKFLOWS_DISABLED)).textContent?.includes(PRIVATE_URL)).toBe(
      false,
    )
    await waitFor(() => expect(api.to(INSTANCE)).toHaveLength(2))
    await waitFor(() => expect(button('Create webhook').disabled).toBe(true))
    expect(destination().value).toBe(PRIVATE_URL)
    expect(checkbox('Booking created').checked).toBe(true)
    expect(checkbox('Workflow executed').checked).toBe(true)
    await user.click(checkbox('Workflow executed'))
    expect(screen.queryByRole('checkbox', { name: 'Workflow executed' })).toBeNull()
    expect(button('Create webhook').disabled).toBe(false)
    expect(api.to(CREATE)).toHaveLength(1)
  })

  it.each(['invalid_webhook', 'invalid_request'])(
    'preserves an authorized create draft for %s',
    async (code) => {
      const { user } = open({ [CREATE]: () => endpointError(400, code) })
      await startCreate(user)
      await user.click(checkbox('Enabled'))
      await user.click(button('Create webhook'))
      const error = await screen.findByText(INVALID)
      expect(error.closest('[role="alert"]')?.textContent?.includes(PRIVATE_URL)).toBe(false)
      expect(destination().value).toBe(PRIVATE_URL)
      expect(checkbox('Booking created').checked).toBe(true)
      expect(checkbox('Enabled').checked).toBe(false)
    },
  )

  it('explains the limit after refreshing the list of enabled and paused endpoints', async () => {
    const { api, user } = open({ [CREATE]: () => endpointError(409, 'webhook_limit_reached') })
    await startCreate(user)
    await user.click(button('Create webhook'))
    await screen.findByText(LIMIT)
    await waitFor(() => expect(api.to(LIST)).toHaveLength(2))
    expect(api.to(CREATE)).toHaveLength(1)
  })

  it('explains disabled rotation and still allows deletion', async () => {
    const { api, user } = open({
      [ROTATE]: () => endpointError(409, 'webhooks_disabled'),
      [DELETE]: () => new Response(null, { status: 204 }),
    })
    await requestRotation(user)
    await screen.findByText(WEBHOOKS_DISABLED)
    await user.click(await findButton('Delete webhook…'))
    await user.click(button('Delete webhook'))
    await screen.findByText('Webhook endpoint deleted.')
    expect(api.to(DELETE)).toHaveLength(1)
  })

  it('closes a stale or foreign selection on 404 and refreshes the opening space', async () => {
    let reads = 0
    const { api, user } = open({
      [LIST]: () => json(200, ++reads === 1 ? [ENDPOINT] : []),
      [PATCH]: () => endpointError(404, 'webhook_not_found'),
    })
    await edit(user)
    await user.click(button('Pause webhook'))
    await screen.findByText(MISSING)
    await screen.findByText(EMPTY)
    expect(screen.queryByRole('heading', { name: 'Edit webhook' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(2)
  })
})

describe('webhook confirmation and one-time secrets', () => {
  it('uses the opening scope and no-store for every operation and keeps URLs and secrets out of browser state', async () => {
    let rows: (typeof ENDPOINT)[] = []
    const { api, user, record } = open({
      [LIST]: () => json(200, rows),
      [CREATE]: () => {
        rows = [ENDPOINT]
        return json(201, created)
      },
      [PATCH]: () => json(200, { ...ENDPOINT, isActive: false }),
      [ROTATE]: () => json(200, secretValue),
      [DELETE]: () => {
        rows = []
        return new Response(null, { status: 204 })
      },
    })
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    const logs = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level),
    )
    await startCreate(user)
    expect(checkbox('Enabled').checked).toBe(true)
    await user.click(button('Create webhook'))
    const secretHeading = await screen.findByRole('heading', {
      name: 'Signing secret',
    })
    expect(document.activeElement).toBe(secretHeading)
    expect(secretVisible()).toBe(true)
    expect(clipboard).not.toHaveBeenCalled()
    expectPrivateDataAbsent()
    await user.click(button('Copy signing secret'))
    expect(clipboard).toHaveBeenCalledTimes(1)
    expect(clipboard.mock.calls[0]?.[0] === SYNTHETIC_SECRET).toBe(true)
    await user.click(button('Dismiss'))
    expect(secretVisible()).toBe(false)
    await edit(user)
    expect(secretVisible()).toBe(false)
    await user.click(button('Pause webhook'))
    await findButton('Resume webhook')

    const rotate = button('Rotate signing secret…')
    await user.click(rotate)
    expect(head('Rotate signing secret')).toBeTruthy()
    expect(document.activeElement).toBe(button('Go back'))
    expect(api.to(ROTATE)).toHaveLength(0)
    await user.click(button('Go back'))
    expect(document.activeElement).toBe(button('Rotate signing secret…'))
    await user.click(button('Rotate signing secret…'))
    await user.click(button('Rotate signing secret'))
    await screen.findByRole('heading', { name: 'Signing secret' })
    expect(secretVisible()).toBe(true)
    expectPrivateDataAbsent()
    await user.click(button('Dismiss'))
    expect(secretVisible()).toBe(false)

    const remove = await findButton('Delete webhook…')
    await user.click(remove)
    expect(head('Delete webhook')).toBeTruthy()
    expect(document.activeElement).toBe(button('Go back'))
    expect(api.to(DELETE)).toHaveLength(0)
    await user.click(button('Go back'))
    expect(document.activeElement).toBe(button('Delete webhook…'))
    await user.click(button('Delete webhook…'))
    await user.click(button('Delete webhook'))
    await screen.findByText(EMPTY)
    expect(document.activeElement?.matches('h2, h3, h4')).toBe(true)
    expect(endpointVisible()).toBe(false)
    expectPrivateDataAbsent()
    expect(api.to(CREATE).map(({ body }) => body)).toEqual([
      { url: PRIVATE_URL, events: ['booking.created'], isActive: true },
    ])
    expect(api.to(ROTATE)).toHaveLength(1)
    expect(api.to(DELETE)).toHaveLength(1)
    expect(
      webhookRequests().every(
        (request) =>
          request.cache === 'no-store' &&
          request.headers.get('X-Expected-Organization-Id') === ME.organization.id &&
          new URL(request.url).origin === location.origin,
      ),
    ).toBe(true)
    expect(new Set(webhookRequests().map(({ method }) => method))).toEqual(
      new Set(['GET', 'POST', 'PATCH', 'DELETE']),
    )
    const logged = JSON.stringify(logs.map((log) => log.mock.calls))
    expect(logged.includes(SYNTHETIC_SECRET)).toBe(false)
    expect(logged.includes(PRIVATE_SUFFIX)).toBe(false)
    const visited = JSON.stringify(record.mock.calls)
    expect(visited.includes(SYNTHETIC_SECRET)).toBe(false)
    expect(visited.includes(PRIVATE_SUFFIX)).toBe(false)
  })

  it('clears a secret on navigation and cannot redisplay it when settings reopen', async () => {
    const { user } = open({ [ROTATE]: () => json(200, secretValue) })
    await requestRotation(user)
    await findButton('Copy signing secret')
    expect(secretVisible()).toBe(true)
    await user.click(screen.getByRole('link', { name: 'Leave settings' }))
    expect(secretVisible()).toBe(false)
    await user.click(screen.getByRole('link', { name: 'Return to settings' }))
    await findButton('Edit webhook')
    expect(secretVisible()).toBe(false)
    expectPrivateDataAbsent()
  })

  it('removes the secret before a page is cached for back/forward navigation', async () => {
    const { user } = open({ [ROTATE]: () => json(200, secretValue) })
    await requestRotation(user)
    await findButton('Copy signing secret')
    expect(secretVisible()).toBe(true)
    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }))
    expect(secretVisible()).toBe(false)
    fireEvent(window, new PageTransitionEvent('pageshow', { persisted: true }))
    await findButton('Edit webhook')
    expect(secretVisible()).toBe(false)
    expectPrivateDataAbsent()
  })

  it.each(['create', 'rotate'] as const)(
    'allows only one pending %s and requires reconciliation after an uncertain result',
    async (action) => {
      const response = later()
      const route = action === 'create' ? CREATE : ROTATE
      const { api, user } = open({
        [route]: () =>
          action === 'rotate'
            ? response.response
            : response.response.then(() => {
                throw new TypeError('Failed to fetch')
              }),
      })
      if (action === 'create') await startCreate(user)
      else {
        await edit(user)
        await user.click(button('Rotate signing secret…'))
      }
      const submit = button(action === 'create' ? 'Create webhook' : 'Rotate signing secret')
      await user.dblClick(submit)
      await waitFor(() => expect(api.to(route)).toHaveLength(1))
      await response.answer(endpointError(503, 'unknown'))
      await screen.findByText(action === 'create' ? CREATE_UNKNOWN : ROTATE_UNKNOWN)
      expect(screen.queryByRole('button', { name: submit.textContent ?? '' })).toBeNull()
      expect(api.to(LIST)).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'Edit webhook' })).toBeNull()
      await user.click(button('Refresh webhook endpoints'))
      await findButton('Edit webhook')
      expect(api.to(route)).toHaveLength(1)
      expect(api.to(LIST)).toHaveLength(2)
      expect(secretVisible()).toBe(false)
      expectPrivateDataAbsent()
    },
  )
})

describe('webhook session and organization boundaries', () => {
  it.each(['team_management_access_denied', 'insufficient_role'])(
    'clears the endpoint and its actions on 403 %s',
    async (code) => {
      const { onAccessDenied, user } = open({ [PATCH]: () => endpointError(403, code) })
      await edit(user)
      await user.click(button('Pause webhook'))
      await screen.findByText(ACCESS)
      expect(onAccessDenied).toHaveBeenCalledTimes(1)
      expect(endpointVisible()).toBe(false)
      expect(screen.queryByRole('button', { name: 'Add webhook' })).toBeNull()
      expectPrivateDataAbsent()
    },
  )

  it('redirects through shared session handling when a pending action gets a 401', async () => {
    const { user } = open({ [ROTATE]: () => endpointError(401, 'unauthorized') })
    await requestRotation(user)
    await screen.findByRole('heading', { name: 'Sign-in destination' })
    expect(endpointVisible()).toBe(false)
    expect(secretVisible()).toBe(false)
  })

  it('shows the shared conflict and waits for deliberate reload before using the resulting space', async () => {
    const check = later()
    let sessionReads = 0
    const { api, user } = open({
      [ME_ROUTE]: () => (++sessionReads === 1 ? json(200, ME) : check.response),
      [PATCH]: () => endpointError(409, 'organization_context_changed'),
    })
    await edit(user)
    await user.click(button('Pause webhook'))
    const conflict = await screen.findByText(CONFLICT)
    expect(endpointVisible()).toBe(false)
    expect(api.to(LIST)).toHaveLength(1)
    const alert = conflict.closest<HTMLElement>('[role="alert"]')
    if (!alert) throw new Error('Context change should be announced')
    await user.click(within(alert).getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(api.to(ME_ROUTE)).toHaveLength(2))
    await check.answer(json(200, ME))
    await findButton('Edit webhook')
    expect(api.to(PATCH)).toHaveLength(1)
  })

  it.each(['list', 'create', 'update'] as const)(
    'rejects cross-organization endpoint data from %s',
    async (operation) => {
      const foreign = { ...ENDPOINT, organizationId: SECOND_SPACE }
      const { user } = open({
        ...(operation === 'list' && { [LIST]: () => json(200, [ENDPOINT, foreign]) }),
        [CREATE]: () => json(201, { webhook: foreign, ...secretValue }),
        [PATCH]: () => json(200, foreign),
      })
      if (operation === 'create') {
        await startCreate(user)
        await user.click(button('Create webhook'))
      }
      if (operation === 'update') {
        await edit(user)
        await user.click(button('Pause webhook'))
      }
      await screen.findByText(CONFLICT)
      expect(endpointVisible()).toBe(false)
      expect(secretVisible()).toBe(false)
      expect(screen.queryByRole('button', { name: 'Add webhook' })).toBeNull()
    },
  )

  it('aborts an old list and ignores its response when switching spaces in another tab', async () => {
    const oldList = later()
    const { api } = open({
      [ME_ROUTE]: (() => {
        let reads = 0
        return () =>
          json(
            200,
            ++reads === 1 ? ME : { ...ME, organization: { ...ME.organization, id: SECOND_SPACE } },
          )
      })(),
      [LIST]: ({ headers }) =>
        headers.get('X-Expected-Organization-Id') === ME.organization.id
          ? oldList.response
          : json(200, []),
    })
    await waitFor(() => expect(api.to(LIST)).toHaveLength(1))
    fireEvent.focus(window)
    await screen.findByText(EMPTY)
    expect(webhookRequests().at(0)?.signal.aborted).toBe(true)
    await oldList.answer(json(200, [ENDPOINT]))
    expect(endpointVisible()).toBe(false)
    expect(api.to(LIST).map(({ headers }) => headers.get('X-Expected-Organization-Id'))).toEqual([
      ME.organization.id,
      SECOND_SPACE,
    ])
  })

  it.each(['create', 'rotate'] as const)(
    'waits for the session refresh on tab return before disclosing a pending %s secret',
    async (action) => {
      const pendingWrite = later()
      const pendingSession = later()
      let sessionReads = 0
      let createdOnServer = false
      setVisibility('visible')
      const { api, user } = open({
        [LIST]: () => json(200, action === 'rotate' || createdOnServer ? [ENDPOINT] : []),
        [ME_ROUTE]: () =>
          ++sessionReads === 1
            ? json(200, ME)
            : pendingSession.response.then((result) => result.clone()),
        [CREATE]: () => pendingWrite.response,
        [ROTATE]: () => pendingWrite.response,
      })
      if (action === 'create') {
        await startCreate(user)
        await user.click(button('Create webhook'))
      } else await requestRotation(user)
      await waitFor(() => expect(api.to(action === 'create' ? CREATE : ROTATE)).toHaveLength(1))

      setVisibility('hidden')
      createdOnServer = action === 'create'
      await pendingWrite.answer(action === 'create' ? json(201, created) : json(200, secretValue))
      expect(secretVisible()).toBe(false)
      expect(screen.queryByRole('button', { name: 'Copy signing secret' })).toBeNull()
      setVisibility('visible')
      await waitFor(() => expect(api.to(ME_ROUTE).length).toBeGreaterThan(1))
      expect(secretVisible()).toBe(false)
      await pendingSession.answer(json(200, ME))
      await findButton('Copy signing secret')
      expect(secretVisible()).toBe(true)
    },
  )

  it('waits for window focus and fresh access before revealing the result of a pending rotation', async () => {
    const rotation = later()
    const session = later()
    let sessionReads = 0
    setVisibility('visible')
    const { api, user } = open({
      [ME_ROUTE]: () =>
        ++sessionReads === 1 ? json(200, ME) : session.response.then((result) => result.clone()),
      [ROTATE]: () => rotation.response,
    })
    await requestRotation(user)
    await waitFor(() => expect(api.to(ROTATE)).toHaveLength(1))

    fireEvent.blur(window)
    expect(document.visibilityState).toBe('visible')
    await rotation.answer(json(200, secretValue))
    expect(api.to(ME_ROUTE)).toHaveLength(1)
    expect(secretVisible()).toBe(false)

    fireEvent.focus(window)
    await waitFor(() => expect(api.to(ME_ROUTE).length).toBeGreaterThan(1))
    expect(secretVisible()).toBe(false)
    await session.answer(json(200, ME))
    await findButton('Copy signing secret')
    expect(api.to(LIST)).toHaveLength(2)
    expect(secretVisible()).toBe(true)
  })

  it('discards a late rotation response after another account enters the same team', async () => {
    const team = { ...ME.organization, personal: false }
    let me = { ...ME, organization: team }
    const pending = later()
    const { api, user } = open({
      [ME_ROUTE]: () => json(200, me),
      [LIST]: () => json(200, me.user.id === ME.user.id ? [ENDPOINT] : []),
      [ROTATE]: () => pending.response,
    })
    await requestRotation(user)
    await waitFor(() => expect(api.to(ROTATE)).toHaveLength(1))
    me = {
      ...ME,
      personalOrganizationId: SECOND_SPACE,
      organization: team,
      user: { ...ME.user, id: '00000000-0000-7000-8000-000000000081' },
    }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await screen.findByText(EMPTY)
    await pending.answer(json(200, secretValue))
    expect(secretVisible()).toBe(false)
    expect(endpointVisible()).toBe(false)
    expect(api.to(LIST)).toHaveLength(2)
    expectPrivateDataAbsent()
  })

  it('checks the returning session afresh when an older identity read was already pending', async () => {
    const rotation = later()
    const beforeReturn = later()
    const afterReturn = later()
    const firstAccount = { ...ME, organization: { ...ME.organization, personal: false } }
    const secondAccount = {
      ...firstAccount,
      personalOrganizationId: SECOND_SPACE,
      user: { ...ME.user, id: '00000000-0000-7000-8000-000000000081' },
    }
    let sessionReads = 0
    setVisibility('visible')
    const { api, user } = open({
      [ME_ROUTE]: () => {
        sessionReads += 1
        if (sessionReads === 1) return json(200, firstAccount)
        return sessionReads === 2 ? beforeReturn.response : afterReturn.response
      },
      [ROTATE]: () => rotation.response,
    })
    await requestRotation(user)
    await waitFor(() => expect(api.to(ROTATE)).toHaveLength(1))
    await user.click(button('Refresh session'))
    await waitFor(() => expect(api.to(ME_ROUTE)).toHaveLength(2))
    setVisibility('hidden')
    await rotation.answer(json(200, secretValue))
    setVisibility('visible')
    await waitFor(() => expect(api.to(ME_ROUTE)).toHaveLength(3))
    await beforeReturn.answer(json(200, firstAccount))
    expect(secretVisible()).toBe(false)
    await afterReturn.answer(json(200, secondAccount))
    await findButton('Edit webhook')
    expect(secretVisible()).toBe(false)
    expect(api.to(LIST)).toHaveLength(2)
  })

  it('does not disclose a pending secret when the returned session has lost webhook access', async () => {
    const pending = later()
    let revoked = false
    setVisibility('visible')
    const { api, onAccessDenied, user } = open({
      [LIST]: () =>
        revoked ? endpointError(403, 'team_management_access_denied') : json(200, [ENDPOINT]),
      [ROTATE]: () => pending.response,
    })
    await requestRotation(user)
    await waitFor(() => expect(api.to(ROTATE)).toHaveLength(1))
    setVisibility('hidden')
    await pending.answer(json(200, secretValue))
    revoked = true
    setVisibility('visible')
    await screen.findByText(ACCESS)
    expect(onAccessDenied).toHaveBeenCalledTimes(1)
    expect(secretVisible()).toBe(false)
    expect(endpointVisible()).toBe(false)
    expectPrivateDataAbsent()
  })

  it('requires reconciliation when the session check fails during a pending rotation', async () => {
    const rotation = later()
    let online = true
    setVisibility('visible')
    const { api, user } = open({
      [ME_ROUTE]: () => {
        if (!online) throw new TypeError('Failed to fetch')
        return json(200, ME)
      },
      [ROTATE]: () => rotation.response,
    })
    await requestRotation(user)
    await waitFor(() => expect(api.to(ROTATE)).toHaveLength(1))

    setVisibility('hidden')
    online = false
    setVisibility('visible')
    const notice = await screen.findByText(ROTATE_UNKNOWN)
    expect(notice.closest('[role="alert"]')).toBeTruthy()
    expect(api.to(LIST)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Edit webhook' })).toBeNull()
    expect(secretVisible()).toBe(false)

    online = true
    await user.click(button('Refresh webhook endpoints'))
    await findButton('Edit webhook')
    expect(api.to(LIST)).toHaveLength(2)
    await rotation.answer(json(200, secretValue))
    expect(api.to(ROTATE)).toHaveLength(1)
    expect(secretVisible()).toBe(false)
    expect(screen.queryByRole('button', { name: 'Copy signing secret' })).toBeNull()
    expectPrivateDataAbsent()
  })
})

describe('webhook delivery history', () => {
  it('loads on demand and presents the persisted outcomes and safe attempt metadata', async () => {
    const response = later()
    const { api, user, record } = open({ [DELIVERIES]: () => response.response })
    const failed = {
      ...delivery,
      id: '00000000-0000-7000-8000-000000000083',
      eventType: 'booking.future-marker',
      status: 'failed',
      attempts: 13,
      lastError: 'synthetic-unclassified-error-marker',
    }
    const skipped = {
      ...delivery,
      id: '00000000-0000-7000-8000-000000000082',
      eventType: 'booking.cancelled',
      status: 'skipped',
      attempts: 0,
      httpStatus: null,
      lastError: 'disabled',
      lastAttemptAt: null,
    }
    const markers = ['synthetic-payload-marker', 'synthetic-signature-marker', SYNTHETIC_SECRET]
    await screen.findByText(ENDPOINT.id)
    expect(api.to(DELIVERIES)).toHaveLength(0)
    const opener = await openHistory(user)
    expect(history().getByText('Loading deliveries…').closest('[role="status"]')).toBeTruthy()
    expect(history().queryByText(HISTORY_EMPTY)).toBeNull()
    await waitFor(() => expect(api.to(DELIVERIES)).toHaveLength(1))
    const request = webhookRequests().find((call) => new URL(call.url).pathname === DELIVERY_PATH)
    expect(request).toMatchObject({ method: 'GET', cache: 'no-store' })
    expect(request?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(request?.url).toBe(location.origin + DELIVERY_PATH)
    expect(api.to(DELIVERIES).map(({ path }) => path)).toEqual([DELIVERY_PATH])

    await response.answer(
      deliveryPage([
        {
          ...delivery,
          payload: { marker: markers[0] },
          headers: { 'X-Hourmere-Signature': markers[1] },
          responseBody: markers[0],
          secret: markers[2],
        },
        olderDelivery,
        failed,
        skipped,
      ]),
    )
    for (const label of [
      'Pending',
      'Delivered',
      'Failed',
      'Skipped',
      'Booking created',
      'Booking rescheduled',
      'Booking cancelled',
      'HTTP error',
      'Unknown delivery error',
      'Unknown event',
      '204',
      '13',
      '0',
    ]) {
      expect(history().getByText(label, { exact: true })).toBeTruthy()
    }
    // The most recent attempt failed with HTTP 503, but its server outcome is still pending.
    const pending = history().getByText(delivery.id, { exact: true }).closest<HTMLElement>('li')
    if (!pending) throw new Error('Delivery should be in the history list')
    expect(within(pending).getByText('Pending')).toBeTruthy()
    expect(within(pending).getByText('Attempts')).toBeTruthy()
    expect(within(pending).getByText('2', { exact: true })).toBeTruthy()
    expect(within(pending).getByText('HTTP status')).toBeTruthy()
    expect(within(pending).getByText('503', { exact: true })).toBeTruthy()
    expect(within(pending).getByText('—', { exact: true })).toBeTruthy()
    for (const dateTime of [delivery.createdAt, delivery.lastAttemptAt]) {
      const time = pending.querySelector(`time[datetime="${dateTime}"]`)
      expect(time?.textContent).toBeTruthy()
      expect(time?.textContent).not.toBe(dateTime)
    }
    const deliveredAt = screen
      .getByRole('region', { name: 'Delivery history' })
      .querySelector(`time[datetime="${olderDelivery.deliveredAt}"]`)
    expect(deliveredAt?.textContent).toBeTruthy()

    const contents = [
      document.body.innerHTML,
      JSON.stringify(record.mock.calls),
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
    ]
    for (const marker of [...markers, failed.eventType, failed.lastError, 'X-Hourmere-Signature']) {
      expect(contents.some((value) => value.includes(marker))).toBe(false)
    }
    expectPrivateDataAbsent()
    expect(history().queryByRole('button', { name: 'Load older deliveries' })).toBeNull()
    await user.click(history().getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(opener)
  })

  it('offers a fresh read on failure and announces empty only after a successful first page', async () => {
    const retry = later()
    let reads = 0
    const { api, user } = open({
      [DELIVERIES]: () => (++reads === 1 ? endpointError(503, 'unavailable') : retry.response),
    })
    await openHistory(user)
    const error = await history().findByText('Could not load webhook deliveries.')
    expect(error.closest('[role="alert"]')).toBeTruthy()
    expect(history().queryByText(HISTORY_EMPTY)).toBeNull()
    expectPrivateDataAbsent()
    await user.click(history().getByRole('button', { name: 'Try again' }))
    expect(document.activeElement).toBe(history().getByRole('button', { name: 'Refresh history' }))
    expect(history().getByText('Loading deliveries…')).toBeTruthy()
    await retry.answer(deliveryPage([]))
    expect((await history().findByText(HISTORY_EMPTY)).closest('[role="status"]')).toBeTruthy()
    expect(api.to(DELIVERIES).map(({ path }) => path)).toEqual([DELIVERY_PATH, DELIVERY_PATH])
  })

  it('keeps the current page on a failed append and retries that cursor before appending in order', async () => {
    const next = later()
    let olderReads = 0
    const { api, user } = open({
      [DELIVERIES]: ({ path }) => {
        if (path === DELIVERY_PATH) return deliveryPage([delivery], delivery.id)
        if (++olderReads === 1) return next.response
        return deliveryPage([olderDelivery])
      },
    })
    await openHistory(user)
    await history().findByText(delivery.id)
    await user.dblClick(history().getByRole('button', { name: 'Load older deliveries' }))
    await waitFor(() => expect(api.to(DELIVERIES)).toHaveLength(2))
    expect(history().getByText(delivery.id)).toBeTruthy()
    expect(history().getByRole('status').textContent).toBe('Loading older deliveries…')
    await next.answer(endpointError(503, 'unavailable'))
    expect(
      (await history().findByText('Could not load older deliveries.')).closest('[role="alert"]'),
    ).toBeTruthy()
    expect(history().getByText(delivery.id)).toBeTruthy()
    await user.click(history().getByRole('button', { name: 'Try again' }))
    const recent = history().getByText(delivery.id)
    const older = await history().findByText(olderDelivery.id)
    expect(recent.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(history().getByRole('status').textContent).toBe('2 deliveries shown.')
    expect(document.activeElement).toBe(older.closest('li'))
    expect(history().queryByRole('button', { name: 'Load older deliveries' })).toBeNull()
    expect(api.to(DELIVERIES).map(({ path }) => path)).toEqual([
      DELIVERY_PATH,
      `${DELIVERY_PATH}?after=${delivery.id}`,
      `${DELIVERY_PATH}?after=${delivery.id}`,
    ])
    expect(
      api.to(DELIVERIES).map(({ headers }) => headers.get('X-Expected-Organization-Id')),
    ).toEqual([ME.organization.id, ME.organization.id, ME.organization.id])
  })

  it('clears an invalid cursor and refreshes from the first page', async () => {
    let firstPages = 0
    const { api, user } = open({
      [DELIVERIES]: ({ path }) => {
        if (path !== DELIVERY_PATH) return endpointError(400, 'invalid_cursor')
        return ++firstPages === 1 ? deliveryPage([delivery], delivery.id) : deliveryPage([])
      },
    })
    await openHistory(user)
    await user.click(await history().findByRole('button', { name: 'Load older deliveries' }))
    const error = await history().findByText(
      'This delivery history page is no longer available. Refresh history to start again.',
    )
    expect(error.closest('[role="alert"]')).toBeTruthy()
    expect(history().queryByRole('button', { name: 'Load older deliveries' })).toBeNull()
    expect(history().queryByRole('button', { name: 'Try again' })).toBeNull()
    await user.click(history().getByRole('button', { name: 'Refresh history' }))
    await history().findByText(HISTORY_EMPTY)
    expect(history().queryByText(delivery.id)).toBeNull()
    expect(api.to(DELIVERIES).map(({ path }) => path)).toEqual([
      DELIVERY_PATH,
      `${DELIVERY_PATH}?after=${delivery.id}`,
      DELIVERY_PATH,
    ])
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'team_management_access_denied'],
  ] as const)(
    'ignores an obsolete %s and starts without its cursor on another endpoint',
    async (status, code) => {
      const pending = later()
      const secondPath = `${BASE}/${SECOND_ENDPOINT.id}/deliveries`
      const { api, onAccessDenied, user } = open({
        [LIST]: () => json(200, [ENDPOINT, SECOND_ENDPOINT]),
        [DELIVERIES]: ({ path }) =>
          path === DELIVERY_PATH ? deliveryPage([delivery], delivery.id) : pending.response,
        [`GET ${secondPath}`]: () => deliveryPage([]),
      })
      await openHistory(user)
      await user.click(await history().findByRole('button', { name: 'Load older deliveries' }))
      await waitFor(() => expect(api.to(DELIVERIES)).toHaveLength(2))
      const oldRequest = webhookRequests().find((call) =>
        new URL(call.url).searchParams.has('after'),
      )
      expect(oldRequest?.signal.aborted).toBe(false)
      await user.click(history().getByRole('button', { name: 'Close' }))
      await openHistory(user, SECOND_ENDPOINT.id)
      await history().findByText(HISTORY_EMPTY)
      expect(api.to(`GET ${secondPath}`).map(({ path }) => path)).toEqual([secondPath])
      expect(oldRequest?.signal.aborted).toBe(true)
      await pending.answer(endpointError(status, code))
      expect(history().getByText(HISTORY_EMPTY)).toBeTruthy()
      expect(screen.queryByText('Sign-in destination')).toBeNull()
      expect(history().queryByText(delivery.id)).toBeNull()
      expect(onAccessDenied).not.toHaveBeenCalled()
    },
  )

  it.each([
    [401, 'unauthorized', 'Sign-in destination'],
    [403, 'team_management_access_denied', ACCESS],
    [409, 'organization_context_changed', CONFLICT],
  ] as const)('clears the endpoint and its loaded history on %s', async (status, code, message) => {
    const { api, onAccessDenied, user } = open({
      [DELIVERIES]: ({ path }) =>
        path === DELIVERY_PATH
          ? deliveryPage([delivery], delivery.id)
          : endpointError(status, code),
    })
    await openHistory(user)
    await history().findByText(delivery.id)
    await user.click(history().getByRole('button', { name: 'Load older deliveries' }))
    await screen.findByText(message)
    expect(screen.queryByRole('region', { name: 'Delivery history' })).toBeNull()
    expect(document.body.textContent?.includes(delivery.id)).toBe(false)
    expect(endpointVisible()).toBe(false)
    expect(api.to(LIST)).toHaveLength(1)
    if (status === 403) expect(onAccessDenied).toHaveBeenCalledWith(code)
    expectPrivateDataAbsent()
  })

  it('closes stale history and refreshes the endpoint list after a missing endpoint', async () => {
    const pending = later()
    let reads = 0
    const { api, user } = open({
      [LIST]: () => json(200, ++reads === 1 ? [ENDPOINT] : []),
      [DELIVERIES]: () => pending.response,
    })
    await openHistory(user)
    await pending.answer(endpointError(404, 'webhook_not_found'))
    await screen.findByText(MISSING)
    await screen.findByText(EMPTY)
    expect(screen.queryByRole('region', { name: 'Delivery history' })).toBeNull()
    expect(document.activeElement).toBe(head('Webhooks'))
    expect(api.to(LIST)).toHaveLength(2)
    expect(
      api
        .to(LIST)
        .every(({ headers }) => headers.get('X-Expected-Organization-Id') === ME.organization.id),
    ).toBe(true)
  })

  it.each(['space', 'account'] as const)(
    'clears visible history and ignores an in-flight page after an observed %s change',
    async (scope) => {
      const pending = later()
      const previous =
        scope === 'account' ? { ...ME, organization: { ...ME.organization, personal: false } } : ME
      let me = previous
      const { api, user } = open({
        [ME_ROUTE]: () => json(200, me),
        [LIST]: () => json(200, me === previous ? [ENDPOINT] : []),
        [DELIVERIES]: ({ path }) =>
          path === DELIVERY_PATH ? deliveryPage([delivery], delivery.id) : pending.response,
      })
      await openHistory(user)
      await user.click(await history().findByRole('button', { name: 'Load older deliveries' }))
      await waitFor(() => expect(api.to(DELIVERIES)).toHaveLength(2))
      const oldRequest = webhookRequests().find((call) =>
        new URL(call.url).searchParams.has('after'),
      )
      me =
        scope === 'space'
          ? { ...previous, organization: { ...previous.organization, id: SECOND_SPACE } }
          : { ...previous, user: { ...previous.user, id: SECOND_SPACE } }
      await user.click(button('Refresh session'))
      await screen.findByText(EMPTY)
      expect(oldRequest?.signal.aborted).toBe(true)
      expect(document.body.textContent?.includes(delivery.id)).toBe(false)
      await pending.answer(deliveryPage([olderDelivery]))
      expect(document.body.textContent?.includes(olderDelivery.id)).toBe(false)
      expect(screen.queryByRole('region', { name: 'Delivery history' })).toBeNull()
    },
  )
})
