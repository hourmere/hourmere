import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { applyDepartureHandoff } from './departure-handoff-apply.ts'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  HANDOFF_START,
  handoffTestRecords,
  handoffTestSession,
} from './departure-handoff-apply-test-fixture.ts'
import {
  controlDepartureHandoffRun,
  type EnqueueDepartureHandoffRun,
  MAX_DEPARTURE_HANDOFF_RUN_ITEMS,
  readDepartureHandoffRun,
  recoverDepartureHandoffRuns,
  runDepartureHandoffQueueItem,
  startDepartureHandoffRun,
} from './departure-handoff-queue.ts'
import { createFixtures, createTestTeam, createTestUser } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => HANDOFF_NOW
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }

describe.skipIf(!serverUrl)('departure handoff queue', () => {
  let owned: TestDatabase
  let db: Db
  let storage: ReturnType<typeof handoffTestRecords>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_queue' })
    owned.pool.options.max = 6
    db = createDb(owned.pool)
    storage = handoffTestRecords(db)
    await sql`CREATE TABLE test_handoff_queue_intents (
      booking_id uuid NOT NULL REFERENCES bookings,
      event_type text NOT NULL,
      PRIMARY KEY (booking_id, event_type)
    )`.execute(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  const notify: BookingNotifier = async (trx, event) => {
    expect(trx.isTransaction).toBe(true)
    await sql`INSERT INTO test_handoff_queue_intents (booking_id, event_type)
      VALUES (${event.bookingId}, ${event.type})`.execute(trx)
  }

  async function setup({ count = 1, pending = -1, departed = true } = {}) {
    const additional: { bookingId: string; start: Temporal.Instant }[] = []
    const f = await createHandoffTestFixture(db, {
      applyContext: { notify },
      async configureSource({ eventTypeId }) {
        if (count === 1) return
        const event = await db
          .selectFrom('event_types as event')
          .innerJoin(
            'auth.organization as organization',
            'organization.id',
            'event.organization_id',
          )
          .select(['event.slug', 'organization.slug as handle'])
          .where('event.id', '=', eventTypeId)
          .executeTakeFirstOrThrow()
        for (let index = 1; index < count; index++) {
          const start = HANDOFF_START.add({ minutes: 30 * index })
          const { booking } = await createPublicTeamBooking(
            { db, now },
            {
              ...event,
              start,
              invitee: { name: 'Private Booker', email: 'booker@example.test', timeZone: 'UTC' },
              guests: [{ name: 'Private Guest', email: 'guest@example.test' }],
              responses: { notes: 'Approved answer' },
            },
          )
          additional.push({ bookingId: booking.id, start })
        }
      },
    })
    const offers = [
      { ...f.input, start: HANDOFF_START },
      ...additional.map((entry) => ({ ...f.input, ...entry, offerId: randomUUID() })),
    ]
    for (const [index, { start, ...offer }] of offers.entries()) {
      await storage.offer(
        f.ctx,
        offer,
        { departingUserId: f.departing.id, start: start.toString() },
        (saved) => ({
          ...saved,
          expiresAt: start.toString(),
          approvals: index === pending ? saved.approvals.slice(0, 1) : saved.approvals,
        }),
      )
    }
    if (departed)
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', f.team.id)
        .where('userId', '=', f.departing.id)
        .execute()

    const key: { organizationId: string; runId: string } = {
      organizationId: f.team.id,
      runId: randomUUID(),
    }
    const input = {
      teamId: key.organizationId,
      expectedOrganizationId: key.organizationId,
      runId: key.runId,
      departingUserId: f.departing.id,
    }
    const wakes: (typeof key)[] = []
    const enqueue: EnqueueDepartureHandoffRun = async (trx, organizationId, runId) => {
      expect(trx.isTransaction).toBe(true)
      wakes.push({ organizationId, runId })
      return randomUUID()
    }
    return { ...f, key, runInput: input, wakes, enqueue }
  }

  type Fixture = Awaited<ReturnType<typeof setup>>
  const start = (f: Fixture) => startDepartureHandoffRun(f.ctx, f.runInput, f.enqueue)
  const read = (f: Fixture) => readDepartureHandoffRun(f.ctx, f.runInput)
  const control = (f: Fixture, action: 'pause' | 'resume' | 'stop') =>
    controlDepartureHandoffRun(
      f.ctx,
      { ...f.runInput, runId: f.runInput.runId.toUpperCase(), action },
      f.enqueue,
    )
  const work = (f: Fixture, notifyOverride = notify) =>
    runDepartureHandoffQueueItem(db, f.key, { notify: notifyOverride, now })

  function makeDue(f: Fixture) {
    return db
      .updateTable('departure_handoff_runs')
      .set({ next_item_at: sql`created_at` })
      .where('organization_id', '=', f.key.organizationId)
      .where('id', '=', f.key.runId)
      .execute()
  }

  function bookings(f: Fixture) {
    return db
      .selectFrom('bookings')
      .select(['id', 'status', 'required_host_user_ids', 'rescheduled_from_id'])
      .where('organization_id', '=', f.team.id)
      .execute()
  }

  async function intents(f: Fixture) {
    const { rows } = await sql<{ booking_id: string; event_type: string }>`
      SELECT intent.booking_id, intent.event_type FROM test_handoff_queue_intents AS intent
      JOIN bookings AS booking ON booking.id = intent.booking_id
      WHERE booking.organization_id = ${f.team.id} ORDER BY intent.event_type
    `.execute(db)
    return rows
  }

  function audit(f: Fixture) {
    return db
      .selectFrom('audit_events')
      .select(['action', 'actor_type', 'actor_id', 'details'])
      .where('organization_id', '=', f.team.id)
      .where('target_type', '=', 'departure_handoff_run')
      .where('target_id', '=', f.key.runId)
      .orderBy('occurred_at')
      .execute()
  }

  async function expectLifecycle(
    f: Fixture,
    sourceBookingId: string,
    replacementBookingId: string,
  ) {
    expect(await bookings(f)).toEqual(
      expect.arrayContaining([
        {
          id: sourceBookingId,
          status: 'cancelled',
          required_host_user_ids: [f.departing.id],
          rescheduled_from_id: null,
        },
        {
          id: replacementBookingId,
          status: 'confirmed',
          required_host_user_ids: [f.candidate.id],
          rescheduled_from_id: null,
        },
      ]),
    )
    expect(await intents(f)).toEqual([
      { booking_id: sourceBookingId, event_type: 'cancelled' },
      { booking_id: replacementBookingId, event_type: 'created' },
    ])
  }

  async function backendPid(trx: Db) {
    const {
      rows: [row],
    } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
    if (!row) throw new Error('Missing transaction backend PID')
    return row.pid
  }

  async function blocksAnotherTransaction(pid: number) {
    const { rows } = await sql<{ blocked: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
        AND ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked
    `.execute(db)
    return rows[0]?.blocked === true
  }

  /** Observe PostgreSQL's actual lock wait before releasing the first transaction. */
  async function raceWithApply<A, B>(
    first: (notifier: BookingNotifier) => Promise<A>,
    second: () => Promise<B>,
    signal: AbortSignal,
  ) {
    const ready = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const firstResult = Promise.allSettled([
      first(async (trx, event, at) => {
        await notify(trx, event, at)
        if (event.type === 'created') {
          ready.resolve(await backendPid(trx))
          await release.promise
        }
      }),
    ])
    let secondResult: Promise<PromiseSettledResult<B>[]> | undefined
    try {
      const blockerPid = await Promise.race([
        ready.promise,
        firstResult.then(([result]) => {
          if (result?.status === 'rejected') throw result.reason
          throw new Error('The first transaction settled before producing a creation intent')
        }),
      ])
      let secondSettled = false
      secondResult = Promise.allSettled([second()]).then((result) => {
        secondSettled = true
        return result
      })
      for (;;) {
        signal.throwIfAborted()
        if (await blocksAnotherTransaction(blockerPid)) break
        expect(secondSettled).toBe(false)
        await setTimeout(10, undefined, { signal })
      }
      release.resolve()
      const [[firstOutcome], [secondOutcome]] = await Promise.all([firstResult, secondResult])
      return [firstOutcome, secondOutcome] as const
    } finally {
      release.resolve()
      await firstResult
      await secondResult
    }
  }

  it.for(['pause', 'stop'] as const)(
    '%s interleaves with an apply and takes effect before the next item',
    async (action, { signal }) => {
      const f = await setup({ count: 2 })
      const admitted = await start(f)
      const [first, next] = admitted.items
      if (!first || !next) throw new Error('Expected two admitted items')

      const [apply, transition] = await raceWithApply(
        (notifier) => work(f, notifier),
        () => control(f, action),
        signal,
      )
      expect(apply).toMatchObject({ status: 'fulfilled', value: expect.any(Date) })
      expect(transition).toMatchObject({ status: 'fulfilled' })
      await makeDue(f)
      expect(await work(f)).toBeUndefined()

      const status = await read(f)
      const firstOutcome = status.items[0]
      if (!firstOutcome?.replacementBookingId) throw new Error('Missing committed replacement')
      expect(status).toMatchObject({
        state: action === 'pause' ? 'paused' : 'stopped',
        items: [
          { sourceBookingId: first.sourceBookingId, outcome: 'applied' },
          {
            sourceBookingId: next.sourceBookingId,
            outcome: action === 'pause' ? 'pending' : 'stopped',
          },
        ],
      })
      expect(await bookings(f)).toContainEqual({
        id: next.sourceBookingId,
        status: 'confirmed',
        required_host_user_ids: [f.departing.id],
        rescheduled_from_id: null,
      })
      await expectLifecycle(f, first.sourceBookingId, firstOutcome.replacementBookingId)

      if (action === 'pause') {
        await expect(control(f, 'resume')).resolves.toMatchObject({ state: 'running' })
        await makeDue(f)
        await work(f)
        expect(await read(f)).toMatchObject({
          state: 'completed',
          items: [{ outcome: 'applied' }, { outcome: 'applied' }],
        })
        expect(await intents(f)).toHaveLength(4)
      } else {
        await expect(control(f, 'resume')).rejects.toMatchObject({ kind: 'conflict' })
      }
      expect(await audit(f)).toMatchObject([
        {
          action: 'booking.handoff_run_started',
          actor_type: 'user',
          actor_id: f.owner.id,
          details: {},
        },
        ...(action === 'pause'
          ? [
              {
                action: 'booking.handoff_run_paused',
                actor_type: 'user',
                actor_id: f.owner.id,
                details: {},
              },
              {
                action: 'booking.handoff_run_resumed',
                actor_type: 'user',
                actor_id: f.owner.id,
                details: {},
              },
              { action: 'booking.handoff_run_completed', actor_type: 'system', details: {} },
            ]
          : [
              {
                action: 'booking.handoff_run_stopped',
                actor_type: 'user',
                actor_id: f.owner.id,
                details: {},
              },
            ]),
      ])
    },
  )

  it('recovers the exact pending item after a worker connection dies inside the apply', async () => {
    const f = await setup()
    const admitted = await start(f)
    let terminated = false
    const crashed = work(f, async (trx, event, at) => {
      await notify(trx, event, at)
      if (event.type === 'created') {
        const pid = await backendPid(trx)
        const { rows } = await sql<{ terminated: boolean }>`
          SELECT pg_terminate_backend(${pid}, 1000) AS terminated
        `.execute(db)
        terminated = rows[0]?.terminated === true
        await sql`SELECT 1`.execute(trx)
      }
    })
    await Promise.allSettled([crashed])
    expect(terminated).toBe(true)
    expect(await read(f)).toEqual(admitted)
    expect(await bookings(f)).toHaveLength(1)
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])

    f.wakes.length = 0
    await recoverDepartureHandoffRuns(db, f.enqueue)
    expect(f.wakes).toContainEqual(f.key)
    await work(f)
    const committed = await read(f)
    const replacement = committed.items[0]?.replacementBookingId
    if (!replacement) throw new Error('Missing recovered replacement')
    expect(committed).toMatchObject({ state: 'completed', items: [{ outcome: 'applied' }] })
    expect(await start(f)).toEqual(committed)
    expect(await work(f)).toBeUndefined()
    expect(await read(f)).toEqual(committed)
    expect(await storage.receipts(f.input)).toHaveLength(1)
    await expectLifecycle(f, f.booking.id, replacement)
  })

  it('fails the run when the departing member rejoins after the first item', async ({ signal }) => {
    const f = await setup({ count: 2 })
    await start(f)
    const [apply, rejoin] = await raceWithApply(
      (notifier) => work(f, notifier),
      () =>
        db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('auth.organization')
            .select('id')
            .where('id', '=', f.team.id)
            .forUpdate()
            .executeTakeFirstOrThrow()
          await createFixtures(trx).member(f.departing.id, f.team.id)
        }),
      signal,
    )
    expect(apply).toMatchObject({ status: 'fulfilled' })
    expect(rejoin).toMatchObject({ status: 'fulfilled' })
    await makeDue(f)
    await work(f)
    const failure = await read(f)
    expect(failure).toMatchObject({
      state: 'failed',
      failureCode: 'departed_member_returned',
      items: [{ outcome: 'applied' }, { outcome: 'stopped', replacementBookingId: null }],
    })
    expect(await intents(f)).toHaveLength(2)
    expect(await bookings(f)).toHaveLength(3)
    expect(await work(f)).toBeUndefined()
  })

  it('reuses a manual handoff receipt when manual apply wins the source lock', async ({
    signal,
  }) => {
    const f = await setup()
    await start(f)
    const [manual, queued] = await raceWithApply(
      (notifier) => applyDepartureHandoff({ ...f.ctx, notify: notifier }, f.input, storage.store),
      () => work(f),
      signal,
    )
    if (manual?.status !== 'fulfilled') throw new Error('Manual apply did not commit')
    expect(queued).toMatchObject({ status: 'fulfilled' })
    expect(await read(f)).toMatchObject({
      state: 'completed',
      items: [{ ...manual.value, outcome: 'applied' }],
    })
    expect(await storage.receipts(f.input)).toHaveLength(1)
    expect(await bookings(f)).toHaveLength(2)
    await expectLifecycle(f, f.booking.id, manual.value.replacementBookingId)
  })

  it('limits a run to ten ready offers, paces items and exposes only opaque results', async () => {
    const f = await setup({ count: 12, pending: 0 })
    const admitted = await start(f)
    expect(admitted.items).toHaveLength(MAX_DEPARTURE_HANDOFF_RUN_ITEMS)
    expect(admitted.items).toHaveLength(10)
    expect(admitted.items).not.toContainEqual(
      expect.objectContaining({ sourceBookingId: f.booking.id }),
    )
    expect(admitted).toEqual({
      id: f.key.runId,
      departingUserId: f.departing.id,
      state: 'running',
      failureCode: null,
      items: admitted.items.map(({ sourceBookingId, offerId, version }) => ({
        sourceBookingId,
        offerId,
        version,
        outcome: 'pending',
        replacementBookingId: null,
      })),
    })
    expect(await start(f)).toEqual(admitted)
    await expect(
      startDepartureHandoffRun(f.ctx, { ...f.runInput, runId: randomUUID() }, f.enqueue),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect(f.wakes).toEqual([f.key])
    const wakeAt = await work(f)
    expect(wakeAt).toBeInstanceOf(Date)
    expect(await work(f)).toEqual(wakeAt)
    expect((await read(f)).items.filter(({ outcome }) => outcome === 'applied')).toHaveLength(1)
    expect(await intents(f)).toHaveLength(2)
    expect(await storage.receipts(f.input)).toEqual([])
    await control(f, 'stop')
    await expect(
      startDepartureHandoffRun(f.ctx, { ...f.runInput, runId: randomUUID() }, f.enqueue),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'handoff_run_rate_limited' })
  })

  it('serializes concurrent starts without blocking an ordinary booking for the same team', async () => {
    const f = await setup()
    const enqueuing = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const starting = startDepartureHandoffRun(f.ctx, f.runInput, async (trx, ...args) => {
      enqueuing.resolve(await backendPid(trx))
      await release.promise
      return f.enqueue(trx, ...args)
    })
    const pending: Promise<unknown>[] = [starting]
    try {
      const startPid = await Promise.race([
        enqueuing.promise,
        starting.then(() => {
          throw new Error('Run start settled before enqueueing')
        }),
      ])
      let bookingSettled = false
      const booking = Promise.allSettled([
        createPublicTeamBooking(
          { db, now },
          {
            handle: f.ctx.principal.organization.slug,
            slug: 'handoff',
            start: HANDOFF_START.add({ hours: 1 }),
            invitee: { name: 'New Booker', email: 'new-booker@example.test', timeZone: 'UTC' },
            responses: { notes: 'New booking' },
          },
        ),
      ]).then((result) => {
        bookingSettled = true
        return result
      })
      pending.push(booking)
      await expect
        .poll(async () => bookingSettled || (await blocksAnotherTransaction(startPid)))
        .toBe(true)
      expect(bookingSettled, 'Run start blocked an ordinary team booking').toBe(true)
      expect(await booking).toEqual([
        {
          status: 'fulfilled',
          value: expect.objectContaining({
            booking: expect.objectContaining({ status: 'confirmed' }),
          }),
        },
      ])

      let replaySettled = false
      const replay = Promise.allSettled([start(f)]).then((result) => {
        replaySettled = true
        return result
      })
      pending.push(replay)
      await expect
        .poll(async () => replaySettled || (await blocksAnotherTransaction(startPid)))
        .toBe(true)
      expect(replaySettled, 'A second start passed admission before the first committed').toBe(
        false,
      )
      release.resolve()
      expect(await replay).toEqual([{ status: 'fulfilled', value: await starting }])
      expect(f.wakes).toEqual([f.key])
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
    }
  })

  it('rolls back start when its transactional wake cannot be written', async () => {
    const f = await setup()
    await expect(
      startDepartureHandoffRun(f.ctx, f.runInput, async () => {
        throw new Error('test outbox failure')
      }),
    ).rejects.toMatchObject({ kind: 'unavailable', code: 'handoff_run_queue_unavailable' })
    await expect(read(f)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(start(f)).resolves.toMatchObject({ state: 'running' })
  })

  it('recovers an expired paused run without applying any items', async () => {
    const f = await setup()
    await start(f)
    await control(f, 'pause')
    await db
      .updateTable('departure_handoff_runs')
      .set({
        created_at: sql`clock_timestamp() - interval '31 minutes'`,
        expires_at: sql`clock_timestamp() - interval '1 minute'`,
      })
      .where('organization_id', '=', f.key.organizationId)
      .where('id', '=', f.key.runId)
      .execute()
    f.wakes.length = 0
    await recoverDepartureHandoffRuns(db, f.enqueue)
    expect(f.wakes).toContainEqual(f.key)
    await work(f)
    expect(await read(f)).toMatchObject({
      state: 'failed',
      failureCode: 'run_expired',
      items: [{ outcome: 'stopped' }],
    })
    expect(await intents(f)).toEqual([])
  })

  it('refuses a member, any API key, and run IDs from another team', async () => {
    const f = await setup()
    const principal = await handoffTestSession(db, f.candidate, f.ctx.principal.organization)
    const memberCtx = { ...f.ctx, principal }
    const keyCtx = { ...f.ctx, principal: f.team.as(f.owner) }
    for (const ctx of [memberCtx, keyCtx])
      await expect(startDepartureHandoffRun(ctx, f.runInput, f.enqueue)).rejects.toMatchObject(
        denied,
      )
    await start(f)
    for (const ctx of [memberCtx, keyCtx]) {
      await expect(readDepartureHandoffRun(ctx, f.runInput)).rejects.toMatchObject(denied)
      await expect(
        controlDepartureHandoffRun(ctx, { ...f.runInput, action: 'stop' }, f.enqueue),
      ).rejects.toMatchObject(denied)
    }

    const other = await createTestUser(db)
    const otherTeam = await createTestTeam(db, [{ user: other, role: 'admin' }])
    const otherCtx = {
      ...f.ctx,
      principal: await handoffTestSession(db, other, otherTeam.as(other).organization),
    }
    const otherInput = {
      teamId: otherTeam.id,
      expectedOrganizationId: otherTeam.id,
      runId: f.key.runId,
    }
    await expect(readDepartureHandoffRun(otherCtx, otherInput)).rejects.toMatchObject({
      kind: 'not_found',
    })
    await expect(
      controlDepartureHandoffRun(otherCtx, { ...otherInput, action: 'stop' }, f.enqueue),
    ).rejects.toMatchObject({ kind: 'not_found' })
    expect((await read(f)).state).toBe('running')
    expect(await intents(f)).toEqual([])
  })

  it('refuses to start while the original host is still a team member', async () => {
    const f = await setup({ departed: false })
    await expect(start(f)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'handoff_departing_member_present',
    })
    expect(f.wakes).toEqual([])
    expect(await intents(f)).toEqual([])
  })

  it('skips an exact offer withdrawn since admission without changing its booking', async () => {
    const f = await setup()
    await start(f)
    await db
      .updateTable('departure_handoff_offers')
      .set({ state: 'closed', close_reason: 'withdrawn' })
      .where('organization_id', '=', f.team.id)
      .where('source_booking_id', '=', f.booking.id)
      .where('id', '=', f.input.offerId)
      .where('version', '=', f.input.version)
      .execute()
    const before = await bookings(f)
    await work(f)
    expect(await read(f)).toMatchObject({
      state: 'completed',
      items: [{ sourceBookingId: f.booking.id, outcome: 'ineligible', replacementBookingId: null }],
    })
    expect(await bookings(f)).toEqual(before)
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])
  })

  it('records a failed item without committing partial writes and leaves manual apply available', async () => {
    const f = await setup()
    await start(f)
    const before = await bookings(f)
    await work(f, async (trx, event, at) => {
      await notify(trx, event, at)
      if (event.type === 'created') throw new Error('Synthetic outbox failure')
    })
    const failed = await read(f)
    expect(failed).toMatchObject({
      state: 'completed',
      items: [
        { sourceBookingId: f.booking.id, outcome: 'processing_failed', replacementBookingId: null },
      ],
    })
    expect(await bookings(f)).toEqual(before)
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])

    const manual = await applyDepartureHandoff(f.ctx, f.input, storage.store)
    await expectLifecycle(f, f.booking.id, manual.replacementBookingId)
    expect(await read(f)).toEqual(failed)
  })

  it('fails closed when the authorizing administrator session is revoked', async () => {
    const f = await setup()
    await start(f)
    await db.deleteFrom('auth.session').where('id', '=', f.ctx.principal.sessionId).execute()
    const newSession = await handoffTestSession(db, f.owner, f.ctx.principal.organization)
    await work(f)
    const result = await readDepartureHandoffRun({ ...f.ctx, principal: newSession }, f.runInput)
    expect(result).toMatchObject({
      state: 'failed',
      failureCode: 'authorization_lost',
      items: [{ outcome: 'stopped', replacementBookingId: null }],
    })
    expect(await storage.receipts(f.input)).toEqual([])
    expect(await intents(f)).toEqual([])
  })
})
