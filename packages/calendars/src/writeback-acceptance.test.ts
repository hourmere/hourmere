import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixtures } from '../../scheduling/src/testing.ts'
import {
  calendarBookingNotifier,
  recoverBookingCalendarPage,
  redispatchBookingCalendar,
  writeBookingCalendar,
} from './booking-events.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES, GoogleCalendarError } from './google.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  finishGoogleConnection,
  listCalendarConnections,
} from './index.ts'
import { bookingCalendarJob, bookingCalendarRecoveryJob, calendarDispatchJob } from './jobs.ts'
import { syncGoogleCalendar } from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
const NOW = Date.parse('2026-11-01T12:00:00Z')
describe.skipIf(!url)('Calendar writeback acceptance (real Postgres)', () => {
  let database: TestDatabase
  let db: Db
  let a: Awaited<ReturnType<typeof calendarTestSession>>
  let b: typeof a
  let f: ReturnType<typeof createFixtures>
  let provider: ReturnType<typeof fakeGoogle>
  let deps: CalendarDeps
  let calA: string
  let calB: string
  let connectionA: string
  beforeAll(async () => {
    database = await createTestDatabase(url as string)
    db = createDb(database.pool)
    a = await calendarTestSession(db)
    b = await calendarTestSession(db)
    f = createFixtures(db)
    await db
      .insertInto('profiles')
      .values([
        { user_id: a.user.id, handle: 'writeback-a', time_zone: 'UTC' },
        { user_id: b.user.id, handle: 'writeback-b', time_zone: 'UTC' },
      ])
      .execute()
  })
  afterAll(async () => {
    await database?.drop()
  })
  async function connect(userId: string, calendarId: string, account: string) {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          `google:${userId}:${account}`,
          JSON.stringify({
            accessToken: 'fake-access',
            refreshToken: 'fake-refresh',
            expiresAt: NOW + 3_600_000,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendars')
      .values({
        id: calendarId,
        connection_id: connection.id,
        external_id: account,
        name: account,
        access_role: 'owner',
        time_zone: 'UTC',
      })
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calendarId })
      .where('user_id', '=', userId)
      .execute()
    return connection.id
  }
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('event_types').execute()
    await db.deleteFrom('calendar_connections').execute()
    provider = fakeGoogle()
    deps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => NOW,
    }
    calA = '00000000-0000-4000-8000-000000000001'
    calB = '00000000-0000-4000-8000-000000000002'
    connectionA = await connect(a.user.id, calA, 'account-a')
    await connect(b.user.id, calB, 'account-b')
  })
  async function booking(hosts = [a.user.id], eventTypeId: string | null = null) {
    return f.booking(a.organization.id, hosts, '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z', {
      eventTypeId,
    })
  }
  async function notify(bookingId: string) {
    await db
      .transaction()
      .execute((trx) => calendarBookingNotifier({ enqueue: async () => null })(trx, { bookingId }))
  }
  const mappings = () =>
    db.selectFrom('booking_calendar_events').select(['booking_id', 'calendar_id']).execute()
  const targets = () =>
    db.selectFrom('booking_calendar_targets').select(['user_id', 'calendar_id']).execute()
  const imports = () => provider.calls.filter((call) => call.url.pathname.endsWith('/import'))

  it.each(['needs_reauth', 'permissions_missing'] as const)(
    'continues to later hosts after one host has %s',
    async (error) => {
      const id = await booking([a.user.id, b.user.id])
      await notify(id)
      if (error === 'needs_reauth')
        await db
          .updateTable('calendar_connections')
          .set({ status: 'needs_reauth' })
          .where('id', '=', connectionA)
          .execute()
      else
        await db
          .updateTable('calendar_connections')
          .set({ scopes: [] })
          .where('id', '=', connectionA)
          .execute()
      await expect(writeBookingCalendar(deps, id)).resolves.toBeUndefined()
      expect(await mappings()).toEqual([{ booking_id: id, calendar_id: calB }])
      expect(imports()).toHaveLength(1)
      expect(imports()[0]?.url.pathname).toContain('account-b')
    },
  )
  it('continues to later hosts before rethrowing retryable provider failures', async () => {
    const id = await booking([a.user.id, b.user.id])
    await notify(id)
    const original = provider.client.findEvent
    vi.spyOn(provider.client, 'findEvent').mockImplementation(async (...args) => {
      if (args[1] === 'account-a') throw new GoogleCalendarError('provider_unavailable')
      return original(...args)
    })
    await expect(writeBookingCalendar(deps, id)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(await mappings()).toEqual([{ booking_id: id, calendar_id: calB }])
  })
  it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'forbidden'])(
    'runs a real writeback job for a Google 403 %s without silently losing the calendar copy',
    async (reason) => {
      // A prior parameter may have left a deliberately delayed retry in this file's DB.
      await database.pool
        .query(
          "DELETE FROM pgboss.job WHERE name IN ('booking-calendar','booking-calendar-recover')",
        )
        .catch((error: { code?: string }) => {
          if (error.code !== '42P01') throw error
        })
      const id = await booking()
      await notify(id)
      provider.controls.eventHook = async () =>
        Response.json({ error: { errors: [{ reason }] } }, { status: 403 })
      const jobs = createJobs({
        connectionString: database.url,
        definitions: [
          bookingCalendarJob(deps),
          bookingCalendarRecoveryJob(
            deps,
            (bookingId, trx): Promise<unknown> =>
              jobs.enqueue(
                'booking-calendar',
                { bookingId },
                { singletonKey: bookingId, transaction: trx },
              ),
            (connectionId, after): Promise<unknown> =>
              jobs.enqueue(
                'booking-calendar-recover',
                { connectionId, after },
                { singletonKey: connectionId },
              ),
          ),
        ],
        work: true,
        migrate: true,
        maxConnections: 2,
        pollingIntervalSeconds: 0.5,
        log: () => {},
      })
      deps.enqueueWritebackRecovery = (connectionId, trx) =>
        jobs.enqueue(
          'booking-calendar-recover',
          { connectionId },
          { singletonKey: connectionId, transaction: trx },
        )
      try {
        await jobs.start()
        const jobId = await jobs.enqueue(
          'booking-calendar',
          { bookingId: id },
          { singletonKey: id },
        )
        const retryable = reason !== 'forbidden'
        await vi.waitFor(
          async () => {
            const row = await database.pool.query(
              'SELECT state, retry_count, retry_limit, retry_backoff, start_after > now() AS delayed FROM pgboss.job WHERE id=$1',
              [jobId],
            )
            expect(row.rows[0]).toMatchObject({
              state: retryable ? 'retry' : 'completed',
              retry_count: 0,
              retry_limit: 12,
              retry_backoff: true,
              ...(retryable && { delayed: true }),
            })
          },
          { timeout: 5000, interval: 50 },
        )
        expect(await mappings()).toEqual([])
        expect((await listCalendarConnections(deps, a)).data[0]).toMatchObject({
          status: 'active',
          lastError: retryable ? 'provider_unavailable' : 'permissions_missing',
        })
        if (retryable) {
          // Simulate the scheduled retry becoming due after the provider recovers.
          provider.controls.eventHook = undefined
          await database.pool.query('UPDATE pgboss.job SET start_after=now() WHERE id=$1', [jobId])
          await vi.waitFor(
            async () => {
              const row = await database.pool.query(
                'SELECT state, retry_count FROM pgboss.job WHERE id=$1',
                [jobId],
              )
              expect(row.rows[0]).toMatchObject({ state: 'completed', retry_count: 1 })
            },
            { timeout: 5000, interval: 50 },
          )
          expect(await mappings()).toEqual([{ booking_id: id, calendar_id: calA }])
          expect((await listCalendarConnections(deps, a)).data[0]?.lastError).toBeNull()
        } else {
          // Unrelated successful work on the same connection (the per-minute busy sync of the
          // destination calendar, another booking's write) must not hide the refused copy.
          provider.controls.eventHook = undefined
          await db
            .updateTable('calendars')
            .set({ check_conflicts: true })
            .where('id', '=', calA)
            .execute()
          await syncGoogleCalendar(deps, calA)
          expect((await listCalendarConnections(deps, a)).data[0]?.lastError).toBe(
            'permissions_missing',
          )
          const second = await f.booking(
            a.organization.id,
            [a.user.id],
            '2026-11-02T11:00:00Z',
            '2026-11-02T11:30:00Z',
            { eventTypeId: null },
          )
          await notify(second)
          await writeBookingCalendar(deps, second)
          expect(await mappings()).toEqual([{ booking_id: second, calendar_id: calA }])
          expect((await listCalendarConnections(deps, a)).data[0]?.lastError).toBe(
            'permissions_missing',
          )
          // Reconnecting the same account clears the error and queues the recovery pass,
          // which writes the copy that was refused.
          provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
          provider.controls.identity = {
            sub: 'account-a',
            email: 'account-a@example.com',
            email_verified: true,
          }
          provider.controls.pages = [
            { items: [{ id: 'account-a', summary: 'account-a', accessRole: 'owner' }] },
          ]
          // The host signs in to reconnect: the fixture session must still be valid at NOW.
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(NOW + 86_400_000) })
            .where('id', '=', a.sessionId)
            .execute()
          const started = await beginGoogleConnection(deps, a, 'sync')
          const state = new URL(started.authorizationUrl).searchParams.get('state') as string
          expect(
            await finishGoogleConnection(
              deps,
              a,
              new URLSearchParams({ state, code: 'fake-authorization-code' }),
            ),
          ).toBe('connected')
          expect((await listCalendarConnections(deps, a)).data[0]).toMatchObject({
            id: connectionA,
            status: 'active',
            lastError: null,
          })
          const recovery = await database.pool.query(
            "SELECT data FROM pgboss.job WHERE name='booking-calendar-recover' AND singleton_key=$1",
            [connectionA],
          )
          expect(recovery.rows).toEqual([{ data: { connectionId: connectionA } }])
          await vi.waitFor(
            async () => {
              expect(
                (await mappings()).sort((x, y) => x.booking_id.localeCompare(y.booking_id)),
              ).toEqual(
                [
                  { booking_id: id, calendar_id: calA },
                  { booking_id: second, calendar_id: calA },
                ].sort((x, y) => x.booking_id.localeCompare(y.booking_id)),
              )
            },
            { timeout: 10_000, interval: 50 },
          )
          expect((await listCalendarConnections(deps, a)).data[0]?.lastError).toBeNull()
        }
      } finally {
        await jobs.stop()
      }
    },
    30_000,
  )
  it('bounds a stalled host attempt so a healthy later host still receives its copy', async () => {
    const id = await booking([a.user.id, b.user.id])
    await notify(id)
    const outer = new AbortController()
    const deadlines: AbortController[] = []
    const durations: number[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      durations.push(milliseconds)
      const controller = new AbortController()
      deadlines.push(controller)
      return controller.signal
    })
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let stalledSignal: AbortSignal | undefined
    let healthySignal: AbortSignal | undefined
    const find = provider.client.findEvent
    vi.spyOn(provider.client, 'findEvent').mockImplementation(async (...args) => {
      if (args[1] === 'account-a') {
        stalledSignal = args[3]
        started()
        await new Promise<void>((_resolve, reject) => {
          args[3].addEventListener(
            'abort',
            () => reject(new GoogleCalendarError('provider_unavailable')),
            { once: true },
          )
        })
      }
      healthySignal = args[3]
      expect(healthySignal.aborted).toBe(false)
      return find(...args)
    })
    const imported = vi.spyOn(provider.client, 'importEvent')
    const pending = writeBookingCalendar(deps, id, outer.signal).catch((error) => error)
    await entered
    try {
      expect(stalledSignal).not.toBe(outer.signal)
      expect(deadlines).toHaveLength(1)
      expect(durations).toEqual([10_000])
      deadlines[0]?.abort()
      expect(await pending).toMatchObject({ code: 'provider_unavailable' })
      expect(outer.signal.aborted).toBe(false)
      expect(await mappings()).toEqual([{ booking_id: id, calendar_id: calB }])
      expect(imported).toHaveBeenCalledOnce()
      expect(imported.mock.calls[0]?.[3]).toBe(healthySignal)
      expect(healthySignal).not.toBe(stalledSignal)
      expect(deadlines).toHaveLength(2)
    } finally {
      outer.abort()
      await pending
    }
  })
  it('uses the target deadline for token refresh, event lookup, import and cancellation update', async () => {
    const id = await booking()
    await notify(id)
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    await db
      .updateTable('calendar_connections')
      .set({
        credentials: encryptCredential(
          calendarEncryptionKey(TEST_CALENDAR_KEY),
          `google:${a.user.id}:account-a`,
          JSON.stringify({
            accessToken: 'fake-expired',
            refreshToken: 'fake-refresh',
            expiresAt: NOW - 1,
          }),
        ),
      })
      .where('id', '=', connectionA)
      .execute()
    const outer = new AbortController().signal
    const refresh = vi.spyOn(provider.client, 'refresh')
    const find = vi.spyOn(provider.client, 'findEvent')
    const imported = vi.spyOn(provider.client, 'importEvent')
    const update = vi.spyOn(provider.client, 'updateEvent')
    await writeBookingCalendar(deps, id, outer)
    const first = find.mock.calls[0]?.[3]
    expect(first).not.toBe(outer)
    expect(refresh.mock.calls[0]?.[1]).toBe(first)
    expect(imported.mock.calls[0]?.[3]).toBe(first)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(NOW) })
      .where('id', '=', id)
      .execute()
    await writeBookingCalendar(deps, id, outer)
    const second = find.mock.calls[1]?.[3]
    expect(second).not.toBe(outer)
    expect(second).not.toBe(first)
    expect(refresh.mock.calls[1]?.[1]).toBe(second)
    expect(update.mock.calls[0]?.[5]).toBe(second)
  })
  it('aggregates retryable failures only after attempting every host', async () => {
    const id = await booking([a.user.id, b.user.id])
    await notify(id)
    const find = vi
      .spyOn(provider.client, 'findEvent')
      .mockRejectedValue(new GoogleCalendarError('provider_unavailable'))
    const error = await writeBookingCalendar(deps, id).catch((error) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toHaveLength(2)
    expect(find).toHaveBeenCalledTimes(2)
  })
  it.each(['profile', 'override'] as const)(
    'refuses a foreign owned %s destination before targeting or writing',
    async (source) => {
      let eventType: string | null = null
      if (source === 'profile')
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: calB })
          .where('user_id', '=', a.user.id)
          .execute()
      else {
        eventType = await f.eventType(a.organization.id, a.user.id, {})
        await db
          .updateTable('event_type_hosts')
          .set({ destination_calendar_id: calB })
          .where('event_type_id', '=', eventType)
          .execute()
      }
      const id = await booking([a.user.id], eventType)
      await notify(id)
      expect(await targets()).toEqual([])
      await writeBookingCalendar(deps, id)
      expect(imports()).toHaveLength(0)
    },
  )
  it('refuses a forged target whose calendar belongs to another user', async () => {
    const id = await booking([a.user.id, b.user.id])
    await db
      .insertInto('booking_calendar_targets')
      .values({ root_booking_id: id, user_id: a.user.id, calendar_id: calB })
      .execute()
    await writeBookingCalendar(deps, id)
    expect(imports()).toHaveLength(0)
    expect(await mappings()).toEqual([])
  })
  it('rechecks owner access after a destination has already been recorded', async () => {
    const id = await booking()
    await notify(id)
    await db
      .updateTable('calendars')
      .set({ access_role: 'writer' })
      .where('id', '=', calA)
      .execute()
    await writeBookingCalendar(deps, id)
    expect(imports()).toHaveLength(0)
    expect(await mappings()).toEqual([])
  })
  it('refuses a directly inserted non-owner destination before recording a target', async () => {
    await db
      .updateTable('calendars')
      .set({ access_role: 'writer' })
      .where('id', '=', calA)
      .execute()
    const id = await booking()
    await notify(id)
    expect(await targets()).toEqual([])
    await writeBookingCalendar(deps, id)
    expect(imports()).toHaveLength(0)
  })
  it('requires sync scopes before recording a destination target', async () => {
    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['openid', 'email'] })
      .where('id', '=', connectionA)
      .execute()
    const id = await booking()
    await notify(id)
    expect(await targets()).toEqual([])
  })
  it('cancels the existing event when a host leaves the latest booking', async () => {
    const id = await booking()
    await notify(id)
    await writeBookingCalendar(deps, id)
    await db
      .deleteFrom('booking_hosts')
      .where('booking_id', '=', id)
      .where('user_id', '=', a.user.id)
      .execute()
    await writeBookingCalendar(deps, id)
    expect([...provider.controls.storedEvents.values()]).toMatchObject([{ status: 'cancelled' }])
  })
  it('dispatches busy sync only for active connections', async () => {
    await db.updateTable('calendars').set({ check_conflicts: true }).execute()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connectionA)
      .execute()
    const enqueue = vi.fn(async () => {})
    await calendarDispatchJob(deps, enqueue).handler(
      {},
      { id: 'fake-job', attempt: 1, signal: new AbortController().signal },
    )
    expect(enqueue.mock.calls).toEqual([[calB]])
  })
  it('retains destinations chosen during reauthorization and recovers their missing copies', async () => {
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connectionA)
      .execute()
    const id = await booking()
    await notify(id)
    expect(await targets()).toEqual([{ user_id: a.user.id, calendar_id: calA }])
    await writeBookingCalendar(deps, id)
    expect(await mappings()).toEqual([])
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active' })
      .where('id', '=', connectionA)
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: null })
      .where('user_id', '=', a.user.id)
      .execute()
    const enqueue = vi.fn(async (_id: string, trx: Db) => {
      expect(trx.isTransaction).toBe(true)
    })
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([id])
    await writeBookingCalendar(deps, id)
    expect(await mappings()).toEqual([{ booking_id: id, calendar_id: calA }])
    enqueue.mockClear()
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('preserves an existing target when the current destination changes on the recovered account', async () => {
    const id = await booking()
    await notify(id)
    const otherCalendar = '00000000-0000-4000-8000-000000000003'
    await db
      .insertInto('calendars')
      .values({
        id: otherCalendar,
        connection_id: connectionA,
        external_id: 'replacement-calendar',
        name: 'Replacement',
        access_role: 'owner',
      })
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: otherCalendar })
      .where('user_id', '=', a.user.id)
      .execute()
    await recoverBookingCalendarPage(deps, connectionA, undefined, async () => {})
    expect(await targets()).toEqual([{ user_id: a.user.id, calendar_id: calA }])
  })
  it('does not recover a recorded target until the account has sync scopes again', async () => {
    const id = await booking()
    await notify(id)
    await db
      .updateTable('calendar_connections')
      .set({ scopes: ['openid', 'email'] })
      .where('id', '=', connectionA)
      .execute()
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('backfills older missing targets for the reauthorized host without selecting other hosts', async () => {
    const id = await booking([a.user.id, b.user.id])
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(await targets()).toEqual([{ user_id: a.user.id, calendar_id: calA }])
    expect(enqueue).toHaveBeenCalledWith(id, expect.objectContaining({ isTransaction: true }))
  })
  it('does not recover inactive, foreign-destination, past or cancelled bookings', async () => {
    await booking()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connectionA)
      .execute()
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'active' })
      .where('id', '=', connectionA)
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calB })
      .where('user_id', '=', a.user.id)
      .execute()
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(await targets()).toEqual([])
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: calA })
      .where('user_id', '=', a.user.id)
      .execute()
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(NOW) })
      .execute()
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('skips past bookings and hosts removed before recovery', async () => {
    const id = await booking()
    await notify(id)
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(
      { ...deps, now: () => NOW + 3 * 86_400_000 },
      connectionA,
      undefined,
      enqueue,
    )
    expect(enqueue).not.toHaveBeenCalled()
    await db.deleteFrom('booking_hosts').where('booking_id', '=', id).execute()
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('recovers only the latest booking in a chain and retains its original destination', async () => {
    const root = await booking()
    await notify(root)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(NOW) })
      .where('id', '=', root)
      .execute()
    const next = await booking()
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: root })
      .where('id', '=', next)
      .execute()
    await db
      .updateTable('profiles')
      .set({ destination_calendar_id: null })
      .where('user_id', '=', a.user.id)
      .execute()
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith(root, expect.objectContaining({ isTransaction: true }))
    expect(await targets()).toEqual([{ user_id: a.user.id, calendar_id: calA }])
  })
  it('does not grant a second create authority to automatic conference bookings', async () => {
    const id = await booking()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: a.organization.id,
        organizer_user_id: a.user.id,
      })
      .execute()
    const enqueue = vi.fn(async () => {})
    await recoverBookingCalendarPage(deps, connectionA, undefined, enqueue)
    expect(enqueue).not.toHaveBeenCalled()
    expect(await targets()).toEqual([])
  })
  it('rolls back recovered targets when the durable enqueue fails', async () => {
    await booking()
    await expect(
      recoverBookingCalendarPage(deps, connectionA, undefined, async () => {
        throw new Error('queue unavailable')
      }),
    ).rejects.toThrow('queue unavailable')
    expect(await targets()).toEqual([])
  })
  it('normalizes an explicit exhausted-job retry to the root and cancels a departed host copy', async () => {
    const root = await booking()
    await notify(root)
    await writeBookingCalendar(deps, root)
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: new Date(NOW) })
      .where('id', '=', root)
      .execute()
    const next = await booking([b.user.id])
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: root })
      .where('id', '=', next)
      .execute()
    const enqueue = vi.fn(async () => null)
    await redispatchBookingCalendar(db, { enqueue }, next)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith(
      'booking-calendar',
      { bookingId: root },
      {
        transaction: expect.objectContaining({ isTransaction: true }),
        singletonKey: root,
      },
    )
    await writeBookingCalendar(deps, root)
    expect([...provider.controls.storedEvents.values()]).toMatchObject([{ status: 'cancelled' }])
  })
  it('bounds each explicit recovery page and continues past the first 100 bookings', async () => {
    for (let n = 0; n < 101; n++)
      await f.booking(
        a.organization.id,
        [a.user.id],
        new Date(NOW + (24 + n) * 3_600_000).toISOString(),
        new Date(NOW + (24 + n) * 3_600_000 + 1_800_000).toISOString(),
      )
    const enqueue = vi.fn(async () => {})
    const continuation = vi.fn(async (_connectionId: string, _after: string) => {})
    const job = bookingCalendarRecoveryJob(deps, enqueue, continuation)
    const run = { id: 'fake-job', attempt: 1, signal: new AbortController().signal }
    await job.handler({ connectionId: connectionA }, run)
    expect(enqueue).toHaveBeenCalledTimes(100)
    expect(continuation).toHaveBeenCalledOnce()
    const after = continuation.mock.calls[0]?.[1] as string | undefined
    expect(after).toBeTypeOf('string')
    enqueue.mockClear()
    await job.handler({ connectionId: connectionA, after }, run)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(continuation).toHaveBeenCalledOnce()
    expect(job.schedule).toBeUndefined()
    expect(job.retry?.limit).toBe(5)
  })
})
