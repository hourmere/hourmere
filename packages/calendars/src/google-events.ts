import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { GoogleCalendarError } from './google.ts'

const text = z.string().min(1).max(4096).refine(isSingleLineText)
const time = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: text.optional(),
})
export const safeGoogleEventId = (value: string) => /^[A-Za-z0-9_-]{1,1024}$/.test(value)
export function googleMeetUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value)
  )
    return undefined
  return value
}
const conferenceData = z.object({
  createRequest: z
    .object({
      status: z.object({ statusCode: z.enum(['pending', 'success', 'failure']) }).optional(),
    })
    .optional(),
  conferenceSolution: z.object({ key: z.object({ type: z.string().max(100) }) }).optional(),
  entryPoints: z
    .array(z.object({ entryPointType: z.string().max(100), uri: z.string().max(2048) }))
    .max(20)
    .optional(),
})
const event = z.object({
  id: text,
  conferenceData: conferenceData.optional(),
  etag: text.optional(),
  iCalUID: text.optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  start: time.optional(),
  end: time.optional(),
  transparency: z.enum(['opaque', 'transparent']).optional(),
  attendees: z
    .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
    .max(1000)
    .optional(),
  recurringEventId: text.optional(),
  recurrence: z.array(z.string()).optional(),
})
export type GoogleEvent = z.infer<typeof event>
const pageSchema = z.object({
  timeZone: text.optional(),
  items: z.array(event).max(2500).optional(),
  nextPageToken: text.optional(),
  nextSyncToken: text.optional(),
})
export interface GoogleEventWrite {
  iCalUID: string
  summary: string
  start: { dateTime: string }
  end: { dateTime: string }
  sequence: number
  status: 'confirmed' | 'cancelled'
  transparency: 'opaque'
  conferenceData?: {
    createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } }
  }
}
export interface EventWindow {
  start: string
  end: string
  token?: string | undefined
}
export class GoogleSyncReset extends Error {
  constructor() {
    super('Google calendar requires a full synchronization')
  }
}

