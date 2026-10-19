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
  /** Only isolated fixtures replace the built-in HTTP(S)/DNS transport. */
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
    handler: ({ deliveryId }, { signal, attempt }) =>
      deliverWebhook(deps, deliveryId, signal, attempt),
  })
}

/** At least once. A crash after the receiver accepts but before commit can duplicate an ID. */
export async function deliverWebhook(
  deps: WebhookDeps,
  deliveryId: string,
  signal: AbortSignal,
  jobAttempt = 1,
) {
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
    // pg-boss also counts runs lost to a killed worker, whose transaction rolled back.
    const attempt = Math.min(13, Math.max(delivery.attempts + 1, jobAttempt))
    const timestamp = Math.floor(now.epochMilliseconds / 1000).toString()
    let status: number | null = null
    let error: 'secret_unavailable' | 'transport_error' | 'http_error' | 'interrupted' | null = null
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
    if (!error && !signal.aborted) {
      try {
        status = await (deps.transport ?? sendWebhook)({
          url: endpoint.url,
          privateTargets: deps.privateTargets,
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
    // A received 2xx acknowledges delivery even if shutdown raced its response. Otherwise
    // commit shutdown consumption before retrying. A killed process is accounted for by
    // the next jobAttempt or by periodic orphan reconciliation.
    if (signal.aborted && (status === null || error !== null)) {
      error = 'interrupted'
      status = null
    }
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
  if (retry)
    throw new Error(signal.aborted ? 'Webhook delivery interrupted' : 'Webhook delivery failed')
}

export function webhookCleanupJob(db: Db, now = () => Temporal.Now.instant()) {
  return defineJob({
    name: 'webhook-cleanup',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '*/15 * * * *', payload: {} },
    expireInSeconds: 30,
    handler: async (_, { signal }) => {
      // One orphan batch and one retention batch per dispatch; unfinished work stays for
      // the next scheduled run. Leave 20s of the 30s pg-boss lease for scheduling/commit.
      const deadline = performance.now() + 10_000
      async function batch(
        phase: 'reconciliation' | 'retention',
        run: (trx: Db) => Promise<unknown>,
      ) {
        if (signal.aborted || performance.now() >= deadline) return
        try {
          await db.transaction().execute(async (trx) => {
            // Pool acquisition may itself have consumed the budget.
            const remaining = Math.floor(deadline - performance.now())
            if (signal.aborted || remaining <= 0) return
            await sql`SELECT
              set_config('statement_timeout', ${`${Math.min(5000, remaining)}ms`}, true),
              set_config('lock_timeout', ${`${Math.min(1000, remaining)}ms`}, true)
            `.execute(trx)
            if (signal.aborted || performance.now() >= deadline) return
            await run(trx)
          })
        } catch (error) {
          // A timed-out batch rolls back completely. Retry it next pass rather than
          // overrunning the lease; unrelated SQL failures must still fail the job.
          const code = (error as { code?: string } | null)?.code
          if (code !== '57014' && code !== '55P03') throw error
          // SQL error text can contain private data. Log only fixed metadata and the
          // recognized SQLSTATE so a repeatedly deferred phase stays observable.
          console.warn(JSON.stringify({ event: 'webhook_cleanup_timeout', phase, code }))
        }
      }
      // Capture and enqueue are atomic. A visible pending row with no created/retry/active
      // job cannot make progress. Keep this test in the UPDATE statement and skip locked
      // deliveries so reconciliation never races an in-flight acknowledgement.
      // pg-boss is pinned; its schema belongs to pg-boss and is never migrated here.
      await batch('reconciliation', (trx) =>
        sql`
        WITH orphaned AS MATERIALIZED (
          SELECT d.id FROM webhook_deliveries d
          WHERE d.status = 'pending' AND NOT EXISTS (
            SELECT 1 FROM pgboss.job j
            WHERE j.name = ${WEBHOOK_DELIVERY_JOB} AND j.singleton_key = d.id::text
              AND j.state IN ('created', 'retry', 'active')
          )
          ORDER BY d.id LIMIT 1000 FOR UPDATE OF d SKIP LOCKED
        ), job_attempts AS MATERIALIZED (
          -- Join the whole batch before grouping: never scan retained jobs per delivery.
          SELECT j.singleton_key,
            MAX(CASE WHEN j.started_on IS NULL THEN 0 ELSE j.retry_count + 1 END) AS attempts
          FROM pgboss.job j JOIN orphaned o ON j.singleton_key = o.id::text
          WHERE j.name = ${WEBHOOK_DELIVERY_JOB}
          GROUP BY j.singleton_key
        )
        UPDATE webhook_deliveries d SET status = 'failed', last_error = 'job_missing',
          attempts = LEAST(13, GREATEST(d.attempts, COALESCE(a.attempts, 0)))
        FROM orphaned o LEFT JOIN job_attempts a ON a.singleton_key = o.id::text
        WHERE d.id = o.id AND d.status = 'pending'
      `.execute(trx),
      )
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
    },
  })
}
