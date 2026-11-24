// Provider-shaped synthetic data, real ingestion and PostgreSQL; no provider network calls.
import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { TroubleshootAvailabilityResult } from '@hourmere/scheduling'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectCalDav } from '../../../packages/calendars/src/caldav-connection.ts'
import {
  configureCalDavCalendar,
  syncCalDavCalendar,
} from '../../../packages/calendars/src/caldav-sync.ts'
import { createCalDavSyncClient } from '../../../packages/calendars/src/caldav-sync-client.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import {
  beginGoogleConnection,
  beginMicrosoftConnection,
  finishGoogleConnection,
  finishMicrosoftConnection,
} from '../../../packages/calendars/src/index.ts'
import { MICROSOFT_DELTA_PAGE_BUDGET } from '../../../packages/calendars/src/microsoft-sync.ts'
import {
  configureCalendar,
  syncGoogleCalendar,
  syncOwnedCalendar,
} from '../../../packages/calendars/src/sync.ts'
import {
  calendarTestSession,
  fakeGoogle,
  fakeMicrosoft,
  TEST_CALENDAR_KEY,
} from '../../../packages/calendars/src/testing.ts'
import { findSlots } from '../../../packages/scheduling/src/availability.ts'
import { createApp } from './app.ts'
import { availabilityTroubleshootingTools } from './mcp/availability-troubleshooting.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { availabilityTroubleshootingRoutes } from './routes/availability-troubleshooting.ts'
import { publicRoutes } from './routes/public.ts'

const instant = Temporal.Instant.from
const now = instant('2030-03-01T12:00:00Z')
const zone = 'America/New_York'
const timed = (id: string, start: string, end: string, extra = {}) => ({
  id,
  summary: 'Private strategy meeting',
  description: 'Private medical note',
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
})
const vevent = (body: string) =>
  `BEGIN:VEVENT\r\n${body}\r\nSUMMARY:Private strategy meeting\r\nEND:VEVENT`
