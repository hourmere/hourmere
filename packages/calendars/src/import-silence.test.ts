import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookingConferenceJob } from './conferences.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import type { CalendarDeps } from './index.ts'
import { bookingCalendarJob } from './jobs.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const moduleFor = (name: string) =>
  process.env.HOURMERE_SILENCE_MUTATION_TARGET === name
    ? (process.env.HOURMERE_SILENCE_MUTATION_FILE as string)
    : `./${name}`
const {
  calendarBookingNotifier,
  recoverBookingCalendarPage,
  redispatchBookingCalendar,
  writeBookingCalendar,
}: typeof import('./booking-events.ts') = await import(moduleFor('booking-events.ts'))
const {
  conferenceBookingNotifier,
  conferenceDispatchJob,
  retryBookingConference,
  writeBookingConference,
}: typeof import('./conferences.ts') = await import(moduleFor('conferences.ts'))
const {
  conferenceMirrorDispatchJob,
  retryConferenceMirror,
  writeConferenceMirrors,
}: typeof import('./conference-mirrors.ts') = await import(moduleFor('conference-mirrors.ts'))

const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = '2030-11-04T09:00:00Z'
const JOIN = 'https://meet.google.com/abc-defg-hij'

describe.skipIf(!process.env.DATABASE_URL)(
  'imported bookings stay local across calendar workers',
  () => {
    let database: TestDatabase
    let db: Db
    let user: Awaited<ReturnType<typeof createTestUser>>
    let provider: ReturnType<typeof fakeGoogle>
    let deps: CalendarDeps
    let bookingId: string
    let calendarId: string
    let connectionId: string
    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'silent_calendar',
      })
      db = createDb(database.pool)
    })
    afterAll(async () => database?.drop())
    beforeEach(async () => {
      user = await createTestUser(db)
      provider = fakeGoogle(() => NOW.epochMilliseconds)
      deps = {
        db,
        google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
        now: () => NOW.epochMilliseconds,
      }
      connectionId = randomUUID()
      calendarId = randomUUID()
      await db
        .insertInto('calendar_connections')
        .values({
          id: connectionId,
          user_id: user.id,
          provider: 'google',
          external_account_id: connectionId,
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
          credentials: encryptCredential(
            calendarEncryptionKey(TEST_CALENDAR_KEY),
            `google:${user.id}:${connectionId}`,
            JSON.stringify({
              accessToken: 'fake-access',
              refreshToken: 'fake-refresh',
              expiresAt: NOW.epochMilliseconds + 3_600_000,
            }),
          ),
        })
        .execute()
      await db
        .insertInto('calendars')
        .values({
          id: calendarId,
          connection_id: connectionId,
          external_id: calendarId,
          name: 'Synthetic destination',
          access_role: 'owner',
          supports_google_meet: true,
        })
        .execute()
      await db
        .insertInto('profiles')
        .values({
          user_id: user.id,
          handle: `silence-${user.id.slice(0, 16)}`,
          time_zone: 'UTC',
          destination_calendar_id: calendarId,
        })
        .execute()
      bookingId = await createFixtures(db).booking(
        user.principal.organization.id,
        [user.id],
        START,
        '2030-11-04T09:30:00Z',
        { source: 'import' },
      )
    })
    async function intent(state: 'pending' | 'ready' | 'failed' = 'pending') {
      await db
        .updateTable('bookings')
        .set({
          location: JSON.stringify({ kind: 'google_meet', autoCreate: true, url: JOIN }),
        })
        .where('id', '=', bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: bookingId,
          booking_id: bookingId,
          organization_id: user.principal.organization.id,
          organizer_user_id: user.id,
          calendar_id: calendarId,
          connection_id: connectionId,
          state,
          applied_revision: state === 'ready' ? 0 : null,
          invitation_organizer_name: 'Synthetic host',
          invitation_organizer_email: user.principal.user.email,
          next_attempt_at: new Date(NOW.epochMilliseconds),
        })
        .execute()
    }
    async function mirror(state: 'pending' | 'failed' = 'pending') {
      await intent('ready')
      await db
        .insertInto('booking_conference_mirrors')
        .values({
          root_booking_id: bookingId,
          user_id: user.id,
          calendar_id: calendarId,
          connection_id: connectionId,
          state,
          next_attempt_at: new Date(NOW.epochMilliseconds),
        })
        .execute()
    }
    async function staleBacklog(mirrors = false) {
      const prefix = randomUUID().slice(0, 8)
      const ids = Array.from(
        { length: 101 },
        (_, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`,
      )
      await db
        .insertInto('bookings')
        .values(
          ids.map((id, n) => ({
            id,
            organization_id: user.principal.organization.id,
            start_at: START,
            end_at: '2030-11-04T09:30:00Z',
            title: 'Synthetic dispatch backlog',
            source: n < 100 ? 'import' : 'api',
            import_questions: n < 100 ? '[]' : null,
          })),
        )
        .execute()
      await db
        .insertInto('booking_conferences')
        .values(
          ids.map((id, n) => ({
            root_booking_id: id,
            booking_id: id,
            organization_id: user.principal.organization.id,
            organizer_user_id: user.id,
            state: mirrors ? 'ready' : 'pending',
            applied_revision: mirrors ? 0 : null,
            next_attempt_at: new Date(NOW.epochMilliseconds - (n < 100 ? 1000 : 0)),
          })),
        )
        .execute()
      if (mirrors)
        await db
          .insertInto('booking_conference_mirrors')
          .values(
            ids.map((id) => ({
              root_booking_id: id,
              user_id: user.id,
              calendar_id: calendarId,
              connection_id: connectionId,
              state: 'pending',
              next_attempt_at: new Date(NOW.epochMilliseconds),
            })),
          )
          .execute()
      return { imported: ids.slice(0, 100), ordinary: ids[100] as string }
    }
    const context = () => testContext(db, user.principal, () => NOW)
    const queued = () => ({ enqueue: vi.fn(async () => randomUUID()) })
    const event = () => ({ bookingId, type: 'created' as const })
    const jobContext = { id: randomUUID(), signal: new AbortController().signal, attempt: 1 }

    it('calendar notifier creates neither destination artifacts nor jobs', async () => {
      const queue = queued()
      await db.transaction().execute((trx) => calendarBookingNotifier(queue)(trx, event()))
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .selectAll()
          .where('root_booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it('calendar explicit redispatch refuses imports', async () => {
      const queue = queued()
      await expect(redispatchBookingCalendar(db, queue, bookingId)).rejects.toMatchObject({
        code: 'imported_booking_read_only',
      })
      expect(queue.enqueue).not.toHaveBeenCalled()
    })
    it('Google reconnect recovery creates neither destination artifacts nor jobs', async () => {
      const enqueue = vi.fn(async (_id: string) => undefined)
      await recoverBookingCalendarPage(deps, connectionId, undefined, enqueue)
      expect(enqueue).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .selectAll()
          .where('root_booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it('calendar worker ignores stale destination artifacts after restart', async () => {
      await db
        .insertInto('booking_calendar_targets')
        .values({ root_booking_id: bookingId, user_id: user.id, calendar_id: calendarId })
        .execute()
      await writeBookingCalendar(deps, bookingId)
      expect(provider.calls).toEqual([])
      expect(
        await db
          .selectFrom('booking_calendar_events')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it('plain imports reject conference and mirror retry before looking for external artifacts', async () => {
      await expect(retryBookingConference(context(), bookingId)).rejects.toMatchObject({
        code: 'imported_booking_read_only',
      })
      await expect(retryConferenceMirror(context(), bookingId)).rejects.toMatchObject({
        code: 'imported_booking_read_only',
      })
    })
    it('conference notifier does not enqueue stale intents', async () => {
      await intent()
      const queue = queued()
      await db.transaction().execute((trx) => conferenceBookingNotifier(queue)(trx, event()))
      expect(queue.enqueue).not.toHaveBeenCalled()
    })
    it('conference dispatcher does not enqueue stale intents', async () => {
      await intent()
      const enqueue = vi.fn(async (_id: string) => undefined)
      await conferenceDispatchJob(deps, enqueue).handler({}, jobContext)
      expect(enqueue).not.toHaveBeenCalled()
    })
    it('conference dispatch reaches ordinary work behind 100 stale imported intents', async () => {
      const backlog = await staleBacklog()
      const enqueue = vi.fn(async (_id: string) => undefined)
      const job = conferenceDispatchJob(deps, enqueue)
      for (let n = 0; n < 2; n++) {
        enqueue.mockClear()
        await job.handler({}, jobContext)
        expect(enqueue).toHaveBeenCalledWith(backlog.ordinary)
        expect(enqueue.mock.calls.some(([id]) => backlog.imported.includes(id))).toBe(false)
      }
    })
    it('conference worker neither claims nor contacts provider for stale intents', async () => {
      await intent()
      await writeBookingConference(deps, bookingId)
      expect(provider.calls).toEqual([])
      expect(
        await db
          .selectFrom('booking_conferences')
          .select(['attempts', 'create_started'])
          .where('root_booking_id', '=', bookingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ attempts: 0, create_started: false })
    })
    it('conference retry refuses imported bookings with failed stale intents', async () => {
      await intent('failed')
      await expect(retryBookingConference(context(), bookingId)).rejects.toMatchObject({
        code: 'imported_booking_read_only',
      })
      expect(
        (
          await db
            .selectFrom('booking_conferences')
            .select('state')
            .where('root_booking_id', '=', bookingId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('failed')
    })
    it('mirror dispatcher does not enqueue stale copies', async () => {
      await mirror()
      const enqueue = vi.fn(async (_id: string) => undefined)
      await conferenceMirrorDispatchJob(deps, enqueue).handler({}, jobContext)
      expect(enqueue).not.toHaveBeenCalled()
    })
    it('mirror dispatch reaches ordinary work behind 100 stale imported copies', async () => {
      const backlog = await staleBacklog(true)
      const enqueue = vi.fn(async (_id: string) => undefined)
      const job = conferenceMirrorDispatchJob(deps, enqueue)
      for (let n = 0; n < 2; n++) {
        enqueue.mockClear()
        await job.handler({}, jobContext)
        expect(enqueue).toHaveBeenCalledWith(backlog.ordinary)
        expect(enqueue.mock.calls.some(([id]) => backlog.imported.includes(id))).toBe(false)
      }
    })
    it('mirror worker neither claims nor contacts provider for stale copies', async () => {
      await mirror()
      await writeConferenceMirrors(deps, bookingId)
      expect(provider.calls).toEqual([])
      expect(
        await db
          .selectFrom('booking_conference_mirrors')
          .select(['attempts', 'create_started'])
          .where('root_booking_id', '=', bookingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ attempts: 0, create_started: false })
    })
    it('restarted workers drain persisted stale jobs without provider calls', async () => {
      await mirror()
      const options = {
        connectionString: database.url,
        definitions: [bookingCalendarJob(deps), bookingConferenceJob(deps)],
        maxConnections: 2,
        pollingIntervalSeconds: 0.5,
        log: () => {},
      }
      const producer = createJobs({ ...options, work: false, migrate: true })
      const worker = createJobs({ ...options, work: true, migrate: false })
      try {
        await producer.start()
        const calendarJob = await producer.enqueue('booking-calendar', { bookingId })
        const conferenceJob = await producer.enqueue('booking-conference', {
          rootBookingId: bookingId,
        })
        await producer.stop()
        await worker.start()
        await vi.waitFor(
          async () => {
            const result = await database.pool.query<{ state: string }>(
              'SELECT state FROM pgboss.job WHERE id = ANY($1::uuid[])',
              [[calendarJob, conferenceJob]],
            )
            expect(result.rows).toHaveLength(2)
            expect(result.rows.every((row) => row.state === 'completed')).toBe(true)
          },
          { timeout: 5000, interval: 50 },
        )
        expect(provider.calls).toEqual([])
        expect(
          (
            await db
              .selectFrom('booking_conferences')
              .select('attempts')
              .where('root_booking_id', '=', bookingId)
              .executeTakeFirstOrThrow()
          ).attempts,
        ).toBe(0)
        expect(
          (
            await db
              .selectFrom('booking_conference_mirrors')
              .select('attempts')
              .where('root_booking_id', '=', bookingId)
              .executeTakeFirstOrThrow()
          ).attempts,
        ).toBe(0)
      } finally {
        await worker.stop()
        await producer.stop()
      }
    })
    it('mirror retry refuses imported bookings with failed stale copies', async () => {
      await mirror('failed')
      await expect(retryConferenceMirror(context(), bookingId)).rejects.toMatchObject({
        code: 'imported_booking_read_only',
      })
      expect(
        (
          await db
            .selectFrom('booking_conference_mirrors')
            .select('state')
            .where('root_booking_id', '=', bookingId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('failed')
    })
  },
)
