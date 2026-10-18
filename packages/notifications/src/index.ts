// Booking notifications (docs/notifications.md): the job that emails attendees and hosts
// when a booking is confirmed, rescheduled or cancelled and before it starts, and the helper
// the booking services call inside their transactions to queue those jobs.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db, Json } from '@hourmere/db'
import { defineJob, type EnqueueOptions, type KyselyTransactionLike } from '@hourmere/jobs'
import {
  type BookingEmailKind,
  type BookingEmailMeeting,
  bookingEmail,
  icsAttachment,
  type Mailer,
  type MailMessage,
  MailRejectedError,
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
  'conference_failed',
] as const satisfies readonly BookingEmailKind[]
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export const BOOKING_NOTIFICATION_JOB = 'booking-notification'

/**
 * How long before a meeting its reminder goes out: an absolute 24 hours, so across a
 * daylight saving change it arrives an hour earlier or later on the clock.
 */
export const REMINDER_LEAD = { hours: 24 } as const

/** No reminder when it would go out sooner than this after the booking (made just over a day ahead). */
export const REMINDER_MIN_GAP = { hours: 1 } as const

/** Fixed, so changing PUBLIC_URL does not orphan calendar entries made before. */
export const CALENDAR_UID_DOMAIN = 'hourmere'

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
  /** Receives a line for each email the mail server refused for good. Default: console.warn. */
  log?: ((line: string) => void) | undefined
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
    handler: ({ bookingId, kind }, { signal }) =>
      sendBookingNotification(deps, bookingId, kind, { signal }),
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
 * or moved booking a reminder REMINDER_LEAD before it starts (unless that is less than
 * REMINDER_MIN_GAP away). The old booking's reminder of a reschedule needs no cancelling:
 * it finds that booking cancelled when it runs and sends nothing.
 */
export async function enqueueBookingNotifications(
  queue: NotificationQueue,
  transaction: KyselyTransactionLike & { readonly isTransaction: boolean },
  event: BookingEvent,
  now: Temporal.Instant,
): Promise<void> {
  // Outside a transaction the jobs would commit on their own, without the booking change.
  if (!transaction.isTransaction) {
    throw new Error('enqueueBookingNotifications needs the transaction that writes the booking')
  }
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
  if (Temporal.Instant.compare(remindAt, now.add(REMINDER_MIN_GAP)) > 0) {
    await send('reminder', remindAt)
  }
}

/**
 * The booking services' `notify` (BookingNotifier in @hourmere/scheduling, given in their
 * contexts): queues each booking change's notifications through the transaction that makes
 * the change, judged by the instant the service used for its checks.
 */
export function bookingNotifier(queue: NotificationQueue) {
  return (
    transaction: KyselyTransactionLike & { readonly isTransaction: boolean },
    event: BookingEvent,
    now: Temporal.Instant,
  ): Promise<void> => enqueueBookingNotifications(queue, transaction, event, now)
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
  /** The booking this one replaced. */
  previous: { start: Temporal.Instant; end: Temporal.Instant; status: string } | undefined
  /** A booking that replaced this one (it was cancelled by a reschedule). */
  replaced: boolean
  automaticConference: boolean
}

/**
 * Everything the emails need, read now (the booking may have changed since the event), one
 * query at a time on one connection: a running job holds at most this one and its send
 * transaction's.
 */