const ical = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`

describe.skipIf(!process.env.DATABASE_URL)(
  'calendar-backed troubleshooting acceptance (real PostgreSQL)',
  () => {
    let database: TestDatabase
    let db: Db
    let owner: Awaited<ReturnType<typeof calendarTestSession>>
    let eventTypeId: string
    let app: ReturnType<typeof createApp>
    let caller: Principal
    let google: ReturnType<typeof fakeGoogle>
    let googleCalendarId: string
    let caldavCalendarId: string
    let microsoft: ReturnType<typeof fakeMicrosoft>
    let microsoftCalendarId: string
    let failCalDav = false
    let refreshCalDav: () => Promise<void>
    let failMicrosoft = false
    let refreshMicrosoft: () => Promise<void>

    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'calendar_accept',
      })
      db = createDb(database.pool)
      owner = await calendarTestSession(db)
      await db
        .updateTable('auth.session')
        .set({ expiresAt: new Date('2031-01-01') })
        .where('id', '=', owner.sessionId)
        .execute()
      const fixtures = createFixtures(db)
      await db
        .insertInto('profiles')
        .values({ user_id: owner.user.id, handle: 'calendar-acceptance', time_zone: zone })
        .execute()
      const hours = [{ start: '00:00', end: '24:00' }]
      await fixtures.schedule(owner.user.id, {
        timeZone: zone,
        weeklyHours: {
          monday: hours,
          tuesday: hours,
          wednesday: hours,
          thursday: hours,
          friday: hours,
          saturday: hours,
          sunday: hours,
        },
      })
      eventTypeId = await fixtures.eventType(owner.organization.id, owner.user.id, {
        slug: 'calendar-check',
        durationMinutes: 30,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
      })
      google = fakeGoogle(() => now.epochMilliseconds)
      google.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
      google.controls.pages = [
        {
          items: [
            { id: 'work', summary: 'Private work calendar', accessRole: 'owner', timeZone: zone },
            {
              id: 'family',
              summary: 'Private family calendar',
              accessRole: 'owner',
              timeZone: zone,
            },
          ],
        },
      ]
      microsoft = fakeMicrosoft(() => now.epochMilliseconds)
      const deps = {
        db,
        now: () => now.epochMilliseconds,
        google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
        microsoft: { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
      }
      for (const [begin, finish] of [
        [
          () => beginGoogleConnection(deps, owner, 'sync'),
          (query: URLSearchParams) => finishGoogleConnection(deps, owner, query),
        ],
        [
          () => beginMicrosoftConnection(deps, owner),
          (query: URLSearchParams) => finishMicrosoftConnection(deps, owner, query),
        ],
      ] as const) {
        const start = new URL((await begin()).authorizationUrl)
        expect(
          await finish(
            new URLSearchParams({
              state: start.searchParams.get('state') as string,
              code: 'synthetic-code',
            }),
          ),
        ).toBe('connected')
      }
      // Google supplies expanded instances (singleEvents=true), including a moved exception
      // and a cancellation tombstone. The original 09:00 exception time must remain free.
      google.controls.eventHook = async (url) => {
        expect(url.searchParams.get('singleEvents')).toBe('true')
        const events = url.pathname.includes('/work/')
          ? [
              timed('series-normal', '2030-03-09T09:00:00-05:00', '2030-03-09T10:00:00-05:00', {
                recurringEventId: 'series',
                originalStartTime: { dateTime: '2030-03-09T09:00:00-05:00' },
              }),
              timed('series-moved', '2030-03-10T11:00:00-04:00', '2030-03-10T12:00:00-04:00', {
                recurringEventId: 'series',
                originalStartTime: { dateTime: '2030-03-10T09:00:00-04:00' },
              }),
              {
                id: 'series-cancelled',
                status: 'cancelled',
                recurringEventId: 'series',
                originalStartTime: { dateTime: '2030-03-10T13:00:00-04:00' },
              },
              timed('tentative', '2030-03-10T14:00:00-04:00', '2030-03-10T14:30:00-04:00', {
                status: 'tentative',
              }),
              timed('transparent', '2030-03-10T15:00:00-04:00', '2030-03-10T15:30:00-04:00', {
                transparency: 'transparent',
              }),
              timed('declined', '2030-03-10T16:00:00-04:00', '2030-03-10T16:30:00-04:00', {
                attendees: [
                  {
                    self: true,
                    responseStatus: 'declined',
                    email: 'private-attendee@example.test',
                  },
                ],
              }),
              timed('cross-midnight', '2030-03-09T23:30:00-05:00', '2030-03-10T00:30:00-05:00'),
            ]
          : [
              {
                id: 'all-day',
                summary: 'Private medical note',
                start: { date: '2030-03-11' },
                end: { date: '2030-03-12' },
              },
            ]
        return Response.json({ items: events, nextSyncToken: 'synthetic-cursor', timeZone: zone })
      }
      const googleCalendars = await db
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select(['c.id', 'c.external_id'])
        .where('cc.provider', '=', 'google')
        .execute()
      const workCalendar = googleCalendars.find((c) => c.external_id === 'work')
      if (!workCalendar) throw new Error('Missing fake Google calendar')
      googleCalendarId = workCalendar.id
      for (const calendar of googleCalendars) {
        await configureCalendar(deps, owner, calendar.id, true)
        await syncGoogleCalendar(deps, calendar.id)
      }
      const calendarUrl = 'https://dav.example.com/calendars/personal/'
      const connection = await connectCalDav(
        {
          db,
          encryptionKey: TEST_CALENDAR_KEY,
          now: () => now.epochMilliseconds,
          client: {
            discover: async () => ({
              principalUrl: 'https://dav.example.com/principal/',
              calendarHomeUrl: 'https://dav.example.com/calendars/',
              calendars: [
                {
                  url: calendarUrl,
                  displayName: 'Private CalDAV calendar',
                  color: null,
                  supportsEvents: true,
                  canWrite: false,
                },
              ],
            }),
          },
        },
        owner,
        { serverUrl: 'https://dav.example.com/', username: 'synthetic', password: 'synthetic' },
        [calendarUrl],
      )
      caldavCalendarId = (
        await db
          .selectFrom('calendars')
          .select('id')
          .where('connection_id', '=', connection.id)
          .executeTakeFirstOrThrow()
      ).id
      const data = ical(
        vevent('UID:dst\r\nDTSTART:20300310T063000Z\r\nDTEND:20300310T073000Z'),
        vevent(
          'UID:series\r\nRECURRENCE-ID:20300310T140000Z\r\nDTSTART:20300310T160000Z\r\nDTEND:20300310T163000Z',
        ),
        vevent('UID:series\r\nRECURRENCE-ID:20300310T170000Z\r\nSTATUS:CANCELLED'),
        vevent(
          'UID:transparent\r\nDTSTART:20300310T190000Z\r\nDTEND:20300310T193000Z\r\nTRANSP:TRANSPARENT',
        ),
        vevent(
          'UID:tentative\r\nDTSTART:20300310T230000Z\r\nDTEND:20300310T233000Z\r\nSTATUS:TENTATIVE',
        ),
        // Without a verified owner address, a declined attendee is conservatively busy.
        vevent(
          'UID:unverified-decline\r\nDTSTART:20300310T210000Z\r\nDTEND:20300310T213000Z\r\nATTENDEE;PARTSTAT=DECLINED:mailto:private-attendee@example.test',
        ),
      )
      const wrap = (body: string) =>
        `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`
      const client = createCalDavSyncClient(async (request) => {
        if (failCalDav) return { status: 503, body: '' }
        if (request.method === 'PROPFIND')
          return {
            status: 207,
            body: wrap(
              `<d:response><d:href>${calendarUrl}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
          }
        expect(request.method).toBe('REPORT')
        expect(request.body).toContain('c:expand')
        return {
          status: 207,
          body: wrap(
            `<d:response><d:href>${calendarUrl}private.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[${data}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          ),
        }
      })
      const davDeps = {
        db,
        client,
        encryptionKey: TEST_CALENDAR_KEY,
        now: () => now.epochMilliseconds,
      }
      await configureCalDavCalendar(davDeps, owner, caldavCalendarId, true)
      refreshCalDav = () => syncCalDavCalendar(davDeps, caldavCalendarId)
      await refreshCalDav()
      microsoftCalendarId = (
        await db
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select('c.id')
          .where('cc.provider', '=', 'microsoft')
          .executeTakeFirstOrThrow()
      ).id
      microsoft.controls.viewHook = (url) =>
        failMicrosoft
          ? Response.json({ error: { code: 'ServiceUnavailable' } }, { status: 503 })
          : Response.json({
              '@odata.deltaLink': `${url.origin}${url.pathname}?$deltatoken=synthetic-cursor`,
              value: [
                {
                  id: 'synthetic-ms-busy',
                  type: 'singleInstance',
                  subject: 'Private Outlook appointment',
                  start: { dateTime: '2030-03-10T22:00:00.0000000', timeZone: 'UTC' },
                  end: { dateTime: '2030-03-10T22:30:00.0000000', timeZone: 'UTC' },
                  showAs: 'busy',
                  isCancelled: false,
                  isAllDay: false,
                },
              ],
            })
      await configureCalendar(deps, owner, microsoftCalendarId, true)
      refreshMicrosoft = () => syncOwnedCalendar(deps, owner, microsoftCalendarId)
      await refreshMicrosoft()
      caller = { ...owner, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope: 'full' }
      vi.spyOn(Temporal.Now, 'instant').mockReturnValue(now)
      app = createApp({
        publicUrl: 'https://example.test',
        checkDb: async () => {},
        authHandler: async () => new Response(),
        resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
        routes: [
          availabilityTroubleshootingRoutes({ db, now: () => now }),
          publicRoutes({ db, now: () => now }),
        ],
        mcp: mcpEndpoint({ tools: availabilityTroubleshootingTools({ db }) }),
      })
    }, 30_000)
    afterAll(async () => {
      vi.restoreAllMocks()
      await database?.drop()
    })

    async function explain(date: string, transport: 'REST' | 'MCP') {
      if (transport === 'REST') {
        const response = await app.request(
          `/api/v1/event-types/${eventTypeId}/availability-troubleshooting?date=${date}&timeZone=${zone}`,
        )
        return { ok: response.ok, body: await response.json() }
      }
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-test-key',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'troubleshoot_availability',
            arguments: { eventTypeId, date, timeZone: zone },
          },
        }),
      })
      const wire = await response.text()
      const message = JSON.parse(
        wire.startsWith('event:')
          ? (wire.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6)
          : wire,
      )
      return {
        ok: !message.result.isError,
        body: message.result.isError
          ? JSON.parse(message.result.content[0].text)
          : message.result.structuredContent,
      }
    }
    async function verify(date: string) {
      const rest = await explain(date, 'REST')
      expect(rest.ok).toBe(true)
      expect(await explain(date, 'MCP')).toEqual(rest)
      const result = rest.body as TroubleshootAvailabilityResult
      const ordinary = await findSlots(db, {
        eventTypeId,
        hostUserId: owner.user.id,
        rangeStart: instant(result.rangeStart),
        rangeEnd: instant(result.rangeEnd),
        now,
      })
      expect(
        result.slots.filter((slot) => slot.status === 'available').map((slot) => slot.start),
      ).toEqual(ordinary.map((slot) => slot.start.toString()))
      const response = await app.request(
        `/api/v1/public/calendar-acceptance/calendar-check/slots?${new URLSearchParams({ start: result.rangeStart, end: result.rangeEnd })}`,
      )
      expect(response.status).toBe(200)
      const offered = (await response.json()) as { data: { start: string }[] }
      expect(offered.data.map((slot) => instant(slot.start).toString())).toEqual(
        ordinary.map((slot) => slot.start.toString()),
      )
      for (const slot of result.slots)
        expect(slot.reasons.length === 0).toBe(slot.status === 'available')
      const wire = JSON.stringify(rest)
      for (const privateValue of [
        'Private strategy meeting',
        'Private medical note',
        'private-attendee@example.test',
        'Private work calendar',
        'Private CalDAV calendar',
        'Private Outlook appointment',
        googleCalendarId,
        caldavCalendarId,
        microsoftCalendarId,
        'synthetic-ms-busy',
      ])
        expect(wire).not.toContain(privateValue)
      return result
    }
    const first = (result: TroubleshootAvailabilityResult, start: string) => {
      const slot = result.slots.find((item) => item.start === instant(start).toString())
      expect(slot, start).toBeDefined()
      return slot?.reasons[0]?.code ?? 'available'
    }

    it('matches all starts across recurrence exceptions, midnight, DST and provider event states', async () => {
      const result = await verify('2030-03-10')
      expect(result.rangeStart).toBe('2030-03-10T05:00:00Z')
      expect(result.rangeEnd).toBe('2030-03-11T04:00:00Z')
      for (const [start, reason] of [
        ['2030-03-10T00:00:00-05:00', 'calendar_busy'],
        ['2030-03-10T01:30:00-05:00', 'calendar_busy'],
        ['2030-03-10T03:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T09:00:00-04:00', 'available'],
        ['2030-03-10T10:30:00-04:00', 'buffer_after'],
        ['2030-03-10T11:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T12:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T13:00:00-04:00', 'available'],
        ['2030-03-10T14:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T14:30:00-04:00', 'buffer_before'],
        ['2030-03-10T15:00:00-04:00', 'available'],
        ['2030-03-10T16:00:00-04:00', 'available'],
        ['2030-03-10T17:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T18:00:00-04:00', 'calendar_busy'],
        ['2030-03-10T19:00:00-04:00', 'calendar_busy'],
      ])
        expect(first(result, start as string), start).toBe(reason)
      // At 12:00 CalDAV is busy while Google contributes the previous meeting’s buffer.
      const overlap = result.slots.find((slot) => slot.start === '2030-03-10T16:00:00Z')
      expect(overlap?.reasons.map((reason) => reason.code)).toEqual([
        'calendar_busy',
        'buffer_before',
      ])
      const prior = await verify('2030-03-09')
      expect(first(prior, '2030-03-09T09:00:00-05:00')).toBe('calendar_busy')
    })

    it('keeps all-day exclusive boundaries in host time and honors calendar selection', async () => {
      const allDay = await verify('2030-03-11')
      expect(allDay.slots.every((slot) => slot.reasons[0]?.code === 'calendar_busy')).toBe(true)
      expect(first(await verify('2030-03-12'), '2030-03-12T00:30:00-04:00')).toBe('available')
      await db
        .updateTable('calendars')
        .set({ check_conflicts: false })
        .where('id', '=', microsoftCalendarId)
        .execute()
      try {
        expect(first(await verify('2030-03-10'), '2030-03-10T18:00:00-04:00')).toBe('available')
      } finally {
        await db
          .updateTable('calendars')
          .set({ check_conflicts: true })
          .where('id', '=', microsoftCalendarId)
          .execute()
      }
    })

    it('offers free slots and protects published busy times while the first delta round is pending', async () => {
      const originalView = microsoft.controls.viewHook
      const day = now.toZonedDateTimeISO('UTC').startOfDay().toInstant()
      // A v2 snapshot produced by the former full-read worker has coverage and no delta link.
      await db
        .updateTable('calendars')
        .set({
          sync_state: JSON.stringify({
            version: 2,
            start: day.subtract({ hours: 72 }).toString(),
            end: day.add({ hours: 403 * 24 }).toString(),
            timeZone: null,
          }),
        })
        .where('id', '=', microsoftCalendarId)
        .execute()
      let pages = 0
      microsoft.controls.viewHook = (url) =>
        Response.json({
          '@odata.nextLink': `${url.origin}${url.pathname}?$skiptoken=${++pages}`,
          value: [],
        })
      try {
        await expect(refreshMicrosoft()).rejects.toMatchObject({
          code: 'microsoft_calendar_provider_unavailable',
        })
        expect(pages).toBe(MICROSOFT_DELTA_PAGE_BUDGET)
        const result = await verify('2030-03-10')
        expect(first(result, '2030-03-10T18:00:00-04:00')).toBe('calendar_busy')
        expect(first(result, '2030-03-10T09:00:00-04:00')).toBe('available')
      } finally {
        microsoft.controls.viewHook = originalView
        await refreshMicrosoft()
      }
    })

    it('refuses another owner without exposing provider data on either transport', async () => {
      const original = caller
      const outsider = await createTestUser(db, 'Outside owner')
      caller = outsider.principal
      try {
        for (const transport of ['REST', 'MCP'] as const) {
          const result = await explain('2030-03-10', transport)
          expect(result.ok).toBe(false)
          expect(JSON.stringify(result.body)).toContain('event_type_not_found')
          expect(JSON.stringify(result.body)).not.toContain('calendar_busy')
        }
      } finally {
        caller = original
      }
    })

    it('fails closed on unreadable providers and stale Google, without claiming missing setup', async () => {
      const query = {
        eventTypeId,
        hostUserId: owner.user.id,
        rangeStart: instant('2030-03-10T05:00Z'),
        rangeEnd: instant('2030-03-11T04:00Z'),
        now,
      }
      async function unavailable() {
        await expect(findSlots(db, query)).rejects.toMatchObject({
          code: 'calendar_sync_unavailable',
        })
        const publicQuery = new URLSearchParams({
          start: query.rangeStart.toString(),
          end: query.rangeEnd.toString(),
        })
        const publicSlots = await app.request(
          `/api/v1/public/calendar-acceptance/calendar-check/slots?${publicQuery}`,
        )
        expect(publicSlots.status).toBe(409)
        expect(await publicSlots.json()).toMatchObject({ error: 'calendar_sync_unavailable' })
        for (const transport of ['REST', 'MCP'] as const) {
          const result = await explain('2030-03-10', transport)
          expect(result.ok).toBe(false)
          expect(JSON.stringify(result.body)).toContain('calendar_sync_unavailable')
        }
      }
      failMicrosoft = true
      try {
        await expect(refreshMicrosoft()).rejects.toMatchObject({
          code: 'microsoft_calendar_provider_unavailable',
        })
        await unavailable()
      } finally {
        failMicrosoft = false
        await refreshMicrosoft()
      }
      failCalDav = true
      try {
        await expect(refreshCalDav()).rejects.toMatchObject({ code: 'unavailable' })
        await unavailable()
      } finally {
        failCalDav = false
        await refreshCalDav()
      }
      await db
        .updateTable('calendars')
        .set({ last_synced_at: new Date(now.subtract({ minutes: 11 }).epochMilliseconds) })
        .where('id', '=', googleCalendarId)
        .execute()
      try {
        await unavailable()
      } finally {
        await db
          .updateTable('calendars')
          .set({ last_synced_at: new Date(now.epochMilliseconds) })
          .where('id', '=', googleCalendarId)
          .execute()
      }
    })
  },
)
