import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import * as Availability from './availability.ts'
import * as Bookings from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import {
  createOneTimeBookingLink,
  revokeManagedOneTimeBookingLink,
  revokeOneTimeBookingLink,
} from './one-time-links.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T00:00Z')
const invitee = { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' }
type Change = readonly [string, string]

/** Execute only an isolated copy; mutation controls never rewrite production files. */
async function sourceCopy<T>(name: string, change?: Change): Promise<T> {
  const location = new URL(name, import.meta.url)
  const original = readFileSync(location, 'utf8')
  if (change) expect(original.includes(change[0]), 'mutation must match source').toBe(true)
  const source = stripTypeScriptTypes(change ? original.replace(...change) : original).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return guardCopy(
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`),
  )
}

async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (error: unknown) => error,
  )
  expect(error && typeof error === 'object' && (error as Error).name === 'DomainError').toBe(true)
  return error as { kind: string; code: string; detail: string; message: string }
}

const unavailable = { kind: 'not_found', code: 'one_time_link_not_found' }

describe.skipIf(!serverUrl)('public one-time booking flow', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'one_time_public' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(options: Parameters<Fixtures['eventType']>[2] = {}) {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      ...options,
    })
    const service: ServiceContext = {
      ...ctx,
      principal: {
        kind: 'session',
        sessionId: randomUUID(),
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, slug: '', name: '', personal: true },
      },
    }
    const link = await createOneTimeBookingLink(service, {
      eventTypeId,
      prefill: { name: 'Suggested name', email: 'suggested@example.com' },
    })
    const input = (more: Partial<Bookings.CreateOneTimeBookingInput> = {}) => ({
      token: link.token,
      start: instant('2026-11-02T09:00Z'),
      invitee,
      ...more,
    })
    return { ...host, eventTypeId, service, link, input }
  }

  const storedLink = (id: string) =>
    db
      .selectFrom('one_time_booking_links')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const bookingCount = async (eventTypeId: string) =>
    Number(
      (
        await db
          .selectFrom('bookings')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('event_type_id', '=', eventTypeId)
          .executeTakeFirstOrThrow()
      ).count,
    )

  /** Both actual booking transactions must be waiting before the owned blocker releases. */
  async function withHostBlocked<T>(
    userId: string,
    contenders: number,
    start: () => Promise<T>,
    whileBlocked?: () => Promise<void>,
  ): Promise<T> {
    const blocker = await owned.pool.connect()
    const key = `booking-host:${userId}`
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
    let pending: Promise<T> | undefined
    let blockedFailure: unknown
    try {
      pending = start()
      for (let attempt = 0; ; attempt++) {
        const waiting = await sql<{ count: string }>`SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'`.execute(db)
        if (Number(waiting.rows[0]?.count) >= contenders) break
        expect(attempt < 400, 'booking transactions must overlap at the host lock').toBe(true)
        await setTimeout(5)
      }
      await whileBlocked?.()
    } catch (error) {
      blockedFailure = error
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
      blocker.release()
    }
    const result = await pending
    if (blockedFailure) throw blockedFailure
    return result as T
  }

  it('shows the normal hidden event, durations and questions with editable prefill', async () => {
    const s = await setup({
      allowGuests: true,
      questions: [{ id: 'company', label: 'Company', type: 'short_text', required: true }],
    })
    await db
      .updateTable('event_types')
      .set({ is_hidden: true, allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const page = await Availability.getOneTimeBookingPage(ctx, s.link.token)
    expect(page.prefill).toEqual({ name: 'Suggested name', email: 'suggested@example.com' })
    expect(page.eventType).toMatchObject({
      title: 'Intro call',
      allowedDurationsMinutes: [15, 30, 60],
      allowGuests: true,
      questions: [{ id: 'company', required: true }],
    })
    const slots = await Availability.listOneTimeBookingSlots(ctx, {
      token: s.link.token,
      start: instant('2026-11-02T09:00Z'),
      end: instant('2026-11-02T10:00Z'),
      durationMinutes: 15,
    })
    expect(slots).toHaveLength(4)
    expect(slots[0]).toEqual({ start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T09:15:00.000Z' })
    const result = await Bookings.createOneTimeBooking(
      ctx,
      s.input({
        durationMinutes: 15,
        invitee: { ...invitee, name: 'Edited name', email: 'edited@example.com' },
        guests: [{ name: 'Guest', email: 'guest@example.com' }],
        responses: { company: 'Acme' },
      }),
    )
    expect(result.booking).toMatchObject({
      end: '2026-11-02T09:15:00.000Z',
      responses: { company: 'Acme' },
      attendees: [{ name: 'Edited name', email: 'edited@example.com' }, { name: 'Guest' }],
    })
    expect((await storedLink(s.link.id)).booking_id).toBe(result.booking.id)
  })

  it('preserves normal personal profile readiness and team ownership', async () => {
    const s = await setup()
    await db.deleteFrom('profiles').where('user_id', '=', s.userId).execute()
    expect(
      await failure(() => Availability.getOneTimeBookingPage(ctx, s.link.token)),
    ).toMatchObject(unavailable)
    expect(await failure(() => Bookings.createOneTimeBooking(ctx, s.input()))).toMatchObject(
      unavailable,
    )
    expect((await storedLink(s.link.id)).state).toBe('active')

    const creator = await f.user('Creator')
    const host = await f.user('Assigned host')
    const organizationId = await f.organization()
    await f.member(creator, organizationId, 'owner')
    await f.member(host, organizationId)
    await f.schedule(host, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(organizationId, null, { hosts: [{ userId: host }] })
    const service: ServiceContext = {
      ...s.service,
      principal: {
        ...s.service.principal,
        user: { id: creator, name: 'Creator', email: 'creator@example.com' },
        organization: { id: organizationId, name: 'Team', slug: '', personal: false },
      },
    }
    const link = await createOneTimeBookingLink(service, { eventTypeId })
    await db
      .deleteFrom('auth.member')
      .where('userId', '=', creator)
      .where('organizationId', '=', organizationId)
      .execute()
    expect((await Availability.getOneTimeBookingPage(ctx, link.token)).eventType.team).toBeDefined()
    expect(
      (await Bookings.createOneTimeBooking(ctx, s.input({ token: link.token }))).booking.status,
    ).toBe('confirmed')
  })

  it('refuses inactive, deleted and unavailable hosts uniformly without consuming the link', async () => {
    for (const change of ['inactive', 'deleted', 'unverified', 'departed'] as const) {
      const s = await setup()
      if (change === 'inactive')
        await db
          .updateTable('event_types')
          .set({ is_active: false })
          .where('id', '=', s.eventTypeId)
          .execute()
      if (change === 'deleted')
        await db
          .updateTable('event_types')
          .set({ deleted_at: new Date() })
          .where('id', '=', s.eventTypeId)
          .execute()
      if (change === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', s.userId)
          .execute()
      if (change === 'departed')
        await db
          .deleteFrom('auth.member')
          .where('userId', '=', s.userId)
          .where('organizationId', '=', s.organizationId)
          .execute()
      expect(
        await failure(() => Availability.getOneTimeBookingPage(ctx, s.link.token)),
      ).toMatchObject(unavailable)
      expect(
        await failure(() =>
          Availability.listOneTimeBookingSlots(ctx, {
            token: s.link.token,
            start: instant('2026-11-02T09:00Z'),
            end: instant('2026-11-02T10:00Z'),
          }),
        ),
      ).toMatchObject(unavailable)
      expect(await failure(() => Bookings.createOneTimeBooking(ctx, s.input()))).toMatchObject(
        unavailable,
      )
      expect((await storedLink(s.link.id)).state).toBe('active')
      expect(await bookingCount(s.eventTypeId)).toBe(0)
    }
  })

  it('retains ordinary validation and rolls back the claim when the booking transaction fails', async () => {
    const s = await setup({
      questions: [{ id: 'company', label: 'Company', type: 'short_text', required: true }],
    })
    expect((await failure(() => Bookings.createOneTimeBooking(ctx, s.input()))).code).toBe(
      'invalid_responses',
    )
    expect(
      (
        await failure(() =>
          Bookings.createOneTimeBooking(
            ctx,
            s.input({ responses: { company: 'Acme' }, durationMinutes: 60 }),
          ),
        )
      ).code,
    ).toBe('invalid_duration')
    expect(
      (
        await failure(() =>
          Bookings.createOneTimeBooking(
            ctx,
            s.input({
              responses: { company: 'Acme' },
              guests: [{ name: 'Guest', email: 'guest@example.com' }],
            }),
          ),
        )
      ).code,
    ).toBe('guests_not_allowed')
    const notify = vi.fn(async () => {
      throw new Error('synthetic outbox failure')
    })
    await expect(
      Bookings.createOneTimeBooking(
        { ...ctx, notify },
        s.input({ responses: { company: 'Acme' } }),
      ),
    ).rejects.toThrow('synthetic outbox failure')
    expect(notify).toHaveBeenCalledTimes(1)
    expect((await storedLink(s.link.id)).state).toBe('active')
    expect(await bookingCount(s.eventTypeId)).toBe(0)
    expect(
      (await Bookings.createOneTimeBooking(ctx, s.input({ responses: { company: 'Acme' } })))
        .booking.status,
    ).toBe('confirmed')
  })

  async function verifyConcurrent(module = Bookings, rounds = 20) {
    for (let round = 0; round < rounds; round++) {
      const s = await setup()
      const notify = vi.fn(async () => {})
      const results = await withHostBlocked(s.userId, 2, () =>
        Promise.allSettled([
          module.createOneTimeBooking(
            { ...ctx, notify },
            s.input({ idempotencyKey: randomUUID() }),
          ),
          module.createOneTimeBooking(
            { ...ctx, notify },
            s.input({
              start: instant(rounds === 1 || round % 2 ? '2026-11-02T10:00Z' : '2026-11-02T09:00Z'),
              idempotencyKey: randomUUID(),
            }),
          ),
        ]),
      )
      const winners = results.filter((result) => result.status === 'fulfilled')
      expect(winners).toHaveLength(1)
      const loser = results.find((result) => result.status === 'rejected')
      expect(loser?.status === 'rejected' && loser.reason).toMatchObject(unavailable)
      expect(await bookingCount(s.eventTypeId)).toBe(1)
      expect(notify).toHaveBeenCalledTimes(1)
      expect((await storedLink(s.link.id)).state).toBe('used')
    }
  }

  it('admits exactly one winner in 20 overlapping Postgres races, including different slots', async () => {
    await verifyConcurrent()
  }, 30_000)

  async function verifyRevocationWins(module = Bookings) {
    const s = await setup()
    const notify = vi.fn(async () => {})
    let reached = false
    let resume: (() => void) | undefined
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    // Pause after the locked eligibility recheck, while the transaction holds no
    // link-row lock. Revocation must still defeat the later insertion and claim.
    const pausedDb = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        if (
          !reached &&
          result.rows.some((row) => Object.keys(row).length === 1 && 'notifications' in row)
        ) {
          reached = true
          await paused
        }
        return result
      },
    })
    let settled = false
    const booking = Promise.allSettled([
      module.createOneTimeBooking({ ...ctx, db: pausedDb, notify }, s.input()).finally(() => {
        settled = true
      }),
    ])
    let revoked: Awaited<ReturnType<typeof revokeManagedOneTimeBookingLink>> | undefined
    let blockedFailure: unknown
    try {
      for (let attempt = 0; !reached && !settled; attempt++) {
        expect(attempt < 400, 'booking must reach its locked notification-policy read').toBe(true)
        await setTimeout(5)
      }
      expect(reached, 'booking must remain in flight while the host revokes').toBe(true)
      revoked = await revokeManagedOneTimeBookingLink(s.service, {
        eventTypeId: s.eventTypeId,
        id: s.link.id,
      })
    } catch (error) {
      blockedFailure = error
    } finally {
      resume?.()
    }
    const [result] = await booking
    if (blockedFailure) throw blockedFailure
    expect(result?.status).toBe('rejected')
    expect(result?.status === 'rejected' && result.reason).toMatchObject(unavailable)
    expect(revoked?.state).toBe('revoked')
    expect(revoked?.bookingId).toBeNull()
    expect(await bookingCount(s.eventTypeId)).toBe(0)
    expect(notify).not.toHaveBeenCalled()
    expect(await storedLink(s.link.id)).toMatchObject({
      state: 'revoked',
      booking_id: null,
      used_at: null,
    })
    expect(
      await failure(() => Availability.getOneTimeBookingPage(ctx, s.link.token)),
    ).toMatchObject(unavailable)
  }

  async function verifyBookingWins(module = Bookings) {
    const s = await setup()
    let reached = false
    let resume: (() => void) | undefined
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const notify = vi.fn(async () => {
      reached = true
      await paused
    })
    let bookingSettled = false
    const booking = Promise.allSettled([
      module.createOneTimeBooking({ ...ctx, notify }, s.input()).finally(() => {
        bookingSettled = true
      }),
    ])
    let revokeSettled = false
    let revocation:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof revokeManagedOneTimeBookingLink>>>[]>
      | undefined
    let blockedFailure: unknown
    try {
      for (let attempt = 0; !reached && !bookingSettled; attempt++) {
        expect(attempt < 400, 'booking must reach its pre-commit notification callback').toBe(true)
        await setTimeout(5)
      }
      expect(reached, 'booking must remain in flight while the host revokes').toBe(true)
      revocation = Promise.allSettled([
        revokeManagedOneTimeBookingLink(s.service, {
          eventTypeId: s.eventTypeId,
          id: s.link.id,
        }).finally(() => {
          revokeSettled = true
        }),
      ])
      // A correct revoke waits for the booking's claim. A broken claim can let it
      // finish early; still release the booking so the persisted outcome is asserted.
      for (let attempt = 0; !revokeSettled; attempt++) {
        const waiting = await sql<{ count: string }>`SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db)
        if (Number(waiting.rows[0]?.count) >= 1) break
        expect(attempt < 400, 'revocation must overlap the uncommitted booking').toBe(true)
        await setTimeout(5)
      }
    } catch (error) {
      blockedFailure = error
    } finally {
      resume?.()
    }
    const [created] = await booking
    const [revoked] = (await revocation) ?? []
    if (blockedFailure) throw blockedFailure
    expect(created?.status).toBe('fulfilled')
    expect(revoked?.status).toBe('fulfilled')
    if (created?.status !== 'fulfilled' || revoked?.status !== 'fulfilled') return
    expect(revoked.value?.state).toBe('used')
    expect(revoked.value?.bookingId).toBe(created.value.booking.id)
    expect(revoked.value?.revokedAt).toBeNull()
    expect(await bookingCount(s.eventTypeId)).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await storedLink(s.link.id)).toMatchObject({
      state: 'used',
      booking_id: created.value.booking.id,
      revoked_at: null,
    })
    expect(
      await failure(() => Availability.getOneTimeBookingPage(ctx, s.link.token)),
    ).toMatchObject(unavailable)
  }

  it('serializes 20 overlapping revoke/booking races with only the winning terminal outcome', async () => {
    for (let round = 0; round < 10; round++) {
      await verifyBookingWins()
      await verifyRevocationWins()
    }
  }, 30_000)

  it('replays concurrent and later winning requests without claiming or notifying again', async () => {
    const s = await setup()
    const notify = vi.fn(async () => {})
    const input = s.input({ idempotencyKey: randomUUID() })
    const results = await withHostBlocked(s.userId, 2, () =>
      Promise.all([
        Bookings.createOneTimeBooking({ ...ctx, notify }, input),
        Bookings.createOneTimeBooking({ ...ctx, notify }, input),
      ]),
    )
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true])
    expect(results[0]?.booking.id).toBe(results[1]?.booking.id)
    const before = await storedLink(s.link.id)
    const replay = await Bookings.createOneTimeBooking({ ...ctx, notify }, input)
    expect(replay).toMatchObject({
      replayed: true,
      manageToken: null,
      booking: { id: before.booking_id },
    })
    expect(await storedLink(s.link.id)).toEqual(before)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await bookingCount(s.eventTypeId)).toBe(1)
    expect(
      await failure(() =>
        Bookings.createOneTimeBooking(ctx, {
          ...input,
          invitee: { ...invitee, name: 'Someone else' },
        }),
      ),
    ).toMatchObject(unavailable)
  })

  async function verifyReplayDuringResolution(module = Bookings) {
    const s = await setup()
    const input = s.input({ idempotencyKey: randomUUID() })
    let readReached: (() => void) | undefined
    let resume: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      readReached = resolve
    })
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    let held = false
    const hash = createHash('sha256').update(s.link.token).digest('hex')
    const pausedDb = db.withPlugin({
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        if (!held && result.rows.some((row) => row.token_hash === hash && row.state === 'active')) {
          held = true
          readReached?.()
          await paused
        }
        return result
      },
    })
    const pending = module.createOneTimeBooking({ ...ctx, db: pausedDb }, input).then(
      (result) => result,
      (error: unknown) => error,
    )
    // A copy that fails before its read settles at once instead of pausing there.
    await Promise.race([reached, pending])
    let winner: Bookings.CreateBookingResult
    try {
      winner = await module.createOneTimeBooking(ctx, input)
    } finally {
      resume?.()
    }
    expect(await pending).toMatchObject({ replayed: true, booking: { id: winner.booking.id } })
    expect(await bookingCount(s.eventTypeId)).toBe(1)
  }

  it('replays the winner when consumption commits between initial credential reads', async () => {
    await verifyReplayDuringResolution()
  })

  async function verifyBoundReplay(module = Bookings) {
    const s = await setup()
    const input = s.input({ idempotencyKey: randomUUID() })
    const ordinary = { ...input, handle: s.handle, slug: 'intro' }
    await module.createPublicBooking(ctx, ordinary)
    expect(await failure(() => module.createOneTimeBooking(ctx, input))).toMatchObject({
      code: 'idempotency_key_reused',
    })
    expect((await storedLink(s.link.id)).state).toBe('active')
    const winnerInput = {
      ...input,
      idempotencyKey: randomUUID(),
      start: instant('2026-11-02T10:00Z'),
    }
    await module.createOneTimeBooking(ctx, winnerInput)
    const other = await createOneTimeBookingLink(s.service, { eventTypeId: s.eventTypeId })
    expect(
      await failure(() => module.createOneTimeBooking(ctx, { ...winnerInput, token: other.token })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    expect(
      await failure(() => module.createPublicBooking(ctx, { ...ordinary, ...winnerInput })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    expect((await storedLink(other.id)).state).toBe('active')
    expect(await bookingCount(s.eventTypeId)).toBe(2)
  }

  it('binds idempotency to the link, excluding ordinary and other-link request replays', async () => {
    await verifyBoundReplay()
  })

  it('rechecks revocation and wall-time expiry after waiting for the host lock', async () => {
    for (const action of ['revoke', 'expire'] as const) {
      const s = await setup()
      const expiry = await sql<{
        expires: Date
      }>`SELECT clock_timestamp() + interval '300 milliseconds' AS expires`.execute(db)
      const link =
        action === 'revoke'
          ? s.link
          : await createOneTimeBookingLink(s.service, {
              eventTypeId: s.eventTypeId,
              expiresAt: expiry.rows[0]?.expires.toISOString(),
            })
      const result = await withHostBlocked(
        s.userId,
        1,
        () =>
          Bookings.createOneTimeBooking(ctx, s.input({ token: link.token })).then(
            () => null,
            (error: unknown) => error,
          ),
        async () => {
          if (action === 'revoke') await revokeOneTimeBookingLink(s.service, link.id)
          else
            await sql`SELECT pg_sleep(greatest(0, extract(epoch FROM (${link.expiresAt}::timestamptz - clock_timestamp()))) + 0.02)`.execute(
              db,
            )
        },
      )
      expect(result).toMatchObject(unavailable)
      expect(await bookingCount(s.eventTypeId)).toBe(0)
    }
  })

  it('keeps a used link terminal through normal manage-link rescheduling and cancellation', async () => {
    const s = await setup()
    const input = s.input({ idempotencyKey: randomUUID() })
    const created = await Bookings.createOneTimeBooking(ctx, input)
    const moved = await Bookings.rescheduleManagedBooking(ctx, created.manageToken as string, {
      start: instant('2026-11-02T10:00Z'),
    })
    expect(moved.booking.rescheduledFromId).toBe(created.booking.id)
    expect((await storedLink(s.link.id)).booking_id).toBe(created.booking.id)
    await Bookings.cancelManagedBooking(ctx, moved.manageToken as string)
    expect(
      await failure(() => Availability.getOneTimeBookingPage(ctx, s.link.token)),
    ).toMatchObject(unavailable)
    expect((await storedLink(s.link.id)).state).toBe('used')
    const replay = await Bookings.createOneTimeBooking(ctx, input)
    expect(replay).toMatchObject({
      replayed: true,
      booking: { id: created.booking.id, status: 'cancelled' },
    })
    expect(await bookingCount(s.eventTypeId)).toBe(2)
  })

  it('uses one neutral result for malformed, unknown, expired, revoked and used links without logging secrets', async () => {
    const s = await setup()
    const revoked = await createOneTimeBookingLink(s.service, { eventTypeId: s.eventTypeId })
    await revokeOneTimeBookingLink(s.service, revoked.id)
    const expiredToken = randomBytes(32).toString('base64url')
    await db
      .insertInto('one_time_booking_links')
      .values({
        organization_id: s.organizationId,
        event_type_id: s.eventTypeId,
        creator_user_id: s.userId,
        token_hash: createHash('sha256').update(expiredToken).digest('hex'),
        expires_at: sql`clock_timestamp() - interval '1 second'`,
      })
      .execute()
    await Bookings.createOneTimeBooking(ctx, s.input())
    const tokens = [
      '',
      'bad-token',
      randomBytes(32).toString('base64url'),
      expiredToken,
      revoked.token,
      s.link.token,
    ]
    const logs: unknown[][] = []
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((name) =>
      vi.spyOn(console, name as 'log').mockImplementation((...values: unknown[]) => {
        logs.push(values)
      }),
    )
    try {
      const errors: Awaited<ReturnType<typeof failure>>[] = []
      for (const token of tokens) {
        errors.push(await failure(() => Availability.getOneTimeBookingPage(ctx, token)))
        errors.push(await failure(() => Bookings.createOneTimeBooking(ctx, s.input({ token }))))
      }
      for (const error of errors) expect(error).toMatchObject(unavailable)
      expect(errors.every((error) => error.message === errors[0]?.message)).toBe(true)
      const serialized = JSON.stringify({ errors, logs })
      for (const token of tokens.filter((token) => token.length >= 43))
        expect(serialized.includes(token)).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  async function verifyNoEmbed(module = Bookings) {
    const s = await setup()
    expect(
      await failure(() =>
        module.createOneTimeBooking(ctx, s.input(), { source: 'embed', apiKeyId: null }),
      ),
    ).toMatchObject(unavailable)
    expect((await storedLink(s.link.id)).state).toBe('active')
    expect(await bookingCount(s.eventTypeId)).toBe(0)
  }

  it('refuses embed-origin booking even when a caller bypasses the page', async () => {
    await verifyNoEmbed()
  })

  async function mutation(change: Change, verify: (module: typeof Bookings) => Promise<void>) {
    await verify(Bookings)
    const copy = await sourceCopy<typeof Bookings>('./bookings.ts', change)
    await expectKilled(copy, verify)
  }

  it('detects a removed atomic claim with a real concurrency assertion failure', async () => {
    await mutation(
      ['if (oneTimeLink) await claimOneTimeBookingLink(trx, oneTimeLink.token, id)', ''],
      (module) => verifyConcurrent(module, 1),
    )
  })

  it.each([
    ['booking wins', verifyBookingWins, 'revoked', 'used'],
    ['revocation wins', verifyRevocationWins, 'fulfilled', 'rejected'],
  ] as const)(
    'detects a removed claim in the race where %s',
    async (_, verify, actual, expected) => {
      const hash = () =>
        createHash('sha256')
          .update(readFileSync(new URL('./bookings.ts', import.meta.url)))
          .digest('hex')
      const original = hash()
      await verify()
      const copy = await sourceCopy<typeof Bookings>('./bookings.ts', [
        'if (oneTimeLink) await claimOneTimeBookingLink(trx, oneTimeLink.token, id)',
        '',
      ])
      await expectKilled(copy, verify, { outcome: { actual, expected } })
      expect(hash(), 'production source remains byte-identical after the isolated mutation').toBe(
        original,
      )
      await verify()
    },
  )

  it('detects an unbound idempotency fingerprint with real replay assertion failures', async () => {
    await mutation(
      ['...(oneTimeLinkId !== undefined && { oneTimeLinkId }),', ''],
      verifyBoundReplay,
    )
  })

  it('detects a removed replay fallback after racing consumption with a real assertion failure', async () => {
    await mutation(
      [
        "const replay = await oneTimeBookingReplay(ctx, input, origin)\n    if (replay) return oneTimeBookingResult(replay)\n    throw new DomainError('not_found', 'one_time_link_not_found')",
        "throw new DomainError('not_found', 'one_time_link_not_found')",
      ],
      verifyReplayDuringResolution,
    )
  })

  it('detects removed embed exclusion with a real booking assertion failure', async () => {
    await mutation(
      [
        "if (origin.source === 'embed') throw new DomainError('not_found', 'one_time_link_not_found')",
        '',
      ],
      verifyNoEmbed,
    )
  })

  it('detects removed prefill projection with a real page assertion failure', async () => {
    const verify = async (module: typeof Availability) => {
      const s = await setup()
      expect((await module.getOneTimeBookingPage(ctx, s.link.token)).prefill).toEqual({
        name: 'Suggested name',
        email: 'suggested@example.com',
      })
    }
    await verify(Availability)
    const copy = await sourceCopy<typeof Availability>('./availability.ts', [
      'prefill: link.prefill',
      'prefill: { name: null, email: null }',
    ])
    await expectKilled(copy, verify)
  })

  it.each(['personal address', 'team address'] as const)(
    'detects a leaked %s with exact page keys',
    async (mode) => {
      const s = await setup()
      if (mode === 'team address') {
        const organizationId = await f.organization()
        await f.member(s.userId, organizationId, 'owner')
        const eventTypeId = await f.eventType(organizationId, null, {
          hosts: [{ userId: s.userId }],
        })
        const principal = {
          ...s.service.principal,
          organization: { id: organizationId, name: 'Team', slug: '', personal: false },
        }
        const link = await createOneTimeBookingLink({ ...s.service, principal }, { eventTypeId })
        s.link = link
      }
      const verify = async (module: typeof Availability) => {
        const page = await module.getOneTimeBookingPage(ctx, s.link.token)
        expect(Object.keys(page.eventType).sort()).toEqual(
          [
            'allowGuests',
            'description',
            'durationMinutes',
            'host',
            'location',
            'locations',
            'questions',
            ...(mode === 'team address' ? ['team'] : []),
            'title',
          ].sort(),
        )
        if (mode === 'team address')
          expect(Object.keys(page.eventType.team ?? {})).toEqual(['name'])
      }
      await verify(Availability)
      const copy = await sourceCopy<typeof Availability>(
        './availability.ts',
        mode === 'personal address'
          ? ['title: page.title,', '...page, title: page.title,']
          : ['team: { name: page.team.name }', 'team: page.team'],
      )
      await expectKilled(copy, verify)
      await verify(Availability)
    },
  )

  it('detects a bypassed personal handle readiness check with a real page assertion failure', async () => {
    const verify = async (module: typeof Availability) => {
      const s = await setup()
      await db
        .updateTable('profiles')
        .set({ handle: 'app' })
        .where('user_id', '=', s.userId)
        .execute()
      try {
        expect(await failure(() => module.getOneTimeBookingPage(ctx, s.link.token))).toMatchObject(
          unavailable,
        )
      } finally {
        await db
          .updateTable('profiles')
          .set({ handle: s.handle })
          .where('user_id', '=', s.userId)
          .execute()
      }
    }
    await verify(Availability)
    const copy = await sourceCopy<typeof Availability>('./availability.ts', [
      'if (servedHandle(row.handle) === undefined) return undefined',
      '',
    ])
    await expectKilled(copy, verify)
  })

  it('detects a removed locked link reread before availability with a real race assertion failure', async () => {
    const verify = async (module: typeof Bookings) => {
      const s = await setup()
      const results = await withHostBlocked(s.userId, 2, () =>
        Promise.allSettled([
          module.createOneTimeBooking(ctx, s.input()),
          module.createOneTimeBooking(ctx, s.input()),
        ]),
      )
      const loser = results.find((result) => result.status === 'rejected')
      expect(loser?.status === 'rejected' && loser.reason).toMatchObject(unavailable)
    }
    await mutation(
      [
        'await resolveOneTimeBookingLink({ db }, input.token)',
        'if (!options?.lock) await resolveOneTimeBookingLink({ db }, input.token)',
      ],
      verify,
    )
  })
})
