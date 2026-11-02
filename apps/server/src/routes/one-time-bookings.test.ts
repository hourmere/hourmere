import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { CreateBookingResult } from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { bookingRoutes } from './bookings.ts'
import { oneTimeBookingRoutes } from './one-time-bookings.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const plenty = { limit: 100_000, windowSeconds: 60 }
const base = {
  checkDb: async () => {},
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({
    ok: false as const,
    error: 'unauthorized' as const,
    setCookie: [],
  }),
  publicUrl: 'http://localhost',
}

describe.skipIf(!serverUrl)('one-time booking HTTP contract', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let app: ReturnType<typeof createApp>
  let dist: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_http' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    dist = await mkdtemp(join(tmpdir(), 'hourmere-one-time-http-'))
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Hourmere</title>')
    app = createApp({
      ...base,
      webDist: dist,
      embedOrigins: ['https://site.example'],
      routes: [
        oneTimeBookingRoutes({
          db,
          now: () => NOW,
          rateLimits: { page: plenty, slots: plenty, book: plenty },
        }),
        bookingRoutes({ db, now: () => NOW, rateLimits: { manage: plenty } }),
      ],
    })
  })
  afterAll(async () => {
    await owned?.drop()
    if (dist) await rm(dist, { recursive: true, force: true })
  })

  async function setup(expiresAt?: string) {
    const host = await f.host()
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'private-call',
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
    })
    await db
      .updateTable('event_types')
      .set({ is_hidden: true, allowed_durations_minutes: [30, 60] })
      .where('id', '=', eventTypeId)
      .execute()
    const token = randomBytes(32).toString('base64url')
    const link = await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: host.organizationId,
        event_type_id: eventTypeId,
        creator_user_id: host.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
        prefill_name: 'Suggested name',
        prefill_email: 'suggested@example.test',
        expires_at: expiresAt ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { host, eventTypeId, token, linkId: link.id }
  }
  const path = (token: string) => `/api/v1/book/${token}`
  const body = (start = '2026-11-02T09:00:00Z') => ({
    start,
    durationMinutes: 60,
    invitee: { name: 'Edited invitee', email: 'edited@example.test', timeZone: 'UTC' },
    responses: { topic: 'A normal question' },
  })
  const book = (token: string, key: string, payload = body()) =>
    app.request(`${path(token)}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(payload),
    })

  it('uses only path capabilities, never query tokens; serves editable prefill for hidden types', async () => {
    const s = await setup()
    const response = await app.request(path(s.token))
    expect(response.status).toBe(200)
    const page = await response.json()
    expect(page).toMatchObject({
      prefill: { name: 'Suggested name', email: 'suggested@example.test' },
      eventType: { allowedDurationsMinutes: [30, 60], questions: [{ id: 'topic' }] },
    })
    expect(JSON.stringify(page).includes(s.token)).toBe(false)
    for (const url of [
      `/api/v1/book?token=${s.token}`,
      `/api/v1/book/not-a-token?token=${s.token}`,
    ]) {
      const refused = await app.request(url)
      expect(refused.status).toBe(404)
      expect((await refused.text()).includes(s.token)).toBe(false)
    }
    const slots = await app.request(
      `${path(s.token)}/slots?${new URLSearchParams({
        start: '2026-11-02T08:00:00Z',
        end: '2026-11-02T16:00:00Z',
        durationMinutes: '60',
      })}`,
    )
    expect(slots.status).toBe(200)
    expect(((await slots.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
    const booked = await book(s.token, randomUUID())
    expect(booked.status).toBe(201)
    const result = (await booked.json()) as CreateBookingResult
    expect(result.booking.attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Edited invitee', email: 'edited@example.test' }),
      ]),
    )
    expect(result.booking.end).toBe('2026-11-02T10:00:00.000Z')
  })

  it('uses no-referrer and no-store for page, API, errors, and refused embeds', async () => {
    const s = await setup()
    for (const url of [
      `/book/${s.token}`,
      path(s.token),
      '/api/v1/book/malformed',
      `/embed/book/${s.token}?parentOrigin=https%3A%2F%2Fsite.example&embedId=abcdefghijklmnop1234`,
    ]) {
      const response = await app.request(url)
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('X-Frame-Options')).toBe('DENY')
      if (url.startsWith('/embed/')) expect(response.status).toBe(403)
      if (url.startsWith('/book/'))
        expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    }
    const embedded = await book(s.token, randomUUID(), { ...body(), source: 'embed' } as ReturnType<
      typeof body
    >)
    expect(embedded.status).toBe(400)
  })

  it('returns one neutral result for unknown, malformed, expired, revoked, used and inactive links', async () => {
    const unknown = await app.request('/api/v1/book/not-a-token')
    const neutral = await unknown.json()
    expect(neutral).toEqual({ error: 'one_time_link_not_found' })
    for (const state of ['expired', 'revoked', 'used', 'inactive', 'deleted'] as const) {
      const s = await setup(state === 'expired' ? '2000-01-01T00:00:00Z' : undefined)
      if (state === 'revoked')
        await db
          .updateTable('one_time_booking_links')
          .set({ state: 'revoked', revoked_at: new Date() })
          .where('id', '=', s.linkId)
          .execute()
      if (state === 'used') expect((await book(s.token, randomUUID())).status).toBe(201)
      if (state === 'inactive')
        await db
          .updateTable('event_types')
          .set({ is_active: false })
          .where('id', '=', s.eventTypeId)
          .execute()
      if (state === 'deleted')
        await db
          .updateTable('event_types')
          .set({ deleted_at: new Date() })
          .where('id', '=', s.eventTypeId)
          .execute()
      const response = await app.request(path(s.token))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(neutral)
    }
  })

  it('keeps the winning idempotent replay and normal management while refusing a race loser', async () => {
    const s = await setup()
    const keys = [randomUUID(), randomUUID()] as const
    const results = await Promise.all(keys.map((key) => book(s.token, key)))
    expect(results.map((response) => response.status).sort()).toEqual([201, 404])
    const winnerIndex = results.findIndex((response) => response.status === 201)
    const result = (await results[winnerIndex]?.json()) as CreateBookingResult
    const replay = await book(s.token, keys[winnerIndex] as string)
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as CreateBookingResult).booking.id).toBe(result.booking.id)
    const moved = await app.request('/api/v1/bookings/manage/reschedule', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-manage-token': result.manageToken as string,
      },
      body: JSON.stringify({ start: '2026-11-03T09:00:00Z' }),
    })
    expect(moved.status).toBe(200)
    const successor = (await moved.json()) as CreateBookingResult
    const cancelled = await app.request('/api/v1/bookings/manage/cancel', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-manage-token': successor.manageToken as string,
      },
      body: '{}',
    })
    expect(cancelled.status).toBe(200)
    expect((await app.request(path(s.token))).status).toBe(404)
    const row = await db
      .selectFrom('one_time_booking_links')
      .select(['state', 'booking_id'])
      .where('id', '=', s.linkId)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ state: 'used', booking_id: result.booking.id })
  })

  it('never logs the path capability on success, validation, missing links, or errors', async () => {
    const s = await setup()
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    try {
      await app.request(path(s.token))
      await book(s.token, randomUUID(), { ...body(), [s.token]: 'unrecognized' })
      await app.request(`${path(s.token)}/unknown`)
      await book(s.token, randomUUID())
      await app.request(path(s.token))
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls)).includes(s.token)).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
