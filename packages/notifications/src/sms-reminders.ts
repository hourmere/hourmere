import { createHash } from 'node:crypto'
import {
  formattingLocale,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'
import { type Db, isImportedBooking } from '@hourmere/db'
import { defineJob, type EnqueueOptions, type KyselyTransactionLike } from '@hourmere/jobs'
import {
  DEFAULT_NOTIFICATIONS,
  type NotificationSnapshot,
  REMINDER_MIN_GAP,
} from '@hourmere/scheduling/notification-settings'
import { sql } from 'kysely'
import { z } from 'zod'
import { SmsError } from './sms-provider.ts'
import type { SmsRequest } from './sms-service.ts'

export const BOOKING_SMS_REMINDER_JOB = 'booking-sms-reminder'
export const BookingSmsReminderPayload = z.strictObject({
  bookingId: z.uuid(),
  ruleId: z.string().min(1).max(64),
  startAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
})
type Payload = z.infer<typeof BookingSmsReminderPayload>
export interface SmsReminderQueue {
  enqueue(
    name: typeof BOOKING_SMS_REMINDER_JOB,
    payload: Payload,
    options?: EnqueueOptions,
  ): Promise<string | null>
}

/** Shares email reminder offsets and the absolute elapsed-time minimum gap. */
export async function enqueueBookingSmsReminders(
  queue: SmsReminderQueue,
  transaction: KyselyTransactionLike,
  bookingId: string,
  now: Temporal.Instant,
) {
  const db = transaction as Db
  if (await isImportedBooking(db, bookingId)) return
  const { rows } = await sql<{
    start_at: Date
    sms_reminders_enabled: boolean
    notification_snapshot: NotificationSnapshot | null
  }>`
    SELECT start_at,sms_reminders_enabled,notification_snapshot FROM bookings WHERE id=${bookingId}
  `.execute(db)
  const booking = rows[0]
  if (!booking?.sms_reminders_enabled) return
  const start = Temporal.Instant.fromEpochMilliseconds(booking.start_at.getTime())
  const rules =
    booking.notification_snapshot?.executionMode === 'configurable'
      ? booking.notification_snapshot.notifications.reminders
      : DEFAULT_NOTIFICATIONS.reminders
  for (const rule of rules) {
    if (!rule.recipients.invitee && !rule.recipients.guests) continue
    const due = start.subtract({ minutes: rule.offsetMinutes })
    if (Temporal.Instant.compare(due, now.add(REMINDER_MIN_GAP)) <= 0) continue
    await queue.enqueue(
      BOOKING_SMS_REMINDER_JOB,
      {
        bookingId,
        ruleId: rule.id,
        startAt: start.toString(),
        dueAt: due.toString(),
      },
      { transaction, startAfter: due, singletonKey: `sms:${bookingId}:${rule.id}` },
    )
  }
}

const copy: Record<InterfaceLanguage, { reminder: string; stop: string }> = {
  en: { reminder: 'Appointment reminder', stop: 'Reply STOP to opt out.' },
  'zh-CN': { reminder: '预约提醒', stop: '回复 STOP 退订。' },
  de: { reminder: 'Terminerinnerung', stop: 'Zum Abmelden STOP antworten.' },
  fr: { reminder: 'Rappel de rendez-vous', stop: 'Répondez STOP pour vous désinscrire.' },
  es: { reminder: 'Recordatorio de cita', stop: 'Responde STOP para darte de baja.' },
  'pt-BR': { reminder: 'Lembrete de agendamento', stop: 'Responda STOP para cancelar os SMS.' },
}
export function smsReminderText(input: {
  business: string
  locale: string | null
  timeZone: string | null
  start: Date
}) {
  const language = interfaceLanguage(input.locale) ?? 'en'
  let timeZone = input.timeZone ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone })
  } catch {
    timeZone = 'UTC'
  }
  const when = new Intl.DateTimeFormat(formattingLocale(language), {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(input.start)
  // User-written organization names cannot insert controls or turn the message into a long body.
  const business =
    input.business
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 60) || 'Hourmere'
  return `${business}: ${copy[language].reminder} ${when}. ${copy[language].stop}`
}
export interface SmsReminderDeps {
  db: Db
  sms: { sendSms(input: SmsRequest): Promise<{ providerMessageId: string }> }
  now?: (() => Temporal.Instant) | undefined
  log?: ((line: string) => void) | undefined
}

