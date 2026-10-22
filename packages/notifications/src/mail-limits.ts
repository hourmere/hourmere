import { createHash } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'

export interface NotificationMailLimits {
  /** Invitee/guest mail only. Positive integers; hosts do not consume this budget. */
  mailRecipientMaxPerHour?: number | undefined
  mailRecipientMaxPerDay?: number | undefined
  /** All booking notification mail. Zero disables the instance limit. */
  mailMaxPerHour?: number | undefined
}

export type SuppressionReason =
  | 'recipient_hourly_limit'
  | 'recipient_daily_limit'
  | 'instance_hourly_limit'

export function notificationRecipientHash(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest()
}

/** Whole emails only: a cap of one has no fractional host allowance. */
export function notificationSuppressionReason(
  limits: NotificationMailLimits,
  counts: { instanceHour: number; recipientHour: number; recipientDay: number },
  inviteeFacing: boolean,
): SuppressionReason | undefined {
  const global = limits.mailMaxPerHour ?? 100
  if (global > 0 && counts.instanceHour >= (inviteeFacing ? global : Math.floor(global * 1.2)))
    return 'instance_hourly_limit'
  if (inviteeFacing) {
    if (counts.recipientHour >= (limits.mailRecipientMaxPerHour ?? 5))
      return 'recipient_hourly_limit'
    if (counts.recipientDay >= (limits.mailRecipientMaxPerDay ?? 20)) return 'recipient_daily_limit'
  }
}

/**
 * Use after identity locks, before the final lifecycle read. The existing recipient
 * transaction holds this fence through SMTP and its receipt commit/rollback, so workers
 * cannot spend the same last slot. It is database-local and holds no booking row lock.
 */
export async function lockNotificationEmailBudget(db: Db) {
  await sql`SELECT pg_advisory_xact_lock(1852798057, 1835100524)`.execute(db)
}

export async function notificationEmailBudget(
  db: Db,
  limits: NotificationMailLimits,
  hash: Buffer,
  inviteeFacing: boolean,
  now: Date,
) {
  const hour = new Date(now.getTime() - 3_600_000)
  const day = new Date(now.getTime() - 86_400_000)
  const global = await db
    .selectFrom('notification_email_sends')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('sent_at', '>', hour)
    .executeTakeFirstOrThrow()
  let recipientHour = 0
  let recipientDay = 0
  if (inviteeFacing) {
    const recipient = await db
      .selectFrom('notification_email_sends')
      .select((eb) => [
        eb.fn.countAll<string>().as('day'),
        eb.fn.countAll<string>().filterWhere('sent_at', '>', hour).as('hour'),
      ])
      .where('recipient_hash', '=', hash)
      .where('sent_at', '>', day)
      .executeTakeFirstOrThrow()
    recipientHour = Number(recipient.hour)
    recipientDay = Number(recipient.day)
  }
  return notificationSuppressionReason(
    limits,
    { instanceHour: Number(global.count), recipientHour, recipientDay },
    inviteeFacing,
  )
}

export async function purgeNotificationEmailSends(db: Db, now = new Date()) {
  return db
    .deleteFrom('notification_email_sends')
    .where('sent_at', '<', new Date(now.getTime() - 2 * 86_400_000))
    .executeTakeFirst()
}

export function notificationEmailCleanupJob(deps: {
  db: Db
  now?: (() => Temporal.Instant) | undefined
}) {
  return defineJob({
    name: 'notification-email-cleanup',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '17 * * * *', payload: {} },
    handler: () =>
      purgeNotificationEmailSends(
        deps.db,
        new Date((deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds),
      ).then(() => {}),
  })
}
