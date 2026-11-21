import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureBookingWorkflows } from './capture.ts'
import { createWorkflowDefinition } from './creates.ts'
import { workflowJobs } from './dispatcher.ts'
import { WORKFLOW_RETENTION_BATCH } from './retention.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('workflow retention job', () => {
  let owned: TestDatabase
  let db: Db
  let old: Date
  let recent: Date

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_retention' })
    db = createDb(owned.pool)
    const times = await db
      .selectNoFrom([
        sql<Date>`transaction_timestamp() - interval '744 hours'`.as('old'),
        sql<Date>`transaction_timestamp() - interval '696 hours'`.as('recent'),
      ])
      .executeTakeFirstOrThrow()
    old = times.old
    recent = times.recent
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function workflowFixture() {
    const user = await createTestUser(db)
    const organizationId = user.principal.organization.id
    const workflow = await createWorkflowDefinition(
      { db, principal: user.principal },
      {
        owner: { kind: 'personal', id: user.id },
        idempotencyKey: randomUUID(),
        name: 'Retention fixture',
        scope: { type: 'all_event_types' },
        trigger: { type: 'booking.created', delayMinutes: 0 },
        actions: [{ type: 'email', recipients: ['booker'] }],
        enabled: true,
      },
    )
    return { user, organizationId, workflowId: workflow.id }
  }

  async function seedRuns(
    { organizationId, workflowId }: Awaited<ReturnType<typeof workflowFixture>>,
    count: number,
  ) {
    const bookings = await db
      .insertInto('bookings')
      .values(
        Array.from({ length: count }, () => ({
          organization_id: organizationId,
          start_at: old,
          end_at: recent,
          title: 'Retention fixture',
          source: 'web',
        })),
      )
      .returning('id')
      .execute()
    const enrollments = await db
      .insertInto('workflow_enrollments')
      .values(
        bookings.map(({ id }) => ({
          organization_id: organizationId,
          booking_id: id,
          workflow_id: workflowId,
          revision: 1,
          occurrence: 'created',
          trigger: 'booking.created',
        })),
      )
      .returning(['id', 'booking_id'])
      .execute()
    return db
      .insertInto('workflow_runs')
      .values(
        enrollments.map((enrollment) => ({
          organization_id: organizationId,
          enrollment_id: enrollment.id,
          booking_id: enrollment.booking_id,
          due_at: old,
          expires_at: recent,
          created_at: old,
        })),
      )
      .returningAll()
      .execute()
  }

  type Run = Awaited<ReturnType<typeof seedRuns>>[number]

  async function finishRuns(
    workflowId: string,
    runs: Run[],
    state: 'completed' | 'skipped' | 'retired' = 'completed',
    finishedAt = old,
  ) {
    const reason = state === 'skipped' ? 'condition_false' : null
    await db
      .updateTable('workflow_runs')
      .set({
        state,
        finished_at: finishedAt,
        skip_reason: reason,
        claim_token: null,
        lease_until: null,
      })
      .where(
        'id',
        'in',
        runs.map(({ id }) => id),
      )
      .execute()
    await db
      .insertInto('workflow_run_history')
      .values(
        runs.map((run) => ({
          run_id: run.id,
          organization_id: run.organization_id,
          workflow_id: workflowId,
          revision: 1,
          trigger: 'booking.created',
          due_at: run.due_at,
          finished_at: finishedAt,
          outcome: state,
          reason,
        })),
      )
      .execute()
  }

  const runIds = (organizationId: string) =>
    db
      .selectFrom('workflow_runs')
      .select('id')
      .where('organization_id', '=', organizationId)
      .orderBy('id')
      .execute()
  const historyIds = (organizationId: string) =>
    db
      .selectFrom('workflow_run_history')
      .select('run_id as id')
      .where('organization_id', '=', organizationId)
      .orderBy('id')
      .execute()
  const claimRunIds = (organizationId: string) =>
    db
      .selectFrom('workflow_recipient_claims')
      .select('run_id as id')
      .where('organization_id', '=', organizationId)
      .orderBy('id')
      .execute()

  function purge() {
    const jobs = workflowJobs(
      { db, now: () => Temporal.Now.instant(), workflowsEnabled: true },
      { ensureWake: async () => {} },
      async () => {},
    )
    return jobs[2].handler(
      {},
      { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
    )
  }

  it('purges only aged terminal runs and their claims, expires history, and retains audit and enrollment replay protection', async () => {
    const fixture = await workflowFixture()
    const { organizationId, workflowId, user } = fixture
    const fixtures = createFixtures(db)
    const eventTypeId = await fixtures.eventType(organizationId, user.id, { slug: 'retention' })
    const start = Temporal.Instant.fromEpochMilliseconds(recent.getTime())
    const bookingId = await fixtures.booking(
      organizationId,
      [user.id],
      start.toString(),
      start.add({ minutes: 30 }).toString(),
      { eventTypeId },
    )
    const capture = () =>
      db
        .transaction()
        .execute((trx) =>
          captureBookingWorkflows(
            trx,
            { type: 'created', bookingId, start },
            Temporal.Instant.fromEpochMilliseconds(old.getTime()),
            'synthetic-retention-fixture',
          ),
        )
    await capture()
    const completed = await db
      .selectFrom('workflow_runs')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    const [skipped, retired, pending, claimed, fresh, interrupted, webhook] = (await seedRuns(
      fixture,
      7,
    )) as [Run, Run, Run, Run, Run, Run, Run]
    await db
      .insertInto('workflow_recipient_claims')
      .values(
        [skipped, retired, pending, claimed, fresh, interrupted].map((run) => ({
          organization_id: organizationId,
          run_id: run.id,
          booking_id: run.booking_id,
          recipient: `attendee:${randomUUID()}`,
          recipient_hash: Buffer.alloc(32, 1),
        })),
      )
      .execute()
    const token = randomUUID()
    await db
      .updateTable('workflow_runs')
      .set({ state: 'claimed', claim_token: token, lease_until: recent })
      .where('id', 'in', [claimed.id, interrupted.id])
      .execute()
    await db
      .updateTable('workflow_recipient_claims')
      .set({ state: 'dispatching', attempts: 1, claim_token: token })
      .where('run_id', '=', interrupted.id)
      .execute()
    await finishRuns(workflowId, [completed])
    await finishRuns(workflowId, [skipped], 'skipped')
    await finishRuns(workflowId, [retired, interrupted], 'retired')
    await finishRuns(workflowId, [fresh], 'completed', recent)
    await finishRuns(workflowId, [webhook])
    const endpoint = await db
      .insertInto('webhooks')
      .values({
        organization_id: organizationId,
        url: 'https://example.test/webhook',
        events: ['workflow.executed'],
        secret_ciphertext: Buffer.from('synthetic-retention-fixture'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const delivery = await db
      .insertInto('webhook_deliveries')
      .values({
        webhook_id: endpoint.id,
        organization_id: organizationId,
        booking_id: webhook.booking_id,
        workflow_run_id: webhook.id,
        event_id: randomUUID(),
        event_type: 'workflow.executed',
        payload: '{}',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const enrollments = () =>
      db
        .selectFrom('workflow_enrollments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute()
    const audit = () =>
      db
        .selectFrom('audit_events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute()
    const originalEnrollments = await enrollments()
    const originalAudit = await audit()
    expect(originalEnrollments).toHaveLength(8)
    expect(originalAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'workflow.run_scheduled' })]),
    )
    expect(await claimRunIds(organizationId)).toHaveLength(7)

    await expect(purge()).resolves.toBeUndefined()

    const ids = (runs: Run[]) =>
      runs
        .map(({ id }) => id)
        .sort()
        .map((id) => ({ id }))
    const keptClaims = [pending, claimed, fresh, interrupted]
    expect(await runIds(organizationId)).toEqual(ids([...keptClaims, webhook]))
    expect(await claimRunIds(organizationId)).toEqual(ids(keptClaims))
    expect(await historyIds(organizationId)).toEqual([{ id: fresh.id }])
    await capture()
    expect(await enrollments()).toEqual(originalEnrollments)
    expect(await audit()).toEqual(originalAudit)
    expect(await runIds(organizationId)).toEqual(ids([...keptClaims, webhook]))

    await db
      .updateTable('webhook_deliveries')
      .set({ status: 'failed' })
      .where('id', '=', delivery.id)
      .execute()
    await purge()
    expect(await runIds(organizationId)).toEqual(ids(keptClaims))
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('status')
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'failed' })
  })

  it('limits each invocation to one batch of runs and history', async () => {
    const fixture = await workflowFixture()
    const runs = await seedRuns(fixture, WORKFLOW_RETENTION_BATCH + 1)
    const [last] = runs
      .map(({ id }) => id)
      .sort()
      .slice(-1)
    await finishRuns(fixture.workflowId, runs)

    await purge()
    expect(await runIds(fixture.organizationId)).toEqual([{ id: last }])
    expect(await historyIds(fixture.organizationId)).toEqual([{ id: last }])

    await purge()
    expect(await runIds(fixture.organizationId)).toEqual([])
    expect(await historyIds(fixture.organizationId)).toEqual([])
  })

  it('lets concurrent invocations skip locked rows and pick them up on a later pass', async () => {
    const fixture = await workflowFixture()
    const runs = await seedRuns(fixture, 3)
    const [locked] = runs.map(({ id }) => id).sort() as [string, ...string[]]
    await finishRuns(fixture.workflowId, runs)

    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('workflow_runs')
        .select('id')
        .where('id', '=', locked)
        .forUpdate()
        .execute()
      await trx
        .selectFrom('workflow_run_history')
        .select('run_id')
        .where('run_id', '=', locked)
        .forUpdate()
        .execute()
      await Promise.all([purge(), purge()])
      expect(await runIds(fixture.organizationId)).toEqual([{ id: locked }])
      expect(await historyIds(fixture.organizationId)).toEqual([{ id: locked }])
    })

    await purge()
    expect(await runIds(fixture.organizationId)).toEqual([])
    expect(await historyIds(fixture.organizationId)).toEqual([])
  })
})
