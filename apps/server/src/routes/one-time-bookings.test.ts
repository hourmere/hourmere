import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type {
  CreateBookingResult,
  ManagedBooking,
  OneTimeBookingPage,
  SlotView,
} from '@hourmere/scheduling'
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

  async function setup(expiresAt?: string, team = false) {
    const host = await f.host()
    await f.schedule(host.userId)
    const teamSlug = `private-team-${randomUUID()}`
    const organizationId = team ? await f.organization(teamSlug) : host.organizationId
    if (team) {
      await f.member(host.userId, organizationId, 'owner')
      await db
        .updateTable('auth.organization')
        .set({ name: 'Private team' })
        .where('id', '=', organizationId)
        .execute()
    }
    const eventTypeId = await f.eventType(organizationId, team ? null : host.userId, {
      slug: 'private-call',
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
      ...(team && { hosts: [{ userId: host.userId }] }),
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
        organization_id: organizationId,
        event_type_id: eventTypeId,
        creator_user_id: host.userId,
        token_hash: createHash('sha256').update(token).digest('hex'),
        prefill_name: 'Suggested name',
        prefill_email: 'suggested@example.test',
        expires_at: expiresAt ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { host, eventTypeId, token, linkId: link.id, teamSlug }
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

  it('validates the selected location on one-time slot queries', async () => {
    const s = await setup()
    const response = await app.request(
      `${path(s.token)}/slots?start=2026-11-02T00:00:00Z&end=2026-11-03T00:00:00Z&locationOptionId=missing`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_location_choice' })
  })

  it.each([false, true])(
    'serves only presentation keys for hidden types (team=%s)',
    async (team) => {
      const s = await setup(undefined, team)
      const response = await app.request(path(s.token))
      expect(response.status).toBe(200)
      const page = (await response.json()) as OneTimeBookingPage
      expect(page).toMatchObject({
        prefill: { name: 'Suggested name', email: 'suggested@example.test' },
        eventType: { allowedDurationsMinutes: [30, 60], questions: [{ id: 'topic' }] },
      })
      expect(Object.keys(page).sort()).toEqual(['eventType', 'prefill'])
      expect(Object.keys(page.prefill).sort()).toEqual(['email', 'name'])
      expect(Object.keys(page.eventType).sort()).toEqual(
        [
          'allowGuests',
          'allowedDurationsMinutes',
          'description',
          'durationMinutes',
          'host',
          'location',
          'locations',
          'questions',
          ...(team ? ['team'] : []),
          'title',
        ].sort(),
      )
      expect(Object.keys(page.eventType.host).sort()).toEqual(['name', 'timeZone'])
      if (team) expect(page.eventType.team).toEqual({ name: 'Private team' })
      const privateAddressesAbsent = (value: unknown) => {
        for (const identifier of [s.host.handle, 'private-call', s.teamSlug])
          expect(JSON.stringify(value).includes(identifier)).toBe(false)
      }
      privateAddressesAbsent(page)
      const html = await app.request(`/book/${s.token}`)
      expect(html.status).toBe(200)
      privateAddressesAbsent(await html.text())
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
      const available = (await slots.json()) as { data: SlotView[] }
      expect(Object.keys(available)).toEqual(['data'])
      expect(available.data.length).toBeGreaterThan(0)
      for (const slot of available.data) expect(Object.keys(slot).sort()).toEqual(['end', 'start'])
      privateAddressesAbsent(available)
      const booked = await book(s.token, randomUUID())
      expect(booked.status).toBe(201)
      const result = (await booked.json()) as CreateBookingResult
      expect(Object.keys(result).sort()).toEqual(['booking', 'manageToken'])
      expect(Object.keys(result.booking).sort()).toEqual([
        'attendees',
        'cancelReason',
        'cancelledAt',
        'createdAt',
        'end',
        'eventTypeId',
        'id',
        'location',
        'rescheduledFromId',
        'responses',
        'source',
        'start',
        'status',
        'title',
      ])
      privateAddressesAbsent(result)
      expect(result.booking.attendees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Edited invitee', email: 'edited@example.test' }),
        ]),
      )
      expect(result.booking.end).toBe('2026-11-02T10:00:00.000Z')
      const managed = await app.request('/api/v1/bookings/manage', {
        headers: { 'x-manage-token': result.manageToken as string },
      })
      expect(managed.status).toBe(200)
      const details = (await managed.json()) as ManagedBooking
      expect(Object.keys(details).sort()).toEqual(
        [...Object.keys(result.booking), 'eventType', 'hosts'].sort(),
      )
      expect(Object.keys(details.eventType ?? {}).sort()).toEqual([
        'allowedDurationsMinutes',
        'durationMinutes',
        'title',
      ])
      expect(details.hosts.every((host: object) => Object.keys(host).join() === 'name')).toBe(true)
      privateAddressesAbsent(details)
    },
  )

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
