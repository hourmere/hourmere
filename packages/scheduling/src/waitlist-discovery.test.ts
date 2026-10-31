// Freed-slot discovery and ordinary-booking attribution use the real scheduling engine,
// booking locks and PostgreSQL constraints. One owned fixture pool bounds connections.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as availability from './availability.ts'
import {
  type CreateBookingInput,
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext } from './context.ts'
import { createFixtures, type Fixtures, weekdays } from './testing.ts'
import * as waitlist from './waitlist.ts'
import {
  ensureWaitlistKey,
  mintWaitlistManagementToken,
  removeWaitlist,
  type WaitlistContext,
  waitlistRecipientHash,
} from './waitlist.ts'
import { attributeWaitlistBooking } from './waitlist-booking.ts'
import { scanWaitlistEvent, scanWaitlists } from './waitlist-discovery.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (value: string) => Temporal.Instant.from(value)
const NOW = instant('2026-11-01T12:00:00Z')
const START = '2026-11-02T08:00:00Z'
const END = '2026-11-02T08:30:00Z'
const SECRET = 'waitlist-discovery-test-secret-with-32-characters'
const SERIALIZED = { timeout: 20_000 }

interface Candidate {
  id: string
  cohort_id: string
  entry_id: string
  slots: { start: string; end: string }[]
  expires_at: Date
}

const iso = (value: string) => instant(value).toString({ fractionalSecondDigits: 3 })

type Change = readonly [string, string]

