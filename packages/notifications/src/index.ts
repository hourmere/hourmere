// Booking notifications (docs/notifications.md): the job that emails attendees and hosts
// when a booking is confirmed, rescheduled or cancelled and before it starts, and the helper
// the booking services call inside their transactions to queue those jobs.
import { createHash, randomBytes } from 'node:crypto'
import type { Db, Json } from '@hourmere/db'
import { defineJob, type EnqueueOptions, type KyselyTransactionLike } from '@hourmere/jobs'
import {
  type BookingEmailKind,
  type BookingEmailMeeting,
  bookingEmail,
  icsAttachment,
  type Mailer,
  type MailMessage,
  type ManageLinks,
  type MeetingLocation,
  meetingLocationText,
} from '@hourmere/mail'
import { sql } from 'kysely'
import { z } from 'zod'

export const NOTIFICATION_KINDS = [
  'confirmed',
  'rescheduled',
  'cancelled',
  'reminder',
] as const satisfies readonly BookingEmailKind[]
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const BOOKING_NOTIFICATION_JOB = 'booking-notification'

/** How long before a meeting its reminder goes out. */
export const REMINDER_LEAD = { hours: 24 } as const

/**
 * The job's payload: which booking and what happened. Nothing else, and never a secret:
 * the job loads the booking when it runs and mints the invitee's link secret itself.
 */
export const BookingNotificationPayload = z.strictObject({
  bookingId: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
})

export interface NotificationDeps {
  db: Db
  mailer: Mailer
  /** PUBLIC_URL: manage links and invitation UIDs are built from it. */
  publicUrl: string
  now?: (() => Temporal.Instant) | undefined
}

/** The job definition, with its handler bound to the database and mailer. */
export function bookingNotificationJob(deps: NotificationDeps) {
  return defineJob({
    name: BOOKING_NOTIFICATION_JOB,
    payload: BookingNotificationPayload,
    // One queued or running job per booking and kind (singletonKey below), so a repeated
    // enqueue while one is pending does nothing. booking_notifications makes sends idempotent.
    policy: 'exclusive',
    // A mail server that is down gets about seven hours: 1 minute, doubling, at most an hour.
    retry: { limit: 12, delaySeconds: 60, backoff: true, maxDelaySeconds: 3600 },
    expireInSeconds: 300,
    concurrency: 2,
    handler: ({ bookingId, kind }) => sendBookingNotification(deps, bookingId, kind),
  })
}

// --- Queueing (called by the booking services, inside their transactions) ----------------

export type BookingEvent =
  | { type: 'created'; bookingId: string; start: Temporal.Instant }
  /** `bookingId` is the new booking, the one that replaced the old. */
  | { type: 'rescheduled'; bookingId: string; start: Temporal.Instant }
  | { type: 'cancelled'; bookingId: string }

/** What enqueueBookingNotifications needs of a Jobs instance. */
export interface NotificationQueue {
  enqueue(
    name: typeof BOOKING_NOTIFICATION_JOB,
    payload: z.input<typeof BookingNotificationPayload>,
    options?: EnqueueOptions,
  ): Promise<string | null>
}

/**
 * Queues the notifications for a booking event through the caller's transaction, so they
 * exist exactly when the booking change commits: the email about the event, and for a new
 * or moved booking a reminder REMINDER_LEAD before it starts (when that is still ahead).
 * The old booking's reminder of a reschedule needs no cancelling: it finds that booking
 * cancelled when it runs and sends nothing.
 */
export async function enqueueBookingNotifications(
  queue: NotificationQueue,
  transaction: KyselyTransactionLike,
  event: BookingEvent,
  now: Temporal.Instant,
): Promise<void> {
  const send = (kind: NotificationKind, startAfter?: Temporal.Instant) =>
    queue.enqueue(
      BOOKING_NOTIFICATION_JOB,
      { bookingId: event.bookingId, kind },
      { transaction, singletonKey: `${event.bookingId}:${kind}`, startAfter },
    )
  if (event.type === 'cancelled') {
    await send('cancelled')
    return
  }
  await send(event.type === 'created' ? 'confirmed' : 'rescheduled')
  const remindAt = event.start.subtract(REMINDER_LEAD)
  if (Temporal.Instant.compare(remindAt, now) > 0) await send('reminder', remindAt)
}

