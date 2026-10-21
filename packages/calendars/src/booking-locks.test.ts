import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPublicBooking, createPublicTeamBooking } from '../../scheduling/src/bookings.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { calendarBookingNotifier } from './booking-events.ts'
import { calendarEncryptionKey, encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  disconnectCalendar,
  finishGoogleConnection,
  readTokens,
  tokenAad,
} from './index.ts'
import { syncGoogleCalendar, useGoogleConnection } from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const url = process.env.DATABASE_URL
const now = Date.parse('2026-11-01T12:00Z')
const gate = () => {
  let release: () => void = () => {}
  const reached = new Promise<void>((resolve) => {
    release = resolve
  })
  return { reached, release: () => release() }
}

describe.skipIf(!url)('calendar connection and booking lock compatibility', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(url as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  async function setup() {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const owner = await calendarTestSession(db)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: new Date('2028-01-01T00:00Z') })
      .where('id', '=', owner.sessionId)
      .execute()
    const provider = fakeGoogle()
    provider.controls.token.scope = GOOGLE_CALENDAR_SYNC_SCOPES.join(' ')
    const deps: CalendarDeps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now,
    }
    const key = calendarEncryptionKey(TEST_CALENDAR_KEY)
    const handle = `lock-${randomUUID().slice(0, 8)}`
    await db
      .insertInto('profiles')
      .values({ user_id: owner.user.id, handle, time_zone: 'UTC' })
      .execute()
    const connect = async (account = 'google-account-1', expired = true) => {
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: owner.user.id,
          provider: 'google',
          external_account_id: account,
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
          credentials: encryptCredential(
            key,
            tokenAad(owner.user.id, account),
            JSON.stringify({
              accessToken: 'initial-access',
              refreshToken: 'initial-refresh',
              expiresAt: now + (expired ? -1 : 3_600_000),
            }),
          ),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const day = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO('UTC')
        .toPlainDate()
        .toZonedDateTime('UTC')
        .toInstant()
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: connection.id,
          external_id: `calendar-${account}`,
          name: 'Synthetic',
          access_role: 'owner',
          time_zone: 'UTC',
          check_conflicts: true,
          last_synced_at: new Date(now),
          sync_state: JSON.stringify({
            version: 2,
            timeZone: 'UTC',
            token: 'synthetic-cursor',
            start: day.subtract({ hours: 72 }).toString(),
            end: day.add({ hours: 403 * 24 }).toString(),
          }),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { connectionId: connection.id, calendarId: calendar.id, account }
    }
    return { owner, provider, deps, key, connect, handle }
  }
  async function blockedBy(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await owned.pool.query<{ blocked: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
        [pid],
      )
      if (result.rows[0]?.blocked) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  const backendPid = async (trx: Db) =>
    (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]?.pid ?? 0

  it('serializes two refreshes of one connection and retains the rotated refresh token', async () => {
    const s = await setup(),
      connection = await s.connect()
    s.provider.controls.token.access_token = 'rotated-access'
    s.provider.controls.token.refresh_token = 'rotated-refresh'
    const entered = gate(),
      release = gate()
    let pid = 0
    const first = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async (trx, token) => {
        pid = await backendPid(trx)
        entered.release()
        await release.reached
        return token
      },
    )
    await entered.reached
    const second = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async (_trx, token) => token,
    )
    let blocked = false
    try {
      blocked = await blockedBy(pid)
    } finally {
      release.release()
    }
    expect(await first).toBe('rotated-access')
    expect(await second).toBe('rotated-access')
    expect(blocked).toBe(true)
    expect(
      s.provider.calls.filter((call) => call.url.href === 'https://oauth2.googleapis.com/token'),
    ).toHaveLength(1)
    const saved = await db
      .selectFrom('calendar_connections')
      .select('credentials')
      .where('id', '=', connection.connectionId)
      .executeTakeFirstOrThrow()
    expect(
      readTokens(s.key, s.owner.user.id, connection.account, saved.credentials).refreshToken,
    ).toBe('rotated-refresh')
  })

  it('locks the connection before provider work even with fresh credentials, and keeps an owner deletion lock', async () => {
    const s = await setup(),
      connection = await s.connect('google-account-1', false)
    const entered = gate(),
      release = gate()
    let pid = 0,
      secondEntered = false
    const first = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async (trx) => {
        pid = await backendPid(trx)
        entered.release()
        await release.reached
      },
    )
    await entered.reached
    const second = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async () => {
        secondEntered = true
      },
    )
    const probe = await owned.pool.connect()
    let ownerLocked = false,
      connectionLocked = false,
      enteredWhileHeld = false
    try {
      await probe.query('BEGIN')
      try {
        await probe.query('SELECT id FROM auth."user" WHERE id=$1 FOR UPDATE NOWAIT', [
          s.owner.user.id,
        ])
      } catch (error) {
        ownerLocked =
          typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03'
      } finally {
        await probe.query('ROLLBACK')
      }
      connectionLocked = await blockedBy(pid)
      enteredWhileHeld = secondEntered
    } finally {
      probe.release()
      release.release()
      await Promise.all([first, second])
    }
    expect(ownerLocked).toBe(true)
    expect(connectionLocked).toBe(true)
    expect(enteredWhileHeld).toBe(false)
    expect(s.provider.calls).toHaveLength(0)
  })

  it('permits independent connections of one owner to make progress concurrently', async () => {
    const s = await setup(),
      a = await s.connect('account-a', false),
      b = await s.connect('account-b', false)
    const firstEntered = gate(),
      secondEntered = gate(),
      release = gate()
    const first = useGoogleConnection(
      s.deps,
      a.connectionId,
      AbortSignal.timeout(10_000),
      async () => {
        firstEntered.release()
        await release.reached
      },
    )
    await firstEntered.reached
    const second = useGoogleConnection(
      s.deps,
      b.connectionId,
      AbortSignal.timeout(10_000),
      async () => {
        secondEntered.release()
        await release.reached
      },
    )
    let concurrent = false
    try {
      concurrent = await Promise.race([
        secondEntered.reached.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ])
    } finally {
      release.release()
      await Promise.all([first, second])
    }
    expect(concurrent).toBe(true)
  })

  it('keeps disconnect behind an in-flight refresh and refuses later work on the deleted connection', async () => {
    const s = await setup(),
      connection = await s.connect()
    const entered = gate(),
      release = gate()
    let pid = 0
    const refresh = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async (trx) => {
        pid = await backendPid(trx)
        entered.release()
        await release.reached
      },
    )
    await entered.reached
    const disconnected = disconnectCalendar(s.deps, s.owner, connection.connectionId)
    let blocked = false
    try {
      blocked = await blockedBy(pid)
    } finally {
      release.release()
    }
    await Promise.all([refresh, disconnected])
    expect(blocked).toBe(true)
    expect(
      await db
        .selectFrom('calendar_connections')
        .select('id')
        .where('id', '=', connection.connectionId)
        .execute(),
    ).toEqual([])
    let called = false
    await useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async () => {
        called = true
      },
    )
    expect(called).toBe(false)
  })

  it('commits a reconnect after an old refresh, without letting the old credentials overwrite it', async () => {
    const s = await setup(),
      connection = await s.connect()
    const authorization = new URL(
      (await beginGoogleConnection(s.deps, s.owner, 'sync')).authorizationUrl,
    )
    s.provider.controls.token.refresh_token = 'old-rotation'
    const entered = gate(),
      release = gate()
    let pid = 0
    const refresh = useGoogleConnection(
      s.deps,
      connection.connectionId,
      AbortSignal.timeout(10_000),
      async (trx) => {
        pid = await backendPid(trx)
        entered.release()
        await release.reached
      },
    )
    await entered.reached
    s.provider.controls.token.refresh_token = 'new-reconnection'
    const reconnect = finishGoogleConnection(
      s.deps,
      s.owner,
      new URLSearchParams({
        state: authorization.searchParams.get('state') as string,
        code: 'synthetic-code',
      }),
    )
    let blocked = false
    try {
      blocked = await blockedBy(pid)
    } finally {
      release.release()
    }
    await refresh
    expect(await reconnect).toBe('connected')
    expect(blocked).toBe(true)
    const saved = await db
      .selectFrom('calendar_connections')
      .select('credentials')
      .where('id', '=', connection.connectionId)
      .executeTakeFirstOrThrow()
    expect(
      readTokens(s.key, s.owner.user.id, connection.account, saved.credentials).refreshToken,
    ).toBe('new-reconnection')
  })

  for (const mode of ['personal', 'collective'] as const)
    it(`commits a ${mode} booking while a host busy-sync call is waiting on the network`, async () => {
      const s = await setup(),
        connection = await s.connect('google-account-1', false)
      const f = createFixtures(db)
      await f.schedule(s.owner.user.id, { timeZone: 'UTC' })
      let org = s.owner.organization.id,
        handle = s.handle
      let hostIds = [s.owner.user.id]
      if (mode === 'collective') {
        const other = await calendarTestSession(db)
        await f.schedule(other.user.id, { timeZone: 'UTC' })
        handle = `Collective-${randomUUID().slice(0, 8)}`
        org = await f.organization(handle)
        await f.member(s.owner.user.id, org, 'owner')
        await f.member(other.user.id, org)
        hostIds = [...hostIds, other.user.id]
      }
      const event = await f.eventType(org, mode === 'personal' ? s.owner.user.id : null, {
        slug: 'call',
        hosts: hostIds.map((userId) => ({ userId })),
      })
      if (mode === 'collective')
        await db
          .updateTable('event_types')
          .set({ scheduling_type: 'collective' })
          .where('id', '=', event)
          .execute()
      await db
        .updateTable('profiles')
        .set({ destination_calendar_id: connection.calendarId })
        .where('user_id', '=', s.owner.user.id)
        .execute()
      const entered = gate(),
        release = gate()
      s.provider.controls.eventHook = async () => {
        entered.release()
        await release.reached
        return Response.json({ items: [], nextSyncToken: 'after' })
      }
      const sync = syncGoogleCalendar(s.deps, connection.calendarId)
      await entered.reached
      const book = (mode === 'personal' ? createPublicBooking : createPublicTeamBooking)(
        {
          db,
          now: () => Temporal.Instant.fromEpochMilliseconds(now),
          notify: calendarBookingNotifier({ enqueue: async () => null }),
        },
        {
          handle,
          slug: 'call',
          start: Temporal.Instant.from('2026-11-02T09:00Z'),
          invitee: { name: 'Synthetic', email: 'synthetic@example.com', timeZone: 'UTC' },
        },
      )
      let completed = false
      try {
        completed = await Promise.race([
          book.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ])
      } finally {
        release.release()
        await sync
      }
      const result = await book
      expect(completed).toBe(true)
      expect(
        await db
          .selectFrom('booking_hosts')
          .select('user_id')
          .where('booking_id', '=', result.booking.id)
          .execute(),
      ).toHaveLength(hostIds.length)
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .select('calendar_id')
          .where('root_booking_id', '=', result.booking.id)
          .execute(),
      ).toHaveLength(1)
    })
})
