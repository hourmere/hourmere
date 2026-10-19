import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { BookingEvent, BookingNotifier } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingTools } from '../mcp/bookings.ts'
import type { RateLimit } from '../rate-limit.ts'
import { type BookingRoutesDeps, bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const PUBLIC_URL = 'http://localhost:3000'
const RANGE = new URLSearchParams({ start: '2026-11-04T08:00:00Z', end: '2026-11-04T12:00:00Z' })
const plenty: RateLimit = { limit: 100_000, windowSeconds: 60 }

describe.skipIf(!serverUrl)('host rescheduling over REST', () => {
  let testDb: TestDatabase
  let db: Db
  const principals = new Map<string, Principal>()
  const events: BookingEvent[] = []
  const notify: BookingNotifier = async (_trx, event) => {
    events.push(event)
  }

  const appWith = (
    rateLimits = { manage: plenty, slots: plenty },
    hostRateLimits: BookingRoutesDeps['hostRateLimits'] = { manage: plenty, slots: plenty },
  ) =>
    createApp({
      publicUrl: PUBLIC_URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => {
        const credential =
          headers.get('authorization')?.replace('Bearer ', '') ?? headers.get('cookie')
        const principal = principals.get(credential ?? '')
        return principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [
        bookingRoutes({ db, now: () => NOW, notify, rateLimits, hostRateLimits }),
        publicRoutes({ db, now: () => NOW }),
      ],
    })

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })

  async function fixture() {
    const f = createFixtures(db)
    const personalHost = await f.host()
    const organizationId = await f.organization()
    await f.member(personalHost.userId, organizationId)
    const host = { ...personalHost, organizationId }
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    const id = await f.booking(
      host.organizationId,
      [host.userId],
      '2026-11-04T09:00:00Z',
      '2026-11-04T09:30:00Z',
      { eventTypeId },
    )
    const base = {
      user: { id: host.userId, name: '', email: '' },
      organization: { id: host.organizationId, name: '', slug: '', personal: false },
    }
    const key = crypto.randomUUID()
    const session = crypto.randomUUID()
    const apiKeyId = crypto.randomUUID()
    principals.set(key, { ...base, kind: 'api_key', apiKeyId })
    principals.set(session, { ...base, kind: 'session', sessionId: crypto.randomUUID() })
    return { f, host, id, key, session, apiKeyId, base }
  }

  function post(
    app: ReturnType<typeof createApp>,
    id: string,
    headers: Record<string, string>,
    body: unknown = { start: '2026-11-04T09:00:00Z' },
  ) {
    return app.request(`/api/v1/bookings/${id}/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it.each(['api_key', 'session'] as const)(
    'moves as %s, retains invitee access and attributes the operation',
    async (kind) => {
      const { id, key, session, apiKeyId } = await fixture()
      const app = appWith()
      const headers: Record<string, string> =
        kind === 'api_key'
          ? { authorization: `Bearer ${key}` }
          : { cookie: session, origin: PUBLIC_URL }
      const oldHash = (
        await db
          .selectFrom('bookings')
          .select('manage_token_hash')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).manage_token_hash
      const res = await post(app, id, headers)
      expect(res.status).toBe(200)
      const result = (await res.json()) as {
        booking: { id: string; start: string; rescheduledFromId: string; source: string }
        manageToken: string | null
      }
      expect(result.manageToken === null).toBe(true)
      expect(result.booking).toMatchObject({
        start: '2026-11-04T09:00:00.000Z',
        rescheduledFromId: id,
        source: kind === 'api_key' ? 'api' : 'web',
      })
      const old = await db
        .selectFrom('bookings')
        .select(['status', 'manage_token_hash', 'cancelled_source', 'cancelled_api_key_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      const successor = await db
        .selectFrom('bookings')
        .select(['manage_token_hash', 'api_key_id'])
        .where('id', '=', result.booking.id)
        .executeTakeFirstOrThrow()
      expect(old.manage_token_hash === null).toBe(true)
      expect(successor.manage_token_hash?.equals(oldHash as Buffer)).toBe(true)
      expect(old).toMatchObject({
        status: 'cancelled',
        cancelled_source: kind === 'api_key' ? 'api' : 'web',
        cancelled_api_key_id: kind === 'api_key' ? apiKeyId : null,
      })
      expect(successor.api_key_id).toBe(kind === 'api_key' ? apiKeyId : null)
      const detail = await app.request(`/api/v1/bookings/${id}`, { headers })
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        id,
        status: 'cancelled',
        rescheduledToId: result.booking.id,
      })
      const list = await app.request('/api/v1/bookings?status=cancelled&limit=1', { headers })
      expect(list.status).toBe(200)
      expect(await list.json()).toMatchObject({
        data: [{ id, status: 'cancelled', rescheduledToId: result.booking.id }],
      })
      expect(
        events.some(
          (event) => event.type === 'rescheduled' && event.bookingId === result.booking.id,
        ),
      ).toBe(true)
      const replay = await post(app, id, headers)
      expect(replay.status).toBe(409)
      expect(await replay.json()).toMatchObject({ error: 'booking_cancelled' })
    },
  )

  it('offers the current slot without a token and scopes both routes to host and organization', async () => {
    const { f, host, id, key, base } = await fixture()
    const app = appWith()
    const path = `/api/v1/bookings/${id}/slots?${RANGE}`
    const own = await app.request(path, { headers: { authorization: `Bearer ${key}` } })
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({
      data: expect.arrayContaining([
        { start: '2026-11-04T09:00:00.000Z', end: '2026-11-04T09:30:00.000Z' },
      ]),
    })
    const team = await f.organization()
    await f.member(host.userId, team)
    const outsider = await f.host()
    await f.member(outsider.userId, host.organizationId)
    principals.set('wrong-org', {
      ...base,
      kind: 'api_key',
      apiKeyId: crypto.randomUUID(),
      organization: { ...base.organization, id: team },
    })
    principals.set('not-host', {
      ...base,
      kind: 'api_key',
      apiKeyId: crypto.randomUUID(),
      user: { ...base.user, id: outsider.userId },
    })
    for (const who of [undefined, 'wrong-org', 'not-host']) {
      const headers: Record<string, string> = who ? { authorization: `Bearer ${who}` } : {}
      for (const response of [await app.request(path, { headers }), await post(app, id, headers)]) {
        expect(response.status).toBe(who ? 404 : 401)
        expect(await response.json()).toMatchObject({
          error: who ? 'booking_not_found' : 'unauthorized',
        })
      }
    }
  })

  it('requires same-origin session writes and accepts bearer writes without Origin', async () => {
    const { id, session, key } = await fixture()
    const app = appWith()
    for (const origin of [undefined, 'https://other.example']) {
      const res = await post(app, id, { cookie: session, ...(origin && { origin }) })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
    expect((await post(app, id, { authorization: `Bearer ${key}` })).status).toBe(200)
  })

  it('rejects malformed or non-JSON bodies before making any changes', async () => {
    const { id, key } = await fixture()
    const app = appWith()
    for (const body of [
      {},
      { start: 'invalid' },
      { start: '2026-11-04T09:00:00Z', source: 'mcp' },
    ]) {
      const res = await post(app, id, { authorization: `Bearer ${key}` }, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    }
    const noJson = await app.request(`/api/v1/bookings/${id}/reschedule`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(noJson.status).toBe(400)
    expect(await noJson.json()).toMatchObject({ error: 'invalid_request' })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
  })

  it('validates slot ranges and returns the same cancellation conflict from both routes', async () => {
    const { id, key } = await fixture()
    const app = appWith()
    const headers = { authorization: `Bearer ${key}` }
    for (const [range, error] of [
      [{ start: '2026-11-04T12:00:00Z', end: '2026-11-04T08:00:00Z' }, 'invalid_range'],
      [{ start: '2026-11-04T00:00:00Z', end: '2027-02-04T00:00:00Z' }, 'range_too_long'],
    ] as const) {
      const res = await app.request(`/api/v1/bookings/${id}/slots?${new URLSearchParams(range)}`, {
        headers,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error })
    }
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: NOW.toString() })
      .where('id', '=', id)
      .execute()
    for (const res of [
      await app.request(`/api/v1/bookings/${id}/slots?${RANGE}`, { headers }),
      await post(app, id, headers),
    ]) {
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'booking_cancelled' })
    }
  })

  it('keeps host reschedules and slots independent of exhausted invitee IP budgets', async () => {
    const { id, key } = await fixture()
    const limits = {
      manage: { limit: 1, windowSeconds: 60 },
      slots: { limit: 1, windowSeconds: 60 },
    }
    const app = appWith(limits, limits)
    expect((await app.request('/api/v1/bookings/manage')).status).toBe(404)
    expect((await app.request('/api/v1/bookings/manage')).status).toBe(429)
    expect((await app.request(`/api/v1/bookings/manage/slots?${RANGE}`)).status).toBe(404)
    expect((await app.request(`/api/v1/bookings/manage/slots?${RANGE}`)).status).toBe(429)
    const headers = { authorization: `Bearer ${key}` }
    expect((await app.request(`/api/v1/bookings/${id}/slots?${RANGE}`, { headers })).status).toBe(
      200,
    )
    expect((await post(app, id, headers)).status).toBe(200)
  })

  it('keeps invitee IP budgets independent of host reschedules and slots', async () => {
    const { id, key } = await fixture()
    const limits = {
      manage: { limit: 1, windowSeconds: 60 },
      slots: { limit: 1, windowSeconds: 60 },
    }
    const app = appWith(limits, limits)
    const headers = { authorization: `Bearer ${key}` }
    expect((await app.request(`/api/v1/bookings/${id}/slots?${RANGE}`, { headers })).status).toBe(
      200,
    )
    expect((await post(app, id, headers)).status).toBe(200)
    expect((await app.request('/api/v1/bookings/manage')).status).toBe(404)
    expect((await app.request('/api/v1/bookings/manage')).status).toBe(429)
    expect((await app.request(`/api/v1/bookings/manage/slots?${RANGE}`)).status).toBe(404)
    expect((await app.request(`/api/v1/bookings/manage/slots?${RANGE}`)).status).toBe(429)
  })

  it.each(['manage', 'slots'] as const)(
    'shares the host %s budget by user across credentials, organizations and IPs',
    async (kind) => {
      const { id, key, session, base } = await fixture()
      const other = await fixture()
      const limits = {
        manage: { limit: 1, windowSeconds: 60 },
        slots: { limit: 1, windowSeconds: 60 },
      }
      const app = appWith(undefined, limits)
      const otherKey = crypto.randomUUID()
      principals.set(otherKey, {
        ...base,
        kind: 'api_key',
        apiKeyId: crypto.randomUUID(),
        organization: { ...base.organization, id: other.base.organization.id },
      })
      const request = (bookingId: string, headers: Record<string, string>, ip: string) =>
        app.request(
          `/api/v1/bookings/${bookingId}/${kind === 'manage' ? 'reschedule' : `slots?${RANGE}`}`,
          kind === 'manage'
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify({ start: '2026-11-04T09:00:00Z' }),
              }
            : { headers },
          { incoming: { socket: { remoteAddress: ip } } },
        )
      // Refused authentication must not consume a user's budget or read a principal early.
      expect((await request(id, {}, '203.0.113.1')).status).toBe(401)
      expect((await request(id, { authorization: `Bearer ${key}` }, '203.0.113.1')).status).toBe(
        200,
      )
      const alternateHeaders: Record<string, string>[] = [
        { cookie: session, origin: PUBLIC_URL },
        { authorization: `Bearer ${otherKey}` },
      ]
      for (const headers of alternateHeaders) {
        const limited = await request(id, headers, '203.0.113.2')
        expect(limited.status).toBe(429)
        expect(limited.headers.get('retry-after')).toBe('60')
        expect(await limited.json()).toEqual({ error: 'rate_limited' })
      }
      expect(
        (await request(other.id, { authorization: `Bearer ${other.key}` }, '203.0.113.1')).status,
      ).toBe(200)
    },
  )

  it('limits host reschedules after authentication and before reading a body', async () => {
    const { id, key } = await fixture()
    const app = appWith(undefined, { manage: { limit: 1, windowSeconds: 60 }, slots: plenty })
    expect((await post(app, id, { authorization: `Bearer ${key}` }, {})).status).toBe(400)
    let read = false
    const body = new ReadableStream(
      {
        pull(controller) {
          read = true
          controller.enqueue(new TextEncoder().encode('{}'))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const res = await app.request(`/api/v1/bookings/${id}/reschedule`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expect(read).toBe(false)
  })

  it('defaults to 30 host reschedules and 120 host slot requests per minute', async () => {
    const { id, key } = await fixture()
    const app = appWith(undefined, {})
    const headers = { authorization: `Bearer ${key}` }
    for (let i = 0; i < 30; i++) expect((await post(app, id, headers, {})).status).toBe(400)
    expect((await post(app, id, headers, {})).status).toBe(429)
    const path = `/api/v1/bookings/${id}/slots`
    for (let i = 0; i < 120; i++) expect((await app.request(path, { headers })).status).toBe(400)
    expect((await app.request(path, { headers })).status).toBe(429)
  })

  it('keeps REST equivalents for each existing MCP booking mutation', async () => {
    const document = (await (await appWith().request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>
    }
    const equivalents = {
      create_booking: [
        '/api/v1/public/{handle}/{slug}/bookings',
        '/api/v1/public/teams/{handle}/{slug}/bookings',
      ],
      reschedule_booking: [
        '/api/v1/bookings/{id}/reschedule',
        '/api/v1/bookings/manage/reschedule',
      ],
      cancel_booking: ['/api/v1/bookings/{id}/cancel', '/api/v1/bookings/manage/cancel'],
      retry_conference: ['/api/v1/bookings/{id}/conference/retry'],
      retry_calendar_copy: ['/api/v1/bookings/{id}/calendar-copy/retry'],
    }
    expect(
      bookingTools({ db })
        .filter((tool) => !tool.annotations.readOnlyHint)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(Object.keys(equivalents).sort())
    for (const [tool, paths] of Object.entries(equivalents)) {
      for (const path of paths)
        expect(document.paths[path]?.post, `${tool} requires POST ${path}`).toBeDefined()
    }
  })
})
