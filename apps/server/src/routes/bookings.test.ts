// The host's bookings over HTTP: authentication, organization scoping and host checks.
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')

interface Page {
  data: { id: string; start: string; status: string; cancelReason: string | null }[]
  nextCursor: string | null
}

describe.skipIf(!serverUrl)('host booking routes', () => {
  let testDb: TestDatabase
  let db: Db
  let app: ReturnType<typeof createApp>
  const principals = new Map<string, Principal>()
  let aliceBookings: string[]
  let bobBooking: string
  let teamBooking: string

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    const f = createFixtures(db)
    const alice = await f.host()
    const bob = await f.host()
    const team = await f.organization()
    await f.member(alice.userId, team)
    await f.member(bob.userId, team)

    const as = (userId: string, organizationId: string): Principal => ({
      kind: 'api_key',
      apiKeyId: crypto.randomUUID(),
      user: { id: userId, name: '', email: '' },
      organization: { id: organizationId, name: '', slug: '', personal: false },
    })
    principals.set('alice', as(alice.userId, alice.organizationId))
    principals.set('alice-team', as(alice.userId, team))
    principals.set('bob', as(bob.userId, bob.organizationId))
    principals.set('bob-team', as(bob.userId, team))

    aliceBookings = []
    for (const t of ['09:00', '10:00', '11:00']) {
      aliceBookings.push(
        await f.booking(
          alice.organizationId,
          [alice.userId],
          `2026-11-04T${t}Z`,
          `2026-11-04T${t.replace(':00', ':30')}Z`,
        ),
      )
    }
    bobBooking = await f.booking(
      bob.organizationId,
      [bob.userId],
      '2026-11-04T09:00Z',
      '2026-11-04T09:30Z',
    )
    teamBooking = await f.booking(team, [alice.userId], '2026-11-05T09:00Z', '2026-11-05T09:30Z')

    app = createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async (headers) => {
        const principal = principals.get(headers.get('authorization')?.replace('Bearer ', '') ?? '')
        return principal
          ? { ok: true, principal, setCookie: [] }
          : { ok: false, error: 'unauthorized', setCookie: [] }
      },
      routes: [bookingRoutes({ db, now: () => NOW })],
    })
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  const get = (path: string, who?: string) =>
    app.request(path, { headers: who ? { authorization: `Bearer ${who}` } : {} })
  const post = (path: string, who: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it('requires a caller', async () => {
    for (const res of [
      await get('/api/v1/bookings'),
      await get(`/api/v1/bookings/${bobBooking}`),
      await app.request(`/api/v1/bookings/${bobBooking}/cancel`, { method: 'POST' }),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('lists the bookings the caller hosts in their organization, page by page', async () => {
    const first = await get('/api/v1/bookings?limit=2', 'alice')
    expect(first.status).toBe(200)
    const page1 = (await first.json()) as Page
    expect(page1.data.map((b) => b.id)).toEqual(aliceBookings.slice(0, 2))
    const second = (await (
      await get(`/api/v1/bookings?limit=2&cursor=${page1.nextCursor}`, 'alice')
    ).json()) as Page
    expect(second).toMatchObject({ data: [{ id: aliceBookings[2] }], nextCursor: null })

    const ids = async (who: string, query = '') =>
      ((await (await get(`/api/v1/bookings${query}`, who)).json()) as Page).data.map((b) => b.id)
    expect(await ids('alice-team')).toEqual([teamBooking])
    expect(await ids('bob-team')).toEqual([])
    expect(await ids('bob')).toEqual([bobBooking])
    expect(await ids('alice', '?from=2026-11-04T10:00:00Z&to=2026-11-04T11:00:00%2B00:00')).toEqual(
      [aliceBookings[1]],
    )
  })

  it.each([
    ['?endAfter=invalid', 'invalid_request'],
    ['?endTo=2026-11-04T10:00:00.1234567890Z', 'invalid_request'],
    ['?endAfter=2026-11-05T00:00:00Z&endTo=2026-11-04T00:00:00Z', 'invalid_range'],
    ['?endAfter=2026-11-04T00:00:00Z&endTo=2026-11-04T00:00:00Z', 'invalid_range'],
    ['?order=newest', 'invalid_request'],
    ['?limit=0', 'invalid_request'],
    ['?limit=101', 'invalid_request'],
    ['?status=pending', 'invalid_request'],
    ['?cursor=garbage', 'invalid_cursor'],
    ['?from=2026-11-05T00:00:00Z&to=2026-11-04T00:00:00Z', 'invalid_range'],
    // More fractional digits than Temporal reads.
    ['?from=2026-11-04T10:00:00.1234567890Z', 'invalid_request'],
  ])('refuses %s with 400 %s', async (query, error) => {
    const res = await get(`/api/v1/bookings${query}`, 'alice')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error })
  })

  it('preserves descending order and time filters on every REST page', async () => {
    const ids: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({
        order: 'desc',
        limit: '1',
        from: '2026-11-04T00:00:00Z',
        to: '2026-11-05T00:00:00Z',
        ...(cursor && { cursor }),
      })
      const response = await get(`/api/v1/bookings?${params}`, 'alice')
      expect(response.status).toBe(200)
      const result = (await response.json()) as Page
      ids.push(...result.data.map((b) => b.id))
      cursor = result.nextCursor
      if (page < 2) expect(cursor).not.toBeNull()
    }
    expect(ids).toEqual(aliceBookings.toReversed())
    expect(cursor).toBeNull()
    expect((await (await get('/api/v1/bookings?order=desc', 'bob-team')).json()) as Page).toEqual({
      data: [],
      nextCursor: null,
    })
  })

  it('filters with sub-millisecond precision', async () => {
    const ids = async (query: string) =>
      ((await (await get(`/api/v1/bookings${query}`, 'alice')).json()) as Page).data.map(
        (b) => b.id,
      )
    // Alice's bookings start at 09:00, 10:00 and 11:00 on 2026-11-04.
    expect(await ids('?from=2026-11-04T10:00:00.000001Z')).toEqual([aliceBookings[2]])
    expect(await ids('?to=2026-11-04T10:00:00.000001Z')).toEqual(aliceBookings.slice(0, 2))
  })

  it('splits bookings by their end, keeping in-progress meetings and precision at the boundary', async () => {
    const ids = async (query: string) => {
      const response = await get(`/api/v1/bookings?${query}`, 'alice')
      expect(response.status).toBe(200)
      return ((await response.json()) as Page).data.map((b) => b.id)
    }
    expect(await ids('endAfter=2026-11-04T09:15:00Z')).toEqual(aliceBookings)
    expect(await ids('endAfter=2026-11-04T10:30:00Z')).toEqual(aliceBookings.slice(2))
    expect(await ids('endTo=2026-11-04T10:30:00Z')).toEqual(aliceBookings.slice(0, 2))
    expect(await ids('endTo=2026-11-04T10:29:59.999999Z')).toEqual(aliceBookings.slice(0, 1))
    expect(
      await ids('endAfter=2026-11-04T09:30:00Z&endTo=2026-11-04T11:30:00Z&limit=1&order=desc'),
    ).toEqual(aliceBookings.slice(2))
  })

  it('never lets a cache keep a response, errors included', async () => {
    const id = aliceBookings[1] as string
    for (const [what, res, status] of [
      ['list', await get('/api/v1/bookings', 'alice'), 200],
      ['detail', await get(`/api/v1/bookings/${id}`, 'alice'), 200],
      ['not found (DomainError)', await get(`/api/v1/bookings/${id}`, 'bob'), 404],
      ['unauthenticated', await get('/api/v1/bookings'), 401],
      ['validation error', await get('/api/v1/bookings?limit=0', 'alice'), 400],
      ['invitee link, bad token', await get('/api/v1/bookings/manage'), 404],
      [
        'invitee link, bad token',
        await app.request('/api/v1/bookings/manage', {
          headers: { 'x-manage-token': 'A'.repeat(43) },
        }),
        404,
      ],
      ['unknown path', await get('/api/v1/nope'), 404],
      ['OpenAPI document', await get('/api/v1/openapi.json'), 200],
    ] as const) {
      expect(res.status, what).toBe(status)
      expect(res.headers.get('cache-control'), what).toBe('no-store')
    }
    // Outside /api/v1 nothing is added: health is harmless, Better Auth manages its own.
    expect((await get('/api/health')).headers.get('cache-control')).toBeNull()
  })

  it("gets and cancels only bookings the caller hosts in the caller's organization", async () => {
    const id = aliceBookings[0] as string
    const own = await get(`/api/v1/bookings/${id}`, 'alice')
    expect(own.status).toBe(200)
    expect(await own.json()).toMatchObject({ id, status: 'confirmed' })

    for (const who of ['bob', 'bob-team', 'alice-team']) {
      for (const res of [
        await get(`/api/v1/bookings/${id}`, who),
        await post(`/api/v1/bookings/${id}/cancel`, who),
      ]) {
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'booking_not_found', message: 'No such booking' })
      }
    }
    expect((await get('/api/v1/bookings/not-a-uuid', 'alice')).status).toBe(400)

    // Request bodies are strict: a misspelled field is refused, not ignored.
    const typo = await post(`/api/v1/bookings/${id}/cancel`, 'alice', { reasons: 'Out sick' })
    expect(typo.status).toBe(400)
    expect(await typo.json()).toMatchObject({ error: 'invalid_request' })

    const cancelled = await post(`/api/v1/bookings/${id}/cancel`, 'alice', { reason: 'Out sick' })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      id,
      status: 'cancelled',
      cancelReason: 'Out sick',
    })
    const again = await post(`/api/v1/bookings/${id}/cancel`, 'alice')
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'booking_cancelled' })
    const list = (await (await get('/api/v1/bookings?status=cancelled', 'alice')).json()) as Page
    expect(list.data.map((b) => b.id)).toEqual([id])
  })
})
