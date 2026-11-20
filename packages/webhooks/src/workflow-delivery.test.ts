import { createHmac, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { workflowExecutionAuditRow, workflowJournal } from '../../workflows/src/testing.ts'
import {
  captureWorkflowWebhook,
  deliverWorkflowWebhook,
  WEBHOOK_DELIVERY_JOB,
  webhookBookingNotifier,
  webhookDeliveryJob,
} from './delivery.ts'
import { createWebhook } from './service.ts'
import type { WebhookRequest } from './transport.ts'
import {
  captureQueuedWorkflowWebhook,
  seedWorkflowWebhookRun,
} from './workflow-delivery-fixture.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2030-11-03T12:00Z')
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }
const privateAttendee = { name: 'Private Invitee', email: 'private-invitee@example.com' }
const privateAnswer = 'Private answer fixture'
const privateLocation = 'https://meeting.example/fixture-private-room'

describe.skipIf(!serverUrl)('workflow webhook outbox', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<ReturnType<typeof webhookDeliveryJob>[]>>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_hooks' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [webhookDeliveryJob({ db, ...settings })],
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

  async function fixture(personal = true) {
    const user = await createTestUser(db)
    const principal = personal
      ? user.principal
      : (await createTestTeam(db, [{ user, role: 'owner' }])).as(user)
    const organizationId = principal.organization.id
    const ctx = testContext(db, principal, () => now)
    async function endpoint(path: string, subscribed = true) {
      const result = await createWebhook(ctx, settings, {
        url: `https://hooks.example.com/${path}`,
        events: ['booking.created'],
      })
      // Seed the stored subscription without bypassing the production hard-off guard.
      if (subscribed)
        await db
          .updateTable('webhooks')
          .set({ events: ['booking.created', 'workflow.executed'] })
          .where('id', '=', result.webhook.id)
          .execute()
      return result
    }
    const f = createFixtures(db)
    const eventTypeId = await f.eventType(organizationId, personal ? user.id : null, {
      hosts: [{ userId: user.id }],
    })
    const previous = await f.booking(
      organizationId,
      [user.id],
      '2030-11-02T09:00Z',
      '2030-11-02T09:30Z',
      { status: 'cancelled' },
    )
    const bookingId = await f.booking(
      organizationId,
      [user.id],
      '2030-11-03T09:00Z',
      '2030-11-03T09:30Z',
      { eventTypeId, attendee: privateAttendee },
    )
    await db
      .updateTable('bookings')
      .set({
        rescheduled_from_id: previous,
        responses: JSON.stringify({ question: privateAnswer }),
        location: JSON.stringify({ type: 'link', url: privateLocation }),
      })
      .where('id', '=', bookingId)
      .execute()
    const { webhook, secret } = await endpoint('selected')
    const seed = () =>
      seedWorkflowWebhookRun(ctx, {
        bookingId,
        webhookId: webhook.id,
        eventTypeId,
        owner: personal ? { kind: 'personal', id: user.id } : { kind: 'team', id: organizationId },
        trigger: { type: 'after_end', offsetMinutes: 150 },
        capturedAt: now.subtract({ hours: 24 }),
      })
    const { capture: input } = await seed()
    return { input, seed, endpoint, eventTypeId, webhook, secret, previous }
  }

  const deliveries = (bookingId: string) =>
    db.selectFrom('webhook_deliveries').selectAll().where('booking_id', '=', bookingId).execute()

  async function queued(deliveryId: string) {
    const result = await owned.pool.query<{ data: unknown }>(
      "SELECT data FROM pgboss.job WHERE name=$1 AND data->>'deliveryId'=$2",
      [WEBHOOK_DELIVERY_JOB, deliveryId],
    )
    return result.rows.map((row) => row.data)
  }

  it.each([true, false])(
    'captures distinct runs once each and signs the exact field allow-list (personal=%s)',
    async (personal) => {
      const { input, seed, endpoint, eventTypeId, webhook, secret, previous } =
        await fixture(personal)
      await endpoint('also-subscribed')
      const { capture: second } = await seed()
      const capture = (event: typeof input) =>
        db
          .transaction()
          .execute((trx) => captureQueuedWorkflowWebhook(jobs, settings, trx, event, now))
      await expect(Promise.all([capture(input), capture(input), capture(second)])).resolves.toEqual(
        [undefined, undefined, undefined],
      )
      const rows = await deliveries(input.bookingId)
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.id)).size).toBe(2)
      expect(new Set(rows.map((row) => row.event_id)).size).toBe(2)
      expect(new Set(rows.map((row) => row.workflow_run_id))).toEqual(
        new Set([input.workflowRunId, second.workflowRunId]),
      )

      const requests: WebhookRequest[] = []
      const productionQueries: string[] = []
      const deps = {
        db,
        ...settings,
        now: () => now,
        transport: async (request: WebhookRequest) => {
          requests.push(request)
          return 204
        },
      }
      const productionJob = webhookDeliveryJob({
        ...deps,
        workflowsEnabled: true,
        db: db.withPlugin({
          transformQuery({ node }) {
            productionQueries.push(node.kind)
            return node
          },
          async transformResult({ result }) {
            return result
          },
        }),
      })
      for (const row of rows) {
        expect(row.webhook_id).toBe(webhook.id)
        expect(row.request_id).toBeNull()
        expect(await queued(row.id)).toEqual([{ deliveryId: row.id }])
        const signal = new AbortController().signal
        productionQueries.length = 0
        await productionJob.handler(
          { deliveryId: row.id },
          { id: randomUUID(), attempt: 1, signal },
        )
        // Only ordinary delivery classification runs while workflow execution is hard-off.
        expect(productionQueries).toEqual(['SelectQueryNode', 'SelectQueryNode', 'SelectQueryNode'])
        expect((await deliveries(input.bookingId)).find(({ id }) => id === row.id)).toEqual(row)
        expect(requests.filter(({ headers }) => headers['webhook-id'] === row.id)).toHaveLength(0)
        await deliverWorkflowWebhook(deps, row.id, signal)
        await deliverWorkflowWebhook(deps, row.id, signal, 2)
      }
      expect(requests).toHaveLength(2)
      const events = await workflowJournal(db, input.organizationId)
        .where('action', 'in', ['workflow.webhook_queued', 'workflow.webhook_completed'])
        .execute()
      expect(events).toHaveLength(4)
      for (const captured of [input, second]) {
        expect(events.filter(({ target_id }) => target_id === captured.workflowId)).toEqual(
          (['workflow.webhook_queued', 'workflow.webhook_completed'] as const).map((action) =>
            workflowExecutionAuditRow(
              input.organizationId,
              captured.workflowId,
              action,
              'dispatch',
              {
                revision: captured.workflowRevision,
                trigger: captured.trigger,
              },
            ),
          ),
        )
      }
      for (const [index, request] of requests.entries()) {
        const row = rows[index]
        const captured = row?.workflow_run_id === input.workflowRunId ? input : second
        expect(request.url).toBe(webhook.url)
        expect(request.headers['webhook-id']).toBe(row?.id)
        expect(request.headers['webhook-event-id']).toBe(row?.event_id)
        const timestamp = String(Math.floor(now.epochMilliseconds / 1000))
        expect(request.headers['webhook-timestamp']).toBe(timestamp)
        const signature = createHmac('sha256', secret)
          .update(`${timestamp}.${request.body}`)
          .digest('hex')
        expect(request.headers['webhook-signature']).toBe(`v1=${signature}`)
        expect(request.body).toBe(row?.payload)
        expect(JSON.parse(request.body)).toEqual({
          id: row?.event_id,
          type: 'workflow.executed',
          occurredAt: now.toString(),
          data: {
            bookingId: input.bookingId,
            organizationId: input.organizationId,
            eventTypeId,
            start: '2030-11-03T09:00:00.000Z',
            end: '2030-11-03T09:30:00.000Z',
            status: 'confirmed',
            workflowId: captured.workflowId,
            workflowRevision: captured.workflowRevision,
            trigger: captured.trigger,
            workflowRunId: row?.workflow_run_id,
            ...(personal ? { source: 'api', rescheduledFromId: previous } : {}),
          },
        })
      }
    },
  )

  it('keeps the delivery and queued job in the caller transaction', async () => {
    const { input } = await fixture()
    const journal = (connection: Db = db) =>
      workflowJournal(connection, input.organizationId)
        .where('action', '=', 'workflow.webhook_queued')
        .execute()
    let rolledBackId: string | undefined
    await expect(
      db.transaction().execute(async (trx) => {
        await captureWorkflowWebhook(jobs, settings, trx, input, now)
        const row = await trx
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('workflow_run_id', '=', input.workflowRunId)
          .executeTakeFirstOrThrow()
        rolledBackId = row.id
        expect(await queued(row.id)).toEqual([])
        expect(await journal()).toEqual([])
        expect(await journal(trx)).toEqual([
          workflowExecutionAuditRow(
            input.organizationId,
            input.workflowId,
            'workflow.webhook_queued',
            'dispatch',
            {
              revision: input.workflowRevision,
              trigger: input.trigger,
            },
          ),
        ])
        throw new Error('rollback workflow fixture')
      }),
    ).rejects.toThrow('rollback workflow fixture')
    expect(rolledBackId).toBeDefined()
    expect(await deliveries(input.bookingId)).toEqual([])
    expect(await queued(rolledBackId as string)).toEqual([])
    expect(await journal()).toEqual([])
  })

  it('records only the terminal failure across retries and leaves booking webhook delivery alone', async () => {
    const { input } = await fixture()
    const privateError = 'Private receiver error fixture'
    const journal = () =>
      workflowJournal(db, input.organizationId)
        .where('action', 'like', 'workflow.webhook_%')
        .execute()
    const requests: WebhookRequest[] = []
    const deps = {
      db,
      ...settings,
      now: () => now,
      transport: async (request: WebhookRequest) => {
        requests.push(request)
        if (JSON.parse(request.body).type === 'workflow.executed') throw new Error(privateError)
        return 204
      },
    }
    await db.transaction().execute(async (trx) => {
      await captureQueuedWorkflowWebhook(jobs, settings, trx, input, now)
      await webhookBookingNotifier(jobs, settings)(
        trx,
        { type: 'created', bookingId: input.bookingId, start: now.subtract({ hours: 3 }) },
        now,
      )
    })
    const rows = await deliveries(input.bookingId)
    const workflow = rows.find((row) => row.event_type === 'workflow.executed')
    const booking = rows.find((row) => row.event_type === 'booking.created')
    if (!workflow || !booking) throw new Error('Missing fixture deliveries')
    const signal = new AbortController().signal
    await webhookDeliveryJob(deps).handler(
      { deliveryId: booking.id },
      { id: randomUUID(), attempt: 1, signal },
    )
    await expect(deliverWorkflowWebhook(deps, workflow.id, signal)).rejects.toThrow(
      'Webhook delivery failed',
    )
    const queued = workflowExecutionAuditRow(
      input.organizationId,
      input.workflowId,
      'workflow.webhook_queued',
      'dispatch',
      {
        revision: input.workflowRevision,
        trigger: input.trigger,
      },
    )
    expect(await journal()).toEqual([queued])
    await expect(deliverWorkflowWebhook(deps, workflow.id, signal, 13)).rejects.toThrow(
      'Webhook delivery failed',
    )
    await deliverWorkflowWebhook(deps, workflow.id, signal, 13)
    expect(requests).toHaveLength(3)
    expect(await journal()).toEqual([queued, { ...queued, action: 'workflow.webhook_failed' }])
    expect(await deliveries(input.bookingId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: booking.id, status: 'delivered' }),
        expect.objectContaining({
          id: workflow.id,
          status: 'failed',
          last_error: 'transport_error',
        }),
      ]),
    )
  })

  it('requires the selected endpoint to be active and subscribed in the booking organization', async () => {
    const { input, endpoint, webhook } = await fixture()
    const other = await fixture()
    const unsubscribed = await endpoint('unsubscribed', false)
    await db
      .updateTable('webhooks')
      .set({ is_active: false })
      .where('id', '=', webhook.id)
      .execute()
    for (const invalid of [
      input,
      { ...input, webhookId: other.webhook.id },
      { ...input, webhookId: unsubscribed.webhook.id },
      { ...other.input, bookingId: input.bookingId },
    ])
      await db
        .transaction()
        .execute((trx) => captureWorkflowWebhook(jobs, settings, trx, invalid, now))
    expect(await deliveries(input.bookingId)).toEqual([])
    expect(await deliveries(other.input.bookingId)).toEqual([])
  })
})
