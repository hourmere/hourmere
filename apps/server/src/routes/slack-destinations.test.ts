import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import * as webhooks from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as openapi from '../openapi.ts'
import * as teamManagement from '../team-management.ts'
import { slackDestinationRoutes } from './slack-destinations.ts'
import { productApp, syntheticSessionCookie } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const secret = 'https://hooks.slack.com/services/Tfixture/Bfixture/private-fixture-secret'
const settings = { enabled: false, encryptionKey: Buffer.alloc(32, 4).toString('base64') }
describe.skipIf(!serverUrl)('Slack REST API', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function client(session = false, factory = slackDestinationRoutes) {
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
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
    const principals = new Map<string, Principal>([['hm_slack', principal]])
    const app = productApp(db, principals, [
      factory({ db, ...settings, queue: { enqueue: async () => randomUUID() } }),
    ])
    const request = (
      path = '',
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(`/api/v1/slack-destinations${path}`, {
        method,
        headers: {
          ...(session
            ? {
                cookie: syntheticSessionCookie('hm_slack'),
                origin: 'http://localhost:3000',
                'X-Expected-Organization-Id': principal.organization.id,
              }
            : { authorization: 'Bearer hm_slack' }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    return { user, principal, principals, request, app }
  }
  it('creates, lists, updates, queues sample and deletes with masked responses even when generic webhooks are off', async () => {
    const { request } = await client()
    const created = await request('', 'POST', { url: secret, events: ['booking.created'] })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { id: string; url: string }
    expect(body.url).not.toBe(secret)
    expect(JSON.stringify(body)).not.toContain('private-fixture-secret')
    expect(await (await request()).json()).toEqual([body])
    const sample = await request(`/${body.id}/test`, 'POST')
    expect(sample.status).toBe(202)
    expect(await sample.json()).toHaveProperty('deliveryId')
    expect((await request(`/${body.id}`, 'PATCH', { isActive: false })).status).toBe(200)
    expect((await request(`/${body.id}`, 'DELETE')).status).toBe(204)
    expect(await (await request()).json()).toEqual([])
  })
  it('isolates organizations and denies read/bookings scoped writes', async () => {
    const first = await client()
    const second = await client()
    const created = (await (
      await first.request('', 'POST', { url: secret, events: ['booking.created'] })
    ).json()) as { id: string }
    expect((await second.request(`/${created.id}`, 'PATCH', { isActive: false })).status).toBe(404)
    expect((await second.request(`/${created.id}/test`, 'POST')).status).toBe(404)
    for (const scope of ['read', 'bookings'] as const) {
      if (first.principal.kind !== 'api_key') throw new Error('fixture')
      first.principals.set('hm_slack', { ...first.principal, apiKeyScope: scope })
      expect(
        (await first.request('', 'POST', { url: secret, events: ['booking.created'] })).status,
      ).toBe(403)
      expect((await first.request()).status).toBe(scope === 'read' ? 200 : 403)
    }
  })
  it('requires session expected organization and current owner/admin membership', async () => {
    const own = await client(true)
    expect(
      (
        await own.request(
          '',
          'POST',
          { url: secret, events: ['booking.created'] },
          { 'X-Expected-Organization-Id': '' },
        )
      ).status,
    ).toBe(409)
    const team = await createTestTeam(db, [{ user: own.user, role: 'member' }])
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('userId', '=', own.user.id)
      .where('organizationId', '=', team.id)
      .execute()
    own.principals.set('hm_slack', {
      ...own.principal,
      organization: { id: team.id, name: 'Team', slug: 'team', personal: false },
    })
    if (own.principal.kind !== 'session') throw new Error('fixture')
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: team.id })
      .where('id', '=', own.principal.sessionId)
      .execute()
    expect(
      (
        await own.request(
          '',
          'POST',
          { url: secret, events: ['booking.created'] },
          { 'X-Expected-Organization-Id': team.id },
        )
      ).status,
    ).toBe(403)
  })
  it('source-copy mutation detects removing the expected-organization write fence', async () => {
    let source = readFileSync('apps/server/src/routes/slack-destinations.ts', 'utf8')
    const anchor = 'prepareOrganizationWrite: async (trx: Db) => {'
    expect(source).toContain(anchor)
    const baseline = source
    source = source.replace(
      anchor,
      'prepareOrganizationWrite: async (_ignored: Db) => { return; const trx = _ignored;',
    )
    // Removing both fence hooks simulates bypassing the shared browser context guard.
    source = source.replace(
      'authorizeOrganizationWrite: organizationContextAccess(',
      'unusedOrganizationWrite: organizationContextAccess(',
    )
    source = stripTypeScriptTypes(
      source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
    ).replace(/\bexport /g, '')
    const bindings = { createRoute, z, ...webhooks, ...openapi, ...teamManagement }
    const factory = new Function(
      ...Object.keys(bindings),
      `${source}; return slackDestinationRoutes`,
    )(...Object.values(bindings)) as typeof slackDestinationRoutes
    async function verify(factory: typeof slackDestinationRoutes) {
      const own = await client(true, factory)
      const result = await own.request(
        '',
        'POST',
        { url: secret, events: ['booking.created'] },
        { 'X-Expected-Organization-Id': '' },
      )
      expect(result.status).toBe(409)
    }
    const baselineScript = stripTypeScriptTypes(
      baseline.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
    ).replace(/\bexport /g, '')
    const control = new Function(
      ...Object.keys(bindings),
      `${baselineScript}; return slackDestinationRoutes`,
    )(...Object.values(bindings)) as typeof slackDestinationRoutes
    await verify(control)
    await expect(verify(factory)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('rejects unsupported URLs and secret-bearing unknown fields without echoing them', async () => {
    const { request } = await client()
    for (const url of [
      'http://hooks.slack.com/services/T/B/secret',
      'https://127.0.0.1/services/T/B/secret',
      'https://hooks.slack.com.evil.test/services/T/B/secret',
    ]) {
      const result = await request('', 'POST', { url, events: ['booking.created'] })
      expect(result.status).toBe(400)
      expect(await result.text()).not.toContain(url)
    }
    const result = await request('', 'POST', {
      url: secret,
      events: ['booking.created'],
      [secret]: true,
    })
    expect(result.status).toBe(400)
    expect(await result.text()).not.toContain('private-fixture-secret')
  })
})
