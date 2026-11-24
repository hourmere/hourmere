import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { MicrosoftCalendarError } from './microsoft.ts'

const graphOrigin = 'https://graph.microsoft.com'
// Reuse one named property per mailbox. Graph can filter this property to recover the
// event after a lost POST response, independently of its transactionId retry cache.
const bookingKeyProperty = 'String {3eb52777-459b-4501-8511-4284ebcd11de} Name HourmereBookingKey'
const transactionKey = /^[A-Za-z0-9-]{1,128}$/u
const text = z.string().min(1).max(1024).refine(isSingleLineText)
const event = z.object({
  id: text,
  transactionId: text,
  type: z.literal('singleInstance'),
  isCancelled: z.literal(false),
  '@odata.etag': text.optional(),
})
const eventPage = z.object({
  value: z.array(event).max(2),
  '@odata.nextLink': z.string().min(1).max(16_384).optional(),
})

export interface MicrosoftBookingEventWrite {
  transactionId: string
  title: string
  start: Date
  end: Date
  seatCount?: number
}

export interface MicrosoftBookingEvent {
  id: string
  etag?: string
}

function eventCollection(link: string, calendarId: string) {
  try {
    const url = new URL(link)
    const segment = /^\/v1\.0\/me\/calendars\/([^/]+)\/events$/u.exec(url.pathname)?.[1]
    if (
      url.origin === graphOrigin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      segment !== undefined &&
      decodeURIComponent(segment) === calendarId
    )
      return url
  } catch {
    // Opaque provider links do not belong in errors.
  }
  throw new MicrosoftCalendarError('provider_unavailable')
}

function collection(calendarId: string, transactionId: string) {
  if (
    !transactionKey.test(transactionId) ||
    !text.safeParse(calendarId).success ||
    !calendarId.isWellFormed()
  )
    throw new MicrosoftCalendarError('provider_unavailable')
  return eventCollection(
    `${graphOrigin}/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
    calendarId,
  )
}

function reference(result: z.infer<typeof event>, transactionId: string): MicrosoftBookingEvent {
  if (result.transactionId !== transactionId || !result.id.isWellFormed())
    throw new MicrosoftCalendarError('provider_unavailable')
  const etag = result['@odata.etag']
  return { id: result.id, ...(etag ? { etag } : {}) }
}

function utcTime(date: Date) {
  return { dateTime: date.toISOString().slice(0, -1), timeZone: 'UTC' }
}

export function microsoftEventMethods(
  json: (url: string, init: RequestInit, signal: AbortSignal) => Promise<unknown>,
) {
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  return {
    async findEvent(token: string, calendarId: string, transactionId: string, signal: AbortSignal) {
      let url = collection(calendarId, transactionId)
      const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${bookingKeyProperty}' and ep/value eq '${transactionId}')`
      url.search = `$filter=${encodeURIComponent(filter)}&$select=id,transactionId,type,isCancelled&$top=2`
      const seen = new Set<string>()
      let found: MicrosoftBookingEvent | undefined
      for (let page = 0; page < 20; page++) {
        if (seen.has(url.href)) throw new MicrosoftCalendarError('provider_unavailable')
        seen.add(url.href)
        const parsed = eventPage.safeParse(
          await json(url.href, { headers: headers(token) }, signal),
        )
        if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
        for (const match of parsed.data.value) {
          if (found) throw new MicrosoftCalendarError('provider_unavailable')
          found = reference(match, transactionId)
        }
        const next = parsed.data['@odata.nextLink']
        if (!next) return found
        url = eventCollection(next, calendarId)
      }
      throw new MicrosoftCalendarError('provider_unavailable')
    },
    async createEvent(
      token: string,
      calendarId: string,
      value: MicrosoftBookingEventWrite,
      signal: AbortSignal,
    ) {
      const url = collection(calendarId, value.transactionId)
      if (!(value.start.getTime() < value.end.getTime()))
        throw new MicrosoftCalendarError('provider_unavailable')
      // Use the same REST event IDs as calendarView/delta so the busy cache can
      // identify this copy. Booking instants stay timed even when they span midnight.
      const parsed = event.safeParse(
        await json(
          url.href,
          {
            method: 'POST',
            headers: { ...headers(token), 'content-type': 'application/json' },
            body: JSON.stringify({
              subject: value.title,
              start: utcTime(value.start),
              end: utcTime(value.end),
              isAllDay: false,
              showAs: 'busy',
              sensitivity: 'private',
              isOnlineMeeting: false,
              ...(value.seatCount !== undefined && {
                body: { contentType: 'text', content: String(value.seatCount) },
              }),
              transactionId: value.transactionId,
              singleValueExtendedProperties: [
                { id: bookingKeyProperty, value: value.transactionId },
              ],
            }),
          },
          signal,
        ),
      )
      if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
      return reference(parsed.data, value.transactionId)
    },
  }
}
