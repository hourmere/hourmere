// Slot-owned host mail: independent of every seat's lifecycle and capability.
import { randomUUID } from 'node:crypto'
import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { escapeHtml, icsAttachment, type MailMessage } from '@hourmere/mail'
import type { NotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import { sql } from 'kysely'
import { z } from 'zod'
import type { NotificationDeps } from './index.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

const asDate = (value: Temporal.Instant) => new Date(value.epochMilliseconds)
const instant = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime())
const clock = (deps: NotificationDeps) => deps.now?.() ?? Temporal.Now.instant()
interface Slot {
  id: string
  state: string
  revision: string
  title: string
  start_at: Date
  end_at: Date
  created_at: Date
  active_seats: number
  host_user_id: string
  host_notification_settings: NotificationSnapshot
  destination_calendar_id: string | null
  ical_organizer_name: string | null
  ical_organizer_email: string | null
}

/** Repeated seat writes cannot replace slot policy or restart scheduled delivery attempts. */
export async function enqueueGroupHostMail(db: Db, bookingId: string, now: Temporal.Instant) {
  const slots = (
    await sql<Slot>`SELECT DISTINCT s.* FROM group_slots s JOIN bookings b
    ON s.id=b.group_slot_id WHERE b.id=${bookingId} OR b.id=(SELECT rescheduled_from_id FROM bookings WHERE id=${bookingId})`.execute(
      db,
    )
  ).rows
  for (const slot of slots) {
    // Count updates coalesce into one current slot calendar item; provider copies suppress ICS.
    await sql`INSERT INTO group_slot_host_messages(group_slot_id,kind,rule_id,revision,due_at,expires_at,next_attempt_at)
      VALUES (${slot.id},'calendar','calendar',${slot.revision},${asDate(now)},${asDate(now.add({ hours: 24 }))},${asDate(now)})
      ON CONFLICT(group_slot_id,kind,rule_id) DO UPDATE SET revision=EXCLUDED.revision,
      due_at=EXCLUDED.due_at,expires_at=EXCLUDED.expires_at,next_attempt_at=EXCLUDED.next_attempt_at,
      state='pending',attempts=0,claim_token=NULL,lease_until=NULL
      WHERE group_slot_host_messages.revision < EXCLUDED.revision`.execute(db)
    if (slot.state !== 'open') {
      await sql`UPDATE group_slot_host_messages SET state='skipped',claim_token=NULL,lease_until=NULL
        WHERE group_slot_id=${slot.id} AND kind<>'calendar' AND state IN ('pending','processing')`.execute(
        db,
      )
      continue
    }
    const snapshot = slot.host_notification_settings
    if (!snapshot?.notifications) continue
    for (const kind of ['reminder', 'follow_up'] as const) {
      const rules =
        kind === 'reminder' ? snapshot.notifications.reminders : snapshot.notifications.followUps
      for (const rule of rules.filter((rule) => rule.recipients.host)) {
        const due =
          kind === 'reminder'
            ? instant(slot.start_at).subtract({ minutes: rule.offsetMinutes })
            : instant(slot.end_at).add({ minutes: rule.offsetMinutes })
        const skipped =
          Temporal.Instant.compare(
            due,
            instant(slot.created_at).add({ hours: kind === 'reminder' ? 1 : 0 }),
          ) <= 0
        await sql`INSERT INTO group_slot_host_messages(group_slot_id,kind,rule_id,revision,due_at,expires_at,next_attempt_at,state)
          VALUES (${slot.id},${kind},${rule.id},1,${asDate(due)},${kind === 'reminder' ? slot.start_at : asDate(due.add({ hours: 24 }))},${asDate(due)},${skipped ? 'skipped' : 'pending'})
          ON CONFLICT(group_slot_id,kind,rule_id) DO NOTHING`.execute(db)
      }
    }
  }
}

