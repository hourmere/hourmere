// Booking writes against a throwaway database: creating from a public page, idempotent
// retries, races, the invitee's manage link and the host's view.
import { createHash, randomBytes } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Booking,
  type BookingOrigin,
  type BookingWithToken,
  type CreateBookingInput,
  cancelHostBooking,
  cancelManagedBooking,
  canonicalJson,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingNotifier, PublicContext, ServiceContext } from './context.ts'
import { listHostBookingSlots, listManagedSlots } from './manage.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
/** For tests whose bookings wait on each other's locks: room to finish on a busy machine. */
const SERIALIZED = { timeout: 20_000 }
const instant = (iso: string) => Temporal.Instant.from(iso)
// Mon 2026-11-02; Berlin is on CET (+01:00), so 09:00–17:00 local is 08:00Z–16:00Z.
const NOW = instant('2026-11-01T12:00:00Z')
const NUL = 'A\u0000B'
const LONE_SURROGATE = 'a\ud800b'

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
      // These scenarios exercise a host that explicitly enabled guests.
      allowGuests: true,
      title: 'Intro call',
      durationMinutes: 30,
      location: { kind: 'phone', number: '+49 30 1234567' },
      ...eventType,
    })
    const book = (
      start: string,
      more: Partial<CreateBookingInput> = {},
      c = ctx,
      origin?: BookingOrigin,
    ) =>
      createPublicBooking(
        c,
        {
          handle: host.handle,
          slug: 'intro',
          start: instant(start),
          invitee: {
            name: 'Grace Hopper',
            email: 'grace@example.com',
            timeZone: 'America/New_York',
          },
          ...more,
        },
        origin,
      )
    return { ...host, eventTypeId, book }
  }

  /** A manage token minted by a successfully sent invitee email. */
  async function emailToken(bookingId: string, kind = 'confirmed') {
    const token = randomBytes(32).toString('base64url')
    const invitee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: bookingId,
        kind,
        recipient: `attendee:${invitee.id}`,
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .execute()
    return token
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await testDb.pool.query<{ n: number }>(sql, params)).rows[0]?.n

  /**
   * Holds the per-host lock the booking services take (same key as lockHosts), so a test
   * can change the world while a booking waits for it. Returns the release function.
   */
  async function holdHostLock(userId: string) {
    const client = await testDb.pool.connect()
    const key = `booking-host:${userId}`
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
    return async () => {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
      client.release()
    }
  }

  /** Resolves once `sessions` sessions of this database wait for a lock. */
  async function untilSomeoneWaits(sessions = 1) {
    for (let i = 0; i < 500; i++) {
      const waiting = await count(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
      if ((waiting ?? 0) >= sessions) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`fewer than ${sessions} sessions waited for a lock`)
  }

  /** Runs `attempt` while the host's lock is held, calling `meanwhile` once it waits. */
  async function whileWaiting<T>(
    userId: string,
    attempt: () => Promise<T>,
    meanwhile: () => Promise<unknown>,
  ): Promise<T> {
    const release = await holdHostLock(userId)
    const pending = attempt()
    pending.catch(() => {})
    try {
      await untilSomeoneWaits()
      await meanwhile()
    } finally {
      await release()
    }
    return pending
  }

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

    it(
      'answers slot_taken when a concurrent booking commits the same time first',
      SERIALIZED,
      async () => {
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
      },
    )

    it(
      'keeps the daily limit under concurrent bookings of different times',
      SERIALIZED,
      async () => {
        const s = await setup({ maxBookingsPerDay: 1 })
        const results = await Promise.allSettled(
          ['09:00', '10:00', '11:00', '12:00', '13:00'].map((t) => s.book(`2026-11-03T${t}:00Z`)),
        )
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'slot_unavailable' })
        }
      },
    )

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

    it('replays concurrent retries of one request as one booking', SERIALIZED, async () => {
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

    it("reschedule over the booking's own calendar event, but not over other busy time", async () => {
      const s = await setup({ slotStepMinutes: 15 })
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      // Calendar sync mirrored the booking into the host's calendar; another event is real.
      const { calendarId, externalEventIds } = await f.calendarBusy(s.userId, [
        ['2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z'],
        ['2026-11-02T11:00:00Z', '2026-11-02T11:30:00Z'],
      ])
      await db
        .insertInto('booking_calendar_events')
        .values({
          booking_id: booking.id,
          calendar_id: calendarId,
          external_event_id: externalEventIds[0] as string,
        })
        .execute()

      const moved = await rescheduleManagedBooking(ctx, manageToken as string, {
        start: instant('2026-11-02T10:15:00Z'),
      })
      expect(moved.booking.start).toBe('2026-11-02T10:15:00.000Z')
      await expect(
        rescheduleManagedBooking(ctx, moved.manageToken as string, {
          start: instant('2026-11-02T11:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' })
    })

    it('refuse to reschedule a booking without hosts', async () => {
      const s = await setup()
      const id = await f.booking(s.organizationId, [], '2026-11-02T10:00Z', '2026-11-02T10:30Z', {
        eventTypeId: s.eventTypeId,
      })
      const token = 'NoHost'.padEnd(43, 'x')
      await db
        .updateTable('bookings')
        .set({ manage_token_hash: createHash('sha256').update(token).digest() })
        .where('id', '=', id)
        .execute()
      await expect(
        rescheduleManagedBooking(ctx, token, { start: instant('2026-11-02T13:00:00Z') }),
      ).rejects.toMatchObject({ kind: 'conflict', code: 'booking_has_no_host' })
      expect((await getManagedBooking(ctx, token)).status).toBe('confirmed')
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

  describe('change attribution', () => {
    const audit = (id: string) =>
      db
        .selectFrom('bookings')
        .select(['source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    const hostContext = (
      s: Awaited<ReturnType<typeof setup>>,
      apiKeyId?: string,
    ): ServiceContext => ({
      ...ctx,
      principal: {
        ...(apiKeyId
          ? { kind: 'api_key' as const, apiKeyScope: 'full' as const, apiKeyId }
          : { kind: 'session' as const, sessionId: 'session' }),
        user: { id: s.userId, name: '', email: '' },
        organization: { id: s.organizationId, name: '', slug: '', personal: true },
      },
    })

    it('keeps creation attribution when the invitee cancels on the web', async () => {
      const s = await setup()
      const creator = crypto.randomUUID()
      const { booking, manageToken } = await s.book('2026-11-02T10:00Z', {}, ctx, {
        source: 'mcp',
        apiKeyId: creator,
      })
      const cancelled = await cancelManagedBooking(ctx, manageToken as string)
      expect(await audit(booking.id)).toEqual({
        source: 'mcp',
        api_key_id: creator,
        cancelled_source: 'web',
        cancelled_api_key_id: null,
      })
      expect(cancelled.source).toBe('mcp')
      for (const field of [
        'apiKeyId',
        'cancelledSource',
        'cancelledApiKeyId',
        'cancelled_source',
        'cancelled_api_key_id',
      ]) {
        expect(cancelled).not.toHaveProperty(field)
      }
      expect(JSON.stringify(await getManagedBooking(ctx, manageToken as string))).not.toContain(
        creator,
      )
    })

    it(
      'records only the winning cancellation when different callers race',
      SERIALIZED,
      async () => {
        const s = await setup()
        const { booking, manageToken } = await s.book('2026-11-02T10:00Z')
        const origins: BookingOrigin[] = [
          { source: 'mcp', apiKeyId: crypto.randomUUID() },
          { source: 'api', apiKeyId: crypto.randomUUID() },
        ]
        const results = await Promise.allSettled(
          origins.map((origin) => cancelManagedBooking(ctx, manageToken as string, {}, origin)),
        )
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({
          reason: { code: 'booking_cancelled' },
        })
        const winner = origins[results.findIndex((r) => r.status === 'fulfilled')] as BookingOrigin
        expect(await audit(booking.id)).toEqual({
          source: 'web',
          api_key_id: null,
          cancelled_source: winner.source,
          cancelled_api_key_id: winner.apiKeyId,
        })
      },
    )

    it('attributes a reschedule withdrawal and its new booking to that caller', async () => {
      const s = await setup()
      const creator = crypto.randomUUID()
      const mover = crypto.randomUUID()
      const { booking: old, manageToken } = await s.book('2026-11-02T10:00Z', {}, ctx, {
        source: 'mcp',
        apiKeyId: creator,
      })
      const moved = await rescheduleManagedBooking(
        ctx,
        manageToken as string,
        { start: instant('2026-11-02T11:00Z') },
        { source: 'api', apiKeyId: mover },
      )
      expect(await audit(old.id)).toEqual({
        source: 'mcp',
        api_key_id: creator,
        cancelled_source: 'api',
        cancelled_api_key_id: mover,
      })
      expect(await audit(moved.booking.id)).toEqual({
        source: 'api',
        api_key_id: mover,
        cancelled_source: null,
        cancelled_api_key_id: null,
      })
      await cancelManagedBooking(ctx, moved.manageToken as string)
      expect(await audit(moved.booking.id)).toEqual({
        source: 'api',
        api_key_id: mover,
        cancelled_source: 'web',
        cancelled_api_key_id: null,
      })
    })

    it.each(['session', 'api', 'mcp'] as const)(
      'attributes a host cancellation through %s',
      async (via) => {
        const s = await setup()
        const { booking } = await s.book('2026-11-02T10:00Z')
        const key = crypto.randomUUID()
        await cancelHostBooking(
          hostContext(s, via === 'session' ? undefined : key),
          booking.id,
          {},
          via === 'mcp' ? { source: 'mcp', apiKeyId: key } : undefined,
        )
        expect(await audit(booking.id)).toEqual({
          source: 'web',
          api_key_id: null,
          cancelled_source: via === 'session' ? 'web' : via,
          cancelled_api_key_id: via === 'session' ? null : key,
        })
      },
    )

    it('rejects inconsistent audit data while preserving unknown legacy cancellations', async () => {
      const s = await setup()
      const { booking } = await s.book('2026-11-02T10:00Z')
      const key = crypto.randomUUID()
      for (const values of [
        { cancelled_source: 'web' },
        { status: 'cancelled', cancelled_source: 'unknown' },
        { status: 'cancelled', cancelled_source: null, cancelled_api_key_id: key },
        { status: 'cancelled', cancelled_source: 'web', cancelled_api_key_id: key },
        { status: 'cancelled', cancelled_source: 'embed', cancelled_api_key_id: key },
      ]) {
        await expect(
          db.updateTable('bookings').set(values).where('id', '=', booking.id).execute(),
        ).rejects.toMatchObject({ code: '23514' })
      }
      await db
        .updateTable('bookings')
        .set({ status: 'cancelled', cancelled_at: NOW.toString() })
        .where('id', '=', booking.id)
        .execute()
      expect(await audit(booking.id)).toEqual({
        source: 'web',
        api_key_id: null,
        cancelled_source: null,
        cancelled_api_key_id: null,
      })
    })
  })

  describe('notifying', () => {
    /**
     * A notifier that records each event, with whether it was called inside a transaction
     * whose change other connections cannot see yet (so it commits or rolls back with it).
     */
    function recorder() {
      const events: Record<string, unknown>[] = []
      const notify: BookingNotifier = async (trx, event, now) => {
        const committed = await count(
          'SELECT count(*)::int AS n FROM bookings WHERE id = $1 AND status = $2',
          [event.bookingId, event.type === 'cancelled' ? 'cancelled' : 'confirmed'],
        )
        events.push({
          type: event.type,
          bookingId: event.bookingId,
          start: 'start' in event ? event.start.toString() : undefined,
          now: now.toString(),
          inTransaction: trx.isTransaction,
          visibleOutside: committed === 1,
        })
      }
      return { events, ctx: { db, now: () => NOW, notify } satisfies PublicContext }
    }
    const inTransaction = { now: NOW.toString(), inTransaction: true, visibleOutside: false }
    const hostContext = (userId: string, organizationId: string, c: PublicContext) =>
      ({
        ...c,
        principal: {
          kind: 'session',
          sessionId: 'session',
          user: { id: userId, name: '', email: '' },
          organization: { id: organizationId, name: '', slug: '', personal: true },
        },
      }) satisfies ServiceContext

    it('tells about a new booking in its transaction, and not when replaying it', async () => {
      const s = await setup()
      const r = recorder()
      const key = crypto.randomUUID()
      const first = await s.book('2026-11-02T14:00:00Z', { idempotencyKey: key }, r.ctx)
      const again = await s.book('2026-11-02T14:00:00Z', { idempotencyKey: key }, r.ctx)
      expect(again.replayed).toBe(true)
      expect(r.events).toEqual([
        {
          type: 'created',
          bookingId: first.booking.id,
          start: '2026-11-02T14:00:00Z',
          ...inTransaction,
        },
      ])
    })

    it('tells once about concurrent retries of one request', SERIALIZED, async () => {
      const s = await setup()
      const r = recorder()
      const key = crypto.randomUUID()
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          s.book('2026-11-02T15:00:00Z', { idempotencyKey: key }, r.ctx),
        ),
      )
      expect(r.events.map((e) => e.bookingId)).toEqual([results[0]?.booking.id])
    })

    it('tells about reschedules and cancellations, never about refused changes', async () => {
      const s = await setup()
      const r = recorder()
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      await expect(
        rescheduleManagedBooking(r.ctx, manageToken as string, {
          start: instant('2026-11-02T20:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' })
      const moved = await rescheduleManagedBooking(r.ctx, manageToken as string, {
        start: instant('2026-11-02T13:00:00Z'),
      })
      await expect(
        rescheduleManagedBooking(r.ctx, manageToken as string, {
          start: instant('2026-11-02T14:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })
      await cancelManagedBooking(r.ctx, moved.manageToken as string)
      await expect(cancelManagedBooking(r.ctx, moved.manageToken as string)).rejects.toMatchObject({
        code: 'booking_cancelled',
      })
      // And the host cancelling.
      const other = await s.book('2026-11-02T15:00:00Z')
      const host = hostContext(s.userId, s.organizationId, r.ctx)
      await cancelHostBooking(host, other.booking.id, { reason: 'Ill' })
      await expect(cancelHostBooking(host, other.booking.id)).rejects.toMatchObject({
        code: 'booking_cancelled',
      })
      expect(r.events).toEqual([
        {
          type: 'rescheduled',
          bookingId: moved.booking.id,
          start: '2026-11-02T13:00:00Z',
          ...inTransaction,
        },
        { type: 'cancelled', bookingId: moved.booking.id, start: undefined, ...inTransaction },
        { type: 'cancelled', bookingId: other.booking.id, start: undefined, ...inTransaction },
      ])
      expect(booking.id).not.toBe(moved.booking.id)
    })

    /** Runs `attempt` while another transaction holds the booking's row, as whileWaiting. */
    async function whileHoldingRow<T>(
      bookingId: string,
      attempt: () => Promise<T>,
      meanwhile: () => Promise<unknown>,
    ): Promise<T> {
      const client = await testDb.pool.connect()
      await client.query('BEGIN')
      await client.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])
      const pending = attempt()
      pending.catch(() => {})
      try {
        await untilSomeoneWaits()
        await meanwhile()
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      return pending
    }

    it('tells the instant read after waiting for the locks', SERIALIZED, async () => {
      // A running clock: NOW plus the time since the test began.
      const began = Date.now()
      const clock = () => NOW.add({ milliseconds: Date.now() - began })
      const told: { type: string; now: Temporal.Instant }[] = []
      const c: PublicContext = {
        db,
        now: clock,
        notify: async (_trx, event, now) => {
          told.push({ type: event.type, now })
        },
      }
      // Each wait lasts 800 ms; the instant just before it ends is kept.
      const released: Temporal.Instant[] = []
      const hold = async () => {
        await new Promise((r) => setTimeout(r, 800))
        released.push(clock())
      }
      const s = await setup()
      // Booking and rescheduling wait for the host's lock, cancelling for the booking's row.
      const { manageToken } = await whileWaiting(
        s.userId,
        () => s.book('2026-11-02T10:00:00Z', {}, c),
        hold,
      )
      const moved = await whileWaiting(
        s.userId,
        () =>
          rescheduleManagedBooking(c, manageToken as string, {
            start: instant('2026-11-02T13:00:00Z'),
          }),
        hold,
      )
      await whileHoldingRow(
        moved.booking.id,
        () => cancelManagedBooking(c, moved.manageToken as string),
        hold,
      )
      const other = await s.book('2026-11-02T15:00:00Z')
      await whileHoldingRow(
        other.booking.id,
        () => cancelHostBooking(hostContext(s.userId, s.organizationId, c), other.booking.id),
        hold,
      )
      expect(told.map((t) => t.type)).toEqual(['created', 'rescheduled', 'cancelled', 'cancelled'])
      for (const [i, t] of told.entries()) {
        const until = released[i] as Temporal.Instant
        expect(
          Temporal.Instant.compare(t.now, until),
          `${t.type}: ${t.now} before ${until}`,
        ).toBeGreaterThanOrEqual(0)
      }
    })

    it('makes no change when telling fails', async () => {
      const failing: PublicContext = {
        db,
        now: () => NOW,
        notify: async () => {
          throw new Error('the queue is down')
        },
      }
      const s = await setup()
      await expect(s.book('2026-11-02T10:00:00Z', {}, failing)).rejects.toThrow('queue is down')
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE event_type_id = $1', [
          s.eventTypeId,
        ]),
      ).toBe(0)

      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      const origin: BookingOrigin = { source: 'mcp', apiKeyId: crypto.randomUUID() }
      await expect(
        rescheduleManagedBooking(
          failing,
          manageToken as string,
          {
            start: instant('2026-11-02T13:00:00Z'),
          },
          origin,
        ),
      ).rejects.toThrow('queue is down')
      await expect(
        cancelManagedBooking(failing, manageToken as string, {}, origin),
      ).rejects.toThrow('queue is down')
      await expect(
        cancelHostBooking(hostContext(s.userId, s.organizationId, failing), booking.id, {}, origin),
      ).rejects.toThrow('queue is down')
      expect(await getManagedBooking(ctx, manageToken as string)).toEqual(booking)
      expect(
        await db
          .selectFrom('bookings')
          .select(['cancelled_source', 'cancelled_api_key_id'])
          .where('id', '=', booking.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ cancelled_source: null, cancelled_api_key_id: null })
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE event_type_id = $1', [
          s.eventTypeId,
        ]),
      ).toBe(1)
    })
  })

  describe('manage links from emails', () => {
    it("open, cancel and reschedule the booking, and the API's token keeps working", async () => {
      const s = await setup()
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      const fromEmail = await emailToken(booking.id)
      const fromReminder = await emailToken(booking.id, 'reminder')
      expect(await getManagedBooking(ctx, fromEmail)).toEqual(booking)
      expect(await getManagedBooking(ctx, fromReminder)).toEqual(booking)
      expect(await getManagedBooking(ctx, manageToken as string)).toEqual(booking)

      const moved = await rescheduleManagedBooking(ctx, fromEmail, {
        start: instant('2026-11-02T13:00:00Z'),
      })
      expect(moved.booking).toMatchObject({ rescheduledFromId: booking.id, status: 'confirmed' })
      expect(moved.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect([fromEmail, fromReminder, manageToken]).not.toContain(moved.manageToken)
      expect(await getManagedBooking(ctx, moved.manageToken as string)).toEqual(moved.booking)

      const cancelled = await cancelManagedBooking(ctx, fromReminder, { reason: 'Busy' })
      expect(cancelled).toMatchObject({ id: moved.booking.id, status: 'cancelled' })
    })

    it('follow the meeting through reschedules, unlike the token the API returned', async () => {
      const s = await setup()
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      const fromEmail = await emailToken(booking.id)
      const first = await rescheduleManagedBooking(ctx, manageToken as string, {
        start: instant('2026-11-02T13:00:00Z'),
      })
      // The email about the old booking opens the one that replaced it.
      expect(await getManagedBooking(ctx, fromEmail)).toEqual(first.booking)
      // The API's token stays with its booking, so a retried reschedule cannot move it again.
      expect(await getManagedBooking(ctx, manageToken as string)).toMatchObject({
        id: booking.id,
        status: 'cancelled',
      })
      await expect(
        rescheduleManagedBooking(ctx, manageToken as string, {
          start: instant('2026-11-02T13:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })
      await expect(cancelManagedBooking(ctx, manageToken as string)).rejects.toMatchObject({
        code: 'booking_cancelled',
      })

      // Moved again through the old email: it acts on the latest booking of the chain.
      const second = await rescheduleManagedBooking(ctx, fromEmail, {
        start: instant('2026-11-02T14:00:00Z'),
      })
      expect(second.booking.rescheduledFromId).toBe(first.booking.id)
      expect(await getManagedBooking(ctx, fromEmail)).toEqual(second.booking)
      expect(await getManagedBooking(ctx, first.manageToken as string)).toMatchObject({
        id: first.booking.id,
        status: 'cancelled',
      })

      // Cancelled through it: still shown, read-only.
      await cancelManagedBooking(ctx, fromEmail)
      const shown = await getManagedBooking(ctx, fromEmail)
      expect(shown).toMatchObject({ id: second.booking.id, status: 'cancelled' })
      await expect(cancelManagedBooking(ctx, fromEmail)).rejects.toMatchObject({
        kind: 'conflict',
        code: 'booking_cancelled',
      })
      await expect(
        rescheduleManagedBooking(ctx, fromEmail, { start: instant('2026-11-02T15:00:00Z') }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })
      expect(await getManagedBooking(ctx, second.manageToken as string)).toEqual(shown)
    })

    it('show a cancelled booking read-only', async () => {
      const s = await setup()
      const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
      const fromEmail = await emailToken(booking.id)
      await cancelManagedBooking(ctx, manageToken as string, { reason: 'Conflict' })
      expect(await getManagedBooking(ctx, fromEmail)).toMatchObject({
        id: booking.id,
        status: 'cancelled',
        cancelReason: 'Conflict',
      })
      await expect(cancelManagedBooking(ctx, fromEmail)).rejects.toMatchObject({
        code: 'booking_cancelled',
      })
      await expect(
        rescheduleManagedBooking(ctx, fromEmail, { start: instant('2026-11-02T13:00:00Z') }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })
    })

    it('never match an email the mail server refused, which keeps no hash', async () => {
      const s = await setup()
      const { booking } = await s.book('2026-11-02T10:00:00Z')
      const invitee = await db
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', booking.id)
        .executeTakeFirstOrThrow()
      const refused = {
        booking_id: booking.id,
        kind: 'confirmed',
        recipient: `attendee:${invitee.id}`,
        outcome: 'rejected',
      }
      // The schema keeps a refused email's secret from ever being stored.
      await expect(
        db
          .insertInto('booking_notifications')
          .values({ ...refused, manage_token_hash: createHash('sha256').update('x').digest() })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' })
      await db.insertInto('booking_notifications').values(refused).execute()
      for (const token of ['A'.repeat(43), randomBytes(32).toString('base64url')]) {
        await expect(getManagedBooking(ctx, token)).rejects.toMatchObject({
          code: 'booking_not_found',
        })
      }
    })

    it(
      'cancel the booking that replaced theirs when a reschedule commits while they wait',
      SERIALIZED,
      async () => {
        const s = await setup()
        const { booking, manageToken } = await s.book('2026-11-02T10:00:00Z')
        const fromEmail = await emailToken(booking.id)
        const release = await holdHostLock(s.userId)
        let moving: ReturnType<typeof rescheduleManagedBooking> | undefined
        let byEmail: ReturnType<typeof cancelManagedBooking> | undefined
        let byApi: ReturnType<typeof cancelManagedBooking> | undefined
        try {
          // The reschedule locks the booking, then waits for the host.
          moving = rescheduleManagedBooking(ctx, manageToken as string, {
            start: instant('2026-11-02T13:00:00Z'),
          })
          moving.catch(() => {})
          await untilSomeoneWaits(1)
          // Both cancels wait for the booking's row.
          byEmail = cancelManagedBooking(ctx, fromEmail)
          byEmail.catch(() => {})
          byApi = cancelManagedBooking(ctx, manageToken as string)
          byApi.catch(() => {})
          await untilSomeoneWaits(3)
        } finally {
          await release()
        }
        const moved = await moving
        expect(await byEmail).toMatchObject({ id: moved.booking.id, status: 'cancelled' })
        await expect(byApi).rejects.toMatchObject({ code: 'booking_cancelled' })
      },
    )

    it(
      'lock the booking they act on, even one reached through the chain while it moves on',
      SERIALIZED,
      async () => {
        // B0 was moved to B1 earlier; the email about B0 now stands for B1.
        const s = await setup()
        const { booking: b0, manageToken: t0 } = await s.book('2026-11-02T10:00:00Z')
        const fromEmail = await emailToken(b0.id)
        const b1 = await rescheduleManagedBooking(ctx, t0 as string, {
          start: instant('2026-11-02T11:00:00Z'),
        })
        const releaseHost = await holdHostLock(s.userId)
        // Another transaction holds the old row, ahead of the email's request.
        const other = await testDb.pool.connect()
        await other.query('BEGIN')
        await other.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [b0.id])
        let otherOpen = true
        let moving: ReturnType<typeof rescheduleManagedBooking> | undefined
        let byEmail: ReturnType<typeof cancelManagedBooking> | undefined
        try {
          // B1's own token moves it to B2: it locks B1, then waits for the host.
          moving = rescheduleManagedBooking(ctx, b1.manageToken as string, {
            start: instant('2026-11-02T13:00:00Z'),
          })
          moving.catch(() => {})
          await untilSomeoneWaits(1)
          byEmail = cancelManagedBooking(ctx, fromEmail)
          byEmail.catch(() => {})
          await untilSomeoneWaits(2)
          // Let go of the old row first: whatever the email's request reads now, B2 is
          // not committed yet.
          await other.query('ROLLBACK')
          other.release()
          otherOpen = false
          await new Promise((r) => setTimeout(r, 300))
          await untilSomeoneWaits(2)
        } finally {
          if (otherOpen) {
            await other.query('ROLLBACK')
            other.release()
          }
          await releaseHost()
        }
        const b2 = await moving
        // The cancel acted on the latest booking, B2, not on B1 as it was before the move.
        expect(await byEmail).toMatchObject({ id: b2.booking.id, status: 'cancelled' })
        expect(await getManagedBooking(ctx, b2.manageToken as string)).toMatchObject({
          status: 'cancelled',
        })
        expect(await getManagedBooking(ctx, fromEmail)).toMatchObject({ id: b2.booking.id })
      },
    )

    it('follow a chain of any length, the same way to show and to act', async () => {
      const s = await setup()
      const { booking: root } = await s.book('2026-11-02T10:00:00Z')
      const fromEmail = await emailToken(root.id)
      // 1100 reschedules, as the services write them (a cap of 1000 hops would stop short).
      await testDb.pool.query(`
        DO $$
        DECLARE previous uuid := '${root.id}'; hop int;
        BEGIN
          UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = previous;
          FOR hop IN 1..1100 LOOP
            INSERT INTO bookings (organization_id, status, cancelled_at, start_at, end_at, title,
                                  manage_token_hash, source, rescheduled_from_id)
            VALUES ('${s.organizationId}', CASE WHEN hop < 1100 THEN 'cancelled' ELSE 'confirmed' END,
                    CASE WHEN hop < 1100 THEN now() END, '2026-11-03T12:00Z', '2026-11-03T12:30Z',
                    'Hop ' || hop, sha256(gen_random_uuid()::text::bytea), 'api', previous)
            RETURNING id INTO previous;
          END LOOP;
        END $$`)
      const latest = await db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', s.organizationId)
        .where('title', '=', 'Hop 1100')
        .executeTakeFirstOrThrow()
      expect(await getManagedBooking(ctx, fromEmail)).toMatchObject({
        id: latest.id,
        status: 'confirmed',
      })
      expect(await cancelManagedBooking(ctx, fromEmail)).toMatchObject({
        id: latest.id,
        status: 'cancelled',
      })
      expect(await getManagedBooking(ctx, fromEmail)).toMatchObject({
        id: latest.id,
        status: 'cancelled',
      })
    })

    it('neither hang nor fail on a chain someone edited into a loop', async () => {
      // A statement that loops is cut off here instead of running on.
      const url = new URL(testDb.url)
      url.searchParams.set('options', '-c statement_timeout=5000')
      const guarded = createPool(url.toString())
      try {
        const g: PublicContext = { db: createDb(guarded), now: () => NOW }
        expect((await guarded.query('SHOW statement_timeout')).rows).toEqual([
          { statement_timeout: '5s' },
        ])
        const s = await setup()
        const { booking: b0, manageToken: t0 } = await s.book('2026-11-02T10:00:00Z')
        const fromEmail = await emailToken(b0.id)
        const b1 = await rescheduleManagedBooking(g, t0 as string, {
          start: instant('2026-11-02T11:00:00Z'),
        })
        // Impossible through the services (the link is set once, to an older booking).
        await db
          .updateTable('bookings')
          .set({ rescheduled_from_id: b1.booking.id })
          .where('id', '=', b0.id)
          .execute()
        expect(await getManagedBooking(g, fromEmail)).toMatchObject({ id: b1.booking.id })
        // Acting finds the meeting "moving" forever, so it gives up with a clear answer.
        await expect(cancelManagedBooking(g, fromEmail)).rejects.toMatchObject({
          kind: 'conflict',
          code: 'booking_changed',
        })
      } finally {
        await guarded.end()
      }
    })
  })

  describe('text', () => {
    it.each([
      ['NUL', NUL],
      ['a lone surrogate', LONE_SURROGATE],
    ])('refuses %s in names, emails, locales and answers', async (_, bad) => {
      const s = await setup({ questions: [{ id: 'topic', label: 'Topic', type: 'short_text' }] })
      const invitee = { name: 'Grace', email: 'grace@example.com', timeZone: 'UTC' }
      const cases: [Partial<CreateBookingInput>, string][] = [
        [{ invitee: { ...invitee, name: bad } }, 'invalid_invitee'],
        [{ invitee: { ...invitee, email: `g${bad}@example.com` } }, 'invalid_invitee'],
        [{ invitee: { ...invitee, locale: `en${bad}` } }, 'invalid_invitee'],
        [{ invitee, guests: [{ name: bad, email: 'alan@example.com' }] }, 'invalid_guests'],
        [{ invitee, guests: [{ name: 'Alan', email: `a${bad}@example.com` }] }, 'invalid_guests'],
        [{ invitee, responses: { topic: bad } }, 'invalid_responses'],
      ]
      for (const [more, code] of cases) {
        await expect(s.book('2026-11-02T09:00:00Z', more), code).rejects.toMatchObject({
          kind: 'invalid',
          code,
        })
      }
      await expect(s.book('2026-11-02T09:00:00Z', { invitee })).resolves.toBeDefined()
    })

    it('refuses control characters in names and locales other than NUL too', async () => {
      const s = await setup()
      for (const name of ['Grace\nHopper', `Grace${String.fromCharCode(0x1b)}[31m`, 'a\u2028b']) {
        await expect(
          s.book('2026-11-02T09:00:00Z', {
            invitee: { name, email: 'grace@example.com', timeZone: 'UTC' },
          }),
        ).rejects.toMatchObject({ code: 'invalid_invitee' })
      }
      await expect(
        s.book('2026-11-02T09:00:00Z', {
          invitee: { name: 'G', email: 'g@example.com', timeZone: 'UTC', locale: 'en US' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_invitee' })
    })

    it.each([
      ['NUL', NUL],
      ['a lone surrogate', LONE_SURROGATE],
    ])('refuses %s in cancel reasons, but takes line breaks', async (_, bad) => {
      const s = await setup()
      const { booking, manageToken } = await s.book('2026-11-02T09:00:00Z')
      await expect(
        cancelManagedBooking(ctx, manageToken as string, { reason: bad }),
      ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_reason' })
      const host: ServiceContext = {
        db,
        now: () => NOW,
        principal: {
          kind: 'session',
          sessionId: 'session',
          user: { id: s.userId, name: '', email: '' },
          organization: { id: s.organizationId, name: '', slug: '', personal: true },
        },
      }
      await expect(cancelHostBooking(host, booking.id, { reason: bad })).rejects.toMatchObject({
        code: 'invalid_reason',
      })
      await expect(
        cancelManagedBooking(ctx, manageToken as string, { reason: 'Sorry,\nsomething came up' }),
      ).resolves.toMatchObject({ cancelReason: 'Sorry,\nsomething came up' })
    })
  })

  describe('waiting for the host lock', () => {
    it(
      'books with the event type as it is once the lock is held, not as read before',
      SERIALIZED,
      async () => {
        const s = await setup()
        const { booking } = await whileWaiting(
          s.userId,
          () => s.book('2026-11-02T09:00:00Z'),
          () =>
            db
              .updateTable('event_types')
              .set({ duration_minutes: 60 })
              .where('id', '=', s.eventTypeId)
              .execute(),
        )
        expect([booking.start, booking.end]).toEqual([
          '2026-11-02T09:00:00.000Z',
          '2026-11-02T10:00:00.000Z',
        ])
      },
    )

    it(
      'preserves the original duration when the default changes while rescheduling waits',
      SERIALIZED,
      async () => {
        const s = await setup()
        const { manageToken } = await s.book('2026-11-02T10:00:00Z')
        const { booking } = await whileWaiting(
          s.userId,
          () =>
            rescheduleManagedBooking(ctx, manageToken as string, {
              start: instant('2026-11-02T13:00:00Z'),
            }),
          () =>
            db
              .updateTable('event_types')
              .set({ duration_minutes: 60 })
              .where('id', '=', s.eventTypeId)
              .execute(),
        )
        expect(booking.end).toBe('2026-11-02T13:30:00.000Z')
      },
    )

    it('reads the clock after waiting when booking', SERIALIZED, async () => {
      const s = await setup()
      let clock = NOW
      const ticking: PublicContext = { db, now: () => clock }
      const attempt = whileWaiting(
        s.userId,
        () => s.book('2026-11-02T09:00:00Z', {}, ticking),
        async () => {
          clock = instant('2026-11-02T09:05:00Z')
        },
      )
      await expect(attempt).rejects.toMatchObject({ code: 'slot_unavailable' })
    })

    it('reads the clock after waiting when rescheduling', SERIALIZED, async () => {
      const s = await setup()
      const { manageToken } = await s.book('2026-11-02T10:00:00Z')
      let clock = NOW
      const ticking: PublicContext = { db, now: () => clock }
      const attempt = whileWaiting(
        s.userId,
        () =>
          rescheduleManagedBooking(ticking, manageToken as string, {
            start: instant('2026-11-02T13:00:00Z'),
          }),
        async () => {
          clock = instant('2026-11-02T10:05:00Z')
        },
      )
      await expect(attempt).rejects.toMatchObject({ code: 'booking_in_past' })
    })

    it(
      'lets only one of two bookings that collide only through buffers succeed',
      SERIALIZED,
      async () => {
        // 09:00 keeps 09:00–10:00 busy with its 30-minute buffer after; 09:30 does not overlap
        // the 09:00 meeting itself, so the exclusion constraint alone would let both in.
        const s = await setup({ bufferAfterMinutes: 30 })
        const days = ['02', '03', '04', '05', '06']
        const results = await Promise.allSettled(
          days.flatMap((d) => [s.book(`2026-11-${d}T08:00:00Z`), s.book(`2026-11-${d}T08:30:00Z`)]),
        )
        for (const [i, d] of days.entries()) {
          const pair = results.slice(i * 2, i * 2 + 2)
          expect(
            pair.filter((r) => r.status === 'fulfilled'),
            d,
          ).toHaveLength(1)
          const refused = pair.find((r) => r.status === 'rejected')
          expect(refused?.reason).toMatchObject({ code: 'slot_unavailable' })
        }
      },
    )
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

    it('limits invitee moves to five across new response tokens and preserves cancellation', async () => {
      const h = await setup()
      let current: BookingWithToken = await h.book('2026-11-02T09:00Z')
      const originalId = current.booking.id
      let notifications = 0
      const limited: PublicContext = {
        ...ctx,
        notify: async () => {
          notifications++
        },
      }
      for (const hour of [10, 11, 12, 13, 14]) {
        current = await rescheduleManagedBooking(limited, current.manageToken as string, {
          start: instant(`2026-11-02T${hour}:00Z`),
        })
      }
      await expect(
        rescheduleManagedBooking(limited, current.manageToken as string, {
          start: instant('2026-11-02T15:00Z'),
        }),
      ).rejects.toMatchObject({
        kind: 'conflict',
        code: 'booking_reschedule_limit',
        message:
          'This booking has been rescheduled the maximum number of times. Contact the host to change it again.',
      })
      expect(notifications).toBe(5)
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE organization_id = $1', [
          h.organizationId,
        ]),
      ).toBe(6)
      expect(current.booking.id).not.toBe(originalId)
      expect(await getManagedBooking(ctx, current.manageToken as string)).toMatchObject({
        id: current.booking.id,
        status: 'confirmed',
      })
      const hostMove = rescheduleHostBooking(as(h, h.organizationId), current.booking.id, {
        start: instant('2026-11-02T15:00Z'),
      })
      await expect(hostMove).resolves.toMatchObject({ booking: { status: 'confirmed' } })
      const hostMoved = await hostMove
      const range = {
        start: instant('2026-11-02T08:00Z'),
        end: instant('2026-11-02T16:00Z'),
      }
      await expect(
        listManagedSlots(limited, current.manageToken as string, range),
      ).rejects.toMatchObject({ code: 'booking_reschedule_limit' })
      expect(
        await listHostBookingSlots(as(h, h.organizationId), hostMoved.booking.id, range),
      ).not.toHaveLength(0)
      expect(await cancelManagedBooking(limited, current.manageToken as string)).toMatchObject({
        id: hostMoved.booking.id,
        status: 'cancelled',
      })
      expect(notifications).toBe(6)
    })

    it('counts only invitee moves through mixed host moves and old email tokens', async () => {
      const h = await setup()
      const host = as(h, h.organizationId)
      const limited: PublicContext = { ...ctx, bookingMaxInviteeReschedules: 2 }
      const initial = await h.book('2026-11-02T09:00Z')
      const fromEmail = await emailToken(initial.booking.id)
      const hostFirst = await rescheduleHostBooking(host, initial.booking.id, {
        start: instant('2026-11-02T10:00Z'),
      })
      const inviteeFirst = await rescheduleManagedBooking(limited, initial.manageToken as string, {
        start: instant('2026-11-02T11:00Z'),
      })
      expect(inviteeFirst.booking.rescheduledFromId).toBe(hostFirst.booking.id)
      const hostSecond = await rescheduleHostBooking(host, inviteeFirst.booking.id, {
        start: instant('2026-11-02T12:00Z'),
      })
      const secondMove = rescheduleManagedBooking(limited, fromEmail, {
        start: instant('2026-11-02T13:00Z'),
      })
      await expect(secondMove).resolves.toMatchObject({
        booking: { rescheduledFromId: hostSecond.booking.id },
      })
      const inviteeSecond = await secondMove
      const hostThird = await rescheduleHostBooking(host, inviteeSecond.booking.id, {
        start: instant('2026-11-02T14:00Z'),
      })
      for (const token of [fromEmail, inviteeSecond.manageToken as string]) {
        await expect(
          rescheduleManagedBooking(limited, token, { start: instant('2026-11-02T15:00Z') }),
        ).rejects.toMatchObject({ code: 'booking_reschedule_limit' })
      }
      // Host authority remains available after the invitee has spent its whole budget.
      const hostFourth = await rescheduleHostBooking(host, hostThird.booking.id, {
        start: instant('2026-11-02T15:00Z'),
      })
      expect(await getManagedBooking(ctx, fromEmail)).toMatchObject({ id: hostFourth.booking.id })
      expect(await cancelManagedBooking(limited, fromEmail)).toMatchObject({
        id: hostFourth.booking.id,
        status: 'cancelled',
      })
    })

    it('disables invitee rescheduling at zero while hosts and cancellation remain available', async () => {
      const h = await setup()
      const initial = await h.book('2026-11-02T09:00Z')
      const disabled: PublicContext = { ...ctx, bookingMaxInviteeReschedules: 0 }
      await expect(
        rescheduleManagedBooking(disabled, initial.manageToken as string, {
          start: instant('2026-11-02T10:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_reschedule_limit' })
      const moved = await rescheduleHostBooking(as(h, h.organizationId), initial.booking.id, {
        start: instant('2026-11-02T10:00Z'),
      })
      expect(await cancelManagedBooking(disabled, initial.manageToken as string)).toMatchObject({
        id: moved.booking.id,
        status: 'cancelled',
      })
    })

    it('serializes competing email-token reschedules at the chain limit', async () => {
      const h = await setup()
      const initial = await h.book('2026-11-02T09:00Z')
      const fromEmail = await emailToken(initial.booking.id)
      const limited: PublicContext = { ...ctx, bookingMaxInviteeReschedules: 1 }
      const results = await Promise.allSettled([
        rescheduleManagedBooking(limited, fromEmail, { start: instant('2026-11-02T10:00Z') }),
        rescheduleManagedBooking(limited, fromEmail, { start: instant('2026-11-02T11:00Z') }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'booking_reschedule_limit' },
      })
    })

    it('returns current event title metadata only to hosts without rewriting historical titles', async () => {
      const h = await setup({ title: '初次通话' })
      const caller = as(h, h.organizationId)
      const { booking: original, manageToken } = await h.book('2026-11-02T09:00Z')
      expect(original).not.toHaveProperty('eventTypeTitle')
      expect(await getManagedBooking(ctx, manageToken as string)).not.toHaveProperty(
        'eventTypeTitle',
      )
      for (const current of [
        await getHostBooking(caller, original.id),
        (await listHostBookings(caller)).data[0],
      ]) {
        expect(current).toMatchObject({
          eventTypeTitle: '初次通话',
          title: '初次通话 with Grace Hopper',
        })
      }
      await db
        .updateTable('event_types')
        .set({ title: 'New title' })
        .where('id', '=', h.eventTypeId)
        .execute()
      for (const current of [
        await getHostBooking(caller, original.id),
        (await listHostBookings(caller)).data[0],
      ]) {
        expect(current).toMatchObject({
          eventTypeTitle: 'New title',
          title: '初次通话 with Grace Hopper',
        })
      }
      await db
        .updateTable('event_types')
        .set({ deleted_at: new Date() })
        .where('id', '=', h.eventTypeId)
        .execute()
      for (const current of [
        await getHostBooking(caller, original.id),
        (await listHostBookings(caller)).data[0],
      ]) {
        expect(current).toMatchObject({
          eventTypeTitle: null,
          title: '初次通话 with Grace Hopper',
        })
      }
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

    it.each(['session', 'api', 'mcp'] as const)(
      'reschedules as a host through %s, retaining attendees and creation attribution',
      async (via) => {
        const h = await setup({
          slotStepMinutes: 15,
          questions: [{ id: 'topic', label: 'Topic', type: 'short_text' }],
        })
        const creator = crypto.randomUUID()
        const { booking: old, manageToken } = await h.book(
          '2026-11-02T09:00Z',
          {
            guests: [{ name: 'Guest', email: 'guest@example.com' }],
            responses: { topic: 'Compilers' },
          },
          ctx,
          { source: 'mcp', apiKeyId: creator },
        )
        const key = crypto.randomUUID()
        const base = as(h, h.organizationId)
        const caller: ServiceContext =
          via === 'session'
            ? base
            : {
                ...base,
                principal: {
                  kind: 'api_key',
                  apiKeyScope: 'full' as const,
                  apiKeyId: key,
                  user: base.principal.user,
                  organization: base.principal.organization,
                },
              }
        const moving = rescheduleHostBooking(
          caller,
          old.id,
          { start: instant('2026-11-02T09:15Z') },
          via === 'mcp' ? { source: 'mcp', apiKeyId: key } : undefined,
        )
        await expect(moving.then((moved) => moved.manageToken === null)).resolves.toBe(true)
        const moved = await moving
        expect(moved.booking).toMatchObject({
          status: 'confirmed',
          start: '2026-11-02T09:15:00.000Z',
          rescheduledFromId: old.id,
          title: old.title,
          attendees: old.attendees,
          responses: old.responses,
          location: old.location,
          source: via === 'session' ? 'web' : via,
        })
        expect(moved.manageToken === null).toBe(true)
        const hashes = await db
          .selectFrom('bookings')
          .select(['id', 'manage_token_hash'])
          .where('id', 'in', [old.id, moved.booking.id])
          .execute()
        expect(hashes.find((b) => b.id === old.id)?.manage_token_hash === null).toBe(true)
        expect(
          hashes
            .find((b) => b.id === moved.booking.id)
            ?.manage_token_hash?.equals(
              createHash('sha256')
                .update(manageToken as string)
                .digest(),
            ),
        ).toBe(true)
        expect((await getManagedBooking(ctx, manageToken as string)).id).toBe(moved.booking.id)
        expect(
          await db
            .selectFrom('bookings')
            .select(['source', 'api_key_id', 'cancelled_source', 'cancelled_api_key_id'])
            .where('id', '=', old.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          source: 'mcp',
          api_key_id: creator,
          cancelled_source: via === 'session' ? 'web' : via,
          cancelled_api_key_id: via === 'session' ? null : key,
        })
        expect(
          await db
            .selectFrom('bookings')
            .select('api_key_id')
            .where('id', '=', moved.booking.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ api_key_id: via === 'session' ? null : key })
        await expect(
          rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
        ).rejects.toMatchObject({ code: 'booking_cancelled' })
      },
    )

    it('keeps invitee and email links through host moves while invitee moves still rotate', async () => {
      const h = await setup()
      const { booking: original, manageToken } = await h.book('2026-11-02T09:00Z')
      const fromEmail = await emailToken(original.id)
      const fromReminder = await emailToken(original.id, 'reminder')
      const caller = as(h, h.organizationId)
      let current = original
      for (const start of ['10:00', '11:00']) {
        const moved = await rescheduleHostBooking(caller, current.id, {
          start: instant(`2026-11-02T${start}Z`),
        })
        expect(moved.manageToken === null).toBe(true)
        current = moved.booking
        for (const token of [manageToken, fromEmail, fromReminder])
          expect((await getManagedBooking(ctx, token as string)).id).toBe(current.id)
      }

      const inviteeMove = await rescheduleManagedBooking(ctx, manageToken as string, {
        start: instant('2026-11-02T12:00Z'),
      })
      expect(typeof inviteeMove.manageToken === 'string').toBe(true)
      expect(inviteeMove.manageToken !== manageToken).toBe(true)
      expect(await getManagedBooking(ctx, manageToken as string)).toMatchObject({
        id: current.id,
        status: 'cancelled',
      })
      await expect(
        rescheduleManagedBooking(ctx, manageToken as string, {
          start: instant('2026-11-02T13:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'booking_cancelled' })

      const nextHostMove = await rescheduleHostBooking(caller, inviteeMove.booking.id, {
        start: instant('2026-11-02T13:00Z'),
      })
      expect(nextHostMove.manageToken === null).toBe(true)
      for (const token of [inviteeMove.manageToken, fromEmail, fromReminder])
        expect((await getManagedBooking(ctx, token as string)).id).toBe(nextHostMove.booking.id)
      expect((await getManagedBooking(ctx, manageToken as string)).id).toBe(current.id)
      expect((await cancelManagedBooking(ctx, fromEmail)).id).toBe(nextHostMove.booking.id)
      expect((await getManagedBooking(ctx, inviteeMove.manageToken as string)).status).toBe(
        'cancelled',
      )
    })

    it.each(['team organization', 'personal owner'] as const)(
      'locks the %s before the booking to preserve deletion lock order',
      SERIALIZED,
      async (parent) => {
        const h = await setup()
        const organizationId =
          parent === 'personal owner' ? h.organizationId : await f.organization()
        if (parent === 'team organization') await f.member(h.userId, organizationId)
        const eventTypeId =
          parent === 'personal owner'
            ? h.eventTypeId
            : await f.eventType(organizationId, null, { hosts: [{ userId: h.userId }] })
        const bookingId = await f.booking(
          organizationId,
          [h.userId],
          '2026-11-02T09:00Z',
          '2026-11-02T09:30Z',
          { eventTypeId },
        )
        const blocker = await testDb.pool.connect()
        let pending: ReturnType<typeof rescheduleHostBooking> | undefined
        try {
          await blocker.query('BEGIN')
          const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          if (parent === 'personal owner')
            await blocker.query('SELECT id FROM auth."user" WHERE id = $1 FOR UPDATE', [h.userId])
          else
            await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
              organizationId,
            ])
          pending = rescheduleHostBooking(as(h, organizationId), bookingId, {
            start: instant('2026-11-02T10:00Z'),
          })
          pending.catch(() => {})
          await expect
            .poll(
              () =>
                count(
                  `SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
                  [rows[0]?.pid],
                ),
              { timeout: 5000 },
            )
            .toBe(1)
          // The move has reached the held parent lock but must not yet hold the booking.
          await expect(
            testDb.pool.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE NOWAIT', [
              bookingId,
            ]),
          ).resolves.toMatchObject({ rowCount: 1 })
        } finally {
          await blocker.query('ROLLBACK')
          blocker.release()
          await pending
        }
      },
    )

    it('requires both the caller host and the acting organization, with opaque not-found errors', async () => {
      const h = await setup()
      const peer = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      const elsewhere = await f.organization()
      for (const caller of [as(peer, h.organizationId), as(h, elsewhere), as(peer, elsewhere)]) {
        await expect(
          rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
        ).rejects.toMatchObject({
          kind: 'not_found',
          code: 'booking_not_found',
          detail: 'No such booking',
        })
      }
      for (const id of ['not-a-uuid', crypto.randomUUID()]) {
        await expect(
          rescheduleHostBooking(as(h, h.organizationId), id, {
            start: instant('2026-11-02T10:00Z'),
          }),
        ).rejects.toMatchObject({ code: 'booking_not_found' })
      }
      expect((await getHostBooking(as(h, h.organizationId), old.id)).status).toBe('confirmed')
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE rescheduled_from_id = $1', [
          old.id,
        ]),
      ).toBe(0)
    })

    it.each(['cancelled', 'past'] as const)(
      'refuses a %s booking without a successor',
      async (status) => {
        const h = await setup()
        const { booking: old, manageToken } = await h.book('2026-11-02T09:00Z')
        if (status === 'cancelled') await cancelManagedBooking(ctx, manageToken as string)
        const caller = {
          ...as(h, h.organizationId),
          now: () => (status === 'past' ? instant('2026-11-02T09:00Z') : NOW),
        }
        await expect(
          rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
        ).rejects.toMatchObject({
          code: status === 'past' ? 'booking_in_past' : 'booking_cancelled',
        })
        expect(
          await count('SELECT count(*)::int AS n FROM bookings WHERE rescheduled_from_id = $1', [
            old.id,
          ]),
        ).toBe(0)
      },
    )

    it('checks current availability and leaves the old booking intact when a slot is occupied', async () => {
      const h = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      await h.book('2026-11-02T10:00Z')
      await expect(
        rescheduleHostBooking(as(h, h.organizationId), old.id, {
          start: instant('2026-11-02T10:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' })
      expect((await getHostBooking(as(h, h.organizationId), old.id)).status).toBe('confirmed')
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE rescheduled_from_id = $1', [
          old.id,
        ]),
      ).toBe(0)
    })

    it.each(['inactive', 'deleted'] as const)('refuses a now-%s event type', async (state) => {
      const h = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      await db
        .updateTable('event_types')
        .set(state === 'inactive' ? { is_active: false } : { deleted_at: NOW.toString() })
        .where('id', '=', h.eventTypeId)
        .execute()
      await expect(
        rescheduleHostBooking(as(h, h.organizationId), old.id, {
          start: instant('2026-11-02T10:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'event_type_unavailable' })
      expect((await getHostBooking(as(h, h.organizationId), old.id)).status).toBe('confirmed')
    })

    it('passes the same transaction to notifications and rolls back a failed notification', async () => {
      const h = await setup()
      const { booking: old, manageToken } = await h.book('2026-11-02T09:00Z')
      const hash = createHash('sha256')
        .update(manageToken as string)
        .digest()
      let calls = 0
      const caller = {
        ...as(h, h.organizationId),
        notify: async (trx: Db, event: Parameters<BookingNotifier>[1]) => {
          calls++
          expect(event.type).toBe('rescheduled')
          expect(
            (
              await trx
                .selectFrom('bookings')
                .select(['status', 'manage_token_hash'])
                .where('id', '=', old.id)
                .executeTakeFirstOrThrow()
            ).status,
          ).toBe('cancelled')
          expect(
            (
              await trx
                .selectFrom('bookings')
                .select('manage_token_hash')
                .where('id', '=', old.id)
                .executeTakeFirstOrThrow()
            ).manage_token_hash === null,
          ).toBe(true)
          expect(
            (
              await trx
                .selectFrom('bookings')
                .select('rescheduled_from_id')
                .where('id', '=', event.bookingId)
                .executeTakeFirstOrThrow()
            ).rescheduled_from_id,
          ).toBe(old.id)
          expect(
            (
              await trx
                .selectFrom('bookings')
                .select('manage_token_hash')
                .where('id', '=', event.bookingId)
                .executeTakeFirstOrThrow()
            ).manage_token_hash?.equals(hash),
          ).toBe(true)
          throw new Error('queue unavailable')
        },
      }
      await expect(
        rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
      ).rejects.toThrow('queue unavailable')
      expect(calls).toBe(1)
      expect((await getHostBooking(as(h, h.organizationId), old.id)).status).toBe('confirmed')
      expect((await getManagedBooking(ctx, manageToken as string)).id).toBe(old.id)
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE rescheduled_from_id = $1', [
          old.id,
        ]),
      ).toBe(0)
    })

    it('commits one successor when a host races another host move', SERIALIZED, async () => {
      const h = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      const caller = as(h, h.organizationId)
      const release = await holdHostLock(h.userId)
      const pending = Promise.allSettled([
        rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
        rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T11:00Z') }),
      ])
      try {
        await untilSomeoneWaits(2)
      } finally {
        await release()
      }
      const results = await pending
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'booking_cancelled' },
      })
      expect(
        await count('SELECT count(*)::int AS n FROM bookings WHERE rescheduled_from_id = $1', [
          old.id,
        ]),
      ).toBe(1)
    })

    it(
      'follows the transferred own token when cancellation waited for a host move',
      SERIALIZED,
      async () => {
        const h = await setup()
        const { booking: old, manageToken } = await h.book('2026-11-02T09:00Z')
        const release = await holdHostLock(h.userId)
        let moving: ReturnType<typeof rescheduleHostBooking> | undefined
        let cancelling: ReturnType<typeof cancelManagedBooking> | undefined
        try {
          moving = rescheduleHostBooking(as(h, h.organizationId), old.id, {
            start: instant('2026-11-02T10:00Z'),
          })
          moving.catch(() => {})
          await untilSomeoneWaits()
          cancelling = cancelManagedBooking(ctx, manageToken as string)
          cancelling.catch(() => {})
          await untilSomeoneWaits(2)
        } finally {
          await release()
        }
        const moved = await moving
        await expect(cancelling).resolves.toMatchObject({
          id: moved?.booking.id,
          status: 'cancelled',
        })
        expect((await getManagedBooking(ctx, manageToken as string)).id).toBe(moved?.booking.id)
      },
    )

    it('does not create a new token when the predecessor has only email tokens', async () => {
      const h = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      const fromEmail = await emailToken(old.id)
      await db
        .updateTable('bookings')
        .set({ manage_token_hash: null })
        .where('id', '=', old.id)
        .execute()
      const moved = await rescheduleHostBooking(as(h, h.organizationId), old.id, {
        start: instant('2026-11-02T10:00Z'),
      })
      expect(moved.manageToken === null).toBe(true)
      expect(
        (
          await db
            .selectFrom('bookings')
            .select('manage_token_hash')
            .where('id', '=', moved.booking.id)
            .executeTakeFirstOrThrow()
        ).manage_token_hash === null,
      ).toBe(true)
      expect((await getManagedBooking(ctx, fromEmail)).id).toBe(moved.booking.id)
    })

    it('checks the clock after waiting for the host lock', SERIALIZED, async () => {
      const h = await setup()
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      let now = NOW
      const caller = { ...as(h, h.organizationId), now: () => now }
      const pending = whileWaiting(
        h.userId,
        () => rescheduleHostBooking(caller, old.id, { start: instant('2026-11-02T10:00Z') }),
        async () => {
          now = instant('2026-11-02T09:00Z')
        },
      )
      await expect(pending).rejects.toMatchObject({ code: 'booking_in_past' })
      expect((await getHostBooking(as(h, h.organizationId), old.id)).status).toBe('confirmed')
    })

    it('lists the bookings the caller hosts in the organization, a page at a time', async () => {
      const ctxA = as(alice, alice.organizationId)
      const first = await listHostBookings(ctxA, { limit: 3 })
      expect(first.data.map((b) => b.start)).toEqual([
        '2026-11-04T09:00:00.000Z',
        '2026-11-04T10:00:00.000Z',
        '2026-11-04T11:00:00.000Z',
      ])
      expect(first.nextCursor).toEqual(expect.any(String))
      const second = await listHostBookings(ctxA, {
        limit: 3,
        cursor: first.nextCursor as string,
      })
      expect(second.data.map((b) => b.start)).toEqual(['2026-11-05T09:00:00.000Z'])
      expect(second.nextCursor).toBeNull()

      const inTeam = await listHostBookings(as(alice, team))
      expect(inTeam.data.map((b) => b.id)).toEqual([teamBooking])
      expect((await listHostBookings(as(bob, team))).data).toEqual([])
      expect((await listHostBookings(as(bob, bob.organizationId))).data).toHaveLength(1)
    })

    it('includes a rescheduled successor outside the host page and preserves cancelled status', async () => {
      const h = await setup()
      const caller = as(h, h.organizationId)
      const { booking: old, manageToken } = await h.book('2026-11-02T09:00Z')
      const { booking: successor } = await rescheduleManagedBooking(ctx, manageToken as string, {
        start: instant('2026-11-03T10:00Z'),
      })
      // Restrict the page to the predecessor, so a client cannot infer this from its rows.
      const page = await listHostBookings(caller, {
        status: 'cancelled',
        to: instant('2026-11-03T00:00Z'),
        limit: 1,
      })
      expect(page.data).toHaveLength(1)
      expect(page.data[0]).toMatchObject({
        id: old.id,
        status: 'cancelled',
        rescheduledToId: successor.id,
      })
      expect(await getHostBooking(caller, old.id)).toMatchObject({
        status: 'cancelled',
        rescheduledToId: successor.id,
      })
      expect(await getManagedBooking(ctx, manageToken as string)).not.toHaveProperty(
        'rescheduledToId',
      )
      await cancelHostBooking(caller, successor.id)
      expect(await getHostBooking(caller, old.id)).toMatchObject({
        status: 'cancelled',
        rescheduledToId: successor.id,
      })
      expect(await getHostBooking(caller, successor.id)).toMatchObject({
        status: 'cancelled',
        rescheduledToId: null,
      })
    })

    it('never exposes a rescheduled successor the caller does not host', async () => {
      const h = await setup()
      const caller = as(h, h.organizationId)
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      const { booking: successor } = await rescheduleHostBooking(caller, old.id, {
        start: instant('2026-11-03T10:00Z'),
      })
      await db
        .deleteFrom('booking_hosts')
        .where('booking_id', '=', successor.id)
        .where('user_id', '=', h.userId)
        .execute()
      const otherHost = await f.host()
      await f.member(otherHost.userId, h.organizationId)
      await db
        .insertInto('booking_hosts')
        .values({ booking_id: successor.id, user_id: otherHost.userId })
        .execute()
      expect(await getHostBooking(caller, old.id)).toMatchObject({ rescheduledToId: null })
    })

    it('never exposes a rescheduled successor from another organization', async () => {
      const h = await setup()
      const caller = as(h, h.organizationId)
      const { booking: old } = await h.book('2026-11-02T09:00Z')
      const otherOrganization = await f.organization()
      await f.member(h.userId, otherOrganization)
      const unrelated = await f.booking(
        otherOrganization,
        [h.userId],
        '2026-11-03T09:00Z',
        '2026-11-03T09:30Z',
      )
      // The self-reference alone is not authorization, even for malformed retained data.
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: old.id })
        .where('id', '=', unrelated)
        .execute()
      expect(await getHostBooking(caller, old.id)).toMatchObject({ rescheduledToId: null })
    })

    it('filters by ending time with an exclusive Upcoming and inclusive Past boundary', async () => {
      const caller = as(alice, alice.organizationId)
      const starts = async (input: Parameters<typeof listHostBookings>[1]) =>
        (await listHostBookings(caller, input)).data.map((b) => b.start)
      expect(await starts({ endAfter: instant('2026-11-04T10:15Z') })).toEqual([
        '2026-11-04T10:00:00.000Z',
        '2026-11-04T11:00:00.000Z',
        '2026-11-05T09:00:00.000Z',
      ])
      expect(await starts({ endAfter: instant('2026-11-04T10:30Z') })).toEqual([
        '2026-11-04T11:00:00.000Z',
        '2026-11-05T09:00:00.000Z',
      ])
      expect(await starts({ endTo: instant('2026-11-04T10:30Z') })).toEqual([
        '2026-11-04T09:00:00.000Z',
        '2026-11-04T10:00:00.000Z',
      ])
      expect(await starts({ endTo: instant('2026-11-04T10:29:59.999999Z') })).toEqual([
        '2026-11-04T09:00:00.000Z',
      ])
      for (const endTo of ['2026-11-04T10:30Z', '2026-11-04T10:00Z'])
        await expect(
          listHostBookings(caller, {
            endAfter: instant('2026-11-04T10:30Z'),
            endTo: instant(endTo),
          }),
        ).rejects.toMatchObject({ code: 'invalid_range' })
    })

    it('filters by start and status', async () => {
      const ctxA = as(alice, alice.organizationId)
      const { data } = await listHostBookings(ctxA, {
        from: instant('2026-11-04T10:00Z'),
        to: instant('2026-11-05T09:00Z'),
      })
      expect(data.map((b) => b.start)).toEqual([
        '2026-11-04T10:00:00.000Z',
        '2026-11-04T11:00:00.000Z',
      ])
      expect((await listHostBookings(ctxA, { status: 'cancelled' })).data).toEqual([])
      // Bounds keep their microseconds (a Date would cut them to milliseconds).
      const starts = async (bounds: { from?: Temporal.Instant; to?: Temporal.Instant }) =>
        (await listHostBookings(ctxA, bounds)).data.map((b) => b.start)
      expect(await starts({ from: instant('2026-11-04T10:00:00.000001Z') })).toEqual([
        '2026-11-04T11:00:00.000Z',
        '2026-11-05T09:00:00.000Z',
      ])
      expect(await starts({ to: instant('2026-11-04T10:00:00.000001Z') })).toEqual([
        '2026-11-04T09:00:00.000Z',
        '2026-11-04T10:00:00.000Z',
      ])
      // Bounds beyond the years Postgres reads are the same as no bound.
      expect(await starts({ from: instant('0000-06-01T00:00:00Z') })).toHaveLength(4)
      expect(await starts({ to: instant('+010000-01-01T00:00:00Z') })).toHaveLength(4)
      await expect(listHostBookings(ctxA, { cursor: 'nope' })).rejects.toMatchObject({
        code: 'invalid_cursor',
      })
      // Instants Temporal accepts but Postgres or Date cannot hold.
      for (const start of [
        '-271821-04-20T00:00:00Z',
        '0000-06-01T00:00:00Z',
        '+010000-01-01T00:00:00Z',
        '+275760-09-13T00:00:00Z',
      ]) {
        const cursor = Buffer.from(JSON.stringify([start, crypto.randomUUID()])).toString(
          'base64url',
        )
        await expect(listHostBookings(ctxA, { cursor }), start).rejects.toMatchObject({
          code: 'invalid_cursor',
        })
      }
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

    it('pages through bookings that differ only in microseconds without repeats', async () => {
      const host = await setup()
      const ids: string[] = []
      // Adjacent one-microsecond bookings that all start in the same millisecond.
      for (const us of [1, 2, 3]) {
        const at = (n: number) => `2026-11-09T09:00:00.${String(n).padStart(6, '0')}Z`
        ids.push(await f.booking(host.organizationId, [host.userId], at(us), at(us + 1)))
      }
      const seen: string[] = []
      let cursor: string | undefined
      for (let i = 0; i < 5; i++) {
        const page = await listHostBookings(as(host, host.organizationId), { limit: 1, cursor })
        seen.push(...page.data.map((b) => b.id))
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      expect(seen).toEqual(ids)
    })

    it("gets and cancels only the caller's own bookings in the organization", async () => {
      const [own] = (await listHostBookings(as(alice, alice.organizationId))).data
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
        (await listHostBookings(as(alice, alice.organizationId), { status: 'cancelled' })).data,
      ).toHaveLength(1)
      await expect(
        cancelHostBooking(as(alice, alice.organizationId), id, { reason: 'x'.repeat(1001) }),
      ).rejects.toMatchObject({ code: 'invalid_reason' })
    })

    it('pages backwards through equal starts and microseconds without omissions or repeats', async () => {
      const host = await setup()
      const rows: { id: string; start: string }[] = []
      for (const us of [0, 1, 1, 1, 2, 3]) {
        const start = `2026-11-09T09:00:00.${String(us).padStart(6, '0')}Z`
        rows.push({
          id: await f.booking(host.organizationId, [host.userId], start, '2026-11-09T09:30:00Z', {
            status: 'cancelled',
          }),
          start,
        })
      }
      const expected = rows
        .sort((a, b) => Temporal.Instant.compare(a.start, b.start) || (a.id < b.id ? -1 : 1))
        .map((r) => r.id)
      const c = as(host, host.organizationId)
      expect((await listHostBookings(c)).data.map((b) => b.id)).toEqual(expected)
      expect((await listHostBookings(c, { order: 'asc' })).data.map((b) => b.id)).toEqual(expected)
      for (const limit of [1, 2, 3, 5, 6]) {
        const ids: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
          const result = await listHostBookings(c, {
            order: 'desc',
            status: 'cancelled',
            limit,
            cursor,
          })
          ids.push(...result.data.map((b) => b.id))
          if (!result.nextCursor) break
          cursor = result.nextCursor
        }
        expect(ids).toEqual(expected.toReversed())
      }
      const filtered = await listHostBookings(c, {
        order: 'desc',
        from: instant('2026-11-09T09:00:00.000001Z'),
        to: instant('2026-11-09T09:00:00.000003Z'),
      })
      expect(filtered.data.map((b) => b.id)).toEqual(expected.slice(1, 5).toReversed())
      expect(
        await listHostBookings(c, { order: 'desc', from: instant('2030-01-01T00:00Z') }),
      ).toEqual({ data: [], nextCursor: null })
      await expect(listHostBookings(c, { order: 'newest' as 'desc' })).rejects.toMatchObject({
        code: 'invalid_order',
      })
    })

    it('continues descending pages without repeating newly inserted newer bookings', async () => {
      const host = await setup()
      const ids = []
      for (const hour of ['09', '10', '11'])
        ids.push(
          await f.booking(
            host.organizationId,
            [host.userId],
            `2026-11-09T${hour}:00Z`,
            `2026-11-09T${hour}:30Z`,
          ),
        )
      const c = as(host, host.organizationId)
      const first = await listHostBookings(c, { order: 'desc', limit: 1 })
      await f.booking(host.organizationId, [host.userId], '2026-11-09T12:00Z', '2026-11-09T12:30Z')
      const rest = await listHostBookings(c, { order: 'desc', cursor: first.nextCursor as string })
      expect([...first.data, ...rest.data].map((b) => b.id)).toEqual(ids.toReversed())
      expect(rest.nextCursor).toBeNull()
    })
  })
})