function loadNotificationData(db: Db, bookingId: string): Promise<NotificationData | undefined> {
  return db.connection().execute(async (conn) => {
    const b = await conn
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
    const hosts = await conn
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
        'p.handle as profile_handle',
        'p.time_zone as profile_zone',
        's.time_zone as schedule_zone',
      ])
      .where('bh.booking_id', '=', bookingId)
      // Only addresses their owner proved. Accounts start verified; should one not be, it
      // gets nothing and is not named as organizer or attendee.
      .where('u.emailVerified', '=', true)
      .orderBy('u.id')
      .execute()
    const attendees = await conn
      .selectFrom('booking_attendees')
      .select(['id', 'name', 'email', 'time_zone', 'is_booker'])
      .where('booking_id', '=', bookingId)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute()
    const chain = await sql<{ id: string; depth: number }>`
      WITH RECURSIVE chain (id, rescheduled_from_id, depth) AS (
        SELECT id, rescheduled_from_id, 0 FROM bookings WHERE id = ${bookingId}
        UNION ALL
        SELECT b.id, b.rescheduled_from_id, c.depth + 1
          FROM bookings b JOIN chain c ON b.id = c.rescheduled_from_id
         WHERE c.depth < 1000
      )
      SELECT id, depth FROM chain ORDER BY depth DESC LIMIT 1`.execute(conn)
    const previous = b.rescheduled_from_id
      ? await conn
          .selectFrom('bookings')
          .select(['start_at', 'end_at', 'status'])
          .where('id', '=', b.rescheduled_from_id)
          .executeTakeFirst()
      : undefined
    const successor = await conn
      .selectFrom('bookings')
      .select('id')
      .where('rescheduled_from_id', '=', bookingId)
      .executeTakeFirst()

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
        name: h.name.trim() || h.profile_handle || h.email,
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
      previous: previous && {
        start: instant(previous.start_at),
        end: instant(previous.end_at),
        status: previous.status,
      },
      replaced: successor !== undefined,
      automaticConference: isRecord(b.location) && b.location.autoCreate === true,
    }
  })
}

/** Whether the booking, as it is now, is still what the email says. */
function stillTrue(
  kind: NotificationKind,
  booking: { status: string; start: Temporal.Instant },
  now: Temporal.Instant,
): boolean {
  if (kind === 'cancelled') return booking.status === 'cancelled'
  if (kind === 'conference_failed') return booking.status === 'confirmed'
  return booking.status === 'confirmed' && Temporal.Instant.compare(booking.start, now) > 0
}

/** Whether the job's email still applies, judged from everything it loaded. */
function stillApplies(kind: NotificationKind, data: NotificationData, now: Temporal.Instant) {
  if (!stillTrue(kind, data.booking, now)) return false
  // A reschedule email needs the booking it replaced, cancelled by that reschedule.
  if (kind === 'rescheduled') return data.previous?.status === 'cancelled'
  // A booking cancelled by a reschedule is announced by the reschedule email.
  if (kind === 'cancelled') return !data.replaced
  return true
}

/** Thrown inside a send transaction to roll it back when the booking changed meanwhile. */
class Overtaken extends Error {}
/** An obsolete host recipient must not suppress the original invitee's failure notice. */
class RecipientUnavailable extends Error {}

/** Private worker fence, never an externally supplied send/force-send capability. */
interface ConferenceNotificationClaim {
  leaseId: string
  attempt: number
}

/**
 * Sends one recipient's email once, with a narrow duplicate window. The row in
 * booking_notifications is inserted first and the transaction stays open while the mail
 * server takes the email: a failed send rolls the row back (the job retries it), and a
 * concurrent attempt for the same recipient waits on the row and then skips. If the commit
 * fails after the server accepted the email, the retry sends it again (and the first copy's
 * manage link does not work: its hash was rolled back).
 */