/** Compile an isolated source copy; production source and database guards are unchanged. */
function sourceCopy(
  file: 'waitlist-discovery' | 'waitlist-booking',
  changes: readonly Change[] = [],
) {
  let source = readFileSync(`packages/scheduling/src/${file}.ts`, 'utf8')
  for (const [before, after] of changes) {
    expect(source.includes(before), 'mutation must match its protection').toBe(true)
    source = source.replace(before, after)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { sql, ...availability, ...waitlist }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return ${file === 'waitlist-discovery' ? '{ scanWaitlistEvent, scanWaitlists }' : '{ attributeWaitlistBooking }'}`,
  )(...Object.values(bindings)) as {
    scanWaitlistEvent: typeof scanWaitlistEvent
    scanWaitlists: typeof scanWaitlists
    attributeWaitlistBooking: typeof attributeWaitlistBooking
  }
}

describe.skipIf(!serverUrl)('waitlist discovery and booking attribution', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: WaitlistContext
  let publicCtx: PublicContext

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_scan' })
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = { db, secret: SECRET, publicUrl: 'https://booking.example.test', now: () => NOW }
    publicCtx = { db, waitlistSecret: SECRET, now: () => NOW }
    await db
      .transaction()
      .execute((trx) => ensureWaitlistKey(trx, SECRET, new Date(NOW.epochMilliseconds)))
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  async function setup(
    options: {
      hours?: WeeklyHours
      now?: Temporal.Instant
      timeZone?: string
      event?: Parameters<Fixtures['eventType']>[2]
    } = {},
  ) {
    const now = options.now ?? NOW
    const host = await f.host({ timeZone: options.timeZone ?? 'Europe/Berlin' })
    const scheduleId = await f.schedule(host.userId, {
      timeZone: options.timeZone ?? 'Europe/Berlin',
      weeklyHours: options.hours ?? weekdays({ start: '09:00', end: '11:00' }),
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      ...options.event,
    })
    await testDb.pool.query('UPDATE event_types SET waitlist_enabled = true WHERE id = $1', [
      eventTypeId,
    ])
    return {
      ...host,
      eventTypeId,
      scheduleId,
      now,
      ctx: { ...ctx, now: () => now },
      publicCtx: { ...publicCtx, now: () => now },
    }
  }

  type Setup = Awaited<ReturnType<typeof setup>>

  // Contact fixtures start already verified to isolate discovery from the separately
  // exercised verification service. Capabilities are minted by the production helper.
  async function entry(
    s: Setup,
    options: {
      email?: string
      start?: string
      end?: string
      status?: 'active' | 'notified' | 'pending_verification'
      expiry?: string
    } = {},
  ) {
    const email = options.email ?? `${randomUUID()}@example.test`
    const start = options.start ?? START
    const end = options.end ?? END
    const expires = options.expiry ?? end
    const created = options.expiry ? instant(options.expiry).subtract({ hours: 720 }) : s.now
    const status = options.status ?? 'active'
    const recipient = waitlistRecipientHash(email, SECRET)
    const row = await testDb.pool.query<{ id: string }>(
      `INSERT INTO waitlist_entries
        (organization_id,event_type_id,recipient_hash,email,name,window_start,window_end,
         time_zone,locale,consent_version,consented_at,status,created_at,expires_at,
         pending_expires_at,verified_at)
       VALUES ($1,$2,$3,$4,'Waitlisted invitee',$5,$6,'Europe/Berlin','en-US',
               'waitlist-v1',$7,$8,$7,$9,LEAST($7::timestamptz + interval '24 hours',$9),$10)
       RETURNING id`,
      [
        s.organizationId,
        s.eventTypeId,
        recipient,
        email,
        start,
        end,
        new Date(created.epochMilliseconds),
        status,
        expires,
        status === 'pending_verification' ? null : new Date(s.now.epochMilliseconds),
      ],
    )
    const id = row.rows[0]?.id as string
    const token = await db
      .transaction()
      .execute((trx) => mintWaitlistManagementToken(trx, id, new Date(s.now.epochMilliseconds)))
    return { id, token, email, recipient }
  }

  async function candidates(eventTypeId: string): Promise<Candidate[]> {
    return (
      await testDb.pool.query<Candidate>(
        'SELECT id,cohort_id,entry_id,slots,expires_at FROM waitlist_candidates WHERE event_type_id=$1 ORDER BY entry_id',
        [eventTypeId],
      )
    ).rows
  }

  async function state(id: string) {
    return (
      await testDb.pool.query<{ status: string; booking_id: string | null }>(
        'SELECT status,booking_id FROM waitlist_entries WHERE id=$1',
        [id],
      )
    ).rows[0]
  }

  function book(s: Setup, email: string, more: Partial<CreateBookingInput> = {}, c = s.publicCtx) {
    return createPublicBooking(c, {
      handle: s.handle,
      slug: 'intro',
      start: instant(START),
      invitee: { name: 'Invitee', email, timeZone: 'Europe/Berlin' },
      ...more,
    })
  }

  it('broadcasts one cohort to every verified matching entry and excludes unverified or partial windows', async () => {
    const s = await setup()
    const first = await entry(s)
    const second = await entry(s, { status: 'notified' })
    await entry(s, { status: 'pending_verification' })
    await entry(s, { start: '2026-11-02T08:15:00Z', end: '2026-11-02T08:45:00Z' })
    const ended = await entry(s)
    await removeWaitlist(s.ctx, { token: ended.token })
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(2)
    const rows = await candidates(s.eventTypeId)
    expect(rows.map((r) => r.entry_id).sort()).toEqual([first.id, second.id].sort())
    expect(new Set(rows.map((r) => r.cohort_id)).size).toBe(1)
    expect(rows.map((r) => r.slots)).toEqual([
      [{ start: iso(START), end: iso(END) }],
      [{ start: iso(START), end: iso(END) }],
    ])
    // Discovery creates intentions, without claiming SMTP acceptance or a slot hold.
    expect(await state(first.id)).toMatchObject({ status: 'active', booking_id: null })
    expect(await state(second.id)).toMatchObject({ status: 'notified', booking_id: null })
  })

  it('selects up to three deterministic exact UTC intervals and leaves distinct later slots eligible', async () => {
    const s = await setup()
    const person = await entry(s, { end: '2026-11-02T10:00:00Z' })
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    const first = (await candidates(s.eventTypeId))[0]
    expect(first?.slots).toEqual([
      { start: iso('2026-11-02T08:00:00Z'), end: iso('2026-11-02T08:30:00Z') },
      { start: iso('2026-11-02T08:30:00Z'), end: iso('2026-11-02T09:00:00Z') },
      { start: iso('2026-11-02T09:00:00Z'), end: iso('2026-11-02T09:30:00Z') },
    ])
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    const rows = await candidates(s.eventTypeId)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id !== first?.id)?.slots).toEqual([
      { start: iso('2026-11-02T09:30:00Z'), end: iso('2026-11-02T10:00:00Z') },
    ])
    expect(rows.every((r) => r.entry_id === person.id)).toBe(true)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
  })

  it('deduplicates concurrent scans by exact mailbox and UTC slot', SERIALIZED, async () => {
    const s = await setup()
    await entry(s)
    await entry(s)
    const counts = await Promise.all([
      scanWaitlistEvent(s.ctx, s.eventTypeId),
      scanWaitlistEvent(s.ctx, s.eventTypeId),
    ])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2)
    expect(await candidates(s.eventTypeId)).toHaveLength(2)
    expect(
      (
        await testDb.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM waitlist_slot_tombstones WHERE event_type_id=$1',
          [s.eventTypeId],
        )
      ).rows[0]?.n,
    ).toBe(2)
  })

  it('retains mailbox-slot tombstones across removal and rejoin and keeps another event distinct', async () => {
    const s = await setup()
    const first = await entry(s)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    await removeWaitlist(s.ctx, { token: first.token })
    const next = await entry(s, { email: first.email })
    expect(next.id === first.id).toBe(false)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
    const otherId = await f.eventType(s.organizationId, s.userId, { slug: 'other' })
    await testDb.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [otherId])
    await entry({ ...s, eventTypeId: otherId }, { email: first.email })
    expect(await scanWaitlistEvent(s.ctx, otherId)).toBe(1)
    const tombstones = (
      await testDb.pool.query<{ purge_at: Date }>(
        'SELECT purge_at FROM waitlist_slot_tombstones WHERE event_type_id=$1',
        [s.eventTypeId],
      )
    ).rows
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.purge_at.toISOString()).toBe('2026-11-04T08:30:00.000Z')
  })

  it.each([
    [
      'twenty-four elapsed hours',
      '2026-11-03T08:00:00Z',
      '2026-11-03T08:30:00Z',
      undefined,
      0,
      '2026-11-02T12:00:00.000Z',
    ],
    ['entry expiry', START, END, '2026-11-01T18:00:00Z', 0, '2026-11-01T18:00:00.000Z'],
    ['minimum-notice cutoff', START, END, undefined, 60, '2026-11-02T07:00:00.000Z'],
  ])('bounds the candidate deadline by %s', async (_, start, end, expiry, notice, expected) => {
    const s = await setup({ event: { minimumNoticeMinutes: notice } })
    await entry(s, { start, end, expiry })
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    expect((await candidates(s.eventTypeId))[0]?.expires_at.toISOString()).toBe(expected)
  })

  it('discovers cross-organization slots only after a real cancellation commits', async () => {
    const s = await setup()
    const teamId = await f.organization()
    await f.member(s.userId, teamId, 'owner')
    const targetId = await f.eventType(teamId, null, { hosts: [{ userId: s.userId }] })
    await testDb.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [targetId])
    await entry({ ...s, organizationId: teamId, eventTypeId: targetId })
    const booking = await book(s, 'ordinary@example.test')
    expect(await scanWaitlistEvent(s.ctx, targetId)).toBe(0)
    await cancelManagedBooking(s.publicCtx, booking.manageToken ?? undefined)
    const work = (
      await testDb.pool.query<{ dirty_generation: string; scanned_generation: string }>(
        'SELECT dirty_generation,scanned_generation FROM waitlist_scan_work WHERE event_type_id=$1',
        [targetId],
      )
    ).rows[0]
    expect(BigInt(work?.dirty_generation ?? '0') > BigInt(work?.scanned_generation ?? '0')).toBe(
      true,
    )
    expect(await scanWaitlistEvent(s.ctx, targetId)).toBe(1)
    expect(await scanWaitlistEvent(s.ctx, targetId)).toBe(0)
    await expect(
      cancelManagedBooking(s.publicCtx, booking.manageToken ?? undefined),
    ).rejects.toMatchObject({
      code: 'booking_cancelled',
    })
    expect(await scanWaitlistEvent(s.ctx, targetId)).toBe(0)
  })

  it("does not observe a reschedule transaction's temporary gap when the successor still blocks it", async () => {
    const s = await setup({ event: { durationMinutes: 60, slotStepMinutes: 30 } })
    await entry(s, { end: '2026-11-02T10:00:00Z' })
    const booking = await book(s, 'reschedule@example.test')
    await rescheduleManagedBooking(s.publicCtx, booking.manageToken ?? undefined, {
      start: instant('2026-11-02T08:30:00Z'),
    })
    expect(await candidates(s.eventTypeId)).toHaveLength(0)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
  })

  it('finds the exact original slot after a committed reschedule away', async () => {
    const s = await setup()
    await entry(s)
    const booking = await book(s, 'move-away@example.test')
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
    await rescheduleManagedBooking(s.publicCtx, booking.manageToken ?? undefined, {
      start: instant('2026-11-02T09:00:00Z'),
    })
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    expect((await candidates(s.eventTypeId))[0]?.slots).toEqual([
      { start: iso(START), end: iso(END) },
    ])
  })

  it('rolls back the dirty signal with a failed writer transaction', async () => {
    const s = await setup()
    await entry(s)
    const booking = await book(s, 'rollback@example.test')
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
    const generation = async () =>
      (
        await testDb.pool.query<{ dirty_generation: string }>(
          'SELECT dirty_generation FROM waitlist_scan_work WHERE event_type_id=$1',
          [s.eventTypeId],
        )
      ).rows[0]?.dirty_generation
    const before = await generation()
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .updateTable('bookings')
          .set({ status: 'cancelled', cancelled_at: new Date(NOW.epochMilliseconds) })
          .where('id', '=', booking.booking.id)
          .execute()
        throw new Error('simulated writer rollback')
      }),
    ).rejects.toThrow('simulated writer rollback')
    expect(await generation()).toBe(before)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
  })

  it('recovers missing wakeups with a bounded fair scan, including events without a work row', async () => {
    const first = await setup()
    const second = await setup()
    await entry(first)
    await entry(second)
    // A startup/minute recovery must not depend on the original signal or job surviving.
    await testDb.pool.query('DELETE FROM waitlist_scan_work WHERE event_type_id=ANY($1::uuid[])', [
      [first.eventTypeId, second.eventTypeId],
    ])
    // Retire other fixtures so the bounded recovery page has exactly these due events.
    await testDb.pool.query(
      'UPDATE waitlist_scan_work SET next_due_at=$1 WHERE event_type_id<>ALL($2::uuid[])',
      [new Date(NOW.add({ hours: 1 }).epochMilliseconds), [first.eventTypeId, second.eventTypeId]],
    )
    const a = await scanWaitlists(ctx, { limit: 1 })
    const b = await scanWaitlists(ctx, { limit: 1 })
    expect(a).toMatchObject({ events: 1, candidates: 1, errors: 0 })
    expect(b).toMatchObject({ events: 1, candidates: 1, errors: 0 })
    expect(await candidates(first.eventTypeId)).toHaveLength(1)
    expect(await candidates(second.eventTypeId)).toHaveLength(1)
  })

  it('reacts to working-hours edits and cached busy removal without any provider request', async () => {
    const s = await setup({ hours: {} })
    await entry(s)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
    await testDb.pool.query('UPDATE schedules SET weekly_hours=$1 WHERE id=$2', [
      JSON.stringify(weekdays({ start: '09:00', end: '11:00' })),
      s.scheduleId,
    ])
    const busy = await f.calendarBusy(s.userId, [[START, END]])
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(0)
    await testDb.pool.query('DELETE FROM calendar_busy WHERE calendar_id=$1', [busy.calendarId])
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
  })

  it(
    'lets two waitlisted claimers use ordinary booking concurrency; only the winner becomes booked',
    SERIALIZED,
    async () => {
      const s = await setup()
      const first = await entry(s)
      const second = await entry(s)
      expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(2)
      const results = await Promise.allSettled([
        book(s, first.email, { waitlistToken: first.token }),
        book(s, second.email, { waitlistToken: second.token }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      const winner = results[0]?.status === 'fulfilled' ? first : second
      const loser = winner === first ? second : first
      expect(await state(winner.id)).toMatchObject({
        status: 'booked',
        booking_id: expect.any(String),
      })
      expect(await state(loser.id)).toEqual({ status: 'active', booking_id: null })
      expect(
        (
          await testDb.pool.query<{ n: number }>(
            "SELECT count(*)::int n FROM bookings WHERE event_type_id=$1 AND status='confirmed'",
            [s.eventTypeId],
          )
        ).rows[0]?.n,
      ).toBe(1)
    },
  )

  it('allows an ordinary booker to win an advertised slot and leaves losing waitlist eligibility intact', async () => {
    const s = await setup()
    const person = await entry(s)
    expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
    await book(s, 'not-waitlisted@example.test')
    await expect(book(s, person.email, { waitlistToken: person.token })).rejects.toMatchObject({
      kind: 'conflict',
    })
    expect(await state(person.id)).toEqual({ status: 'active', booking_id: null })
  })

  it.each([
    'tokenless',
    'wrong email',
    'unknown token',
    'expired token',
    'pending verification',
    'other event',
    'outside window',
  ] as const)('keeps ordinary booking usable but does not attribute with %s', async (reason) => {
    const s = await setup()
    let target = s
    if (reason === 'other event') {
      const otherId = await f.eventType(s.organizationId, s.userId, { slug: 'other' })
      await testDb.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [otherId])
      target = { ...s, eventTypeId: otherId }
    }
    const person = await entry(target, {
      status: reason === 'pending verification' ? 'pending_verification' : 'active',
      ...(reason === 'outside window'
        ? { start: '2026-11-02T09:00:00Z', end: '2026-11-02T09:30:00Z' }
        : {}),
    })
    if (reason === 'expired token') {
      await testDb.pool.query(
        "UPDATE waitlist_capabilities SET expires_at=$1,created_at=$1::timestamptz-interval '1 hour' WHERE entry_id=$2 AND purpose='management'",
        [new Date(NOW.epochMilliseconds), person.id],
      )
    }
    const token =
      reason === 'tokenless'
        ? undefined
        : reason === 'unknown token'
          ? randomBytes(32).toString('base64url')
          : person.token
    const result = await book(
      s,
      reason === 'wrong email' ? 'different@example.test' : person.email,
      { waitlistToken: token },
    )
    expect(result.replayed).toBe(false)
    expect(await state(person.id)).toEqual({
      status: reason === 'pending verification' ? 'pending_verification' : 'active',
      booking_id: null,
    })
  })

  it('does not attach a later capability on replay, including a different live entry', async () => {
    const s = await setup()
    const person = await entry(s)
    const key = randomUUID()
    const original = await book(s, person.email, { idempotencyKey: key })
    const replay = await book(s, person.email, { idempotencyKey: key, waitlistToken: person.token })
    expect(replay.replayed).toBe(true)
    expect(replay.booking.id).toBe(original.booking.id)
    expect(await state(person.id)).toEqual({ status: 'active', booking_id: null })
  })

  it('rolls booking attribution back when later transactional work fails', async () => {
    const s = await setup()
    const person = await entry(s)
    const failing = {
      ...s.publicCtx,
      notify: async () => {
        throw new Error('simulated outbox failure')
      },
    }
    await expect(book(s, person.email, { waitlistToken: person.token }, failing)).rejects.toThrow(
      'simulated outbox failure',
    )
    expect(await state(person.id)).toEqual({ status: 'active', booking_id: null })
    expect(
      (
        await testDb.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM bookings WHERE event_type_id=$1',
          [s.eventTypeId],
        )
      ).rows[0]?.n,
    ).toBe(0)
    const committed = await book(s, person.email, { waitlistToken: person.token })
    expect(await state(person.id)).toEqual({ status: 'booked', booking_id: committed.booking.id })
    await cancelManagedBooking(s.publicCtx, committed.manageToken ?? undefined)
    expect(await state(person.id)).toEqual({ status: 'booked', booking_id: committed.booking.id })
  })

  it.each([
    {
      zone: 'America/Los_Angeles',
      day: '2027-03-14',
      now: '2027-03-13T12:00:00Z',
      hours: { start: '01:00', end: '04:00' },
      starts: ['2027-03-14T09:00:00Z', '2027-03-14T09:30:00Z', '2027-03-14T10:00:00Z'],
    },
    {
      zone: 'America/Los_Angeles',
      day: '2026-11-01',
      now: '2026-10-31T12:00:00Z',
      hours: { start: '01:00', end: '02:00' },
      starts: ['2026-11-01T08:00:00Z', '2026-11-01T08:30:00Z'],
    },
    {
      zone: 'Europe/Berlin',
      day: '2027-03-28',
      now: '2027-03-27T12:00:00Z',
      hours: { start: '01:00', end: '04:00' },
      starts: ['2027-03-28T00:00:00Z', '2027-03-28T00:30:00Z', '2027-03-28T01:00:00Z'],
    },
    {
      zone: 'Europe/Berlin',
      day: '2026-10-25',
      now: '2026-10-24T12:00:00Z',
      hours: { start: '02:00', end: '03:00' },
      starts: ['2026-10-25T00:00:00Z', '2026-10-25T00:30:00Z'],
    },
  ])(
    'preserves UTC candidate identity through $zone DST on $day',
    async ({ zone, day, now, hours, starts }) => {
      const s = await setup({ timeZone: zone, now: instant(now), hours: { sunday: [hours] } })
      const localStart = Temporal.PlainDate.from(day).toZonedDateTime(zone).toInstant()
      const localEnd = Temporal.PlainDate.from(day)
        .add({ days: 1 })
        .toZonedDateTime(zone)
        .toInstant()
      await entry(s, { start: localStart.toString(), end: localEnd.toString() })
      expect(await scanWaitlistEvent(s.ctx, s.eventTypeId)).toBe(1)
      const rows = await candidates(s.eventTypeId)
      expect(rows[0]?.slots).toEqual(
        starts.map((start) => ({
          start: iso(start),
          end: instant(start).add({ minutes: 30 }).toString({ fractionalSecondDigits: 3 }),
        })),
      )
      const tombstones = (
        await testDb.pool.query<{ start_at: Date; end_at: Date; purge_at: Date }>(
          'SELECT start_at,end_at,purge_at FROM waitlist_slot_tombstones WHERE event_type_id=$1 ORDER BY start_at',
          [s.eventTypeId],
        )
      ).rows
      expect(tombstones.map((r) => r.start_at.toISOString())).toEqual(starts.map(iso))
      expect(
        tombstones.every((r) => r.purge_at.getTime() - r.end_at.getTime() === 48 * 60 * 60 * 1000),
      ).toBe(true)
    },
  )
  type ScanCheck =
    | 'all recipients'
    | 'verification'
    | 'containment'
    | 'three slots'
    | 'dedupe'
    | 'entry deadline'
    | 'notice deadline'
    | '24-hour deadline'

  async function verifyScanProtection(check: ScanCheck, scan = scanWaitlistEvent) {
    const s = await setup({ event: { minimumNoticeMinutes: check === 'notice deadline' ? 60 : 0 } })
    if (check === 'all recipients') {
      await entry(s)
      await entry(s)
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(2)
    } else if (check === 'verification') {
      await entry(s, { status: 'pending_verification' })
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(0)
    } else if (check === 'containment') {
      await entry(s)
      await entry(s, { start: '2026-11-02T08:15:00Z', end: '2026-11-02T08:45:00Z' })
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(1)
    } else if (check === 'three slots') {
      await entry(s, { end: '2026-11-02T10:00:00Z' })
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(1)
      expect((await candidates(s.eventTypeId))[0]?.slots).toHaveLength(3)
    } else if (check === 'dedupe') {
      const person = await entry(s)
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(1)
      await removeWaitlist(s.ctx, { token: person.token })
      await entry(s, { email: person.email })
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(0)
    } else {
      await entry(
        s,
        check === 'entry deadline'
          ? { expiry: '2026-11-01T18:00:00Z' }
          : check === '24-hour deadline'
            ? { start: '2026-11-03T08:00:00Z', end: '2026-11-03T08:30:00Z' }
            : {},
      )
      await expect(scan(s.ctx, s.eventTypeId)).resolves.toBe(1)
      expect((await candidates(s.eventTypeId))[0]?.expires_at.toISOString()).toBe(
        check === 'entry deadline'
          ? '2026-11-01T18:00:00.000Z'
          : check === '24-hour deadline'
            ? '2026-11-02T12:00:00.000Z'
            : '2026-11-02T07:00:00.000Z',
      )
    }
  }

  const scanMutations: { check: ScanCheck; changes: Change[] }[] = [
    {
      check: 'all recipients',
      changes: [['for (const entry of entries) {', 'for (const entry of entries.slice(0, 1)) {']],
    },
    {
      check: 'verification',
      changes: [
        [
          "AND status IN ('active','notified') AND verified_at IS NOT NULL",
          "AND status IN ('pending_verification','active','notified')",
        ],
      ],
    },
    {
      check: 'containment',
      changes: [
        [
          'slotStart < entry.window_start.getTime() || slotEnd > entry.window_end.getTime()',
          'false',
        ],
      ],
    },
    {
      check: 'three slots',
      changes: [['if (selected.length === 3) break', 'if (selected.length === 2) break']],
    },
    { check: 'dedupe', changes: [['if (!inserted.rows.length) continue', '']] },
    {
      check: 'entry deadline',
      changes: [
        ['entry.expires_at.getTime(),', 'Number.POSITIVE_INFINITY,'],
        ['entry.expires_at.getTime(),', 'Number.POSITIVE_INFINITY,'],
      ],
    },
    {
      check: 'notice deadline',
      changes: [
        ['slotStart - event.minimumNoticeMinutes * 60_000,', 'Number.POSITIVE_INFINITY,'],
        [
          "Date.parse(selected[0]?.start ?? '') - event.minimumNoticeMinutes * 60_000,",
          'Number.POSITIVE_INFINITY,',
        ],
      ],
    },
    {
      check: '24-hour deadline',
      changes: [
        ['now.epochMilliseconds + 86_400_000,', 'Number.POSITIVE_INFINITY,'],
        ['now.epochMilliseconds + 86_400_000,', 'Number.POSITIVE_INFINITY,'],
      ],
    },
  ]

  it('passes discovery protections against the unmodified source copy', async () => {
    const copy = sourceCopy('waitlist-discovery')
    for (const { check } of scanMutations) await verifyScanProtection(check, copy.scanWaitlistEvent)
  })

  it.each(scanMutations)(
    'detects source-copy removal of discovery $check',
    async ({ check, changes }) => {
      const copy = sourceCopy('waitlist-discovery', changes)
      await expect(verifyScanProtection(check, copy.scanWaitlistEvent)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  type AttributeCheck =
    | 'email identity'
    | 'event identity'
    | 'window start'
    | 'window end'
    | 'token expiry'
    | 'verification'
  async function verifyAttributeProtection(
    check: AttributeCheck,
    attribute = attributeWaitlistBooking,
  ) {
    const s = await setup()
    let target = s
    if (check === 'event identity') {
      const otherId = await f.eventType(s.organizationId, s.userId, { slug: 'other' })
      await testDb.pool.query('UPDATE event_types SET waitlist_enabled=true WHERE id=$1', [otherId])
      target = { ...s, eventTypeId: otherId }
    }
    const person = await entry(target, {
      status: check === 'verification' ? 'pending_verification' : 'active',
      ...(check === 'window start'
        ? { start: '2026-11-02T08:15:00Z', end: '2026-11-02T08:45:00Z' }
        : {}),
      ...(check === 'window end'
        ? { start: '2026-11-02T07:45:00Z', end: '2026-11-02T08:15:00Z' }
        : {}),
    })
    const email = check === 'email identity' ? 'wrong-recipient@example.test' : person.email
    const booking = await book(s, email)
    if (check === 'token expiry')
      await testDb.pool.query(
        "UPDATE waitlist_capabilities SET expires_at=$1,created_at=$1::timestamptz-interval '1 hour' WHERE entry_id=$2 AND purpose='management'",
        [new Date(NOW.epochMilliseconds), person.id],
      )
    await expect(
      db.transaction().execute((trx) =>
        attribute(trx, {
          secret: SECRET,
          token: person.token,
          eventTypeId: s.eventTypeId,
          bookingId: booking.booking.id,
          email,
          start: instant(START),
          end: instant(END),
          now: () => NOW,
        }),
      ),
    ).resolves.toBeUndefined()
    expect(await state(person.id)).toEqual({
      status: check === 'verification' ? 'pending_verification' : 'active',
      booking_id: null,
    })
  }

  const attributeMutations: { check: AttributeCheck; changes: Change[] }[] = [
    {
      check: 'email identity',
      changes: [[`AND e.email=\${input.email.trim().toLowerCase()}`, '']],
    },
    { check: 'event identity', changes: [[`AND e.event_type_id=\${input.eventTypeId}`, '']] },
    {
      check: 'window start',
      changes: [[`AND e.window_start<=\${new Date(input.start.epochMilliseconds)}`, '']],
    },
    {
      check: 'window end',
      changes: [[`AND e.window_end>=\${new Date(input.end.epochMilliseconds)}`, '']],
    },
    { check: 'token expiry', changes: [[`AND c.expires_at>\${at}`, '']] },
    {
      check: 'verification',
      changes: [
        ["AND e.status IN ('active','notified')", ''],
        ['AND e.verified_at IS NOT NULL', ''],
      ],
    },
  ]

  it('passes attribution protections against the unmodified source copy', async () => {
    const copy = sourceCopy('waitlist-booking')
    for (const { check } of attributeMutations)
      await verifyAttributeProtection(check, copy.attributeWaitlistBooking)
  })

  it.each(attributeMutations)(
    'detects source-copy removal of attribution $check',
    async ({ check, changes }) => {
      const copy = sourceCopy('waitlist-booking', changes)
      await expect(
        verifyAttributeProtection(check, copy.attributeWaitlistBooking),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
  async function bookingSourceCopy(replayMutation = false, keyMutation = false) {
    let source = readFileSync('packages/scheduling/src/bookings.ts', 'utf8')
    if (replayMutation) {
      const before = 'if (replay) return { ...replay, replayed: true }'
      expect(source.includes(before), 'replay mutation must match source').toBe(true)
      source = source.replaceAll(
        before,
        `if (replay) {
        if (ctx.waitlistSecret && input.waitlistToken) await ctx.db.transaction().execute(tr =>
          attributeWaitlistBooking(tr, {secret:ctx.waitlistSecret,token:input.waitlistToken,
            eventTypeId:et.id,bookingId:replay.booking.id,email:input.invitee.email,
            start:input.start,end:input.start.add({minutes:et.durationMinutes}),now:ctx.now}));
        return {...replay,replayed:true}
      }`,
      )
    }
    if (keyMutation) {
      const before =
        'await ensureWaitlistKey(trx, ctx.waitlistSecret, new Date(ctx.now().epochMilliseconds))'
      expect(source.includes(before), 'key fence mutation must match source').toBe(true)
      source = source.replace(before, '')
    }
    const javascript = stripTypeScriptTypes(source).replace(
      /from '([^']+)'/g,
      (_, specifier: string) => `from '${import.meta.resolve(specifier)}'`,
    )
    return (await import(
      `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    )) as typeof import('./bookings.ts')
  }

  async function verifyReplayProtection(create = createPublicBooking) {
    const s = await setup()
    const person = await entry(s)
    const input = {
      handle: s.handle,
      slug: 'intro',
      start: instant(START),
      invitee: { name: 'Invitee', email: person.email, timeZone: 'Europe/Berlin' },
      idempotencyKey: randomUUID(),
    }
    const first = await create(s.publicCtx, input)
    const replay = await create(s.publicCtx, { ...input, waitlistToken: person.token })
    expect(replay.replayed).toBe(true)
    expect(replay.booking.id).toBe(first.booking.id)
    expect(await state(person.id)).toEqual({ status: 'active', booking_id: null })
  }

  it('passes replay attribution protection against an unmodified bookings source copy', async () => {
    await verifyReplayProtection((await bookingSourceCopy()).createPublicBooking)
  })

  it('detects a source-copy mutation attributing a capability supplied only on replay', async () => {
    const copy = await bookingSourceCopy(true)
    await expect(verifyReplayProtection(copy.createPublicBooking)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  async function verifyConferenceGuard(
    scan = scanWaitlistEvent,
    kind: 'zoom' | 'google_meet' = 'zoom',
  ) {
    const s = await setup()
    await entry(s)
    expect(await scan(s.ctx, s.eventTypeId)).toBe(1)
    const before = (
      await testDb.pool.query<{ n: number }>(
        'SELECT count(*)::int n FROM waitlist_slot_tombstones WHERE event_type_id=$1',
        [s.eventTypeId],
      )
    ).rows[0]?.n
    await testDb.pool.query('UPDATE event_types SET location=$1 WHERE id=$2', [
      JSON.stringify({ kind, autoCreate: true }),
      s.eventTypeId,
    ])
    await entry(s)
    const unavailable = { ...s.ctx, automaticZoom: true, automaticMeet: true }
    const expected = {
      code: kind === 'zoom' ? 'automatic_zoom_unavailable' : 'automatic_meet_unavailable',
    }
    await expect(
      availability.listPublicSlots(
        { ...s.publicCtx, automaticZoom: true, automaticMeet: true },
        { handle: s.handle, slug: 'intro', start: instant(START), end: instant(END) },
      ),
    ).rejects.toMatchObject(expected)
    await expect(scan(unavailable, s.eventTypeId)).rejects.toMatchObject(expected)
    expect(
      (
        await testDb.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM waitlist_slot_tombstones WHERE event_type_id=$1',
          [s.eventTypeId],
        )
      ).rows[0]?.n,
    ).toBe(before)
    expect(await candidates(s.eventTypeId)).toHaveLength(1)
    expect(
      (
        await testDb.pool.query<{ open: boolean }>(
          'SELECT is_open AS open FROM waitlist_slots WHERE event_type_id=$1',
          [s.eventTypeId],
        )
      ).rows,
    ).toEqual([{ open: true }])
  }

  it.each(['zoom', 'google_meet'] as const)(
    'preserves candidates, observations and tombstones when ordinary %s availability is unavailable',
    async (kind) => {
      await verifyConferenceGuard(scanWaitlistEvent, kind)
    },
  )

  it('detects a source-copy mutation bypassing cached conference availability guards', async () => {
    const copy = sourceCopy('waitlist-discovery', [
      [
        'await (event.team ? listPublicTeamSlots : listPublicSlots)(',
        'await (async (_ctx, range) => (await findSlots(trx,{eventTypeId,hostUserId:event.hostUserId,rangeStart:range.start,rangeEnd:range.end,now})).map(slot=>({start:toIso(slot.start),end:toIso(slot.end)})))(',
      ],
    ])
    await expect(verifyConferenceGuard(copy.scanWaitlistEvent)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it(
    'bounds SQL round trips for a dense seven-day page whose exact slots are already consumed',
    SERIALIZED,
    async () => {
      const hours = Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
          (day) => [day, [{ start: '00:00', end: '24:00' }]],
        ),
      ) as WeeklyHours
      const s = await setup({
        timeZone: 'UTC',
        hours,
        event: { durationMinutes: 1, slotStepMinutes: 1 },
      })
      for (let i = 0; i < 3; i++) {
        const person = await entry(s, {
          start: '2026-11-02T00:00:00Z',
          end: '2026-11-09T00:00:00Z',
        })
        await testDb.pool.query(
          `INSERT INTO waitlist_slot_tombstones(event_type_id,recipient_hash,start_at,end_at,purge_at)
        SELECT $1,$2,start,start+interval '1 minute',start+interval '1 minute'+interval '48 hours'
        FROM generate_series('2026-11-02T00:00:00Z'::timestamptz,'2026-11-08T23:59:00Z'::timestamptz,interval '1 minute') start`,
          [s.eventTypeId, person.recipient],
        )
      }
      let queries = 0
      const counted = db.withPlugin({
        transformQuery({ node }) {
          queries++
          return node
        },
        async transformResult({ result }) {
          return result
        },
      })
      expect(await scanWaitlistEvent({ ...s.ctx, db: counted }, s.eventTypeId)).toBe(0)
      expect(queries).toBeLessThan(100)
      expect(
        (
          await testDb.pool.query<{ n: number }>(
            'SELECT count(*)::int n FROM waitlist_slots WHERE event_type_id=$1',
            [s.eventTypeId],
          )
        ).rows[0]?.n,
      ).toBe(10080)
      expect(await candidates(s.eventTypeId)).toHaveLength(0)
    },
  )

  async function verifyKeyFenceOrder(create = createPublicBooking) {
    const s = await setup()
    const person = await entry(s)
    const holder = await testDb.pool.connect()
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `booking-host:${s.userId}`,
    ])
    const pending = create(s.publicCtx, {
      handle: s.handle,
      slug: 'intro',
      start: instant(START),
      invitee: { name: 'Invitee', email: person.email, timeZone: 'UTC' },
      waitlistToken: person.token,
    })
    pending.catch(() => {})
    try {
      let waiting = false
      for (let n = 0; n < 500; n++) {
        waiting =
          (
            await testDb.pool.query<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory') AS waiting",
            )
          ).rows[0]?.waiting ?? false
        if (waiting) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiting, 'booking must reach the host lock').toBe(true)
      const probe = await testDb.pool.connect()
      try {
        await probe.query('BEGIN')
        const exclusive = (
          await probe.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_xact_lock(1752658796,1801812326) AS acquired',
          )
        ).rows[0]?.acquired
        expect(exclusive, 'booking must hold shared key fence before waiting for host').toBe(false)
      } finally {
        await probe.query('ROLLBACK')
        probe.release()
      }
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        `booking-host:${s.userId}`,
      ])
      holder.release()
      await pending
    }
  }

  it(
    'takes the accounting-key fence before waiting on the ordinary booking host lock',
    SERIALIZED,
    async () => {
      await verifyKeyFenceOrder()
    },
  )

  it(
    'detects source-copy removal of the accounting-key fence before booking locks',
    SERIALIZED,
    async () => {
      const copy = await bookingSourceCopy(false, true)
      await expect(verifyKeyFenceOrder(copy.createPublicBooking)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )
})
