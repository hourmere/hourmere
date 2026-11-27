import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { removeTeamMember } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
} from '@hourmere/notifications'
import {
  type BookingNotifier,
  cancelManagedBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TEAM_BOOKING_BULK_JOB,
  TEAM_BOOKING_BULK_RECOVERY_JOB,
  teamBookingBulkCancellationJobs,
} from './team-booking-bulk-jobs.ts'
import {
  type EnqueueBulkCancellation,
  recoverTeamBookingBulkCancellations,
  runTeamBookingBulkCancellation,
} from './team-booking-bulk-worker.ts'

const bootstrap = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2030-11-04T08:00:00Z')
const baseStart = Temporal.Instant.from('2030-11-04T09:00:00Z')
const wallTime = sql<Date>`clock_timestamp()`

describe.skipIf(!bootstrap)('team booking bulk cancellation worker', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createBookingJobs>
  let notify: BookingNotifier
  const sent: string[] = []

  const mail = () =>
    bookingNotificationJob({
      db,
      secret: 'synthetic-bulk-worker-notification-secret',
      publicUrl: 'https://hourmere.example',
      now,
      mailMaxPerHour: 0,
      mailRecipientMaxPerHour: 100,
      mailer: {
        senderEmail: 'calendar@example.test',
        async send(message) {
          sent.push(message.to)
        },
      },
      log: () => {},
    })

  function createBookingJobs() {
    return createJobs({
      connectionString: owned.url,
      definitions: [mail()],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
  }

  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'bulk_worker' })
    owned.pool.options.max = 6
    db = createDb(owned.pool)
    jobs = createBookingJobs()
    await jobs.start()
    notify = bookingNotifier(jobs)
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function session(team: TestTeam, user: TestUser) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: `synthetic-${randomUUID()}`,
        activeOrganizationId: team.id,
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
        updatedAt: wallTime,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { ...team.as(user), kind: 'session' as const, sessionId: id }
  }

  async function fixture() {
    const owner = await createTestUser(db, 'Team owner')
    const admin = await createTestUser(db, 'Submitting administrator')
    const host = await createTestUser(db, 'Required host')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: host, role: 'member' },
    ])
    const principal = await session(team, admin)
    const fixtures = createFixtures(db)
    await fixtures.schedule(host.id, { timeZone: 'UTC' })
    const eventId = await fixtures.eventType(team.id, null, { hosts: [{ userId: host.id }] })

    async function booking(hour = 0, requiredHost = host) {
      const start = baseStart.add({ hours: hour })
      const token = randomBytes(32).toString('base64url')
      return db.transaction().execute(async (trx) => {
        const { id } = await trx
          .insertInto('bookings')
          .values({
            organization_id: team.id,
            event_type_id: eventId,
            start_at: start.toString(),
            end_at: start.add({ minutes: 30 }).toString(),
            title: 'Team booking',
            source: 'web',
            required_host_user_ids: [requiredHost.id],
            manage_token_hash: createHash('sha256').update(token).digest(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('booking_hosts')
          .values({ booking_id: id, user_id: requiredHost.id })
          .execute()
        await trx
          .insertInto('booking_attendees')
          .values({
            booking_id: id,
            name: 'Invitee',
            email: 'invitee@example.com',
            time_zone: 'UTC',
            is_booker: true,
          })
          .execute()
        return { id, token }
      })
    }

    async function admit(bookingIds: string[], pauseAfterFirst = false) {
      const id = randomUUID()
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('team_booking_bulk_cancellations')
          .values({
            id,
            organization_id: team.id,
            actor_user_id: admin.id,
            session_id: principal.sessionId,
            expires_at: sql<Date>`clock_timestamp() + interval '9 minutes'`,
          })
          .execute()
        await trx
          .updateTable('team_booking_bulk_cancellations')
          .set({ state: 'queued', admitted_at: wallTime })
          .where('id', '=', id)
          .execute()
        await trx
          .insertInto('team_booking_bulk_cancellation_items')
          .values(
            bookingIds.map((bookingId, index) => ({
              batch_id: id,
              ordinal: index + 1,
              booking_id: bookingId,
              preview_outcome: 'eligible',
              outcome: 'pending',
              next_attempt_at:
                pauseAfterFirst && index > 0
                  ? sql<Date>`clock_timestamp() + interval '3 minutes'`
                  : wallTime,
            })),
          )
          .execute()
      })
      return id
    }

    return { owner, admin, host, team, principal, booking, admit }
  }

  const run = (batchId: string, notifier = notify) =>
    runTeamBookingBulkCancellation(db, batchId, { notify: notifier })

  function pauseClaimedWorker(batchId: string, notifier = notify) {
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let paused = false
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        // The advisory slot is acquired after the claim commits and before any row locks.
        if (!paused && result.rows[0]?.acquired === true) {
          paused = true
          ready.resolve()
          await release.promise
        }
        return result
      },
    })
    const worker = runTeamBookingBulkCancellation(observed, batchId, { notify: notifier })
    return {
      worker,
      wait: () =>
        Promise.race([
          ready.promise,
          worker.then(() => expect.fail('Worker exited before acquiring the item slot')),
        ]),
      release: release.resolve,
    }
  }

  const itemRows = (batchId: string) =>
    db
      .selectFrom('team_booking_bulk_cancellation_items')
      .select([
        'booking_id',
        'outcome',
        'attempt_count',
        'claim_token',
        'claim_expires_at',
        'next_attempt_at',
      ])
      .where('batch_id', '=', batchId)
      .orderBy('ordinal')
      .execute()

  const batch = (batchId: string) =>
    db
      .selectFrom('team_booking_bulk_cancellations')
      .select(['state', 'completed_at'])
      .where('id', '=', batchId)
      .executeTakeFirstOrThrow()

  const bookingState = (id: string) =>
    db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()

  const audit = (organizationId: string, action: string) =>
    db
      .selectFrom('audit_events')
      .select([
        'actor_id',
        'actor_type',
        'credential_id',
        'credential_type',
        'details',
        'request_id',
        'target_id',
      ])
      .where('organization_id', '=', organizationId)
      .where('action', '=', action)
      .execute()

  const queuedNotifications = async (...bookingIds: string[]) =>
    (
      await owned.pool.query<{ id: string; data: unknown }>(
        `SELECT id, data FROM pgboss.job
         WHERE name = $1 AND data->>'bookingId' = ANY($2::text[])
         ORDER BY data->>'bookingId', data->>'kind'`,
        [BOOKING_NOTIFICATION_JOB, bookingIds],
      )
    ).rows

  async function makePendingDue(batchId: string) {
    await db
      .updateTable('team_booking_bulk_cancellation_items')
      .set({ next_attempt_at: wallTime })
      .where('batch_id', '=', batchId)
      .where('outcome', '=', 'pending')
      .execute()
  }

  async function waitForLock(blocker: number, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const { rows } = await sql<{ blocked: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_locks AS lock
        WHERE lock.locktype = 'tuple' AND lock.relation IN (
          'auth.organization'::regclass, 'bookings'::regclass
        ) AND ${blocker} = ANY(pg_blocking_pids(lock.pid))
      ) AS blocked`.execute(db)
      if (rows[0]?.blocked) return
      await setTimeout(10, undefined, { signal })
    }
  }

  it.for(['cancel', 'reschedule'] as const)(
    'keeps only the ordinary %s when it holds the target locks first',
    async (action, { signal }) => {
      const f = await fixture()
      const { id, token } = await f.booking()
      const batchId = await f.admit([id])
      const holding = Promise.withResolvers<number>()
      const release = Promise.withResolvers<void>()
      const pause: BookingNotifier = async (trx, event, instant) => {
        await notify(trx, event, instant)
        const { pid } = await trx
          .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
          .executeTakeFirstOrThrow()
        holding.resolve(pid)
        await release.promise
      }
      const context = { db, now, notify: pause }
      const ordinary =
        action === 'cancel'
          ? cancelManagedBooking(context, token)
          : rescheduleManagedBooking(context, token, { start: baseStart.add({ hours: 1 }) })
      const pid = ordinary.then(() => {
        throw new Error('Ordinary operation completed before its notification checkpoint')
      })
      const probe = new AbortController()
      let bulk: ReturnType<typeof run> | undefined
      try {
        const blocker = await Promise.race([holding.promise, pid])
        bulk = run(batchId)
        await Promise.race([
          waitForLock(blocker, AbortSignal.any([probe.signal, signal])),
          bulk.then(() => expect.fail('Bulk worker did not wait on the ordinary operation')),
        ])
      } finally {
        probe.abort()
        release.resolve()
        await Promise.allSettled([ordinary, bulk])
      }
      const result = await ordinary
      await bulk

      expect(await itemRows(batchId)).toMatchObject([
        { booking_id: id, outcome: 'already_cancelled' },
      ])
      expect(await bookingState(id)).toEqual({ status: 'cancelled' })
      if ('booking' in result) {
        expect(result.booking.id).not.toBe(id)
        expect(await bookingState(result.booking.id)).toEqual({ status: 'confirmed' })
        expect((await queuedNotifications(id, result.booking.id)).map(({ data }) => data)).toEqual([
          { bookingId: result.booking.id, kind: 'rescheduled' },
        ])
      } else {
        expect((await queuedNotifications(id)).map(({ data }) => data)).toEqual([
          { bookingId: id, kind: 'cancelled' },
        ])
      }
      expect(await batch(batchId)).toMatchObject({ state: 'completed' })
      expect(
        (await audit(f.team.id, 'booking.cancelled')).filter((row) => row.request_id === batchId),
      ).toEqual([])
    },
  )

  it('keeps committed items, checks departed hosts and continues with other hosts', async () => {
    const f = await fixture()
    const first = await f.booking(0)
    const departed = await f.booking(1)
    const cancelledFirst = await f.booking(2)
    const unaffected = await f.booking(3, f.owner)
    const batchId = await f.admit([first.id, departed.id, cancelledFirst.id, unaffected.id], true)
    await run(batchId)
    expect((await itemRows(batchId)).map(({ outcome }) => outcome)).toEqual([
      'cancelled',
      'pending',
      'pending',
      'pending',
    ])
    await cancelManagedBooking({ db, now, notify }, cancelledFirst.token)
    await removeTeamMember(db, await session(f.team, f.owner), {
      teamId: f.team.id,
      expectedOrganizationId: f.team.id,
      memberUserId: f.host.id,
    })
    await makePendingDue(batchId)
    await run(batchId)

    expect((await itemRows(batchId)).map(({ outcome }) => outcome)).toEqual([
      'cancelled',
      'booking_host_departed',
      'already_cancelled',
      'cancelled',
    ])
    expect(await bookingState(departed.id)).toEqual({ status: 'confirmed' })
    expect(await queuedNotifications(departed.id)).toEqual([])
    expect(await bookingState(unaffected.id)).toEqual({ status: 'cancelled' })
    expect(await queuedNotifications(first.id, cancelledFirst.id, unaffected.id)).toHaveLength(3)
  })

  it('rechecks a Checkout binding to the current booking after an eligible preview', async () => {
    const f = await fixture()
    const root = await f.booking()
    const successor = await f.booking(1)
    await cancelManagedBooking({ db, now }, root.token)
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: root.id })
      .where('id', '=', successor.id)
      .execute()
    const batchId = await f.admit([successor.id])
    await db
      .insertInto('payment_checkout_attempts')
      .values({
        id: randomUUID(),
        booking_id: root.id,
        current_booking_id: successor.id,
        account_id: 'acct_synthetic_bulk_worker',
        amount_minor: 1000,
        currency: 'usd',
        mode: 'test',
        idempotency_key: randomUUID(),
      })
      .execute()

    await run(batchId)

    expect(await itemRows(batchId)).toMatchObject([
      { booking_id: successor.id, outcome: 'booking_not_supported' },
    ])
    expect(await bookingState(successor.id)).toEqual({ status: 'confirmed' })
    expect(await queuedNotifications(successor.id)).toEqual([])
    expect(await db.selectFrom('payment_refund_obligations').select('id').execute()).toEqual([])
  })

  it('rechecks a link to a foreign imported booking after an eligible preview', async () => {
    const f = await fixture()
    const foreignTeam = await createTestTeam(db, [{ user: f.owner, role: 'owner' }])
    const imported = await createFixtures(db).booking(
      foreignTeam.id,
      [],
      '2030-11-04T08:00:00Z',
      '2030-11-04T08:30:00Z',
      { source: 'import' },
    )
    const { id } = await f.booking()
    const batchId = await f.admit([id])
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: imported })
      .where('id', '=', id)
      .execute()

    await run(batchId)

    expect(await itemRows(batchId)).toMatchObject([{ outcome: 'booking_not_supported' }])
    expect(await bookingState(id)).toEqual({ status: 'confirmed' })
    expect(await bookingState(imported)).toEqual({ status: 'confirmed' })
    expect(await queuedNotifications(id, imported)).toEqual([])
    expect(await audit(f.team.id, 'booking.cancelled')).toEqual([])
  })

  it('preserves terminal outcomes across recovery of an abandoned claim and redelivery', async () => {
    const f = await fixture()
    const first = await f.booking()
    const abandoned = await f.booking(1)
    const batchId = await f.admit([first.id, abandoned.id], true)
    await run(batchId)
    const claim = randomUUID()
    await db
      .updateTable('team_booking_bulk_cancellation_items')
      .set({
        attempt_count: 1,
        claim_token: claim,
        claim_expires_at: sql<Date>`clock_timestamp() + interval '10 seconds'`,
        next_attempt_at: wallTime,
      })
      .where('batch_id', '=', batchId)
      .where('booking_id', '=', abandoned.id)
      .execute()

    const wakes: string[] = []
    const recover = () =>
      recoverTeamBookingBulkCancellations(db, async (trx, id) => {
        expect(trx.isTransaction).toBe(true)
        wakes.push(id)
        return randomUUID()
      })
    await recover()
    await run(batchId)
    expect(wakes).toEqual([])
    expect(await itemRows(batchId)).toMatchObject([
      { outcome: 'cancelled', attempt_count: 1 },
      { outcome: 'pending', attempt_count: 1, claim_token: claim },
    ])

    await db
      .updateTable('team_booking_bulk_cancellation_items')
      .set({ claim_expires_at: sql<Date>`clock_timestamp() - interval '1 second'` })
      .where('batch_id', '=', batchId)
      .where('booking_id', '=', abandoned.id)
      .execute()
    await recover()
    expect(wakes).toEqual([batchId])
    await run(batchId)
    const done = await batch(batchId)
    const items = await itemRows(batchId)
    const outbox = await queuedNotifications(first.id, abandoned.id)
    expect(done).toMatchObject({ state: 'completed', completed_at: expect.any(Date) })
    expect(items).toMatchObject([
      { outcome: 'cancelled', attempt_count: 1, claim_token: null, next_attempt_at: null },
      { outcome: 'cancelled', attempt_count: 2, claim_token: null, next_attempt_at: null },
    ])
    expect(outbox).toHaveLength(2)

    const sentBefore = sent.length
    const drain = async () => {
      for (const row of await queuedNotifications(first.id, abandoned.id)) {
        await mail().handler(BookingNotificationPayload.parse(row.data), {
          id: row.id,
          attempt: 1,
          signal: new AbortController().signal,
        })
      }
    }
    await drain()
    expect(sent.slice(sentBefore).sort()).toEqual(
      [f.host.email, f.host.email, 'invitee@example.com', 'invitee@example.com'].sort(),
    )
    await Promise.all([run(batchId), run(batchId)])
    await recover()
    await drain()
    expect(wakes).toEqual([batchId])
    expect(sent).toHaveLength(sentBefore + 4)
    expect(await batch(batchId)).toEqual(done)
    expect(await itemRows(batchId)).toEqual(items)
    expect(await queuedNotifications(first.id, abandoned.id)).toEqual(outbox)
    const cancellations = await audit(f.team.id, 'booking.cancelled')
    expect(cancellations).toHaveLength(2)
    expect(cancellations).toEqual(
      expect.arrayContaining(
        [first.id, abandoned.id].map((id) =>
          expect.objectContaining({
            target_id: id,
            actor_type: 'user',
            actor_id: f.admin.id,
            credential_type: 'session',
            credential_id: f.principal.sessionId,
            request_id: batchId,
          }),
        ),
      ),
    )
    expect(await audit(f.team.id, 'booking.bulk_cancellation_completed')).toMatchObject([
      {
        target_id: batchId,
        actor_type: 'system',
        credential_type: 'none',
        request_id: batchId,
        details: { counts: { pending: 0, cancelled: 2 } },
      },
    ])
  })

  it('leaves the item and its side effects untouched when a stale claimant resumes', async () => {
    const f = await fixture()
    const { id } = await f.booking()
    const batchId = await f.admit([id])
    const stale = pauseClaimedWorker(batchId)
    let replacement: ReturnType<typeof pauseClaimedWorker> | undefined
    try {
      await stale.wait()
      const [firstClaim] = await itemRows(batchId)
      expect(firstClaim).toMatchObject({
        outcome: 'pending',
        attempt_count: 1,
        claim_token: expect.any(String),
      })
      await db
        .updateTable('team_booking_bulk_cancellation_items')
        .set({ claim_expires_at: wallTime, next_attempt_at: wallTime })
        .where('batch_id', '=', batchId)
        .execute()

      replacement = pauseClaimedWorker(batchId)
      await replacement.wait()
      const running = await batch(batchId)
      const replacementItems = await itemRows(batchId)
      const [secondClaim] = replacementItems
      expect(secondClaim).toMatchObject({
        outcome: 'pending',
        attempt_count: 2,
        claim_token: expect.any(String),
      })
      expect(secondClaim?.claim_token).not.toBe(firstClaim?.claim_token)

      stale.release()
      await stale.worker

      expect(await bookingState(id)).toEqual({ status: 'confirmed' })
      expect(await itemRows(batchId)).toEqual(replacementItems)
      expect(await batch(batchId)).toEqual(running)
      expect(await queuedNotifications(id)).toEqual([])
      expect(await audit(f.team.id, 'booking.cancelled')).toEqual([])
      expect(await audit(f.team.id, 'booking.bulk_cancellation_completed')).toEqual([])
    } finally {
      stale.release()
      replacement?.release()
      await Promise.allSettled([stale.worker, replacement?.worker])
    }

    await replacement?.worker
    expect(await itemRows(batchId)).toMatchObject([{ outcome: 'cancelled', attempt_count: 2 }])
    expect(await queuedNotifications(id)).toHaveLength(1)
    expect(await audit(f.team.id, 'booking.cancelled')).toHaveLength(1)
  })

  it.each(['before the booking lock', 'before commit'] as const)(
    'stops cancellation when the issuing session expires %s',
    async (phase) => {
      const f = await fixture()
      const { id } = await f.booking()
      const batchId = await f.admit([id])
      const expireSession = (connection: Db) =>
        connection
          .updateTable('auth.session')
          .set({ expiresAt: wallTime })
          .where('id', '=', f.principal.sessionId)
          .executeTakeFirstOrThrow()
      let notificationAttempts = 0
      const paused = pauseClaimedWorker(batchId, async (trx, event, instant) => {
        notificationAttempts++
        await notify(trx, event, instant)
        // Advance expiry on the connection holding the session lock, after queuing the
        // notification, so the commit check observes it without waiting on a real timer.
        if (phase === 'before commit') await expireSession(trx)
      })
      try {
        await paused.wait()
        if (phase === 'before the booking lock') await expireSession(db)
      } finally {
        paused.release()
        await paused.worker
      }

      expect(notificationAttempts).toBe(phase === 'before commit' ? 1 : 0)
      expect(await itemRows(batchId)).toMatchObject([{ outcome: 'authorization_lost' }])
      expect(await batch(batchId)).toMatchObject({ state: 'completed' })
      expect(await bookingState(id)).toEqual({ status: 'confirmed' })
      expect(await queuedNotifications(id)).toEqual([])
      expect(await audit(f.team.id, 'booking.cancelled')).toEqual([])
    },
  )

  it('stops pending writes when the submitting session switches teams', async () => {
    const f = await fixture()
    const first = await f.booking()
    const later = await f.booking(1)
    const batchId = await f.admit([first.id, later.id], true)
    await run(batchId)
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.admin.principal.organization.id })
      .where('id', '=', f.principal.sessionId)
      .execute()
    await session(f.team, f.admin)
    await makePendingDue(batchId)
    await run(batchId)

    expect(await itemRows(batchId)).toMatchObject([
      { outcome: 'cancelled' },
      { outcome: 'authorization_lost' },
    ])
    expect(await batch(batchId)).toMatchObject({ state: 'completed' })
    expect(await bookingState(later.id)).toEqual({ status: 'confirmed' })
    expect(await queuedNotifications(later.id)).toEqual([])
  })

  it.each(['SSO', 'SCIM'] as const)(
    'rechecks team authority after a change in %s policy',
    async (authority) => {
      const f = await fixture()
      const { id } = await f.booking()
      const batchId = await f.admit([id])
      if (authority === 'SSO') {
        await db
          .insertInto('sso_policies')
          .values({ organization_id: f.team.id, require_sso: true })
          .execute()
      } else {
        await createFixtures(db).suspendManagedChildMembership(f.team.id, f.admin.id)
      }

      await runTeamBookingBulkCancellation(db, batchId, {
        notify,
        scimResourcesEnabled: true,
        ssoCapabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
      })

      expect(await itemRows(batchId)).toMatchObject([{ outcome: 'authorization_lost' }])
      expect(await batch(batchId)).toMatchObject({ state: 'completed' })
      expect(await bookingState(id)).toEqual({ status: 'confirmed' })
      expect(await queuedNotifications(id)).toEqual([])
    },
  )

  it.each(['execution deadline', 'attempt budget'] as const)(
    'records an uncommitted failure when the %s is exhausted',
    async (limit) => {
      const f = await fixture()
      const { id } = await f.booking()
      const batchId = await f.admit([id])
      if (limit === 'execution deadline') {
        await db
          .updateTable('team_booking_bulk_cancellations')
          .set({
            created_at: sql<Date>`clock_timestamp() - interval '8 minutes'`,
            admitted_at: sql<Date>`clock_timestamp() - interval '7 minutes'`,
            expires_at: sql<Date>`clock_timestamp() + interval '1 minute'`,
          })
          .where('id', '=', batchId)
          .execute()
      } else {
        await db
          .updateTable('team_booking_bulk_cancellation_items')
          .set({
            attempt_count: 3,
            claim_token: randomUUID(),
            claim_expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
          })
          .where('batch_id', '=', batchId)
          .execute()
      }

      await run(batchId)

      expect(await itemRows(batchId)).toMatchObject([
        {
          outcome: 'processing_failed',
          attempt_count: limit === 'execution deadline' ? 0 : 3,
          claim_token: null,
          next_attempt_at: null,
        },
      ])
      expect(await bookingState(id)).toEqual({ status: 'confirmed' })
      expect(await queuedNotifications(id)).toEqual([])
      expect(await batch(batchId)).toMatchObject({ state: 'completed' })
    },
  )

  it.each([
    ['serialization failure', Object.assign(new Error('Synthetic failure'), { code: '40001' })],
    ['queue startup', new Error('jobs are not running (starting)')],
  ])('rolls back the cancellation and its outbox on %s before retrying', async (_, error) => {
    const f = await fixture()
    const { id } = await f.booking()
    const batchId = await f.admit([id])
    await run(batchId, async (trx, event, instant) => {
      await notify(trx, event, instant)
      throw error
    })
    expect(await bookingState(id)).toEqual({ status: 'confirmed' })
    expect(await queuedNotifications(id)).toEqual([])
    expect(await audit(f.team.id, 'booking.cancelled')).toEqual([])
    expect(await itemRows(batchId)).toMatchObject([
      {
        outcome: 'pending',
        attempt_count: 1,
        claim_token: null,
        next_attempt_at: expect.any(Date),
      },
    ])

    await makePendingDue(batchId)
    await run(batchId)

    expect(await bookingState(id)).toEqual({ status: 'cancelled' })
    expect(await queuedNotifications(id)).toHaveLength(1)
    expect(await audit(f.team.id, 'booking.cancelled')).toHaveLength(1)
    expect(await itemRows(batchId)).toMatchObject([{ outcome: 'cancelled', attempt_count: 2 }])
  })

  it('shares four item write slots across simultaneous worker invocations', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const f = await fixture()
        const { id } = await f.booking()
        return f.admit([id])
      }),
    )
    const [waiting, ...occupied] = ids as [string, ...string[]]
    const release = Promise.withResolvers<void>()
    const writing = occupied.map(() => Promise.withResolvers<void>())
    const workers = occupied.map((id, index) =>
      run(id, async (...args) => {
        await notify(...args)
        writing[index]?.resolve()
        await release.promise
      }),
    )
    try {
      await Promise.race([
        Promise.all(writing.map(({ promise }) => promise)),
        Promise.race(workers).then(() => expect.fail('An item exited before the write checkpoint')),
      ])
      expect(await run(waiting)).toBeInstanceOf(Date)
      expect(await itemRows(waiting)).toMatchObject([
        { outcome: 'pending', attempt_count: 0, claim_token: null },
      ])
    } finally {
      release.resolve()
      await Promise.all(workers)
    }
    await makePendingDue(waiting)
    await run(waiting)
    expect(await itemRows(waiting)).toMatchObject([{ outcome: 'cancelled', attempt_count: 1 }])
  })

  it('dispatches a lost wake through the registered recovery job and worker', async ({
    signal,
  }) => {
    const f = await fixture()
    const { id } = await f.booking()
    const batchId = await f.admit([id])
    const enqueue: EnqueueBulkCancellation = (transaction, batchId, startAfter) =>
      bulkJobs.enqueue(
        TEAM_BOOKING_BULK_JOB,
        { batchId },
        { transaction, singletonKey: batchId, startAfter },
      )
    const enqueueDelayed = (batchId: string, startAfter: Date): Promise<string | null> =>
      bulkJobs.enqueue(TEAM_BOOKING_BULK_JOB, { batchId }, { singletonKey: batchId, startAfter })
    const bulkJobs = createJobs({
      connectionString: owned.url,
      definitions: teamBookingBulkCancellationJobs(db, {
        enabled: true,
        notify,
        enqueue,
        enqueueDelayed,
      }),
      work: true,
      migrate: false,
      pollingIntervalSeconds: 0.5,
      maxConnections: 2,
      log: () => {},
    })
    try {
      await bulkJobs.start()
      await bulkJobs.enqueue(TEAM_BOOKING_BULK_RECOVERY_JOB, {}, { singletonKey: 'startup' })
      while ((await batch(batchId)).state !== 'completed')
        await setTimeout(20, undefined, { signal })
      expect(await itemRows(batchId)).toMatchObject([{ outcome: 'cancelled', attempt_count: 1 }])
      expect(await queuedNotifications(id)).toHaveLength(1)
      const wakes = await owned.pool.query<{ data: unknown }>(
        'SELECT data FROM pgboss.job WHERE name = $1 AND data = $2::jsonb',
        [TEAM_BOOKING_BULK_JOB, { batchId }],
      )
      expect(wakes.rows.length).toBeGreaterThan(0)
      for (const wake of wakes.rows) expect(wake.data).toEqual({ batchId })
    } finally {
      await bulkJobs.stop()
    }
  })
})
