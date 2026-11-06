import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { rescheduleRequestEmail } from '@hourmere/mail'
import type { BookingNotifier } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  hostBookingUrl,
  inviteeManageLinks,
  loadNotificationData,
  type NotificationDeps,
  Overtaken,
  sendOnce,
} from './index.ts'

type RequestNotice = {
  bookingId: string
  requestId: string
  kind: 'reschedule_requested' | 'reschedule_request_expired'
}
interface RequestRow {
  id: string
  booking_id: string
  state: string
  note: string | null
  expires_at: Date
}

async function requestRow(db: Db, id: string) {
  return (
    await sql<RequestRow>`SELECT id,booking_id,state,note,expires_at FROM booking_reschedule_requests WHERE id=${id}::uuid`.execute(
      db,
    )
  ).rows[0]
}

export async function sendRescheduleRequestNotification(
  deps: NotificationDeps,
  notice: RequestNotice,
  signal?: AbortSignal,
) {
  const clock = deps.now ?? (() => Temporal.Now.instant())
  const row = await requestRow(deps.db, notice.requestId)
  const data = await loadNotificationData(deps.db, notice.bookingId)
  const expired = notice.kind === 'reschedule_request_expired'
  const current = (request: RequestRow | undefined) =>
    request?.booking_id === notice.bookingId &&
    request.state === (expired ? 'expired' : 'pending') &&
    (expired || request.expires_at.getTime() > clock().epochMilliseconds)
  if (!current(row) || !row || !data || data.booking.status !== 'confirmed' || data.replaced) return
  const invitee = data.attendees.find((a) => a.isBooker)
  if (!invitee) return
  const meeting = {
    eventName: data.booking.eventName,
    hostName: data.hosts[0]?.name ?? '',
    hostNames: data.hosts.map((h) => h.displayName),
    inviteeName: invitee.name,
    inviteeEmail: invitee.email,
    inviteeTimeZone: invitee.timeZone,
    start: data.booking.start,
    end: data.booking.end,
    location: null,
  }
  const recipients = expired
    ? data.hosts.map((host) => ({ ...host, host: true }))
    : [{ ...invitee, host: false }]
  for (const recipient of recipients) {
    signal?.throwIfAborted()
    await sendOnce(
      deps,
      {
        bookingId: notice.bookingId,
        kind: notice.kind,
        messageKey: notice.requestId,
        recipient: `${recipient.host ? 'host' : 'attendee'}:${recipient.id}`,
        email: recipient.email,
        verifiedHost: recipient.host ? { id: recipient.id, email: recipient.email } : undefined,
        conferenceRevision: undefined,
        finalCheck: async (db) => {
          if (!current(await requestRow(db, notice.requestId))) throw new Overtaken()
        },
      },
      !expired,
      (token) =>
        rescheduleRequestEmail(
          meeting,
          recipient.host
            ? {
                role: 'host',
                answers: [],
                email: recipient.email,
                timeZone: recipient.timeZone,
                locale: recipient.locale,
              }
            : {
                role: 'attendee',
                email: recipient.email,
                timeZone: recipient.timeZone,
                locale: recipient.locale,
                manageLinks: token ? inviteeManageLinks(deps.publicUrl, token) : undefined,
              },
          {
            expired,
            expiresAt: Temporal.Instant.fromEpochMilliseconds(row.expires_at.getTime()),
            hostNote: row.note ?? undefined,
            bookingUrl: hostBookingUrl(deps.publicUrl, notice.bookingId),
          },
        ),
      clock,
      signal,
      undefined,
    )
  }
}

/** A minute sweep repairs missed expiry dispatches without freeing the original slot. */
export function rescheduleRequestExpiryJob(deps: {
  db: Db
  now?: (() => Temporal.Instant) | undefined
  notify: BookingNotifier
}) {
  return defineJob({
    name: 'reschedule-request-expiry',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '* * * * *', payload: {} },
    concurrency: 1,
    handler: async (_payload, { signal }) => {
      const { expireRescheduleRequest } = await import('@hourmere/scheduling')
      const at = new Date((deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds)
      const rows = await sql<{
        id: string
      }>`SELECT id FROM booking_reschedule_requests WHERE state='pending' AND expires_at <= ${at} ORDER BY expires_at,id LIMIT 100`.execute(
        deps.db,
      )
      for (const row of rows.rows) {
        signal.throwIfAborted()
        await expireRescheduleRequest(
          { ...deps, now: deps.now ?? (() => Temporal.Now.instant()) },
          row.id,
        )
      }
    },
  })
}
