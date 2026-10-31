import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAvailabilityInput } from '../../scheduling/src/availability.ts'
import { createPublicBooking } from '../../scheduling/src/bookings.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { calendarBookingNotifier, writeBookingCalendar } from './booking-events.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishGoogleConnection,
  listCalendarConnections,
  readTokens,
  refreshCalendarList,
  refreshGoogleCalendars,
} from './index.ts'
import { bookingCalendarJob, calendarDispatchJob, calendarSyncJob } from './jobs.ts'
import {
  configureCalendar,
  eventPeriod,
  setCalendarDestination,
  syncGoogleCalendar,
  syncOwnedCalendar,
} from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
const instant = (s: string) => Temporal.Instant.from(s)
const timed = (id: string, start = '2026-11-02T10:00:00Z', end = '2026-11-02T11:00:00Z') => ({
  id,
  start: { dateTime: start },
  end: { dateTime: end },
})
const allDay = (id: string, start = '2026-11-10', end = '2026-11-11') => ({
  id,
  start: { date: start },
  end: { date: end },
})
describe.skipIf(!url)('Google busy and booking synchronization (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let provider: ReturnType<typeof fakeGoogle>
  let deps: CalendarDeps
  let calendarId: string
  let connectionId: string
  let now: number
  let f: ReturnType<typeof createFixtures>
  beforeAll(async () => {
    database = await createTestDatabase(url as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    for (const principal of [owner, other])
      await db
        .insertInto('auth.apikey')
        .values({
          id: principal.sessionId,
          configId: 'default',
          referenceId: principal.user.id,
          key: `synthetic-${principal.sessionId}`,
          metadata: JSON.stringify({ organizationId: owner.organization.id }),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: other.user.id, handle: 'sync-other', time_zone: 'UTC' })
      .execute()
    f = createFixtures(db)
  })
  afterAll(async () => {
    await database?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('schedules').where('user_id', '=', owner.user.id).execute()
    await db.deleteFrom('profiles').where('user_id', '=', owner.user.id).execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    now = Date.parse('2026-11-01T12:00:00Z')
    // The real session clock is independent of the injected calendar clock.
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2028-01-01T00:00:00Z') })
      .where('id', 'in', [owner.sessionId, other.sessionId])
      .execute()
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
    const auth = new URL((await beginGoogleConnection(deps, owner, 'sync')).authorizationUrl)
    expect(
      await finishGoogleConnection(
        deps,
        owner,
        new URLSearchParams({ state: auth.searchParams.get('state') as string, code: 'fake-code' }),
      ),
    ).toBe('connected')
    const row = await db
      .selectFrom('calendars')
      .select(['id', 'connection_id'])
      .executeTakeFirstOrThrow()
    calendarId = row.id
    connectionId = row.connection_id
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle: 'sync-host', time_zone: 'UTC' })
      .execute()
  })
  const busy = async () =>
    db
      .selectFrom('calendar_busy')
      .selectAll()
      .where('calendar_id', '=', calendarId)
      .orderBy('external_event_id')
      .execute()
  const select = async () => configureCalendar(deps, owner, calendarId, true)
  const snapshot = async (id: string) =>
    db
      .transaction()
      .execute((trx) =>
        calendarBookingNotifier({ enqueue: async () => null })(trx, { bookingId: id }),
      )
  const booking = async () => {
    const id = await f.booking(
      owner.organization.id,
      [owner.user.id],
      '2026-11-02T10:00:00Z',
      '2026-11-02T10:30:00Z',
    )
    await snapshot(id)
    return id
  }
  async function reschedule(id: string) {
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(now) })
      .where('id', '=', id)
      .execute()
    const next = await f.booking(
      owner.organization.id,
      [owner.user.id],
      '2026-11-02T11:00:00Z',
      '2026-11-02T11:30:00Z',
    )
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: id })
      .where('id', '=', next)
      .execute()
    await snapshot(next)
    return next
  }

  it('binds elevated scopes to the attempt, rejects partial consent and prevents list-only connections opting in', async () => {
    await disconnectCalendar(deps, owner, connectionId)
    const request = new URL((await beginGoogleConnection(deps, owner, 'sync')).authorizationUrl)
    expect(request.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_CALENDAR_SYNC_SCOPES])
    provider.controls.token.scope =
      'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    expect(
      await finishGoogleConnection(
        deps,
        owner,
        new URLSearchParams({ state: request.searchParams.get('state') as string, code: 'fake' }),
      ),
    ).toBe('permissions_missing')
    expect(await db.selectFrom('calendar_connections').selectAll().execute()).toEqual([])
    const base = new URL((await beginGoogleConnection(deps, owner)).authorizationUrl)
    await finishGoogleConnection(
      deps,
      owner,
      new URLSearchParams({ state: base.searchParams.get('state') as string, code: 'fake' }),
    )
    const calendar = await db.selectFrom('calendars').select('id').executeTakeFirstOrThrow()
    await expect(configureCalendar(deps, owner, calendar.id, true)).rejects.toMatchObject({
      code: 'google_calendar_permissions_missing',
    })
  })
  it('checks ownership and enqueues the first sync in the settings transaction', async () => {
    const queued = vi.fn(async (_id: string, trx: Db) => {
      expect(trx.isTransaction).toBe(true)
    })
    await expect(configureCalendar(deps, other, calendarId, true)).rejects.toMatchObject({
      code: 'calendar_not_found',
    })
    await configureCalendar({ ...deps, enqueueSync: queued }, owner, calendarId, true)
    expect(queued).toHaveBeenCalledOnce()
    await expect(
      configureCalendar(
        {
          ...deps,
          enqueueSync: async () => {
            throw Error('queue down')
          },
        },
        owner,
        calendarId,
        false,
      ),
    ).resolves.toBeUndefined()
    await expect(
      configureCalendar(
        {
          ...deps,
          enqueueSync: async () => {
            throw Error('queue down')
          },
        },
        owner,
        calendarId,
        true,
      ),
    ).rejects.toThrow('queue down')
    expect(
      (
        await db
          .selectFrom('calendars')
          .select('check_conflicts')
          .where('id', '=', calendarId)
          .executeTakeFirstOrThrow()
      ).check_conflicts,
    ).toBe(false)
  })
  const delegated = (kind: 'api_key' | 'oauth', user = owner): Principal => ({
    user: user.user,
    organization: owner.organization,
    ...(kind === 'api_key'
      ? { kind, apiKeyId: user.sessionId, apiKeyScope: 'full' as const }
      : {
          kind,
          oauthConsentId: user.sessionId,
          clientId: 'synthetic-client',
          scopes: ['mcp:tools'],
        }),
  })
  it.each(['api_key', 'oauth'] as const)(
    'lets an owner %s principal manage existing non-credential settings with the shared services',
    async (kind) => {
      const principal = delegated(kind)
      await expect(configureCalendar(deps, principal, calendarId, true)).resolves.toBeUndefined()
      await expect(syncOwnedCalendar(deps, principal, calendarId)).resolves.toBeUndefined()
      await expect(setCalendarDestination(deps, principal, calendarId)).resolves.toBeUndefined()
      await expect(refreshCalendarList(deps, principal, connectionId)).resolves.toBeUndefined()
      const listed = await listCalendarConnections(deps, principal)
      expect(listed.destinationCalendarId).toBe(calendarId)
      expect(listed.data).toHaveLength(1)
      expect(listed.data[0]?.calendars[0]).toMatchObject({
        id: calendarId,
        checkConflicts: true,
        lastSyncedAt: new Date(now).toISOString(),
      })
      expect(
        (await listCalendarConnections(deps, delegated(kind, other))).destinationCalendarId,
      ).toBeNull()
      await setCalendarDestination(deps, principal, null)
      expect((await listCalendarConnections(deps, principal)).destinationCalendarId).toBeNull()
    },
  )
  it.each(['api_key', 'oauth'] as const)(
    'keeps another user’s calendars private from a %s principal in the same organization',
    async (kind) => {
      const principal = delegated(kind, other)
      expect((await listCalendarConnections(deps, principal)).data).toEqual([])
      await configureCalendar(deps, owner, calendarId, true)
      const calls = provider.calls.length
      await expect(configureCalendar(deps, principal, calendarId, true)).rejects.toMatchObject({
        code: 'calendar_not_found',
      })
      await expect(syncOwnedCalendar(deps, principal, calendarId)).rejects.toMatchObject({
        code: 'calendar_not_found',
      })
      await expect(setCalendarDestination(deps, principal, calendarId)).rejects.toMatchObject({
        code: 'calendar_not_found',
      })
      await expect(refreshCalendarList(deps, principal, connectionId)).rejects.toMatchObject({
        code: 'calendar_connection_not_found',
      })
      expect(provider.calls).toHaveLength(calls)
    },
  )
  it('still requires a live browser session when session callers change calendar settings', async () => {
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(now - 1) })
      .where('id', '=', owner.sessionId)
      .execute()
    for (const change of [
      () => configureCalendar(deps, owner, calendarId, true),
      () => setCalendarDestination(deps, owner, calendarId),
      () => refreshCalendarList(deps, owner, connectionId),
    ])
      await expect(change()).rejects.toMatchObject({ code: 'session_required' })
  })
  it('combines all pages atomically and persists only busy intervals', async () => {
    await select()
    provider.controls.eventPages = [
      { items: [{ ...timed('a'), summary: 'private event title' }], nextPageToken: '1' },
      { items: [timed('b')], nextSyncToken: 'next-cursor' },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect((await busy()).map((b) => b.external_event_id)).toEqual(['a', 'b'])
    const row = await db
      .selectFrom('calendars')
      .selectAll()
      .where('id', '=', calendarId)
      .executeTakeFirstOrThrow()
    expect(row.sync_state).toMatchObject({ token: 'next-cursor' })
    expect(row.last_synced_at?.getTime()).toBe(now)
    expect(JSON.stringify(await busy())).not.toContain('private event title')
    expect(
      provider.calls
        .filter((c) => c.url.pathname.endsWith('/events'))
        .at(-1)
        ?.url.searchParams.get('pageToken'),
    ).toBe('1')
  })
  it('applies incremental updates and deletes cancelled, declined and transparent events', async () => {
    await select()
    provider.controls.eventPages = [
      { items: [timed('a'), timed('b'), timed('c'), timed('d')], nextSyncToken: 'first' },
    ]
    await syncGoogleCalendar(deps, calendarId)
    provider.controls.eventPages = [
      {
        items: [
          timed('a', '2026-11-02T12:00Z', '2026-11-02T13:00Z'),
          { id: 'b', status: 'cancelled' },
          { ...timed('c'), transparency: 'transparent' },
          { ...timed('d'), attendees: [{ self: true, responseStatus: 'declined' }] },
        ],
        nextSyncToken: 'second',
      },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect((await busy()).map((b) => b.external_event_id)).toEqual(['a'])
    expect((await busy())[0]?.period).toContain('12:00:00')
    const call = provider.calls.filter((c) => c.url.pathname.endsWith('/events')).at(-1)?.url
    expect(call?.searchParams.get('syncToken')).toBe('first')
    expect(call?.searchParams.has('timeMin')).toBe(false)
  })
  it.each(['Asia/Shanghai', 'America/New_York'])(
    'preserves all-day dates from a %s calendar without making calendar-zone instants',
    async (timeZone) => {
      await select()
      provider.controls.eventPages = [
        { timeZone, items: [allDay('days', '2026-11-10', '2026-11-13')], nextSyncToken: 'days' },
      ]
      await syncGoogleCalendar(deps, calendarId)
      expect(await busy()).toEqual([
        expect.objectContaining({
          external_event_id: 'days',
          period: null,
          all_day_start: '2026-11-10',
          all_day_end: '2026-11-13',
        }),
      ])
    },
  )
  it('removes cancelled, transparent and self-declined all-day entries in deltas', async () => {
    await select()
    provider.controls.eventPages = [
      { items: ['a', 'b', 'c', 'd'].map((id) => allDay(id)), nextSyncToken: 'before' },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect(await busy()).toHaveLength(4)
    provider.controls.eventPages = [
      {
        items: [
          allDay('a'),
          { id: 'b', status: 'cancelled' },
          { ...allDay('c'), transparency: 'transparent' },
          { ...allDay('d'), attendees: [{ self: true, responseStatus: 'declined' }] },
        ],
        nextSyncToken: 'after',
      },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect((await busy()).map((row) => row.external_event_id)).toEqual(['a'])
  })
  it('replaces both representations when a provider event changes between timed and all-day', async () => {
    await select()
    provider.controls.eventPages = [{ items: [timed('changing')], nextSyncToken: 'timed' }]
    await expect(syncGoogleCalendar(deps, calendarId)).resolves.toBeUndefined()
    expect((await busy())[0]).toMatchObject({
      period: expect.stringContaining('2026-11-02 10:00:00'),
      all_day_start: null,
      all_day_end: null,
    })
    provider.controls.eventPages = [{ items: [allDay('changing')], nextSyncToken: 'day' }]
    await expect(syncGoogleCalendar(deps, calendarId)).resolves.toBeUndefined()
    expect((await busy())[0]).toMatchObject({
      period: null,
      all_day_start: '2026-11-10',
      all_day_end: '2026-11-11',
    })
    provider.controls.eventPages = [
      {
        items: [timed('changing', '2026-11-10T09:00:00-08:00', '2026-11-10T10:00:00-08:00')],
        nextSyncToken: 'timed-again',
      },
    ]
    await expect(syncGoogleCalendar(deps, calendarId)).resolves.toBeUndefined()
    expect((await busy())[0]).toMatchObject({
      period: expect.stringContaining('2026-11-10 17:00:00'),
      all_day_start: null,
      all_day_end: null,
    })
  })
  it('rebuilds invalidated legacy all-day ranges as dates on the next sync', async () => {
    await select()
    await db
      .insertInto('calendar_busy')
      .values(
        ['all-day', 'stale-legacy'].map((id) => ({
          calendar_id: calendarId,
          external_event_id: id,
          period: sql<string>`tstzrange('2026-11-09T16:00Z'::timestamptz,'2026-11-10T16:00Z'::timestamptz,'[)')`,
        })),
      )
      .execute()
    // The upgrade migration invalidates these fields because ranges cannot recover dates.
    await db
      .updateTable('calendars')
      .set({ sync_state: null, last_synced_at: null })
      .where('id', '=', calendarId)
      .execute()
    provider.controls.eventPages = [
      { timeZone: 'Asia/Shanghai', items: [allDay('all-day')], nextSyncToken: 'rebuilt' },
    ]
    await syncGoogleCalendar(deps, calendarId)
    const call = provider.calls.filter((c) => c.url.pathname.endsWith('/events')).at(-1)?.url
    expect(call?.searchParams.has('syncToken')).toBe(false)
    expect(await busy()).toEqual([
      expect.objectContaining({
        external_event_id: 'all-day',
        period: null,
        all_day_start: '2026-11-10',
        all_day_end: '2026-11-11',
      }),
    ])
  })
  it('preserves selected hidden calendars and their busy data and booking targets on list refresh', async () => {
    await select()
    await setCalendarDestination(deps, owner, calendarId)
    await booking()
    provider.controls.eventPages = [{ items: [timed('hidden-busy')], nextSyncToken: 'hidden' }]
    await syncGoogleCalendar(deps, calendarId)
    provider.controls.listHook = async (url) =>
      Response.json({
        items:
          url.searchParams.get('showHidden') === 'true'
            ? [
                {
                  id: 'primary-calendar',
                  summary: 'Hidden calendar',
                  hidden: true,
                  accessRole: 'owner',
                  timeZone: 'America/Los_Angeles',
                },
              ]
            : [],
      })
    await refreshGoogleCalendars(deps, owner, connectionId)
    expect(
      await db
        .selectFrom('calendars')
        .select(['id', 'check_conflicts'])
        .where('id', '=', calendarId)
        .executeTakeFirst(),
    ).toEqual({ id: calendarId, check_conflicts: true })
    expect((await busy()).map((row) => row.external_event_id)).toEqual(['hidden-busy'])
    expect(await db.selectFrom('booking_calendar_targets').select('calendar_id').execute()).toEqual(
      [{ calendar_id: calendarId }],
    )
    expect(
      (
        await db
          .selectFrom('profiles')
          .select('destination_calendar_id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirstOrThrow()
      ).destination_calendar_id,
    ).toBe(calendarId)
  })
  it('recovers a 410 with a complete replacement rather than publishing half a sync', async () => {
    await select()
    provider.controls.eventPages = [{ items: [timed('old')], nextSyncToken: 'old' }]
    await syncGoogleCalendar(deps, calendarId)
    provider.controls.eventHook = async (url) =>
      url.searchParams.has('syncToken')
        ? Response.json({}, { status: 410 })
        : Response.json({ items: [timed('new')], nextSyncToken: 'new' })
    await syncGoogleCalendar(deps, calendarId)
    expect((await busy()).map((b) => b.external_event_id)).toEqual(['new'])
  })
  it('retains the previous snapshot and cursor after a malformed later page', async () => {
    await select()
    provider.controls.eventPages = [{ items: [timed('old')], nextSyncToken: 'old' }]
    await syncGoogleCalendar(deps, calendarId)
    provider.controls.eventPages = [
      { items: [timed('partial')], nextPageToken: '1' },
      { items: [{ id: 'broken' }], nextSyncToken: 'new' },
    ]
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect((await busy()).map((b) => b.external_event_id)).toEqual(['old'])
    expect(
      (
        await db
          .selectFrom('calendars')
          .selectAll()
          .where('id', '=', calendarId)
          .executeTakeFirstOrThrow()
      ).sync_state,
    ).toMatchObject({ token: 'old' })
  })
  it.each([false, true])(
    'rebuilds offset-less timed intervals on collection/list timezone changes and keeps dates (metadata=%s)',
    async (refreshMetadata) => {
      await select()
      await db
        .updateTable('calendars')
        .set({ time_zone: 'UTC' })
        .where('id', '=', calendarId)
        .execute()
      const day = allDay('all-day', '2026-11-02', '2026-11-03')
      const localTimed = timed('local-timed', '2026-11-02T10:00:00', '2026-11-02T11:00:00')
      provider.controls.eventPages = [
        { timeZone: 'UTC', items: [day, localTimed], nextSyncToken: 'utc' },
      ]
      await syncGoogleCalendar(deps, calendarId)
      if (refreshMetadata)
        await db
          .updateTable('calendars')
          .set({ time_zone: 'America/Los_Angeles' })
          .where('id', '=', calendarId)
          .execute()
      provider.controls.eventHook = async (url) =>
        Response.json({
          timeZone: 'America/Los_Angeles',
          items: url.searchParams.has('syncToken') ? [] : [day, localTimed],
          nextSyncToken: 'la',
        })
      await syncGoogleCalendar(deps, calendarId)
      const rows = await busy()
      expect(rows.find((row) => row.external_event_id === 'all-day')).toMatchObject({
        period: null,
        all_day_start: '2026-11-02',
        all_day_end: '2026-11-03',
      })
      expect(rows.find((row) => row.external_event_id === 'local-timed')?.period).toContain(
        '2026-11-02 18:00:00',
      )
      expect(
        (
          await db
            .selectFrom('calendars')
            .select('sync_state')
            .where('id', '=', calendarId)
            .executeTakeFirstOrThrow()
        ).sync_state,
      ).toMatchObject({ timeZone: 'America/Los_Angeles' })
    },
  )
  it('accepts a shared writerWithoutPrivateAccess role without allowing it as the write destination', async () => {
    provider.controls.pages = [
      {
        items: [
          {
            id: 'primary-calendar',
            summary: 'My calendar',
            primary: true,
            timeZone: 'UTC',
            accessRole: 'writerWithoutPrivateAccess',
          },
        ],
      },
    ]
    const url = new URL((await beginGoogleConnection(deps, owner, 'sync')).authorizationUrl)
    expect(
      await finishGoogleConnection(
        deps,
        owner,
        new URLSearchParams({ state: url.searchParams.get('state') as string, code: 'fake' }),
      ),
    ).toBe('connected')
    expect(
      (
        await db
          .selectFrom('calendars')
          .select('access_role')
          .where('id', '=', calendarId)
          .executeTakeFirstOrThrow()
      ).access_role,
    ).toBe('writerWithoutPrivateAccess')
    await expect(setCalendarDestination(deps, owner, calendarId)).rejects.toMatchObject({
      code: 'calendar_not_writable',
    })
  })

  it('refuses repeated pages and missing final cursors', async () => {
    await select()
    provider.controls.eventPages = [
      { items: [], nextPageToken: '1' },
      { items: [], nextPageToken: '1' },
    ]
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    provider.controls.eventPages = [{ items: [] }]
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(await busy()).toEqual([])
  })
  it('preserves rotated refresh credentials when busy fetch fails', async () => {
    await select()
    const row = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow()
    const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
    const prior = readTokens(key, row.user_id, row.external_account_id, row.credentials)
    await db
      .updateTable('calendar_connections')
      .set({
        credentials: encryptCredential(
          key,
          `google:${row.user_id}:${row.external_account_id}`,
          JSON.stringify({ ...prior, expiresAt: now - 1 }),
        ),
      })
      .where('id', '=', connectionId)
      .execute()
    provider.controls.token.refresh_token = 'rotated-refresh'
    provider.controls.eventStatus = 503
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    const saved = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow()
    expect(
      readTokens(key, row.user_id, row.external_account_id, saved.credentials).refreshToken,
    ).toBe('rotated-refresh')
  })
  it('fails closed for unsynchronized, stale, failed and uncovered selected Google calendars', async () => {
    const schedule = await f.schedule(owner.user.id, { timeZone: 'UTC' })
    const et = await f.eventType(owner.organization.id, owner.user.id, {})
    const query = {
      eventTypeId: et,
      hostUserId: owner.user.id,
      rangeStart: instant('2026-11-02T09:00:00Z'),
      rangeEnd: instant('2026-11-02T12:00:00Z'),
      now: instant('2026-11-01T12:00:00Z'),
    }
    expect(schedule).toBeTruthy()
    await select()
    await expect(buildAvailabilityInput(db, query)).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
    await syncGoogleCalendar(deps, calendarId)
    expect(await buildAvailabilityInput(db, query)).toBeDefined()
    await expect(
      buildAvailabilityInput(db, { ...query, now: query.now.add({ minutes: 11 }) }),
    ).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
    await expect(
      buildAvailabilityInput(db, { ...query, rangeEnd: instant('2028-11-02T12:00:00Z') }),
    ).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
    await db
      .updateTable('calendars')
      .set({ sync_error: 'provider_unavailable' })
      .where('id', '=', calendarId)
      .execute()
    await expect(buildAvailabilityInput(db, query)).rejects.toMatchObject({
      code: 'calendar_sync_unavailable',
    })
  })
  it('allows only an owned, authorized destination in this user profile', async () => {
    await expect(setCalendarDestination(deps, other, calendarId)).rejects.toMatchObject({
      code: 'calendar_not_found',
    })
    await db
      .updateTable('calendars')
      .set({ access_role: 'writer' })
      .where('id', '=', calendarId)
      .execute()
    await expect(setCalendarDestination(deps, owner, calendarId)).rejects.toMatchObject({
      code: 'calendar_not_writable',
    })
    await db
      .updateTable('calendars')
      .set({ access_role: 'owner' })
      .where('id', '=', calendarId)
      .execute()
    await setCalendarDestination(deps, owner, calendarId)
    expect(
      (
        await db
          .selectFrom('profiles')
          .select('destination_calendar_id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirstOrThrow()
      ).destination_calendar_id,
    ).toBe(calendarId)
  })
  it('writes one private UID copy, recovers a lost mapping and keeps reschedules/cancellation on it', async () => {
    await setCalendarDestination(deps, owner, calendarId)
    const id = await booking()
    await writeBookingCalendar(deps, id)
    expect(provider.controls.storedEvents.size).toBe(1)
    const imported = [...provider.controls.storedEvents.values()][0]
    expect(imported).toMatchObject({ iCalUID: `${id}@hourmere`, sequence: 0 })
    expect(imported).not.toHaveProperty('attendees')
    await db.deleteFrom('booking_calendar_events').execute()
    await writeBookingCalendar(deps, id)
    expect(provider.controls.storedEvents.size).toBe(1)
    const next = await reschedule(id)
    await writeBookingCalendar(deps, id)
    expect(provider.controls.storedEvents.size).toBe(1)
    expect([...provider.controls.storedEvents.values()][0]).toMatchObject({
      iCalUID: `${id}@hourmere`,
      sequence: 1,
      start: { dateTime: '2026-11-02T11:00:00.000Z' },
    })
    const mapping = await db
      .selectFrom('booking_calendar_events')
      .selectAll()
      .where('booking_id', '=', next)
      .executeTakeFirstOrThrow()
    expect(mapping.external_event_id).toBe(imported?.id)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(now) })
      .where('id', '=', next)
      .execute()
    await writeBookingCalendar(deps, id)
    expect([...provider.controls.storedEvents.values()][0]).toMatchObject({
      status: 'cancelled',
      sequence: 2,
    })
    expect(await busy()).toEqual([])
  })
  it('ignores old destination changes for an already-bound meeting and never writes to another owner', async () => {
    await setCalendarDestination(deps, owner, calendarId)
    const id = await booking()
    await writeBookingCalendar(deps, id)
    await setCalendarDestination(deps, owner, null)
    const next = await reschedule(id)
    await writeBookingCalendar(deps, next)
    expect(provider.controls.storedEvents.size).toBe(1)
    expect(
      provider.calls.filter((c) => c.init.method === 'POST' && c.url.pathname.endsWith('/import')),
    ).toHaveLength(1)
  })
  it('keeps the committed destination even before the first provider attempt', async () => {
    await setCalendarDestination(deps, owner, calendarId)
    const id = await booking()
    await setCalendarDestination(deps, owner, null)
    await writeBookingCalendar(deps, id)
    expect(provider.controls.storedEvents.size).toBe(1)
    expect(
      (
        await db
          .selectFrom('booking_calendar_targets')
          .selectAll()
          .where('root_booking_id', '=', id)
          .execute()
      ).length,
    ).toBe(1)
  })
  it('recovers an import whose provider response was lost without importing another copy', async () => {
    await setCalendarDestination(deps, owner, calendarId)
    const id = await booking()
    const original = provider.client.importEvent
    const write = vi
      .spyOn(provider.client, 'importEvent')
      .mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('connection lost')
      })
    await expect(writeBookingCalendar(deps, id)).rejects.toThrow('connection lost')
    expect(await db.selectFrom('booking_calendar_events').selectAll().execute()).toHaveLength(0)
    await writeBookingCalendar(deps, id)
    expect(provider.controls.storedEvents.size).toBe(1)
    expect(write).toHaveBeenCalledTimes(1)
  })
  it('serializes sync with disconnect so a late sync cannot restore deleted data', async () => {
    await select()
    // Keep the token valid: a refresh would incidentally lock the connection row and hide
    // the absence of the owner lock this test is intended to exercise.
    const connection = await db
      .selectFrom('calendar_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirstOrThrow()
    const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
    const tokens = readTokens(
      key,
      connection.user_id,
      connection.external_account_id,
      connection.credentials,
    )
    await db
      .updateTable('calendar_connections')
      .set({
        credentials: encryptCredential(
          key,
          `google:${connection.user_id}:${connection.external_account_id}`,
          JSON.stringify({ ...tokens, expiresAt: now + 3_600_000 }),
        ),
      })
      .where('id', '=', connectionId)
      .execute()
    let release: () => void = () => {},
      entered: () => void = () => {}
    const pause = new Promise<void>((r) => {
        release = r
      }),
      seen = new Promise<void>((r) => {
        entered = r
      })
    provider.controls.eventHook = async () => {
      entered()
      await pause
      return Response.json({ items: [timed('late')], nextSyncToken: 'late' })
    }
    const sync = syncGoogleCalendar(deps, calendarId)
    sync.catch(() => {})
    await seen
    const disconnect = disconnectCalendar(deps, owner, connectionId)
    disconnect.catch(() => {})
    try {
      await vi.waitFor(
        async () => {
          const waiting = await database.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
          expect(waiting.rowCount).toBeGreaterThan(0)
        },
        { timeout: 2000, interval: 10 },
      )
      expect(
        await db
          .selectFrom('calendar_connections')
          .select('id')
          .where('id', '=', connectionId)
          .execute(),
      ).toHaveLength(1)
    } finally {
      release()
    }
    await sync
    await disconnect
    expect(await busy()).toEqual([])
    expect(await db.selectFrom('calendars').selectAll().execute()).toEqual([])
  })
  it('excludes the meeting ancestors while a second reschedule waits for calendar writeback', async () => {
    await select()
    await syncGoogleCalendar(deps, calendarId)
    await setCalendarDestination(deps, owner, calendarId)
    await f.schedule(owner.user.id, { timeZone: 'UTC' })
    const eventType = await f.eventType(owner.organization.id, owner.user.id, {})
    const id = await booking()
    await writeBookingCalendar(deps, id)
    const next = await reschedule(id)
    const input = await buildAvailabilityInput(db, {
      eventTypeId: eventType,
      hostUserId: owner.user.id,
      rangeStart: instant('2026-11-02T09:00:00Z'),
      rangeEnd: instant('2026-11-02T12:00:00Z'),
      now: instant('2026-11-01T12:00:00Z'),
      excludeBookingId: next,
    })
    expect(input?.busy).toEqual([])
  })

  it('excludes a booking mirrored through another connected account of the same user', async () => {
    await select()
    await syncGoogleCalendar(deps, calendarId)
    await setCalendarDestination(deps, owner, calendarId)
    await f.schedule(owner.user.id, { timeZone: 'UTC' })
    const eventType = await f.eventType(owner.organization.id, owner.user.id, {})
    const id = await booking()
    await writeBookingCalendar(deps, id)
    const source = await db
      .selectFrom('calendars')
      .selectAll()
      .where('id', '=', calendarId)
      .executeTakeFirstOrThrow()
    const otherConnection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: owner.user.id,
        provider: 'google',
        external_account_id: 'second-google-account',
        credentials: Buffer.from('unused-fixture'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const mirror = await db
      .insertInto('calendars')
      .values({
        connection_id: otherConnection.id,
        external_id: source.external_id,
        name: 'Shared mirror',
        check_conflicts: true,
        last_synced_at: source.last_synced_at,
        sync_state: JSON.stringify(source.sync_state),
        time_zone: source.time_zone,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const own = (await busy())[0]
    if (!own) throw Error('Missing own event')
    await db
      .insertInto('calendar_busy')
      .values({
        calendar_id: mirror.id,
        external_event_id: own.external_event_id,
        period: own.period,
      })
      .execute()
    const input = await buildAvailabilityInput(db, {
      eventTypeId: eventType,
      hostUserId: owner.user.id,
      rangeStart: instant('2026-11-02T10:15:00Z'),
      rangeEnd: instant('2026-11-02T10:45:00Z'),
      now: instant('2026-11-01T12:00:00Z'),
      excludeBookingId: id,
    })
    expect(input?.busy).toEqual([])
  })
  it('accepts a cancellation response containing only the provider event ID', async () => {
    await setCalendarDestination(deps, owner, calendarId)
    const id = await booking()
    await writeBookingCalendar(deps, id)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(now) })
      .where('id', '=', id)
      .execute()
    const original = provider.client.updateEvent
    vi.spyOn(provider.client, 'updateEvent').mockImplementationOnce(async (...args) => ({
      id: (await original(...args)).id,
    }))
    await writeBookingCalendar(deps, id)
    expect(await busy()).toEqual([])
  })

  it('queues a real booking destination without waiting for a busy-sync network call', async () => {
    await select()
    await syncGoogleCalendar(deps, calendarId)
    await setCalendarDestination(deps, owner, calendarId)
    await f.schedule(owner.user.id, { timeZone: 'UTC' })
    await f.eventType(owner.organization.id, owner.user.id, { slug: 'intro' })
    let release: () => void = () => {},
      entered: () => void = () => {}
    const pause = new Promise<void>((r) => {
        release = r
      }),
      seen = new Promise<void>((r) => {
        entered = r
      })
    provider.controls.eventHook = async () => {
      entered()
      await pause
      return Response.json({ items: [], nextSyncToken: 'after' })
    }
    const sync = syncGoogleCalendar(deps, calendarId)
    await seen
    const queue = { enqueue: vi.fn(async () => null) }
    const pending = createPublicBooking(
      { db, now: () => instant('2026-11-01T12:00:00Z'), notify: calendarBookingNotifier(queue) },
      {
        handle: 'sync-host',
        slug: 'intro',
        start: instant('2026-11-02T10:00:00Z'),
        invitee: { name: 'Test Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
      },
    )
    try {
      const completed = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ])
      expect(completed).toBe(true)
    } finally {
      release()
      await sync
    }
    const result = await pending
    expect(
      await db
        .selectFrom('booking_calendar_targets')
        .selectAll()
        .where('root_booking_id', '=', result.booking.id)
        .execute(),
    ).toHaveLength(1)
    expect(queue.enqueue).toHaveBeenCalledOnce()
  })

  it('queues booking changes atomically and preserves a pending follow-up while one is running', async () => {
    const sync = calendarSyncJob(deps),
      write = bookingCalendarJob(deps),
      dispatch = calendarDispatchJob(deps, async () => {})
    const jobs = createJobs({
      connectionString: database.url,
      definitions: [sync, write, dispatch],
      work: false,
      migrate: true,
    })
    await jobs.start()
    try {
      const notify = calendarBookingNotifier(jobs),
        id = await booking()
      await expect(
        db.transaction().execute(async (trx) => {
          await notify(trx, { bookingId: id })
          throw Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(
        (
          await database.pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1', [
            'booking-calendar',
          ])
        ).rows[0].n,
      ).toBe(0)
      await db.transaction().execute((trx) => notify(trx, { bookingId: id }))
      await database.pool.query(
        "UPDATE pgboss.job SET state='active' WHERE name='booking-calendar'",
      )
      await db.transaction().execute((trx) => notify(trx, { bookingId: id }))
      expect(
        (
          await database.pool.query('SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1', [
            'booking-calendar',
          ])
        ).rows[0].n,
      ).toBe(2)
    } finally {
      await jobs.stop()
    }
  })
})

describe('Google event time semantics', () => {
  it.each([null, 'America/Los_Angeles', 'Asia/Shanghai', 'Europe/Berlin'])(
    'keeps all-day dates and their exclusive end without interpreting timezone %s',
    (zone) => {
      expect(eventPeriod(allDay('day', '2026-03-08', '2026-03-10'), zone)).toEqual({
        kind: 'all_day',
        start: '2026-03-08',
        end: '2026-03-10',
      })
    },
  )
  it.each([
    { id: 'cancelled', status: 'cancelled' as const },
    { ...timed('transparent'), transparency: 'transparent' as const },
    { ...timed('declined'), attendees: [{ self: true, responseStatus: 'declined' }] },
  ])('does not block non-busy or cancelled events', (event) =>
    expect(eventPeriod(event, 'UTC')).toBeNull(),
  )
  it('widens sub-millisecond busy intervals instead of losing them to database rounding', () => {
    expect(
      eventPeriod(
        timed('tiny', '2026-11-02T10:00:00.000000001Z', '2026-11-02T10:00:00.000000002Z'),
        'UTC',
      ),
    ).toEqual({ kind: 'timed', start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:00:00.001Z' })
  })
  it('keeps explicit timed offsets independent of the calendar timezone', () => {
    expect(
      eventPeriod(
        timed('timed', '2026-11-10T09:00:00-08:00', '2026-11-10T10:00:00-08:00'),
        'Asia/Shanghai',
      ),
    ).toEqual({ kind: 'timed', start: '2026-11-10T17:00:00Z', end: '2026-11-10T18:00:00Z' })
  })
  it('refuses incomplete intervals', () => {
    expect(() => eventPeriod({ id: 'broken' }, 'UTC')).toThrow()
  })
  it.each([
    allDay('impossible', '2026-02-30', '2026-03-02'),
    allDay('malformed', '2026-2-01', '2026-03-02'),
    allDay('zero-year', '0000-01-01', '0000-01-02'),
    allDay('negative-year', '-000001-01-01', '2026-03-02'),
    allDay('expanded-year', '2026-03-01', '+010000-03-02'),
    allDay('empty', '2026-03-02', '2026-03-02'),
    allDay('reversed', '2026-03-03', '2026-03-02'),
    { id: 'mixed', start: { date: '2026-03-01' }, end: { dateTime: '2026-03-02T00:00:00Z' } },
    {
      id: 'ambiguous',
      start: { date: '2026-03-01', dateTime: '2026-03-01T00:00:00Z' },
      end: { date: '2026-03-02' },
    },
  ])('refuses malformed all-day dates or date ranges ($id)', (event) => {
    expect(() => eventPeriod(event, 'UTC')).toThrow()
  })
})
