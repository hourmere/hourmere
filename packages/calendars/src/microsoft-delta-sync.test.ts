import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertCachedCalendarSync } from '../../scheduling/src/availability.ts'
import {
  beginMicrosoftConnection,
  type CalendarDeps,
  configureCalendar,
  finishMicrosoftConnection,
  syncOwnedCalendar,
} from './index.ts'
import { MICROSOFT_DELTA_PAGE_BUDGET, syncMicrosoftCalendar } from './microsoft-sync.ts'
import { calendarTestSession, fakeMicrosoft, TEST_CALENDAR_KEY } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const deltaEndpoint =
  'https://graph.microsoft.com/v1.0/me/calendars/microsoft-calendar-1/calendarView/delta'
const cursor = (token: string) => `${deltaEndpoint}?$deltatoken=${token}`
const continuation = (page: number) => `${deltaEndpoint}?$skiptoken=${page}`
const finish = (token: string, value: unknown[] = []) =>
  Response.json({ '@odata.deltaLink': cursor(token), value })
const tombstone = (id: string) => ({ id, '@removed': { reason: 'deleted' } })
const error = (code: string, status: number, headers?: Record<string, string>) =>
  Response.json({ error: { code, message: 'Private provider error' } }, { status, headers })

// calendarView returns UTC dateTimeTimeZone pairs even when a local all-day event spans a DST change.
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' })
const event = (id: string, start: string, end: string) => ({
  id,
  type: 'singleInstance',
  showAs: 'busy',
  isAllDay: false,
  isCancelled: false,
  start: utc(start),
  end: utc(end),
})
const occurrence = (id: string, date: string, seriesMasterId = 'series') => ({
  ...event(id, `${date}T10:00:00`, `${date}T11:00:00`),
  type: 'occurrence',
  originalStart: `${date}T10:00:00.0000000Z`,
  seriesMasterId,
})

