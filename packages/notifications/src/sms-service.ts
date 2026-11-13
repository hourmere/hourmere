import { createHmac } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  maskSmsNumber,
  normalizeSmsDestination,
  SmsError,
  type SmsProvider,
  validateSmsInput,
} from './sms-provider.ts'

export interface SmsLimits {
  recipientPerHour: number
  recipientPerDay: number
  instancePerHour: number
  organizationPerDay: number
}
export const DEFAULT_SMS_LIMITS: Readonly<SmsLimits> = Object.freeze({
  recipientPerHour: 3,
  recipientPerDay: 10,
  instancePerHour: 100,
  organizationPerDay: 50,
})
export interface SmsRequest {
  to: string
  body: string
  /** Stable across every retry of a logical job; never reuse for another message. */
  idempotencyKey: string
  organizationId: string
}

function digest(secret: string, purpose: string, value: string): Buffer {
  return createHmac('sha256', secret).update(`hourmere/sms/${purpose}/v1\0`).update(value).digest()
}

/** Retain only a non-reversible job key and timestamps after 720 elapsed hours. Never delete tombstones. */
export async function purgeSmsDeliveryDetails(db: Db) {
  await sql`UPDATE sms_deliveries SET request_hash=NULL,recipient_hash=NULL,
    recipient_mask=NULL,organization_id=NULL,provider_message_id=NULL,retry_not_before=NULL,status='expired',
    updated_at=clock_timestamp()
    WHERE key_hash IN (SELECT key_hash FROM sms_deliveries
      WHERE status <> 'expired' AND created_at < clock_timestamp()-interval '720 hours'
      ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`.execute(db)
}

/**
 * At-most-once dispatch: commit a permanent reservation before any provider I/O.
 * A crash between commit and dispatch can lose a message; retrying cannot duplicate it.
 * Only a definite provider rate-limit response permits another attempt after backoff.
 */
