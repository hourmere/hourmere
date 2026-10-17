import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { GoogleCalendarError } from './google.ts'

const text = z.string().min(1).max(4096).refine(isSingleLineText)
const time = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: text.optional(),
})
const event = z.object({
  id: text,
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
      let pageToken: string | undefined
      for (let page = 0; page < 100; page++) {
        const url = new URL(base(calendar))
        url.search = new URLSearchParams({
          singleEvents: 'true',
          showDeleted: 'true',
          maxResults: '250',
          fields:
            'items(id,status,start,end,transparency,attendees(self,responseStatus)),nextPageToken,nextSyncToken',
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
        for (const item of result.data.items ?? []) {
          if (seenEvents.has(item.id)) throw new GoogleCalendarError('provider_unavailable')
          seenEvents.add(item.id)
          items.push(item)
        }
        if (items.length > 20_000) throw new GoogleCalendarError('provider_unavailable')
        pageToken = result.data.nextPageToken
        if (!pageToken) {
          if (!result.data.nextSyncToken) throw new GoogleCalendarError('provider_unavailable')
          return { items, token: result.data.nextSyncToken }
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
    importEvent(token: string, calendar: string, value: GoogleEventWrite, signal: AbortSignal) {
      // Import a private host copy with the same UID as our ICS. No attendees or invitation email.
      return parsed(
        `${base(calendar)}/import`,
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
      const { iCalUID: _uid, ...patch } = value
      return parsed(
        `${base(calendar)}/${encodeURIComponent(id)}?sendUpdates=none`,
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
