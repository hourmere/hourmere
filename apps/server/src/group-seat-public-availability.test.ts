import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { publicRoutes } from './routes/public.ts'

const NOW = Temporal.Instant.from('2027-10-31T12:00:00Z')
const START = '2027-11-01T09:00:00Z'
const NEXT = '2027-11-01T10:00:00Z'
const plenty = { limit: 100_000, windowSeconds: 60 }
type Seat = { booking: { id: string }; manageToken: string | null }
type Slot = { start: string; end: string; seatsRemaining?: number; capacity?: number }

describe.skipIf(!process.env.DATABASE_URL)('public group availability', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  function app(database = db, manageRoutes = bookingRoutes) {
    return createApp({
      publicUrl: 'http://localhost:3000',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        publicRoutes({
          db: database,
          now: () => NOW,
          smtpConfigured: true,
          automaticMeet: true,
          waitlistSecret: 'synthetic-public-group-waitlist-secret',
          rateLimits: { book: plenty, slots: plenty },
        }),
        manageRoutes({
          db: database,
          now: () => NOW,
          rateLimits: { manage: plenty, slots: plenty },
        }),
      ],
    })
  }

  async function fixture(capacity = 3, timeZone = 'UTC') {
    const f = createFixtures(db)
    const host = await f.host({ timeZone })
    const scheduleId = await f.schedule(host.userId, {
      timeZone,
      weeklyHours: Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
          (day) => [day, [{ start: '00:00', end: '23:59' }]],
        ),
      ),
    })
    const eventId = await f.eventType(host.organizationId, host.userId, {
      slug: 'class',
      location: { kind: 'link', url: 'https://example.test/class' },
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: capacity })
      .where('id', '=', eventId)
      .execute()
    return { ...host, scheduleId, eventId, path: `/api/v1/public/${host.handle}/class` }
  }

  async function slots(path: string, start = START, end = NEXT, client = app()) {
    const response = await client.request(`${path}/slots?${new URLSearchParams({ start, end })}`)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { data: Slot[] }
    // An exact allowlist catches accidental attendee IDs, mailbox keys or membership data.
    for (const slot of body.data) {
      expect(Object.keys(slot).sort()).toEqual(['capacity', 'end', 'seatsRemaining', 'start'])
    }
    return body.data.map((slot) => ({
      ...slot,
      start: Temporal.Instant.from(slot.start).toString(),
      end: Temporal.Instant.from(slot.end).toString(),
    }))
  }
  function book(path: string, email: string, start = START, key = randomUUID(), client = app()) {
    return client.request(`${path}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        start,
        invitee: { name: `Private ${email}`, email, timeZone: 'UTC' },
      }),
    })
  }
  async function seat(path: string, email: string, start = START) {
    const response = await book(path, email, start)
    expect(response.status, await response.clone().text()).toBe(201)
    return (await response.json()) as Seat
  }
  async function manage(action: 'cancel' | 'reschedule', token: string | null, start?: string) {
    expect(token).toBeTypeOf('string')
    const response = await app().request(`/api/v1/bookings/manage/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-manage-token': token as string,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(start ? { start } : {}),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as Seat
  }

  it('counts each independent seat, hides a full session, and reopens cancelled and rescheduled seats', async () => {
    const f = await fixture(2)
    expect((await slots(f.path))[0]).toMatchObject({ start: START, capacity: 2, seatsRemaining: 2 })
    const first = await seat(f.path, 'first-private@example.test')
    expect((await slots(f.path))[0]).toMatchObject({ start: START, seatsRemaining: 1 })
    const second = await seat(f.path, 'second-private@example.test')
    expect((await slots(f.path)).some((slot) => slot.start === START)).toBe(false)
    await manage('cancel', first.manageToken)
    expect((await slots(f.path))[0]).toMatchObject({ start: START, seatsRemaining: 1 })
    const third = await seat(f.path, 'third-private@example.test')
    expect((await slots(f.path)).some((slot) => slot.start === START)).toBe(false)
    await manage('reschedule', second.manageToken, NEXT)
    expect((await slots(f.path))[0]).toMatchObject({ start: START, seatsRemaining: 1 })
    expect((await slots(f.path, NEXT, '2027-11-01T10:30:00Z'))[0]).toMatchObject({
      seatsRemaining: 1,
    })
    const managed = await app().request('/api/v1/bookings/manage', {
      headers: { 'x-manage-token': third.manageToken as string },
    })
    const body = await managed.text()
    expect(body).not.toContain('first-private')
    expect(body).not.toContain('second-private')
    const discovery = JSON.stringify(await slots(f.path))
    expect(discovery).not.toMatch(/private|@|attendee|booker|group_slot|bookingId/i)
  })

  it('serializes the last seat across two database connections and replays the winner at capacity', async () => {
    const f = await fixture(2)
    await seat(f.path, 'existing@example.test')
    const pools = [createPool(owned.url), createPool(owned.url)]
    try {
      const clients = pools.map((pool) => app(createDb(pool)))
      const keys = [randomUUID(), randomUUID()]
      const responses = await Promise.all(
        clients.map((client, i) => book(f.path, `racer-${i}@example.test`, START, keys[i], client)),
      )
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
      const winner = responses.findIndex((response) => response.status === 201)
      const winningSeat = (await responses[winner]?.json()) as Seat
      const loser = responses[1 - winner] as Response
      expect(await loser.json()).toMatchObject({ error: 'slot_taken' })
      const replay = await book(
        f.path,
        `racer-${winner}@example.test`,
        START,
        keys[winner],
        clients[winner],
      )
      expect(replay.status).toBe(200)
      expect(await replay.json()).toMatchObject({
        booking: { id: winningSeat.booking.id },
        manageToken: null,
      })
      const count = await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', f.eventId)
        .where('status', '=', 'confirmed')
        .execute()
      expect(count).toHaveLength(2)
      expect((await slots(f.path)).some((slot) => slot.start === START)).toBe(false)
    } finally {
      await Promise.all(pools.map((pool) => pool.end()))
    }
  })

  it('keeps existing seats bookable at the occurrence limit while hiding new occurrences', async () => {
    const f = await fixture()
    await db
      .updateTable('event_types')
      .set({ max_bookings_per_day: 1 })
      .where('id', '=', f.eventId)
      .execute()
    await seat(f.path, 'first@example.test')
    const available = await slots(f.path)
    expect(available).toEqual([
      { start: START, end: '2027-11-01T09:30:00Z', seatsRemaining: 2, capacity: 3 },
    ])
    await seat(f.path, 'joining@example.test')
    await db
      .updateTable('event_types')
      .set({ minimum_notice_minutes: 7 * 24 * 60 })
      .where('id', '=', f.eventId)
      .execute()
    expect(await slots(f.path)).toEqual([])
    const holder = await book(f.path, 'first@example.test')
    const stranger = await book(f.path, 'stranger@example.test')
    expect(holder.status).toBe(409)
    expect(await holder.text()).toBe(await stranger.text())
  })

  it('preserves pinned capacity and host reservation after current configuration changes', async () => {
    const f = await fixture(3)
    await seat(f.path, 'pinned@example.test')
    await db
      .updateTable('event_types')
      .set({ group_capacity: 5 })
      .where('id', '=', f.eventId)
      .execute()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{}' })
      .where('id', '=', f.scheduleId)
      .execute()
    await createFixtures(db).calendarBusy(f.userId, [[START, NEXT]], { now: NOW })
    expect(await slots(f.path)).toEqual([
      { start: START, end: '2027-11-01T09:30:00Z', capacity: 3, seatsRemaining: 2 },
    ])
    await seat(f.path, 'pinned-join@example.test')
    expect((await slots(f.path))[0]).toMatchObject({ capacity: 3, seatsRemaining: 1 })
  })

  it('offers a usable pinned plain occurrence after an unavailable provider edit and hides a broken pinned conference', async () => {
    const plain = await fixture()
    await seat(plain.path, 'plain-private@example.test')
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', plain.eventId)
      .execute()
    expect(await slots(plain.path, START, '2027-11-01T09:30:00Z')).toEqual([
      { start: START, end: '2027-11-01T09:30:00Z', capacity: 3, seatsRemaining: 2 },
    ])
    await seat(plain.path, 'plain-joining@example.test')

    const meet = await fixture()
    const calendarId = await createFixtures(db).meetDestination(meet.userId)
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
      .where('id', '=', meet.eventId)
      .execute()
    await seat(meet.path, 'meet-private@example.test')
    expect((await slots(meet.path, START, '2027-11-01T09:30:00Z'))[0]).toMatchObject({
      seatsRemaining: 2,
    })
    // New occurrences now use a plain link; the existing occurrence keeps Meet.
    await db
      .updateTable('event_types')
      .set({ location: JSON.stringify({ kind: 'link', url: 'https://example.test/new' }) })
      .where('id', '=', meet.eventId)
      .execute()
    const calendar = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', calendarId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', calendar.connection_id)
      .execute()
    expect(await slots(meet.path, START, '2027-11-01T09:30:00Z')).toEqual([])
    const holder = await book(meet.path, 'meet-private@example.test')
    const stranger = await book(meet.path, 'stranger@example.test')
    expect(holder.status).toBe(409)
    expect(await holder.json()).toEqual({
      error: 'slot_unavailable',
      message: 'This time is not available',
    })
    expect(await stranger.json()).toEqual({
      error: 'slot_unavailable',
      message: 'This time is not available',
    })
  })

  it('uses the existing waitlist only when the requested group window has no seats', async () => {
    const f = await fixture(2)
    await db
      .updateTable('event_types')
      .set({ waitlist_enabled: true })
      .where('id', '=', f.eventId)
      .execute()
    const discovery = await app().request(f.path)
    expect(await discovery.json()).toMatchObject({ waitlist: { enabled: true } })
    const join = () =>
      app().request(`${f.path}/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'waiting@example.test',
          consent: true,
          preferredWindow: { start: START, end: '2027-11-01T09:30:00Z', timeZone: 'UTC' },
        }),
      })
    await seat(f.path, 'one@example.test')
    const free = await join()
    expect(free.status).toBe(409)
    expect(await free.json()).toMatchObject({ error: 'availability_changed' })
    const second = await seat(f.path, 'two@example.test')
    expect(await slots(f.path, START, '2027-11-01T09:30:00Z')).toEqual([])
    const full = await join()
    expect(full.status, await full.clone().text()).toBe(202)
    expect(await full.json()).toEqual({ accepted: true })
    await manage('cancel', second.manageToken)
    expect((await slots(f.path, START, '2027-11-01T09:30:00Z'))[0]).toMatchObject({
      seatsRemaining: 1,
    })
    expect((await join()).status).toBe(409)
  })

  it('kills omitting the public reschedule idempotency header forwarding', async () => {
    const url = new URL('./routes/bookings.ts', import.meta.url)
    const original = readFileSync(url, 'utf8')
    const anchor = "            idempotencyKey: c.req.valid('header')['idempotency-key'],"
    expect(original).toContain(anchor)
    let source = stripTypeScriptTypes(original.replace(anchor, ''))
    const bindings: Record<string, unknown> = {}
    for (const match of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
      const specifier = match[2] as string
      const imported = await import(
        specifier.startsWith('.') ? new URL(specifier, url).href : specifier
      )
      for (const binding of (match[1] as string)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)) {
        const [name, local] = binding.split(/\s+as\s+/)
        bindings[local ?? (name as string)] = imported[name as string]
      }
      source = source.replace(match[0], '')
    }
    source = source.replace(/^export \{[^}]*\}\n/gm, '').replace(/\bexport /g, '')
    const mutated: typeof bookingRoutes = new Function(
      ...Object.keys(bindings),
      `${source}; return bookingRoutes`,
    )(...Object.values(bindings))
    const f = await fixture()
    const booked = await seat(f.path, 'mutation-reschedule@example.test')
    const response = await app(db, mutated).request('/api/v1/bookings/manage/reschedule', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-manage-token': booked.manageToken as string,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ start: NEXT }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_idempotency_key' })
    expect(() => expect(response.status).toBe(200)).toThrowError(/expected 400 to be 200/)
  })

  it('does not reopen a host-cancelled occurrence', async () => {
    const f = await fixture()
    // This terminal storage state has no host-facing creation surface yet.
    await db.transaction().execute(async (trx) => {
      const occurrence = await trx
        .insertInto('group_slots')
        .values({
          organization_id: f.organizationId,
          event_type_id: f.eventId,
          original_event_type_id: f.eventId,
          host_user_id: f.userId,
          start_at: START,
          end_at: '2027-11-01T09:30:00Z',
          capacity: 3,
          title: 'Cancelled class',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('group_slots')
        .set({ state: 'host_cancelled' })
        .where('id', '=', occurrence.id)
        .execute()
    })
    expect(await slots(f.path, START, '2027-11-01T09:30:00Z')).toEqual([])
    const response = await book(f.path, 'new@example.test')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'slot_unavailable' })
  })

  it('counts seats on the DST spring-forward day without offering a nonexistent local time', async () => {
    const f = await fixture(3, 'America/New_York')
    const start = '2028-03-12T06:30:00Z'
    const end = '2028-03-12T08:00:00Z'
    await seat(f.path, 'dst@example.test', start)
    const available = await slots(f.path, start, end)
    expect(available.find((slot) => slot.start === start)).toMatchObject({ seatsRemaining: 2 })
    expect(available.find((slot) => slot.start === '2028-03-12T07:00:00Z')).toMatchObject({
      seatsRemaining: 3,
    })
    expect(
      available.map(
        (slot) => Temporal.Instant.from(slot.start).toZonedDateTimeISO('America/New_York').hour,
      ),
    ).not.toContain(2)
    await seat(f.path, 'dst-later@example.test', '2028-03-12T07:00:00Z')
    expect((await slots(f.path, start, end)).find((slot) => slot.start === start)).toMatchObject({
      seatsRemaining: 2,
    })
  })
})
