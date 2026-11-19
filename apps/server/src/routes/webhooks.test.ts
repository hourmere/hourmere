import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { productApp, syntheticSessionCookie } from './test-app.ts'
import { webhookRoutes } from './webhooks.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('webhook REST API', () => {
  let owned: TestDatabase
  let db: Db
  const key = Buffer.alloc(32, 4).toString('base64')
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function client(enabled = true, session = false) {
    const user = await createTestUser(db)
    const principal: Principal = session
      ? { ...user.principal, kind: 'session', sessionId: randomUUID() }
      : user.principal
    if (principal.kind === 'session')
      await db
        .insertInto('auth.session')
        .values({
          id: principal.sessionId,
          userId: user.id,
          token: randomUUID(),
          activeOrganizationId: principal.organization.id,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
    const principals = new Map([['hm_webhook_fixture', principal]])
    const app = productApp(db, principals, [webhookRoutes({ db, enabled, encryptionKey: key })])
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(`/api/v1${path}`, {
        method,
        headers: {
          ...(session
            ? { cookie: syntheticSessionCookie('hm_webhook_fixture') }
            : { authorization: 'Bearer hm_webhook_fixture' }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(session ? { 'X-Expected-Organization-Id': principal.organization.id } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    return { user, app, request, principals }
  }
  it('creates once-revealed secrets, lists safe metadata, updates, rotates and deletes', async () => {
    const { request } = await client()
    const created = await request('/webhooks', 'POST', {
      url: 'https://hooks.example.com/',
      events: ['booking.created'],
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const data = (await created.json()) as { secret: string; webhook: { id: string } }
    expect(typeof data.secret === 'string').toBe(true)
    const listed = await request('/webhooks')
    const list = await listed.json()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list).includes(data.secret)).toBe(false)
    expect(
      (await request(`/webhooks/${data.webhook.id}`, 'PATCH', { isActive: false })).status,
    ).toBe(200)
    expect(
      (
        (await (await request(`/webhooks/${data.webhook.id}/deliveries`)).json()) as {
          data: unknown[]
        }
      ).data,
    ).toEqual([])
    const rotated = (await (
      await request(`/webhooks/${data.webhook.id}/rotate-secret`, 'POST')
    ).json()) as { secret: string }
    expect(rotated.secret === data.secret).toBe(false)
    expect((await request(`/webhooks/${data.webhook.id}`, 'DELETE')).status).toBe(204)
    expect((await request(`/webhooks/${data.webhook.id}/deliveries`)).status).toBe(404)
  })
  it('requires authentication before reading a body', async () => {
    const { app } = await client()
    const response = await app.request('/api/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    })
    expect(response.status).toBe(401)
  })
  it('keeps write bodies strict and enforces the global opt-in', async () => {
    const { request } = await client(false)
    expect(
      (
        await request('/webhooks', 'POST', {
          url: 'https://hooks.example.com/',
          events: ['booking.created'],
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request('/webhooks', 'POST', {
          url: 'https://hooks.example.com/',
          events: ['booking.created'],
          unknown: true,
        })
      ).status,
    ).toBe(400)
    expect((await request('/webhooks/not-an-id/deliveries')).status).toBe(404)
  })
  it.each([true, false])(
    'refuses workflow subscriptions with webhooks enabled=%s',
    async (enabled) => {
      const { request } = await client(enabled)
      for (const url of ['https://hooks.example.com/', 'http://127.0.0.1/']) {
        const response = await request('/webhooks', 'POST', { url, events: ['workflow.executed'] })
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'workflows_disabled' })
      }
      expect(await (await request('/webhooks')).json()).toEqual([])
    },
  )
  it('lets an owner keep or remove a workflow subscription while workflows are disabled', async () => {
    const { request } = await client()
    const bookingEvents = ['booking.reschedule_requested', 'booking.attendee_no_show_changed']
    const events = [...bookingEvents, 'workflow.executed'].sort()
    const created = await request('/webhooks', 'POST', {
      url: 'https://hooks.example.com/',
      events: bookingEvents,
    })
    expect(created.status).toBe(201)
    const { webhook } = (await created.json()) as { webhook: { id: string } }
    const path = `/webhooks/${webhook.id}`
    const addition = await request(path, 'PATCH', { events })
    expect(addition.status).toBe(404)
    expect(await addition.json()).toEqual({ error: 'workflows_disabled' })
    expect(await (await request('/webhooks')).json()).toMatchObject([
      { events: bookingEvents.sort() },
    ])

    // A subscription saved by an enabled build can outlive that build.
    await db.updateTable('webhooks').set({ events }).where('id', '=', webhook.id).execute()
    const outsider = await client()
    const foreign = await outsider.request(path, 'PATCH', { events })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'webhook_not_found' })
    const keep = await request(path, 'PATCH', { events })
    expect(keep.status).toBe(200)
    expect(await keep.json()).toMatchObject({ events })
    const remove = await request(path, 'PATCH', { events: bookingEvents })
    expect(remove.status).toBe(200)
    expect(await remove.json()).toMatchObject({ events: bookingEvents })
  })
  it('enforces same-origin session writes before side effects', async () => {
    const { request } = await client(true, true)
    const body = { url: 'https://hooks.example.com/', events: ['booking.created'] }
    expect(
      (await request('/webhooks', 'POST', body, { origin: 'https://other.example.com' })).status,
    ).toBe(403)
    expect(
      (await request('/webhooks', 'POST', body, { origin: 'http://localhost:3000' })).status,
    ).toBe(201)
  })
  it('does not let a member read organization-level endpoint data', async () => {
    const { user, request, principals } = await client()
    const team = await createTestTeam(db, [{ user, role: 'member' }])
    principals.set('hm_webhook_fixture', team.as(user))
    const response = await request('/webhooks')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'insufficient_role' })
  })
})
