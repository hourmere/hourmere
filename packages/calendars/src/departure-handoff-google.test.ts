import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { EnqueueOptions } from '@hourmere/jobs'
import type { BookingNotifier } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readDepartureHandoffAdminPreview } from '../../scheduling/src/departure-handoff-admin.ts'
import { applyDepartureHandoff } from '../../scheduling/src/departure-handoff-apply.ts'
import {
  createHandoffTestFixture,
  HANDOFF_NOW,
  handoffTestRecords,
  handoffTestSession,
} from '../../scheduling/src/departure-handoff-apply-test-fixture.ts'
import {
  BOOKING_CALENDAR_JOB,
  calendarBookingNotifier,
  writeBookingCalendar,
} from './booking-events.ts'
import {
  CONFERENCE_JOB,
  conferenceBookingNotifier,
  retryBookingConference,
  writeBookingConference,
} from './conferences.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const NEW_LINK = 'https://meet.google.com/xyz-abcd-efg'

describe.skipIf(!databaseUrl)('departure handoff Google lifecycle (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let instant: Temporal.Instant
  let google: ReturnType<typeof fakeGoogle>
  let work: CalendarDeps
  const now = () => instant
  let jobs: { name: string; payload: unknown; singletonKey?: string }[]

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string)
    db = createDb(database.pool)
  })

  beforeEach(() => {
    instant = HANDOFF_NOW
    google = fakeGoogle(() => now().epochMilliseconds)
    work = {
      db,
      google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now().epochMilliseconds,
    }
    jobs = []
  })

  afterAll(async () => {
    await database?.drop()
  })

  async function connect(userId: string, name: string) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'google',
        external_account_id: name,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          tokenAad(userId, name),
          JSON.stringify({
            accessToken: `access-${name}`,
            refreshToken: `refresh-${name}`,
            expiresAt: HANDOFF_NOW.add({ hours: 5 }).epochMilliseconds,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: `${name}-calendar`,
        name,
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
        time_zone: 'UTC',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: userId,
        handle: `cal-${userId}`,
        time_zone: 'UTC',
        destination_calendar_id: calendar.id,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ destination_calendar_id: calendar.id }),
      )
      .execute()
    return { connectionId: connection.id, calendarId: calendar.id }
  }

  async function stage(meet = false, sourceReady = false) {
    const queue = {
      async enqueue(name: string, payload: unknown, options?: EnqueueOptions) {
        expect(options?.transaction).toBeDefined()
        jobs.push({ name, payload, singletonKey: options?.singletonKey })
        return null
      },
    }
    const calendar = calendarBookingNotifier(queue, { now: work.now })
    const conference = conferenceBookingNotifier(queue)
    const notify: BookingNotifier = async (trx, event) => {
      if ('requestId' in event) return
      await conference(trx, event)
      await calendar(trx, event)
    }
    let original!: Awaited<ReturnType<typeof connect>>
    let successor!: typeof original
    const fixture = await createHandoffTestFixture(db, {
      now,
      sourceContext: { automaticMeet: true, notify },
      applyContext: { automaticMeet: true, notify },
      configureSource: async ({ eventTypeId, departing }) => {
        original = await connect(departing.id, 'old')
        if (meet)
          await db
            .updateTable('event_types')
            .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
            .where('id', '=', eventTypeId)
            .execute()
      },
      configureTarget: async ({ candidate }) => {
        successor = await connect(candidate.id, 'new')
      },
    })
    if (sourceReady) {
      await writeBookingConference(work, fixture.booking.id)
      instant = instant.add({ minutes: 2 })
      await writeBookingConference(work, fixture.booking.id)
    }
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', fixture.team.id)
      .where('userId', '=', fixture.departing.id)
      .execute()
    const records = handoffTestRecords(db)
    await records.offer(fixture.ctx, fixture.input, { departingUserId: fixture.departing.id })
    return {
      ...fixture,
      original,
      successor,
      apply: () => applyDepartureHandoff(fixture.ctx, fixture.input, records.store),
      receipt: async () =>
        (await readDepartureHandoffAdminPreview(fixture.ctx, fixture.input, records.store)).receipt,
    }
  }

  function intent(id: string) {
    return db
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', id)
      .executeTakeFirstOrThrow()
  }

  const callsFor = (name: string) =>
    google.calls.filter(({ url }) => url.pathname.includes(`/${name}-calendar/`))

  it('reconciles lost cancellation acknowledgements under the original pinned account', async () => {
    const staged = await stage()
    const source = staged.booking.id
    await writeBookingCalendar(work, source)
    const originalId = [...google.controls.storedEvents.keys()][0] as string
    expect(originalId).toBeTruthy()
    await connect(staged.departing.id, 'changed')
    const callsBeforeApply = google.calls.length

    const ids = await staged.apply()
    expect(google.calls).toHaveLength(callsBeforeApply)
    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'not_required',
      oldConferenceCleanup: 'pending',
    })
    expect(jobs).toContainEqual({
      name: BOOKING_CALENDAR_JOB,
      payload: { bookingId: source },
      singletonKey: source,
    })
    const callsBeforeCleanup = google.calls.length
    google.controls.eventHook = async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-old')
      expect(new Headers(init.headers).get('if-match')).toBe(
        init.method === 'PATCH' ? '"v1"' : null,
      )
      const event = google.controls.storedEvents.get(originalId)
      if (init.method !== 'PATCH') return Response.json({ items: [event] })
      google.controls.storedEvents.set(originalId, { ...event, status: 'cancelled', etag: '"v2"' })
      return Response.json({}, { status: 503 })
    }
    await expect(writeBookingCalendar(work, source)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(await staged.receipt()).toMatchObject({ oldConferenceCleanup: 'unresolved' })
    google.controls.eventHook = undefined
    await writeBookingCalendar(work, source)
    await writeBookingCalendar(work, source)

    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'not_required',
      oldConferenceCleanup: 'complete',
    })
    expect(google.calls.slice(callsBeforeCleanup)).toEqual(
      callsFor('old').slice(callsBeforeCleanup),
    )
    expect(google.calls.filter(({ init }) => init.method === 'PATCH')).toHaveLength(1)
    expect(google.calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1)
    expect(google.controls.storedEvents.get(originalId)).toMatchObject({ status: 'cancelled' })
    expect(
      await db
        .selectFrom('calendar_busy')
        .select('external_event_id')
        .where('calendar_id', '=', staged.original.calendarId)
        .execute(),
    ).toEqual([])
  })

  it('keeps an original Google copy unresolved when the original grant is revoked', async () => {
    const staged = await stage()
    const source = staged.booking.id
    await writeBookingCalendar(work, source)
    const callsBefore = google.calls.length
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', staged.original.connectionId)
      .execute()
    const ids = await staged.apply()
    await writeBookingCalendar(work, source)
    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'not_required',
      oldConferenceCleanup: 'unresolved',
    })
    expect(google.calls).toHaveLength(callsBefore)
    expect([...google.controls.storedEvents.values()]).toEqual([
      expect.objectContaining({ status: 'confirmed', iCalUID: `${source}@hourmere` }),
    ])
    await db
      .deleteFrom('calendar_connections')
      .where('id', '=', staged.original.connectionId)
      .execute()
    expect(await staged.receipt()).toMatchObject({ oldConferenceCleanup: 'unresolved' })
  })

  it('retries an empty lookup after an old import response is lost', async () => {
    const staged = await stage()
    const source = staged.booking.id
    const eventId = 'old-late-event'
    let accepted: Record<string, unknown> | undefined
    google.controls.eventHook = async (_url, init) => {
      if (init.method !== 'POST') return Response.json({ items: [] })
      accepted = { ...JSON.parse(String(init.body)), id: eventId, etag: '"v1"' }
      return Response.json({}, { status: 503 })
    }
    await expect(writeBookingCalendar(work, source)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(accepted).toMatchObject({ iCalUID: `${source}@hourmere`, status: 'confirmed' })
    await staged.apply()
    google.controls.eventHook = undefined
    await expect(writeBookingCalendar(work, source)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(await staged.receipt()).toMatchObject({ oldConferenceCleanup: 'unresolved' })
    google.controls.storedEvents.set(eventId, accepted ?? {})
    await writeBookingCalendar(work, source)
    expect(await staged.receipt()).toMatchObject({ oldConferenceCleanup: 'complete' })
    expect(google.controls.storedEvents.get(eventId)).toMatchObject({ status: 'cancelled' })
    expect(google.calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1)
  })

  it('refuses to cancel a different event that reuses the same UID', async () => {
    const staged = await stage()
    const source = staged.booking.id
    await writeBookingCalendar(work, source)
    const [[originalId, original]] = [...google.controls.storedEvents] as [
      [string, Record<string, unknown>],
    ]
    google.controls.storedEvents.delete(originalId)
    google.controls.storedEvents.set('different-event', { ...original, id: 'different-event' })
    await staged.apply()
    await writeBookingCalendar(work, source)
    expect(google.calls.filter(({ init }) => init.method === 'PATCH')).toEqual([])
    expect(await staged.receipt()).toMatchObject({ oldConferenceCleanup: 'unresolved' })
    expect(google.controls.storedEvents.get('different-event')).toMatchObject({
      status: 'confirmed',
    })
  })

  it('recovers a distinct new Meet after a lost import response and polls without another create', async () => {
    const staged = await stage(true, true)
    const source = staged.booking.id
    const old = await intent(source)
    expect(old).toMatchObject({ state: 'ready', organizer_user_id: staged.departing.id })
    const callsBeforeApply = google.calls.length

    const ids = await staged.apply()
    const replacement = ids.replacementBookingId
    expect(google.calls).toHaveLength(callsBeforeApply)
    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'pending',
      oldConferenceCleanup: 'pending',
    })
    expect(jobs).toContainEqual({
      name: CONFERENCE_JOB,
      payload: { rootBookingId: replacement },
      singletonKey: replacement,
    })
    const fresh = await intent(replacement)
    expect(fresh).toMatchObject({
      state: 'pending',
      external_event_id: null,
      calendar_id: staged.successor.calendarId,
      organizer_user_id: staged.candidate.id,
      connection_id: staged.successor.connectionId,
    })
    expect(fresh.request_id).not.toBe(old.request_id)
    await connect(staged.departing.id, 'changed')
    await connect(staged.candidate.id, 'changed-new')
    await writeBookingConference(work, source)
    expect(google.controls.storedEvents.get(old.external_event_id as string)).toMatchObject({
      status: 'cancelled',
    })
    const eventId = 'event-lost-response'
    google.controls.conferenceUrl = NEW_LINK
    google.controls.eventHook = async (url, init) => {
      expect(url.pathname).toContain('/new-calendar/')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-new')
      expect(init.method).toBe('POST')
      const committed = await db
        .selectFrom('bookings')
        .select(['id', 'status', 'location', 'rescheduled_from_id'])
        .where('id', 'in', [source, replacement])
        .execute()
      expect(committed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: source, status: 'cancelled' }),
          {
            id: replacement,
            status: 'confirmed',
            rescheduled_from_id: null,
            location: { kind: 'google_meet', autoCreate: true },
          },
        ]),
      )
      await db.transaction().execute(async (trx) => {
        for (const host of [staged.departing, staged.candidate]) {
          const { rows } = await sql<{ unlocked: boolean }>`select pg_try_advisory_xact_lock(
            hashtextextended(${`booking-host:${host.id}`}, 0)) as unlocked`.execute(trx)
          expect(rows[0]?.unlocked).toBe(true)
        }
      })
      const value = JSON.parse(String(init.body))
      expect(value.iCalUID).toBe(`${replacement}@hourmere`)
      google.controls.storedEvents.set(eventId, { ...value, id: eventId, etag: '"v1"' })
      return Response.json({}, { status: 503 })
    }

    await writeBookingConference(work, replacement)
    expect(await intent(replacement)).toMatchObject({
      state: 'failed',
      error_code: 'ambiguous_create',
      external_event_id: null,
      create_started: true,
    })
    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'failed',
      oldConferenceCleanup: 'complete',
    })
    await expect(retryBookingConference(staged.ctx, replacement)).rejects.toMatchObject({
      code: 'conference_not_found',
    })
    const principal = await handoffTestSession(
      db,
      staged.candidate,
      staged.team.as(staged.candidate).organization,
    )
    await retryBookingConference({ ...staged.ctx, principal }, replacement)
    google.controls.eventHook = undefined
    await writeBookingConference(work, replacement)
    expect(await staged.receipt()).toMatchObject({ conference: 'pending' })
    instant = instant.add({ minutes: 2 })
    await writeBookingConference(work, replacement)
    await writeBookingConference(work, replacement)

    expect(await staged.receipt()).toEqual({
      ...ids,
      conference: 'ready',
      oldConferenceCleanup: 'complete',
    })
    expect(await intent(replacement)).toMatchObject({
      external_event_id: eventId,
      request_id: fresh.request_id,
      state: 'ready',
    })
    expect(
      await db
        .selectFrom('bookings')
        .select('location')
        .where('id', '=', replacement)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      location: { kind: 'google_meet', autoCreate: true, url: NEW_LINK },
    })
    expect(callsFor('new').filter(({ init }) => init.method === 'POST')).toHaveLength(1)
    expect(callsFor('new').filter(({ init }) => init.method === 'PATCH')).toHaveLength(1)
    expect(google.controls.storedEvents.size).toBe(2)
  })

  it('refuses to create a Meet when the pinned successor calendar loses support after apply', async () => {
    const staged = await stage(true)
    const { replacementBookingId } = await staged.apply()
    await db
      .updateTable('calendars')
      .set({ supports_google_meet: false })
      .where('id', '=', staged.successor.calendarId)
      .execute()
    await writeBookingConference(work, replacementBookingId)
    expect(google.calls).toHaveLength(0)
    expect(await intent(replacementBookingId)).toMatchObject({
      state: 'failed',
      error_code: 'calendar_unavailable',
      create_started: false,
    })
    expect(await staged.receipt()).toMatchObject({ conference: 'failed' })
  })
})