async function sendOnce(
  deps: NotificationDeps,
  key: {
    bookingId: string
    kind: NotificationKind
    recipient: string
    verifiedHost?: { id: string; email: string } | undefined
  },
  withManageLink: boolean,
  message: (manageToken: string | undefined) => MailMessage,
  clock: () => Temporal.Instant,
  signal: AbortSignal | undefined,
  conferenceClaim: ConferenceNotificationClaim | undefined,
): Promise<'sent' | 'sent before' | 'overtaken' | 'recipient unavailable'> {
  try {
    return await deps.db.transaction().execute(async (trx) => {
      if (key.verifiedHost) {
        // Parent protection before the notification's booking FK, matching user-deletion
        // order. Hold verification/address stable until this bounded SMTP attempt ends.
        const host = await trx
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', key.verifiedHost.id)
          .where('email', '=', key.verifiedHost.email)
          .where('emailVerified', '=', true)
          .forShare()
          .executeTakeFirst()
        if (!host) throw new RecipientUnavailable()
      }
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
      if (!claimed) return 'sent before'
      // Read the booking and the clock again: it may have been cancelled, or have started,
      // while an earlier recipient's email went out. Without a lock, which would hold up
      // that cancel.
      const current = await trx
        .selectFrom('bookings')
        .select(['status', 'start_at'])
        .where('id', '=', key.bookingId)
        .executeTakeFirst()
      if (
        !current ||
        !stillTrue(
          key.kind,
          { status: current.status, start: instant(current.start_at) },
          clock(),
        ) ||
        !(await conferenceNotificationAllowed(trx, key.bookingId, key.kind))
      ) {
        throw new Overtaken()
      }
      if (
        conferenceClaim &&
        !(await trx
          .selectFrom('booking_conference_notifications')
          .select('booking_id')
          .where('booking_id', '=', key.bookingId)
          .where('kind', '=', key.kind)
          .where('lease_id', '=', conferenceClaim.leaseId)
          .where('attempts', '=', conferenceClaim.attempt)
          .where('lease_until', '>', new Date(clock().epochMilliseconds))
          .where('delivered', '=', false)
          .where('exhausted_at', 'is', null)
          .executeTakeFirst())
      )
        throw new Overtaken()
      // An abort (worker shutdown) rejects here and rolls the row back for another worker.
      await deps.mailer.send(message(token), { signal })
      return 'sent'
    })
  } catch (err) {
    if (err instanceof Overtaken) return 'overtaken'
    if (err instanceof RecipientUnavailable) return 'recipient unavailable'
    throw err
  }
}

/** Some recipients' emails were refused for now; a retry sends only those. */
export class NotificationRetryError extends Error {
  override name = 'NotificationRetryError'
}

const codesOf = (err: MailRejectedError) =>
  [err.responseCode, err.enhancedCode].filter(Boolean).join(' ') || 'no code'

/**
 * Sends the emails for one booking event to every host and attendee who has not had them
 * yet, if they still describe the booking (a later change may have overtaken them).
 */
