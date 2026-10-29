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
