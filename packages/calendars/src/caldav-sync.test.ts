import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectCalDav } from './caldav-connection.ts'
import { calDavDispatchJob, calDavSyncJob, createCalDavSyncEnqueuer } from './caldav-jobs.ts'
import { type CalDavSyncDeps, configureCalDavCalendar, syncCalDavCalendar } from './caldav-sync.ts'
import type { CalDavSyncClient } from './caldav-sync-client.ts'
import { CalDavError } from './caldav-transport.ts'
import { calendarTestSession, TEST_CALENDAR_KEY } from './testing.ts'

const calendarUrl = 'https://dav.example.com/calendars/events/'
const credentials = {
  serverUrl: 'https://dav.example.com/',
  username: 'synthetic-owner',
  password: 'synthetic-secret',
}
const now = () => Date.parse('2026-11-16T12:00:00Z')
const ical = (start = '20261117T100000Z', end = '20261117T110000Z') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-uid\r\nSUMMARY:Secret event title\r\nATTENDEE:mailto:private@example.com\r\nDTSTART:${start}\r\nDTEND:${end}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
type Page = Awaited<ReturnType<CalDavSyncClient['sync']>>
const page = (full = true): Page => ({
  full,
  syncToken: 'token-1',
  etags: { [`${calendarUrl}one.ics`]: 'etag-1' },
  resources: [{ href: `${calendarUrl}one.ics`, etag: 'etag-1', calendarData: ical() }],
  deleted: [],
  calendarTimezone: 'UTC',
})