export function createSmsService(deps: {
  db: Db
  provider?: SmsProvider | undefined
  hashSecret: string
  limits?: Partial<SmsLimits> | undefined
}) {
  const limits = { ...DEFAULT_SMS_LIMITS, ...deps.limits }
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1))
    throw new Error('SMS limits must be positive safe integers')
  if (deps.provider && deps.hashSecret.length < 32) throw new Error('SMS hash secret is too short')
  return {
    async sendSms(input: SmsRequest): Promise<{ providerMessageId: string }> {
      if (!deps.provider) throw new SmsError('sms_not_configured')
      validateSmsInput(input)
      const to = normalizeSmsDestination(input.to)
      if (
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.organizationId) ||
        input.idempotencyKey.length < 1 ||
        input.idempotencyKey.length > 200 ||
        input.body.length < 1 ||
        input.body.length > 1600
      )
        throw new SmsError('sms_invalid_request')
      const key = digest(deps.hashSecret, 'job', input.idempotencyKey)
      const recipient = digest(deps.hashSecret, 'recipient', to)
      const request = digest(
        deps.hashSecret,
        'request',
        JSON.stringify([to, input.body, input.organizationId.toLowerCase()]),
      )
      const reservation = await deps.db.transaction().execute(async (tx) => {
        // Database-local fence shared by all workers, held only for reservation, never HTTP.
        await sql`SELECT pg_advisory_xact_lock(1852798057, 1936552802)`.execute(tx)
        await purgeSmsDeliveryDetails(tx)
        const existing = await tx
          .selectFrom('sms_deliveries')
          .selectAll()
          .where('key_hash', '=', key)
          .executeTakeFirst()
        if (existing) {
          if (existing.request_hash && !existing.request_hash.equals(request))
            throw new SmsError('sms_idempotency_conflict')
          if (existing.status === 'accepted' && existing.provider_message_id)
            return existing.provider_message_id
          if (existing.status === 'failed') throw new SmsError('sms_provider_rejected')
          if (existing.status !== 'rate_limited') throw new SmsError('sms_delivery_unknown')
          const remaining = await sql<{ seconds: number }>`SELECT ceil(extract(epoch FROM
            (${existing.retry_not_before}::timestamptz-clock_timestamp())))::int AS seconds`.execute(
            tx,
          )
          if ((remaining.rows[0]?.seconds ?? 1) > 0)
            throw new SmsError('sms_rate_limited', {
              retryAfterSeconds: remaining.rows[0]?.seconds,
            })
        }
        const counts = await sql<{
          recipient_hour: number
          recipient_day: number
          instance_hour: number
          organization_day: number
        }>`
          SELECT count(*) FILTER (WHERE created_at > clock_timestamp()-interval '1 hour')::int AS instance_hour,
          count(*) FILTER (WHERE recipient_hash=${recipient} AND created_at > clock_timestamp()-interval '1 hour')::int AS recipient_hour,
          count(*) FILTER (WHERE recipient_hash=${recipient})::int AS recipient_day,
          count(*) FILTER (WHERE organization_id=${input.organizationId}::uuid)::int AS organization_day
          FROM sms_deliveries WHERE status NOT IN ('expired','rate_limited') AND created_at > clock_timestamp()-interval '24 hours'`.execute(
          tx,
        )
        const count = counts.rows[0]
        if (
          !count ||
          count.recipient_hour >= limits.recipientPerHour ||
          count.recipient_day >= limits.recipientPerDay ||
          count.instance_hour >= limits.instancePerHour ||
          count.organization_day >= limits.organizationPerDay
        )
          throw new SmsError('sms_rate_limited')
        await tx
          .insertInto('sms_deliveries')
          .values({
            key_hash: key,
            request_hash: request,
            recipient_hash: recipient,
            recipient_mask: maskSmsNumber(to),
            organization_id: input.organizationId,
            status: 'dispatching',
          })
          .onConflict((conflict) =>
            conflict.column('key_hash').doUpdateSet({
              status: 'dispatching',
              retry_not_before: null,
              created_at: sql`clock_timestamp()`,
              updated_at: sql`clock_timestamp()`,
            }),
          )
          .execute()
        return undefined
      })
      if (reservation) return { providerMessageId: reservation }
      let result: { providerMessageId: string }
      try {
        result = await deps.provider.sendSms({
          to,
          body: input.body,
          idempotencyKey: input.idempotencyKey,
        })
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(result.providerMessageId))
          throw new SmsError('sms_delivery_unknown')
      } catch (error) {
        const rateLimited = error instanceof SmsError && error.code === 'sms_rate_limited'
        const requestedDelay = error instanceof SmsError ? error.retryAfterSeconds : undefined
        const retryDelay = Number.isFinite(requestedDelay)
          ? Math.min(3600, Math.max(1, Math.ceil(requestedDelay as number)))
          : 60
        await deps.db
          .updateTable('sms_deliveries')
          .set({
            retry_not_before: rateLimited
              ? sql`clock_timestamp()+${retryDelay}*interval '1 second'`
              : null,
            status: rateLimited
              ? 'rate_limited'
              : error instanceof SmsError && error.code === 'sms_provider_rejected'
                ? 'failed'
                : 'unknown',
            updated_at: sql`clock_timestamp()`,
          })
          .where('key_hash', '=', key)
          .where('status', '=', 'dispatching')
          .execute()
        if (rateLimited)
          throw new SmsError('sms_rate_limited', {
            retryAfterSeconds: retryDelay,
            providerCode: error instanceof SmsError ? error.providerCode : undefined,
          })
        // Unknown exceptions may contain a provider request/body/phone: never propagate them.
        throw error instanceof SmsError ? error : new SmsError('sms_delivery_unknown')
      }
      await deps.db
        .updateTable('sms_deliveries')
        .set({
          status: 'accepted',
          provider_message_id: result.providerMessageId,
          updated_at: sql`clock_timestamp()`,
        })
        .where('key_hash', '=', key)
        .where('status', '=', 'dispatching')
        .execute()
      return result
    },
  }
}

/** Always register retention, including when SMS sending is disabled. */
export function smsRetentionJob(deps: { db: Db }) {
  return defineJob({
    name: 'sms-retention',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '23 * * * *', payload: {} },
    handler: () => purgeSmsDeliveryDetails(deps.db),
  })
}
