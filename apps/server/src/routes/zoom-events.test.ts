import { createHmac, timingSafeEqual } from 'node:crypto'
import '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType } from '@hourmere/scheduling'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conferenceTestSession } from '../../../../packages/conferences/src/testing.ts'
import { zoomScopes } from '../../../../packages/conferences/src/zoom.ts'
import { createApp } from '../app.ts'
import { productRoutes, type RunningServer, startServer } from '../server.ts'
import { ZOOM_EVENTS_PATH, zoomEventRoutes } from './zoom-events.ts'

vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const databaseUrl = process.env.DATABASE_URL
const SECRET = 'synthetic-webhook-token'
const NOW = 1_900_000_000_000
const payload = { user_id: 'zoom-target', account_id: 'shared-zoom-account' }
const deauthorized = { event: 'app_deauthorized', payload }
const validation = {
  event: 'endpoint.url_validation',
  payload: { plainToken: 'synthetic-challenge' },
}

describe.skipIf(!databaseUrl)('Zoom event endpoint (real Postgres, no provider calls)', () => {
  let database: TestDatabase,
    db: Db,
    owner: Awaited<ReturnType<typeof conferenceTestSession>>,
    other: typeof owner,
    connectionId: string,
    otherId: string,
    eventId: string,
    app: ReturnType<typeof createApp>

  function composition(secretToken: string | undefined = SECRET, database = db) {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'https://hourmere.invalid',
      routes: [zoomEventRoutes({ db: database, secretToken, now: () => NOW })],
    })
  }
  function signed(body: string, timestamp = String(NOW / 1000), secret = SECRET) {
    return {
      'content-type': 'application/json',
      'x-zm-request-timestamp': timestamp,
      'x-zm-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
    }
  }
  function post(value: unknown = deauthorized, timestamp = String(NOW / 1000)) {
    const body = JSON.stringify(value)
    return app.request(ZOOM_EVENTS_PATH, { method: 'POST', body, headers: signed(body, timestamp) })
  }
  const target = () =>
    db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow()
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
    owner = await conferenceTestSession(db)
    other = await conferenceTestSession(db)
  })
  afterAll(async () => {
    await database?.drop()
  })
  beforeEach(async () => {
    vi.mocked(timingSafeEqual).mockClear()
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('conference_oauth_states').execute()
    await db.deleteFrom('conference_connections').execute()
    const insert = async (userId: string, external: string) =>
      (
        await db
          .insertInto('conference_connections')
          .values({
            user_id: userId,
            provider: 'zoom',
            external_user_id: external,
            account_email: `${external}@example.com`,
            display_name: 'Synthetic Zoom identity',
            credentials: Buffer.from('synthetic-encrypted-credentials'),
            scopes: zoomScopes('meetings'),
            mode: 'meetings',
            status: 'active',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    connectionId = await insert(owner.user.id, payload.user_id)
    otherId = await insert(other.user.id, 'another-user-in-shared-account')
    eventId = (
      await createEventType(
        { db, principal: owner, automaticZoom: true, now: () => Temporal.Now.instant() },
        {
          slug: 'automatic-zoom',
          title: 'Automatic Zoom',
          durationMinutes: 30,
          location: { kind: 'zoom', autoCreate: true },
          zoomConnectionId: connectionId,
        },
      )
    ).id
    app = composition()
  })

  it('authenticates the raw bytes with a constant-time comparison and answers the URL challenge', async () => {
    const body = ` { "event": "endpoint.url_validation", "payload": {"plainToken":"synthetic-challenge"} }\n`
    const response = await app.request(ZOOM_EVENTS_PATH, {
      method: 'POST',
      body,
      headers: signed(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      plainToken: 'synthetic-challenge',
      encryptedToken: createHmac('sha256', SECRET).update('synthetic-challenge').digest('hex'),
    })
    expect(timingSafeEqual).toHaveBeenCalledOnce()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await target()).status).toBe('active')
  })
  it.each([
    'missing',
    'wrong secret',
    'tampered body',
    'wrong digest',
    'short digest',
    'wrong version',
  ])('refuses %s signatures before cleanup, including for challenges', async (kind) => {
    for (const event of [deauthorized, validation]) {
      const original = JSON.stringify(event)
      const headers = new Headers(
        signed(original, undefined, kind === 'wrong secret' ? 'another-secret' : SECRET),
      )
      if (kind === 'missing') headers.delete('x-zm-signature')
      if (kind === 'wrong digest') headers.set('x-zm-signature', `v0=${'0'.repeat(64)}`)
      if (kind === 'short digest') headers.set('x-zm-signature', 'v0=00')
      if (kind === 'wrong version') headers.set('x-zm-signature', `v1=${'0'.repeat(64)}`)
      const response = await app.request(ZOOM_EVENTS_PATH, {
        method: 'POST',
        headers,
        body: kind === 'tampered body' ? `${original} ` : original,
      })
      expect(response.status).toBe(401)
    }
    expect((await target()).status).toBe('active')
  })
  it.each([
    '',
    'invalid',
    '1.9e9',
    '1900000000.0',
    String(NOW / 1000 - 301),
    String(NOW / 1000 + 301),
  ])('refuses missing, malformed, stale or future timestamps (%s)', async (timestamp) => {
    expect((await post(deauthorized, timestamp)).status).toBe(401)
    expect((await target()).status).toBe('active')
  })
  it.each([-300, 300])('accepts the timestamp window boundary (%s seconds)', async (offset) => {
    expect((await post(validation, String(NOW / 1000 + offset))).status).toBe(200)
  })
  it('deletes only the matching user data, invalidates OAuth attempts and flags automatic settings', async () => {
    const beforeOther = await db
      .selectFrom('conference_connections')
      .selectAll()
      .where('id', '=', otherId)
      .executeTakeFirstOrThrow()
    const response = await post({ ...deauthorized, event_ts: 1 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect(await target()).toMatchObject({
      credentials: null,
      external_user_id: null,
      account_email: null,
      display_name: null,
      operation_id: null,
      scopes: [],
      status: 'disconnected',
    })
    expect(
      await db
        .selectFrom('conference_connections')
        .selectAll()
        .where('id', '=', otherId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeOther)
    expect(
      await db
        .selectFrom('event_types')
        .select(['is_active', 'zoom_connection_id', 'location'])
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      is_active: false,
      zoom_connection_id: connectionId,
      location: { kind: 'zoom', autoCreate: true },
    })
  })
  it('acknowledges unknown users and repeated deliveries without any further changes', async () => {
    const before = await target()
    expect(
      (await post({ event: 'app_deauthorized', payload: { ...payload, user_id: 'unknown' } }))
        .status,
    ).toBe(200)
    expect(await target()).toEqual(before)
    expect((await post()).status).toBe(200)
    const after = await target()
    expect((await post()).status).toBe(200)
    expect(await target()).toEqual(after)
    expect(await db.selectFrom('conference_connections').select('id').execute()).toHaveLength(2)
  })
  it.each([
    null,
    [],
    {},
    { user_id: payload.user_id },
    { account_id: payload.account_id },
    { ...payload, user_id: '' },
    { ...payload, account_id: 'bad\u0000id' },
  ])(
    'refuses malformed deauthorization identities without a broad account match (%j)',
    async (value) => {
      expect((await post({ event: 'app_deauthorized', payload: value })).status).toBe(400)
      expect((await target()).status).toBe('active')
    },
  )
  it.each([
    null,
    {},
    { event: 'endpoint.url_validation', payload: {} },
    { event: 'endpoint.url_validation', payload: { plainToken: 1 } },
  ])('refuses malformed event or challenge shapes (%j)', async (value) => {
    expect((await post(value)).status).toBe(400)
  })
  it('refuses authenticated malformed JSON and acknowledges unrelated events', async () => {
    const body = '{'
    expect(
      (await app.request(ZOOM_EVENTS_PATH, { method: 'POST', body, headers: signed(body) })).status,
    ).toBe(400)
    expect((await post({ event: 'meeting.started', payload: {} })).status).toBe(200)
    expect((await target()).status).toBe('active')
  })
  it('refuses authenticated invalid UTF-8 instead of replacing signed challenge bytes', async () => {
    const body = Buffer.concat([
      Buffer.from('{"event":"endpoint.url_validation","payload":{"plainToken":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ])
    const headers = signed('')
    headers['x-zm-signature'] = `v0=${createHmac('sha256', SECRET)
      .update(`v0:${NOW / 1000}:`)
      .update(body)
      .digest('hex')}`
    const response = await app.request(ZOOM_EVENTS_PATH, { method: 'POST', body, headers })
    expect(response.status).toBe(400)
    expect((await target()).status).toBe('active')
  })
  it('is absent when no webhook token is configured, including in the server composition', async () => {
    for (const zoomWebhookSecretToken of [undefined, '']) {
      app = createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        publicUrl: 'https://hourmere.invalid',
        routes: productRoutes({ db, socialProviders: {}, zoomWebhookSecretToken }),
      })
      expect((await post()).status).toBe(404)
    }
    expect((await target()).status).toBe('active')
  })
  it('enables the configured endpoint independently of OAuth and automatic-meeting flags', async () => {
    app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'https://hourmere.invalid',
      routes: productRoutes({ db, socialProviders: {}, zoomWebhookSecretToken: SECRET }),
    })
    const body = JSON.stringify(deauthorized)
    expect(
      (
        await app.request(ZOOM_EVENTS_PATH, {
          method: 'POST',
          body,
          headers: signed(body, String(Math.floor(Date.now() / 1000))),
        })
      ).status,
    ).toBe(200)
    expect((await target()).credentials).toBeNull()
  })
  it('limits declared and streamed bodies before any cleanup', async () => {
    const body = JSON.stringify({ ...deauthorized, padding: 'x'.repeat(16 * 1024) })
    for (const declared of [true, false]) {
      const headers = signed(body)
      const response = await app.request(ZOOM_EVENTS_PATH, {
        method: 'POST',
        body,
        headers: {
          ...headers,
          ...(declared && { 'content-length': String(Buffer.byteLength(body)) }),
        },
      })
      expect(response.status).toBe(413)
    }
    expect((await target()).status).toBe('active')
  })
  it('rate limits requests before reading their bodies', async () => {
    for (let i = 0; i < 120; i++) expect((await post(validation)).status).toBe(200)
    let read = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true
          throw new Error('Body must stay unread')
        },
      },
      { highWaterMark: 0 },
    )
    const response = await app.request(ZOOM_EVENTS_PATH, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: signed(''),
    } as RequestInit)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
    expect(read).toBe(false)
    expect((await target()).status).toBe('active')
  })
  it('keeps payloads, signatures, secrets and database error details out of responses and logs', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const body = JSON.stringify({ ...deauthorized, private: 'synthetic-private-pii' })
      const headers = signed(body)
      const broken = db.withPlugin({
        transformQuery() {
          throw new Error('synthetic-private-database-pii')
        },
        transformResult: async ({ result }) => result,
      })
      app = composition(SECRET, broken)
      const response = await app.request(`${ZOOM_EVENTS_PATH}?private=synthetic-query-pii`, {
        method: 'POST',
        body,
        headers,
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal_error' })
      const output = [...logs.mock.calls, ...errors.mock.calls].flat().join(' ')
      expect(output).toContain('Zoom deauthorization cleanup failed')
      expect(output.includes(SECRET)).toBe(false)
      expect(output.includes(headers['x-zm-signature'])).toBe(false)
      expect(output).not.toMatch(
        /synthetic-private|synthetic-query|zoom-target|shared-zoom-account/,
      )
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
  })
  it('forwards the optional token from the real server environment and closes all server pools', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      for (const token of ['', SECRET]) {
        running = await startServer({
          DATABASE_URL: database.url,
          BETTER_AUTH_SECRET: 'synthetic-auth-secret-for-zoom-event-tests',
          PUBLIC_URL: 'https://hourmere.invalid',
          PORT: '0',
          HOURMERE_ROLE: 'web',
          SIGNUP: 'closed',
          ZOOM_WEBHOOK_SECRET_TOKEN: token,
        })
        const body = JSON.stringify(validation)
        const response = await fetch(`http://127.0.0.1:${running.port}${ZOOM_EVENTS_PATH}`, {
          method: 'POST',
          body,
          headers: signed(body, String(Math.floor(Date.now() / 1000))),
        })
        expect(response.status).toBe(token ? 200 : 404)
        await response.body?.cancel()
        await running.close()
        running = undefined
      }
    } finally {
      await running?.close()
      for (const spy of spies) spy.mockRestore()
    }
  }, 20_000)
})
