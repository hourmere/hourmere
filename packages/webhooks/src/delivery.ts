import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import type { BookingNotifier } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'
import { decryptWebhookSecret, webhookSignature } from './crypto.ts'
import type { WebhookEventType, WebhookSettings } from './service.ts'
import { sendWebhook, type WebhookTransport } from './transport.ts'

export const WEBHOOK_DELIVERY_JOB = 'webhook-delivery'
export const WebhookDeliveryPayload = z.strictObject({ deliveryId: z.uuid() })
export interface WebhookQueue {
  enqueue(
    name: typeof WEBHOOK_DELIVERY_JOB,
    payload: { deliveryId: string },
    options?: EnqueueOptions,
  ): Promise<string | null>
}
export interface WebhookDeps extends WebhookSettings {
  db: Db
  now?: (() => Temporal.Instant) | undefined
  /** Only isolated fixtures replace the built-in HTTPS/DNS transport. */
  transport?: WebhookTransport | undefined
}

/** Capture only changes made while globally enabled; enabling never backfills old bookings. */
export function webhookBookingNotifier(
  queue: WebhookQueue,
  settings: WebhookSettings,
): BookingNotifier {
  return async (trx, event, now) => {
    if (!settings.enabled) return
    if (!trx.isTransaction) throw new Error('Webhook capture requires the booking transaction')
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
    const eventType: WebhookEventType =
      event.type === 'created'
        ? 'booking.created'
        : event.type === 'rescheduled'
          ? 'booking.rescheduled'
          : 'booking.cancelled'
    // Share locks serialize opt-out/deletion with capture, and are always taken by ID.
    const endpoints = await trx
      .selectFrom('webhooks')
      .select('id')
      .where('organization_id', '=', booking.organization_id)
      .where('is_active', '=', true)
      .where(sql<boolean>`${eventType} = ANY(events)`)
      .orderBy('id')
      .limit(10)
      .forShare()
      .execute()
    if (!endpoints.length) return
    const eventId = randomUUID()
    const payload = JSON.stringify({
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
        source: booking.source,
        rescheduledFromId: booking.rescheduled_from_id,
      },
    })
    for (const endpoint of endpoints) {
      const delivery = await trx
        .insertInto('webhook_deliveries')
        .values({
          webhook_id: endpoint.id,
          organization_id: booking.organization_id,
          booking_id: booking.id,
          event_id: eventId,
          event_type: eventType,
          payload,
          created_at: new Date(now.epochMilliseconds),
        })
        .onConflict((oc) => oc.columns(['webhook_id', 'booking_id', 'event_type']).doNothing())
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
    }
  }
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
    handler: ({ deliveryId }, { signal }) => deliverWebhook(deps, deliveryId, signal),
  })
}

/** At least once. A crash after the receiver accepts but before commit can duplicate an ID. */
export async function deliverWebhook(deps: WebhookDeps, deliveryId: string, signal: AbortSignal) {
  const found = await deps.db
    .selectFrom('webhook_deliveries')
    .select('webhook_id')
    .where('id', '=', deliveryId)
    .executeTakeFirst()
  if (!found) return
  const retry = await deps.db.transaction().execute(async (trx) => {
    // Endpoint first, then delivery: deletion cascades in that order too. Keep the share
    // lock through acknowledgement, so successful disable/delete/rotation waits for sends.
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
    const now = (deps.now ?? (() => Temporal.Now.instant()))()
    if (
      !deps.enabled ||
      !endpoint.is_active ||
      !endpoint.events.includes(delivery.event_type) ||
      delivery.created_at.getTime() < now.subtract({ hours: 24 * 30 }).epochMilliseconds
    ) {
      await trx
        .updateTable('webhook_deliveries')
        .set({
          status: 'skipped',
          last_error:
            deps.enabled && endpoint.is_active && endpoint.events.includes(delivery.event_type)
              ? 'expired'
              : 'disabled',
        })
        .where('id', '=', deliveryId)
        .execute()
      return false
    }
    const attempt = delivery.attempts + 1
    if (attempt > 13) return false
    signal.throwIfAborted()
    const timestamp = Math.floor(now.epochMilliseconds / 1000).toString()
    let status: number | null = null
    let error: 'secret_unavailable' | 'transport_error' | 'http_error' | null = null
    let secret: string
    try {
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
    if (!error) {
      try {
        status = await (deps.transport ?? sendWebhook)({
          url: endpoint.url,
          body: delivery.payload,
          signal,
          headers: {
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
    // Shutdown rolls back the attempt, rather than turning it into a permanent failure.
    signal.throwIfAborted()
    await trx
      .updateTable('webhook_deliveries')
      .set({
        attempts: attempt,
        last_attempt_at: new Date(now.epochMilliseconds),
        http_status: status,
        last_error: error,
        status: error ? (attempt === 13 ? 'failed' : 'pending') : 'delivered',
        delivered_at: error ? null : new Date(now.epochMilliseconds),
      })
      .where('id', '=', deliveryId)
      .execute()
    return error !== null
  })
  // Safe even when a request failed with a body, query credential, headers or secret.
  if (retry) throw new Error('Webhook delivery failed')
}

export function webhookCleanupJob(db: Db, now = () => Temporal.Now.instant()) {
  return defineJob({
    name: 'webhook-cleanup',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '*/15 * * * *', payload: {} },
    expireInSeconds: 30,
    handler: async () => {
      const expired = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('created_at', '<', new Date(now().subtract({ hours: 24 * 30 }).epochMilliseconds))
        .orderBy('id')
        .limit(1000)
        .execute()
      if (expired.length)
        await db
          .deleteFrom('webhook_deliveries')
          .where(
            'id',
            'in',
            expired.map((row) => row.id),
          )
          .execute()
    },
  })
}
