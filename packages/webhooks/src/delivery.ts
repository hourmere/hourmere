import { randomUUID } from 'node:crypto'
import { ssoHardOff, type TeamSsoSession, teamSsoAccess } from '@hourmere/auth'
import { type Db, isImportedBooking, type WebhookDeliveries, type Webhooks } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import type { AttendeeNoShowNotifier, BookingEvent, BookingNotifier } from '@hourmere/scheduling'
import type { WorkflowAuditPort, WorkflowTriggerType } from '@hourmere/workflows'
import { workflowExecution } from '@hourmere/workflows/hard-off'
import { type Insertable, type Selectable, sql } from 'kysely'
import { z } from 'zod'
import { decryptWebhookSecret, webhookSignature } from './crypto.ts'
import type { WebhookEventType, WebhookSettings } from './service.ts'
import { SLACK_EVENTS, slackPayload, slackUrl } from './slack-format.ts'
import { sendWebhook, type WebhookTransport, webhookUrl } from './transport.ts'

export const WEBHOOK_DELIVERY_JOB = 'webhook-delivery'
export const WebhookDeliveryPayload = z.strictObject({
  deliveryId: z.uuid(),
  actor: z.strictObject({ userId: z.uuid(), sessionId: z.uuid() }).optional(),
})
export interface WebhookQueue {
  enqueue(
    name: typeof WEBHOOK_DELIVERY_JOB,
    payload: z.input<typeof WebhookDeliveryPayload>,
    options?: EnqueueOptions,
  ): Promise<string | null>
}
export interface WebhookDeps extends WebhookSettings {
  db: Db
  now?: (() => Temporal.Instant) | undefined
  workflowAudit?: WorkflowAuditPort | undefined
  /** Only isolated fixtures replace the built-in HTTP(S)/DNS transport. */
  transport?: WebhookTransport | undefined
  /** Only isolated fixtures shorten the Slack sender wait (SLACK_SENDER_WAIT_MS). */
  slackSenderWaitMs?: number | undefined
}

/**
 * Longest wait for another worker's send to the same Slack destination. With the 10 s
 * transport deadline it stays inside the 30 s job lease; a timed-out job retries later
 * with the normal backoff instead of holding a worker slot and pool connection.
 */
export const SLACK_SENDER_WAIT_MS = 10_000
const LOCK_NOT_AVAILABLE = '55P03'

/** Capture current changes only; the operator switch controls every destination kind. */
export function webhookBookingNotifier(
  queue: WebhookQueue,
  settings: WebhookSettings,
): BookingNotifier {
  return (trx, event, now) => captureBookingWebhook(queue, settings, trx, event, now)
}

/** Attendance changes never enter the mail/calendar notification pipeline. */
export function webhookAttendeeNoShowNotifier(
  queue: WebhookQueue,
  settings: WebhookSettings,
): AttendeeNoShowNotifier {
  return (trx, event, now) =>
    captureBookingWebhook(queue, settings, trx, { type: 'attendee_no_show_changed', ...event }, now)
}

interface WorkflowWebhookCapture {
  webhookId: string
  organizationId: string
  bookingId: string
  workflowId: string
  workflowRevision: number
  trigger: WorkflowTriggerType
  workflowRunId: string
}

