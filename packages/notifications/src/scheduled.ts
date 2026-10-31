// Configurable booking mail. Durable rows own retries; pg-boss only wakes exact identities.
import { randomUUID } from 'node:crypto'
import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions, type KyselyTransactionLike } from '@hourmere/jobs'
import { bookingEmail, type MailMessage, MailRejectedError, singleLine } from '@hourmere/mail'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  answersOf,
  conferenceNotificationAllowed,
  inviteeManageLinks,
  loadNotificationData,
  type NotificationDeps,
  NotificationRetryError,
  sendOnce,
} from './index.ts'

export const SCHEDULED_BOOKING_EMAIL_JOB = 'scheduled-booking-email'
export const ScheduledBookingEmailPayload = z.strictObject({ messageId: z.uuid() })
const MAX_ATTEMPTS = 13
const LEASE_SECONDS = 300
const RETRY_DELAY = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000)
const instant = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime())
const clock = (deps: NotificationDeps) => deps.now?.() ?? Temporal.Now.instant()
const asDate = (value: Temporal.Instant) => new Date(value.epochMilliseconds)
interface Rule {
  id: string
  offsetMinutes: number
  recipients: { host: boolean; invitee: boolean; guests: boolean }
}
interface Snapshot {
  executionMode: 'legacy_default' | 'configurable'
  notifications: { reminders: Rule[]; followUps: Rule[] }
}
export interface ScheduledEmailQueue {
  enqueue(
    name: typeof SCHEDULED_BOOKING_EMAIL_JOB,
    payload: { messageId: string },
    options?: EnqueueOptions,
  ): Promise<string | null>
  hasLiveScheduledBookingEmailJob(
    identity: { id: string; messageId: string },
    transaction?: KyselyTransactionLike,
  ): Promise<boolean>
  retireExpiredScheduledBookingEmailJobs(
    identity: { messageId: string },
    transaction: KyselyTransactionLike,
  ): Promise<void>
}
interface ScheduledRow {
  id: string
  booking_id: string
  kind: 'reminder' | 'follow_up'
  rule_id: string
  anchor_start_at: Date
  anchor_end_at: Date
  due_at: Date
  expires_at: Date
  state: string
  attempts: number
  next_attempt_at: Date
  claim_token: string | null
  lease_until: Date | null
  last_job_id: string | null
}
class ScheduledConfigurationError extends Error {}
class ScheduledObsolete extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

/** Called only by the booking transaction, after its immutable snapshot was saved. */
export async function enqueueScheduledBookingEmails(
  queue: Partial<ScheduledEmailQueue>,
  transaction: KyselyTransactionLike,
  bookingId: string,
  decisionNow: Temporal.Instant,
): Promise<boolean> {
  const trx = transaction as Db
  const result = await sql<{
    organization_id: string
    start_at: Date
    end_at: Date
    notification_snapshot: Snapshot | null
  }>`SELECT organization_id,start_at,end_at,notification_snapshot FROM bookings WHERE id=${bookingId}`.execute(
    trx,
  )
  const booking = result.rows[0]
  const snapshot = booking?.notification_snapshot
  if (!booking || !snapshot || snapshot.executionMode === 'legacy_default') return false
  if (!queue.enqueue) throw new Error('Configurable notifications require the scheduled mail queue')
  for (const kind of ['reminder', 'follow_up'] as const) {
    const rules =
      kind === 'reminder' ? snapshot.notifications.reminders : snapshot.notifications.followUps
    for (const rule of rules) {
      const due =
        kind === 'reminder'
          ? instant(booking.start_at).subtract({ minutes: rule.offsetMinutes })
          : instant(booking.end_at).add({ minutes: rule.offsetMinutes })
      const reason =
        Temporal.Instant.compare(due, decisionNow) <= 0
          ? 'offset_not_future'
          : kind === 'reminder' &&
              Temporal.Instant.compare(due, decisionNow.add({ minutes: 60 })) <= 0
            ? 'minimum_gap'
            : null
      const id = randomUUID()
      await sql`INSERT INTO booking_scheduled_messages
        (id,organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,state,skip_reason,next_attempt_at)
        VALUES (${id},${booking.organization_id},${bookingId},${kind},${rule.id},${booking.start_at},${booking.end_at},${asDate(due)},
          ${kind === 'reminder' ? booking.start_at : asDate(due.add({ hours: 24 }))},${reason ? 'skipped' : 'pending'},${reason},${asDate(due)})`.execute(
        trx,
      )
      if (!reason) {
        const job = await queue.enqueue(
          SCHEDULED_BOOKING_EMAIL_JOB,
          { messageId: id },
          {
            transaction,
            singletonKey: `scheduled-booking-email:${id}`,
            startAfter: due,
          },
        )
        if (!job)
          throw new Error('Scheduled mail enqueue did not return its exact new job identity')
        await sql`UPDATE booking_scheduled_messages SET last_job_id=${job} WHERE id=${id}`.execute(
          trx,
        )
      }
    }
  }
  return true
}

