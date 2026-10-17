// The MCP server end to end against a throwaway database: real API keys (Better Auth), the
// per-key rate limit, and the booking tools on the shared services.
import { randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { PUBLIC_RATE_LIMITS, type RateLimit } from '../rate-limit.ts'
import { bookingRoutes } from '../routes/bookings.ts'
import { publicRoutes } from '../routes/public.ts'
import { type BookingToolsDeps, bookingTools } from './bookings.ts'
import { mcpEndpoint } from './endpoint.ts'
import { whoamiTool } from './whoami.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:3000'
// Mon 2026-11-02; Berlin is on CET (+01:00), so 09:00–17:00 local is 08:00Z–16:00Z.
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const SERIALIZED = { timeout: 20_000 }
const plenty: RateLimit = { limit: 100_000, windowSeconds: 60 }

interface Booked {
  booking: {
    id: string
    status: string
    start: string
    source: string
    rescheduledFromId: string | null
  }
  manageToken: string | null
  replayed?: boolean
}

type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown }

describe.skipIf(!serverUrl)('MCP with real API keys and bookings', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let auth: Auth
  let f: Fixtures
  let ada: Awaited<ReturnType<Fixtures['host']>>
  let agent: { userId: string; key: string; keyId: string }
  let adaKey: { key: string; keyId: string }

  function appWith(rateLimits: BookingToolsDeps['rateLimits'] = {}) {
    const limits = { page: plenty, slots: plenty, book: plenty, manage: plenty, ...rateLimits }
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: PUBLIC_URL,
      routes: [
        publicRoutes({ db, now: () => NOW, rateLimits: limits }),
        bookingRoutes({ db, now: () => NOW, rateLimits: limits }),
      ],
      mcp: mcpEndpoint({
        tools: [whoamiTool, ...bookingTools({ db, now: () => NOW, rateLimits: limits })],
      }),
    })
  }
  let app: ReturnType<typeof createApp>

  async function createKey(userId: string, name: string) {
    const created = await auth.api.createApiKey({ body: { userId, name } })
    return { key: created.key, keyId: created.id }
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    // Users come from fixtures; the sign-up policy is not what these tests are about.
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(testDb.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: PUBLIC_URL,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async () => {} },
      signup,
    })
    f = createFixtures(db)
    ada = await f.host({ name: 'Ada Lovelace', handle: 'ada' })
    await f.schedule(ada.userId)
    await f.eventType(ada.organizationId, ada.userId, {
      slug: 'intro',
      title: 'Intro call',
      durationMinutes: 30,
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
    })
    adaKey = await createKey(ada.userId, 'ada')
    const grace = await f.host({ name: 'Grace Hopper', handle: null })
    agent = { userId: grace.userId, ...(await createKey(grace.userId, 'assistant')) }
    app = appWith()
  })

  afterAll(async () => {
    await authPool?.end()
    await testDb?.drop()
  })

  async function connect(key: string, a = app) {
    const client = new Client({ name: 'test-agent', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
        fetch: async (input, init) => a.request(input, init),
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    )
    return client
  }

  /** Calls one tool on a fresh connection, as a stateless client may. */
  async function call(name: string, args: Record<string, unknown>, key = agent.key, a = app) {
    const client = await connect(key, a)
    try {
      return (await client.callTool({ name, arguments: args })) as ToolResult
    } finally {
      await client.close()
    }
  }

  const ok = <T>(result: ToolResult): T => {
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    return result.structuredContent as T
  }
  const errorOf = (result: ToolResult) => {
    expect(result.isError).toBe(true)
    return JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null') as {
      error: string
      message?: string
    }
  }

  const initialize = (key: string) =>
    app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
      }),
    })

  const bookingArgs = (start: string, more: Record<string, unknown> = {}) => ({
    handle: 'ada',
    slug: 'intro',
    start,
    invitee: { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'America/New_York' },
    responses: { topic: 'Compilers' },
    ...more,
  })

  describe('API keys', () => {
    it('whoami names the key, its user and the organization it acts in', async () => {
      const me = ok<{
        user: { id: string }
        organization: { personal: boolean }
        principal: unknown
      }>(await call('whoami', {}))
      expect(me.user.id).toBe(agent.userId)
      expect(me.organization.personal).toBe(true)
      expect(me.principal).toEqual({ kind: 'api_key', apiKeyId: agent.keyId })
    })

    it('refuses disabled and deleted keys with 401', async () => {
      const disabled = await createKey(agent.userId, 'disabled')
      expect((await initialize(disabled.key)).status).toBe(200)
      await auth.api.updateApiKey({
        body: { keyId: disabled.keyId, userId: agent.userId, enabled: false },
      })
      const refused = await initialize(disabled.key)
      expect(refused.status).toBe(401)
      expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')

      const deleted = await createKey(agent.userId, 'deleted')
      await testDb.pool.query('DELETE FROM auth.apikey WHERE id = $1', [deleted.keyId])
      expect((await initialize(deleted.key)).status).toBe(401)
      expect((await initialize('hm_not-a-real-key')).status).toBe(401)
    })

    it("applies the key's rate limit to MCP requests as to REST", async () => {
      const limited = await createKey(agent.userId, 'limited')
      await auth.api.updateApiKey({
        body: { keyId: limited.keyId, userId: agent.userId, rateLimitMax: 1 },
      })
      expect((await initialize(limited.key)).status).toBe(200)
      const res = await initialize(limited.key)
      expect(res.status).toBe(429)
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
      // The same budget: REST is refused too.
      const rest = await app.request('/api/v1/me', {
        headers: { authorization: `Bearer ${limited.key}` },
      })
      expect(rest.status).toBe(429)
    })
  })

  describe('find_available_slots', () => {
    it('reads the dates in the requested time zone and gives each slot in UTC and in it', async () => {
      const berlin = ok<{
        eventType: { title: string; questions: unknown[]; host: { timeZone: string } }
        timeZone: string
        slots: { start: string; end: string; localStart: string; localEnd: string }[]
      }>(
        await call('find_available_slots', {
          handle: 'ada',
          slug: 'intro',
          timeZone: 'europe/berlin',
          startDate: '2026-11-02',
          endDate: '2026-11-02',
        }),
      )
      expect(berlin.timeZone).toBe('Europe/Berlin')
      expect(berlin.eventType).toMatchObject({
        title: 'Intro call',
        questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
        host: { timeZone: 'Europe/Berlin' },
      })
      expect(berlin.slots).toHaveLength(16)
      expect(berlin.slots[0]).toEqual({
        start: '2026-11-02T08:00:00.000Z',
        end: '2026-11-02T08:30:00.000Z',
        localStart: '2026-11-02T09:00:00+01:00',
        localEnd: '2026-11-02T09:30:00+01:00',
      })

      // 2 November in Tokyo ends at 15:00Z, so only Berlin's morning is left.
      const tokyo = ok<{ slots: { start: string; localStart: string }[] }>(
        await call('find_available_slots', {
          handle: 'ada',
          slug: 'intro',
          timeZone: 'Asia/Tokyo',
          startDate: '2026-11-02',
          endDate: '2026-11-02',
        }),
      )
      expect(tokyo.slots.at(-1)).toMatchObject({
        start: '2026-11-02T14:30:00.000Z',
        localStart: '2026-11-02T23:30:00+09:00',
      })
      expect(tokyo.slots).toHaveLength(14)
    })

    it('cuts the hour a daylight saving change adds to a 62-day search', async () => {
      // New York leaves daylight saving time on 1 November, so these 62 days last
      // 62 × 24 + 1 hours, one more than the slots service takes.
      const result = ok<{ slots: { start: string }[] }>(
        await call('find_available_slots', {
          handle: 'ada',
          slug: 'intro',
          timeZone: 'America/New_York',
          startDate: '2026-10-02',
          endDate: '2026-12-02',
        }),
      )
      expect(result.slots.length).toBeGreaterThan(100)
      expect(result.slots.at(-1)?.start.startsWith('2026-12-02')).toBe(true)
    })

    it.each([
      [{ timeZone: '+01:00' }, 'invalid_time_zone'],
      [{ timeZone: 'Mars/Olympus' }, 'invalid_time_zone'],
      [{ startDate: '2026-11-03', endDate: '2026-11-02' }, 'invalid_range'],
      [{ startDate: '2026-11-01', endDate: '2027-01-15' }, 'range_too_long'],
      [{ slug: 'nope' }, 'event_type_not_found'],
      [{ startDate: '2026-11-31' }, 'invalid_request'],
    ])('answers %j with %s', async (change, code) => {
      const result = await call('find_available_slots', {
        handle: 'ada',
        slug: 'intro',
        timeZone: 'Europe/Berlin',
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        ...change,
      })
      expect(errorOf(result).error).toBe(code)
    })
  })

  describe('booking', () => {
    it('books a slot as an agent, then refuses the same slot', async () => {
      const booked = ok<Booked>(await call('create_booking', bookingArgs('2026-11-02T08:00:00Z')))
      expect(booked.booking).toMatchObject({
        status: 'confirmed',
        start: '2026-11-02T08:00:00.000Z',
        source: 'mcp',
      })
      expect(booked.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(booked.replayed).toBe(false)
      const row = await testDb.pool.query('SELECT source, api_key_id FROM bookings WHERE id = $1', [
        booked.booking.id,
      ])
      expect(row.rows).toEqual([{ source: 'mcp', api_key_id: agent.keyId }])

      const again = await call(
        'create_booking',
        bookingArgs('2026-11-02T08:00:00Z', {
          invitee: { name: 'Someone', email: 's@example.com', timeZone: 'UTC' },
        }),
      )
      expect(errorOf(again)).toEqual({
        error: 'slot_unavailable',
        message: 'This time is not available',
      })
    })

    it('lets exactly one of concurrent bookings of one slot succeed', SERIALIZED, async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          call(
            'create_booking',
            bookingArgs('2026-11-02T08:30:00Z', {
              invitee: { name: `Invitee ${i}`, email: `i${i}@example.com`, timeZone: 'UTC' },
            }),
          ),
        ),
      )
      expect(results.filter((r) => !r.isError)).toHaveLength(1)
      for (const r of results.filter((r) => r.isError)) {
        expect(['slot_taken', 'slot_unavailable']).toContain(errorOf(r).error)
      }
    })

    it('refuses invalid bookings with the REST codes', async () => {
      const noAnswer = await call(
        'create_booking',
        bookingArgs('2026-11-02T09:00:00Z', { responses: {} }),
      )
      expect(errorOf(noAnswer).error).toBe('invalid_responses')
      const badEmail = await call(
        'create_booking',
        bookingArgs('2026-11-02T09:00:00Z', {
          invitee: { name: 'G', email: 'nope', timeZone: 'UTC' },
        }),
      )
      expect(errorOf(badEmail)).toMatchObject({
        error: 'invalid_request',
        message: expect.stringMatching(/invitee\.email/),
      })
      const offGrid = await call('create_booking', bookingArgs('2026-11-02T09:10:00Z'))
      expect(errorOf(offGrid).error).toBe('slot_unavailable')
    })

    it('replays a retry with the same idempotencyKey, scoped to the API key', async () => {
      const idempotencyKey = randomUUID()
      const first = ok<Booked>(
        await call('create_booking', bookingArgs('2026-11-02T10:00:00Z', { idempotencyKey })),
      )
      const retry = ok<Booked>(
        await call('create_booking', bookingArgs('2026-11-02T10:00:00Z', { idempotencyKey })),
      )
      expect(retry).toEqual({ booking: first.booking, manageToken: null, replayed: true })

      const different = await call(
        'create_booking',
        bookingArgs('2026-11-02T10:30:00Z', { idempotencyKey }),
      )
      expect(errorOf(different).error).toBe('idempotency_key_reused')

      // Another key's agent, and the anonymous booking page, have scopes of their own.
      const other = ok<Booked>(
        await call(
          'create_booking',
          bookingArgs('2026-11-02T11:00:00Z', { idempotencyKey }),
          adaKey.key,
        ),
      )
      expect(other.booking.id).not.toBe(first.booking.id)
      const page = await app.request('/api/v1/public/ada/intro/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          start: '2026-11-02T11:30:00Z',
          invitee: { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'UTC' },
          responses: { topic: 'Compilers' },
        }),
      })
      expect(page.status).toBe(201)
    })

    it('reschedules and cancels with the manage token, never logging it', async () => {
      const lines: string[] = []
      const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args) => {
          lines.push(args.map(String).join(' '))
        }),
      )
      const tokens: string[] = []
      try {
        const booked = ok<Booked>(await call('create_booking', bookingArgs('2026-11-02T12:00:00Z')))
        tokens.push(booked.manageToken as string)
        const moved = ok<Booked>(
          await call('reschedule_booking', {
            manageToken: booked.manageToken,
            start: '2026-11-02T12:30:00Z',
          }),
        )
        tokens.push(moved.manageToken as string)
        expect(moved.booking).toMatchObject({
          start: '2026-11-02T12:30:00.000Z',
          status: 'confirmed',
          source: 'mcp',
          rescheduledFromId: booked.booking.id,
        })
        expect(moved.manageToken).not.toBe(booked.manageToken)

        const retry = await call('reschedule_booking', {
          manageToken: booked.manageToken,
          start: '2026-11-02T13:00:00Z',
        })
        expect(errorOf(retry).error).toBe('booking_cancelled')

        const cancelled = ok<{ status: string; cancelReason: string | null }>(
          await call('cancel_booking', { manageToken: moved.manageToken, reason: 'Plans changed' }),
        )
        expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Plans changed' })
        const attribution = await db
          .selectFrom('bookings')
          .select(['id', 'source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
          .where('id', 'in', [booked.booking.id, moved.booking.id])
          .execute()
        expect(attribution).toEqual(
          expect.arrayContaining(
            [booked.booking.id, moved.booking.id].map((id) => ({
              id,
              source: 'mcp',
              api_key_id: agent.keyId,
              cancelled_source: 'mcp',
              cancelled_api_key_id: agent.keyId,
            })),
          ),
        )
        const twice = await call('cancel_booking', { manageToken: moved.manageToken })
        expect(errorOf(twice).error).toBe('booking_cancelled')
        const unknown = await call('cancel_booking', { manageToken: 'x'.repeat(43) })
        expect(errorOf(unknown).error).toBe('booking_not_found')
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
      expect(tokens).toHaveLength(2)
      for (const token of tokens) {
        expect(lines.some((l) => l.includes(token))).toBe(false)
      }
    })

    it("lists and cancels the host's bookings with the host's key", async () => {
      const booked = ok<Booked>(await call('create_booking', bookingArgs('2026-11-02T14:00:00Z')))

      const page = ok<{ data: { id: string; source: string }[]; nextCursor: string | null }>(
        await call(
          'list_bookings',
          { from: '2026-11-02T14:00:00Z', to: '2026-11-02T15:00:00Z', limit: 10 },
          adaKey.key,
        ),
      )
      expect(page.data.map((b) => b.id)).toEqual([booked.booking.id])
      expect(page.nextCursor).toBeNull()
      // The agent hosts nothing.
      expect(ok<{ data: unknown[] }>(await call('list_bookings', {})).data).toEqual([])

      const notMine = await call('cancel_booking', { bookingId: booked.booking.id })
      expect(errorOf(notMine).error).toBe('booking_not_found')
      const cancelled = ok<{ id: string; status: string }>(
        await call('cancel_booking', { bookingId: booked.booking.id }, adaKey.key),
      )
      expect(cancelled).toMatchObject({ id: booked.booking.id, status: 'cancelled' })
      expect(
        await db
          .selectFrom('bookings')
          .select(['source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
          .where('id', '=', booked.booking.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        source: 'mcp',
        api_key_id: agent.keyId,
        cancelled_source: 'mcp',
        cancelled_api_key_id: adaKey.keyId,
      })
    })

    it('records the cancelling MCP key on a web booking, retaining it after key deletion', async () => {
      const response = await app.request('/api/v1/public/ada/intro/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: '2026-11-03T10:00:00Z',
          invitee: { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'UTC' },
          responses: { topic: 'Compilers' },
        }),
      })
      expect(response.status).toBe(201)
      const booked = (await response.json()) as Booked
      const key = await createKey(agent.userId, 'cancellation audit')
      const cancelled = ok<Record<string, unknown>>(
        await call('cancel_booking', { manageToken: booked.manageToken }, key.key),
      )
      expect(cancelled).toMatchObject({ id: booked.booking.id, status: 'cancelled', source: 'web' })
      for (const field of [
        'apiKeyId',
        'cancelledSource',
        'cancelledApiKeyId',
        'cancelled_source',
        'cancelled_api_key_id',
      ]) {
        expect(cancelled).not.toHaveProperty(field)
      }
      expect(JSON.stringify(cancelled)).not.toContain(key.keyId)
      await testDb.pool.query('DELETE FROM auth.apikey WHERE id = $1', [key.keyId])
      expect(
        await db
          .selectFrom('bookings')
          .select(['source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
          .where('id', '=', booked.booking.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        source: 'web',
        api_key_id: null,
        cancelled_source: 'mcp',
        cancelled_api_key_id: key.keyId,
      })
    })

    it('records api rather than mcp when the host cancels through REST', async () => {
      const booked = ok<Booked>(await call('create_booking', bookingArgs('2026-11-03T11:00:00Z')))
      const response = await app.request(`/api/v1/bookings/${booked.booking.id}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adaKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Host cancelled through REST' }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: booked.booking.id,
        status: 'cancelled',
        source: 'mcp',
      })
      expect(
        await db
          .selectFrom('bookings')
          .select(['source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
          .where('id', '=', booked.booking.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        source: 'mcp',
        api_key_id: agent.keyId,
        cancelled_source: 'api',
        cancelled_api_key_id: adaKey.keyId,
      })
    })

    it('needs exactly one of bookingId and manageToken to cancel', async () => {
      for (const args of [{}, { bookingId: randomUUID(), manageToken: 'x'.repeat(43) }]) {
        expect(errorOf(await call('cancel_booking', args))).toMatchObject({
          error: 'invalid_request',
          message: expect.stringMatching(/exactly one/),
        })
      }
    })

    it('counts create_booking per user, across keys: the 11th call in a minute is refused', async () => {
      const real = appWith({ book: PUBLIC_RATE_LIMITS.book })
      const busy = await f.host({ name: 'Busy Agent', handle: null })
      const first = await createKey(busy.userId, 'first')
      const second = await createKey(busy.userId, 'second')
      const other = await f.host({ name: 'Other Agent', handle: null })
      const otherKey = await createKey(other.userId, 'other')
      // Not a slot, so nothing is booked, but every call counts.
      const args = bookingArgs('2026-11-02T09:10:00Z')
      const client = await connect(first.key, real)
      try {
        for (let i = 0; i < PUBLIC_RATE_LIMITS.book.limit; i++) {
          const result = await client.callTool({ name: 'create_booking', arguments: args })
          expect(errorOf(result as ToolResult).error).toBe('slot_unavailable')
        }
        const eleventh = await client.callTool({ name: 'create_booking', arguments: args })
        expect(errorOf(eleventh as ToolResult)).toMatchObject({
          error: 'rate_limited',
          retryAfterSeconds: expect.any(Number),
        })
      } finally {
        await client.close()
      }
      // Another key of the same user shares the count; another user does not.
      expect(errorOf(await call('create_booking', args, second.key, real)).error).toBe(
        'rate_limited',
      )
      expect(errorOf(await call('create_booking', args, otherKey.key, real)).error).toBe(
        'slot_unavailable',
      )
    })

    it('counts find_available_slots and the manage-token tools per user too', async () => {
      const once = { limit: 1, windowSeconds: 60 }
      const limited = appWith({ slots: once, manage: once })
      const busy = await f.host({ name: 'Busy Agent', handle: null })
      const first = await createKey(busy.userId, 'first')
      const second = await createKey(busy.userId, 'second')
      const other = await f.host({ name: 'Other Agent', handle: null })
      const otherKey = await createKey(other.userId, 'other')
      const slotArgs = {
        handle: 'ada',
        slug: 'intro',
        timeZone: 'UTC',
        startDate: '2026-11-03',
        endDate: '2026-11-03',
      }
      ok(await call('find_available_slots', slotArgs, first.key, limited))
      expect(
        errorOf(await call('find_available_slots', slotArgs, second.key, limited)),
      ).toMatchObject({ error: 'rate_limited' })
      ok(await call('find_available_slots', slotArgs, otherKey.key, limited))

      // Rescheduling and cancelling with a manage token share one count.
      const booked = ok<Booked>(
        await call('create_booking', bookingArgs('2026-11-03T08:00:00Z'), first.key, limited),
      )
      const moved = ok<Booked>(
        await call(
          'reschedule_booking',
          { manageToken: booked.manageToken, start: '2026-11-03T08:30:00Z' },
          first.key,
          limited,
        ),
      )
      expect(
        errorOf(
          await call('cancel_booking', { manageToken: moved.manageToken }, second.key, limited),
        ),
      ).toMatchObject({ error: 'rate_limited' })
      ok(await call('cancel_booking', { manageToken: moved.manageToken }, otherKey.key, limited))
    })
  })
})