/** No personal data in pg-boss payloads or diagnostics; provider failures stay in this worker. */
export async function deliverBookingSmsReminder(deps: SmsReminderDeps, payload: Payload) {
  const now = deps.now?.() ?? Temporal.Now.instant()
  if (
    Temporal.Instant.compare(now, Temporal.Instant.from(payload.dueAt)) < 0 ||
    Temporal.Instant.compare(now, Temporal.Instant.from(payload.startAt)) >= 0
  )
    return
  if (await isImportedBooking(deps.db, payload.bookingId)) return
  const { rows } = await sql<{
    organization_id: string
    start_at: Date
    status: string
    sms_reminders_enabled: boolean
    notification_snapshot: NotificationSnapshot | null
    business: string
  }>`SELECT b.organization_id,b.start_at,b.status,b.sms_reminders_enabled,b.notification_snapshot,o.name AS business
    FROM bookings b JOIN auth.organization o ON o.id=b.organization_id
    WHERE b.id=${payload.bookingId}`.execute(deps.db)
  const booking = rows[0]
  if (
    booking?.status !== 'confirmed' ||
    !booking.sms_reminders_enabled ||
    booking.start_at.getTime() !== Date.parse(payload.startAt)
  )
    return
  const rules =
    booking.notification_snapshot?.executionMode === 'configurable'
      ? booking.notification_snapshot.notifications.reminders
      : DEFAULT_NOTIFICATIONS.reminders
  const rule = rules.find((rule) => rule.id === payload.ruleId)
  if (
    !rule ||
    Temporal.Instant.from(payload.startAt).subtract({ minutes: rule.offsetMinutes }).toString() !==
      Temporal.Instant.from(payload.dueAt).toString()
  )
    return
  const attendees = await sql<{
    id: string
    sms_phone: string
    locale: string | null
    time_zone: string | null
    is_booker: boolean
  }>`
    SELECT id,sms_phone,locale,time_zone,is_booker FROM booking_attendees
    WHERE booking_id=${payload.bookingId} AND sms_consent AND sms_phone IS NOT NULL
  `.execute(deps.db)
  for (const attendee of attendees.rows) {
    if (!(attendee.is_booker ? rule.recipients.invitee : rule.recipients.guests)) continue
    try {
      await deps.sms.sendSms({
        to: attendee.sms_phone,
        body: smsReminderText({
          business: booking.business,
          locale: attendee.locale,
          timeZone: attendee.time_zone,
          start: booking.start_at,
        }),
        organizationId: booking.organization_id,
        idempotencyKey: `reminder:${payload.bookingId}:${createHash('sha256').update(payload.ruleId).digest('hex').slice(0, 16)}:${attendee.id}`,
        beforeReserve: async (tx) => {
          const current = await sql<{ eligible: boolean }>`SELECT true AS eligible FROM bookings b
            JOIN booking_attendees a ON a.booking_id=b.id
            WHERE b.id=${payload.bookingId} AND b.status='confirmed' AND b.sms_reminders_enabled
            AND b.start_at=${payload.startAt}::timestamptz AND b.start_at > clock_timestamp()
            AND a.id=${attendee.id} AND a.sms_consent AND a.sms_phone=${attendee.sms_phone}
            FOR SHARE OF b,a`.execute(tx)
          return current.rows[0]?.eligible === true
        },
      })
    } catch (error) {
      // Never pass through arbitrary provider/database errors, which may contain request data.
      const code = error instanceof SmsError ? error.code : 'sms_delivery_unknown'
      deps.log?.(`SMS reminder: ${code}`)
    }
  }
}

export function bookingSmsReminderJob(deps: SmsReminderDeps) {
  return defineJob({
    name: BOOKING_SMS_REMINDER_JOB,
    payload: BookingSmsReminderPayload,
    policy: 'exclusive',
    concurrency: 2,
    expireInSeconds: 300,
    handler: (payload) => deliverBookingSmsReminder(deps, payload),
  })
}