function obsoleteReason(
  row: ScheduledRow & {
    status: string
    start_at: Date
    end_at: Date
    replaced: boolean
    anchors_match: boolean
  },
  now: Temporal.Instant,
) {
  if (row.replaced) return 'booking_replaced'
  if (row.status !== 'confirmed') return 'booking_cancelled'
  if (!row.anchors_match) return 'anchor_changed'
  if (Temporal.Instant.compare(now, instant(row.expires_at)) >= 0)
    return row.kind === 'reminder' ? 'meeting_started' : 'delivery_window_expired'
  return undefined
}
async function currentRow(db: Db, messageId: string, lock = false) {
  return (
    await sql<
      ScheduledRow & {
        status: string
        start_at: Date
        end_at: Date
        replaced: boolean
        notification_snapshot: Snapshot | null
        wall_now: Date
        anchors_match: boolean
      }
    >`
    SELECT m.*,b.status,b.start_at,b.end_at,b.notification_snapshot,clock_timestamp() AS wall_now,
      (b.start_at=m.anchor_start_at AND b.end_at=m.anchor_end_at) AS anchors_match,
      EXISTS(SELECT 1 FROM bookings successor WHERE successor.rescheduled_from_id=b.id) AS replaced
      FROM booking_scheduled_messages m JOIN bookings b ON b.id=m.booking_id
      WHERE m.id=${messageId} ${lock ? sql`FOR UPDATE OF m SKIP LOCKED` : sql``}`.execute(db)
  ).rows[0]
}
async function skip(db: Db, id: string, reason: string) {
  await sql`UPDATE booking_scheduled_messages SET state='skipped',skip_reason=${reason},claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=${id} AND state IN ('pending','processing')`.execute(db)
}