/** Internal outbox capture for an authorized workflow run, within its transaction. */
export async function captureWorkflowWebhook(
  queue: WebhookQueue,
  settings: WebhookSettings,
  trx: Db,
  input: WorkflowWebhookCapture,
  now: Temporal.Instant,
  audit?: WorkflowAuditPort,
): Promise<void> {
  if (!settings.enabled) return
  if (!trx.isTransaction) throw new Error('Webhook capture requires the workflow transaction')
  const booking = await trx
    .selectFrom('bookings as b')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'b.organization_id')
    .select([
      'b.id',
      'b.organization_id',
      'b.event_type_id',
      'b.start_at',
      'b.end_at',
      'b.status',
      'b.source',
      'b.rescheduled_from_id',
      'p.user_id as personal_owner_id',
    ])
    .where('b.id', '=', input.bookingId)
    .where('b.organization_id', '=', input.organizationId)
    .executeTakeFirst()
  if (!booking || (await isImportedBooking(trx, booking.id))) return

  const eventType = 'workflow.executed'
  const endpoint = await trx
    .selectFrom('webhooks')
    .select('id')
    .where('id', '=', input.webhookId)
    .where('organization_id', '=', booking.organization_id)
    .where('destination_kind', '=', 'webhook')
    .where('is_active', '=', true)
    .where(sql<boolean>`${eventType} = ANY(events)`)
    .where((eb) =>
      eb.or([eb('event_type_id', 'is', null), eb('event_type_id', '=', booking.event_type_id)]),
    )
    .forShare()
    .executeTakeFirst()
  if (!endpoint) return

  const eventId = randomUUID()
  const inserted = await insertWebhookDelivery(queue, trx, {
    webhook_id: endpoint.id,
    organization_id: booking.organization_id,
    booking_id: booking.id,
    event_id: eventId,
    event_type: eventType,
    workflow_run_id: input.workflowRunId,
    payload: JSON.stringify({
      id: eventId,
      type: eventType,
      occurredAt: now.toString(),
      data: {
        bookingId: booking.id,
        organizationId: booking.organization_id,
        eventTypeId: booking.event_type_id,
        start: booking.start_at.toISOString(),
        end: booking.end_at.toISOString(),
        status: booking.status,
        ...(booking.personal_owner_id !== null && {
          source: booking.source,
          rescheduledFromId: booking.rescheduled_from_id,
        }),
        workflowId: input.workflowId,
        workflowRevision: input.workflowRevision,
        trigger: input.trigger,
        workflowRunId: input.workflowRunId,
      },
    }),
    created_at: new Date(now.epochMilliseconds),
  })
  if (!inserted) return
  const { hardOffWorkflowAuditPort } = await import('@hourmere/workflows')
  await (audit ?? hardOffWorkflowAuditPort()).record(trx, {
    event: 'workflow.webhook_queued',
    occurredAt: now,
    actor: { kind: 'background', job: 'dispatch' },
    owner: booking.personal_owner_id
      ? {
          kind: 'personal',
          userId: booking.personal_owner_id,
          organizationId: booking.organization_id,
        }
      : { kind: 'team', organizationId: booking.organization_id },
    workflowId: input.workflowId,
    revision: input.workflowRevision,
    trigger: input.trigger,
  })
}