// --- Sending ------------------------------------------------------------------------------

/**
 * The invitee's manage links. The secret is in the fragment, which browsers send neither to
 * servers nor in Referer; the web app reads it and calls the API with `X-Manage-Token`.
 */
export function inviteeManageLinks(publicUrl: string, token: string): ManageLinks {
  const base = `${new URL(publicUrl).origin}/booking#token=${encodeURIComponent(token)}`
  return { reschedule: `${base}&action=reschedule`, cancel: `${base}&action=cancel` }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const instant = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime())

/** A valid IANA zone or undefined. */
function timeZone(value: string | null | undefined): string | undefined {
  if (!value || /^[+-]/.test(value)) return undefined
  try {
    return new Temporal.ZonedDateTime(0n, value).timeZoneId
  } catch {
    return undefined
  }
}

/** `bookings.location` as the emails show it; unknown shapes are left out. */
function meetingLocation(value: Json | null): MeetingLocation | null {
  if (!isRecord(value)) return null
  const text = (key: string) => {
    const v = value[key]
    return typeof v === 'string' && v.trim() !== '' ? v : undefined
  }
  const url = text('url')
  switch (value.kind) {
    case 'link':
      return url ? { kind: 'link', url } : null
    case 'google_meet':
    case 'zoom': {
      const label = value.kind === 'zoom' ? 'Zoom' : 'Google Meet'
      return url ? { kind: 'link', url, label } : { kind: 'custom', text: label }
    }
    case 'phone': {
      const number = text('number')
      return number ? { kind: 'phone', number } : null
    }
    case 'in_person': {
      const address = text('address')
      return address ? { kind: 'address', address } : null
    }
    default:
      return null
  }
}

function formatAnswer(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ')
  return undefined
}

/** Answers in question order, labelled; answers to removed questions keep their id. */
function answersOf(
  questions: Json | null,
  responses: Json,
): { question: string; answer: string }[] {
  const given = isRecord(responses) ? responses : {}
  const answers: { question: string; answer: string }[] = []
  const seen = new Set<string>()
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!isRecord(q) || typeof q.id !== 'string' || !Object.hasOwn(given, q.id)) continue
    seen.add(q.id)
    const answer = formatAnswer(given[q.id])
    if (answer) answers.push({ question: typeof q.label === 'string' ? q.label : q.id, answer })
  }
  for (const [id, value] of Object.entries(given)) {
    const answer = seen.has(id) ? undefined : formatAnswer(value)
    if (answer) answers.push({ question: id, answer })
  }
  return answers
}

interface NotificationData {
  booking: {
    id: string
    status: string
    start: Temporal.Instant
    end: Temporal.Instant
    eventName: string
    location: MeetingLocation | null
    answers: { question: string; answer: string }[]
    cancelReason: string | null
    rescheduledFromId: string | null
  }
  hosts: { id: string; name: string; email: string; timeZone: string }[]
  /** The invitee first, then guests. */
  attendees: { id: string; name: string; email: string; timeZone: string; isBooker: boolean }[]
  /** The booking this chain of reschedules began with, and how many reschedules ago. */
  root: { id: string; depth: number }
  previous: { start: Temporal.Instant; end: Temporal.Instant } | undefined
  /** A booking that replaced this one (it was cancelled by a reschedule). */
  replaced: boolean
}

