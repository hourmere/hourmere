import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertCachedCalendarSync, findSlots } from '../../scheduling/src/availability.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import {
  beginMicrosoftConnection,
  type CalendarDeps,
  configureCalendar,
  finishMicrosoftConnection,
  syncOwnedCalendar,
} from './index.ts'
import { calendarDispatchJob } from './jobs.ts'
import { MICROSOFT_DELTA_PAGE_BUDGET, syncMicrosoftCalendar } from './microsoft-sync.ts'
import { SYNC_MAX_AGE_MS } from './sync.ts'
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
  const instant = () => Temporal.Instant.fromEpochMilliseconds(now)
  const requiredWindow = () => {
    const day = instant().toZonedDateTimeISO('UTC').startOfDay().toInstant()
    return { start: day.subtract({ hours: 72 }), end: day.add({ hours: 403 * 24 }) }
  }

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
    expect(() => assertCachedCalendarSync([original], instant())).not.toThrow()

    const lastPage = 2 * MICROSOFT_DELTA_PAGE_BUDGET + 2
    const rebuildStartedAt = now + 1_000
    const requests: string[] = []
    let failedPage: number | undefined
    microsoft.controls.viewHook = (url) => {
      requests.push(url.href)
      if (url.href === cursor('expired')) {
        now = rebuildStartedAt
        return error('SyncStateNotFound', 410, { Location: 'https://example.invalid/resync' })
      }
      const page = Number(url.searchParams.get('$skiptoken') ?? '1')
      if (page === 1) expect(url.searchParams.has('startDateTime')).toBe(true)
      if (failedPage === page) return error('ServiceUnavailable', 503)
      const value = [{ ...prior, id: `replacement-${page}` }]
      if (page === lastPage) {
        now += 1_000
        return finish('rebuilt', value)
      }
      return Response.json({ '@odata.nextLink': continuation(page + 1), value })
    }

    await expect(syncOwnedCalendar(deps, owner, calendarId)).rejects.toMatchObject({
      code: 'microsoft_calendar_provider_unavailable',
    })
    expect(requests).toHaveLength(MICROSOFT_DELTA_PAGE_BUDGET)
    expect(requests[0]).toBe(cursor('expired'))
    const checkpoint = await metadata()
    expect(checkpoint.last_synced_at).toEqual(original.last_synced_at)
    expect(checkpoint.sync_state).toMatchObject({
      microsoftPending: {
        nextLink: continuation(MICROSOFT_DELTA_PAGE_BUDGET),
        startedAt: new Date(rebuildStartedAt).toISOString(),
      },
    })
    expect(await ids()).toEqual(['prior'])
    expect(checkpoint.sync_error).toBeNull()
    expect(() => assertCachedCalendarSync([checkpoint], instant(), requiredWindow())).not.toThrow()

    failedPage = MICROSOFT_DELTA_PAGE_BUDGET + 1
    requests.length = 0
    await expect(sync()).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 })
    expect(requests).toEqual([continuation(MICROSOFT_DELTA_PAGE_BUDGET), continuation(failedPage)])
    const failed = await metadata()
    expect(failed).toEqual({ ...checkpoint, sync_error: 'provider_unavailable' })
    expect(() => assertCachedCalendarSync([failed], instant(), requiredWindow())).toThrow(
      expect.objectContaining({ code: 'calendar_sync_unavailable' }),
    )
    expect(await ids()).toEqual(['prior'])

    failedPage = undefined
    requests.length = 0
    await sync()
    expect(requests[0]).toBe(continuation(MICROSOFT_DELTA_PAGE_BUDGET))
    expect(requests).toHaveLength(MICROSOFT_DELTA_PAGE_BUDGET)
    expect(await ids()).toEqual(['prior'])
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
    expect(published.last_synced_at).toEqual(new Date(rebuildStartedAt))
    expect(() => assertCachedCalendarSync([published], instant(), requiredWindow())).not.toThrow()
  })

  it.each(['next dispatch', 'same run', 'resumed catch-up'])(
    'never offers a newly busy slot after a stale round with catch-up by %s',
    async (catchUp) => {
      const fixtures = createFixtures(db)
      const hostUserId = owner.user.id
      const scheduleId = await fixtures.schedule(hostUserId, { timeZone: 'UTC', isDefault: false })
      const eventTypeId = await fixtures.eventType(owner.organization.id, hostUserId, {
        hosts: [{ userId: hostUserId, scheduleId }],
      })
      const rangeStart = Temporal.Instant.from('2026-03-05T10:00:00Z')
      const rangeEnd = rangeStart.add({ hours: 1 })
      const slotStarts = async () =>
        (
          await findSlots(db, { eventTypeId, hostUserId, rangeStart, rangeEnd, now: instant() })
        ).map(({ start }) => start.toString())
      const unaffectedSlot = rangeStart.add({ minutes: 30 }).toString()
      microsoft.controls.viewHook = () => finish('before-long-round')
      await sync()
      expect(await slotStarts()).toEqual([rangeStart.toString(), unaffectedSlot])

      const pagesLeft = catchUp === 'next dispatch' ? 0 : 1
      const lastPage = 2 * MICROSOFT_DELTA_PAGE_BUDGET - pagesLeft
      const catchUpContinuation = continuation(lastPage + 1)
      const requests: string[] = []
      let delayedChange: ReturnType<typeof event> | undefined
      microsoft.controls.viewHook = (url) => {
        requests.push(url.href)
        if (url.href === cursor('long-round')) {
          expect(delayedChange).toBeDefined()
          now += 1_000
          const value = [delayedChange]
          if (catchUp === 'resumed catch-up')
            return Response.json({ '@odata.nextLink': catchUpContinuation, value })
          return finish('caught-up', value)
        }
        if (url.href === catchUpContinuation) return finish('caught-up')
        const page =
          url.href === cursor('before-long-round') ? 1 : Number(url.searchParams.get('$skiptoken'))
        if (page === lastPage) return finish('long-round')
        return Response.json({ '@odata.nextLink': continuation(page + 1), value: [] })
      }

      now += 1_000
      const startedAt = now
      await sync()
      expect(requests).toHaveLength(MICROSOFT_DELTA_PAGE_BUDGET)
      expect(requests[0]).toBe(cursor('before-long-round'))
      // A change to a page Graph has already returned only shows up on the next delta read.
      now += 60_000
      delayedChange = event('late-change', '2026-03-05T10:00:00', '2026-03-05T10:30:00')
      now += SYNC_MAX_AGE_MS
      let followUpStartedAt = now
      await sync()
      expect(requests).toHaveLength(2 * MICROSOFT_DELTA_PAGE_BUDGET)

      if (catchUp !== 'same run') {
        await expect(slotStarts()).rejects.toMatchObject({ code: 'calendar_sync_unavailable' })
        const stale = await metadata()
        expect(stale).toMatchObject({
          last_synced_at: new Date(startedAt),
          sync_state: { deltaLink: cursor('long-round') },
          sync_error: null,
        })
        expect(await ids()).toEqual([])
        if (catchUp === 'resumed catch-up') {
          expect(stale.sync_state).toMatchObject({
            microsoftPending: {
              nextLink: catchUpContinuation,
              startedAt: new Date(followUpStartedAt).toISOString(),
            },
          })
        }

        now += 60_000
        const enqueued: string[] = []
        const dispatch = calendarDispatchJob(deps, async (id) => enqueued.push(id))
        expect(dispatch.schedule?.cron).toBe('* * * * *')
        await dispatch.handler(
          {},
          { id: 'synthetic-job', signal: new AbortController().signal, attempt: 1 },
        )
        expect(enqueued).toEqual([calendarId])
        if (catchUp === 'next dispatch') followUpStartedAt = now
        await sync()
      }

      expect(requests.slice(0, lastPage).at(-1)).toBe(continuation(lastPage))
      expect(requests.slice(lastPage)).toEqual(
        catchUp === 'resumed catch-up'
          ? [cursor('long-round'), catchUpContinuation]
          : [cursor('long-round')],
      )
      expect(await metadata()).toMatchObject({
        last_synced_at: new Date(followUpStartedAt),
        sync_state: { deltaLink: cursor('caught-up') },
      })
      expect(await slotStarts()).toEqual([unaffectedSlot])
    },
  )

  it.each(['early rollover', 'legacy snapshot'])(
    'serves a covering snapshot during %s',
    async (mode) => {
      const prior = event('published', '2026-04-01T10:00:00', '2026-04-01T11:00:00')
      microsoft.controls.viewHook = () => finish('old', [prior])
      await sync()
      if (mode === 'early rollover') now += 22 * 24 * 60 * 60_000
      const required = requiredWindow()
      await db
        .updateTable('calendars')
        .set({
          last_synced_at: new Date(now),
          ...(mode === 'legacy snapshot'
            ? {
                sync_state: JSON.stringify({
                  version: 2,
                  start: required.start.toString(),
                  end: required.end.toString(),
                  timeZone: null,
                }),
              }
            : {}),
        })
        .where('id', '=', calendarId)
        .execute()
      const original = await metadata()
      const requests: URL[] = []
      microsoft.controls.viewHook = (url) => {
        requests.push(url)
        const page = Number(url.searchParams.get('$skiptoken') ?? '0')
        return Response.json({ '@odata.nextLink': continuation(page + 1), value: [] })
      }
      await sync()
      expect(requests[0]?.searchParams.get('endDateTime')).toBe(
        required.end.add({ hours: 28 * 24 }).toString(),
      )
      const pending = await metadata()
      expect(pending.sync_state).toMatchObject({
        ...(mode === 'early rollover' ? { deltaLink: cursor('old') } : {}),
        microsoftPending: { nextLink: continuation(MICROSOFT_DELTA_PAGE_BUDGET), replace: true },
      })
      expect(pending.last_synced_at).toEqual(original.last_synced_at)
      expect(pending.sync_error).toBeNull()
      expect(() => assertCachedCalendarSync([pending], instant(), required)).not.toThrow()
      expect(await ids()).toEqual(['published'])

      const enqueued: string[] = []
      await calendarDispatchJob(deps, async (id) => enqueued.push(id)).handler(
        {},
        {
          id: 'synthetic-job',
          signal: new AbortController().signal,
          attempt: 1,
        },
      )
      expect(enqueued).toEqual([calendarId])

      microsoft.controls.viewHook = (url) => {
        expect(url.href).toBe(continuation(MICROSOFT_DELTA_PAGE_BUDGET))
        return finish('new')
      }
      await sync()
      expect(await ids()).toEqual([])
      expect((await metadata()).sync_state).toMatchObject({ deltaLink: cursor('new') })
    },
  )

  it.each(['stale', 'too short'])(
    'fails closed after a 410 when the old snapshot is %s',
    async (mode) => {
      const required = requiredWindow()
      microsoft.controls.viewHook = () => finish('expired')
      await sync()
      const shortenedEnd = required.end.subtract({ hours: 24 })
      if (mode === 'stale') now += 11 * 60_000
      else {
        await db
          .updateTable('calendars')
          .set({
            sync_state: JSON.stringify({
              version: 2,
              start: required.start.toString(),
              end: shortenedEnd.toString(),
              timeZone: null,
              deltaLink: cursor('expired'),
              microsoftPending: {
                start: required.start.toString(),
                end: required.end.toString(),
                nextLink: continuation(1),
                startedAt: instant().toString(),
                position: 0,
                replace: true,
              },
            }),
          })
          .where('id', '=', calendarId)
          .execute()
      }
      const expiredLink = mode === 'stale' ? cursor('expired') : continuation(1)
      const expiredAtProvider: string[] = []
      microsoft.controls.viewHook = (url) => {
        if (url.href === expiredLink && !expiredAtProvider.length) {
          expiredAtProvider.push(url.href)
          return error('SyncStateNotFound', 410)
        }
        const page = Number(url.searchParams.get('$skiptoken') ?? '0')
        return Response.json({ '@odata.nextLink': continuation(page + 1), value: [] })
      }
      await sync()
      expect(expiredAtProvider).toEqual([expiredLink])
      const pending = await metadata()
      expect(pending.sync_error).toBeNull()
      expect(() => assertCachedCalendarSync([pending], instant(), required)).toThrow(
        expect.objectContaining({ code: 'calendar_sync_unavailable' }),
      )
    },
  )

  it('uses the last delta copy even when its modification time is earlier', async () => {
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
              { ...deleted, lastModifiedDateTime: '2026-03-04T14:00:00Z' },
            ],
          })
        : finish('after-replays', [
            { ...moving, showAs: 'free', lastModifiedDateTime: '2026-03-04T13:00:00Z' },
            tombstone(deleted.id),
          ])
    await sync()
    expect(await ids()).toEqual([])
  })

  it('keeps an event busy after it moves out of and back into the window across runs', async () => {
    const moving = event('moving', '2026-03-05T13:00:00', '2026-03-05T14:00:00')
    const returned = event('moving', '2026-03-06T13:00:00', '2026-03-06T14:00:00')
    microsoft.controls.viewHook = () => finish('before-move', [moving])
    await sync()
    const original = await busy()

    microsoft.controls.viewHook = (url) => {
      if (url.href === cursor('before-move')) {
        return Response.json({ '@odata.nextLink': continuation(1), value: [tombstone(moving.id)] })
      }
      const page = Number(url.searchParams.get('$skiptoken'))
      return page === MICROSOFT_DELTA_PAGE_BUDGET
        ? finish('after-move', [returned])
        : Response.json({ '@odata.nextLink': continuation(page + 1), value: [] })
    }
    await sync()
    expect(await busy()).toEqual(original)
    expect((await metadata()).sync_state).toMatchObject({
      microsoftPending: { nextLink: continuation(MICROSOFT_DELTA_PAGE_BUDGET), position: 1 },
    })

    await sync()
    expect(await busy()).toEqual([
      { id: moving.id, start: '2026-03-06T13:00:00.000000Z', end: '2026-03-06T14:00:00.000000Z' },
    ])
  })

  it('keeps the live event that follows a changed marker in the same page', async () => {
    const live = event('live', '2026-03-05T13:00:00', '2026-03-05T14:00:00')
    microsoft.controls.viewHook = () =>
      finish('after-change', [{ id: live.id, '@removed': { reason: 'changed' } }, live])
    await sync()
    expect(await ids()).toEqual([live.id])
  })

  it.each([undefined, '2026-03-04T14:00:00Z'])(
    'preserves a busy recurring slot when another alias has ambiguous modification time (%s)',
    async (lastModifiedDateTime) => {
      const live = {
        ...occurrence('live-exception', '2026-03-05'),
        type: 'exception',
        ...(lastModifiedDateTime && { lastModifiedDateTime }),
      }
      const free = {
        ...live,
        id: 'free-exception',
        showAs: 'free',
        lastModifiedDateTime: '2026-03-04T14:00:00Z',
      }
      microsoft.controls.viewHook = () => finish('with-ambiguous-alias', [live, free])
      await sync()
      expect(await ids()).toEqual([live.id])
    },
  )

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
