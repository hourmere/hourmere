import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import * as core from '@hourmere/core'
import type { Db } from '@hourmere/db'
import * as scheduling from '@hourmere/scheduling'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServiceDeps } from '../openapi.ts'
import * as openapi from '../openapi.ts'
import * as teamManagement from '../team-management.ts'
import { eventTypeRoutes } from './event-types.ts'
import {
  createTestApp,
  openApiDocument,
  PUBLIC_URL,
  productApp,
  responseAndRequestStrictness,
  syntheticSessionCookie,
  type TestApp,
} from './test-app.ts'

const bootstrap = process.env.DATABASE_URL
const recipients = { invitee: true, guests: false, host: true }
const rule = (id = 'one-hour', offsetMinutes = 60) => ({ id, offsetMinutes, recipients })
const custom: NotificationSettings = {
  reminders: [rule('soon', 60), rule('early', 43200)],
  followUps: [
    { ...rule('later', 43200), hostNote: 'Thanks\r\n{{invitee.name}}\u202e' },
    rule('after', 5),
  ],
}
const normalized: NotificationSettings = {
  reminders: [rule('early', 43200), rule('soon', 60)],
  followUps: [rule('after', 5), { ...rule('later', 43200), hostNote: 'Thanks\n{{invitee.name}}' }],
}
const disabled = { reminders: [], followUps: [] }
const input = (notifications?: unknown) => ({
  slug: `notification-${randomUUID()}`,
  title: 'Notification contract',
  durationMinutes: 30,
  ...(notifications === undefined ? {} : { notifications }),
})

describe('event-type notification OpenAPI contract', () => {
  it('publishes additive open responses and strict inputs with follow-up-only notes', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const path = '/api/v1/event-types/{id}/notifications'
    expect(
      responseAndRequestStrictness(doc, ['/api/v1/event-types', '/api/v1/event-types/{id}', path]),
    ).toEqual({ closedResponses: [], openRequests: [] })
    expect(doc.paths[path]?.put?.security).toEqual([{ apiKey: [] }, { session: [] }])
    expect(Object.keys(doc.paths[path]?.put?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409', '429']),
    )
    expect({
      settings: doc.components.schemas.EventTypeNotifications,
      input: doc.components.schemas.EventTypeNotificationsInput,
      put: doc.paths[path]?.put,
    }).toMatchSnapshot()
  })
})