/** Claim commits before SMTP; both the token and attempt fence every later write. */
export async function deliverScheduledBookingEmail(
  deps: NotificationDeps,
  messageId: string,
  signal?: AbortSignal,
) {
  const claim = await deps.db.transaction().execute(async (trx) => {
    const row = await currentRow(trx, messageId, true)
    if (!row || !['pending', 'processing'].includes(row.state)) return
    const now = clock(deps)
    if (row.state === 'processing' && row.lease_until && row.lease_until > row.wall_now) return
    const obsolete = obsoleteReason(row, now)
    if (obsolete) {
      await skip(trx, row.id, obsolete)
      return
    }
    // Early readiness wakes and stale queue duplicates consume no attempts.
    if (
      instant(row.due_at).epochMilliseconds > now.epochMilliseconds ||
      instant(row.next_attempt_at).epochMilliseconds > now.epochMilliseconds
    )
      return
    if (row.attempts >= MAX_ATTEMPTS) {
      await sql`UPDATE booking_scheduled_messages SET state='failed',error_code='attempt_expired',claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${row.id}`.execute(
        trx,
      )
      return
    }
    const token = randomUUID()
    const attempt = row.attempts + 1
    const lease = new Date(row.wall_now.getTime() + LEASE_SECONDS * 1000)
    await sql`UPDATE booking_scheduled_messages SET state='processing',attempts=${attempt},claim_token=${token},lease_until=${lease},next_attempt_at=${asDate(now.add({ milliseconds: RETRY_DELAY(attempt) }))},error_code=NULL,updated_at=clock_timestamp() WHERE id=${row.id}`.execute(
      trx,
    )
    return { ...row, token, attempt, lease }
  })
  if (!claim) return
  let outcome: 'completed' | 'skipped' | 'pending' = 'completed'
  let reason: string | undefined
  let errorCode: string | undefined
  let invalidConfiguration = false
  const finalCheck = async (
    db: Db,
    revision?: number,
    organizer?: { id: string; email: string; pinned: boolean },
  ) => {
    const row = await currentRow(db, messageId)
    if (
      row?.state !== 'processing' ||
      row.claim_token !== claim.token ||
      row.attempts !== claim.attempt ||
      !row.lease_until ||
      row.lease_until <= row.wall_now
    )
      throw new ScheduledObsolete('claim_lost')
    const obsolete = obsoleteReason(row, clock(deps))
    if (obsolete) throw new ScheduledObsolete(obsolete)
    if (
      row.due_at > asDate(clock(deps)) ||
      (row.kind === 'follow_up' && row.end_at > asDate(clock(deps)))
    )
      throw new NotificationRetryError('Scheduled mail is not due')
    if (row.kind === 'reminder') {
      if (!(await conferenceNotificationAllowed(db, row.booking_id, 'reminder', true)))
        throw new NotificationRetryError('Conference preparation remains pending')
      const c = await db
        .selectFrom('booking_conferences')
        .select('revision')
        .where('booking_id', '=', row.booking_id)
        .executeTakeFirst()
      if ((c?.revision ?? undefined) !== revision)
        throw new NotificationRetryError('Conference revision changed')
    }
    if (organizer) {
      // Plain reads after the budget wait: taking another user/member lock here
      // would invert sendOnce's identity-before-budget lock order.
      const available = await db
        .selectFrom('booking_hosts as bh')
        .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
        .innerJoin('auth.user as u', 'u.id', 'bh.user_id')
        .innerJoin('auth.member as m', (join) =>
          join.onRef('m.userId', '=', 'u.id').onRef('m.organizationId', '=', 'b.organization_id'),
        )
        .select('u.id')
        .where('bh.booking_id', '=', claim.booking_id)
        .where('u.id', '=', organizer.id)
        .where('u.email', '=', organizer.email)
        .where('u.emailVerified', '=', true)
        .executeTakeFirst()
      if (!available) {
        if (organizer.pinned) throw new NotificationRetryError('Pinned organizer unavailable')
        throw new ScheduledObsolete('no_organizer')
      }
    }
  }
  try {
    signal?.throwIfAborted()
    const data = await loadNotificationData(deps.db, claim.booking_id)
    if (!data) throw new ScheduledObsolete('booking_missing')
    await finalCheck(deps.db, data.conferenceRevision)
    const policy = claim.notification_snapshot?.notifications
    const rule = (claim.kind === 'reminder' ? policy?.reminders : policy?.followUps)?.find(
      (r) => r.id === claim.rule_id,
    )
    if (!rule)
      throw new ScheduledConfigurationError('Scheduled rule missing from immutable snapshot')
    const identity = data.conferenceIdentity
    const organizer =
      claim.kind === 'reminder' && identity
        ? identity.available && identity.email && identity.name
          ? { id: identity.organizerId, name: identity.name, email: identity.email }
          : undefined
        : data.hosts[0]
    if (!organizer && claim.kind === 'reminder' && data.automaticConference)
      throw new NotificationRetryError('Pinned organizer unavailable')
    if (!organizer) throw new ScheduledObsolete('no_organizer')
    const organizerGuard = {
      id: organizer.id,
      email: organizer.email,
      pinned: claim.kind === 'reminder' && data.automaticConference,
    }
    await finalCheck(deps.db, data.conferenceRevision, organizerGuard)
    const booker = data.attendees.find((a) => a.isBooker)
    const language = interfaceLanguage(booker?.locale) ?? 'en'
    const meeting = {
      eventName: data.booking.eventName,
      hostName: organizer.name,
      inviteeName: booker?.name ?? '',
      inviteeEmail: booker?.email ?? '',
      inviteeTimeZone: booker?.timeZone ?? 'UTC',
      guests: data.attendees.filter((a) => !a.isBooker).map(({ name, email }) => ({ name, email })),
      start: data.booking.start,
      end: data.booking.end,
      location: data.booking.location,
    }
    const recipients = [
      ...(rule.recipients.host
        ? data.hosts.map((h) => ({
            key: `host:${h.id}`,
            email: h.email,
            zone: h.timeZone,
            locale: interfaceLanguage(h.locale) ?? 'en',
            host: { id: h.id, email: h.email },
            links: false,
          }))
        : []),
      ...data.attendees
        .filter((a) => (a.isBooker ? rule.recipients.invitee : rule.recipients.guests))
        .map((a) => ({
          key: `attendee:${a.id}`,
          email: a.email,
          zone: a.timeZone,
          locale: language,
          host: undefined,
          links: a.isBooker && claim.kind === 'reminder',
        })),
    ]
    if (!recipients.length) throw new ScheduledObsolete('no_recipients')
    const permanent: string[] = []
    let attempted = 0
    let temporary = false
    for (const recipient of recipients) {
      const remaining = claim.lease.getTime() - Date.now() - 1000
      if (remaining <= 0) throw new NotificationRetryError('Scheduled claim deadline reached')
      const timeout = AbortSignal.timeout(Math.min(60_000, remaining))
      const sendSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      try {
        const result = await sendOnce(
          deps,
          {
            bookingId: claim.booking_id,
            kind: claim.kind,
            messageKey: claim.rule_id,
            recipient: recipient.key,
            email: recipient.email,
            verifiedHost: recipient.host,
            conferenceRevision: data.conferenceRevision,
            finalCheck: (db) => finalCheck(db, data.conferenceRevision, organizerGuard),
          },
          recipient.links,
          (token): MailMessage => {
            if (claim.kind === 'reminder')
              return {
                ...bookingEmail(
                  'reminder',
                  meeting,
                  {
                    ...(recipient.host
                      ? {
                          role: 'host' as const,
                          answers: answersOf(
                            data.booking.questions,
                            data.booking.responses,
                            recipient.locale,
                          ),
                        }
                      : {
                          role: 'attendee' as const,
                          manageLinks: token
                            ? inviteeManageLinks(deps.publicUrl, token)
                            : undefined,
                        }),
                    email: recipient.email,
                    timeZone: recipient.zone,
                    locale: recipient.locale,
                  },
                  {
                    bookingUrl: recipient.host
                      ? new URL(
                          `/app/bookings/${encodeURIComponent(claim.booking_id)}`,
                          deps.publicUrl,
                        ).href
                      : undefined,
                  },
                ),
                sensitive: data.automaticConference,
                replyTo: recipient.host
                  ? booker
                    ? { name: booker.name, email: booker.email }
                    : undefined
                  : { name: organizer.name, email: organizer.email },
              }
            const title = singleLine(data.booking.eventName)
            const chinese = recipient.locale === 'zh-CN'
            const when = data.booking.end
              .toZonedDateTimeISO(recipient.zone)
              .toLocaleString(chinese ? 'zh-CN' : 'en', { dateStyle: 'full', timeStyle: 'short' })
            const bookingLink = recipient.host
              ? new URL(`/app/bookings/${encodeURIComponent(claim.booking_id)}`, deps.publicUrl)
                  .href
              : undefined
            return {
              to: recipient.email,
              subject: chinese
                ? `会议时间已结束：${title}`
                : `Scheduled meeting time ended: ${title}`,
              text: chinese
                ? `「${title}」的预定会议时间已于 ${when}（${recipient.zone}）结束。\n${bookingLink ? `\n查看预约：${bookingLink}\n` : ''}`
                : `The scheduled time for “${title}” ended at ${when} (${recipient.zone}).\n${bookingLink ? `\nView booking: ${bookingLink}\n` : ''}`,
            }
          },
          () => clock(deps),
          sendSignal,
          undefined,
        )
        if (result === 'overtaken') throw new ScheduledObsolete('booking_cancelled')
        if (result === 'sent') attempted++
      } catch (error) {
        if (!(error instanceof MailRejectedError) || !error.recipientOnly) throw error
        attempted++
        if (error.permanent) permanent.push(recipient.key)
        else temporary = true
      }
    }
    if (permanent.length && permanent.length === attempted)
      throw new NotificationRetryError('All recipients permanently refused')
    for (const recipient of permanent) {
      await deps.db.transaction().execute(async (trx) => {
        await finalCheck(trx, data.conferenceRevision, organizerGuard)
        await sql`INSERT INTO booking_notifications (booking_id,kind,message_key,recipient,outcome)
          VALUES (${claim.booking_id},${claim.kind},${claim.rule_id},${recipient},'rejected') ON CONFLICT DO NOTHING`.execute(
          trx,
        )
      })
    }
    if (temporary) throw new NotificationRetryError('Recipients temporarily refused')
  } catch (error) {
    if (error instanceof ScheduledObsolete) {
      outcome = 'skipped'
      reason = error.reason
    } else {
      invalidConfiguration = error instanceof ScheduledConfigurationError
      outcome = 'pending'
      errorCode = signal?.aborted
        ? 'interrupted'
        : error instanceof NotificationRetryError
          ? 'recipient_retry'
          : 'delivery_failed'
    }
  }
  const failed = invalidConfiguration || (outcome === 'pending' && claim.attempt >= MAX_ATTEMPTS)
  await sql`UPDATE booking_scheduled_messages SET state=${failed ? 'failed' : outcome},skip_reason=${reason ?? null},error_code=${errorCode ?? null},
    next_attempt_at=${asDate(clock(deps).add({ milliseconds: RETRY_DELAY(claim.attempt) }))},claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=${messageId} AND state='processing' AND claim_token=${claim.token} AND attempts=${claim.attempt} AND lease_until > clock_timestamp()`.execute(
    deps.db,
  )
  signal?.throwIfAborted()
}

