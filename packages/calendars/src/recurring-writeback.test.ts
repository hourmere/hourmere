import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  type BookingNotifier,
  cancelManagedBooking,
  cancelManagedBookingSeries,
  createPublicBooking,
  createPublicBookingSeries,
  expandRecurringRule,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { calendarBookingNotifier } from './booking-events.ts'
import { createCalDavCredentialRecord } from './caldav-credentials.ts'
import { createCalDavWriteClient } from './caldav-write-client.ts'
import { calDavBookingNotifier } from './caldav-writeback.ts'
import { calDavBookingJob } from './caldav-writeback-jobs.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES, GoogleCalendarError } from './google.ts'
import type { CalendarDeps } from './index.ts'
import { bookingCalendarJob } from './jobs.ts'
import { MICROSOFT_CALENDAR_SCOPES } from './microsoft.ts'
import { fakeGoogle, fakeMicrosoft, TEST_CALENDAR_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
// pg-boss compares job retention against PostgreSQL's real clock.
const now = () => Temporal.Instant.from('2030-11-02T00:00:00Z')
const providerNow = () => now().epochMilliseconds
const firstLocalStart = '2030-11-04T09:00+00:00'
const timeZone = 'UTC'
const durationMinutes = 30
const slug = 'weekly-consultation'
const title = 'Weekly consultation'
const invitee = { name: 'Synthetic invitee', email: 'invitee@example.test', timeZone }
const calendarJobPolicy = {
  policy: 'stately',
  retry_limit: 12,
  retry_delay: 60,
  retry_backoff: true,
  retry_delay_max: 3600,
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing recurring calendar fixture value')
  return value
}

type Occurrence = { bookingId: string; start: string; end: string }
type Provider = 'google' | 'microsoft' | 'caldav'
type CalendarJobName = 'booking-calendar' | 'caldav-booking'
type CalendarJobIdentity = {
  name: CalendarJobName
  data: { bookingId: string }
  singleton_key: string
}

function googleEvent({ bookingId, start, end }: Occurrence, cancelled = false) {
  return {
    iCalUID: `${bookingId}@hourmere`,
    summary: `${title} with ${invitee.name}`,
    start: { dateTime: new Date(start).toISOString() },
    end: { dateTime: new Date(end).toISOString() },
    sequence: cancelled ? 1 : 0,
    status: cancelled ? 'cancelled' : 'confirmed',
    transparency: 'opaque',
  }
}

function googleCancellation(occurrence: Occurrence) {
  const { iCalUID: _uid, ...patch } = googleEvent(occurrence, true)
  return patch
}

describe.skipIf(!databaseUrl)(
  'recurring booking calendar jobs on PostgreSQL',
  { timeout: 15_000 },
  () => {
    let database: TestDatabase
    let db: Db
    let jobs: ReturnType<
      typeof createJobs<
        readonly [ReturnType<typeof bookingCalendarJob>, ReturnType<typeof calDavBookingJob>]
      >
    >
    let google: ReturnType<typeof fakeGoogle>
    let microsoft: ReturnType<typeof fakeMicrosoft>
    let deps: CalendarDeps
    let notify: BookingNotifier
    let notifyCalDav: BookingNotifier
    const context = (notifier = notify) => ({ db, now, notify: notifier })
    const calDavOrigin = 'https://dav.example.com'
    const calDavResources = new Map<string, { etag: string; body: string }>()

    beforeAll(async () => {
      database = await createTestDatabase(databaseUrl as string, undefined, {
        tag: 'series_calendar',
      })
      db = createDb(database.pool)
      deps = { db, now: providerNow }
      const client = createCalDavWriteClient(async (request) => {
        const saved = calDavResources.get(request.url)
        if (request.method === 'GET')
          return saved ? { status: 200, ...saved } : { status: 404, body: '' }
        if (request.method === 'PUT' && request.ifNoneMatch === '*' && !saved) {
          const etag = '"v1"'
          calDavResources.set(request.url, { body: request.body, etag })
          return { status: 201, body: '', etag }
        }
        if (request.method === 'DELETE' && saved && request.ifMatch === saved.etag) {
          calDavResources.delete(request.url)
          return { status: 204, body: '' }
        }
        return { status: 412, body: '' }
      })
      jobs = createJobs({
        connectionString: database.url,
        definitions: [
          bookingCalendarJob(deps),
          calDavBookingJob({ db, client, encryptionKey: TEST_CALENDAR_KEY, now: providerNow }),
        ],
        work: true,
        migrate: true,
        maxConnections: 2,
        pollingIntervalSeconds: 0.5,
        log: () => {},
      })
      const googleNotify = calendarBookingNotifier(jobs)
      notify = async (trx, event) => {
        if (!('requestId' in event)) await googleNotify(trx, event)
      }
      const calDavNotify = calDavBookingNotifier(jobs)
      notifyCalDav = async (trx, event) => {
        if (!('requestId' in event)) await calDavNotify(trx, event)
      }
      await jobs.start()
    })

    beforeEach(() => {
      calDavResources.clear()
      google = fakeGoogle(providerNow)
      microsoft = fakeMicrosoft(providerNow)
      deps.google = { client: google.client, encryptionKey: TEST_CALENDAR_KEY }
      deps.microsoft = { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY }
    })

    afterAll(async () => {
      try {
        await jobs?.stop()
      } finally {
        await database?.drop()
      }
    })

    async function fixture(provider: Provider = 'google') {
      const fixtures = createFixtures(db)
      const host = await fixtures.host({ timeZone })
      await fixtures.schedule(host.userId, { timeZone })
      const eventId = await fixtures.eventType(host.organizationId, host.userId, { slug, title })
      const account = `${provider}-calendar-account`
      const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
      const connection =
        provider === 'caldav'
          ? createCalDavCredentialRecord(key, host.userId, {
              serverUrl: calDavOrigin,
              username: host.userId,
              password: 'synthetic-dav-password',
            })
          : {
              user_id: host.userId,
              provider,
              external_account_id: account,
              scopes: [
                ...(provider === 'google'
                  ? GOOGLE_CALENDAR_SYNC_SCOPES
                  : MICROSOFT_CALENDAR_SCOPES),
              ],
              credentials: encryptCredential(
                key,
                `${provider}:${host.userId}:${account}`,
                JSON.stringify({
                  accessToken: 'synthetic-access',
                  refreshToken: 'synthetic-refresh',
                  expiresAt: providerNow() + 3_600_000,
                }),
              ),
            }
      const { id: connectionId } = await db
        .insertInto('calendar_connections')
        .values(connection)
        .returning('id')
        .executeTakeFirstOrThrow()
      const { id: calendarId } = await db
        .insertInto('calendars')
        .values({
          connection_id: connectionId,
          external_id: provider === 'caldav' ? `${calDavOrigin}/calendars/synthetic/` : account,
          name: 'Synthetic calendar',
          access_role: provider === 'caldav' ? 'writer' : 'owner',
          time_zone: timeZone,
          check_conflicts: false,
          ...(provider === 'caldav' && {
            sync_state: { caldavDiscovery: { version: 1, available: true, color: null } },
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: calendarId })
        .where('user_id', '=', host.userId)
        .execute()
      return { ...host, eventId, calendarId }
    }

    async function seriesFixture(provider?: Provider) {
      const host = await fixture(provider)
      await db
        .updateTable('event_types')
        .set({
          recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 3 }),
        })
        .where('id', '=', host.eventId)
        .execute()
      const rule = { pattern: 'weekly', count: 3 } as const
      const planned = expandRecurringRule({
        firstLocalStart,
        timeZone,
        durationMinutes,
        rule,
        now: now(),
      })
      const actorDigest = randomBytes(32)
      const idempotencyKey = randomUUID()
      const create = (notifyMemberCalendar = notify) =>
        createPublicBookingSeries(
          context(),
          {
            handle: host.handle,
            slug,
            firstLocalStart,
            rule,
            invitee,
            idempotencyKey,
            expectedPreview: {
              eventRevision: '0',
              timeZone,
              rule,
              durationMinutes,
              occurrences: planned.map(({ ordinal, localStart, start, end, offset }) => ({
                ordinal,
                localStart,
                start: start?.toString() ?? null,
                end: end?.toString() ?? null,
                offset,
              })),
            },
          },
          { recurringBookingsEnabled: true, actorDigest, notifyMemberCalendar },
        )
      return { ...host, planned, create }
    }

    const ids = (occurrences: readonly Occurrence[]) =>
      occurrences.map(({ bookingId }) => bookingId)
    const imports = () => google.calls.filter(({ url }) => url.pathname.endsWith('/import'))
    const patches = () => google.calls.filter(({ init }) => init.method === 'PATCH')
    const values = (calls: ReturnType<typeof imports>) =>
      calls.map(({ init }) => JSON.parse(String(init.body)))
    const entries = () =>
      [...google.controls.storedEvents.values()].sort((a, b) =>
        String(a.iCalUID).localeCompare(String(b.iCalUID)),
      )

    const jobsFor = async (bookingIds: string[], name: CalendarJobName = 'booking-calendar') =>
      (
        await database.pool.query<CalendarJobIdentity>(
          `SELECT id, name, data, singleton_key, state, policy, retry_count, retry_limit, retry_delay,
                retry_backoff, retry_delay_max, start_after > now() AS delayed
         FROM pgboss.job WHERE name = $2
           AND (singleton_key = ANY($1::text[]) OR data->>'bookingId' = ANY($1::text[]))
         ORDER BY singleton_key, created_on, id`,
          [bookingIds, name],
        )
      ).rows

    const completed = (bookingId: string) => ({
      name: 'booking-calendar' as const,
      data: { bookingId },
      singleton_key: bookingId,
      state: 'completed',
      ...calendarJobPolicy,
    })

    async function expectJobs(
      bookingIds: string[],
      expected: (CalendarJobIdentity & { state: string })[],
      name: CalendarJobName = 'booking-calendar',
    ) {
      const identity = ({ name, data, singleton_key }: CalendarJobIdentity) => ({
        name,
        data,
        singleton_key,
      })
      expect((await jobsFor(bookingIds, name)).map(identity)).toEqual(expected.map(identity))
      await expect.poll(() => jobsFor(bookingIds, name), { timeout: 6000 }).toMatchObject(expected)
    }

    const targets = (calendarId: string) =>
      db
        .selectFrom('booking_calendar_targets')
        .select('root_booking_id')
        .where('calendar_id', '=', calendarId)
        .orderBy('root_booking_id')
        .execute()

    const mappings = (calendarId: string) =>
      db
        .selectFrom('booking_calendar_events')
        .select(['booking_id', 'external_event_id'])
        .where('calendar_id', '=', calendarId)
        .orderBy('booking_id')
        .execute()

    async function expectGoogleSeries(occurrences: readonly Occurrence[]) {
      const bookingIds = ids(occurrences).toSorted()
      await expectJobs(bookingIds, bookingIds.map(completed))
      expect(values(imports())).toEqual(
        expect.arrayContaining(occurrences.map((occurrence) => googleEvent(occurrence))),
      )
      expect(imports()).toHaveLength(occurrences.length)
      expect(entries()).toHaveLength(occurrences.length)
    }

    it('writes one independent Google event per occurrence and deduplicates creation replay', async () => {
      const fixture = await seriesFixture()
      const series = await fixture.create()
      await expectGoogleSeries(series.occurrences)
      const bookingIds = ids(series.occurrences).toSorted()
      const prior = await jobsFor(bookingIds)
      expect(await targets(fixture.calendarId)).toEqual(
        bookingIds.map((root_booking_id) => ({ root_booking_id })),
      )
      expect((await mappings(fixture.calendarId)).map(({ booking_id }) => booking_id)).toEqual(
        bookingIds,
      )

      const { seriesId: replayId, replayed } = await fixture.create()
      expect({ seriesId: replayId, replayed }).toEqual({
        seriesId: series.seriesId,
        replayed: true,
      })
      expect(await jobsFor(bookingIds)).toEqual(prior)
      expect(imports()).toHaveLength(bookingIds.length)
    })

    it('cancels exactly the Google events in the requested tail', async () => {
      const fixture = await seriesFixture()
      const series = await fixture.create()
      await expectGoogleSeries(series.occurrences)
      const bookingIds = ids(series.occurrences).toSorted()
      const originalMappings = await mappings(fixture.calendarId)
      const originalJobs = await jobsFor(bookingIds)
      const tail = series.occurrences.slice(1)
      const affectedIds = new Set(ids(tail))
      const request = {
        scope: 'following',
        fromOrdinal: 2,
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
      } as const
      await expect(
        cancelManagedBookingSeries(context(), randomBytes(32).toString('base64url'), request),
      ).rejects.toMatchObject({ code: 'series_not_found' })
      expect(await jobsFor(bookingIds)).toEqual(originalJobs)
      const result = await cancelManagedBookingSeries(
        context(),
        required(series.manageToken),
        request,
      )
      await expectJobs(
        bookingIds,
        bookingIds.flatMap((id) =>
          affectedIds.has(id) ? [completed(id), completed(id)] : [completed(id)],
        ),
      )
      expect(values(patches())).toEqual(expect.arrayContaining(tail.map(googleCancellation)))
      expect(patches()).toHaveLength(tail.length)
      expect(imports()).toHaveLength(bookingIds.length)
      expect(entries()).toMatchObject(
        series.occurrences
          .map((occurrence) => googleEvent(occurrence, affectedIds.has(occurrence.bookingId)))
          .toSorted((a, b) => a.iCalUID.localeCompare(b.iCalUID)),
      )
      expect(await mappings(fixture.calendarId)).toEqual(originalMappings)
      expect(ids(result.affected)).toEqual(ids(tail))

      const prior = await jobsFor(bookingIds)
      expect(
        await cancelManagedBookingSeries(context(), required(series.manageToken), request),
      ).toMatchObject({ replayed: true })
      expect(await jobsFor(bookingIds)).toEqual(prior)
    })

    it('creates and deletes independent CalDAV resources for the same series rules', async () => {
      const fixture = await seriesFixture('caldav')
      const series = await fixture.create(notifyCalDav)
      const [first, ...tail] = ids(series.occurrences)
      const bookingIds = [required(first), ...tail].toSorted()
      const completedCalDav = (bookingId: string) => ({
        name: 'caldav-booking' as const,
        data: { bookingId },
        singleton_key: bookingId,
        state: 'completed',
        policy: 'stately',
        retry_limit: 5,
        retry_delay: 30,
        retry_backoff: true,
        retry_delay_max: 120,
      })
      await expectJobs(bookingIds, bookingIds.map(completedCalDav), 'caldav-booking')
      const resources = await mappings(fixture.calendarId)
      expect(resources.map(({ booking_id }) => booking_id)).toEqual(bookingIds)
      expect(calDavResources.size).toBe(bookingIds.length)
      for (const { booking_id, external_event_id } of resources) {
        const { body } = required(calDavResources.get(external_event_id))
        expect(body).toContain(`\r\nUID:${booking_id}\r\n`)
        expect(body).not.toMatch(/\r\n(?:RRULE|RECURRENCE-ID)[:;]/)
      }
      await cancelManagedBookingSeries(context(notifyCalDav), required(series.manageToken), {
        scope: 'following',
        fromOrdinal: 2,
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
      })
      await expectJobs(
        bookingIds,
        bookingIds.flatMap((id) =>
          tail.includes(id) ? [completedCalDav(id), completedCalDav(id)] : [completedCalDav(id)],
        ),
        'caldav-booking',
      )
      expect([...calDavResources.keys()]).toEqual(
        resources
          .filter(({ booking_id }) => booking_id === first)
          .map(({ external_event_id }) => external_event_id),
      )
    })

    it('retains the local series and retries only the occurrence with a provider failure', async () => {
      const fixture = await seriesFixture()
      const importEvent = google.client.importEvent
      const failedStart = required(required(fixture.planned[1]).start).toString()
      const failedImport = vi
        .spyOn(google.client, 'importEvent')
        .mockImplementation(async (...args) => {
          if (Temporal.Instant.from(args[2].start.dateTime).toString() === failedStart)
            throw new GoogleCalendarError('provider_unavailable')
          return importEvent(...args)
        })
      try {
        const series = await fixture.create()
        const failedId = required(series.occurrences[1]).bookingId
        const bookingIds = ids(series.occurrences).toSorted()
        const succeeded = bookingIds.filter((id) => id !== failedId)
        await expectJobs(
          bookingIds,
          bookingIds.map((id) =>
            id === failedId
              ? { ...completed(id), state: 'retry', retry_count: 0, delayed: true }
              : completed(id),
          ),
        )
        expect(
          await db
            .selectFrom('booking_series')
            .select('id')
            .where('id', '=', series.seriesId)
            .execute(),
        ).toEqual([{ id: series.seriesId }])
        expect(
          await db
            .selectFrom('bookings')
            .select(['id', 'status'])
            .where('id', 'in', bookingIds)
            .orderBy('id')
            .execute(),
        ).toEqual(bookingIds.map((id) => ({ id, status: 'confirmed' })))
        expect(await targets(fixture.calendarId)).toEqual(
          bookingIds.map((root_booking_id) => ({ root_booking_id })),
        )
        const successfulMappings = await mappings(fixture.calendarId)
        expect(successfulMappings.map(({ booking_id }) => booking_id)).toEqual(succeeded)

        failedImport.mockRestore()
        await database.pool.query(
          "UPDATE pgboss.job SET start_after = now() WHERE name = 'booking-calendar' AND singleton_key = $1 AND state = 'retry'",
          [failedId],
        )
        await expectJobs(
          bookingIds,
          bookingIds.map((id) => ({ ...completed(id), retry_count: id === failedId ? 1 : 0 })),
        )
        const repaired = await mappings(fixture.calendarId)
        expect(repaired.filter(({ booking_id }) => booking_id !== failedId)).toEqual(
          successfulMappings,
        )
        expect(repaired.map(({ booking_id }) => booking_id)).toEqual(bookingIds)
        expect(imports()).toHaveLength(bookingIds.length)
        expect(entries()).toHaveLength(bookingIds.length)
        expect(patches()).toHaveLength(0)
      } finally {
        failedImport.mockRestore()
      }
    })

    it('leaves Microsoft calendars untouched during series creation and cancellation', async () => {
      const fixture = await seriesFixture('microsoft')
      const series = await fixture.create()
      const bookingIds = ids(series.occurrences).toSorted()
      await expectJobs(bookingIds, bookingIds.map(completed))
      await cancelManagedBookingSeries(context(), required(series.manageToken), {
        scope: 'all',
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
      })
      await expectJobs(
        bookingIds,
        bookingIds.flatMap((id) => [completed(id), completed(id)]),
      )
      expect(await targets(fixture.calendarId)).toEqual([])
      expect(await mappings(fixture.calendarId)).toEqual([])
      expect(google.calls).toHaveLength(0)
      expect(microsoft.calls).toHaveLength(0)
    })

    it('keeps ordinary booking calendar payloads, singleton keys and retry policy', async () => {
      const host = await fixture()
      const { booking, manageToken } = await createPublicBooking(context(), {
        handle: host.handle,
        slug,
        start: Temporal.Instant.from(firstLocalStart),
        invitee,
      })
      const occurrence = { bookingId: booking.id, start: booking.start, end: booking.end }
      const job = completed(booking.id)
      await expectJobs([booking.id], [job])
      expect(values(imports())).toEqual([googleEvent(occurrence)])
      const originalMappings = await mappings(host.calendarId)
      expect(originalMappings).toHaveLength(1)

      await cancelManagedBooking(context(), required(manageToken))
      await expectJobs([booking.id], [job, job])
      expect(values(patches())).toEqual([googleCancellation(occurrence)])
      expect(values(imports())).toEqual([googleEvent(occurrence)])
      expect(await mappings(host.calendarId)).toEqual(originalMappings)
    })

    it('rolls back already-enqueued calendar jobs when a later occurrence fails', async () => {
      const fixture = await seriesFixture()
      const notified: string[] = []
      await expect(
        fixture.create(async (trx, event, timestamp) => {
          await notify(trx, event, timestamp)
          notified.push(event.bookingId)
          if (notified.length === 2) throw new Error('Synthetic calendar enqueue failure')
        }),
      ).rejects.toThrow('Synthetic calendar enqueue failure')
      expect(notified).toHaveLength(2)
      expect(await jobsFor(notified)).toEqual([])
      expect(await targets(fixture.calendarId)).toEqual([])
      expect(await mappings(fixture.calendarId)).toEqual([])
      expect(google.calls).toHaveLength(0)
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', fixture.eventId)
          .execute(),
      ).toEqual([])
    })
  },
)
