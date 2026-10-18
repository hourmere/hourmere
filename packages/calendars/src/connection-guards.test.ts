import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPublicBooking } from '../../scheduling/src/bookings.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import {
  beginGoogleConnection,
  type CalendarDeps,
  finishGoogleConnection,
  lockUser,
  refreshGoogleCalendars,
  refreshMicrosoftCalendars,
} from './index.ts'
import { calendarTestSession, fakeGoogle, fakeMicrosoft, TEST_CALENDAR_KEY } from './testing.ts'

const gate = () => {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
describe.skipIf(!process.env.DATABASE_URL)('calendar connection acceptance guards', () => {
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
    const provider = fakeGoogle()
    const deps: CalendarDeps = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
    }
    const begin = async () => {
      const result = await beginGoogleConnection(deps, owner)
      return new URL(result.authorizationUrl).searchParams.get('state') as string
    }
    const finish = (state: string, code = 'synthetic-code') =>
      finishGoogleConnection(deps, owner, new URLSearchParams({ state, code }))
    const connect = async () => {
      expect(await finish(await begin())).toBe('connected')
      return db
        .selectFrom('calendar_connections')
        .select('id')
        .where('user_id', '=', owner.user.id)
        .executeTakeFirstOrThrow()
    }
    return { owner, provider, deps, begin, finish, connect }
  }

  it('rechecks session expiry after the callback provider work and before saving', async () => {
    const s = await setup()
    const state = await s.begin()
    const entered = gate(),
      resume = gate()
    s.provider.controls.listHook = async () => {
      entered.release()
      await resume.promise
      return Response.json(s.provider.controls.pages[0])
    }
    const callback = s.finish(state).catch((error: unknown) => error)
    await entered.promise
    try {
      await db
        .updateTable('auth.session')
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where('id', '=', s.owner.sessionId)
        .execute()
    } finally {
      resume.release()
    }
    expect(await callback).toMatchObject({ code: 'session_required' })
    expect(
      await db
        .selectFrom('calendar_connections')
        .select('id')
        .where('user_id', '=', s.owner.user.id)
        .execute(),
    ).toHaveLength(0)
  })

  it('requires the final transaction session to still exist independently of OAuth state cleanup', async () => {
    const s = await setup()
    await db.deleteFrom('auth.session').where('id', '=', s.owner.sessionId).execute()
    await expect(
      db.transaction().execute((trx) => lockUser(trx, s.owner, Date.now())),
    ).rejects.toMatchObject({ code: 'session_required' })
  })

  it.each(['synthetic code', 'synthetic\tcode', 'synthetic\ncode'])(
    'consumes whitespace authorization codes before provider work: %j',
    async (code) => {
      const s = await setup()
      const state = await s.begin()
      expect(await s.finish(state, code)).toBe('provider_unavailable')
      expect(s.provider.calls).toHaveLength(0)
      expect(await s.finish(state)).toBe('invalid_state')
    },
  )

  it('short-circuits list refresh for a non-active connection', async () => {
    const s = await setup(),
      connection = await s.connect()
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connection.id)
      .execute()
    s.provider.calls.length = 0
    await expect(refreshGoogleCalendars(s.deps, s.owner, connection.id)).rejects.toMatchObject({
      code: 'google_calendar_needs_reauth',
    })
    expect(s.provider.calls).toHaveLength(0)
  })

  it('queues writeback compensation in the successful reauthorization transaction', async () => {
    const s = await setup()
    const calls: { id: string; transaction: boolean }[] = []
    s.deps.enqueueWritebackRecovery = async (id, trx) => {
      calls.push({ id, transaction: trx.isTransaction })
    }
    const connection = await s.connect()
    expect(calls).toHaveLength(0)
    await db
      .updateTable('calendar_connections')
      .set({ status: 'needs_reauth' })
      .where('id', '=', connection.id)
      .execute()
    expect(await s.finish(await s.begin())).toBe('connected')
    expect(calls).toEqual([{ id: connection.id, transaction: true }])
    expect(
      (
        await db
          .selectFrom('calendar_connections')
          .select('status')
          .where('id', '=', connection.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active')
  })

  it('logs only the fixed OAuth error enum when callback configuration fails', async () => {
    const s = await setup()
    const state = await s.begin()
    s.provider.controls.tokenStatus = 401
    s.provider.controls.token = {
      error: 'invalid_client',
      error_description: 'synthetic-private-provider-description',
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await s.finish(state)).toBe('provider_unavailable')
      expect(log.mock.calls).toEqual([
        ['Calendar OAuth token exchange failed:', 'google', 'invalid_client'],
      ])
    } finally {
      log.mockRestore()
    }
  })

  it.each(['google', 'microsoft'] as const)(
    'allows public bookings while a %s calendar-list HTTP call is paused',
    async (provider) => {
      const s = await setup()
      const microsoft = fakeMicrosoft()
      s.deps.microsoft = { client: microsoft.client, encryptionKey: TEST_CALENDAR_KEY }
      const connection = provider === 'google' ? await s.connect() : undefined
      if (!connection) {
        const { beginMicrosoftConnection, finishMicrosoftConnection } = await import('./index.ts')
        const state = new URL(
          (await beginMicrosoftConnection(s.deps, s.owner)).authorizationUrl,
        ).searchParams.get('state') as string
        expect(
          await finishMicrosoftConnection(
            s.deps,
            s.owner,
            new URLSearchParams({ state, code: 'synthetic-code' }),
          ),
        ).toBe('connected')
      }
      const id =
        connection?.id ??
        (
          await db
            .selectFrom('calendar_connections')
            .select('id')
            .where('user_id', '=', s.owner.user.id)
            .executeTakeFirstOrThrow()
        ).id
      const f = createFixtures(db)
      const handle = `refresh-${randomUUID().slice(0, 8)}`
      await db
        .insertInto('profiles')
        .values({ user_id: s.owner.user.id, handle, time_zone: 'UTC' })
        .execute()
      await f.schedule(s.owner.user.id, { timeZone: 'UTC' })
      await f.eventType(s.owner.organization.id, s.owner.user.id, { slug: 'call' })
      const entered = gate(),
        resume = gate()
      const fake = provider === 'google' ? s.provider : microsoft
      fake.controls.listHook = async () => {
        entered.release()
        await resume.promise
        return Response.json(fake.controls.pages[0])
      }
      const refresh = (provider === 'google' ? refreshGoogleCalendars : refreshMicrosoftCalendars)(
        s.deps,
        s.owner,
        id,
      )
      await entered.promise
      const book = createPublicBooking(
        { db, now: () => Temporal.Instant.from('2026-11-01T12:00Z') },
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
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
        ])
      } finally {
        resume.release()
        await refresh
        await book
      }
      expect(completed).toBe(true)
    },
  )

  it('serializes list refresh on the connection row while the owner lock stays compatible', async () => {
    const s = await setup(),
      connection = await s.connect()
    s.deps.now = () => Date.now() + 3_600_000
    const entered = gate(),
      resume = gate(),
      secondEntered = gate()
    let calls = 0
    const refreshToken = s.provider.client.refresh
    vi.spyOn(s.provider.client, 'refresh').mockImplementation(async (...args) => {
      if (++calls === 1) {
        entered.release()
        await resume.promise
      } else secondEntered.release()
      return refreshToken(...args)
    })
    const first = refreshGoogleCalendars(s.deps, s.owner, connection.id)
    await entered.promise
    const second = refreshGoogleCalendars(s.deps, s.owner, connection.id)
    let overtook = false
    try {
      overtook = await Promise.race([
        secondEntered.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ])
    } finally {
      resume.release()
      await Promise.all([first, second])
    }
    expect(overtook).toBe(false)
    expect(calls).toBe(2)
  })
})
