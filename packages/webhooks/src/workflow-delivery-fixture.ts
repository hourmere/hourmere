import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { type WorkflowTrigger, workflowRunTiming } from '@hourmere/workflows'
import { createWorkflowDefinition } from '../../workflows/src/creates.ts'
import { captureWorkflowWebhook, type WebhookQueue } from './delivery.ts'
import { createWebhook, type WebhookSettings } from './service.ts'

export const workflowDeliveryDueAt = Temporal.Instant.from('2030-11-03T12:00Z')
const defaultSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }

export async function seedWorkflowWebhookRun(
  ctx: ReturnType<typeof testContext>,
  input: {
    bookingId: string
    webhookId: string
    eventTypeId: string
    owner: { kind: 'personal' | 'team'; id: string }
    trigger: WorkflowTrigger & { type: 'booking.created' | 'after_end' }
    capturedAt: Temporal.Instant
  },
) {
  const { db, principal } = ctx
  const { bookingId, webhookId, eventTypeId, owner, trigger, capturedAt } = input
  const organizationId = principal.organization.id
  const workflow = await createWorkflowDefinition(ctx, {
    owner,
    idempotencyKey: randomUUID(),
    name: 'Workflow webhook fixture',
    scope: { type: 'event_type', eventTypeId },
    trigger,
    actions: [{ type: 'webhook', webhookId }],
    enabled: true,
  })
  const booking = await db
    .selectFrom('bookings')
    .select(['start_at', 'end_at'])
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow()
  const { dueAt, expiresAt } = workflowRunTiming(
    trigger,
    {
      start: Temporal.Instant.fromEpochMilliseconds(booking.start_at.getTime()),
      end: Temporal.Instant.fromEpochMilliseconds(booking.end_at.getTime()),
    },
    capturedAt,
  )
  const run = await db.transaction().execute(async (trx) => {
    const enrollment = await trx
      .insertInto('workflow_enrollments')
      .values({
        organization_id: organizationId,
        booking_id: bookingId,
        workflow_id: workflow.id,
        revision: workflow.revision,
        occurrence: 'created',
        trigger: trigger.type,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return trx
      .insertInto('workflow_runs')
      .values({
        organization_id: organizationId,
        booking_id: bookingId,
        enrollment_id: enrollment.id,
        due_at: new Date(dueAt.epochMilliseconds),
        expires_at: new Date(expiresAt.epochMilliseconds),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  })
  return {
    workflow,
    run,
    capture: {
      webhookId,
      organizationId,
      bookingId,
      workflowId: workflow.id,
      workflowRevision: workflow.revision,
      trigger: trigger.type,
      workflowRunId: run.id,
    },
  }
}

export async function captureQueuedWorkflowWebhook(
  queue: WebhookQueue,
  settings: WebhookSettings,
  trx: Db,
  input: Awaited<ReturnType<typeof seedWorkflowWebhookRun>>['capture'],
  now: Temporal.Instant,
) {
  // The outbox handoff finishes dispatch. Delivery and retries then belong to its queued job.
  await trx
    .updateTable('workflow_runs')
    .set({ state: 'completed', finished_at: new Date(now.epochMilliseconds) })
    .where('id', '=', input.workflowRunId)
    .where('state', '=', 'pending')
    .execute()
  await captureWorkflowWebhook(queue, settings, trx, input, now)
}

export async function workflowDeliveryFixture(
  db: Db,
  queue: WebhookQueue,
  options: { url?: string; privateTargets?: WebhookSettings['privateTargets'] } = {},
) {
  const clock = { now: workflowDeliveryDueAt }
  const settings = { ...defaultSettings, privateTargets: options.privateTargets }
  const user = await createTestUser(db)
  const ctx = testContext(db, user.principal, () => clock.now)
  const organizationId = user.principal.organization.id
  const fixtures = createFixtures(db)
  const eventTypeId = await fixtures.eventType(organizationId, user.id)
  const bookingId = await fixtures.booking(
    organizationId,
    [user.id],
    workflowDeliveryDueAt.add({ hours: 12 }).toString(),
    workflowDeliveryDueAt.add({ hours: 12, minutes: 30 }).toString(),
    { eventTypeId },
  )
  const { webhook, secret } = await createWebhook(ctx, settings, {
    url: options.url ?? 'https://hooks.example.com/receiver',
    events: ['booking.created'],
  })
  // Seed the stored subscription while production keeps the workflow event hard-off.
  await db
    .updateTable('webhooks')
    .set({ events: ['booking.created', 'workflow.executed'] })
    .where('id', '=', webhook.id)
    .execute()
  const { workflow, run, capture } = await seedWorkflowWebhookRun(ctx, {
    bookingId,
    webhookId: webhook.id,
    eventTypeId,
    owner: { kind: 'personal', id: user.id },
    trigger: { type: 'booking.created', delayMinutes: 0 },
    capturedAt: workflowDeliveryDueAt,
  })
  await db
    .transaction()
    .execute((trx) => captureQueuedWorkflowWebhook(queue, settings, trx, capture, clock.now))
  const delivery = await db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('workflow_run_id', '=', run.id)
    .executeTakeFirstOrThrow()
  return { ctx, settings, clock, workflow, run, webhook, secret, delivery, bookingId, eventTypeId }
}
