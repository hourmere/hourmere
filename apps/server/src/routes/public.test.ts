// Public booking pages and invitee links over HTTP, against a throwaway database.
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'
import { type PublicRoutesDeps, publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
// Mon 2026-11-02; Berlin is on CET (+01:00), so 09:00–17:00 local is 08:00Z–16:00Z.
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')

const noAuth: Pick<AppDeps, 'authHandler' | 'resolveCaller' | 'publicUrl' | 'checkDb'> = {
  publicUrl: 'http://localhost:3000',
  checkDb: async () => {},
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
}

const plenty = { limit: 100_000, windowSeconds: 60 }

interface BookingBody {
  booking: { id: string; status: string; start: string; rescheduledFromId: string | null }
  manageToken: string | null
}

describe.skipIf(!serverUrl)('public routes', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let app: ReturnType<typeof createApp>

  const appWith = (rateLimits: PublicRoutesDeps['rateLimits']) =>
    createApp({
      ...noAuth,
      routes: [
        publicRoutes({ db, now: () => NOW, rateLimits }),
        bookingRoutes({ db, now: () => NOW, rateLimits }),
      ],
    })

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    app = appWith({ page: plenty, slots: plenty, book: plenty, manage: plenty })

    const host = await f.host({ name: 'Ada Lovelace', handle: 'ada' })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro call',
      durationMinutes: 30,
      location: { kind: 'phone', number: '+49 30 1234567' },
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
    })
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const get = (path: string, a = app) => a.request(path)
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}, a = app) =>
    a.request(path, {
      method: 'POST',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const bookingRequest = (start: string, more: Record<string, unknown> = {}) => ({
    start,
    invitee: { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'America/New_York' },
    responses: { topic: 'Compilers' },
    ...more,
  })
  const book = (start: string, more: Record<string, unknown> = {}, headers = {}) =>
    post('/api/v1/public/ada/intro/bookings', bookingRequest(start, more), headers)

  it('shows the public event type', async () => {
    const res = await get('/api/v1/public/ada/intro')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      handle: 'ada',
      slug: 'intro',
      title: 'Intro call',
      description: null,
      durationMinutes: 30,
      location: { kind: 'phone' },
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
      host: { name: 'Ada Lovelace', timeZone: 'Europe/Berlin' },
    })

    const missing = await get('/api/v1/public/ada/nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: 'event_type_not_found',
      message: 'No such event type',
    })
  })

  it('lists slots for a range', async () => {
    const res = await get(
      '/api/v1/public/ada/intro/slots?start=2026-11-02T00:00:00%2B01:00&end=2026-11-02T10:00:00Z',
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        { start: '2026-11-02T08:00:00.000Z', end: '2026-11-02T08:30:00.000Z' },
        { start: '2026-11-02T08:30:00.000Z', end: '2026-11-02T09:00:00.000Z' },
        { start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T09:30:00.000Z' },
        { start: '2026-11-02T09:30:00.000Z', end: '2026-11-02T10:00:00.000Z' },
      ],
    })
  })

  it.each([
    ['?start=2026-11-02T00:00:00Z&end=2027-01-03T00:00:01Z', 'range_too_long'],
    ['?start=2026-11-02T00:00:00Z&end=2026-11-02T00:00:00Z', 'invalid_range'],
    ['?start=2026-11-02T00:00:00Z', 'invalid_request'],
    ['?start=tomorrow&end=2026-11-03T00:00:00Z', 'invalid_request'],
  ])('refuses slots%s with 400 %s', async (query, error) => {
    const res = await get(`/api/v1/public/ada/intro/slots${query}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error })
  })

  it('books a slot and returns the manage token', async () => {
    const res = await book('2026-11-02T08:00:00Z')
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as BookingBody
    expect(body.booking).toMatchObject({
      status: 'confirmed',
      start: '2026-11-02T08:00:00.000Z',
      end: '2026-11-02T08:30:00.000Z',
      title: 'Intro call with Grace Hopper',
      location: { kind: 'phone', number: '+49 30 1234567' },
      responses: { topic: 'Compilers' },
      source: 'web',
    })
    expect(body.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it.each([
    [
      'an unknown field',
      { ...bookingRequest('2026-11-02T09:00:00Z'), notes: 'hi' },
      400,
      'invalid_request',
    ],
    [
      'an unknown invitee field',
      bookingRequest('2026-11-02T09:00:00Z', {
        invitee: { name: 'G', email: 'g@example.com', timeZone: 'UTC', phone: '1' },
      }),
      400,
      'invalid_request',
    ],
    ['an invalid body', { start: '2026-11-02T09:00:00Z' }, 400, 'invalid_request'],
    [
      'a bad email',
      bookingRequest('2026-11-02T09:00:00Z', {
        invitee: { name: 'G', email: 'g', timeZone: 'UTC' },
      }),
      400,
      'invalid_request',
    ],
    [
      'missing answers',
      bookingRequest('2026-11-02T09:00:00Z', { responses: {} }),
      400,
      'invalid_responses',
    ],
    [
      'an unknown time zone',
      bookingRequest('2026-11-02T09:00:00Z', {
        invitee: { name: 'G', email: 'g@example.com', timeZone: 'Mars/Olympus' },
      }),
      400,
      'invalid_time_zone',
    ],
    ['a time that is not offered', bookingRequest('2026-11-02T09:10:00Z'), 409, 'slot_unavailable'],
  ])('refuses %s', async (_, body, status, error) => {
    const res = await post('/api/v1/public/ada/intro/bookings', body)
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ error })
  })

  it('replays a retry with the same Idempotency-Key and refuses a different request', async () => {
    const key = { 'idempotency-key': crypto.randomUUID() }
    const first = await book('2026-11-02T10:00:00Z', {}, key)
    expect(first.status).toBe(201)
    const original = (await first.json()) as BookingBody

    const retry = await book('2026-11-02T10:00:00Z', {}, key)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ booking: original.booking, manageToken: null })

    const different = await book('2026-11-02T10:30:00Z', {}, key)
    expect(different.status).toBe(409)
    expect(await different.json()).toMatchObject({ error: 'idempotency_key_reused' })
  })

  it('lets exactly one of many concurrent bookings of one slot succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        book('2026-11-02T11:00:00Z', {
          invitee: { name: `Invitee ${i}`, email: `i${i}@example.com`, timeZone: 'UTC' },
        }),
      ),
    )
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, ...Array(9).fill(409)])
    for (const r of results.filter((r) => r.status === 409)) {
      expect(['slot_taken', 'slot_unavailable']).toContain(
        ((await r.json()) as { error: string }).error,
      )
    }
    const rows = await testDb.pool.query(
      `SELECT count(*)::int AS n FROM bookings WHERE start_at = '2026-11-02T11:00Z' AND status = 'confirmed'`,
    )
    expect(rows.rows[0]).toEqual({ n: 1 })
  })

  it('shows, reschedules and cancels through the manage link, never logging the token', async () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi
        .spyOn(console, m)
        .mockImplementation((...args) => void lines.push(args.map(String).join(' '))),
    )
    let tokens: string[] = []
    try {
      const created = (await (await book('2026-11-02T13:00:00Z')).json()) as BookingBody
      const token = created.manageToken as string
      const as = (t: string) => ({ 'x-manage-token': t })
      const manage = '/api/v1/bookings/manage'

      const shown = await app.request(manage, { headers: as(token) })
      expect(shown.status).toBe(200)
      expect(shown.headers.get('cache-control')).toBe('no-store')
      expect(await shown.json()).toEqual(created.booking)

      // Onto a time overlapping the old one.
      const moved = await post(`${manage}/reschedule`, { start: '2026-11-02T13:30:00Z' }, as(token))
      expect(moved.status).toBe(200)
      const next = (await moved.json()) as BookingBody
      expect(next.booking).toMatchObject({
        start: '2026-11-02T13:30:00.000Z',
        rescheduledFromId: created.booking.id,
      })
      const newToken = next.manageToken as string
      tokens = [token, newToken]

      expect(await (await app.request(manage, { headers: as(token) })).json()).toMatchObject({
        status: 'cancelled',
      })
      const again = await post(`${manage}/reschedule`, { start: '2026-11-02T14:00:00Z' }, as(token))
      expect(again.status).toBe(409)
      expect(await again.json()).toMatchObject({ error: 'booking_cancelled' })

      // Cancel without a body, then once more.
      const cancelled = await post(`${manage}/cancel`, undefined, as(newToken))
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({ status: 'cancelled', cancelReason: null })
      const twice = await post(`${manage}/cancel`, { reason: 'Sorry' }, as(newToken))
      expect(twice.status).toBe(409)
      expect(await twice.json()).toMatchObject({ error: 'booking_cancelled' })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(tokens).toHaveLength(2)
    // The request log ran, and no line of any log holds a token.
    expect(lines.some((l) => l.includes('POST /api/v1/bookings/manage/reschedule'))).toBe(true)
    for (const token of tokens) {
      expect(lines.filter((l) => l.includes(token))).toEqual([])
    }
  })

  it('answers a missing, malformed or unknown manage token identically', async () => {
    const bodies = new Set<string>()
    for (const headers of [
      {},
      { 'x-manage-token': '' },
      { 'x-manage-token': 'short' },
      { 'x-manage-token': 'A'.repeat(43) },
    ]) {
      for (const [method, path, body] of [
        ['GET', '/api/v1/bookings/manage', undefined],
        ['POST', '/api/v1/bookings/manage/cancel', undefined],
        ['POST', '/api/v1/bookings/manage/reschedule', { start: '2026-11-02T15:00:00Z' }],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
          body: body && JSON.stringify(body),
        })
        expect(res.status).toBe(404)
        bodies.add(await res.text())
      }
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: 'booking_not_found', message: 'No such booking' }),
    ])
  })

  it('serves the manage endpoints whatever order the route modules are registered in', async () => {
    const reversed = createApp({
      ...noAuth,
      routes: [bookingRoutes({ db, now: () => NOW }), publicRoutes({ db, now: () => NOW })],
    })
    const res = await reversed.request('/api/v1/bookings/manage', {
      headers: { 'x-manage-token': 'A'.repeat(43) },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'booking_not_found' })
    const cancel = await reversed.request('/api/v1/bookings/manage/cancel', { method: 'POST' })
    expect(cancel.status).toBe(404)
  })

  it('rate limits each group per client address with 429 and Retry-After', async () => {
    const limited = appWith({
      page: { limit: 2, windowSeconds: 60 },
      manage: { limit: 1, windowSeconds: 60 },
    })
    const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } })
    const page = (ip: string) => limited.request('/api/v1/public/ada/intro', {}, from(ip))

    expect((await page('203.0.113.1')).status).toBe(200)
    expect((await page('203.0.113.1')).status).toBe(200)
    const refused = await page('203.0.113.1')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(60)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })

    // Another address has its own budget; other groups count separately.
    expect((await page('203.0.113.2')).status).toBe(200)
    const manage = (ip: string) => limited.request('/api/v1/bookings/manage', {}, from(ip))
    expect((await manage('203.0.113.1')).status).toBe(404)
    expect((await manage('203.0.113.1')).status).toBe(429)
    // Reschedule and cancel share the manage budget.
    const cancel = await limited.request(
      '/api/v1/bookings/manage/cancel',
      { method: 'POST' },
      from('203.0.113.1'),
    )
    expect(cancel.status).toBe(429)
  })

  it('documents the routes', async () => {
    const doc = (await (await get('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/public/{handle}/{slug}',
        '/api/v1/public/{handle}/{slug}/slots',
        '/api/v1/public/{handle}/{slug}/bookings',
        '/api/v1/bookings/manage',
        '/api/v1/bookings/manage/cancel',
        '/api/v1/bookings/manage/reschedule',
        '/api/v1/bookings',
        '/api/v1/bookings/{id}',
        '/api/v1/bookings/{id}/cancel',
      ]),
    )
    expect(doc.paths['/api/v1/public/{handle}/{slug}/bookings']?.post?.security).toBeUndefined()
    expect(doc.paths['/api/v1/bookings']?.get?.security).toEqual([{ apiKey: [] }, { session: [] }])
    expect(doc.paths['/api/v1/bookings/manage']?.get?.security).toBeUndefined()
    const manage = doc.paths['/api/v1/bookings/manage']?.get as {
      parameters?: { name: string; in: string }[]
    }
    expect(manage.parameters).toContainEqual(
      expect.objectContaining({ name: 'x-manage-token', in: 'header' }),
    )
    expect(Object.keys(doc.paths).filter((p) => p.includes('{token}'))).toEqual([])
  })
})