interface Message extends Slot {
  logistics_ready: boolean
  message_id: string
  kind: 'calendar' | 'reminder' | 'follow_up'
  rule_id: string
  message_revision: string
  message_state: string
  attempts: number
  claim_token: string | null
  lease_until: Date | null
  wall_now: Date
  due_at: Date
  expires_at: Date
  next_attempt_at: Date
  host_name: string | null
  host_email: string | null
  locale: string | null
  time_zone: string | null
}
async function current(db: Db, id: string, lock = false) {
  return (
    await sql<Message>`SELECT s.*,m.id AS message_id,m.kind,m.rule_id,m.revision AS message_revision,
    m.state AS message_state,m.attempts,m.claim_token,m.lease_until,m.due_at,m.expires_at,m.next_attempt_at,
    ((s.location->>'autoCreate') IS DISTINCT FROM 'true' OR EXISTS(SELECT FROM group_slot_conferences c WHERE c.group_slot_id=s.id AND c.state='ready' AND c.applied_revision=c.revision AND c.join_url IS NOT NULL
      AND c.organizer_user_id=s.host_user_id AND c.invitation_organizer_email=u.email)) AS logistics_ready,
    clock_timestamp() AS wall_now,u.name AS host_name,u.email AS host_email,p.locale,p.time_zone
    FROM group_slot_host_messages m JOIN group_slots s ON s.id=m.group_slot_id
    LEFT JOIN auth."user" u ON u.id=s.host_user_id AND u."emailVerified"
      AND EXISTS(SELECT FROM auth.member member WHERE member."userId"=u.id AND member."organizationId"=s.organization_id)
    LEFT JOIN profiles p ON p.user_id=u.id WHERE m.id=${id}
    ${lock ? sql`FOR UPDATE OF m SKIP LOCKED` : sql``}`.execute(db)
  ).rows[0]
}
function obsolete(row: Message, now: Date) {
  return (
    now >= row.expires_at ||
    !row.host_email ||
    (row.kind !== 'calendar' && row.state !== 'open') ||
    (row.kind === 'calendar' &&
      (row.destination_calendar_id !== null || row.message_revision !== row.revision))
  )
}