/** Fair bounded scan: completed queue history is never mistaken for a live wake. */
const repairCursors = new WeakMap<object, string>()
export async function repairScheduledBookingEmails(
  deps: NotificationDeps,
  queue: ScheduledEmailQueue,
) {
  const cursor = repairCursors.get(queue) ?? '00000000-0000-0000-0000-000000000000'
  const now = asDate(clock(deps))
  let rows = (
    await sql<{
      id: string
    }>`SELECT id FROM booking_scheduled_messages WHERE state IN ('pending','processing')
    AND next_attempt_at <= ${now} AND due_at <= ${now} AND id > ${cursor} ORDER BY id LIMIT 100`.execute(
      deps.db,
    )
  ).rows
  if (!rows.length && cursor !== '00000000-0000-0000-0000-000000000000')
    rows = (
      await sql<{
        id: string
      }>`SELECT id FROM booking_scheduled_messages WHERE state IN ('pending','processing') AND next_attempt_at <= ${now} AND due_at <= ${now} ORDER BY id LIMIT 100`.execute(
        deps.db,
      )
    ).rows
  for (const { id } of rows) {
    try {
      await deps.db.transaction().execute(async (trx) => {
        const row = await currentRow(trx, id, true)
        if (!row || !['pending', 'processing'].includes(row.state)) return
        if (row.state === 'processing' && row.lease_until && row.lease_until > row.wall_now) return
        const obsolete = obsoleteReason(row, clock(deps))
        if (obsolete) {
          await skip(trx, id, obsolete)
          return
        }
        if (row.attempts >= MAX_ATTEMPTS) {
          await sql`UPDATE booking_scheduled_messages SET state='failed',error_code='attempt_expired',claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${id}`.execute(
            trx,
          )
          return
        }
        if (
          row.last_job_id &&
          (await queue.hasLiveScheduledBookingEmailJob({ id: row.last_job_id, messageId: id }, trx))
        )
          return
        await queue.retireExpiredScheduledBookingEmailJobs({ messageId: id }, trx)
        const job = await queue.enqueue(
          SCHEDULED_BOOKING_EMAIL_JOB,
          { messageId: id },
          {
            transaction: trx,
            singletonKey: `scheduled-booking-email:${id}`,
            startAfter: row.next_attempt_at,
          },
        )
        if (!job) {
          if (
            row.last_job_id &&
            (await queue.hasLiveScheduledBookingEmailJob(
              { id: row.last_job_id, messageId: id },
              trx,
            ))
          )
            return
          throw new Error('Scheduled mail singleton has no matching live job')
        }
        await sql`UPDATE booking_scheduled_messages SET state='pending',claim_token=NULL,lease_until=NULL,last_job_id=${job},updated_at=clock_timestamp() WHERE id=${id}`.execute(
          trx,
        )
      })
    } catch {
      // One corrupt singleton must not prevent later rows from being repaired.
      ;(deps.log ?? console.warn)(
        `WARN scheduled-booking-email-repair: message ${id} repair_unavailable`,
      )
    } finally {
      repairCursors.set(queue, id)
    }
  }
}
export function scheduledBookingEmailJob(deps: NotificationDeps) {
  return defineJob({
    name: SCHEDULED_BOOKING_EMAIL_JOB,
    payload: ScheduledBookingEmailPayload,
    policy: 'exclusive',
    concurrency: 2,
    retry: { limit: 0 },
    expireInSeconds: 300,
    handler: ({ messageId }, { signal }) =>
      deliverScheduledBookingEmail(
        deps,
        messageId,
        AbortSignal.any([signal, AbortSignal.timeout(299_000)]),
      ),
  })
}
export function scheduledBookingEmailRepairJob(deps: NotificationDeps, queue: ScheduledEmailQueue) {
  return defineJob({
    name: 'scheduled-booking-email-repair',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    retry: { limit: 0 },
    expireInSeconds: 300,
    handler: () => repairScheduledBookingEmails(deps, queue),
  })
}