export async function sendBookingNotification(
  deps: NotificationDeps,
  bookingId: string,
  kind: NotificationKind,
  {
    signal,
    conferenceClaim,
  }: {
    signal?: AbortSignal | undefined
    conferenceClaim?: ConferenceNotificationClaim | undefined
  } = {},
): Promise<void> {
  const clock = deps.now ?? (() => Temporal.Now.instant())
  const now = clock()
  if (!(await conferenceNotificationAllowed(deps.db, bookingId, kind))) return
  const data = await loadNotificationData(deps.db, bookingId)
  if (!data || !stillApplies(kind, data, now)) return
  const { booking, hosts, attendees } = data
  const organizer = hosts[0]
  const invitee =
    attendees.find((a) => a.isBooker) ?? (kind === 'conference_failed' ? undefined : attendees[0])
  const log = deps.log ?? ((line: string) => console.warn(line))
  // No trusted organizer means no REQUEST. Automatic roots must retain their durable
  // pending notice instead of claiming delivery, so restored proof may still release it.
  if (!organizer && kind !== 'conference_failed' && kind !== 'cancelled') {
    log(
      `${new Date().toISOString()} WARN ${BOOKING_NOTIFICATION_JOB}: booking ${bookingId} has no host with a verified email address; not sending its ${kind} emails`,
    )
    if (data.automaticConference)
      throw new NotificationRetryError('A verified conference organizer is unavailable')
    return
  }
  // Nobody it is for.
  if (!invitee) {
    if (kind === 'conference_failed')
      throw new NotificationRetryError(
        'The original invitee is unavailable; failure notification remains pending',
      )
    return
  }
  const guests = kind === 'conference_failed' ? [] : attendees.filter((a) => a !== invitee)
  const email: typeof bookingEmail = (...args) => ({
    ...bookingEmail(...args),
    sensitive: data.automaticConference,
  })

  const meeting: BookingEmailMeeting = {
    eventName: booking.eventName,
    // A logistical failure needs no calendar organizer and must still reach the original
    // invitee when the pinned host was deleted or is no longer verified.
    hostName: organizer?.name ?? 'Host',
    inviteeName: invitee.name,
    inviteeEmail: invitee.email,
    guests: guests.map(({ name, email }) => ({ name, email })),
    start: booking.start,
    end: booking.end,
    location: booking.location,
    previous: data.previous,
    cancelReason: booking.cancelReason,
  }
  const invitation = (summary: string) =>
    kind === 'reminder' || kind === 'conference_failed' || !organizer
      ? undefined
      : icsAttachment({
          method: kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
          // The first booking of the chain: a reschedule updates the same calendar entry.
          uid: `${data.root.id}@${CALENDAR_UID_DOMAIN}`,
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
  const toAttendee = (attendee: (typeof attendees)[number]) => ({
    key: `attendee:${attendee.id}`,
    verifiedHost: undefined,
    withLinks: attendee === invitee && kind !== 'cancelled',
    message: (token: string | undefined) =>
      email(
        kind,
        meeting,
        {
          role: 'attendee',
          email: attendee.email,
          timeZone: attendee.timeZone,
          manageLinks: token === undefined ? undefined : inviteeManageLinks(deps.publicUrl, token),
        },
        { attachment: invitation(`${booking.eventName} with ${meeting.hostName}`) },
      ),
  })
  // Hosts first (verified addresses, and they most need to know), then the invitee, then
  // guests: a guest address that is slow to answer must not hold up the others.
  const recipients = [
    ...hosts.map((host) => ({
      key: `host:${host.id}`,
      verifiedHost:
        kind === 'conference_failed' || kind === 'cancelled'
          ? { id: host.id, email: host.email }
          : undefined,
      withLinks: false,
      message: () =>
        email(
          kind,
          meeting,
          { role: 'host', email: host.email, timeZone: host.timeZone, answers: booking.answers },
          { attachment: invitation(`${booking.eventName} with ${invitee.name}`) },
        ),
    })),
    toAttendee(invitee),
    ...guests.map(toAttendee),
  ]

  // One refused address must not hold up everyone else's email: refusals of an address are
  // collected and dealt with at the end. Anything else (the mail server unreachable, sign-in
  // or relaying refused, a sending limit, shutdown) would hit every remaining recipient the
  // same way, so it ends the attempt at once and the job is retried.
  const refused: string[] = []
  const gone: { key: string; err: MailRejectedError }[] = []
  // Recipients this run tried to send to (not those done in an earlier attempt).
  let attempted = 0
  for (const r of recipients) {
    signal?.throwIfAborted()
    try {
      const outcome = await sendOnce(
        deps,
        { bookingId, kind, recipient: r.key, verifiedHost: r.verifiedHost },
        r.withLinks,
        r.message,
        clock,
        signal,
        conferenceClaim,
      )
      // A later change (e.g. a cancellation) sends its own email.
      if (outcome === 'overtaken') return
      if (outcome === 'sent') attempted++
    } catch (err) {
      if (!(err instanceof MailRejectedError) || !err.recipientOnly) throw err
      attempted++
      if (err.permanent) gone.push({ key: r.key, err })
      else refused.push(`${r.key} (${codesOf(err)})`)
    }
  }
  // Every address tried in this run refused for good says more about the mail server than
  // about the addresses.
  if (gone.length > 0 && gone.length === attempted) {
    throw new NotificationRetryError(
      `the mail server refused every recipient it was offered for good (${gone.map((g) => codesOf(g.err)).join(', ')}); retrying rather than giving up on them`,
    )
  }
  for (const { key, err } of gone) {
    await deps.db
      .insertInto('booking_notifications')
      .values({ booking_id: bookingId, kind, recipient: key, outcome: 'rejected' })
      .onConflict((oc) => oc.doNothing())
      .execute()
    log(
      `${new Date().toISOString()} WARN ${BOOKING_NOTIFICATION_JOB}: the mail server refused the ${kind} email for booking ${bookingId} to ${key} for good (${codesOf(err)}); not retrying`,
    )
  }
  if (refused.length) {
    throw new NotificationRetryError(
      `the mail server refused ${refused.length} of ${recipients.length} emails for now: ${refused.join(', ')}`,
    )
  }
}

export {
  deliverSignInEmail,
  queuedSignInEmail,
  SIGN_IN_EMAIL_JOB,
  type SignInEmailDeps,
  SignInEmailPayload,
  signInEmailJobs,
} from './sign-in.ts'

/** Legacy queued jobs and outbox jobs share this gate; no final invitation while unready. */
export async function conferenceNotificationAllowed(
  db: Db,
  bookingId: string,
  kind: NotificationKind,
) {
  if (kind === 'cancelled') return true
  const row = await db
    .selectFrom('bookings as b')
    .leftJoin('booking_conferences as c', 'c.booking_id', 'b.id')
    .select(['b.location', 'c.state', 'c.revision', 'c.applied_revision'])
    .where('b.id', '=', bookingId)
    .executeTakeFirst()
  if (!row) return false
  const automatic = isRecord(row.location) && row.location.autoCreate === true
  if (!automatic) return kind !== 'conference_failed'
  if (kind === 'conference_failed') return row.state === 'failed'
  return (
    row.state === 'ready' &&
    row.applied_revision === row.revision &&
    isRecord(row.location) &&
    typeof row.location.url === 'string'
  )
}

// An initial attempt plus twelve retries, counted durably across cron jobs and crashes.
const CONFERENCE_NOTIFICATION_ATTEMPTS = 13
const CONFERENCE_NOTIFICATION_LEASE_MS = 600_000
const CONFERENCE_NOTIFICATION_SEND_MS = 240_000
const conferenceRetryDelay = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000)

function logConferenceNotificationExhausted(
  deps: NotificationDeps,
  row: { booking_id: string; kind: string },
) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  log(
    `WARN conference-notification-dispatch: booking ${row.booking_id} kind ${row.kind} exhausted its delivery budget`,
  )
}

