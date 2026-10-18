import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAvailabilityInput } from '../../scheduling/src/availability.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SCOPES, GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { type CalendarDeps, tokenAad } from './index.ts'
import { configureCalendar, syncGoogleCalendar, syncOwnedCalendar } from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
const instant = (value: string) => Temporal.Instant.from(value)
const timed = (id: string, start = '2026-11-02T10:00:00Z', end = '2026-11-02T11:00:00Z') => ({
  id,
  start: { dateTime: start },
  end: { dateTime: end },
})

describe.skipIf(!url)('Google sync authorization and fail-closed guards (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let provider: ReturnType<typeof fakeGoogle>
  let deps: CalendarDeps
  let connectionId: string
  let calendarId: string
  let eventTypeId: string
  let now: number

  beforeAll(async () => {
    database = await createTestDatabase(url as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2028-01-01T00:00:00Z') })
      .where('id', 'in', [owner.sessionId, other.sessionId])
      .execute()
    const f = createFixtures(db)
    await f.schedule(owner.user.id, { timeZone: 'UTC' })
    eventTypeId = await f.eventType(owner.organization.id, owner.user.id)
  })

  afterAll(async () => {
    await database?.drop()
  })

  const credentials = (expiresAt: number) =>
    encryptCredential(
      calendarEncryptionKey(TEST_CALENDAR_KEY),
      tokenAad(owner.user.id, 'guard-account'),
      JSON.stringify({ accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt }),
    )
  beforeEach(async () => {
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    now = Date.parse('2026-11-01T12:00:00Z')
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: owner.user.id,
        provider: 'google',
        external_account_id: 'guard-account',
        credentials: credentials(now + 30 * 86_400_000),
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    connectionId = connection.id
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connectionId,
        external_id: 'guard-calendar',
        name: 'Guard calendar',
        time_zone: 'UTC',
        access_role: 'owner',
        check_conflicts: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    calendarId = calendar.id
  })

  const calendar = () =>
    db.selectFrom('calendars').selectAll().where('id', '=', calendarId).executeTakeFirstOrThrow()
  const busy = () =>
    db
      .selectFrom('calendar_busy')
      .select('external_event_id')
      .where('calendar_id', '=', calendarId)
      .orderBy('external_event_id')
      .execute()
  const availability = () =>
    buildAvailabilityInput(db, {
      eventTypeId,
      hostUserId: owner.user.id,
      rangeStart: instant('2026-11-02T09:00:00Z'),
      rangeEnd: instant('2026-11-02T12:00:00Z'),
      now: Temporal.Instant.fromEpochMilliseconds(now),
    })

  it('refuses sync-now for another user calendar before calling the provider', async () => {
    await expect(syncOwnedCalendar(deps, other, calendarId)).rejects.toMatchObject({
      code: 'calendar_not_found',
    })
    expect(provider.calls).toHaveLength(0)
    expect((await calendar()).last_synced_at).toBeNull()
  })

  it('invalidates fresh availability immediately when a provider sync fails', async () => {
    provider.controls.eventPages = [{ items: [timed('retained')], nextSyncToken: 'before' }]
    await syncGoogleCalendar(deps, calendarId)
    await expect(availability()).resolves.toBeDefined()
    provider.controls.eventStatus = 503
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect((await calendar()).sync_error).toBe('provider_unavailable')
    expect(await busy()).toEqual([{ external_event_id: 'retained' }])
    await expect(availability()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('clears a previous connection error after a successful sync', async () => {
    provider.controls.eventStatus = 503
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    const connection = () =>
      db
        .selectFrom('calendar_connections')
        .select(['status', 'last_error'])
        .where('id', '=', connectionId)
        .executeTakeFirstOrThrow()
    expect(await connection()).toEqual({ status: 'active', last_error: 'provider_unavailable' })
    provider.controls.eventStatus = 200
    await syncGoogleCalendar(deps, calendarId)
    expect(await connection()).toEqual({ status: 'active', last_error: null })
    expect((await calendar()).sync_error).toBeNull()
  })

  it('preserves the safe OAuth enum in the sync-now error cause', async () => {
    await db
      .updateTable('calendar_connections')
      .set({ credentials: credentials(now - 1) })
      .where('id', '=', connectionId)
      .execute()
    provider.controls.tokenStatus = 401
    provider.controls.tokenError = 'invalid_client'
    const error = await syncOwnedCalendar(deps, owner, calendarId).catch((error) => error)
    expect(error).toMatchObject({
      code: 'google_calendar_provider_unavailable',
      cause: { code: 'provider_unavailable', oauthError: 'invalid_client', status: 401 },
    })
  })

  it('renews the daily window with a full fetch and replaces the old snapshot', async () => {
    provider.controls.eventPages = [{ items: [timed('previous-day')], nextSyncToken: 'before' }]
    await syncGoogleCalendar(deps, calendarId)
    const previous = (await calendar()).sync_state
    now += 86_400_000
    provider.controls.eventHook = async (request) =>
      Response.json({
        items: request.searchParams.has('syncToken') ? [] : [timed('new-day')],
        nextSyncToken: 'after',
      })
    await syncGoogleCalendar(deps, calendarId)
    const request = provider.calls.at(-1)?.url
    expect(request?.searchParams.has('syncToken')).toBe(false)
    expect(request?.searchParams.get('timeMin')).toBe('2026-10-30T00:00:00Z')
    expect(request?.searchParams.get('timeMax')).toBe(
      instant('2026-11-02T00:00:00Z')
        .add({ hours: 403 * 24 })
        .toString(),
    )
    expect(await busy()).toEqual([{ external_event_id: 'new-day' }])
    expect((await calendar()).sync_state).not.toEqual(previous)
  })

  it('rejects an inactive connection even while its snapshot remains fresh', async () => {
    await syncGoogleCalendar(deps, calendarId)
    await expect(availability()).resolves.toBeDefined()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connectionId)
      .execute()
    await expect(availability()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('requires snapshot coverage before the query and its buffer window', async () => {
    await syncGoogleCalendar(deps, calendarId)
    await expect(availability()).resolves.toBeDefined()
    const saved = (await calendar()).sync_state
    await db
      .updateTable('calendars')
      .set({ sync_state: JSON.stringify({ ...(saved as object), start: '2026-11-02T00:00:00Z' }) })
      .where('id', '=', calendarId)
      .execute()
    await expect(availability()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('rejects a last-sync timestamp more than one minute in the future', async () => {
    await syncGoogleCalendar(deps, calendarId)
    await expect(availability()).resolves.toBeDefined()
    await db
      .updateTable('calendars')
      .set({ last_synced_at: new Date(now + 60_001) })
      .where('id', '=', calendarId)
      .execute()
    await expect(availability()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('rejects snapshot metadata from a different calendar time zone', async () => {
    await syncGoogleCalendar(deps, calendarId)
    await expect(availability()).resolves.toBeDefined()
    await db
      .updateTable('calendars')
      .set({ time_zone: 'America/Los_Angeles' })
      .where('id', '=', calendarId)
      .execute()
    await expect(availability()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
  })

  it('stores only events overlapping the sync window and removes deltas that leave it', async () => {
    const end = instant('2026-11-01T00:00:00Z').add({ hours: 403 * 24 })
    provider.controls.eventPages = [
      {
        items: [
          timed('before', '2026-10-28T23:00:00Z', '2026-10-29T00:00:00Z'),
          timed('after', end.toString(), end.add({ hours: 1 }).toString()),
          timed('cross-start', '2026-10-28T23:00:00Z', '2026-10-29T01:00:00Z'),
          timed(
            'cross-end',
            end.subtract({ hours: 1 }).toString(),
            end.add({ hours: 1 }).toString(),
          ),
          timed('inside'),
        ],
        nextSyncToken: 'before',
      },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect(await busy()).toEqual([
      { external_event_id: 'cross-end' },
      { external_event_id: 'cross-start' },
      { external_event_id: 'inside' },
    ])
    provider.controls.eventPages = [
      {
        items: [timed('inside', end.toString(), end.add({ hours: 1 }).toString())],
        nextSyncToken: 'after',
      },
    ]
    await syncGoogleCalendar(deps, calendarId)
    expect(await busy()).toEqual([
      { external_event_id: 'cross-end' },
      { external_event_id: 'cross-start' },
    ])
  })

  it('refuses the twenty-first selected conflict calendar without queueing a sync', async () => {
    await db
      .updateTable('calendars')
      .set({ check_conflicts: false })
      .where('id', '=', calendarId)
      .execute()
    await db
      .insertInto('calendars')
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          connection_id: connectionId,
          external_id: `selected-${index}`,
          name: `Selected ${index}`,
          check_conflicts: true,
        })),
      )
      .execute()
    const enqueueSync = vi.fn(async () => {})
    await expect(
      configureCalendar({ ...deps, enqueueSync }, owner, calendarId, true),
    ).rejects.toMatchObject({ code: 'calendar_selection_limit' })
    expect((await calendar()).check_conflicts).toBe(false)
    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('refuses event synchronization for a freeBusyReader calendar', async () => {
    await db
      .updateTable('calendars')
      .set({ check_conflicts: false, access_role: 'freeBusyReader' })
      .where('id', '=', calendarId)
      .execute()
    await expect(configureCalendar(deps, owner, calendarId, true)).rejects.toMatchObject({
      code: 'calendar_events_unreadable',
    })
    expect((await calendar()).check_conflicts).toBe(false)
    expect(provider.calls).toHaveLength(0)
  })

  it('checks sync scopes before any provider work', async () => {
    await db
      .updateTable('calendar_connections')
      .set({ scopes: [...GOOGLE_CALENDAR_SCOPES] })
      .where('id', '=', connectionId)
      .execute()
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'permissions_missing',
    })
    expect(provider.calls).toHaveLength(0)
    expect((await calendar()).last_synced_at).toBeNull()
  })

  it('rechecks reduced sync scopes after refreshing credentials before fetching events', async () => {
    await db
      .updateTable('calendar_connections')
      .set({ credentials: credentials(now - 1) })
      .where('id', '=', connectionId)
      .execute()
    provider.controls.token.scope = GOOGLE_CALENDAR_SCOPES.join(' ')
    await expect(syncGoogleCalendar(deps, calendarId)).rejects.toMatchObject({
      code: 'permissions_missing',
    })
    expect(provider.calls.map((call) => call.url.pathname)).toEqual(['/token'])
    expect(
      (
        await db
          .selectFrom('calendar_connections')
          .select('scopes')
          .where('id', '=', connectionId)
          .executeTakeFirstOrThrow()
      ).scopes,
    ).toEqual([...GOOGLE_CALENDAR_SCOPES])
    expect((await calendar()).last_synced_at).toBeNull()
  })
})
