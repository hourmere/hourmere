import { randomUUID } from 'node:crypto'
import { createDb, type Db, guardPoolErrors } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type BookingNotifier,
  cancelHostBooking,
  createPublicBooking,
  requestReschedule,
  rescheduleHostBooking,
  setAttendeeNoShow,
} from '@hourmere/scheduling'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureBookingWorkflows } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'
import {
  claimDueWorkflowRuns,
  dispatchClaimedWorkflowRun,
  dispatchDueWorkflowRuns,
  repairWorkflowRunWakes,
} from './dispatcher.ts'
import { createRecordingWorkflowAudit, expectWorkflowAuditRedacted } from './testing.ts'
import { updateWorkflowDefinition } from './updates.ts'

const NOW = Temporal.Instant.from('2030-01-07T08:00:00Z')
const START = Temporal.Instant.from('2030-01-10T12:00:00Z')

function gate() {
  let enter!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    enter = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { enter, release, ready, wait }
}

describe.skipIf(!process.env.DATABASE_URL)('workflow dispatcher and repair', () => {
  let owned: TestDatabase
  let db: Db
  let workers: [Db, Db]
  let pools: pg.Pool[] = []
  let workerPids: number[] = []
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'wf_dispatch',
    })
    db = createDb(owned.pool)
    pools = [0, 1].map(() => {
      const pool = new pg.Pool({ connectionString: owned.url, max: 1 })
      guardPoolErrors(pool)
      return pool
    })
    workers = [createDb(pools[0] as pg.Pool), createDb(pools[1] as pg.Pool)]
    const pids = await Promise.all(pools.map((p) => p.query('SELECT pg_backend_pid() AS pid')))
    workerPids = pids.map((result) => result.rows[0].pid as number)
    expect(workerPids[0]).not.toBe(workerPids[1])
    await sql`CREATE TABLE test_workflow_wakes (run_id uuid PRIMARY KEY)`.execute(db)
  })
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
    await owned?.drop()
  })

  async function setup(
    trigger: Record<string, unknown> = { type: 'booking.created', delayMinutes: 0 },
    now = NOW,
    start = START,
  ) {
    const user = await createTestUser(db)
    const handle = `dispatch-${randomUUID().slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle, time_zone: 'America/New_York' })
      .execute()
    const hours = [{ start: '00:00', end: '23:59' }]
    await createFixtures(db).schedule(user.id, {
      timeZone: 'UTC',
      weeklyHours: {
        monday: hours,
        tuesday: hours,
        wednesday: hours,
        thursday: hours,
        friday: hours,
        saturday: hours,
        sunday: hours,
      },
    })
    const eventTypeId = await createFixtures(db).eventType(
      user.principal.organization.id,
      user.id,
      { slug: 'dispatch' },
    )
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify({ reminders: [], followUps: [] }) })
      .where('id', '=', eventTypeId)
      .execute()
    const workflow = await createWorkflowDefinition(
      { db, principal: user.principal },
      {
        owner: { kind: 'personal', id: user.id },
        idempotencyKey: randomUUID(),
        name: 'Dispatcher fixture',
        scope: { type: 'all_event_types' },
        trigger,
        actions: [{ type: 'email', recipients: ['booker'] }],
        enabled: true,
      },
    )
    const clock = { now }
    const notify: BookingNotifier = (trx, event, at) =>
      captureBookingWorkflows(trx, event, at, 'synthetic-dispatcher-secret')
    const context = (database = db) => ({
      db: database,
      principal: user.principal,
      now: () => clock.now,
      notify,
    })
    const created = await createPublicBooking(context(), {
      handle,
      slug: 'dispatch',
      start,
      invitee: { name: 'Booker', email: 'booker@example.com', timeZone: 'America/New_York' },
    })
    const run = await db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('booking_id', '=', created.booking.id)
      .executeTakeFirstOrThrow()
    const execution = (worker = 0) => ({ db: workers[worker] as Db, now: () => clock.now })
    return {
      user,
      workflow,
      clock,
      context,
      execution,
      run,
      bookingId: created.booking.id,
      start,
      eventTypeId,
    }
  }
  const savedRun = (id: string) =>
    db.selectFrom('workflow_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const history = (id: string) =>
    db.selectFrom('workflow_run_history').selectAll().where('run_id', '=', id).execute()
  async function claim(s: Awaited<ReturnType<typeof setup>>, worker = 0) {
    const claimed = await claimDueWorkflowRuns(s.execution(worker), { runId: s.run.id })
    expect(claimed).toHaveLength(1)
    return claimed[0] as NonNullable<(typeof claimed)[0]>
  }
  // Query actual blocking state, not elapsed time. The two one-connection pools cannot
  // accidentally run both contenders on one connection, and no timer advances the clock.
  async function waiting(worker: number) {
    for (let i = 0; i < 1000; i++) {
      const result = await owned.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
        [workerPids[worker]],
      )
      if (result.rowCount) return
    }
    throw new Error(`Worker ${worker} never waited for its contender`)
  }

  it.each(['cancel', 'reschedule', 'disable', 'delete'] as const)(
    'rechecks %s after a claimed worker waits behind the contender',
    async (change) => {
      const s = await setup()
      const claimed = await claim(s)
      const pause = gate()
      const prepareOrganizationWrite = async (trx: Db) => {
        await sql`SELECT id FROM auth.organization WHERE id=${s.user.principal.organization.id} FOR KEY SHARE`.execute(
          trx,
        )
        await trx
          .selectFrom('workflow_definitions')
          .select('id')
          .where('id', '=', s.workflow.id)
          .forUpdate()
          .execute()
        pause.enter()
        await pause.wait
      }
      const notify: BookingNotifier = async (trx, event, now) => {
        await captureBookingWorkflows(trx, event, now, 'synthetic-dispatcher-secret')
        pause.enter()
        await pause.wait
      }
      const contender =
        change === 'disable'
          ? updateWorkflowDefinition(
              { ...s.context(workers[0]), prepareOrganizationWrite },
              s.workflow.id,
              { expectedRevision: 1, enabled: false },
            )
          : change === 'delete'
            ? deleteWorkflowDefinition(
                { ...s.context(workers[0]), prepareOrganizationWrite },
                s.workflow.id,
                { expectedRevision: 1 },
              )
            : change === 'cancel'
              ? cancelHostBooking({ ...s.context(workers[0]), notify }, s.bookingId)
              : rescheduleHostBooking({ ...s.context(workers[0]), notify }, s.bookingId, {
                  start: START.add({ hours: 1 }),
                })
      await pause.ready
      const dispatch = dispatchClaimedWorkflowRun(s.execution(1), claimed)
      try {
        await waiting(1)
      } finally {
        pause.release()
      }
      await contender
      const result = await dispatch
      expect(result).not.toBe('ready')
      const run = await savedRun(s.run.id)
      expect(run.state).toBe(change === 'disable' ? 'skipped' : 'retired')
      if (change === 'disable') {
        expect(run.skip_reason).toBe('workflow_disabled')
        expect(await history(run.id)).toMatchObject([
          { outcome: 'skipped', reason: 'workflow_disabled' },
        ])
      }
      expect(await dispatchClaimedWorkflowRun(s.execution(0), claimed)).toBe('stale')
    },
  )

  it('skips a wake claimed while disabled and never revives it after re-enabling', async () => {
    const s = await setup()
    const audit = await createRecordingWorkflowAudit(db)
    const execution = { ...s.execution(1), audit: audit.port }
    await updateWorkflowDefinition(s.context(), s.workflow.id, {
      expectedRevision: 1,
      enabled: false,
    })
    expect(await claimDueWorkflowRuns(execution, { runId: s.run.id })).toEqual([])
    expect(await savedRun(s.run.id)).toMatchObject({
      state: 'skipped',
      skip_reason: 'workflow_disabled',
    })
    await updateWorkflowDefinition(s.context(), s.workflow.id, {
      expectedRevision: 1,
      enabled: true,
    })
    expect(await claimDueWorkflowRuns(execution, { runId: s.run.id })).toEqual([])
    expect(await history(s.run.id)).toMatchObject([{ reason: 'workflow_disabled' }])
    const records = await audit.read()
    expect(records).toEqual([
      {
        event: 'workflow.run_skipped',
        actor: { kind: 'background', job: 'dispatch' },
        owner: {
          kind: 'personal',
          userId: s.user.id,
          organizationId: s.user.principal.organization.id,
        },
        workflowId: s.workflow.id,
        revision: 1,
        trigger: 'booking.created',
        reason: 'workflow_disabled',
        occurredAt: s.clock.now,
      },
    ])
    expectWorkflowAuditRedacted(records, ['booker@example.com', 'synthetic-dispatcher-secret'])
  })

  it('keeps an unclaimed due run eligible when re-enabled before its wake within the late bound', async () => {
    const s = await setup()
    await updateWorkflowDefinition(s.context(), s.workflow.id, {
      expectedRevision: 1,
      enabled: false,
    })
    s.clock.now = NOW.add({ minutes: 59 })
    await updateWorkflowDefinition(s.context(), s.workflow.id, {
      expectedRevision: 1,
      enabled: true,
    })
    const claimed = await claim(s)
    expect(await dispatchClaimedWorkflowRun(s.execution(1), claimed)).toBe('ready')
    expect((await savedRun(s.run.id)).state).toBe('claimed')
    expect(await history(s.run.id)).toEqual([])
  })

  it('fences the old token after lease expiry and permits only the current worker', async () => {
    const s = await setup()
    const old = await claim(s)
    expect(await claimDueWorkflowRuns(s.execution(1), { runId: s.run.id })).toEqual([])
    s.clock.now = NOW.add({ minutes: 2 })
    const current = await claim(s, 1)
    expect(current.token).not.toBe(old.token)
    expect(await dispatchClaimedWorkflowRun(s.execution(0), old)).toBe('stale')
    expect(await dispatchClaimedWorkflowRun(s.execution(1), current)).toBe('ready')
  })

  it('cannot reclaim retired work when retirement wins a race with an expired lease', async () => {
    const s = await setup()
    const old = await claim(s)
    s.clock.now = NOW.add({ minutes: 2 })
    const pause = gate()
    const retirement = workers[0].transaction().execute(async (trx) => {
      await sql`SELECT id FROM auth.organization WHERE id=${s.user.principal.organization.id} FOR KEY SHARE`.execute(
        trx,
      )
      await trx
        .selectFrom('workflow_definitions')
        .select('id')
        .where('id', '=', s.workflow.id)
        .forShare()
        .execute()
      await trx
        .updateTable('workflow_runs')
        .set({
          state: 'retired',
          claim_token: null,
          lease_until: null,
          finished_at: s.clock.now.toString(),
        })
        .where('id', '=', s.run.id)
        .execute()
      pause.enter()
      await pause.wait
    })
    await pause.ready
    const reclaim = claimDueWorkflowRuns(s.execution(1), { runId: s.run.id })
    try {
      await waiting(1)
    } finally {
      pause.release()
    }
    await retirement
    await expect(reclaim).resolves.toEqual([])
    expect(await dispatchClaimedWorkflowRun(s.execution(0), old)).toBe('stale')
    expect((await savedRun(s.run.id)).state).toBe('retired')
  })

  it.each(['request', 'no-show'] as const)(
    'a %s neither delays nor skips a due run',
    async (change) => {
      const trigger =
        change === 'request'
          ? { type: 'before_start', offsetMinutes: 30 }
          : { type: 'after_end', offsetMinutes: 30 }
      const s = await setup(trigger)
      if (change === 'request')
        await requestReschedule(s.context(workers[0]), s.bookingId, {
          idempotencyKey: randomUUID(),
        })
      else {
        s.clock.now = START.add({ minutes: 1 })
        const attendee = await db
          .selectFrom('booking_attendees')
          .select('id')
          .where('booking_id', '=', s.bookingId)
          .executeTakeFirstOrThrow()
        await setAttendeeNoShow(s.context(workers[0]), s.bookingId, attendee.id, true)
      }
      s.clock.now = Temporal.Instant.fromEpochMilliseconds(s.run.due_at.getTime())
      const claimed = await claim(s, 1)
      expect(await dispatchClaimedWorkflowRun(s.execution(0), claimed)).toBe('ready')
      expect((await savedRun(s.run.id)).due_at).toEqual(s.run.due_at)
    },
  )

  it.each(['equality', 'after', 'wait'] as const)(
    'never permits a late first attempt at %s',
    async (boundary) => {
      const s = await setup()
      const expires = Temporal.Instant.fromEpochMilliseconds(s.run.expires_at.getTime())
      s.clock.now = expires.subtract({ seconds: 30 })
      const claimed = await claim(s)
      if (boundary !== 'wait') {
        s.clock.now = boundary === 'equality' ? expires : expires.add({ milliseconds: 1 })
        expect(await dispatchClaimedWorkflowRun(s.execution(1), claimed)).not.toBe('ready')
        const fresh = await claimDueWorkflowRuns(s.execution(0), { runId: s.run.id })
        if (fresh[0])
          expect(await dispatchClaimedWorkflowRun(s.execution(1), fresh[0])).toBe('skipped')
      } else {
        const pause = gate()
        const blocker = workers[0].transaction().execute(async (trx) => {
          await trx
            .selectFrom('workflow_definitions')
            .select('id')
            .where('id', '=', s.workflow.id)
            .forUpdate()
            .execute()
          pause.enter()
          await pause.wait
        })
        await pause.ready
        const dispatch = dispatchClaimedWorkflowRun(s.execution(1), claimed)
        try {
          await waiting(1)
          s.clock.now = expires
        } finally {
          pause.release()
        }
        await blocker
        expect(await dispatch).not.toBe('ready')
        const fresh = await claimDueWorkflowRuns(s.execution(0), { runId: s.run.id })
        if (fresh[0])
          expect(await dispatchClaimedWorkflowRun(s.execution(1), fresh[0])).toBe('skipped')
      }
      expect(await savedRun(s.run.id)).toMatchObject({ state: 'skipped', skip_reason: 'expired' })
      expect(await history(s.run.id)).toMatchObject([{ reason: 'expired' }])
    },
  )

  it('uses the repeated DST-night instant, then handles wake replay with the same identity', async () => {
    const s = await setup(
      { type: 'before_start', offsetMinutes: 30 },
      Temporal.Instant.from('2030-11-02T00:00:00Z'),
      Temporal.Instant.from('2030-11-03T06:30:00Z'),
    )
    expect(s.run.due_at.toISOString()).toBe('2030-11-03T06:00:00.000Z')
    s.clock.now = Temporal.Instant.from('2030-11-03T05:59:59Z')
    expect(await claimDueWorkflowRuns(s.execution(0), { runId: s.run.id })).toEqual([])
    s.clock.now = Temporal.Instant.from('2030-11-03T06:00:00Z')
    const claimed = await claim(s)
    expect(await dispatchClaimedWorkflowRun(s.execution(1), claimed)).toBe('ready')
    expect(await claimDueWorkflowRuns(s.execution(1), { runId: s.run.id })).toEqual([])
    const count = await db
      .selectFrom('workflow_runs')
      .select('id')
      .where('enrollment_id', '=', s.run.enrollment_id)
      .execute()
    expect(count).toEqual([{ id: s.run.id }])
  })

  it('repairs missing wakes idempotently without recreating enrollments or recipient intents', async () => {
    const s = await setup()
    const snapshot = async () => ({
      run: await savedRun(s.run.id),
      enrollments: await db
        .selectFrom('workflow_enrollments')
        .selectAll()
        .where('booking_id', '=', s.bookingId)
        .execute(),
      recipients: await db
        .selectFrom('workflow_recipient_claims')
        .selectAll()
        .where('run_id', '=', s.run.id)
        .execute(),
    })
    const before = await snapshot()
    const queued = async () =>
      (await sql<{ run_id: string }>`SELECT run_id FROM test_workflow_wakes`.execute(db)).rows.map(
        (row) => row.run_id,
      )
    const port = {
      ensureWake: async (trx: Db, runId: string) => {
        await sql`INSERT INTO test_workflow_wakes (run_id) VALUES (${runId}) ON CONFLICT DO NOTHING`.execute(
          trx,
        )
      },
    }
    await Promise.all(
      workers.map((_worker, index) => repairWorkflowRunWakes(s.execution(index), port)),
    )
    expect(await queued()).toContain(s.run.id)
    await sql`DELETE FROM test_workflow_wakes WHERE run_id=${s.run.id}`.execute(db)
    await repairWorkflowRunWakes(s.execution(1), port)
    expect(await queued()).toContain(s.run.id)
    expect(await snapshot()).toEqual(before)
    const claimed = await claim(s)
    expect(await dispatchClaimedWorkflowRun(s.execution(1), claimed)).toBe('ready')
  })
  it('bounds pages and allows only one of two workers to claim the same due identity', async () => {
    const s = await setup()
    const results = await Promise.all(
      [0, 1].map((worker) =>
        claimDueWorkflowRuns(s.execution(worker), { runId: s.run.id, limit: 1 }),
      ),
    )
    expect(results.flat()).toHaveLength(1)
    expect(results.flat()[0]?.runId).toBe(s.run.id)
    for (const limit of [0, -1, 101, 1.5]) {
      await expect(claimDueWorkflowRuns(s.execution(), { limit })).rejects.toThrow(RangeError)
    }
  })

  it('rejects a token from another owner and retires work whose event was deleted', async () => {
    const a = await setup()
    const b = await setup()
    const first = await claim(a)
    const second = await claim(b, 1)
    expect(
      await dispatchClaimedWorkflowRun(b.execution(1), { runId: second.runId, token: first.token }),
    ).toBe('stale')
    expect((await savedRun(b.run.id)).claim_token).toBe(second.token)
    await db
      .updateTable('event_types')
      .set({ deleted_at: NOW.toString() })
      .where('id', '=', a.eventTypeId)
      .execute()
    expect(await dispatchClaimedWorkflowRun(a.execution(1), first)).toBe('retired')
    expect(await dispatchClaimedWorkflowRun(b.execution(0), second)).toBe('ready')
  })

  it('replays the dispatch job body without another claim or recipient intent', async () => {
    const s = await setup()
    await dispatchDueWorkflowRuns(s.execution(0), { runId: s.run.id })
    const first = await savedRun(s.run.id)
    const recipients = await db
      .selectFrom('workflow_recipient_claims')
      .selectAll()
      .where('run_id', '=', s.run.id)
      .execute()
    await dispatchDueWorkflowRuns(s.execution(1), { runId: s.run.id })
    expect(await savedRun(s.run.id)).toEqual(first)
    expect(
      await db
        .selectFrom('workflow_recipient_claims')
        .selectAll()
        .where('run_id', '=', s.run.id)
        .execute(),
    ).toEqual(recipients)
  })

  it('repair advances beyond a full page whose first wake already exists', async () => {
    const a = await setup()
    const b = await setup()
    const queued = new Set<string>()
    const port = {
      ensureWake: async (_trx: Db, runId: string) => {
        queued.add(runId)
      },
    }
    // Other fixtures share this database, so scan more pages than there are unfinished rows.
    const candidates = await db
      .selectFrom('workflow_runs')
      .select('id')
      .where('state', 'in', ['pending', 'claimed'])
      .execute()
    for (let i = 0; i <= candidates.length; i++)
      await repairWorkflowRunWakes(a.execution(i % 2), port, 1)
    expect(queued.has(a.run.id)).toBe(true)
    expect(queued.has(b.run.id)).toBe(true)
    expect((await savedRun(a.run.id)).state).toBe('pending')
    expect((await savedRun(b.run.id)).state).toBe('pending')
  })
})
