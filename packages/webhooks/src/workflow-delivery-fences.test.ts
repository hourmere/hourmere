import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { cancelHostBooking } from '@hourmere/scheduling'
import type { WorkflowAuditPort, WorkflowAuditRecord } from '@hourmere/workflows'
import { ColumnNode, type QueryId, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { captureBookingWorkflows } from '../../workflows/src/capture.ts'
import {
  createRecordingWorkflowAudit,
  expectWorkflowAuditRedacted,
} from '../../workflows/src/testing.ts'
import { updateWorkflowDefinition } from '../../workflows/src/updates.ts'
import {
  deliverWorkflowWebhook,
  WEBHOOK_DELIVERY_JOB,
  webhookCleanupJob,
  webhookDeliveryJob,
} from './delivery.ts'
import type { WebhookRequest, WebhookTransport } from './transport.ts'
import { workflowDeliveryDueAt, workflowDeliveryFixture } from './workflow-delivery-fixture.ts'

const serverUrl = process.env.DATABASE_URL
const signal = () => new AbortController().signal
const expiry = workflowDeliveryDueAt.add({ minutes: 60 })
type Fixture = Awaited<ReturnType<typeof workflowDeliveryFixture>>

function auditIdentity(fixture: Fixture) {
  return {
    owner: {
      kind: 'personal',
      userId: fixture.ctx.principal.user.id,
      organizationId: fixture.ctx.principal.organization.id,
    },
    workflowId: fixture.workflow.id,
    revision: fixture.workflow.revision,
    trigger: fixture.workflow.trigger.type,
  }
}

function expectPrivateDeliveryDataAbsent(events: WorkflowAuditRecord[], fixture: Fixture) {
  expectWorkflowAuditRedacted(events, [
    'Invitee',
    'invitee@example.com',
    'Fixture booking',
    fixture.webhook.url,
    fixture.secret,
    fixture.settings.encryptionKey,
    fixture.bookingId,
    fixture.delivery.payload,
  ])
}

describe.skipIf(!serverUrl)('workflow webhook delivery fences', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<ReturnType<typeof webhookDeliveryJob>[]>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_hook_fences' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [webhookDeliveryJob({ db, enabled: false })],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    await jobs.start()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  const saved = (deliveryId: string) =>
    db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .executeTakeFirstOrThrow()

  function send(
    fixture: Fixture,
    transport: WebhookTransport,
    attempt = 1,
    workflowAudit?: WorkflowAuditPort,
  ) {
    return deliverWorkflowWebhook(
      { db, ...fixture.settings, now: fixture.ctx.now, transport, workflowAudit },
      fixture.delivery.id,
      signal(),
      attempt,
    )
  }

  it('expires an unstarted delivery exactly at due plus sixty minutes', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    const audit = await createRecordingWorkflowAudit(db)
    fixture.clock.now = expiry
    const receiver = vi.fn(async () => 204)
    // pg-boss can count a killed worker even though no network attempt began.
    await send(fixture, receiver, 2, audit.port)
    await send(fixture, receiver, 3, audit.port)
    expect(await saved(fixture.delivery.id)).toMatchObject({
      status: 'skipped',
      last_error: 'expired',
      attempts: 0,
      last_attempt_at: null,
    })
    expect(receiver).not.toHaveBeenCalled()
    const events = await audit.read()
    expectPrivateDeliveryDataAbsent(events, fixture)
    expect(events).toEqual([
      {
        ...auditIdentity(fixture),
        event: 'workflow.webhook_failed',
        actor: { kind: 'background', job: 'dispatch' },
        occurredAt: expiry,
        reason: 'expired',
      },
    ])
  })

  it.each(['deadline', 'abort'] as const)(
    'clears a fresh first-attempt marker when %s wins before transport',
    async (change) => {
      const fixture = await workflowDeliveryFixture(db, jobs)
      fixture.clock.now = expiry.subtract({ milliseconds: 1 })
      const abort = new AbortController()
      const markers = new WeakSet<QueryId>()
      let advanced = false
      const markedDb = db.withPlugin({
        transformQuery({ node, queryId }) {
          if (node.kind === 'UpdateQueryNode') {
            const column = node.updates?.[0]?.column
            if (
              node.updates?.length === 1 &&
              column &&
              ColumnNode.is(column) &&
              column.column.name === 'last_attempt_at'
            )
              markers.add(queryId)
          }
          return node
        },
        async transformResult({ queryId, result }) {
          if (!advanced && markers.has(queryId)) {
            advanced = true
            if (change === 'deadline') fixture.clock.now = expiry
            else abort.abort()
          }
          return result
        },
      })
      const receiver = vi.fn(async () => 204)
      const delivery = deliverWorkflowWebhook(
        { db: markedDb, ...fixture.settings, now: fixture.ctx.now, transport: receiver },
        fixture.delivery.id,
        abort.signal,
      )
      if (change === 'deadline') await expect(delivery).resolves.toBeUndefined()
      else await expect(delivery).rejects.toThrow('Webhook delivery interrupted')
      expect(advanced).toBe(true)
      expect(receiver).not.toHaveBeenCalled()
      expect(await saved(fixture.delivery.id)).toMatchObject({
        last_attempt_at: null,
        ...(change === 'deadline'
          ? { status: 'skipped', last_error: 'expired', attempts: 0 }
          : { status: 'pending', last_error: 'interrupted', attempts: 1 }),
      })
      if (change === 'abort') {
        fixture.clock.now = expiry
        await send(fixture, receiver, 2)
        expect(receiver).not.toHaveBeenCalled()
        expect(await saved(fixture.delivery.id)).toMatchObject({
          status: 'skipped',
          last_error: 'expired',
          last_attempt_at: null,
        })
      }
    },
  )

  it('retries a timely delivery past expiry with the original ID for receiver deduplication', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    const accepted = new Map<string, string>()
    const receiver = vi.fn(async ({ headers, body }: WebhookRequest) => {
      const id = headers['webhook-id'] as string
      if (accepted.has(id)) return 204
      accepted.set(id, body)
      // The receiver performed the side effect, but its acknowledgement was lost.
      throw new Error('fake receiver disconnected')
    })
    fixture.clock.now = expiry.subtract({ milliseconds: 1 })
    await expect(send(fixture, receiver)).rejects.toThrow('Webhook delivery failed')
    expect(await saved(fixture.delivery.id)).toMatchObject({ status: 'pending', attempts: 1 })

    fixture.clock.now = expiry.add({ hours: 1 })
    await expect(send(fixture, receiver, 2)).resolves.toBeUndefined()
    const delivery = await saved(fixture.delivery.id)
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(accepted).toEqual(new Map([[fixture.delivery.id, fixture.delivery.payload]]))
    expect(receiver.mock.calls.map(([request]) => request.headers['webhook-id'])).toEqual([
      fixture.delivery.id,
      fixture.delivery.id,
    ])
    expect(receiver.mock.calls.map(([request]) => request.headers['webhook-event-id'])).toEqual([
      fixture.delivery.event_id,
      fixture.delivery.event_id,
    ])
  })

  it('keeps a timely first-attempt marker when the acknowledgement transaction rolls back', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    const audit = await createRecordingWorkflowAudit(db)
    const began = expiry.subtract({ seconds: 1 })
    fixture.clock.now = began
    const crash = new Error('synthetic acknowledgement rollback')
    const abortAcknowledgement: WorkflowAuditPort = {
      async record(trx, event) {
        await audit.port.record(trx, event)
        throw crash
      },
    }
    const receiver = vi.fn(async (_request: WebhookRequest) => 204)
    await expect(send(fixture, receiver, 1, abortAcknowledgement)).rejects.toBe(crash)
    expect(receiver).toHaveBeenCalledTimes(1)
    expect(await saved(fixture.delivery.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_attempt_at: new Date(began.epochMilliseconds),
    })
    expect(await audit.read()).toEqual([])

    fixture.clock.now = expiry.add({ hours: 1 })
    await send(fixture, receiver, 2, audit.port)
    await send(fixture, receiver, 3, audit.port)
    expect(await saved(fixture.delivery.id)).toMatchObject({ status: 'delivered', attempts: 2 })
    expect(receiver.mock.calls.map(([request]) => request.headers['webhook-id'])).toEqual([
      fixture.delivery.id,
      fixture.delivery.id,
    ])
    const events = await audit.read()
    expectPrivateDeliveryDataAbsent(events, fixture)
    expect(events).toEqual([
      {
        ...auditIdentity(fixture),
        event: 'workflow.webhook_completed',
        actor: { kind: 'background', job: 'dispatch' },
        occurredAt: fixture.clock.now,
      },
    ])
  })

  it.each(['cancel', 'disable'] as const)(
    'stops an in-flight job before transport when %s commits first',
    async (change) => {
      const fixture = await workflowDeliveryFixture(db, jobs)
      const receiver = vi.fn(async () => 204)
      const { promise: locked, resolve: reached } = Promise.withResolvers<number>()
      const { promise: release, resolve: resume } = Promise.withResolvers<void>()
      async function pause(trx: Db) {
        const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        reached(result.rows[0]?.pid as number)
        await release
      }
      const mutation =
        change === 'disable'
          ? updateWorkflowDefinition(
              {
                ...fixture.ctx,
                prepareOrganizationWrite: async (trx) => {
                  await trx
                    .selectFrom('workflow_definitions')
                    .select('id')
                    .where('id', '=', fixture.workflow.id)
                    .forUpdate()
                    .executeTakeFirstOrThrow()
                  await pause(trx)
                },
              },
              fixture.workflow.id,
              { expectedRevision: fixture.workflow.revision, enabled: false },
            )
          : cancelHostBooking(
              {
                ...fixture.ctx,
                notify: async (trx, event, now) => {
                  await captureBookingWorkflows(trx, event, now, 'synthetic-workflow-fixture')
                  await pause(trx)
                },
              },
              fixture.bookingId,
            )
      const pid = await Promise.race([
        locked,
        mutation.then(() => {
          throw new Error('Mutation finished without acquiring its fixture lock')
        }),
      ])
      const delivery = send(fixture, receiver)
      try {
        let blocked = false
        for (let i = 0; i < 1000 && !blocked; i++) {
          const result = await owned.pool.query(
            `SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          )
          blocked = result.rowCount === 1
        }
        expect(blocked).toBe(true)
        expect(receiver).not.toHaveBeenCalled()
      } finally {
        resume()
        await Promise.all([mutation, delivery])
      }
      expect(receiver).not.toHaveBeenCalled()
      expect(await saved(fixture.delivery.id)).toMatchObject({
        status: 'skipped',
        last_error: 'disabled',
        attempts: 0,
      })
    },
  )

  it('rechecks workflow eligibility during a post-expiry retry and consumes the pending delivery', async () => {
    const fixture = await workflowDeliveryFixture(db, jobs)
    const audit = await createRecordingWorkflowAudit(db)
    const receiver = vi.fn(async () => 503)
    await expect(send(fixture, receiver, 1, audit.port)).rejects.toThrow('Webhook delivery failed')
    expect(await audit.read()).toEqual([])
    await updateWorkflowDefinition(fixture.ctx, fixture.workflow.id, {
      expectedRevision: fixture.workflow.revision,
      enabled: false,
    })
    fixture.clock.now = expiry.add({ minutes: 1 })
    await send(fixture, receiver, 2, audit.port)
    expect(await saved(fixture.delivery.id)).toMatchObject({
      status: 'skipped',
      last_error: 'disabled',
      attempts: 1,
    })

    await updateWorkflowDefinition(fixture.ctx, fixture.workflow.id, {
      expectedRevision: fixture.workflow.revision,
      enabled: true,
    })
    await send(fixture, receiver, 3, audit.port)
    expect(receiver).toHaveBeenCalledTimes(1)
    expect(await saved(fixture.delivery.id)).toMatchObject({ status: 'skipped' })
    const events = await audit.read()
    expectPrivateDeliveryDataAbsent(events, fixture)
    expect(events).toEqual([
      {
        ...auditIdentity(fixture),
        event: 'workflow.webhook_failed',
        actor: { kind: 'background', job: 'dispatch' },
        occurredAt: fixture.clock.now,
      },
    ])
  })

  it('reuses bounded reconciliation for a workflow delivery that lost its queue job', async () => {
    const audit = await createRecordingWorkflowAudit(db)
    const { delivery: live } = await workflowDeliveryFixture(db, jobs)
    const fixture = await workflowDeliveryFixture(db, jobs)
    const { delivery: orphan } = fixture
    await owned.pool.query('DELETE FROM pgboss.job WHERE name=$1 AND singleton_key=$2', [
      WEBHOOK_DELIVERY_JOB,
      orphan.id,
    ])
    const ordinary = await db
      .insertInto('webhook_deliveries')
      .values({
        webhook_id: orphan.webhook_id,
        organization_id: orphan.organization_id,
        booking_id: orphan.booking_id,
        event_id: randomUUID(),
        event_type: 'booking.created',
        payload: '{}',
        created_at: orphan.created_at,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const tick = (port: WorkflowAuditPort) =>
      webhookCleanupJob(db, fixture.ctx.now, port).handler(
        {},
        {
          id: randomUUID(),
          signal: signal(),
          attempt: 1,
        },
      )
    const rollback = new Error('Workflow audit rejected reconciliation')
    await expect(
      tick({
        async record(trx, record) {
          await audit.port.record(trx, record)
          expectPrivateDeliveryDataAbsent(await audit.read(trx), fixture)
          throw rollback
        },
      }),
    ).rejects.toBe(rollback)
    expect(await audit.read()).toEqual([])
    expect(await saved(orphan.id)).toMatchObject({ status: 'pending' })
    expect(await saved(ordinary.id)).toMatchObject({ status: 'failed', last_error: 'job_missing' })

    await tick(audit.port)
    await tick(audit.port)
    expect(await saved(live.id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(await saved(orphan.id)).toMatchObject({
      status: 'failed',
      last_error: 'job_missing',
      attempts: 0,
    })
    const events = await audit.read()
    expectPrivateDeliveryDataAbsent(events, fixture)
    expect(events).toEqual([
      {
        ...auditIdentity(fixture),
        event: 'workflow.webhook_failed',
        actor: { kind: 'background', job: 'repair' },
        occurredAt: fixture.clock.now,
      },
    ])
  })
})