describe.skipIf(!process.env.DATABASE_URL)('internal CalDAV sync persistence and jobs', () => {
  let database: TestDatabase, db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })
  async function setup() {
    const owner = await calendarTestSession(db)
    const connection = await connectCalDav(
      {
        db,
        encryptionKey: TEST_CALENDAR_KEY,
        client: {
          discover: async () => ({
            principalUrl: 'https://dav.example.com/p/',
            calendarHomeUrl: 'https://dav.example.com/calendars/',
            calendars: [
              {
                url: calendarUrl,
                displayName: 'Work',
                color: null,
                supportsEvents: true,
                canWrite: true,
              },
            ],
          }),
        },
      },
      owner,
      credentials,
      [calendarUrl],
    )
    const calendar = await db
      .selectFrom('calendars')
      .selectAll()
      .where('connection_id', '=', connection.id)
      .executeTakeFirstOrThrow()
    const sync = vi.fn<CalDavSyncClient['sync']>(async () => page())
    const enqueueSync = vi.fn(async () => {})
    const deps: CalDavSyncDeps = {
      db,
      encryptionKey: TEST_CALENDAR_KEY,
      client: { sync },
      now,
      enqueueSync,
    }
    return { owner, connection, calendar, sync, deps, enqueueSync }
  }
  async function rows(id: string) {
    return db.selectFrom('calendar_busy').selectAll().where('calendar_id', '=', id).execute()
  }
  async function stored(id: string) {
    return db.selectFrom('calendars').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  }
  it('requires a current owner session and explicit selection before network reads', async () => {
    const s = await setup(),
      other = await calendarTestSession(db)
    await syncCalDavCalendar(s.deps, s.calendar.id)
    expect(s.sync).not.toHaveBeenCalled()
    await expect(configureCalDavCalendar(s.deps, other, s.calendar.id, true)).rejects.toMatchObject(
      { code: 'calendar_not_found' },
    )
    await expect(
      configureCalDavCalendar(
        s.deps,
        { ...s.owner, kind: 'api_key', apiKeyId: s.owner.user.id, apiKeyScope: 'full' },
        s.calendar.id,
        true,
      ),
    ).rejects.toMatchObject({ code: 'session_required' })
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', s.owner.sessionId)
      .execute()
    await expect(
      configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true),
    ).rejects.toMatchObject({ code: 'session_required' })
    expect((await stored(s.calendar.id)).check_conflicts).toBe(false)
  })
  it('atomically reconciles initial, changed, added and deleted resources without retaining event content', async () => {
    const s = await setup()
    await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
    expect(s.enqueueSync).toHaveBeenCalledOnce()
    await syncCalDavCalendar(s.deps, s.calendar.id)
    expect(await rows(s.calendar.id)).toHaveLength(1)
    const first = await stored(s.calendar.id)
    expect(first.sync_state).toMatchObject({
      version: 2,
      syncToken: 'token-1',
      caldavDiscovery: { available: true },
    })
    for (const secret of [
      'Secret event title',
      'private@example.com',
      'private-uid',
      credentials.password,
      credentials.username,
    ])
      expect(JSON.stringify([first, await rows(s.calendar.id)])).not.toContain(secret)
    const changed = page(false)
    changed.syncToken = 'token-2'
    const changedResource = changed.resources[0]
    if (!changedResource) throw new Error('Missing fixture')
    changedResource.calendarData = ical('20261117T120000Z', '20261117T130000Z')
    changed.resources.push({
      href: `${calendarUrl}two.ics`,
      etag: 'etag-2',
      calendarData: ical('20261118T100000Z', '20261118T110000Z'),
    })
    changed.etags[`${calendarUrl}two.ics`] = 'etag-2'
    s.sync.mockResolvedValue(changed)
    await syncCalDavCalendar(s.deps, s.calendar.id)
    expect(s.sync.mock.calls[1]?.[1].previous?.syncToken).toBe('token-1')
    expect(await rows(s.calendar.id)).toHaveLength(2)
    const starts = await db
      .selectFrom('calendar_busy')
      .select(sql<Date>`lower(period)`.as('start'))
      .where('calendar_id', '=', s.calendar.id)
      .execute()
    expect(starts.map((row) => row.start.toISOString())).toContain('2026-11-17T12:00:00.000Z')
    s.sync.mockResolvedValue({
      ...page(false),
      syncToken: 'token-3',
      resources: [],
      etags: {},
      deleted: [`${calendarUrl}one.ics`, `${calendarUrl}two.ics`],
    })
    await syncCalDavCalendar(s.deps, s.calendar.id)
    expect(await rows(s.calendar.id)).toEqual([])
    expect((await stored(s.calendar.id)).sync_state).toMatchObject({
      syncToken: 'token-3',
      resources: {},
    })
  })
  it('keeps prior busy data and token on malformed updates and sanitizes provider exceptions', async () => {
    const s = await setup()
    await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
    await syncCalDavCalendar(s.deps, s.calendar.id)
    const before = await rows(s.calendar.id)
    s.sync.mockResolvedValue({
      ...page(false),
      syncToken: 'unsafe-new-token',
      resources: [{ href: `${calendarUrl}one.ics`, etag: 'bad', calendarData: 'malformed' }],
    })
    await expect(syncCalDavCalendar(s.deps, s.calendar.id)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    expect(await rows(s.calendar.id)).toEqual(before)
    expect(await stored(s.calendar.id)).toMatchObject({
      sync_error: 'provider_unavailable',
      sync_state: { syncToken: 'token-1' },
    })
    s.sync.mockRejectedValue(new Error(credentials.password))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(syncCalDavCalendar(s.deps, s.calendar.id)).rejects.toEqual(
        new CalDavError('unavailable'),
      )
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
  it('invalidates freshness and preserves data when the atomic database write fails', async () => {
    const s = await setup()
    await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
    await syncCalDavCalendar(s.deps, s.calendar.id)
    const before = await rows(s.calendar.id)
    const duplicate = page()
    duplicate.resources.push(...duplicate.resources)
    s.sync.mockResolvedValue(duplicate)
    await expect(syncCalDavCalendar(s.deps, s.calendar.id)).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(await rows(s.calendar.id)).toEqual(before)
    expect((await stored(s.calendar.id)).sync_error).toBe('provider_unavailable')
  })
  it('stops rejected credential jobs and dispatches only active selected calendars', async () => {
    const s = await setup()
    await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
    s.sync.mockRejectedValue(new CalDavError('unauthorized'))
    const job = calDavSyncJob(s.deps)
    expect(job.retry).toEqual({ limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 })
    const run = { id: 'test', attempt: 1, signal: new AbortController().signal }
    await job.handler({ calendarId: s.calendar.id }, run)
    await job.handler({ calendarId: s.calendar.id }, run)
    expect(s.sync).toHaveBeenCalledOnce()
    expect(
      await db
        .selectFrom('calendar_connections')
        .select('status')
        .where('id', '=', s.connection.id)
        .executeTakeFirst(),
    ).toEqual({ status: 'needs_reauth' })
    const enqueue = vi.fn(async () => {})
    await calDavDispatchJob(s.deps, enqueue).handler({}, run)
    expect(enqueue.mock.calls.flat()).not.toContain(s.calendar.id)
    const transient = await setup()
    await configureCalDavCalendar(transient.deps, transient.owner, transient.calendar.id, true)
    transient.sync.mockRejectedValue(new CalDavError('timeout'))
    await expect(
      calDavSyncJob(transient.deps).handler({ calendarId: transient.calendar.id }, run),
    ).rejects.toMatchObject({ code: 'timeout' })
    await calDavDispatchJob(s.deps, enqueue).handler({}, run)
    expect(enqueue).toHaveBeenCalledWith(transient.calendar.id)
  })
  it('deduplicates selection and dispatch against queued and retrying jobs transactionally', async () => {
    const s = await setup()
    const jobs = createJobs({
      connectionString: database.url,
      definitions: [calDavSyncJob(s.deps)],
      work: false,
      migrate: true,
      maxConnections: 2,
    })
    try {
      await jobs.start()
      const enqueue = createCalDavSyncEnqueuer(jobs)
      await expect(
        db.transaction().execute(async (trx) => {
          await enqueue(s.calendar.id, trx)
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      const count = async () =>
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1 AND singleton_key=$2',
            ['caldav-sync', s.calendar.id],
          )
        ).rows[0].n
      expect(await count()).toBe(0)
      s.deps.enqueueSync = enqueue
      await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
      expect(await count()).toBe(1)
      expect(await enqueue(s.calendar.id)).toBeNull()
      // A dispatch during the delayed retry must not introduce an immediate new attempt.
      await database.pool.query(
        "UPDATE pgboss.job SET state='retry', start_after=now()+interval '2 minutes' WHERE name=$1 AND singleton_key=$2",
        ['caldav-sync', s.calendar.id],
      )
      await calDavDispatchJob(s.deps, enqueue).handler(
        {},
        { id: 'dispatch', attempt: 1, signal: new AbortController().signal },
      )
      expect(await count()).toBe(1)
      expect(await enqueue(s.calendar.id)).toBeNull()
    } finally {
      await jobs.stop()
    }
  })
  it('serializes two simultaneous jobs on the same connection', async () => {
    const s = await setup()
    await configureCalDavCalendar(s.deps, s.owner, s.calendar.id, true)
    let active = 0,
      maximum = 0
    s.sync.mockImplementation(async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active--
      return page()
    })
    await Promise.all([
      syncCalDavCalendar(s.deps, s.calendar.id),
      syncCalDavCalendar(s.deps, s.calendar.id),
    ])
    expect(s.sync).toHaveBeenCalledTimes(2)
    expect(maximum).toBe(1)
    expect(await rows(s.calendar.id)).toHaveLength(1)
  })
})