describe.skipIf(!serverUrl)('incremental Microsoft calendar snapshots', () => {
  let database: TestDatabase
  let db: Db
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let deps: CalendarDeps
  let microsoft: ReturnType<typeof fakeMicrosoft>
  let calendarId: string
  let now: number

  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    owner = await calendarTestSession(db)
  })
  afterAll(async () => database?.drop())

  beforeEach(async () => {
    await db.deleteFrom('calendar_connections').where('user_id', '=', owner.user.id).execute()
    now = Date.parse('2026-03-04T15:00:00Z')
    microsoft = fakeMicrosoft(() => now)
    deps = {
      db,
      now: () => now,
      microsoft: { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    const link = new URL((await beginMicrosoftConnection(deps, owner)).authorizationUrl)
    const callback = new URLSearchParams({
      state: link.searchParams.get('state') as string,
      code: 'fake-code',
    })
    expect(await finishMicrosoftConnection(deps, owner, callback)).toBe('connected')
    calendarId = (await db.selectFrom('calendars').select('id').executeTakeFirstOrThrow()).id
    await configureCalendar(deps, owner, calendarId, true)
  })

  const sync = () => syncMicrosoftCalendar(deps, calendarId)
  const metadata = () =>
    db
      .selectFrom('calendars as c')
      .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
      .select(['cc.status', 'c.sync_state', 'c.sync_error', 'c.last_synced_at', 'c.time_zone'])
      .where('c.id', '=', calendarId)
      .executeTakeFirstOrThrow()
  const busy = () =>
    db
      .selectFrom('calendar_busy')
      .select([
        'external_event_id as id',
        sql<string>`to_char(lower(period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'start',
        ),
        sql<string>`to_char(upper(period) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'end',
        ),
      ])
      .where('calendar_id', '=', calendarId)
      .orderBy('external_event_id')
      .execute()
  const ids = async () => (await busy()).map((row) => row.id)

  it('reconciles recurrence exceptions by original slot, cancellations, and series deletion', async () => {
    const first = occurrence('first', '2026-03-05')
    const second = occurrence('second', '2026-03-06')
    const third = occurrence('third', '2026-03-07')
    const other = occurrence('another-series', '2026-03-06', 'different-master')
    const allDay = {
      ...event('all-day', '2026-03-08T08:00:00', '2026-03-09T07:00:00'),
      isAllDay: true,
      showAs: 'oof',
      originalStartTimeZone: 'Pacific Standard Time',
    }
    microsoft.controls.viewHook = (url) => {
      expect(url.searchParams.has('startDateTime')).toBe(true)
      return finish('initial', [first, second, third, other, allDay])
    }
    await sync()
    expect(await ids()).toEqual(['all-day', 'another-series', 'first', 'second', 'third'])

    microsoft.controls.viewHook = (url) => {
      if (url.href === cursor('initial')) {
        return Response.json({
          '@odata.nextLink': continuation(1),
          value: [
            {
              ...first,
              id: 'modified',
              type: 'exception',
              start: utc('2026-03-05T13:00:00.1234567'),
              end: utc('2026-03-05T14:00:00.1234567'),
            },
            { ...second, id: 'cancelled-exception', type: 'exception', isCancelled: true },
            tombstone('third'),
            tombstone('outside-our-view'),
          ],
        })
      }
      expect(url.href).toBe(continuation(1))
      return finish('after-edits', [first, second, tombstone('different-master'), other])
    }
    await sync()
    expect(await ids()).toEqual(['all-day', 'another-series', 'modified'])
    expect(await busy()).toEqual(
      expect.arrayContaining([
        { id: 'all-day', start: '2026-03-08T08:00:00.000000Z', end: '2026-03-09T07:00:00.000000Z' },
        {
          id: 'modified',
          start: '2026-03-05T13:00:00.123456Z',
          end: '2026-03-05T14:00:00.123457Z',
        },
      ]),
    )

    microsoft.controls.viewHook = (url) => {
      expect(url.href).toBe(cursor('after-edits'))
      return finish('after-delete', [tombstone('series')])
    }
    await sync()
    expect(await ids()).toEqual(['all-day', 'another-series'])
  })

  it('checkpoints a resync past the old page cap, stays unavailable on failure, and publishes once', async () => {
    const prior = event('prior', '2026-03-05T10:00:00', '2026-03-05T11:00:00')
    microsoft.controls.viewHook = () => finish('expired', [prior])
    await sync()
    const original = await metadata()
    const instant = () => Temporal.Instant.fromEpochMilliseconds(now)
    expect(() => assertCachedCalendarSync([original], instant())).not.toThrow()

    const lastPage = 22
    const requests: string[] = []
    let failedPage: number | undefined
    microsoft.controls.viewHook = (url) => {
      requests.push(url.href)
      if (url.href === cursor('expired'))
        return error('SyncStateNotFound', 410, { Location: 'https://example.invalid/resync' })
      const page = Number(url.searchParams.get('$skiptoken') ?? '1')
      if (page === 1) expect(url.searchParams.has('startDateTime')).toBe(true)
      if (failedPage === page) return error('ServiceUnavailable', 503)
      const value = [{ ...prior, id: `replacement-${page}` }]
      return page === lastPage
        ? finish('rebuilt', value)
        : Response.json({ '@odata.nextLink': continuation(page + 1), value })
    }

    await expect(syncOwnedCalendar(deps, owner, calendarId)).rejects.toMatchObject({
      code: 'microsoft_calendar_provider_unavailable',
    })
    expect(requests).toHaveLength(MICROSOFT_DELTA_PAGE_BUDGET)
    expect(requests[0]).toBe(cursor('expired'))
    const checkpoint = await metadata()
    expect(checkpoint.last_synced_at).toEqual(original.last_synced_at)
    expect(checkpoint.sync_state).toMatchObject({
      microsoftPending: { nextLink: continuation(MICROSOFT_DELTA_PAGE_BUDGET) },
    })
    expect(await ids()).toEqual(['prior'])
    expect(() => assertCachedCalendarSync([checkpoint], instant())).toThrow(
      expect.objectContaining({ code: 'calendar_sync_unavailable' }),
    )

    failedPage = MICROSOFT_DELTA_PAGE_BUDGET + 1
    requests.length = 0
    await expect(sync()).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 })
    expect(requests).toEqual([continuation(MICROSOFT_DELTA_PAGE_BUDGET), continuation(failedPage)])
    expect(await metadata()).toEqual(checkpoint)
    expect(await ids()).toEqual(['prior'])

    failedPage = undefined
    requests.length = 0
    await sync()
    expect(requests[0]).toBe(continuation(MICROSOFT_DELTA_PAGE_BUDGET))
    expect(requests).toHaveLength(MICROSOFT_DELTA_PAGE_BUDGET)
    expect(await ids()).toEqual(['prior'])
    now += 11 * 60_000
    await sync()
    expect(await ids()).toEqual(
      Array.from({ length: lastPage }, (_, index) => `replacement-${index + 1}`).sort(),
    )
    expect(await db.selectFrom('calendar_microsoft_changes').select('position').execute()).toEqual(
      [],
    )
    const published = await metadata()
    expect(published.sync_state).toMatchObject({ deltaLink: cursor('rebuilt') })
    expect(published.sync_state).not.toHaveProperty('microsoftPending')
    expect(() => assertCachedCalendarSync([published], instant())).toThrow(
      expect.objectContaining({ code: 'calendar_sync_unavailable' }),
    )
    microsoft.controls.viewHook = (url) => {
      expect(url.href).toBe(cursor('rebuilt'))
      return finish('caught-up')
    }
    await sync()
    const caughtUp = await metadata()
    expect(() => assertCachedCalendarSync([caughtUp], instant())).not.toThrow()
  })

  it('uses the newer event version across unordered pages and removes an explicitly deleted event', async () => {
    const moving = event('moving', '2026-03-05T13:00:00', '2026-03-05T14:00:00')
    const deleted = event('deleted', '2026-03-06T10:00:00', '2026-03-06T11:00:00')
    microsoft.controls.viewHook = () => finish('before-replays', [moving, deleted])
    await sync()
    microsoft.controls.viewHook = (url) =>
      url.href === cursor('before-replays')
        ? Response.json({
            '@odata.nextLink': continuation(1),
            value: [
              { ...moving, lastModifiedDateTime: '2026-03-04T14:00:00Z' },
              tombstone(deleted.id),
            ],
          })
        : finish('after-replays', [
            { ...moving, showAs: 'free', lastModifiedDateTime: '2026-03-04T13:00:00Z' },
            { ...deleted, lastModifiedDateTime: '2026-03-04T13:00:00Z' },
          ])
    await sync()
    expect(await ids()).toEqual([moving.id])
  })

  it('drops expired cursors after syncStateNotFound, then reuses the rebuilt window until it runs out', async () => {
    const prior = event('prior', '2026-03-05T10:00:00', '2026-03-05T11:00:00')
    microsoft.controls.viewHook = () => finish('expired', [prior])
    await sync()
    const viewRequests: string[] = []
    microsoft.controls.viewHook = (url) => {
      viewRequests.push(url.href)
      if (url.href === cursor('expired')) return error('syncStateNotFound', 404)
      expect(url.searchParams.has('startDateTime')).toBe(true)
      return error('ServiceUnavailable', 503)
    }
    await expect(sync()).rejects.toMatchObject({ status: 503 })
    expect(viewRequests).toHaveLength(2)
    expect((await metadata()).sync_state).not.toHaveProperty('deltaLink')
    expect(await ids()).toEqual(['prior'])

    microsoft.controls.viewHook = (url) => {
      expect(url.searchParams.has('startDateTime')).toBe(true)
      return finish('rebuilt', [prior])
    }
    await sync()
    now += 24 * 60 * 60_000
    microsoft.controls.viewHook = (url) => {
      expect(url.href).toBe(cursor('rebuilt'))
      return finish('second-day')
    }
    await sync()
    expect(await ids()).toEqual(['prior'])

    now += 28 * 24 * 60 * 60_000
    microsoft.controls.viewHook = (url) => {
      expect(url.searchParams.has('startDateTime')).toBe(true)
      expect(url.searchParams.has('$deltatoken')).toBe(false)
      return finish('new-window')
    }
    await sync()
    expect(await ids()).toEqual([])
  })
})