/** Everything the emails need, read now: the booking may have changed since the event. */
async function loadNotificationData(
  db: Db,
  bookingId: string,
): Promise<NotificationData | undefined> {
  const b = await db
    .selectFrom('bookings as b')
    .leftJoin('event_types as et', 'et.id', 'b.event_type_id')
    .select([
      'b.id',
      'b.status',
      'b.start_at',
      'b.end_at',
      'b.title',
      'b.location',
      'b.responses',
      'b.cancel_reason',
      'b.rescheduled_from_id',
      'et.title as event_title',
      'et.questions',
    ])
    .where('b.id', '=', bookingId)
    .executeTakeFirst()
  if (!b) return undefined

  const [hosts, attendees, chain, previous, successor] = await Promise.all([
    db
      .selectFrom('booking_hosts as bh')
      .innerJoin('auth.user as u', 'u.id', 'bh.user_id')
      .leftJoin('profiles as p', 'p.user_id', 'bh.user_id')
      .leftJoin('schedules as s', (join) =>
        join.onRef('s.user_id', '=', 'bh.user_id').on('s.is_default', '=', true),
      )
      .select([
        'u.id',
        'u.name',
        'u.email',
        'p.time_zone as profile_zone',
        's.time_zone as schedule_zone',
      ])
      .where('bh.booking_id', '=', bookingId)
      .orderBy('u.id')
      .execute(),
    db
      .selectFrom('booking_attendees')
      .select(['id', 'name', 'email', 'time_zone', 'is_booker'])
      .where('booking_id', '=', bookingId)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute(),
    sql<{ id: string; depth: number }>`
      WITH RECURSIVE chain (id, rescheduled_from_id, depth) AS (
        SELECT id, rescheduled_from_id, 0 FROM bookings WHERE id = ${bookingId}
        UNION ALL
        SELECT b.id, b.rescheduled_from_id, c.depth + 1
          FROM bookings b JOIN chain c ON b.id = c.rescheduled_from_id
         WHERE c.depth < 1000
      )
      SELECT id, depth FROM chain ORDER BY depth DESC LIMIT 1`.execute(db),
    b.rescheduled_from_id
      ? db
          .selectFrom('bookings')
          .select(['start_at', 'end_at'])
          .where('id', '=', b.rescheduled_from_id)
          .executeTakeFirst()
      : undefined,
    db
      .selectFrom('bookings')
      .select('id')
      .where('rescheduled_from_id', '=', bookingId)
      .executeTakeFirst(),
  ])

  return {
    booking: {
      id: b.id,
      status: b.status,
      start: instant(b.start_at),
      end: instant(b.end_at),
      eventName: b.event_title ?? b.title,
      location: meetingLocation(b.location),
      answers: answersOf(b.questions, b.responses),
      cancelReason: b.cancel_reason,
      rescheduledFromId: b.rescheduled_from_id,
    },
    // Times in the host's profile zone, else their default schedule's, else UTC.
    hosts: hosts.map((h) => ({
      id: h.id,
      name: h.name,
      email: h.email,
      timeZone: timeZone(h.profile_zone) ?? timeZone(h.schedule_zone) ?? 'UTC',
    })),
    attendees: attendees.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      timeZone: timeZone(a.time_zone) ?? 'UTC',
      isBooker: a.is_booker,
    })),
    root: chain.rows[0] ?? { id: b.id, depth: 0 },
    previous: previous && { start: instant(previous.start_at), end: instant(previous.end_at) },
    replaced: successor !== undefined,
  }
}

/** Whether the email still describes the booking as it is now. */
function stillTrue(kind: NotificationKind, data: NotificationData, now: Temporal.Instant): boolean {
  const { booking } = data
  const ahead = Temporal.Instant.compare(booking.start, now) > 0
  switch (kind) {
    case 'confirmed':
      return booking.status === 'confirmed' && ahead
    case 'rescheduled':
      return booking.status === 'confirmed' && booking.rescheduledFromId !== null && ahead
    case 'reminder':
      return booking.status === 'confirmed' && ahead
    case 'cancelled':
      // A booking cancelled by a reschedule is announced by the reschedule email.
      return booking.status === 'cancelled' && !data.replaced
  }
}

