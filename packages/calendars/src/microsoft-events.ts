import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { graphInstant, graphUtcTime, MicrosoftCalendarError } from './microsoft.ts'

const graphOrigin = 'https://graph.microsoft.com'
// Reuse one named property per mailbox. Graph can filter this property to recover the
// event after a lost POST response, independently of its transactionId retry cache.
const bookingKeyProperty = 'String {3eb52777-459b-4501-8511-4284ebcd11de} Name HourmereBookingKey'
const transactionKey = /^[A-Za-z0-9-]{1,128}$/u
const text = z.string().min(1).max(1024).refine(isSingleLineText)
const opaqueId = text.refine((id) => id.isWellFormed() && id !== '.' && id !== '..')
const entityTag = text.regex(/^(?:W\/)?"[!#-~\u0080-\u00ff]*"$/u)
const eventReference = z.object({ id: opaqueId, '@odata.etag': entityTag.optional() })
const event = eventReference.extend({
  transactionId: text,
  type: z.literal('singleInstance'),
  isCancelled: z.literal(false),
})
const itemBody = z.object({ content: z.string(), contentType: z.string() })
const eventPage = z.object({
  value: z.array(event).max(2),
  '@odata.nextLink': z.string().min(1).max(16_384).optional(),
})

interface MicrosoftBookingTime {
  start: Date
  end: Date
  seatCount?: number
}

export interface MicrosoftBookingEventWrite extends MicrosoftBookingTime {
  transactionId: string
  title: string
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

function collection(calendarId: string) {
  if (!opaqueId.safeParse(calendarId).success)
    throw new MicrosoftCalendarError('provider_unavailable')
  return eventCollection(
    `${graphOrigin}/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`,
    calendarId,
  )
}

function requireTransactionId(transactionId: string) {
  if (!transactionKey.test(transactionId)) throw new MicrosoftCalendarError('provider_unavailable')
}

function resource(calendarId: string, id: string) {
  if (!opaqueId.safeParse(id).success) throw new MicrosoftCalendarError('provider_unavailable')
  return new URL(`${collection(calendarId).href}/${encodeURIComponent(id)}`)
}

function reference(result: z.infer<typeof eventReference>): MicrosoftBookingEvent {
  const etag = result['@odata.etag']
  return { id: result.id, ...(etag ? { etag } : {}) }
}

function verifyTransaction(result: z.infer<typeof event>, transactionId: string) {
  if (result.transactionId !== transactionId)
    throw new MicrosoftCalendarError('provider_unavailable')
  return reference(result)
}

function utcTime(date: Date) {
  return { dateTime: date.toISOString().slice(0, -1), timeZone: 'UTC' }
}

function bookingTime(value: MicrosoftBookingTime) {
  if (!(value.start.getTime() < value.end.getTime()))
    throw new MicrosoftCalendarError('provider_unavailable')
  return {
    start: utcTime(value.start),
    end: utcTime(value.end),
    ...(value.seatCount !== undefined && {
      body: { contentType: 'text', content: String(value.seatCount) },
    }),
  }
}

function readSeatCount(body: z.infer<typeof itemBody> | undefined): number | undefined {
  if (body?.contentType !== 'text' || !/^[1-9]\d*$/u.test(body.content)) return
  const count = Number(body.content)
  if (Number.isSafeInteger(count)) return count
}

export function microsoftEventMethods(
  json: (url: string, init: RequestInit, signal: AbortSignal) => Promise<unknown>,
) {
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const readEvent = eventReference.extend({
    transactionId: text.nullish(),
    type: text,
    isCancelled: z.boolean(),
    start: graphUtcTime,
    end: graphUtcTime,
    attendees: z.array(z.unknown()),
    body: itemBody.optional(),
  })
  return {
    async findEvent(token: string, calendarId: string, transactionId: string, signal: AbortSignal) {
      requireTransactionId(transactionId)
      let url = collection(calendarId)
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
          found = verifyTransaction(match, transactionId)
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
      requireTransactionId(value.transactionId)
      const url = collection(calendarId)
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
              ...bookingTime(value),
              isAllDay: false,
              showAs: 'busy',
              sensitivity: 'private',
              isOnlineMeeting: false,
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
      return verifyTransaction(parsed.data, value.transactionId)
    },
    async getEvent(
      token: string,
      calendarId: string,
      id: string,
      transactionId: string,
      signal: AbortSignal,
      includeSeatCount = false,
    ) {
      requireTransactionId(transactionId)
      const url = resource(calendarId, id)
      url.searchParams.set(
        '$select',
        `id,transactionId,type,isCancelled,start,end,attendees${includeSeatCount ? ',body' : ''}`,
      )
      const prefer = includeSeatCount
        ? 'outlook.timezone="UTC", outlook.body-content-type="text"'
        : 'outlook.timezone="UTC"'
      let result: unknown
      try {
        result = await json(url.href, { headers: { ...headers(token), prefer } }, signal)
      } catch (error) {
        if (error instanceof MicrosoftCalendarError && error.status === 404) return
        throw error
      }
      const parsed = readEvent.safeParse(result)
      if (!parsed.success) throw new MicrosoftCalendarError('provider_unavailable')
      const event = parsed.data
      if (
        event.id !== id ||
        event.transactionId !== transactionId ||
        event.type !== 'singleInstance' ||
        event.isCancelled
      )
        throw new MicrosoftCalendarError('provider_unavailable', 412)
      return {
        ...reference(event),
        start: new Date(graphInstant(event.start.dateTime).epochMilliseconds),
        end: new Date(graphInstant(event.end.dateTime).epochMilliseconds),
        hasAttendees: event.attendees.length > 0,
        ...(includeSeatCount && { seatCount: readSeatCount(event.body) }),
      }
    },
    async updateEvent(
      token: string,
      calendarId: string,
      id: string,
      etag: string,
      value: MicrosoftBookingTime,
      signal: AbortSignal,
    ) {
      if (!entityTag.safeParse(etag).success)
        throw new MicrosoftCalendarError('provider_unavailable', 412)
      const parsed = eventReference.safeParse(
        await json(
          resource(calendarId, id).href,
          {
            method: 'PATCH',
            headers: {
              ...headers(token),
              'content-type': 'application/json',
              'if-match': etag,
            },
            body: JSON.stringify(bookingTime(value)),
          },
          signal,
        ),
      )
      if (!parsed.success || parsed.data.id !== id)
        throw new MicrosoftCalendarError('provider_unavailable')
      return reference(parsed.data)
    },
    async deleteEvent(
      token: string,
      calendarId: string,
      id: string,
      etag: string,
      signal: AbortSignal,
    ): Promise<'deleted' | 'not_found'> {
      if (!entityTag.safeParse(etag).success)
        throw new MicrosoftCalendarError('provider_unavailable', 412)
      try {
        await json(
          resource(calendarId, id).href,
          { method: 'DELETE', headers: { ...headers(token), 'if-match': etag } },
          signal,
        )
        return 'deleted'
      } catch (error) {
        if (error instanceof MicrosoftCalendarError && error.status === 404) return 'not_found'
        throw error
      }
    },
  }
}