/** Claim only the outbox row; commit before any recipient transaction or network I/O. */
async function claimConferenceNotification(deps: NotificationDeps, now: Date) {
  return deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('booking_conference_notifications as n')
      .innerJoin('bookings as b', 'b.id', 'n.booking_id')
      .innerJoin('booking_conferences as c', 'c.booking_id', 'b.id')
      .select(['n.booking_id', 'n.kind', 'n.attempts'])
      .where('n.delivered', '=', false)
      .where('n.exhausted_at', 'is', null)
      .where('n.attempts', '<', CONFERENCE_NOTIFICATION_ATTEMPTS)
      .where('n.due_at', '<=', now)
      .where((eb) => eb.or([eb('n.lease_until', 'is', null), eb('n.lease_until', '<=', now)]))
      .where('b.status', '=', 'confirmed')
      .where((eb) => eb.or([eb('n.kind', '=', 'conference_failed'), eb('b.start_at', '>', now)]))
      .where((eb) =>
        eb.or([
          eb.and([eb('n.kind', '=', 'conference_failed'), eb('c.state', '=', 'failed')]),
          eb.and([eb('n.kind', '!=', 'conference_failed'), eb('c.state', '=', 'ready')]),
        ]),
      )
      .orderBy('n.due_at')
      .orderBy('n.booking_id')
      .orderBy('n.kind')
      .limit(1)
      .forUpdate('n')
      .skipLocked()
      .executeTakeFirst()
    if (!row) return
    const attempt = row.attempts + 1
    const leaseId = randomUUID()
    await trx
      .updateTable('booking_conference_notifications')
      .set({
        attempts: attempt,
        lease_id: leaseId,
        lease_until: new Date(now.getTime() + CONFERENCE_NOTIFICATION_LEASE_MS),
        due_at: new Date(now.getTime() + conferenceRetryDelay(attempt)),
      })
      .where('booking_id', '=', row.booking_id)
      .where('kind', '=', row.kind)
      .execute()
    return { ...row, attempt, leaseId }
  })
}

