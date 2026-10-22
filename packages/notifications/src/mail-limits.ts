import { createHmac } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'

export interface NotificationMailLimits {
  /** Invitee/guest mail only. Positive integers; hosts do not consume this budget. */
  mailRecipientMaxPerHour?: number | undefined
  mailRecipientMaxPerDay?: number | undefined
  /** All booking notification and sign-in mail. Zero disables the instance limit. */
  mailMaxPerHour?: number | undefined
}

export interface SignInMailLimits {
  /** Sign-in mail only; separate from booking recipient budgets. */
  signInMailMaxPerHour?: number | undefined
  signInMailMaxPerDay?: number | undefined
  /** Sign-in mail shares the host reserve above the instance cap. */
  mailMaxPerHour?: number | undefined
}

export type SuppressionReason =
  | 'recipient_hourly_limit'
  | 'recipient_daily_limit'
  | 'instance_hourly_limit'

function recipientHash(email: string, secret: string, purpose: 'booking' | 'sign-in'): Buffer {
  // Derive an independent key: ledger/log digests cannot be matched from an address
  // dictionary without BETTER_AUTH_SECRET, or reused in another server-secret protocol.
  const key = createHmac('sha256', secret)
    .update('hourmere/notification-recipient-hash/v1', 'utf8')
    .digest()
  return createHmac('sha256', key)
    .update(`${purpose}\0`, 'utf8')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest()
}

export function notificationRecipientHash(email: string, secret: string): Buffer {
  return recipientHash(email, secret, 'booking')
}

export function signInRecipientHash(email: string, secret: string): Buffer {
  return recipientHash(email, secret, 'sign-in')
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

/** Same lock/ledger as booking mail, with a separate recipient budget and host reserve. */
export async function signInEmailBudget(db: Db, limits: SignInMailLimits, hash: Buffer, now: Date) {
  const cap = limits.mailMaxPerHour ?? 100
  return notificationEmailBudget(
    db,
    {
      mailMaxPerHour: cap === 0 ? 0 : Math.floor(cap * 1.2),
      mailRecipientMaxPerHour: limits.signInMailMaxPerHour ?? 5,
      mailRecipientMaxPerDay: limits.signInMailMaxPerDay ?? 20,
    },
    hash,
    true,
    now,
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