/** Host-only projection. Never load a booker or private answers to compose this message. */
export function groupHostMessage(row: Message, deps: NotificationDeps): MailMessage {
  const zh = interfaceLanguage(row.locale) === 'zh-CN'
  const cancelled = row.state !== 'open'
  const heading =
    row.kind === 'reminder'
      ? zh
        ? '团体活动提醒'
        : 'Group event reminder'
      : row.kind === 'follow_up'
        ? zh
          ? '团体活动已结束'
          : 'Group event has ended'
        : cancelled
          ? zh
            ? '团体活动已取消'
            : 'Group event cancelled'
          : zh
            ? '团体活动更新'
            : 'Group event updated'
  const count = zh ? `已预订席位：${row.active_seats}。` : `Booked seats: ${row.active_seats}.`
  const time = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: row.time_zone ?? 'UTC',
  }).format(row.start_at)
  const text = `${heading}\n${row.title}\n${time}\n${count}`
  return {
    to: row.host_email as string,
    subject: `${heading}${zh ? '：' : ': '}${row.title}`,
    text,
    html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`,
    ...(row.kind === 'calendar' && {
      attachments: [
        icsAttachment({
          method: cancelled ? 'CANCEL' : 'REQUEST',
          uid: `group-${row.id}@hourmere`,
          sequence: Number(row.revision),
          stamp: clock(deps),
          start: instant(row.start_at),
          end: instant(row.end_at),
          summary: row.title,
          description: count,
          organizer: {
            name: row.ical_organizer_name ?? row.host_name ?? '',
            email:
              row.ical_organizer_email ?? deps.mailer.senderEmail ?? (row.host_email as string),
          },
          attendees: [
            {
              name: row.host_name ?? '',
              email: row.host_email as string,
              role: 'CHAIR',
              partstat: 'ACCEPTED',
              rsvp: false,
            },
          ],
        }),
      ],
    }),
  }
}

class Obsolete extends Error {}
/** Short durable claim, bounded SMTP, and a current slot/claim check after the shared budget wait. */
export async function deliverGroupHostMail(
  deps: NotificationDeps,
  id: string,
  signal?: AbortSignal,
) {
  const claim = await deps.db.transaction().execute(async (trx) => {
    const row = await current(trx, id, true)
    if (!row || !['pending', 'processing'].includes(row.message_state)) return
    if (row.lease_until && row.lease_until > row.wall_now) return
    if (obsolete(row, asDate(clock(deps)))) {
      await sql`UPDATE group_slot_host_messages SET state='skipped',claim_token=NULL,lease_until=NULL WHERE id=${id}`.execute(
        trx,
      )
      return
    }
    if (row.next_attempt_at > asDate(clock(deps)) || row.due_at > asDate(clock(deps))) return
    if (row.attempts >= 13) {
      await sql`UPDATE group_slot_host_messages SET state='failed',claim_token=NULL,lease_until=NULL WHERE id=${id}`.execute(
        trx,
      )
      return
    }
    const token = randomUUID()
    await sql`UPDATE group_slot_host_messages SET state='processing',attempts=attempts+1,claim_token=${token},lease_until=clock_timestamp()+interval '90 seconds' WHERE id=${id}`.execute(
      trx,
    )
    return { ...row, token, attempt: row.attempts + 1 }
  })
  if (!claim) return
  let state = 'sent'
  try {
    // Pin calendar organizer outside SMTP; no seat or slot lock is held during delivery.
    if (claim.kind === 'calendar')
      await sql`UPDATE group_slots SET ical_organizer_name=${claim.host_name},ical_organizer_email=${deps.mailer.senderEmail ?? claim.host_email}
      WHERE id=${claim.id} AND ical_organizer_email IS NULL`.execute(deps.db)
    state = await deps.db.transaction().execute(async (trx) => {
      const host = await trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', claim.host_user_id)
        .where('email', '=', claim.host_email as string)
        .where('emailVerified', '=', true)
        .forShare()
        .executeTakeFirst()
      if (!host) throw new Obsolete()
      const member = (
        await sql`SELECT m.id FROM auth.member m JOIN group_slots s ON s.organization_id=m."organizationId"
        WHERE s.id=${claim.id} AND m."userId"=${claim.host_user_id} FOR SHARE OF m`.execute(trx)
      ).rows[0]
      if (!member) throw new Obsolete()
      // Serialize receipts for this exact delivery without holding a slot/booking lock.
      const receipt = (
        await sql`INSERT INTO group_slot_host_mail_receipts(message_id,revision,outcome)
        VALUES (${id},${claim.message_revision},'sent') ON CONFLICT DO NOTHING RETURNING message_id`.execute(
          trx,
        )
      ).rows[0]
      if (!receipt) return 'sent'
      await lockNotificationEmailBudget(trx)
      const row = await current(trx, id)
      if (
        !row ||
        row.claim_token !== claim.token ||
        row.attempts !== claim.attempt ||
        !row.lease_until ||
        row.lease_until <= row.wall_now ||
        obsolete(row, asDate(clock(deps)))
      )
        throw new Obsolete()
      if (row.kind !== 'follow_up' && row.state === 'open' && !row.logistics_ready)
        throw new Error('Slot conference remains pending')
      const reason = await notificationEmailBudget(
        trx,
        deps,
        notificationRecipientHash(row.host_email as string, deps.secret),
        false,
        asDate(clock(deps)),
      )
      if (reason) {
        await sql`UPDATE group_slot_host_mail_receipts SET outcome='suppressed' WHERE message_id=${id} AND revision=${claim.message_revision}`.execute(
          trx,
        )
        return 'suppressed'
      }
      const remaining = row.lease_until.getTime() - row.wall_now.getTime() - 1_000
      if (remaining <= 0) throw new Error('Slot host mail claim deadline reached')
      const timeout = AbortSignal.timeout(Math.min(60_000, remaining))
      await deps.mailer.send(groupHostMessage(row, deps), {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      await trx
        .insertInto('notification_email_sends')
        .values({ recipient_hash: null, sent_at: asDate(clock(deps)) })
        .execute()
      return 'sent'
    })
  } catch (error) {
    state = error instanceof Obsolete ? 'skipped' : claim.attempt >= 13 ? 'failed' : 'pending'
  }
  await sql`UPDATE group_slot_host_messages SET state=${state},claim_token=NULL,lease_until=NULL,
    next_attempt_at=${asDate(clock(deps).add({ milliseconds: Math.min(60_000 * 2 ** (claim.attempt - 1), 3_600_000) }))}
    WHERE id=${id} AND claim_token=${claim.token} AND attempts=${claim.attempt}`.execute(deps.db)
}

/** Durable due rows are the queue; a crash never needs to reconstruct policy from a seat. */
export function groupHostMailJob(deps: NotificationDeps) {
  return defineJob({
    name: 'group-slot-host-mail',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    retry: { limit: 0 },
    expireInSeconds: 300,
    handler: async (_, { signal }) => {
      const rows = (
        await sql<{ id: string }>`SELECT id FROM group_slot_host_messages
        WHERE state IN ('pending','processing') AND next_attempt_at<=${asDate(clock(deps))} AND due_at<=${asDate(clock(deps))}
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY next_attempt_at,id LIMIT 4`.execute(
          deps.db,
        )
      ).rows
      for (const row of rows) {
        signal.throwIfAborted()
        await deliverGroupHostMail(deps, row.id, signal)
      }
    },
  })
}
