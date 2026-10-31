import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { EnqueueOptions } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookingNotifier } from '../../notifications/src/index.ts'
import { enqueueScheduledBookingEmails } from '../../notifications/src/scheduled.ts'
import * as bookings from './bookings.ts'
import type { BookingNotifier, PublicContext, ServiceContext } from './context.ts'
import {
  createEventType,
  deleteEventType,
  getEventType,
  getEventTypeNotifications,
  setEventTypeNotifications,
  updateEventType,
} from './event-types.ts'
import {
  createNotificationSnapshot,
  DEFAULT_NOTIFICATIONS,
  type NotificationSettings,
  notificationSnapshot,
} from './notification-settings.ts'
import { cancelTeamAdminBooking } from './team-bookings.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type Fixtures,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T00:00:00Z')
const START = Temporal.Instant.from('2026-11-02T09:00:00Z')
const NEXT = START.add({ hours: 1 })
const recipients = { invitee: true, guests: false, host: true }
const CUSTOM: NotificationSettings = {
  reminders: [
    { id: 'early', offsetMinutes: 180, recipients },
    { id: 'near', offsetMinutes: 120, recipients },
  ],
  followUps: [
    {
      id: 'after',
      offsetMinutes: 60,
      recipients,
      hostNote: '<a href="https://example.test">Host & invitee</a>\n后续资料 😀',
    },
  ],
}
const CHANGED: NotificationSettings = {
  reminders: [{ id: 'other', offsetMinutes: 5, recipients }],
  followUps: [],
}
type BookingModule = Pick<
  typeof bookings,
  | 'createPublicBooking'
  | 'createPublicTeamBooking'
  | 'cancelManagedBooking'
  | 'cancelHostBooking'
  | 'cancelTeamBookingInTransaction'
  | 'rescheduleManagedBooking'
  | 'rescheduleHostBooking'
>
type Replacement = readonly [string, string]
const BOOKING_EXPORTS = [
  'createPublicBooking',
  'createPublicTeamBooking',
  'cancelManagedBooking',
  'cancelHostBooking',
  'cancelTeamBookingInTransaction',
  'rescheduleManagedBooking',
  'rescheduleHostBooking',
]

/** Compile an isolated in-memory copy with its real dependencies and real Postgres writes. */
async function sourceCopy<T>(
  filename: string,
  names: string[],
  replacement: Replacement,
): Promise<T> {
  const moduleUrl = new URL(filename, import.meta.url)
  let source = readFileSync(moduleUrl, 'utf8')
  expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
  source = stripTypeScriptTypes(source.replace(...replacement))
  const dependencies: Record<string, unknown> = {}
  const imports = [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]
  for (const item of imports) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  source = source.replace(/^export\s*\{[\s\S]*?\}\s*from '[^']+'\n/gm, '').replace(/\bexport /g, '')
  return new Function(...Object.keys(dependencies), `${source}; return { ${names.join(',')} }`)(
    ...Object.values(dependencies),
  ) as T
}

