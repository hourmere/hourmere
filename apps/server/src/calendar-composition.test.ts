import { createHmac, randomBytes } from 'node:crypto'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { calendarTestSession, fakeGoogle } from '../../../packages/calendars/src/testing.ts'
import { startServer } from './server.ts'

interface GoogleComposition {
  database: TestDatabase
  db: Db
  owner: Awaited<ReturnType<typeof calendarTestSession>>
  connectionId: string
  calendarId: string
  reconnect: () => Promise<void>
}

async function withGoogleServer(
  database: TestDatabase,
  role: 'web' | 'all',
  run: (composition: GoogleComposition) => Promise<void>,
) {
  const logs = (['log', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  )
  const realFetch = globalThis.fetch
  const provider = fakeGoogle()
  provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
  vi.stubGlobal('fetch', ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (
      [
        'https://oauth2.googleapis.com',
        'https://openidconnect.googleapis.com',
        'https://www.googleapis.com',
      ].includes(url.origin)
    )
      return provider.request(input, init)
    if (url.hostname !== '127.0.0.1') throw new Error('Unexpected external request')
    return realFetch(input, init)
  }) satisfies typeof fetch)
  try {
    const db = createDb(database.pool)
    const owner = await calendarTestSession(db)
    const session = await db
      .selectFrom('auth.session')
      .select('token')
      .where('id', '=', owner.sessionId)
      .executeTakeFirstOrThrow()
    const secret = randomBytes(32).toString('base64')
    const signature = createHmac('sha256', secret).update(session.token).digest('base64')
    const server = await startServer({
      DATABASE_URL: database.url,
      BETTER_AUTH_SECRET: secret,
      PORT: '0',
      PUBLIC_URL: 'http://localhost',
      HOURMERE_ROLE: role,
      GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-google-client',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-google-secret',
      CALENDAR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    })
    try {
      const request = (path: string, body?: object) =>
        fetch(`http://127.0.0.1:${server.port}${path}`, {
          method: body ? 'POST' : 'GET',
          redirect: 'manual',
          headers: {
            cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      const reconnect = async () => {
        const authorize = await request('/api/v1/calendar-connections/google/authorize', {
          access: 'sync',
        })
        expect(authorize.status).toBe(200)
        const { authorizationUrl } = (await authorize.json()) as { authorizationUrl: string }
        const state = new URL(authorizationUrl).searchParams.get('state') as string
        const callback = await request(
          `/api/calendar/google/callback?${new URLSearchParams({ state, code: 'synthetic-code' })}`,
        )
        expect(callback.status).toBe(303)
        expect(callback.headers.get('location')).toBe('/app/calendars?connection=connected')
        await callback.body?.cancel()
      }
      // Establish the account first: recovery must be exercised by reconnecting its same ID.
      await reconnect()
      const connection = await db
        .selectFrom('calendar_connections')
        .select('id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirstOrThrow()
      const calendar = await db
        .selectFrom('calendars')
        .select('id')
        .where('connection_id', '=', connection.id)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('profiles')
        .values({
          user_id: owner.user.id,
          handle: `recovery-${owner.user.id.slice(0, 8)}`,
          time_zone: 'UTC',
          destination_calendar_id: calendar.id,
        })
        .execute()
      await db
        .updateTable('calendar_connections')
        .set({ status: 'needs_reauth', last_error: 'needs_reauth' })
        .where('id', '=', connection.id)
        .execute()
      expect(
        (
          await database.pool.query(
            "SELECT id FROM pgboss.job WHERE name='booking-calendar-recover' AND singleton_key=$1",
            [connection.id],
          )
        ).rows,
      ).toEqual([])
      await run({
        database,
        db,
        owner,
        connectionId: connection.id,
        calendarId: calendar.id,
        reconnect,
      })
    } finally {
      await server.close()
    }
  } finally {
    vi.unstubAllGlobals()
    for (const log of logs) log.mockRestore()
  }
}

describe.skipIf(!process.env.DATABASE_URL)('calendar server composition', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await database?.drop()
  })

  it('enables Microsoft authorization and its callback on the real web server', async () => {
    const logs = (['log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const secret = randomBytes(32).toString('base64')
    try {
      const db = createDb(database.pool)
      const owner = await calendarTestSession(db)
      const session = await db
        .selectFrom('auth.session')
        .select('token')
        .where('id', '=', owner.sessionId)
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(session.token).digest('base64')
      const server = await startServer({
        DATABASE_URL: database.url,
        BETTER_AUTH_SECRET: secret,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        HOURMERE_ROLE: 'web',
        GOOGLE_CALENDAR_CLIENT_ID: 'synthetic-google-client',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'synthetic-google-secret',
        MICROSOFT_CALENDAR_CLIENT_ID: 'synthetic-microsoft-client',
        MICROSOFT_CALENDAR_CLIENT_SECRET: 'synthetic-microsoft-secret',
        CALENDAR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      })
      try {
        const request = (path: string, method = 'GET') =>
          fetch(`http://127.0.0.1:${server.port}${path}`, {
            method,
            redirect: 'manual',
            headers: {
              cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`,
              origin: 'http://localhost',
              'content-type': 'application/json',
            },
            ...(method === 'POST' ? { body: '{}' } : {}),
          })
        const list = await request('/api/v1/calendar-connections')
        expect(list.status).toBe(200)
        expect(await list.json()).toMatchObject({ googleEnabled: true, microsoftEnabled: true })
        const authorize = await request('/api/v1/calendar-connections/microsoft/authorize', 'POST')
        expect(authorize.status).toBe(200)
        const { authorizationUrl } = (await authorize.json()) as { authorizationUrl: string }
        expect(new URL(authorizationUrl).host).toBe('login.microsoftonline.com')
        const callback = await request('/api/calendar/microsoft/callback?state=x&code=y')
        expect(callback.status).toBe(303)
        expect(callback.headers.get('location')).toBe(
          '/app/calendars?connection=invalid_state&provider=microsoft',
        )
      } finally {
        await server.close()
      }
    } finally {
      for (const log of logs) log.mockRestore()
    }
  })

  it('durably queues the registered recovery job after Google reconnection through the web server', async () => {
    await withGoogleServer(database, 'web', async ({ database, db, connectionId, reconnect }) => {
      await reconnect()
      const jobs = await database.pool.query(
        "SELECT name, singleton_key, data, state FROM pgboss.job WHERE name='booking-calendar-recover' AND singleton_key=$1",
        [connectionId],
      )
      expect(jobs.rows).toEqual([
        {
          name: 'booking-calendar-recover',
          singleton_key: connectionId,
          data: { connectionId },
          state: 'created',
        },
      ])
      expect(
        await db
          .selectFrom('calendar_connections')
          .select(['id', 'status', 'last_error'])
          .where('id', '=', connectionId)
          .execute(),
      ).toEqual([{ id: connectionId, status: 'active', last_error: null }])
    })
  })

  it('runs both recovery pages and queues all 101 missing bookings in the all role', async () => {
    await withGoogleServer(
      database,
      'all',
      async ({ database, db, owner, connectionId, calendarId, reconnect }) => {
        const fixtures = createFixtures(db)
        const bookings: string[] = []
        const tomorrow = Date.now() + 86_400_000
        for (let n = 0; n < 101; n++) {
          const start = tomorrow + n * 3_600_000
          bookings.push(
            await fixtures.booking(
              owner.organization.id,
              [owner.user.id],
              new Date(start).toISOString(),
              new Date(start + 1_800_000).toISOString(),
            ),
          )
        }
        const sortedBookings = bookings.toSorted()
        await reconnect()
        const recoveryJobs = () =>
          database.pool.query(
            "SELECT singleton_key, data, state FROM pgboss.job WHERE name='booking-calendar-recover' AND singleton_key=$1 ORDER BY created_on, id",
            [connectionId],
          )
        await expect
          .poll(async () => (await recoveryJobs()).rows, { timeout: 12_000, interval: 50 })
          .toEqual([
            { singleton_key: connectionId, data: { connectionId }, state: 'completed' },
            {
              singleton_key: connectionId,
              data: { connectionId, after: sortedBookings[99] },
              state: 'completed',
            },
          ])
        const writes = await database.pool.query(
          "SELECT singleton_key, data FROM pgboss.job WHERE name='booking-calendar' ORDER BY singleton_key",
        )
        expect(writes.rows).toEqual(
          sortedBookings.map((bookingId) => ({
            singleton_key: bookingId,
            data: { bookingId },
          })),
        )
        expect(
          await db
            .selectFrom('booking_calendar_targets')
            .select('root_booking_id')
            .where('calendar_id', '=', calendarId)
            .orderBy('root_booking_id')
            .execute(),
        ).toEqual(sortedBookings.map((root_booking_id) => ({ root_booking_id })))
      },
    )
  }, 30_000)
})
