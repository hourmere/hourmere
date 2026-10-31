// Public booking pages and invitee links over HTTP, against a throwaway database.
import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { CHUNK_SIZE, chunkedBody } from '../chunked-body.ts'
import { bookingRoutes } from './bookings.ts'
import { BOOKING_BODY_LIMIT, type PublicRoutesDeps, publicRoutes } from './public.ts'

const serverUrl = process.env.DATABASE_URL
/** For tests whose bookings wait on each other's locks: room to finish on a busy machine. */
const SERIALIZED = { timeout: 20_000 }
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
  let ada: Awaited<ReturnType<Fixtures['host']>>

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
    ada = host
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      // These scenarios exercise a host that explicitly enabled guests.
      allowGuests: true,
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
      allowGuests: true,
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

  it.each([
    { image: '/assets/avatars/host.png', expected: '/assets/avatars/host.png' },
    { image: null, expected: undefined },
    {
      image: `https://www.gravatar.com/avatar/${createHash('md5').update('avatar-private@example.test').digest('hex')}.png`,
      expected: undefined,
    },
    { image: '/assets/host.png?email=avatar-private@example.test', expected: undefined },
  ])('exposes only safe personal avatar references: $expected', async ({ image, expected }) => {
    const handle = `avatar-${randomUUID().slice(0, 8)}`
    const host = await f.host({ handle })
    await db
      .updateTable('auth.user')
      .set({ image, email: `${host.userId}@example.test` })
      .where('id', '=', host.userId)
      .execute()
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const emailHash = createHash('md5').update('avatar-private@example.test').digest('hex')

    for (const endpoint of [`/api/v1/public/${handle}`, `/api/v1/public/${handle}/intro`]) {
      const res = await get(endpoint)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        host: { name: string; timeZone: string; image?: string }
      }
      expect(body.host).toEqual({
        name: 'Ada Lovelace',
        timeZone: 'Europe/Berlin',
        ...(expected && { image: expected }),
      })
      expect(JSON.stringify(body)).not.toContain('@')
      expect(JSON.stringify(body)).not.toContain(emailHash)
      expect(JSON.stringify(body)).not.toContain('gravatar')
    }
  })

  it("lists a host's bookable event types on their page", async () => {
    // Without a name, the host is shown by their handle.
    const grace = await f.host({ name: ' ', handle: 'grace' })
    const second = await f.eventType(grace.organizationId, grace.userId, {
      slug: 'second',
      title: 'Second',
      durationMinutes: 60,
      location: { kind: 'zoom', url: 'https://zoom.example/j/1' },
    })
    await f.eventType(grace.organizationId, grace.userId, {
      slug: 'first',
      title: 'First',
      description: 'Hello',
    })
    await f.eventType(grace.organizationId, grace.userId, { slug: 'off', isActive: false })
    await f.eventType(grace.organizationId, grace.userId, {
      slug: 'gone',
      deletedAt: '2026-10-01T00:00:00Z',
    })
    // An event type in an organization she no longer belongs to.
    await f.eventType(await f.organization(), grace.userId, { slug: 'elsewhere' })
    await db.updateTable('event_types').set({ position: 1 }).where('id', '=', second).execute()

    const res = await get('/api/v1/public/Grace')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      handle: 'grace',
      host: { name: 'grace', timeZone: 'Europe/Berlin' },
      eventTypes: [
        {
          slug: 'first',
          title: 'First',
          description: 'Hello',
          durationMinutes: 30,
          location: null,
        },
        {
          slug: 'second',
          title: 'Second',
          description: null,
          durationMinutes: 60,
          location: { kind: 'zoom' },
        },
      ],
    })

    // A host with nothing to book still has a page.
    await f.host({ name: 'Empty', handle: 'empty' })
    expect(await (await get('/api/v1/public/empty')).json()).toMatchObject({ eventTypes: [] })

    for (const handle of ['nobody', 'not_a_handle', 'a'.repeat(41)]) {
      const missing = await get(`/api/v1/public/${handle}`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({
        error: 'host_not_found',
        message: 'No such booking page',
      })
    }
  })

  it('serves no page for a stored handle that has become reserved', async () => {
    // Written directly, as if stored before the name was reserved: the profile API refuses it.
    for (const handle of ['pricing', 'event-types']) {
      const host = await f.host({ name: 'Early Bird', handle })
      await f.schedule(host.userId)
      await f.eventType(host.organizationId, host.userId, { slug: 'call' })
      for (const path of [
        `/api/v1/public/${handle}`,
        `/api/v1/public/${handle}/call`,
        `/api/v1/public/${handle.toUpperCase()}/call`,
        `/api/v1/public/${handle}/call/slots?start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z`,
      ]) {
        const res = await get(path)
        expect(res.status, path).toBe(404)
      }
      const booked = await post(
        `/api/v1/public/${handle}/call/bookings`,
        bookingRequest('2026-11-02T08:00:00Z', { responses: {} }),
      )
      expect(booked.status).toBe(404)
      expect(await booked.json()).toMatchObject({ error: 'event_type_not_found' })
    }
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
    ['?start=2026-11-02T00:00:00.1234567890Z&end=2026-11-03T00:00:00Z', 'invalid_request'],
    ['?start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00.0000000001Z', 'invalid_request'],
  ])('refuses slots%s with 400 %s', async (query, error) => {
    const res = await get(`/api/v1/public/ada/intro/slots${query}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error })
  })

  it('records only a public embed attribution hint and keeps anonymous retry scope and permissions', async () => {
    const host = await f.host({ handle: 'embed-source' })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const body = {
      start: '2026-11-02T08:00:00Z',
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
      source: 'embed',
    }
    const endpoint = '/api/v1/public/embed-source/intro/bookings',
      headers = { 'Idempotency-Key': 'embed-retry-same-visitor' }
    const created = await post(endpoint, body, headers)
    expect(created.status).toBe(201)
    const result = (await created.json()) as BookingBody
    expect(result.booking).toMatchObject({ source: 'embed' })
    const row = await db
      .selectFrom('bookings')
      .select(['source', 'api_key_id'])
      .where('id', '=', result.booking.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ source: 'embed', api_key_id: null })
    const replay = await post(endpoint, { ...body, source: undefined }, headers)
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as BookingBody).booking.id).toBe(result.booking.id)
    for (const source of ['api', 'mcp', 'constructor', 'web'])
      expect((await post(endpoint, { ...body, source })).status).toBe(400)
    expect((await post(endpoint, { ...body, apiKeyId: host.userId })).status).toBe(400)
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
    [
      'a start with ten fractional digits',
      bookingRequest('2026-11-02T09:00:00.1234567890Z'),
      400,
      'invalid_request',
    ],
  ])('refuses %s', async (_, body, status, error) => {
    const res = await post('/api/v1/public/ada/intro/bookings', body)
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ error })
  })

  it('refuses unsafe text: NUL and lone surrogates up front, other controls in the service', async () => {
    const invitee = (name: string) => ({ name, email: 'g@example.com', timeZone: 'UTC' })
    for (const name of ['A\u0000B', 'a\ud800b']) {
      const res = await book('2026-11-02T09:00:00Z', { invitee: invitee(name) })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    }
    const bell = await book('2026-11-02T09:00:00Z', {
      invitee: invitee(`A${String.fromCharCode(7)}B`),
    })
    expect(bell.status).toBe(400)
    expect(await bell.json()).toMatchObject({ error: 'invalid_invitee' })
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

  it('lets exactly one of many concurrent bookings of one slot succeed', SERIALIZED, async () => {
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
      // With what the invitee needs to recognize it: the event and who they meet.
      expect(await shown.json()).toEqual({
        ...created.booking,
        eventType: { title: 'Intro call', durationMinutes: 30 },
        hosts: [{ name: 'Ada Lovelace' }],
      })

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

  it('offers the times a booking can move to, its own time included', async () => {
    const created = (await (await book('2026-11-03T09:00:00Z')).json()) as BookingBody
    const token = created.manageToken as string
    const range = 'start=2026-11-03T08:00:00Z&end=2026-11-03T10:00:00Z'
    const slots = (t: string, query = range, a = app) =>
      a.request(`/api/v1/bookings/manage/slots?${query}`, { headers: { 'x-manage-token': t } })
    const starts = (body: unknown) =>
      (body as { data: { start: string }[] }).data.map((s) => s.start)

    const res = await slots(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Rescheduling ignores the booking itself, so its time and the overlapping ones are offered
    // (the public page, which does not know whose booking it is, leaves 09:00 out).
    expect(starts(await res.json())).toEqual([
      '2026-11-03T08:00:00.000Z',
      '2026-11-03T08:30:00.000Z',
      '2026-11-03T09:00:00.000Z',
      '2026-11-03T09:30:00.000Z',
    ])
    expect(starts(await (await get(`/api/v1/public/ada/intro/slots?${range}`)).json())).toEqual([
      '2026-11-03T08:00:00.000Z',
      '2026-11-03T08:30:00.000Z',
      '2026-11-03T09:30:00.000Z',
    ])
    // Someone else's booking still blocks its time.
    await book('2026-11-03T08:00:00Z', {
      invitee: { name: 'Other', email: 'other@example.com', timeZone: 'UTC' },
    })
    expect(starts(await (await slots(token)).json())).not.toContain('2026-11-03T08:00:00.000Z')

    for (const [query, error] of [
      ['start=2026-11-03T08:00:00Z&end=2026-11-03T08:00:00Z', 'invalid_range'],
      ['start=2026-11-03T00:00:00Z&end=2027-01-05T00:00:00Z', 'range_too_long'],
      ['start=2026-11-03T00:00:00Z', 'invalid_request'],
    ]) {
      const refused = await slots(token, query)
      expect(refused.status, query).toBe(400)
      expect(await refused.json()).toMatchObject({ error })
    }
    const unknown = await slots('A'.repeat(43))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: 'booking_not_found' })

    // Counted against the slots budget, not the (smaller) manage one.
    const limited = appWith({
      slots: { limit: 1, windowSeconds: 60 },
      manage: { limit: 100, windowSeconds: 60 },
    })
    expect((await slots(token, range, limited)).status).toBe(200)
    expect((await slots(token, range, limited)).status).toBe(429)

    await post('/api/v1/bookings/manage/cancel', undefined, { 'x-manage-token': token })
    const cancelled = await slots(token)
    expect(cancelled.status).toBe(409)
    expect(await cancelled.json()).toMatchObject({ error: 'booking_cancelled' })
  })

  it('offers no new times for a booking that started or whose event type was retired', async () => {
    const as = (t: string) => ({ headers: { 'x-manage-token': t } })
    const range = 'start=2026-11-03T08:00:00Z&end=2026-11-03T12:00:00Z'
    // A booking that has already started, with a token we know.
    const pastToken = 'P'.repeat(43)
    const past = await f.booking(
      ada.organizationId,
      [ada.userId],
      '2026-10-30T09:00:00Z',
      '2026-10-30T09:30:00Z',
    )
    await db
      .updateTable('bookings')
      .set({ manage_token_hash: createHash('sha256').update(pastToken).digest() })
      .where('id', '=', past)
      .execute()
    const started = await app.request(`/api/v1/bookings/manage/slots?${range}`, as(pastToken))
    expect(started.status).toBe(409)
    expect(await started.json()).toMatchObject({ error: 'booking_in_past' })

    const retired = await f.eventType(ada.organizationId, ada.userId, { slug: 'retired' })
    const booked = await post(
      '/api/v1/public/ada/retired/bookings',
      bookingRequest('2026-11-03T14:00:00Z', { responses: {} }),
    )
    expect(booked.status).toBe(201)
    const { manageToken } = (await booked.json()) as BookingBody
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', retired)
      .execute()
    const unavailable = await app.request(
      `/api/v1/bookings/manage/slots?${range}`,
      as(manageToken as string),
    )
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toMatchObject({ error: 'event_type_unavailable' })
    // The manage page still shows it, with the event type as it is now.
    const shown = await app.request('/api/v1/bookings/manage', as(manageToken as string))
    expect(await shown.json()).toMatchObject({
      eventType: { title: 'Intro call', durationMinutes: 30 },
    })
  })

  it("follows the meeting with an email's token, for its details and the times it can move to", async () => {
    const created = (await (await book('2026-11-03T12:00:00Z')).json()) as BookingBody
    const own = created.manageToken as string
    // The token an invitee email carried, stored as the notification job stores it.
    const emailed = 'E'.repeat(43)
    const invitee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', created.booking.id)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: created.booking.id,
        kind: 'confirmed',
        recipient: `attendee:${invitee.id}`,
        manage_token_hash: createHash('sha256').update(emailed).digest(),
      })
      .execute()
    const as = (t: string) => ({ headers: { 'x-manage-token': t } })
    const show = async (t: string) =>
      (await (await app.request('/api/v1/bookings/manage', as(t))).json()) as {
        id: string
        status: string
        start: string
        eventType: unknown
        hosts: unknown
      }
    const range = 'start=2026-11-03T11:00:00Z&end=2026-11-03T13:30:00Z'
    const slots = (t: string) => app.request(`/api/v1/bookings/manage/slots?${range}`, as(t))

    expect(await show(emailed)).toMatchObject({ id: created.booking.id, status: 'confirmed' })

    // Moved with the booking's own token, onto a time overlapping the old one.
    const moved = await post(
      '/api/v1/bookings/manage/reschedule',
      { start: '2026-11-03T12:30:00Z' },
      { 'x-manage-token': own },
    )
    expect(moved.status).toBe(200)
    const next = (await moved.json()) as BookingBody

    // The email's link now opens the new booking; the old token stays with the old one.
    expect(await show(emailed)).toMatchObject({
      id: next.booking.id,
      status: 'confirmed',
      start: '2026-11-03T12:30:00.000Z',
      eventType: { title: 'Intro call', durationMinutes: 30 },
      hosts: [{ name: 'Ada Lovelace' }],
    })
    expect(await show(own)).toMatchObject({ id: created.booking.id, status: 'cancelled' })

    // Times to move to: for the new booking, its own time included; none for the old token.
    const offered = await slots(emailed)
    expect(offered.status).toBe(200)
    expect(
      ((await offered.json()) as { data: { start: string }[] }).data.map((s) => s.start),
    ).toEqual([
      '2026-11-03T11:00:00.000Z',
      '2026-11-03T11:30:00.000Z',
      '2026-11-03T12:00:00.000Z',
      '2026-11-03T12:30:00.000Z',
      '2026-11-03T13:00:00.000Z',
    ])
    const stale = await slots(own)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'booking_cancelled' })

    // Rescheduling through the email's link moves the new booking.
    const again = await post(
      '/api/v1/bookings/manage/reschedule',
      { start: '2026-11-03T13:00:00Z' },
      { 'x-manage-token': emailed },
    )
    expect(again.status).toBe(200)
    expect(await show(emailed)).toMatchObject({ start: '2026-11-03T13:00:00.000Z' })
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
        [
          'GET',
          '/api/v1/bookings/manage/slots?start=2026-11-03T08:00:00Z&end=2026-11-03T10:00:00Z',
          undefined,
        ],
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
    // IPv6 clients are counted by /64: rotating addresses inside it does not help.
    expect((await page('2001:db8:1:2::1')).status).toBe(200)
    expect((await page('2001:db8:1:2::2')).status).toBe(200)
    expect((await page('2001:db8:1:2:ffff::3')).status).toBe(429)
    expect((await page('2001:db8:1:3::1')).status).toBe(200)
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

  it('copes with busy time that Postgres clips to sub-millisecond bounds', async () => {
    // With this range the window around it ends at 2026-11-10T10:00:00.0005Z, so the busy
    // row is clipped to [10:00:00, 10:00:00.0005): one millisecond once widened, not empty.
    await f.calendarBusy(ada.userId, [['2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z']])
    const slots = await get(
      '/api/v1/public/ada/intro/slots?start=2026-11-06T00:00:00Z&end=2026-11-07T10:00:00.0005Z',
    )
    expect(slots.status).toBe(200)
    expect(((await slots.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)

    const odd = await book('2026-11-07T09:30:00.0005Z')
    expect(odd.status).toBe(409)
    expect(await odd.json()).toMatchObject({ error: 'slot_unavailable' })

    const { manageToken } = (await (await book('2026-11-05T08:00:00Z')).json()) as BookingBody
    const moved = await post(
      '/api/v1/bookings/manage/reschedule',
      { start: '2026-11-07T09:30:00.0005Z' },
      { 'x-manage-token': manageToken as string },
    )
    expect(moved.status).toBe(409)
    expect(await moved.json()).toMatchObject({ error: 'slot_unavailable' })
  })

  it('takes the largest legal booking, even with every character escaped', async () => {
    // 20 multi-select questions, each with 50 distinct options of 200 non-ASCII characters.
    const option = (i: number) => String.fromCharCode(0x4e00 + i) + 'é'.repeat(199)
    const questions = Array.from({ length: 20 }, (_, q) => ({
      id: `q${q}`.padEnd(64, 'x'),
      label: `Question ${q}`,
      type: 'multi_select',
      required: true,
      options: Array.from({ length: 50 }, (_, i) => option(i)),
    }))
    await f.eventType(ada.organizationId, ada.userId, {
      slug: 'everything',
      questions,
      allowGuests: true,
    })
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`
    expect(email).toHaveLength(254)
    const request = {
      start: '2026-11-04T13:00:00.000Z',
      invitee: {
        name: 'é'.repeat(200),
        email,
        timeZone: 'Europe/Berlin',
        locale: 'abcdefgh-abcdefgh-abcdefgh-abcdefgh',
      },
      guests: Array.from({ length: 10 }, () => ({ name: 'ü'.repeat(200), email })),
      responses: Object.fromEntries(questions.map((q) => [q.id, q.options])),
    }
    // What e.g. Python's json.dumps sends: every non-ASCII character as \uXXXX.
    const body = JSON.stringify(request).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    expect(body.length).toBeGreaterThan(1_200_000)
    expect(body.length).toBeLessThanOrEqual(BOOKING_BODY_LIMIT)
    const res = await app.request('/api/v1/public/ada/everything/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(201)
    const { booking } = (await res.json()) as { booking: { responses: Record<string, string[]> } }
    expect(booking.responses[questions[0]?.id as string]).toHaveLength(50)

    // The route's limit is exact: one byte more is refused before anything reads the body.
    const padded = (size: number) => {
      const json = JSON.stringify(bookingRequest('2026-11-04T14:00:00Z'))
      return json + ' '.repeat(size - json.length)
    }
    const send = (size: number) =>
      app.request('/api/v1/public/ada/intro/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: padded(size),
      })
    expect((await send(BOOKING_BODY_LIMIT)).status).toBe(201)
    const tooBig = await send(BOOKING_BODY_LIMIT + 1)
    expect(tooBig.status).toBe(413)
    expect(await tooBig.json()).toEqual({ error: 'payload_too_large' })
    // Other routes keep the 64 KB default.
    const reschedule = await post(
      '/api/v1/bookings/manage/reschedule',
      { start: '2026-11-04T15:00:00Z', pad: 'x'.repeat(64 * 1024) },
      { 'x-manage-token': 'A'.repeat(43) },
    )
    expect(reschedule.status).toBe(413)
  })

  it('answers huge flat arrays and objects with a client error, never a 500', async () => {
    // About 1.2 MB each, inside the booking route's 2 MB limit.
    const array = await book('2026-11-02T15:00:00Z', {
      responses: { topic: 'x', q: new Array(300_000).fill('a') },
    })
    expect(array.status).toBe(400)
    expect(await array.json()).toMatchObject({ error: 'invalid_responses' })
    const object = await book('2026-11-02T15:00:00Z', {
      responses: Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`k${i}`, 'a'])),
    })
    expect(object.status).toBe(400)
    expect(await object.json()).toMatchObject({ error: 'invalid_responses' })
  })

  it('refuses a client over its booking limit before reading its body', async () => {
    const limited = appWith({ book: { limit: 1, windowSeconds: 60 } })
    const send = (body: string) =>
      limited.request('/api/v1/public/ada/intro/bookings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    expect((await send('{}')).status).toBe(400)
    // NUL would make the JSON guard answer 400 if it looked at this body: it must not get to.
    const big = JSON.stringify({ pad: 'x'.repeat(1_500_000), name: 'A\u0000B' })
    const refused = await send(big)
    expect(refused.status).toBe(429)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    // Streamed without Content-Length, the body is left unread too.
    const streamed = chunkedBody(JSON.stringify({ pad: 'x'.repeat(1_900_000) }))
    const refusedStream = await limited.request('/api/v1/public/ada/intro/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...streamed.init,
    })
    expect(refusedStream.status).toBe(429)
    expect(streamed.pulled()).toBeLessThanOrEqual(CHUNK_SIZE)
  })

  it('documents the routes', async () => {
    interface Operation {
      security?: unknown
      parameters?: { name: string; in: string }[]
      responses?: Record<string, { description: string }>
    }
    const doc = (await (await get('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, Operation>>
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/public/{handle}',
        '/api/v1/public/{handle}/{slug}',
        '/api/v1/public/{handle}/{slug}/slots',
        '/api/v1/public/{handle}/{slug}/bookings',
        '/api/v1/bookings/manage',
        '/api/v1/bookings/manage/cancel',
        '/api/v1/bookings/manage/reschedule',
        '/api/v1/bookings/manage/slots',
        '/api/v1/bookings',
        '/api/v1/bookings/{id}',
        '/api/v1/bookings/{id}/cancel',
      ]),
    )
    expect(doc.paths['/api/v1/public/{handle}/{slug}/bookings']?.post?.security).toBeUndefined()
    for (const namespace of ['/api/v1/public', '/api/v1/public/teams']) {
      const conflict =
        doc.paths[`${namespace}/{handle}/{slug}/bookings`]?.post?.responses?.['409']?.description
      expect(conflict).toContain('booking_changed')
      expect(conflict).toContain('round-robin host pool or activation changed')
      expect(conflict).toContain('fetch current availability before retrying')
    }
    expect(doc.paths['/api/v1/bookings']?.get?.security).toEqual([{ apiKey: [] }, { session: [] }])
    expect(doc.paths['/api/v1/bookings/manage']?.get?.security).toBeUndefined()
    for (const path of ['/api/v1/bookings/manage', '/api/v1/bookings/manage/slots']) {
      expect(doc.paths[path]?.get?.security).toBeUndefined()
      expect(doc.paths[path]?.get?.parameters).toContainEqual(
        expect.objectContaining({ name: 'x-manage-token', in: 'header' }),
      )
    }
    expect(doc.paths['/api/v1/public/{handle}']?.get?.security).toBeUndefined()
    expect(Object.keys(doc.paths).filter((p) => p.includes('{token}'))).toEqual([])
    const responses = (path: string, method: string) =>
      Object.keys(doc.paths[path]?.[method]?.responses ?? {})
    expect(responses('/api/v1/bookings', 'get')).toEqual(
      expect.arrayContaining(['200', '400', '401', '429']),
    )
    expect(responses('/api/v1/bookings/{id}', 'get')).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '429']),
    )
    expect(responses('/api/v1/bookings/{id}/cancel', 'post')).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409', '429']),
    )
    for (const [path, method] of [
      ['/api/v1/bookings/manage/cancel', 'post'],
      ['/api/v1/bookings/{id}/cancel', 'post'],
    ] as const) {
      expect(doc.paths[path]?.[method]?.responses?.['400']?.description).toContain('invalid_reason')
    }
  })
})