describe.skipIf(!serverUrl)('booking notification settings storage', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(policy: NotificationSettings = CUSTOM, team = false) {
    let host = await f.host({ timeZone: 'UTC' })
    if (team) {
      const organizationId = await f.organization()
      await f.member(host.userId, organizationId, 'owner')
      const organization = await db
        .selectFrom('auth.organization')
        .select('slug')
        .where('id', '=', organizationId)
        .executeTakeFirstOrThrow()
      host = { ...host, organizationId, handle: organization.slug }
    }
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(host.organizationId, team ? null : host.userId, {
      slug: 'notifications',
      hosts: [{ userId: host.userId }],
    })
    const service: ServiceContext = {
      db,
      now: () => NOW,
      principal: {
        kind: 'session',
        sessionId: randomUUID(),
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: {
          id: host.organizationId,
          name: 'Notifications',
          slug: host.handle,
          personal: !team,
        },
      },
    }
    await setEventTypeNotifications(service, eventTypeId, policy)
    const input = {
      handle: host.handle,
      slug: 'notifications',
      start: START,
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    }
    return { host, eventTypeId, service, input }
  }

  const publicContext = (notify?: BookingNotifier): PublicContext => ({
    db,
    now: () => NOW,
    notify,
  })

  async function savedSnapshot(id: string) {
    const row = await db
      .selectFrom('bookings')
      .select('notification_snapshot')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return row.notification_snapshot
  }

  /** Minimal transactional dependency: production queue/delivery behavior has its own tests. */
  const seedMessages: BookingNotifier = async (trx, event) => {
    if (event.type === 'cancelled') return
    const booking = await trx
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', event.bookingId)
      .executeTakeFirstOrThrow()
    const snapshot = notificationSnapshot(booking.notification_snapshot)
    if (snapshot.executionMode === 'legacy_default') return
    for (const [kind, rules] of [
      ['reminder', snapshot.notifications.reminders],
      ['follow_up', snapshot.notifications.followUps],
    ] as const) {
      for (const rule of rules) {
        const start = Temporal.Instant.from(booking.start_at.toISOString())
        const end = Temporal.Instant.from(booking.end_at.toISOString())
        const due =
          kind === 'reminder'
            ? start.subtract({ minutes: rule.offsetMinutes })
            : end.add({ minutes: rule.offsetMinutes })
        await trx
          .insertInto('booking_scheduled_messages')
          .values({
            booking_id: booking.id,
            organization_id: booking.organization_id,
            kind,
            rule_id: rule.id,
            anchor_start_at: start.toString(),
            anchor_end_at: end.toString(),
            due_at: due.toString(),
            expires_at: kind === 'reminder' ? start.toString() : due.add({ hours: 24 }).toString(),
            next_attempt_at: due.toString(),
          })
          .execute()
      }
    }
  }

  async function messageRows(bookingId: string) {
    return db
      .selectFrom('booking_scheduled_messages')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('rule_id')
      .execute()
  }

  async function markProcessing(bookingId: string) {
    await db
      .updateTable('booking_scheduled_messages')
      .set({
        state: 'processing',
        claim_token: randomUUID(),
        lease_until: new Date(Date.now() + 60_000),
        attempts: 4,
      })
      .where('booking_id', '=', bookingId)
      .where('kind', '=', 'follow_up')
      .execute()
  }

  async function verifySnapshotAndReplay(module: BookingModule = bookings) {
    const b = await setup()
    let notifications = 0
    const seenBookings = new Set<string>()
    const ctx = publicContext(async (...args) => {
      notifications++
      if (!seenBookings.has(args[1].bookingId)) {
        seenBookings.add(args[1].bookingId)
        await seedMessages(...args)
      }
    })
    const input = { ...b.input, idempotencyKey: randomUUID() }
    const first = await module.createPublicBooking(ctx, input)
    expect(first.replayed).toBe(false)
    expect(await savedSnapshot(first.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
    const before = await messageRows(first.booking.id)
    expect(before).toHaveLength(3)
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: first.booking.id,
        kind: 'reminder',
        message_key: 'early',
        recipient: `host:${b.host.userId}`,
        outcome: 'suppressed',
        suppression_reason: 'instance_hourly_limit',
      })
      .execute()
    await setEventTypeNotifications(b.service, b.eventTypeId, CHANGED)
    const replay = await module.createPublicBooking(ctx, input)
    expect(replay.booking.id).toBe(first.booking.id)
    expect(replay.replayed).toBe(true)
    expect(replay.manageToken).toBeNull()
    expect(notifications).toBe(1)
    expect(await savedSnapshot(first.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
    expect(await messageRows(first.booking.id)).toEqual(before)
    const receipts = await db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', first.booking.id)
      .execute()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.outcome).toBe('suppressed')
    await expect(module.createPublicBooking(ctx, { ...input, start: NEXT })).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    })
    expect(notifications).toBe(1)
    const future = await module.createPublicBooking(ctx, { ...b.input, start: NEXT })
    expect(await savedSnapshot(future.booking.id)).toEqual(createNotificationSnapshot(CHANGED))
  }

  it('persists the locked policy before notification and replays without requeueing after edits or suppression', () =>
    verifySnapshotAndReplay())

  it('stores explicit disabled and exact legacy execution modes without custom message rows', async () => {
    for (const policy of [DEFAULT_NOTIFICATIONS, { reminders: [], followUps: [] }]) {
      const b = await setup(policy)
      const result = await bookings.createPublicBooking(publicContext(seedMessages), b.input)
      expect(await savedSnapshot(result.booking.id)).toEqual(createNotificationSnapshot(policy))
      expect(await messageRows(result.booking.id)).toEqual([])
    }
  })

  async function waitForLock(stop?: () => boolean) {
    for (let i = 0; i < 500; i++) {
      if (stop?.()) return false
      const { rows } = await owned.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'`,
      )
      if ((rows[0]?.count ?? 0) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Expected this throwaway database to have a lock waiter')
  }

  async function waitForEventTypeLock() {
    for (let i = 0; i < 500; i++) {
      const { rows } = await owned.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%event_types%'`,
      )
      if ((rows[0]?.count ?? 0) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Expected reschedule to wait for the locked event-type row')
  }

  async function verifyRescheduleDecisionClock(
    kind: 'host' | 'invitee',
    cutoff: 'minimum-gap' | 'old-start',
    module: BookingModule = bookings,
  ) {
    const b = await setup()
    const notify = bookingNotifier({ enqueue: async () => randomUUID() })
    const created = await module.createPublicBooking(publicContext(notify), b.input)
    const targetDue = NEXT.subtract({ minutes: 180 })
    let decisionNow =
      cutoff === 'minimum-gap'
        ? targetDue.subtract({ minutes: 61 })
        : START.subtract({ minutes: 1 })
    const holder = await owned.pool.connect()
    let pending: Promise<bookings.BookingWithToken> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM event_types WHERE id=$1 FOR UPDATE', [b.eventTypeId])
      pending =
        kind === 'host'
          ? module.rescheduleHostBooking(
              { ...b.service, now: () => decisionNow, notify },
              created.booking.id,
              { start: NEXT },
            )
          : module.rescheduleManagedBooking(
              { db, now: () => decisionNow, notify },
              created.manageToken as string,
              { start: NEXT },
            )
      pending.catch(() => {})
      await waitForEventTypeLock()
      decisionNow = cutoff === 'minimum-gap' ? targetDue.subtract({ minutes: 60 }) : START
      await holder.query('COMMIT')
      if (cutoff === 'old-start') {
        await expect(pending).rejects.toMatchObject({ code: 'booking_in_past' })
        expect(
          await db
            .selectFrom('bookings')
            .select(['id', 'status'])
            .where('organization_id', '=', b.host.organizationId)
            .execute(),
        ).toEqual([{ id: created.booking.id, status: 'confirmed' }])
        expect(await messageRows(created.booking.id)).toHaveLength(3)
      } else {
        const moved = await pending
        expect(await savedSnapshot(moved.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
        const rows = await messageRows(moved.booking.id)
        expect(rows).toHaveLength(3)
        expect(rows.find((row) => row.rule_id === 'early')).toMatchObject({
          state: 'skipped',
          skip_reason: 'minimum_gap',
          attempts: 0,
        })
        expect(rows.find((row) => row.rule_id === 'near')).toMatchObject({
          state: 'pending',
          attempts: 0,
        })
      }
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending?.catch(() => {})
    }
  }

  function staleRescheduleClock(): Replacement {
    const source = readFileSync('packages/scheduling/src/bookings.ts', 'utf8')
    const start = source.indexOf('  const eventType =\n    old.event_type_id')
    const clock = source.indexOf('  // Settings saves can hold the event row', start)
    const end = source.indexOf('  if (!eventType)', clock)
    expect(start).toBeGreaterThan(0)
    expect(clock).toBeGreaterThan(start)
    expect(end).toBeGreaterThan(clock)
    return [
      source.slice(start, end),
      `  const now = ctx.now()\n  assertChangeable(old, now)\n${source.slice(start, clock)}`,
    ]
  }

  for (const kind of ['host', 'invitee'] as const) {
    it.each(['minimum-gap', 'old-start'] as const)(
      `${kind} reschedule samples %s cutoff after waiting for event-type row`,
      (cutoff) => verifyRescheduleDecisionClock(kind, cutoff),
      20_000,
    )
    it.each(['minimum-gap', 'old-start'] as const)(
      `detects stale ${kind} reschedule %s clock with a real assertion failure`,
      async (cutoff) => {
        const copy = await sourceCopy<BookingModule>(
          'bookings.ts',
          BOOKING_EXPORTS,
          staleRescheduleClock(),
        )
        await expect(verifyRescheduleDecisionClock(kind, cutoff, copy)).rejects.toMatchObject({
          name: 'AssertionError',
        })
      },
      20_000,
    )
  }

  async function verifySerializedSaves(set = setEventTypeNotifications) {
    const b = await setup(DEFAULT_NOTIFICATIONS)
    let entered: () => void = () => {}
    let release: () => void = () => {}
    const seen = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let paused = false
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (
          !paused &&
          result.rows.some((row) => row.id === b.eventTypeId && Object.hasOwn(row, 'notifications'))
        ) {
          paused = true
          entered()
          await gate
        }
        return result
      },
    })
    const first = set({ ...b.service, db: observed }, b.eventTypeId, CUSTOM)
    first.catch(() => {})
    let second: Promise<NotificationSettings> | undefined
    let secondFinished = false
    try {
      await seen
      second = set(b.service, b.eventTypeId, CHANGED).finally(() => {
        secondFinished = true
      })
      second.catch(() => {})
      expect(await waitForLock(() => secondFinished)).toBe(true)
      release()
      expect(await first).toEqual(CUSTOM)
      expect(await second).toEqual(CHANGED)
      expect(await getEventTypeNotifications(b.service, b.eventTypeId)).toEqual(CHANGED)
    } finally {
      release()
      await first.catch(() => {})
      await second?.catch(() => {})
    }
  }

  it(
    'serializes complete settings replacements through the event-type write lock',
    () => verifySerializedSaves(),
    20_000,
  )

  it('a booking waiting for a settings save snapshots the complete committed new value', async () => {
    const b = await setup(DEFAULT_NOTIFICATIONS)
    const client = await owned.pool.connect()
    let pending: Promise<bookings.BookingWithToken> | undefined
    try {
      await client.query('BEGIN')
      await client.query('UPDATE event_types SET notifications=$2::jsonb WHERE id=$1', [
        b.eventTypeId,
        JSON.stringify(CUSTOM),
      ])
      pending = bookings.createPublicBooking(publicContext(seedMessages), b.input)
      pending.catch(() => {})
      await waitForLock()
      await client.query('COMMIT')
      const created = await pending
      expect(await savedSnapshot(created.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
      expect(await messageRows(created.booking.id)).toHaveLength(3)
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pending?.catch(() => {})
    }
  }, 20_000)

  it('a settings save waiting for booking commit leaves that booking snapshot unchanged', async () => {
    const b = await setup()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pendingBooking = bookings.createPublicBooking(
      publicContext(async (...args) => {
        await seedMessages(...args)
        entered()
        await gate
      }),
      b.input,
    )
    pendingBooking.catch(() => {})
    let pendingSave: Promise<NotificationSettings> | undefined
    try {
      await seen
      pendingSave = setEventTypeNotifications(b.service, b.eventTypeId, CHANGED)
      pendingSave.catch(() => {})
      await waitForLock()
      release()
      const created = await pendingBooking
      await pendingSave
      expect(await savedSnapshot(created.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
      const future = await bookings.createPublicBooking(publicContext(), {
        ...b.input,
        start: NEXT,
      })
      expect(await savedSnapshot(future.booking.id)).toEqual(createNotificationSnapshot(CHANGED))
    } finally {
      release()
      await pendingBooking.catch(() => {})
      await pendingSave?.catch(() => {})
    }
  }, 20_000)

  async function verifyReschedule(
    kind: 'host' | 'invitee',
    module: BookingModule = bookings,
    legacy = false,
  ) {
    const b = await setup()
    const created = await module.createPublicBooking(publicContext(seedMessages), b.input)
    if (legacy)
      await db
        .updateTable('bookings')
        .set({ notification_snapshot: null })
        .where('id', '=', created.booking.id)
        .execute()
    await markProcessing(created.booking.id)
    await setEventTypeNotifications(b.service, b.eventTypeId, CHANGED)
    const moved =
      kind === 'host'
        ? await module.rescheduleHostBooking(
            { ...b.service, notify: seedMessages },
            created.booking.id,
            { start: NEXT },
          )
        : await module.rescheduleManagedBooking(
            publicContext(seedMessages),
            created.manageToken as string,
            { start: NEXT },
          )
    expect(await savedSnapshot(moved.booking.id)).toEqual(
      createNotificationSnapshot(legacy ? DEFAULT_NOTIFICATIONS : CUSTOM),
    )
    const old = await messageRows(created.booking.id)
    expect(old).toHaveLength(3)
    for (const row of old) {
      expect(row.state).toBe('skipped')
      expect(row.skip_reason).toBe('booking_replaced')
      expect(row.claim_token).toBeNull()
      expect(row.lease_until).toBeNull()
    }
    expect(old.find((row) => row.kind === 'follow_up')?.attempts).toBe(4)
    const next = await messageRows(moved.booking.id)
    expect(next).toHaveLength(legacy ? 0 : 3)
    for (const row of next) {
      expect(row.booking_id).toBe(moved.booking.id)
      expect(row.anchor_start_at.toISOString()).toBe('2026-11-02T10:00:00.000Z')
      expect(row.anchor_end_at.toISOString()).toBe('2026-11-02T10:30:00.000Z')
      expect(row.state).toBe('pending')
      expect(row.attempts).toBe(0)
      expect(old.some((prior) => prior.id === row.id)).toBe(false)
    }
  }

  it.each(['host', 'invitee'] as const)(
    '%s reschedule inherits its snapshot, recomputes successor messages and fences predecessor claims',
    (kind) => verifyReschedule(kind),
  )

  it.each(['host', 'invitee'] as const)(
    '%s reschedule materializes the immutable default of a legacy null snapshot',
    (kind) => verifyReschedule(kind, bookings, true),
  )

  async function verifyActualDuration(
    kind: 'host' | 'invitee',
    module: BookingModule = bookings,
    enqueue = enqueueScheduledBookingEmails,
  ) {
    const b = await setup()
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 30, allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', b.eventTypeId)
      .execute()
    const queued = new Map<string, string | undefined>()
    const queue = {
      enqueue: async (_name: string, payload: object, options?: EnqueueOptions) => {
        if ('messageId' in payload)
          queued.set(payload.messageId as string, options?.startAfter?.toString())
        return randomUUID()
      },
    }
    const notify: BookingNotifier =
      enqueue === enqueueScheduledBookingEmails
        ? bookingNotifier(queue)
        : async (trx, event, now) => {
            if (event.type !== 'cancelled') await enqueue(queue, trx, event.bookingId, now)
          }
    const context = publicContext(notify)
    const assertMessages = async (bookingId: string, start: string, end: string) => {
      expect(await savedSnapshot(bookingId)).toEqual(createNotificationSnapshot(CUSTOM))
      const rows = await messageRows(bookingId)
      expect(rows).toHaveLength(3)
      for (const row of rows) {
        const rule = [...CUSTOM.reminders, ...CUSTOM.followUps].find(
          (candidate) => candidate.id === row.rule_id,
        )
        if (!rule) throw new Error('Unknown notification rule')
        const due =
          row.kind === 'reminder'
            ? Temporal.Instant.from(start).subtract({ minutes: rule.offsetMinutes })
            : Temporal.Instant.from(end).add({ minutes: rule.offsetMinutes })
        expect(row.anchor_start_at.toISOString()).toBe(start)
        expect(row.anchor_end_at.toISOString()).toBe(end)
        expect(row.due_at.getTime()).toBe(due.epochMilliseconds)
        expect(row.next_attempt_at.getTime()).toBe(due.epochMilliseconds)
        expect(row.expires_at.getTime()).toBe(
          row.kind === 'reminder'
            ? Temporal.Instant.from(start).epochMilliseconds
            : due.add({ hours: 24 }).epochMilliseconds,
        )
        expect(row.state).toBe('pending')
        expect(queued.get(row.id)).toBe(due.toString())
      }
    }
    const created = await module.createPublicBooking(context, { ...b.input, durationMinutes: 60 })
    await assertMessages(created.booking.id, '2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z')
    // Neither a changed default/list nor a new mail policy rewrites an existing booking.
    await updateEventType(b.service, b.eventTypeId, {
      durationMinutes: 15,
      allowedDurationsMinutes: [15, 30],
    })
    await setEventTypeNotifications(b.service, b.eventTypeId, CHANGED)
    const move = async (
      previous: bookings.BookingWithToken,
      start: string,
      durationMinutes?: number,
    ) => {
      const pending =
        kind === 'host'
          ? module.rescheduleHostBooking({ ...b.service, notify }, previous.booking.id, {
              start: Temporal.Instant.from(start),
              durationMinutes,
            })
          : module.rescheduleManagedBooking(context, previous.manageToken as string, {
              start: Temporal.Instant.from(start),
              durationMinutes,
            })
      await expect(pending).resolves.toHaveProperty('booking.id')
      return pending
    }
    const preserved = await move(created, '2026-11-02T11:00:00Z')
    await assertMessages(
      preserved.booking.id,
      '2026-11-02T11:00:00.000Z',
      '2026-11-02T12:00:00.000Z',
    )
    const replaced = await move(preserved, '2026-11-02T13:00:00Z', 15)
    await assertMessages(
      replaced.booking.id,
      '2026-11-02T13:00:00.000Z',
      '2026-11-02T13:15:00.000Z',
    )
    for (const previous of [created, preserved]) {
      const rows = await messageRows(previous.booking.id)
      expect(rows).toHaveLength(3)
      expect(
        rows.every((row) => row.state === 'skipped' && row.skip_reason === 'booking_replaced'),
      ).toBe(true)
    }
    expect(queued.size).toBe(9)
  }

  it.each(['host', 'invitee'] as const)(
    '%s reschedule recomputes real notifier offsets from the actual non-default booking duration',
    (kind) => verifyActualDuration(kind),
  )

  it('detects follow-ups anchored to the event default with a real assertion failure', async () => {
    const copy = await sourceCopy<{
      enqueueScheduledBookingEmails: typeof enqueueScheduledBookingEmails
    }>(
      '../../notifications/src/scheduled.ts',
      ['enqueueScheduledBookingEmails'],
      [
        'instant(booking.end_at).add({ minutes: rule.offsetMinutes })',
        'instant(booking.start_at).add({ minutes: 30 + rule.offsetMinutes })',
      ],
    )
    await expect(
      verifyActualDuration('invitee', bookings, copy.enqueueScheduledBookingEmails),
    ).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it.each<Replacement>([
    ['end_at: b.end.toString(),', 'end_at: b.start.add({ minutes: 30 }).toString(),'],
    [
      "toInstant(old.end_at).since(toInstant(old.start_at)).total({ unit: 'minutes' })",
      'eventType.duration_minutes',
    ],
  ])(
    'detects default duration substitution in %s with a real assertion failure',
    async (from, to) => {
      const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [from, to])
      await expect(verifyActualDuration('host', copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  async function verifyCancel(
    kind: 'host' | 'invitee' | 'team-helper' | 'team-admin',
    module: BookingModule = bookings,
  ) {
    const isTeam = kind === 'team-helper' || kind === 'team-admin'
    const b = await setup(CUSTOM, isTeam)
    const created = await (isTeam ? module.createPublicTeamBooking : module.createPublicBooking)(
      publicContext(seedMessages),
      b.input,
    )
    await markProcessing(created.booking.id)
    await db
      .updateTable('booking_scheduled_messages')
      .set({ state: 'completed' })
      .where('booking_id', '=', created.booking.id)
      .where('rule_id', '=', 'early')
      .execute()
    const completed = (await messageRows(created.booking.id)).find((row) => row.rule_id === 'early')
    let cancelledNotifications = 0
    const notify: BookingNotifier = async (_trx, event) => {
      expect(event).toEqual({ type: 'cancelled', bookingId: created.booking.id })
      cancelledNotifications++
    }
    if (kind === 'host')
      await module.cancelHostBooking({ ...b.service, notify }, created.booking.id)
    else if (kind === 'invitee')
      await module.cancelManagedBooking(publicContext(notify), created.manageToken as string)
    else
      await db.transaction().execute(async (trx) => {
        const actor = { userId: b.host.userId, organizationId: b.host.organizationId }
        if (kind === 'team-helper')
          await module.cancelTeamBookingInTransaction(trx, actor, created.booking.id, () => NOW, {
            notify,
          })
        else
          await cancelTeamAdminBooking(trx, actor, created.booking.id, () => NOW, {
            expectedOrganizationId: actor.organizationId,
            notify,
          })
      })
    expect(cancelledNotifications).toBe(1)
    const current = await messageRows(created.booking.id)
    expect(current.find((row) => row.rule_id === 'early')).toEqual(completed)
    for (const row of current.filter((row) => row.rule_id !== 'early')) {
      expect(row.state).toBe('skipped')
      expect(row.skip_reason).toBe('booking_cancelled')
      expect(row.claim_token).toBeNull()
      expect(row.lease_until).toBeNull()
    }
    expect(current.find((row) => row.kind === 'follow_up')?.attempts).toBe(4)
    await expect(
      module.cancelManagedBooking(publicContext(notify), created.manageToken as string),
    ).rejects.toMatchObject({ code: 'booking_cancelled' })
    expect(cancelledNotifications).toBe(1)
  }

  it.each(['host', 'invitee', 'team-helper', 'team-admin'] as const)(
    '%s cancellation skips pending and claimed work and preserves terminal records',
    (kind) => verifyCancel(kind),
  )

  it('rolls back booking, snapshot and message rows together when initial enqueue fails', async () => {
    const b = await setup()
    const failure = new Error('synthetic enqueue failure')
    const context = publicContext(async (...args) => {
      await seedMessages(...args)
      const snapshot = await args[0]
        .selectFrom('bookings')
        .select('notification_snapshot')
        .where('id', '=', args[1].bookingId)
        .executeTakeFirstOrThrow()
      expect(snapshot.notification_snapshot).toEqual(createNotificationSnapshot(CUSTOM))
      throw failure
    })
    await expect(bookings.createPublicBooking(context, b.input)).rejects.toBe(failure)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', b.host.organizationId)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('booking_scheduled_messages')
        .select('id')
        .where('organization_id', '=', b.host.organizationId)
        .execute(),
    ).toEqual([])
  })

  it.each(['host', 'invitee'] as const)(
    'rolls back %s reschedule snapshot and fenced claims when notification enqueue fails',
    async (kind) => {
      const b = await setup()
      const created = await bookings.createPublicBooking(publicContext(seedMessages), b.input)
      await markProcessing(created.booking.id)
      const before = await messageRows(created.booking.id)
      const failure = new Error('synthetic enqueue failure')
      const notify: BookingNotifier = async (...args) => {
        await seedMessages(...args)
        throw failure
      }
      const attempt =
        kind === 'host'
          ? bookings.rescheduleHostBooking({ ...b.service, notify }, created.booking.id, {
              start: NEXT,
            })
          : bookings.rescheduleManagedBooking(
              publicContext(notify),
              created.manageToken as string,
              { start: NEXT },
            )
      await expect(attempt).rejects.toBe(failure)
      expect(await messageRows(created.booking.id)).toEqual(before)
      expect(await savedSnapshot(created.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
      const rows = await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', b.host.organizationId)
        .execute()
      expect(rows).toEqual([{ id: created.booking.id, status: 'confirmed' }])
    },
  )

  it('rolls back cancellation and claim fencing when cancellation notification enqueue fails', async () => {
    const b = await setup()
    const created = await bookings.createPublicBooking(publicContext(seedMessages), b.input)
    await markProcessing(created.booking.id)
    const before = await messageRows(created.booking.id)
    const failure = new Error('synthetic enqueue failure')
    await expect(
      bookings.cancelManagedBooking(
        publicContext(async () => {
          throw failure
        }),
        created.manageToken as string,
      ),
    ).rejects.toBe(failure)
    expect(await messageRows(created.booking.id)).toEqual(before)
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', created.booking.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
  })

  it('saving the same canonical value is a no-op and edits/deactivation do not rewrite old snapshots or rows', async () => {
    const b = await setup()
    const created = await bookings.createPublicBooking(publicContext(seedMessages), b.input)
    const before = await messageRows(created.booking.id)
    const updated = async () =>
      (
        await sql<{
          time: string
        }>`SELECT updated_at::text AS time FROM event_types WHERE id=${b.eventTypeId}::uuid`.execute(
          db,
        )
      ).rows[0]?.time
    const timestamp = await updated()
    const reordered = { ...CUSTOM, reminders: [...CUSTOM.reminders].reverse() }
    expect(await setEventTypeNotifications(b.service, b.eventTypeId, reordered)).toEqual(CUSTOM)
    expect(await updated()).toBe(timestamp)
    await setEventTypeNotifications(b.service, b.eventTypeId, CHANGED)
    await updateEventType(b.service, b.eventTypeId, { isActive: false })
    await deleteEventType(b.service, b.eventTypeId)
    expect(await savedSnapshot(created.booking.id)).toEqual(createNotificationSnapshot(CUSTOM))
    expect(await messageRows(created.booking.id)).toEqual(before)
  })

  type ConfigurationServices = Pick<
    typeof import('./event-types.ts'),
    'createEventType' | 'updateEventType' | 'setEventTypeNotifications'
  >
  async function verifyConfigurationWrites(
    services: ConfigurationServices = {
      createEventType,
      updateEventType,
      setEventTypeNotifications,
    },
  ) {
    const owner = await createTestUser(db, 'Settings owner')
    const context = testContext(db, owner.principal, () => NOW)
    const disabled = { ...context, followUpHostNotesEnabled: false }
    const input = { slug: 'write-policy', title: 'Write policy', durationMinutes: 30 }
    const initial = await services.createEventType(context, input)
    expect(initial.notifications).toEqual(DEFAULT_NOTIFICATIONS)
    expect((await getEventType(context, initial.id)).notifications).toEqual(DEFAULT_NOTIFICATIONS)
    const custom = await services.createEventType(context, {
      ...input,
      slug: 'custom-policy',
      notifications: CUSTOM,
    })
    expect(custom.notifications).toEqual(CUSTOM)
    const updatedTime = async () =>
      (
        await sql<{
          time: string
        }>`SELECT updated_at::text AS time FROM event_types WHERE id=${custom.id}::uuid`.execute(db)
      ).rows[0]?.time
    const beforeNoop = await updatedTime()
    expect(await services.updateEventType(context, custom.id, { notifications: CUSTOM })).toEqual(
      custom,
    )
    expect(await updatedTime()).toBe(beforeNoop)
    expect(
      (await services.updateEventType(disabled, custom.id, { title: 'Untouched notes' }))
        .notifications,
    ).toEqual(CUSTOM)
    expect(
      (await services.updateEventType(context, initial.id, { notifications: CUSTOM }))
        .notifications,
    ).toEqual(CUSTOM)
    for (const hostNote of ['Explicit host note', '']) {
      const notifications = {
        reminders: [],
        followUps: [{ id: 'after', offsetMinutes: 60, recipients, hostNote }],
      }
      await expect(
        services.createEventType(disabled, {
          ...input,
          slug: `disabled-${hostNote ? 'text' : 'empty'}`,
          notifications,
        }),
      ).rejects.toMatchObject({ code: 'invalid_notifications' })
      await expect(
        services.updateEventType(disabled, initial.id, { notifications }),
      ).rejects.toMatchObject({ code: 'invalid_notifications' })
      await expect(
        services.setEventTypeNotifications(disabled, initial.id, notifications),
      ).rejects.toMatchObject({ code: 'invalid_notifications' })
    }
    expect(
      (await services.updateEventType(disabled, initial.id, { notifications: CHANGED }))
        .notifications,
    ).toEqual(CHANGED)
    expect(
      await services.setEventTypeNotifications(disabled, initial.id, DEFAULT_NOTIFICATIONS),
    ).toEqual(DEFAULT_NOTIFICATIONS)
  }
  it('writes settings through create, update and narrow replacement, preserving omitted policies and enforcing the operator switch', () =>
    verifyConfigurationWrites())
  it.each<Replacement>([
    ['notificationsChanged ||', 'notifications !== undefined ||'],
    [
      'const notifications = validateNotifications(value, ctx)',
      'const notifications = validateNotifications(value)',
    ],
    [
      'input.notifications === undefined ? undefined : validateNotifications(input.notifications, ctx)',
      'input.notifications === undefined ? undefined : validateNotifications(input.notifications)',
    ],
    [
      'const changes = defined(input)\n  const notifications =\n    input.notifications === undefined ? undefined : validateNotifications(input.notifications, ctx)',
      'const changes = defined(input)\n  const notifications =\n    input.notifications === undefined ? undefined : validateNotifications(input.notifications)',
    ],
  ])(
    'detects removing operator policy from a write path with a real assertion failure',
    async (from, to) => {
      const copy = await sourceCopy<ConfigurationServices>(
        'event-types.ts',
        ['createEventType', 'updateEventType', 'setEventTypeNotifications'],
        [from, to],
      )
      await expect(verifyConfigurationWrites(copy)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  async function verifyHistoricalNotes(module: BookingModule = bookings) {
    const b = await setup()
    const legacy = {
      ...CUSTOM,
      followUps: CUSTOM.followUps.map((rule) => ({
        ...rule,
        hostNote: 'Original\ttext\r\nStored\runchanged',
      })),
    }
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify(legacy) })
      .where('id', '=', b.eventTypeId)
      .execute()
    expect((await getEventType(b.service, b.eventTypeId)).notifications).toEqual(legacy)
    expect(await getEventTypeNotifications(b.service, b.eventTypeId)).toEqual(legacy)
    expect(
      (
        await updateEventType({ ...b.service, followUpHostNotesEnabled: false }, b.eventTypeId, {
          title: 'Preserve historical note',
        })
      ).notifications,
    ).toEqual(legacy)
    const created = await module.createPublicBooking(publicContext(), b.input)
    expect(await savedSnapshot(created.booking.id)).toEqual(createNotificationSnapshot(legacy))
    const moved = await module.rescheduleManagedBooking(
      publicContext(),
      created.manageToken as string,
      { start: NEXT },
    )
    expect(await savedSnapshot(moved.booking.id)).toEqual(createNotificationSnapshot(legacy))
  }
  it('preserves historical tab and CRLF host notes on reads, unrelated updates, booking snapshots and reschedules', () =>
    verifyHistoricalNotes())

  async function verifyAccess(get = getEventTypeNotifications, set = setEventTypeNotifications) {
    const owner = await createTestUser(db, 'Owner')
    const admin = await createTestUser(db, 'Admin')
    const member = await createTestUser(db, 'Member')
    const outsider = await createTestUser(db, 'Outsider')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const teamContext = (user: typeof owner) => testContext(db, team.as(user), () => NOW)
    const personalContext = (user: typeof owner) => testContext(db, user.principal, () => NOW)
    const teamEvent = await createEventType(teamContext(owner), {
      slug: 'settings',
      title: 'Settings',
      durationMinutes: 30,
    })
    const personalEvent = await createEventType(personalContext(owner), {
      slug: 'settings',
      title: 'Settings',
      durationMinutes: 30,
    })
    expect(await get(personalContext(owner), personalEvent.id)).toEqual(DEFAULT_NOTIFICATIONS)
    expect(await get(teamContext(member), teamEvent.id)).toEqual(DEFAULT_NOTIFICATIONS)
    expect(await set(teamContext(admin), teamEvent.id, CUSTOM)).toEqual(CUSTOM)
    await expect(set(teamContext(member), teamEvent.id, CHANGED)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
    for (const [context, id] of [
      [personalContext(outsider), personalEvent.id],
      [personalContext(owner), teamEvent.id],
      [teamContext(owner), personalEvent.id],
    ] as const) {
      await expect(get(context, id)).rejects.toMatchObject({
        code: 'event_type_not_found',
      })
      await expect(set(context, id, CUSTOM)).rejects.toMatchObject({
        code: 'event_type_not_found',
      })
    }
    let authorizationCalls = 0
    await expect(
      set(
        {
          ...teamContext(owner),
          authorizeOrganizationWrite: async (_trx, organizationId, targetId) => {
            expect(organizationId).toBe(team.id)
            expect(targetId).toBe(teamEvent.id)
            authorizationCalls++
            throw new Error('synthetic context changed')
          },
        },
        teamEvent.id,
        CHANGED,
      ),
    ).rejects.toThrow('synthetic context changed')
    expect(authorizationCalls).toBe(1)
    expect(await get(teamContext(owner), teamEvent.id)).toEqual(CUSTOM)
  }

  it('keeps personal, team roles and organization boundaries for settings reads and writes', () =>
    verifyAccess())

  it('detects removal of root snapshot persistence with a real assertion failure', async () => {
    const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [
      'notification_snapshot: JSON.stringify(b.notificationSnapshot),',
      'notification_snapshot: null,',
    ])
    await expect(verifySnapshotAndReplay(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each<[string, Replacement]>([
    ['settings write permission', ['await assertCanWrite(trx, ctx, row, true)', '']],
    [
      'settings organization boundary',
      [
        ".where('id', '=', id)\n    .where('organization_id', '=', ctx.principal.organization.id)",
        ".where('id', '=', id)",
      ],
    ],
    [
      'bound organization write authorization',
      ['await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)', ''],
    ],
  ])('detects removal of %s with a real assertion failure', async (_, replacement) => {
    const copy = await sourceCopy<{
      getEventTypeNotifications: typeof getEventTypeNotifications
      setEventTypeNotifications: typeof setEventTypeNotifications
    }>('event-types.ts', ['getEventTypeNotifications', 'setEventTypeNotifications'], replacement)
    await expect(
      verifyAccess(copy.getEventTypeNotifications, copy.setEventTypeNotifications),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects requeueing an idempotent replay with a real assertion failure', async () => {
    const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [
      'if (replay) return { ...replay, replayed: true }',
      "if (replay) { await ctx.notify?.(ctx.db, { type: 'created', bookingId: replay.booking.id, start: input.start }, ctx.now()); return { ...replay, replayed: true } }",
    ])
    await expect(verifySnapshotAndReplay(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it('detects removal of settings save serialization with a real assertion failure', async () => {
    const copy = await sourceCopy<{ setEventTypeNotifications: typeof setEventTypeNotifications }>(
      'event-types.ts',
      ['setEventTypeNotifications'],
      [
        'const row = await visibleRow(trx, ctx, id, { lock: true })',
        'const row = await visibleRow(trx, ctx, id)',
      ],
    )
    await expect(verifySerializedSaves(copy.setEventTypeNotifications)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }, 20_000)

  it.each(['host', 'invitee'] as const)(
    'detects removal of %s reschedule inheritance with a real assertion failure',
    async (kind) => {
      const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [
        'notificationSnapshot: notificationSnapshot(old.notification_snapshot),',
        'notificationSnapshot: createNotificationSnapshot((await trx.selectFrom("event_types").select("notifications").where("id", "=", eventType.id).executeTakeFirstOrThrow()).notifications),',
      ])
      await expect(verifyReschedule(kind, copy)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(['host', 'invitee', 'team-helper'] as const)(
    'detects removal of %s cancellation fencing with a real assertion failure',
    async (kind) => {
      const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [
        "await skipScheduledMessages(db, row.id, 'booking_cancelled')",
        '',
      ])
      await expect(verifyCancel(kind, copy)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(['host', 'invitee'] as const)(
    'detects removal of %s predecessor fencing with a real assertion failure',
    async (kind) => {
      const copy = await sourceCopy<BookingModule>('bookings.ts', BOOKING_EXPORTS, [
        "await skipScheduledMessages(trx, old.id, 'booking_replaced')",
        '',
      ])
      await expect(verifyReschedule(kind, copy)).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