describe.skipIf(!bootstrap)('event-type notification REST contract', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(bootstrap as string)
  })
  afterAll(async () => {
    await t?.drop()
  })

  async function send(
    principal: Principal | undefined,
    method: string,
    path: string,
    body?: unknown,
    options: {
      factory?: typeof eventTypeRoutes
      deps?: Partial<ServiceDeps>
      headers?: Record<string, string | undefined>
    } = {},
  ) {
    const token = `hm_${randomUUID()}`
    const app = productApp(t.db, new Map(principal ? [[token, principal]] : []), [
      (options.factory ?? eventTypeRoutes)({ db: t.db, ...options.deps }),
    ])
    const headers = new Headers({ 'content-type': 'application/json' })
    if (principal?.kind === 'session') {
      headers.set('cookie', syntheticSessionCookie(token))
      headers.set('origin', PUBLIC_URL)
      headers.set('X-Expected-Organization-Id', principal.organization.id)
    } else if (principal) headers.set('authorization', `Bearer ${token}`)
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === undefined) headers.delete(name)
      else headers.set(name, value)
    }
    const response = await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }

  async function fixture() {
    const user = await createTestUser(t.db)
    const created = await t.as(user.principal).post('/api/v1/event-types', input())
    expect(created.status).toBe(201)
    return { user, id: (created.body as { id: string }).id }
  }

  it('round-trips create, get, list, PATCH and narrow PUT with canonical values and stable IDs', async () => {
    const user = await createTestUser(t.db)
    const client = t.as(user.principal)
    const created = await client.post('/api/v1/event-types', input(custom))
    expect(created).toMatchObject({ status: 201, body: { notifications: normalized } })
    const id = (created.body as { id: string }).id
    expect(await client.get(`/api/v1/event-types/${id}`)).toEqual({
      status: 200,
      body: created.body,
    })
    expect((await client.get('/api/v1/event-types')).body).toMatchObject({
      data: [{ id, notifications: normalized }],
    })
    expect(
      await client.patch(`/api/v1/event-types/${id}`, { title: 'Keep notifications' }),
    ).toMatchObject({
      status: 200,
      body: { title: 'Keep notifications', notifications: normalized },
    })
    expect(
      await client.put(`/api/v1/event-types/${id}/notifications`, { notifications: custom }),
    ).toMatchObject({
      status: 200,
      body: { id, title: 'Keep notifications', notifications: normalized },
    })
    expect(
      await client.patch(`/api/v1/event-types/${id}`, { notifications: disabled }),
    ).toMatchObject({ status: 200, body: { notifications: disabled } })
    expect(
      await client.put(`/api/v1/event-types/${id}/notifications`, { notifications: normalized }),
    ).toMatchObject({ status: 200, body: { notifications: normalized } })
  })

  it('keeps untouched defaults and accepts inclusive counts and offset boundaries', async () => {
    const { user, id } = await fixture()
    const client = t.as(user.principal)
    expect((await client.get(`/api/v1/event-types/${id}`)).body).toMatchObject({
      notifications: DEFAULT_NOTIFICATIONS,
    })
    expect(
      (await client.patch(`/api/v1/event-types/${id}`, { title: 'Unrelated edit' })).body,
    ).toMatchObject({ notifications: DEFAULT_NOTIFICATIONS })
    const maximum = {
      reminders: [5, 6, 7, 8, 43200].map((offset) => rule(`reminder-${offset}`, offset)),
      followUps: [5, 6, 43200].map((offset) => rule(`follow-${offset}`, offset)),
    }
    expect(
      (await client.put(`/api/v1/event-types/${id}/notifications`, { notifications: maximum }))
        .status,
    ).toBe(200)
    expect(
      (await client.put(`/api/v1/event-types/${id}/notifications`, { notifications: disabled }))
        .body,
    ).toMatchObject({ notifications: disabled })
  })

  it('keeps host notes private from public pages and accepts the normalized UTF-16 limit', async () => {
    const user = await createTestUser(t.db)
    const client = t.as(user.principal)
    const handle = `host-${randomUUID().slice(0, 8)}`
    expect(
      (await client.put('/api/v1/profile', { handle, timeZone: 'UTC', locale: 'en' })).status,
    ).toBe(201)
    const notifications = {
      reminders: [],
      followUps: [{ ...rule(), hostNote: `${'🙂'.repeat(999)}\r\nA\u202e` }],
    }
    const created = await client.post('/api/v1/event-types', input(notifications))
    expect(created).toMatchObject({
      status: 201,
      body: {
        notifications: {
          reminders: [],
          followUps: [{ ...rule(), hostNote: `${'🙂'.repeat(999)}\nA` }],
        },
      },
    })
    const { slug } = created.body as { slug: string }
    for (const path of [`/api/v1/public/${handle}`, `/api/v1/public/${handle}/${slug}`]) {
      const response = await t.anonymous.get(path)
      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).not.toContain('hostNote')
      expect(JSON.stringify(response.body)).not.toContain('notifications')
    }
  })

  const semanticErrors: [string, unknown][] = [
    [
      'six reminders',
      { reminders: Array.from({ length: 6 }, (_, i) => rule(`r${i}`, 5 + i)), followUps: [] },
    ],
    [
      'four follow-ups',
      { reminders: [], followUps: Array.from({ length: 4 }, (_, i) => rule(`f${i}`, 5 + i)) },
    ],
    ...[0, -1, 4, 43201, 5.5].map((offset): [string, unknown] => [
      `offset ${offset}`,
      { reminders: [rule('r', offset)], followUps: [] },
    ]),
    ...['', 'bad id', 'x'.repeat(65), '__proto__'].map((id): [string, unknown] => [
      `ID ${id}`,
      { reminders: [rule(id)], followUps: [] },
    ]),
    [
      'duplicate ID across categories',
      { reminders: [rule('same')], followUps: [rule('same', 120)] },
    ],
    ['duplicate reminder offset', { reminders: [rule('first'), rule('second')], followUps: [] }],
    ['duplicate follow-up offset', { reminders: [], followUps: [rule('first'), rule('second')] }],
    [
      'no recipients',
      {
        reminders: [{ ...rule(), recipients: { invitee: false, guests: false, host: false } }],
        followUps: [],
      },
    ],
    ['long host note', { reminders: [], followUps: [{ ...rule(), hostNote: 'x'.repeat(2001) }] }],
    [
      'UTF-16 host-note length',
      { reminders: [], followUps: [{ ...rule(), hostNote: '🙂'.repeat(1001) }] },
    ],
    [
      'control in host note',
      { reminders: [], followUps: [{ ...rule(), hostNote: 'secret\tcontrol' }] },
    ],
  ]

  it.each(semanticErrors)(
    'returns invalid_notifications for %s across every write path',
    async (_, notifications) => {
      const { user, id } = await fixture()
      const client = t.as(user.principal)
      for (const result of [
        await client.post('/api/v1/event-types', input(notifications)),
        await client.patch(`/api/v1/event-types/${id}`, { notifications }),
        await client.put(`/api/v1/event-types/${id}/notifications`, { notifications }),
      ])
        expect(result).toMatchObject({ status: 400, body: { error: 'invalid_notifications' } })
      expect((await client.get(`/api/v1/event-types/${id}`)).body).toMatchObject({
        notifications: DEFAULT_NOTIFICATIONS,
      })
    },
  )

  const shapeErrors: [string, unknown][] = [
    ['null', null],
    ['missing category', { reminders: [] }],
    ['null category', { reminders: null, followUps: [] }],
    ['unknown configuration key', { ...disabled, followups: [] }],
    ['string offset', { reminders: [{ ...rule(), offsetMinutes: '60' }], followUps: [] }],
    ['missing ID', { reminders: [{ offsetMinutes: 60, recipients }], followUps: [] }],
    [
      'missing recipient flag',
      { reminders: [{ ...rule(), recipients: { invitee: true, host: true } }], followUps: [] },
    ],
    ['null recipients', { reminders: [{ ...rule(), recipients: null }], followUps: [] }],
    [
      'unknown recipient',
      { reminders: [{ ...rule(), recipients: { ...recipients, other: true } }], followUps: [] },
    ],
    [
      'reminder host note',
      { reminders: [{ ...rule(), hostNote: 'Not supported' }], followUps: [] },
    ],
    ['non-string host note', { reminders: [], followUps: [{ ...rule(), hostNote: null }] }],
    [
      'lone surrogate in host note',
      { reminders: [], followUps: [{ ...rule(), hostNote: '\ud800' }] },
    ],
    ['NUL in host note', { reminders: [], followUps: [{ ...rule(), hostNote: 'text\u0000' }] }],
    [
      'unknown follow-up key',
      { reminders: [], followUps: [{ ...rule(), subject: 'Custom subject' }] },
    ],
  ]

  async function verifyShape(
    factory = eventTypeRoutes,
    notifications: unknown = shapeErrors[9]?.[1],
  ) {
    const { user, id } = await fixture()
    const response = await send(
      user.principal,
      'PUT',
      `/api/v1/event-types/${id}/notifications`,
      { notifications },
      { factory },
    )
    expect(response).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
  }

  it.each(shapeErrors)(
    'returns invalid_request for %s across every write path',
    async (_, notifications) => {
      const { user, id } = await fixture()
      const client = t.as(user.principal)
      for (const result of [
        await client.post('/api/v1/event-types', input(notifications)),
        await client.patch(`/api/v1/event-types/${id}`, { notifications }),
        await client.put(`/api/v1/event-types/${id}/notifications`, { notifications }),
      ])
        expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    },
  )

  it('requires the narrow PUT wrapper and refuses unrelated resource fields', async () => {
    const { user, id } = await fixture()
    for (const value of [disabled, {}, { notifications: disabled, title: 'Smuggled edit' }])
      expect(
        await t.as(user.principal).put(`/api/v1/event-types/${id}/notifications`, value),
      ).toMatchObject({ status: 400, body: { error: 'invalid_request' } })
    expect(
      (
        await send(undefined, 'PUT', `/api/v1/event-types/${id}/notifications`, {
          notifications: disabled,
        })
      ).status,
    ).toBe(401)
  })

  it('restricts API-key writes to full scope and keeps bound organization and roles', async () => {
    const { user, id } = await fixture()
    for (const apiKeyScope of ['read', 'bookings'] as const) {
      const principal: Principal = {
        ...user.principal,
        kind: 'api_key',
        apiKeyId: randomUUID(),
        apiKeyScope,
      }
      expect((await send(principal, 'GET', `/api/v1/event-types/${id}`)).status).toBe(200)
      for (const [method, path, body] of [
        ['POST', '/api/v1/event-types', input(disabled)],
        ['PATCH', `/api/v1/event-types/${id}`, { notifications: disabled }],
        ['PUT', `/api/v1/event-types/${id}/notifications`, { notifications: disabled }],
      ] as const)
        expect(await send(principal, method, path, body)).toMatchObject({
          status: 403,
          body: { error: 'insufficient_scope' },
        })
    }
    const other = await createTestUser(t.db)
    expect(
      await send(other.principal, 'PUT', `/api/v1/event-types/${id}/notifications`, {
        notifications: disabled,
      }),
    ).toMatchObject({ status: 404, body: { error: 'event_type_not_found' } })
    const owner = await createTestUser(t.db)
    const admin = await createTestUser(t.db)
    const member = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const created = await t.as(team.as(owner)).post('/api/v1/event-types', input())
    const path = `/api/v1/event-types/${(created.body as { id: string }).id}/notifications`
    expect(await send(team.as(member), 'PUT', path, { notifications: disabled })).toMatchObject({
      status: 403,
      body: { error: 'insufficient_role' },
    })
    for (const actor of [owner, admin])
      expect((await send(team.as(actor), 'PUT', path, { notifications: disabled })).status).toBe(
        200,
      )
  })

  async function session(
    user: TestUser,
    organization = user.principal.organization,
  ): Promise<Principal> {
    const row = await t.db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        activeOrganizationId: organization.id,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { kind: 'session', sessionId: row.id, user: user.principal.user, organization }
  }

  async function verifySessionContext(factory = eventTypeRoutes) {
    const { user, id } = await fixture()
    const principal = await session(user)
    const path = `/api/v1/event-types/${id}/notifications`
    const response = await send(
      principal,
      'PUT',
      path,
      { notifications: disabled },
      { factory, headers: { 'X-Expected-Organization-Id': randomUUID() } },
    )
    expect(response).toMatchObject({ status: 409, body: { error: 'organization_context_changed' } })
    expect((await t.as(user.principal).get(`/api/v1/event-types/${id}`)).body).toMatchObject({
      notifications: DEFAULT_NOTIFICATIONS,
    })
  }

  it('retains session origin, expected-organization and team management checks', async () => {
    const owner = await createTestUser(t.db)
    const admin = await createTestUser(t.db)
    const member = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const created = await t.as(team.as(owner)).post('/api/v1/event-types', input())
    const path = `/api/v1/event-types/${(created.body as { id: string }).id}/notifications`
    for (const actor of [owner, admin]) {
      const principal = await session(actor, team.as(actor).organization)
      expect((await send(principal, 'PUT', path, { notifications: disabled })).status).toBe(200)
      expect(
        await send(
          principal,
          'PUT',
          path,
          { notifications: normalized },
          { headers: { origin: 'https://foreign.example' } },
        ),
      ).toMatchObject({ status: 403, body: { error: 'forbidden' } })
      expect(
        await send(
          principal,
          'PUT',
          path,
          { notifications: normalized },
          { headers: { 'X-Expected-Organization-Id': '' } },
        ),
      ).toMatchObject({ status: 409, body: { error: 'organization_context_changed' } })
      expect(
        await send(
          principal,
          'PUT',
          path,
          { notifications: normalized },
          { headers: { 'X-Expected-Organization-Id': undefined } },
        ),
      ).toMatchObject({ status: 409, body: { error: 'organization_context_changed' } })
    }
    const principal = await session(member, team.as(member).organization)
    expect(await send(principal, 'PUT', path, { notifications: normalized })).toMatchObject({
      status: 403,
      body: { error: 'team_management_access_denied' },
    })
    await verifySessionContext()
  })

  async function verifyOperatorSwitch(factory = eventTypeRoutes) {
    const { user, id } = await fixture()
    const response = await send(
      user.principal,
      'PUT',
      `/api/v1/event-types/${id}/notifications`,
      { notifications: normalized },
      { factory, deps: { followUpHostNotesEnabled: false } },
    )
    expect(response).toMatchObject({ status: 400, body: { error: 'invalid_notifications' } })
  }

  it('enforces the operator switch on all writes while allowing built-in follow-ups', async () => {
    const { user, id } = await fixture()
    for (const [method, path, body] of [
      ['POST', '/api/v1/event-types', input(normalized)],
      ['PATCH', `/api/v1/event-types/${id}`, { notifications: normalized }],
      ['PUT', `/api/v1/event-types/${id}/notifications`, { notifications: normalized }],
    ] as const)
      expect(
        await send(user.principal, method, path, body, {
          deps: { followUpHostNotesEnabled: false },
        }),
      ).toMatchObject({ status: 400, body: { error: 'invalid_notifications' } })
    expect(
      (
        await send(
          user.principal,
          'PUT',
          `/api/v1/event-types/${id}/notifications`,
          { notifications: { reminders: [], followUps: [rule()] } },
          { deps: { followUpHostNotesEnabled: false } },
        )
      ).status,
    ).toBe(200)
  })

  function sourceCopy(replacement?: [string, string]): typeof eventTypeRoutes {
    let source = readFileSync(new URL('./event-types.ts', import.meta.url), 'utf8')
    if (replacement) {
      expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
      source = source.replace(...replacement)
    }
    source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
    const bindings = { createRoute, z, ...core, ...scheduling, ...openapi, ...teamManagement }
    return new Function(...Object.keys(bindings), `${source}; return eventTypeRoutes`)(
      ...Object.values(bindings),
    ) as typeof eventTypeRoutes
  }

  it('passes protection assertions with an unmodified isolated source copy', async () => {
    const copy = sourceCopy()
    await verifyShape(copy)
    await verifySessionContext(copy)
    await verifyOperatorSwitch(copy)
  })

  it('detects loss of strict reminder shape at the transport boundary', async () => {
    const copy = sourceCopy([
      'z.array(z.strictObject(notificationFields))',
      'z.array(z.object(notificationFields))',
    ])
    await expect(verifyShape(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects loss of expected-organization authorization for notification writes', async () => {
    const copy = sourceCopy([
      'authorizeOrganizationWrite: organizationWriteAccess(principal, expectedOrganizationId)',
      'authorizeOrganizationWrite: undefined',
    ])
    await expect(verifySessionContext(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects bypassing the operator switch in notification write context', async () => {
    const copy = sourceCopy([
      '...serviceContext(deps, principal),',
      '...serviceContext({ ...deps, followUpHostNotesEnabled: true }, principal),',
    ])
    await expect(verifyOperatorSwitch(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
