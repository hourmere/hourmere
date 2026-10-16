// Booking writes against a throwaway database: creating from a public page, idempotent
// retries, races, the invitee's manage link and the host's view.
import { createHash } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Question } from './availability.ts'
import {
  type Booking,
  type CreateBookingInput,
  cancelHostBooking,
  cancelManagedBooking,
  canonicalJson,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  rescheduleManagedBooking,
  validateResponses,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (iso: string) => Temporal.Instant.from(iso)
// Mon 2026-11-02; Berlin is on CET (+01:00), so 09:00–17:00 local is 08:00Z–16:00Z.
const NOW = instant('2026-11-01T12:00:00Z')

describe.skipIf(!serverUrl)('bookings', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  /** A host with a default 09:00–17:00 Berlin schedule and one event type at /{handle}/intro. */
  async function setup(eventType: Parameters<Fixtures['eventType']>[2] = {}) {
    const host = await f.host()
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro call',
      durationMinutes: 30,
      location: { kind: 'phone', number: '+49 30 1234567' },
      ...eventType,
    })
    const book = (start: string, more: Partial<CreateBookingInput> = {}, c = ctx) =>
      createPublicBooking(c, {
        handle: host.handle,
        slug: 'intro',
        start: instant(start),
        invitee: { name: 'Grace Hopper', email: 'grace@example.com', timeZone: 'America/New_York' },
        ...more,
      })
    return { ...host, eventTypeId, book }
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await testDb.pool.query<{ n: number }>(sql, params)).rows[0]?.n

  describe('creating', () => {
    it('stores the booking, its host, attendees and answers, and returns the manage token once', async () => {
      const s = await setup({
        questions: [
          { id: 'topic', label: 'Topic', type: 'long_text', required: true },
          { id: 'agree', label: 'I agree', type: 'checkbox' },
        ],
      })
      const result = await s.book('2026-11-02T09:00:00Z', {
        invitee: {
          name: ' Grace Hopper ',
          email: 'grace@example.com',
          timeZone: 'america/new_york',
          locale: 'en-US',
        },
        guests: [{ name: 'Alan', email: 'alan@example.com' }],
        responses: { topic: '  Compilers  ', agree: false },
      })
      expect(result.replayed).toBe(false)
      expect(result.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(result.booking).toEqual({
        id: expect.any(String),
        eventTypeId: s.eventTypeId,
        status: 'confirmed',
        start: '2026-11-02T09:00:00.000Z',
        end: '2026-11-02T09:30:00.000Z',
        title: 'Intro call with Grace Hopper',
        location: { kind: 'phone', number: '+49 30 1234567' },
        responses: { topic: 'Compilers', agree: false },
        attendees: [
          {
            name: 'Grace Hopper',
            email: 'grace@example.com',
            timeZone: 'America/New_York',
            locale: 'en-US',
            isBooker: true,
          },
          {
            name: 'Alan',
            email: 'alan@example.com',
            timeZone: 'America/New_York',
            locale: null,
            isBooker: false,
          },
        ],
        rescheduledFromId: null,
        cancelledAt: null,
        cancelReason: null,
        source: 'web',
        createdAt: expect.stringMatching(/Z$/),
      } satisfies Booking)

      const row = (
        await testDb.pool.query(
          `SELECT b.organization_id, b.source, b.api_key_id, b.manage_token_hash, bh.user_id, bh.active
             FROM bookings b JOIN booking_hosts bh ON bh.booking_id = b.id WHERE b.id = $1`,
          [result.booking.id],
        )
      ).rows
      expect(row).toEqual([
        {
          organization_id: s.organizationId,
          source: 'web',
          api_key_id: null,
          manage_token_hash: createHash('sha256')
            .update(result.manageToken as string)
            .digest(),
          user_id: s.userId,
          active: true,
        },
      ])
      // The token itself is stored nowhere.
      expect(
        await count(`SELECT count(*)::int AS n FROM bookings b WHERE b::text LIKE $1`, [
          `%${result.manageToken}%`,
        ]),
      ).toBe(0)
    })

    it.each([
      ['off the slot grid', '2026-11-02T09:10:00Z'],
      ['outside working hours', '2026-11-02T17:00:00Z'],
      ['on a weekend', '2026-11-07T09:00:00Z'],
      ['in the past', '2026-10-30T09:00:00Z'],
    ])('refuses a start %s with slot_unavailable', async (_, start) => {
      const s = await setup()
      await expect(s.book(start)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'slot_unavailable',
      })
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE event_type_id = $1', [
          s.eventTypeId,
        ]),
      ).toBe(0)
    })

    it('refuses a time that was just booked, and one within its buffers', async () => {
      const s = await setup({ bufferAfterMinutes: 15 })
      await s.book('2026-11-02T09:00:00Z')
      await expect(s.book('2026-11-02T09:00:00Z')).rejects.toMatchObject({
        code: 'slot_unavailable',
      })
      await expect(s.book('2026-11-02T09:30:00Z')).rejects.toMatchObject({
        code: 'slot_unavailable',
      })
      await expect(s.book('2026-11-02T10:00:00Z')).resolves.toMatchObject({ replayed: false })
    })

    it('answers slot_taken when a concurrent booking commits the same time first', async () => {
      const s = await setup()
      // Another writer holds an uncommitted booking of the same time, so our availability
      // check cannot see it and only the exclusion constraint stops the second booking.
      const other = await testDb.pool.connect()
      try {
        await other.query('BEGIN')
        const b = await other.query<{ id: string }>(
          `INSERT INTO bookings (organization_id, start_at, end_at, title, manage_token_hash, source)
           VALUES ($1, '2026-11-02T11:00Z', '2026-11-02T11:30Z', 'Racer', sha256('racer'::bytea), 'api')
           RETURNING id`,
          [s.organizationId],
        )
        await other.query('INSERT INTO booking_hosts (booking_id, user_id) VALUES ($1, $2)', [
          b.rows[0]?.id,
          s.userId,
        ])
        const attempt = s.book('2026-11-02T11:00:00Z')
        attempt.catch(() => {})
        // Wait until our insert is blocked on the other transaction, then let it commit.
        for (let i = 0; i < 200; i++) {
          const waiting = await count(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
          if (waiting) break
          await new Promise((r) => setTimeout(r, 10))
        }
        await other.query('COMMIT')
        await expect(attempt).rejects.toMatchObject({ kind: 'conflict', code: 'slot_taken' })
      } finally {
        other.release()
      }
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE event_type_id = $1', [
          s.eventTypeId,
        ]),
      ).toBe(0)
    })

    it('keeps the daily limit under concurrent bookings of different times', async () => {
      const s = await setup({ maxBookingsPerDay: 1 })
      const results = await Promise.allSettled(
        ['09:00', '10:00', '11:00', '12:00', '13:00'].map((t) => s.book(`2026-11-03T${t}:00Z`)),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'slot_unavailable' })
      }
    })

    it('validates the invitee, guests and answers', async () => {
      const s = await setup({
        questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
      })
      const start = '2026-11-02T13:00:00Z'
      await expect(s.book(start)).rejects.toMatchObject({ code: 'invalid_responses' })
      await expect(s.book(start, { responses: { topic: 'x', extra: 'y' } })).rejects.toMatchObject({
        code: 'invalid_responses',
      })
      await expect(
        s.book(start, {
          responses: { topic: 'x' },
          invitee: { name: 'G', email: 'g@example.com', timeZone: '+02:00' },
        }),
      ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_time_zone' })
      await expect(
        s.book(start, {
          responses: { topic: 'x' },
          invitee: { name: '  ', email: 'g@example.com', timeZone: 'UTC' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_invitee' })
      await expect(
        s.book(start, {
          responses: { topic: 'x' },
          guests: Array.from({ length: 11 }, (_, i) => ({ name: 'G', email: `g${i}@example.com` })),
        }),
      ).rejects.toMatchObject({ code: 'too_many_guests' })
      await expect(
        s.book(start, { responses: { topic: 'x' }, guests: [{ name: 'G', email: 'nope' }] }),
      ).rejects.toMatchObject({ code: 'invalid_guests' })
      await expect(s.book(start, { responses: { topic: 'x' } })).resolves.toBeDefined()
    })

    it('needs a public event type', async () => {
      const s = await setup()
      await expect(
        createPublicBooking(ctx, {
          handle: s.handle,
          slug: 'missing',
          start: instant('2026-11-02T09:00Z'),
          invitee: { name: 'G', email: 'g@example.com', timeZone: 'UTC' },
        }),
      ).rejects.toMatchObject({ kind: 'not_found', code: 'event_type_not_found' })
    })
  })

  describe('answers', () => {
    const questions: Question[] = [
      { id: 'text', label: 'Text', type: 'short_text', required: false },
      { id: 'phone', label: 'Phone', type: 'phone', required: true },
      { id: 'one', label: 'One', type: 'select', required: false, options: ['a', 'b'] },
      { id: 'many', label: 'Many', type: 'multi_select', required: true, options: ['a', 'b'] },
      { id: 'ok', label: 'OK', type: 'checkbox', required: true },
    ]
    const valid = { phone: '+1 (555) 010-0', many: ['b', 'a'], ok: true }
    const check = (given: unknown) => validateResponses(questions, given)

    it('accepts and normalizes valid answers, leaving out empty optional ones', () => {
      expect(check({ ...valid, text: '  ', one: '' })).toEqual(valid)
      expect(check({ ...valid, text: ' hi ', one: 'a' })).toEqual({
        ...valid,
        text: 'hi',
        one: 'a',
      })
    })

    it.each([
      ['not an object', []],
      ['a missing required answer', { ...valid, phone: undefined }],
      ['an unknown question', { ...valid, other: 'x' }],
      ['an option that does not exist', { ...valid, one: 'c' }],
      ['repeated options', { ...valid, many: ['a', 'a'] }],
      ['no option for a required multi-select', { ...valid, many: [] }],
      ['an unchecked required checkbox', { ...valid, ok: false }],
      ['a non-boolean checkbox', { ...valid, ok: 'yes' }],
      ['text that is too long', { ...valid, text: 'x'.repeat(501) }],
      ['a phone number with letters', { ...valid, phone: 'call me' }],
      ['a number for text', { ...valid, text: 5 }],
    ])('refuses %s', (_, given) => {
      expect(() => check(given)).toThrow(expect.objectContaining({ code: 'invalid_responses' }))
    })
  })

  describe('idempotency', () => {
    it('replays the original booking for the same key and request, without a second insert', async () => {
      const s = await setup()
      const key = crypto.randomUUID()
      const first = await s.book('2026-11-02T14:00:00Z', { idempotencyKey: key })
      // Key order and an equivalent start do not make it a different request.
      const again = await createPublicBooking(ctx, {
        idempotencyKey: key,
        invitee: { timeZone: 'America/New_York', email: 'grace@example.com', name: 'Grace Hopper' },
        start: instant('2026-11-02T15:00:00+01:00'),
        slug: 'intro',
        handle: s.handle,
      })
      expect(again).toEqual({ booking: first.booking, manageToken: null, replayed: true })
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE idempotency_key = $1', [key]),
      ).toBe(1)
    })

    it('refuses a different request with the same key', async () => {
      const s = await setup()
      const key = crypto.randomUUID()
      await s.book('2026-11-02T14:00:00Z', { idempotencyKey: key })
      await expect(s.book('2026-11-02T15:00:00Z', { idempotencyKey: key })).rejects.toMatchObject({
        kind: 'conflict',
        code: 'idempotency_key_reused',
      })
      await expect(
        s.book('2026-11-02T14:00:00Z', {
          idempotencyKey: key,
          guests: [{ name: 'Alan', email: 'alan@example.com' }],
        }),
      ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    })

    it('scopes keys to the organization', async () => {
      const a = await setup()
      const b = await setup()
      const key = 'shared-key'
      const first = await a.book('2026-11-02T14:00:00Z', { idempotencyKey: key })
      const second = await b.book('2026-11-02T14:00:00Z', { idempotencyKey: key })
      expect(second.booking.id).not.toBe(first.booking.id)
      expect(second.manageToken).not.toBeNull()
    })

    it('replays concurrent retries of one request as one booking', async () => {
      const s = await setup()
      const key = crypto.randomUUID()
      const results = await Promise.all(
        Array.from({ length: 5 }, () => s.book('2026-11-02T15:00:00Z', { idempotencyKey: key })),
      )
      expect(new Set(results.map((r) => r.booking.id)).size).toBe(1)
      expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    })

    it('refuses malformed keys', async () => {
      const s = await setup()
      for (const key of ['', 'has space', 'x'.repeat(256), 'ключ']) {
        await expect(s.book('2026-11-02T14:00:00Z', { idempotencyKey: key })).rejects.toMatchObject(
          { kind: 'invalid', code: 'invalid_idempotency_key' },
        )
      }
    })

    it('fingerprints canonical JSON', () => {
      expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: 'x' })).toBe(
        '{"a":"x","b":[2,{"d":1}]}',
      )
    })
  })

  describe('manage links', () => {
    it('show, cancel and free the booking', async () => {
      const s = await setup()
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      const token = manageToken as string
      expect(await getManagedBooking(ctx, token)).toEqual(booking)

      const cancelled = await cancelManagedBooking(ctx, token, { reason: '  Conflict  ' })
      expect(cancelled).toMatchObject({
        id: booking.id,
        status: 'cancelled',
        cancelledAt: '2026-11-01T12:00:00.000Z',
        cancelReason: 'Conflict',
      })
      await expect(cancelManagedBooking(ctx, token)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'booking_cancelled',
      })
      expect((await getManagedBooking(ctx, token)).status).toBe('cancelled')
      // The time is free again.
      await expect(s.book('2026-11-02T10:00:00Z')).resolves.toBeDefined()
    })

    it('answer booking_not_found for unknown and malformed tokens', async () => {
      for (const token of ['A'.repeat(43), 'short', `${'A'.repeat(42)}=`, '']) {
        await expect(getManagedBooking(ctx, token)).rejects.toMatchObject({
          kind: 'not_found',
          code: 'booking_not_found',
        })
        await expect(cancelManagedBooking(ctx, token)).rejects.toMatchObject({
          code: 'booking_not_found',
        })
        await expect(
          rescheduleManagedBooking(ctx, token, { start: instant('2026-11-02T10:00Z') }),
        ).rejects.toMatchObject({ code: 'booking_not_found' })
      }
    })

    it('reschedule onto a time overlapping the old one, with a new token', async () => {
      const s = await setup({
        slotStepMinutes: 15,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 10,
        questions: [{ id: 'topic', label: 'Topic', type: 'short_text' }],
      })
      const { booking: old, manageToken } = await s.book('2026-11-02T10:00:00Z', {
        guests: [{ name: 'Alan', email: 'alan@example.com' }],
        responses: { topic: 'Compilers' },
      })
      const { booking, manageToken: newToken } = await rescheduleManagedBooking(
        ctx,
        manageToken as string,
        { start: instant('2026-11-02T10:15:00Z') },
      )
      expect(booking).toMatchObject({
        status: 'confirmed',
        start: '2026-11-02T10:15:00.000Z',
        end: '2026-11-02T10:45:00.000Z',
        title: old.title,
        location: old.location,
        responses: { topic: 'Compilers' },
        attendees: old.attendees,
        rescheduledFromId: old.id,
        source: 'web',
      })
      expect(booking.id).not.toBe(old.id)
      expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(newToken).not.toBe(manageToken)

      // The old link shows the cancelled booking and can change nothing more.
      expect(await getManagedBooking(ctx, manageToken as string)).toMatchObject({
        id: old.id,
        status: 'cancelled',
      })
      await expect(
        rescheduleManagedBooking(ctx, manageToken as string, {
          start: instant('2026-11-02T13:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })
      expect(await getManagedBooking(ctx, newToken as string)).toEqual(booking)
      const hosts = await testDb.pool.query(
        'SELECT booking_id, active FROM booking_hosts WHERE booking_id = ANY($1) ORDER BY active',
        [[old.id, booking.id]],
      )
      expect(hosts.rows).toEqual([
        { booking_id: old.id, active: false },
        { booking_id: booking.id, active: true },
      ])
    })

    it('reschedule only onto an offered time, leaving the booking as it was otherwise', async () => {
      const s = await setup()
      const { booking: taken } = await s.book('2026-11-02T12:00:00Z')
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      for (const start of [
        '2026-11-02T12:00:00Z',
        '2026-11-02T10:05:00Z',
        '2026-11-02T20:00:00Z',
      ]) {
        await expect(
          rescheduleManagedBooking(ctx, manageToken as string, { start: instant(start) }),
        ).rejects.toMatchObject({ code: 'slot_unavailable' })
      }
      expect(await getManagedBooking(ctx, manageToken as string)).toEqual(booking)
      expect(taken.status).toBe('confirmed')
    })

    it('cannot change a booking that has started', async () => {
      const s = await setup()
      const { manageToken } = await s.book('2026-11-02T10:00:00Z')
      const later = { db, now: () => instant('2026-11-02T10:00:00Z') }
      await expect(cancelManagedBooking(later, manageToken as string)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'booking_in_past',
      })
      await expect(
        rescheduleManagedBooking(later, manageToken as string, {
          start: instant('2026-11-03T10:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_in_past' })
    })

    it('cannot reschedule once the event type stopped taking bookings', async () => {
      const s = await setup()
      const { manageToken } = await s.book('2026-11-02T10:00:00Z')
      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', s.eventTypeId)
        .execute()
      await expect(
        rescheduleManagedBooking(ctx, manageToken as string, {
          start: instant('2026-11-02T11:00Z'),
        }),
      ).rejects.toMatchObject({ kind: 'conflict', code: 'event_type_unavailable' })
      // Cancelling is still possible.
      await expect(cancelManagedBooking(ctx, manageToken as string)).resolves.toMatchObject({
        status: 'cancelled',
      })
    })
  })

  describe('host side', () => {
    let alice: Awaited<ReturnType<typeof setup>>
    let bob: Awaited<ReturnType<typeof setup>>
    let team: string
    let teamBooking: string
    const principal = (
      user: { userId: string },
      organizationId: string,
    ): ServiceContext['principal'] =>
      ({
        kind: 'session',
        sessionId: 'session',
        user: { id: user.userId, name: '', email: '' },
        organization: { id: organizationId, name: '', slug: '', personal: false },
      }) satisfies Principal
    const as = (user: { userId: string }, organizationId: string): ServiceContext => ({
      db,
      now: () => NOW,
      principal: principal(user, organizationId),
    })

    beforeAll(async () => {
      alice = await setup()
      bob = await setup()
      for (const t of ['09:00', '10:00', '11:00']) await alice.book(`2026-11-04T${t}:00Z`)
      await alice.book('2026-11-05T09:00:00Z')
      await bob.book('2026-11-04T09:00:00Z')
      // A team organization both belong to, with a booking Alice hosts there.
      team = await f.organization()
      await f.member(alice.userId, team)
      await f.member(bob.userId, team)
      teamBooking = await f.booking(team, [alice.userId], '2026-11-06T09:00Z', '2026-11-06T09:30Z')
    })

    it('lists the bookings the caller hosts in the organization, a page at a time', async () => {
      const ctxA = as(alice, alice.organizationId)
      const first = await listHostBookings(ctxA, { limit: 3 })
      expect(first.bookings.map((b) => b.start)).toEqual([
        '2026-11-04T09:00:00.000Z',
        '2026-11-04T10:00:00.000Z',
        '2026-11-04T11:00:00.000Z',
      ])
      expect(first.nextCursor).toEqual(expect.any(String))
      const second = await listHostBookings(ctxA, {
        limit: 3,
        cursor: first.nextCursor as string,
      })
      expect(second.bookings.map((b) => b.start)).toEqual(['2026-11-05T09:00:00.000Z'])
      expect(second.nextCursor).toBeNull()

      const inTeam = await listHostBookings(as(alice, team))
      expect(inTeam.bookings.map((b) => b.id)).toEqual([teamBooking])
      expect((await listHostBookings(as(bob, team))).bookings).toEqual([])
      expect((await listHostBookings(as(bob, bob.organizationId))).bookings).toHaveLength(1)
    })

    it('filters by start and status', async () => {
      const ctxA = as(alice, alice.organizationId)
      const { bookings } = await listHostBookings(ctxA, {
        from: instant('2026-11-04T10:00Z'),
        to: instant('2026-11-05T09:00Z'),
      })
      expect(bookings.map((b) => b.start)).toEqual([
        '2026-11-04T10:00:00.000Z',
        '2026-11-04T11:00:00.000Z',
      ])
      expect((await listHostBookings(ctxA, { status: 'cancelled' })).bookings).toEqual([])
      await expect(listHostBookings(ctxA, { cursor: 'nope' })).rejects.toMatchObject({
        code: 'invalid_cursor',
      })
      await expect(listHostBookings(ctxA, { limit: 0 })).rejects.toMatchObject({
        code: 'invalid_limit',
      })
      await expect(
        listHostBookings(ctxA, {
          from: instant('2026-11-05T00:00Z'),
          to: instant('2026-11-04T00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'invalid_range' })
    })

    it("gets and cancels only the caller's own bookings in the organization", async () => {
      const [own] = (await listHostBookings(as(alice, alice.organizationId))).bookings
      const id = (own as Booking).id
      expect(await getHostBooking(as(alice, alice.organizationId), id)).toEqual(own)

      for (const ctxOther of [
        as(bob, alice.organizationId),
        as(bob, bob.organizationId),
        as(bob, team),
        as(alice, team),
      ]) {
        await expect(getHostBooking(ctxOther, id)).rejects.toMatchObject({
          kind: 'not_found',
          code: 'booking_not_found',
        })
        await expect(cancelHostBooking(ctxOther, id)).rejects.toMatchObject({
          code: 'booking_not_found',
        })
      }
      await expect(
        getHostBooking(as(alice, alice.organizationId), 'not-a-uuid'),
      ).rejects.toMatchObject({ code: 'booking_not_found' })

      const cancelled = await cancelHostBooking(as(alice, alice.organizationId), id, {
        reason: 'Out sick',
      })
      expect(cancelled).toMatchObject({ id, status: 'cancelled', cancelReason: 'Out sick' })
      await expect(cancelHostBooking(as(alice, alice.organizationId), id)).rejects.toMatchObject({
        code: 'booking_cancelled',
      })
      expect(
        (await listHostBookings(as(alice, alice.organizationId), { status: 'cancelled' })).bookings,
      ).toHaveLength(1)
      await expect(
        cancelHostBooking(as(alice, alice.organizationId), id, { reason: 'x'.repeat(1001) }),
      ).rejects.toMatchObject({ code: 'invalid_reason' })
    })
  })
})