/**
 * Sends one recipient's email at most once. The row in booking_notifications is inserted
 * first and the transaction stays open while the mail server takes the email: a failed send
 * rolls the row back (the job retries it), and a concurrent attempt for the same recipient
 * waits on the row and then skips. Only if the commit fails after the server accepted the
 * email can it go out twice.
 */
async function sendOnce(
  deps: NotificationDeps,
  key: { bookingId: string; kind: NotificationKind; recipient: string },
  withManageLink: boolean,
  message: (manageToken: string | undefined) => MailMessage,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    // The same format as the token the booking services issue (32 random bytes, base64url).
    const token = withManageLink ? randomBytes(32).toString('base64url') : undefined
    const claimed = await trx
      .insertInto('booking_notifications')
      .values({
        booking_id: key.bookingId,
        kind: key.kind,
        recipient: key.recipient,
        manage_token_hash: token === undefined ? null : sha256(token),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('recipient')
      .executeTakeFirst()
    if (!claimed) return
    await deps.mailer.send(message(token))
  })
}

/**
 * Sends the emails for one booking event to every attendee and host who has not had them
 * yet, if they still describe the booking (a later change may have overtaken them).
 */
export async function sendBookingNotification(
  deps: NotificationDeps,
  bookingId: string,
  kind: NotificationKind,
): Promise<void> {
  const now = (deps.now ?? (() => Temporal.Now.instant()))()
  const data = await loadNotificationData(deps.db, bookingId)
  if (!data || !stillTrue(kind, data, now)) return
  const { booking, hosts, attendees } = data
  const organizer = hosts[0]
  const invitee = attendees.find((a) => a.isBooker) ?? attendees[0]
  // Nobody to send on behalf of, or nobody it is for.
  if (!organizer || !invitee) return

  const meeting: BookingEmailMeeting = {
    eventName: booking.eventName,
    hostName: organizer.name,
    inviteeName: invitee.name,
    inviteeEmail: invitee.email,
    guests: attendees.filter((a) => a !== invitee).map(({ name, email }) => ({ name, email })),
    start: booking.start,
    end: booking.end,
    location: booking.location,
    previous: data.previous,
    cancelReason: booking.cancelReason,
  }
  const invitation = (summary: string) =>
    kind === 'reminder'
      ? undefined
      : icsAttachment({
          method: kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
          // The first booking of the chain: a reschedule updates the same calendar entry.
          uid: `${data.root.id}@${new URL(deps.publicUrl).hostname}`,
          // Each reschedule is a new version; a cancellation supersedes the current one.
          sequence: data.root.depth + (kind === 'cancelled' ? 1 : 0),
          stamp: now,
          start: booking.start,
          end: booking.end,
          summary,
          location: booking.location ? meetingLocationText(booking.location) : undefined,
          organizer: { name: organizer.name, email: organizer.email },
          attendees: [
            ...attendees.map(({ name, email }) => ({ name, email })),
            ...hosts.slice(1).map(({ name, email }) => ({ name, email })),
          ],
        })

  for (const attendee of attendees) {
    const withLinks = attendee === invitee && kind !== 'cancelled'
    await sendOnce(
      deps,
      { bookingId, kind, recipient: `attendee:${attendee.id}` },
      withLinks,
      (token) =>
        bookingEmail(
          kind,
          meeting,
          {
            role: 'attendee',
            email: attendee.email,
            timeZone: attendee.timeZone,
            manageLinks:
              token === undefined ? undefined : inviteeManageLinks(deps.publicUrl, token),
          },
          { attachment: invitation(`${booking.eventName} with ${organizer.name}`) },
        ),
    )
  }
  for (const host of hosts) {
    await sendOnce(deps, { bookingId, kind, recipient: `host:${host.id}` }, false, () =>
      bookingEmail(
        kind,
        meeting,
        { role: 'host', email: host.email, timeZone: host.timeZone, answers: booking.answers },
        { attachment: invitation(`${booking.eventName} with ${invitee.name}`) },
      ),
    )
  }
}