/** A durable, bounded per-row outbox independent of legacy exclusive notification keys. */
export async function dispatchConferenceNotifications(
  deps: NotificationDeps,
  signal?: AbortSignal,
) {
  const clock = () => new Date((deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds)
  signal?.throwIfAborted()
  // A crashed last attempt already consumed the budget. Its expired claim becomes an
  // inspectable failure, not permission for a fourteenth send or a fabricated receipt.
  const expiredAt = clock()
  const expired = await sql<{ booking_id: string; kind: string }>`
    WITH expired AS (
      SELECT booking_id,kind FROM booking_conference_notifications
       WHERE NOT delivered AND exhausted_at IS NULL
         AND attempts >= ${CONFERENCE_NOTIFICATION_ATTEMPTS} AND lease_until <= ${expiredAt}
       ORDER BY lease_until,booking_id,kind LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    UPDATE booking_conference_notifications AS n
       SET exhausted_at=${expiredAt},last_error='attempt_expired',lease_id=NULL,lease_until=NULL
      FROM expired WHERE n.booking_id=expired.booking_id AND n.kind=expired.kind
    RETURNING n.booking_id,n.kind`.execute(deps.db)
  for (const row of expired.rows) logConferenceNotificationExhausted(deps, row)
  for (let batch = 0; batch < 100; batch++) {
    signal?.throwIfAborted()
    const row = await claimConferenceNotification(deps, clock())
    if (!row) return
    const kind = row.kind as NotificationKind
    const finish = () =>
      deps.db
        .updateTable('booking_conference_notifications')
        .where('booking_id', '=', row.booking_id)
        .where('kind', '=', row.kind)
        .where('lease_id', '=', row.leaseId)
        .where('attempts', '=', row.attempt)
        .where('exhausted_at', 'is', null)
        .where('delivered', '=', false)
    let errorCode: 'recipient_retry' | 'delivery_failed' | 'interrupted' | undefined
    const timeout = AbortSignal.timeout(CONFERENCE_NOTIFICATION_SEND_MS)
    try {
      await sendBookingNotification(deps, row.booking_id, kind, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        conferenceClaim: { leaseId: row.leaseId, attempt: row.attempt },
      })
    } catch (error) {
      // Never retain the SMTP/provider/error body: it may contain private recipients.
      errorCode = signal?.aborted
        ? 'interrupted'
        : error instanceof NotificationRetryError
          ? 'recipient_retry'
          : 'delivery_failed'
    }
    const exhausted = errorCode !== undefined && row.attempt >= CONFERENCE_NOTIFICATION_ATTEMPTS
    const result = await finish()
      .set({
        delivered: errorCode === undefined,
        last_error: errorCode ?? null,
        exhausted_at: exhausted ? clock() : null,
        lease_id: null,
        lease_until: null,
      })
      .returning('booking_id')
      .execute()
    if (exhausted && result.length) logConferenceNotificationExhausted(deps, row)
    signal?.throwIfAborted()
  }
}
export function conferenceNotificationDispatchJob(deps: NotificationDeps) {
  return defineJob({
    name: 'conference-notification-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 300,
    retry: { limit: 12, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 },
    handler: (_payload, { signal }) => dispatchConferenceNotifications(deps, signal),
  })
}