/** Shared fixed-host, bounded, sanitized transport; no event descriptions or contacts fetched. */
export function googleEventMethods(
  json: (url: string, init: RequestInit, signal: AbortSignal) => Promise<unknown>,
) {
  const base = (calendar: string) =>
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  async function parsed(url: string, init: RequestInit, signal: AbortSignal) {
    const result = event.safeParse(await json(url, init, signal))
    if (!result.success) throw new GoogleCalendarError('provider_unavailable')
    return result.data
  }
  return {
    async events(token: string, calendar: string, window: EventWindow, signal: AbortSignal) {
      const items: GoogleEvent[] = []
      const seenPages = new Set<string>()
      const seenEvents = new Set<string>()
      let timeZone: string | null = null
      let pageToken: string | undefined
      for (let page = 0; page < 100; page++) {
        const url = new URL(base(calendar))
        url.search = new URLSearchParams({
          singleEvents: 'true',
          showDeleted: 'true',
          maxResults: '250',
          fields:
            'timeZone,items(id,status,start,end,transparency,attendees(self,responseStatus)),nextPageToken,nextSyncToken',
          ...(window.token
            ? { syncToken: window.token }
            : { timeMin: window.start, timeMax: window.end }),
          ...(pageToken ? { pageToken } : {}),
        }).toString()
        let value: unknown
        try {
          value = await json(url.href, { headers: headers(token) }, signal)
        } catch (error) {
          if (error instanceof GoogleCalendarError && error.status === 410)
            throw new GoogleSyncReset()
          throw error
        }
        const result = pageSchema.safeParse(value)
        if (!result.success) throw new GoogleCalendarError('provider_unavailable')
        if (result.data.timeZone) {
          try {
            Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(result.data.timeZone)
          } catch {
            throw new GoogleCalendarError('provider_unavailable')
          }
          if (timeZone !== null && timeZone !== result.data.timeZone)
            throw new GoogleCalendarError('provider_unavailable')
          timeZone = result.data.timeZone
        }
        for (const item of result.data.items ?? []) {
          if (seenEvents.has(item.id)) throw new GoogleCalendarError('provider_unavailable')
          seenEvents.add(item.id)
          items.push(item)
        }
        if (items.length > 20_000) throw new GoogleCalendarError('provider_unavailable')
        pageToken = result.data.nextPageToken
        if (!pageToken) {
          if (!result.data.nextSyncToken) throw new GoogleCalendarError('provider_unavailable')
          return { items, token: result.data.nextSyncToken, timeZone }
        }
        if (seenPages.has(pageToken)) throw new GoogleCalendarError('provider_unavailable')
        seenPages.add(pageToken)
      }
      throw new GoogleCalendarError('provider_unavailable')
    },
    async findEvent(token: string, calendar: string, uid: string, signal: AbortSignal) {
      const url = new URL(base(calendar))
      url.search = new URLSearchParams({
        iCalUID: uid,
        maxResults: '2',
        showDeleted: 'false',
        fields: 'items(id,etag,iCalUID,recurringEventId,recurrence),nextPageToken',
      }).toString()
      const result = pageSchema.safeParse(await json(url.href, { headers: headers(token) }, signal))
      if (!result.success || result.data.nextPageToken || (result.data.items?.length ?? 0) > 1)
        throw new GoogleCalendarError('provider_unavailable')
      const found = result.data.items?.[0]
      if (found && (found.iCalUID !== uid || found.recurringEventId || found.recurrence?.length))
        throw new GoogleCalendarError('provider_unavailable')
      return found
    },
    async getConferenceEvent(token: string, calendar: string, id: string, signal: AbortSignal) {
      if (!safeGoogleEventId(id)) throw new GoogleCalendarError('provider_unavailable')
      const url = new URL(`${base(calendar)}/${encodeURIComponent(id)}`)
      url.searchParams.set(
        'fields',
        'id,etag,iCalUID,status,start,end,conferenceData(createRequest/status,conferenceSolution/key,entryPoints(entryPointType,uri))',
      )
      return parsed(url.href, { headers: headers(token) }, signal)
    },
    async findConferenceEvent(token: string, calendar: string, uid: string, signal: AbortSignal) {
      const url = new URL(base(calendar))
      url.search = new URLSearchParams({
        iCalUID: uid,
        maxResults: '2',
        showDeleted: 'true',
        fields:
          'items(id,etag,iCalUID,status,start,end,recurringEventId,recurrence,conferenceData(createRequest/status,conferenceSolution/key,entryPoints(entryPointType,uri))),nextPageToken',
      }).toString()
      const result = pageSchema.safeParse(await json(url.href, { headers: headers(token) }, signal))
      if (!result.success || result.data.nextPageToken || (result.data.items?.length ?? 0) > 1)
        throw new GoogleCalendarError('provider_unavailable')
      const found = result.data.items?.[0]
      if (
        found &&
        (!safeGoogleEventId(found.id) ||
          found.iCalUID !== uid ||
          found.recurringEventId ||
          found.recurrence?.length)
      )
        throw new GoogleCalendarError('provider_unavailable')
      return found
    },
    importEvent(token: string, calendar: string, value: GoogleEventWrite, signal: AbortSignal) {
      // Import a private host copy with the same UID as our ICS. No attendees or invitation email.
      return parsed(
        `${base(calendar)}/import${value.conferenceData ? '?conferenceDataVersion=1' : ''}`,
        {
          method: 'POST',
          headers: { ...headers(token), 'content-type': 'application/json' },
          body: JSON.stringify(value),
        },
        signal,
      )
    },
    updateEvent(
      token: string,
      calendar: string,
      id: string,
      etag: string | undefined,
      value: GoogleEventWrite,
      signal: AbortSignal,
    ) {
      if (!safeGoogleEventId(id)) throw new GoogleCalendarError('provider_unavailable')
      const { iCalUID: _uid, ...patch } = value
      return parsed(
        `${base(calendar)}/${encodeURIComponent(id)}?sendUpdates=none&conferenceDataVersion=1`,
        {
          method: 'PATCH',
          headers: {
            ...headers(token),
            'content-type': 'application/json',
            ...(etag ? { 'if-match': etag } : {}),
          },
          body: JSON.stringify(patch),
        },
        signal,
      )
    },
  }
}
