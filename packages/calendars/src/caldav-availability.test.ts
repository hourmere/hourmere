import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { findSlots } from '../../scheduling/src/availability.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { connectCalDav } from './caldav-connection.ts'
import { configureCalDavCalendar, syncCalDavCalendar } from './caldav-sync.ts'
import { createCalDavSyncClient } from './caldav-sync-client.ts'
import { calendarTestSession, TEST_CALENDAR_KEY } from './testing.ts'

let database: TestDatabase
let db: Db
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return
  database = await createTestDatabase(process.env.DATABASE_URL)
  db = createDb(database.pool)
})
afterAll(async () => {
  await database?.drop()
})

it.skipIf(!process.env.DATABASE_URL)(
  'removes slots after a real CalDAV REPORT and fails closed on refresh errors',
  async () => {
    const owner = await calendarTestSession(db)
    const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2028-01-01') })
      .where('id', '=', owner.sessionId)
      .execute()
    const fixtures = createFixtures(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'caldav-host', time_zone: 'UTC' })
      .execute()
    await fixtures.schedule(owner.user.id, { timeZone: 'UTC' })
    const eventTypeId = await fixtures.eventType(owner.organization.id, owner.user.id)
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
                displayName: 'Private calendar',
                color: null,
                supportsEvents: true,
                canWrite: false,
              },
            ],
          }),
        },
      },
      owner,
      {
        serverUrl: 'https://dav.example.com/',
        username: 'synthetic-user',
        password: 'synthetic-password',
      },
      [calendarUrl],
    )
    const calendar = await db
      .selectFrom('calendars')
      .select('id')
      .where('connection_id', '=', connection.id)
      .executeTakeFirstOrThrow()
    let fail = false
    let busy = false
    const multistatus = (body: string) =>
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`
    const client = createCalDavSyncClient(async (request) => {
      if (fail) return { status: 503, body: '' }
      if (request.method === 'PROPFIND')
        return {
          status: 207,
          body: multistatus(
            `<d:response><d:href>${calendarUrl}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          ),
        }
      expect(request.method).toBe('REPORT')
      expect(request.body).toContain('c:expand')
      return {
        status: 207,
        body: multistatus(
          busy
            ? `<d:response><d:href>${calendarUrl}event.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-uid\r\nDTSTART:20261102T100000Z\r\nDTEND:20261102T110000Z\r\nSUMMARY:private title\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
            : '',
        ),
      }
    })
    const deps = { db, client, encryptionKey: TEST_CALENDAR_KEY, now: () => now.epochMilliseconds }
    await configureCalDavCalendar(deps, owner, calendar.id, true)
    await syncCalDavCalendar(deps, calendar.id)
    const query = {
      eventTypeId,
      hostUserId: owner.user.id,
      rangeStart: Temporal.Instant.from('2026-11-02T00:00Z'),
      rangeEnd: Temporal.Instant.from('2026-11-03T00:00Z'),
      now,
    }
    const starts = async () => (await findSlots(db, query)).map((slot) => slot.start.toString())
    expect(await starts()).toContain('2026-11-02T10:00:00Z')
    busy = true
    await syncCalDavCalendar(deps, calendar.id)
    expect(await starts()).not.toContain('2026-11-02T10:00:00Z')
    expect(await starts()).toContain('2026-11-02T11:00:00Z')
    const stored = await db
      .selectFrom('calendar_busy')
      .selectAll()
      .where('calendar_id', '=', calendar.id)
      .execute()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain('private')
    fail = true
    await expect(syncCalDavCalendar(deps, calendar.id)).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(
      await db
        .selectFrom('calendar_busy')
        .selectAll()
        .where('calendar_id', '=', calendar.id)
        .execute(),
    ).toEqual(stored)
    await expect(starts()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  },
)