async function captureBookingWebhook(
  queue: WebhookQueue,
  settings: WebhookSettings,
  trx: Db,
  event:
    | BookingEvent
    | ({ type: 'attendee_no_show_changed' } & Parameters<AttendeeNoShowNotifier>[1]),
  now: Temporal.Instant,
) {
  if (!settings.enabled) return
  if (!trx.isTransaction) throw new Error('Webhook capture requires the booking transaction')
  if (await isImportedBooking(trx, event.bookingId)) return
  const booking = await trx
    .selectFrom('bookings')
    .select([
      'id',
      'organization_id',
      'event_type_id',
      'start_at',
      'end_at',
      'status',
      'source',
      'rescheduled_from_id',
    ])
    .where('id', '=', event.bookingId)
    .executeTakeFirstOrThrow()
  const requestId = 'requestId' in event ? event.requestId : null
  const eventType: WebhookEventType =
    event.type === 'created'
      ? 'booking.created'
      : event.type === 'rescheduled'
        ? 'booking.rescheduled'
        : event.type === 'reschedule_requested'
          ? 'booking.reschedule_requested'
          : event.type === 'reschedule_request_expired'
            ? 'booking.reschedule_request_expired'
            : event.type === 'attendee_no_show_changed'
              ? 'booking.attendee_no_show_changed'
              : 'booking.cancelled'
  // Share locks serialize opt-out/deletion with capture, and are always taken by ID.
  // The switch above covers both kinds. Slack posts only SLACK_EVENTS: attendance changes
  // stay signed-webhook events.
  const slackEvent = (SLACK_EVENTS as readonly WebhookEventType[]).includes(eventType)
  const endpoints = await trx
    .selectFrom('webhooks')
    .select(['id', 'destination_kind'])
    .where((eb) =>
      eb.or([
        eb('destination_kind', '=', 'webhook'),
        ...(settings.encryptionKey && slackEvent ? [eb('destination_kind', '=', 'slack')] : []),
      ]),
    )
    .where((eb) =>
      eb.or([eb('event_type_id', 'is', null), eb('event_type_id', '=', booking.event_type_id)]),
    )
    .where('organization_id', '=', booking.organization_id)
    .where('is_active', '=', true)
    .where(sql<boolean>`${eventType} = ANY(events)`)
    .orderBy('id')
    .limit(11)
    .forShare()
    .execute()
  if (!endpoints.length) return
  // Organization records have no zone setting. Personal destinations use their
  // owner's public profile zone; team destinations explicitly use UTC.
  const hasSlack = endpoints.some((endpoint) => endpoint.destination_kind === 'slack')
  const personal = hasSlack
    ? await trx
        .selectFrom('personal_organizations')
        .leftJoin('profiles', 'profiles.user_id', 'personal_organizations.user_id')
        .select(['personal_organizations.user_id', 'profiles.time_zone'])
        .where('personal_organizations.organization_id', '=', booking.organization_id)
        .executeTakeFirst()
    : undefined
  const activity =
    hasSlack && booking.event_type_id
      ? await trx
          .selectFrom('event_types')
          .select('title')
          .where('id', '=', booking.event_type_id)
          .where('organization_id', '=', booking.organization_id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined
  const invitee = personal
    ? await trx
        .selectFrom('booking_attendees')
        .select('name')
        .where('booking_id', '=', booking.id)
        .where('is_booker', '=', true)
        .executeTakeFirst()
    : undefined
  const origin = hasSlack && settings.publicUrl ? new URL(settings.publicUrl).origin : undefined
  // An invalid oversized operator origin must not abort an otherwise valid booking.
  const bookingUrl =
    origin && origin.length <= 512 ? `${origin}/app/bookings/${booking.id}` : undefined
  const eventId = randomUUID()
  // Attendance changes reuse request_id (a plain uuid without a foreign key, added by 0064)
  // as a per-change receipt identity: this capture's fresh event ID, created in the same
  // transaction as the change. With workflow_run_id null for existing kinds, the key
  // gives every transition its own delivery, while lifecycle and reschedule-request receipts
  // deduplicate exactly as before. The value is never sent as data.requestId.
  const receiptId = event.type === 'attendee_no_show_changed' ? eventId : requestId
  const payload = JSON.stringify({
    id: eventId,
    type: eventType,
    occurredAt: now.toString(),
    data: {
      ...(requestId ? { requestId } : {}),
      bookingId: booking.id,
      organizationId: booking.organization_id,
      eventTypeId: booking.event_type_id,
      start: booking.start_at.toISOString(),
      end: booking.end_at.toISOString(),
      status: booking.status,
      source: booking.source,
      rescheduledFromId: booking.rescheduled_from_id,
      ...(event.type === 'attendee_no_show_changed' && {
        attendeeId: event.attendeeId,
        noShowMarkedAt: event.noShowMarkedAt,
        noShowMarkedBy: event.noShowMarkedBy,
      }),
    },
  })
  for (const endpoint of endpoints) {
    await insertWebhookDelivery(queue, trx, {
      webhook_id: endpoint.id,
      organization_id: booking.organization_id,
      booking_id: booking.id,
      event_id: eventId,
      event_type: eventType,
      request_id: receiptId,
      payload:
        endpoint.destination_kind === 'slack'
          ? slackPayload({
              type: eventType,
              bookingId: booking.id,
              start: booking.start_at.toISOString(),
              end: booking.end_at.toISOString(),
              status: booking.status,
              eventTypeTitle: activity?.title,
              timeZone: personal?.time_zone ?? 'UTC',
              ...(invitee ? { inviteeName: invitee.name } : {}),
              ...(bookingUrl ? { bookingUrl } : {}),
            })
          : payload,
      created_at: new Date(now.epochMilliseconds),
    })
  }
}

async function insertWebhookDelivery(
  queue: WebhookQueue,
  trx: Db,
  values: Insertable<WebhookDeliveries>,
) {
  const delivery = await trx
    .insertInto('webhook_deliveries')
    .values(values)
    .onConflict((oc) =>
      oc
        .columns(['webhook_id', 'booking_id', 'event_type', 'request_id', 'workflow_run_id'])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst()
  if (delivery)
    await queue.enqueue(
      WEBHOOK_DELIVERY_JOB,
      { deliveryId: delivery.id },
      {
        transaction: trx,
        singletonKey: delivery.id,
      },
    )
  return delivery
}

export function webhookDeliveryJob(deps: WebhookDeps) {
  return defineJob({
    name: WEBHOOK_DELIVERY_JOB,
    payload: WebhookDeliveryPayload,
    policy: 'exclusive',
    retry: { limit: 12, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
    expireInSeconds: 30,
    retentionSeconds: 30 * 24 * 3600,
    concurrency: 2,
    handler: ({ deliveryId, actor }, { signal, attempt }) =>
      deliverWebhook(deps, deliveryId, signal, attempt, actor),
  })
}

/** Internal workflow path. Production callers reach it through the hard-off guard. */
export async function deliverWorkflowWebhook(
  deps: WebhookDeps,
  deliveryId: string,
  signal: AbortSignal,
  jobAttempt = 1,
) {
  const identity = await deps.db
    .selectFrom('webhook_deliveries')
    .select(['workflow_run_id', 'organization_id', 'booking_id', 'webhook_id'])
    .where('id', '=', deliveryId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
  if (!identity?.workflow_run_id) return
  // Keep workflow schema initialization out of ordinary webhook delivery.
  const { hardOffWorkflowAuditPort, lockWorkflowWebhookRun } = await import('@hourmere/workflows')
  const runId = identity.workflow_run_id
  const now = deps.now ?? (() => Temporal.Now.instant())
  const retry = await deps.db.transaction().execute(async (trx) => {
    // Match capture and lifecycle lock order. The endpoint and delivery lock order
    // remains the same as for booking webhooks.
    const locked = await lockWorkflowWebhookRun(trx, {
      runId,
      organizationId: identity.organization_id,
      bookingId: identity.booking_id,
      webhookId: identity.webhook_id,
    })
    const run = locked?.eligibility
    const endpoint = await trx
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', identity.webhook_id)
      .forShare()
      .executeTakeFirst()
    if (!endpoint) return false
    const delivery = await trx
      .selectFrom('webhook_deliveries')
      .select(['status', 'event_type', 'last_attempt_at', 'created_at'])
      .where('id', '=', deliveryId)
      .executeTakeFirst()
    if (delivery?.status !== 'pending') return false
    const eligible =
      run &&
      deps.enabled &&
      endpoint.is_active &&
      endpoint.destination_kind === 'webhook' &&
      endpoint.events.includes(delivery.event_type) &&
      (endpoint.event_type_id === null || endpoint.event_type_id === run.eventTypeId)
    const credentials = eligible ? webhookCredentials(deps, endpoint) : undefined
    let markedHere = false
    if (
      eligible &&
      credentials?.error === null &&
      delivery.last_attempt_at === null &&
      !signal.aborted &&
      webhookUrl(endpoint.url, deps.privateTargets)
    ) {
      // The run serializes senders. Keep its and the endpoint's locks while a short
      // separate transaction records admission to the first guarded transport attempt.
      // A process lost after the receiver accepts can then retry this same delivery ID.
      markedHere = await deps.db.transaction().execute(async (marker) => {
        const current = await marker
          .selectFrom('webhook_deliveries')
          .select(['status', 'last_attempt_at'])
          .where('id', '=', deliveryId)
          .forUpdate()
          .executeTakeFirst()
        const started = now()
        if (
          current?.status !== 'pending' ||
          current.last_attempt_at !== null ||
          signal.aborted ||
          started.epochMilliseconds >= run.expiresAt ||
          delivery.created_at.getTime() < started.subtract({ hours: 24 * 30 }).epochMilliseconds
        )
          return false
        await marker
          .updateTable('webhook_deliveries')
          .set({ last_attempt_at: new Date(started.epochMilliseconds) })
          .where('id', '=', deliveryId)
          .execute()
        return true
      })
    }
    let current = await trx
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .forUpdate()
      .executeTakeFirst()
    if (current?.status !== 'pending') return false
    const attemptAt = now()
    async function recordOutcome(outcome: 'delivered' | 'failed', reason?: 'expired') {
      if (!locked) return
      await (deps.workflowAudit ?? hardOffWorkflowAuditPort()).record(trx, {
        ...locked.auditIdentity,
        event: outcome === 'delivered' ? 'workflow.webhook_completed' : 'workflow.webhook_failed',
        occurredAt: attemptAt,
        actor: { kind: 'background', job: 'dispatch' },
        ...(reason && { reason }),
      })
    }
    if (!eligible) {
      await skipWebhookDelivery(trx, deliveryId, 'disabled')
      await recordOutcome('failed')
      return false
    }
    const firstAttempt = markedHere || current.last_attempt_at === null
    if (
      (firstAttempt && attemptAt.epochMilliseconds >= run.expiresAt) ||
      delivery.created_at.getTime() < attemptAt.subtract({ hours: 24 * 30 }).epochMilliseconds
    ) {
      await skipWebhookDelivery(trx, deliveryId, 'expired', markedHere)
      await recordOutcome('failed', 'expired')
      return false
    }
    // This worker knows it has not yet entered the transport. A marker left by
    // a previous worker is ambiguous and must still allow a retry.
    if (markedHere && signal.aborted) current = { ...current, last_attempt_at: null }
    const { retry, outcome } = await attemptWebhook(
      trx,
      deps,
      endpoint,
      current,
      signal,
      attemptAt,
      jobAttempt,
      credentials,
    )
    if (outcome !== 'pending') await recordOutcome(outcome)
    return retry
  })
  throwIfWebhookRetry(retry, signal)
}

const guardedWorkflowWebhook = workflowExecution(deliverWorkflowWebhook)

/** At least once. A crash after the receiver accepts but before commit can duplicate an ID. */
export async function deliverWebhook(
  deps: WebhookDeps,
  deliveryId: string,
  signal: AbortSignal,
  jobAttempt = 1,
  actor?: TeamSsoSession,
) {
  const found = await deps.db
    .selectFrom('webhook_deliveries')
    .innerJoin('webhooks', 'webhooks.id', 'webhook_deliveries.webhook_id')
    .select(['webhook_id', 'destination_kind'])
    .where('webhook_deliveries.id', '=', deliveryId)
    .executeTakeFirst()
  if (!found) return
  const retry = await deps.db.transaction().execute(async (trx) => {
    // Serialize only Slack workers before taking SHARE: booking capture never takes
    // this advisory lock and stays unblocked during the network call. A revoked send
    // can then upgrade its row lock after the call without another sender upgrading.
    if (found.destination_kind === 'slack') {
      // Bound only this wait. Later row-lock waits keep the session setting: a timeout
      // after Slack accepted a message would turn it into a duplicate on retry.
      const previous = await sql<{
        value: string
      }>`SELECT current_setting('lock_timeout') AS value`.execute(trx)
      await sql`SELECT set_config('lock_timeout', ${`${deps.slackSenderWaitMs ?? SLACK_SENDER_WAIT_MS}ms`}, true)`.execute(
        trx,
      )
      try {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${found.webhook_id}, 578231))`.execute(
          trx,
        )
      } catch (error) {
        // SQL error text is never surfaced; the job retries with its normal backoff.
        if ((error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE)
          throw new Error('Webhook delivery deferred')
        throw error
      }
      await sql`SELECT set_config('lock_timeout', ${previous.rows[0]?.value ?? '0'}, true)`.execute(
        trx,
      )
    }
    // Endpoint first, then delivery: deletion cascades in that order too.
    const endpoint = await trx
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', found.webhook_id)
      .forShare()
      .executeTakeFirst()
    if (!endpoint) return false
    const delivery = await trx
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', deliveryId)
      .forUpdate()
      .executeTakeFirst()
    if (delivery?.status !== 'pending') return false
    if (delivery.workflow_run_id != null) return 'workflow'
    if (delivery.booking_id && (await isImportedBooking(trx, delivery.booking_id))) return false
    const filterMismatch =
      endpoint.destination_kind === 'slack' &&
      endpoint.event_type_id !== null &&
      delivery.booking_id !== null &&
      !(await trx
        .selectFrom('bookings')
        .select('id')
        .where('id', '=', delivery.booking_id)
        .where('event_type_id', '=', endpoint.event_type_id)
        .executeTakeFirst())
    const now = (deps.now ?? (() => Temporal.Now.instant()))()
    if (
      !deps.enabled ||
      !endpoint.is_active ||
      filterMismatch ||
      !endpoint.events.includes(delivery.event_type) ||
      delivery.created_at.getTime() < now.subtract({ hours: 24 * 30 }).epochMilliseconds
    ) {
      await trx
        .updateTable('webhook_deliveries')
        .set({
          status: 'skipped',
          last_error:
            deps.enabled &&
            endpoint.is_active &&
            !filterMismatch &&
            endpoint.events.includes(delivery.event_type)
              ? 'expired'
              : 'disabled',
        })
        .where('id', '=', deliveryId)
        .execute()
      return false
    }
    // A Slack sample acts for its requester. Booking and workflow events reconcile
    // durable outcomes of a committed booking and do not borrow a browser's authority.
    if (endpoint.destination_kind === 'slack' && delivery.booking_id === null) {
      const access = await teamSsoAccess(
        { db: trx, capabilities: deps.ssoCapabilities ?? ssoHardOff },
        actor ?? null,
        delivery.organization_id,
      )
      if (!access.allowed) {
        await skipWebhookDelivery(trx, deliveryId, 'disabled')
        return false
      }
    }
    const { retry } = await attemptWebhook(trx, deps, endpoint, delivery, signal, now, jobAttempt)
    return retry
  })
  if (retry === 'workflow') return guardedWorkflowWebhook(deps, deliveryId, signal, jobAttempt)
  throwIfWebhookRetry(retry, signal)
}

function webhookCredentials(deps: WebhookDeps, endpoint: Selectable<Webhooks>) {
  let error: 'secret_unavailable' | null = null
  let secret: string
  let destination = endpoint.url
  const isSlack = endpoint.destination_kind === 'slack'
  try {
    if (isSlack) {
      destination = decryptWebhookSecret(
        endpoint.url_ciphertext ?? Buffer.alloc(0),
        deps.encryptionKey ?? '',
        `${endpoint.id}:url`,
        endpoint.organization_id,
      )
      if (!slackUrl(destination)) throw new Error('Invalid Slack destination')
      secret = ''
    } else
      secret = decryptWebhookSecret(
        endpoint.secret_ciphertext,
        deps.encryptionKey ?? '',
        endpoint.id,
        endpoint.organization_id,
      )
  } catch {
    error = 'secret_unavailable'
    secret = ''
  }
  return { destination, isSlack, secret, error }
}

async function attemptWebhook(
  trx: Db,
  deps: WebhookDeps,
  endpoint: Selectable<Webhooks>,
  delivery: Selectable<WebhookDeliveries>,
  signal: AbortSignal,
  now: Temporal.Instant,
  jobAttempt: number,
  credentials = webhookCredentials(deps, endpoint),
): Promise<{ retry: boolean; outcome: 'pending' | 'delivered' | 'failed' }> {
  const deliveryId = delivery.id
  // pg-boss also counts runs lost to a killed worker, whose transaction rolled back.
  const attempt = Math.min(13, Math.max(delivery.attempts + 1, jobAttempt))
  const timestamp = Math.floor(now.epochMilliseconds / 1000).toString()
  let status: number | null = null
  let error: 'secret_unavailable' | 'transport_error' | 'http_error' | 'interrupted' | null =
    credentials.error
  const { destination, isSlack, secret } = credentials
  if (!error && !signal.aborted) {
    try {
      status = await (deps.transport ?? sendWebhook)({
        url: destination,
        privateTargets: isSlack ? [] : deps.privateTargets,
        body: delivery.payload,
        signal,
        headers: isSlack
          ? {}
          : {
              'webhook-id': delivery.id,
              'webhook-event-id': delivery.event_id,
              'webhook-timestamp': timestamp,
              'webhook-signature': webhookSignature(secret, timestamp, delivery.payload),
            },
      })
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        status = null
        error = 'transport_error'
      } else if (status < 200 || status >= 300) error = 'http_error'
    } catch {
      error = 'transport_error'
    }
  }
  // A received 2xx acknowledges delivery even if shutdown raced its response. Otherwise
  // commit shutdown consumption before retrying. A killed process is accounted for by
  // the next jobAttempt or by periodic orphan reconciliation.
  if (signal.aborted && (status === null || error !== null)) {
    error = 'interrupted'
    status = null
  }
  const slackRevoked = isSlack && (status === 404 || status === 410)
  if (slackRevoked) {
    await trx
      .updateTable('webhooks')
      .set({
        is_active: false,
        pause_reason: 'url_rejected',
        updated_at: new Date(now.epochMilliseconds),
      })
      .where('id', '=', endpoint.id)
      .execute()
    // The destination was active under the sender lock, so this is the one transition.
    await writeAuditEvent(trx, {
      organizationId: endpoint.organization_id,
      actor: { type: 'system', id: WEBHOOK_DELIVERY_JOB },
      credential: { type: 'none' },
      action: 'slack_destination.paused',
      targetType: 'slack_destination',
      targetId: endpoint.id,
      details: { events: endpoint.events },
    })
  }
  const outcome = error ? (slackRevoked || attempt === 13 ? 'failed' : 'pending') : 'delivered'
  await trx
    .updateTable('webhook_deliveries')
    .set({
      attempts: attempt,
      last_attempt_at:
        delivery.workflow_run_id == null || delivery.last_attempt_at !== null
          ? new Date(now.epochMilliseconds)
          : null,
      http_status: status,
      last_error: error,
      status: outcome,
      delivered_at: error ? null : new Date(now.epochMilliseconds),
    })
    .where('id', '=', deliveryId)
    .execute()
  return { retry: error !== null && !slackRevoked, outcome }
}

async function skipWebhookDelivery(
  trx: Db,
  deliveryId: string,
  reason: 'disabled' | 'expired',
  clearMarker = false,
) {
  await trx
    .updateTable('webhook_deliveries')
    .set({ status: 'skipped', last_error: reason, ...(clearMarker && { last_attempt_at: null }) })
    .where('id', '=', deliveryId)
    .execute()
}

function throwIfWebhookRetry(retry: boolean, signal: AbortSignal) {
  // Safe even when a request failed with a body, query credential, headers or secret.
  if (retry)
    throw new Error(signal.aborted ? 'Webhook delivery interrupted' : 'Webhook delivery failed')
}

export function webhookCleanupJob(
  db: Db,
  now = () => Temporal.Now.instant(),
  workflowAudit?: WorkflowAuditPort,
) {
  return defineJob({
    name: 'webhook-cleanup',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '*/15 * * * *', payload: {} },
    expireInSeconds: 30,
    handler: async (_, { signal }) => {
      // Bound reconciliation and retention per dispatch. Leave 20s of the 30s pg-boss
      // lease for scheduling and commit.
      const deadline = performance.now() + 10_000
      async function batch<T>(phase: 'reconciliation' | 'retention', run: (trx: Db) => Promise<T>) {
        if (signal.aborted || performance.now() >= deadline) return
        try {
          return await db.transaction().execute(async (trx) => {
            // Pool acquisition may itself have consumed the budget.
            const remaining = Math.floor(deadline - performance.now())
            if (signal.aborted || remaining <= 0) return
            await sql`SELECT
              set_config('statement_timeout', ${`${Math.min(5000, remaining)}ms`}, true),
              set_config('lock_timeout', ${`${Math.min(1000, remaining)}ms`}, true)
            `.execute(trx)
            if (signal.aborted || performance.now() >= deadline) return
            return run(trx)
          })
        } catch (error) {
          // A canceled or lock-unavailable batch rolls back completely. Retry next pass rather than
          // overrunning the lease; unrelated SQL failures must still fail the job.
          const code = (error as { code?: string } | null)?.code
          if (code !== '57014' && code !== '55P03') throw error
          // SQL error text can contain private data. Log only fixed metadata and the
          // recognized SQLSTATE so a repeatedly deferred phase stays observable.
          console.warn(JSON.stringify({ event: 'webhook_cleanup_deferred', phase, code }))
        }
      }
      // Capture and enqueue are atomic. A visible pending row with no created/retry/active
      // job cannot make progress. Keep this test in the UPDATE statement and skip locked
      // deliveries so reconciliation never races an in-flight acknowledgement.
      // pg-boss is pinned; its schema belongs to pg-boss and is never migrated here.
      function failOrphanedDeliveries(trx: Db, workflow: boolean, limit: number) {
        const runFilter = workflow ? sql`IS NOT NULL` : sql`IS NULL`
        return sql<{ id: string }>`
        WITH job_history AS MATERIALIZED (
          -- Keep only pending keys before aggregating. Reuse one retained-job scan for
          -- liveness and attempts; hashing all retained jobs can spill as history grows.
          -- No time/policy cutoff: even an old or differently configured live job protects
          -- its delivery, and every retained attempt contributes to the maximum.
          SELECT j.singleton_key,
            BOOL_OR(j.state IN ('created', 'retry', 'active')) AS live,
            MAX(CASE WHEN j.started_on IS NULL THEN 0 ELSE j.retry_count + 1 END) AS attempts
          FROM pgboss.job j
          WHERE j.name = ${WEBHOOK_DELIVERY_JOB}
            AND j.singleton_key IN (
              SELECT p.id::text FROM webhook_deliveries p
              WHERE p.status = 'pending' AND p.workflow_run_id ${runFilter}
            )
          GROUP BY j.singleton_key
        ), orphaned AS MATERIALIZED (
          SELECT d.id, h.attempts FROM webhook_deliveries d
          LEFT JOIN job_history h ON h.singleton_key = d.id::text
          WHERE d.status = 'pending' AND d.workflow_run_id ${runFilter} AND NOT COALESCE(h.live, false)
          ORDER BY d.id LIMIT ${limit} FOR UPDATE OF d SKIP LOCKED
        )
        UPDATE webhook_deliveries d SET status = 'failed', last_error = 'job_missing',
          attempts = LEAST(13, GREATEST(d.attempts, COALESCE(o.attempts, 0)))
        FROM orphaned o
        WHERE d.id = o.id AND d.status = 'pending'
        RETURNING d.id
      `.execute(trx)
      }
      const limit = 1000
      // Commit ordinary repairs independently of the workflow audit writer.
      const ordinary = await batch('reconciliation', (trx) =>
        failOrphanedDeliveries(trx, false, limit),
      )
      try {
        const remaining = limit - (ordinary?.rows.length ?? limit)
        if (remaining > 0)
          await batch('reconciliation', async (trx) => {
            const pending = await trx
              .selectFrom('webhook_deliveries')
              .select('id')
              .where('status', '=', 'pending')
              .where('workflow_run_id', 'is not', null)
              .limit(1)
              .executeTakeFirst()
            if (!pending) return
            const { rows } = await failOrphanedDeliveries(trx, true, remaining)
            if (rows.length === 0) return
            const { hardOffWorkflowAuditPort, workflowWebhookAuditIdentities } = await import(
              '@hourmere/workflows'
            )
            const repaired = await workflowWebhookAuditIdentities(
              trx,
              rows.map(({ id }) => id),
            )
            const audit = workflowAudit ?? hardOffWorkflowAuditPort()
            const occurredAt = now()
            for (const auditIdentity of repaired)
              await audit.record(trx, {
                ...auditIdentity,
                event: 'workflow.webhook_failed',
                occurredAt,
                actor: { kind: 'background', job: 'repair' },
              })
          })
      } finally {
        await batch('retention', (trx) =>
          sql`
          WITH expired AS (
            SELECT id FROM webhook_deliveries
            WHERE created_at < ${new Date(now().subtract({ hours: 24 * 30 }).epochMilliseconds)}
            ORDER BY created_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED
          )
          DELETE FROM webhook_deliveries d USING expired e WHERE d.id = e.id
        `.execute(trx),
        )
      }
    },
  })
}
