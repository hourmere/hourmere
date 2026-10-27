import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type BookingNotifier, cancelTeamAdminBooking } from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { teamManagementAccess } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2027-01-01T00:00Z')
const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
type Cancel = typeof cancelTeamAdminBooking
type Access = typeof teamManagementAccess

// Import changed copies without modifying source used by other workers.
async function sourceCopy<T>(path: string, before: string, after: string): Promise<T> {
  const location = new URL(path, import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.includes(before), 'mutation matches real source').toBe(true)
  const javascript = stripTypeScriptTypes(source.replace(before, after)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

describe.skipIf(!serverUrl)('team administrator cancellation service', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture(role = 'admin') {
    const manager = await createTestUser(db, 'Acting manager')
    const host = await createTestUser(db, 'Original host')
    const team = await createTestTeam(db, [
      { user: manager, role },
      { user: host, role: 'owner' },
    ])
    const other = await createTestTeam(db, [{ user: manager, role: 'owner' }])
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: manager.id,
        token: `synthetic-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: team.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const principal: Principal = { ...team.as(manager), kind: 'session', sessionId: session.id }
    const booking = await seedBooking(team.id, host.id)
    return { manager, host, team, other, principal, booking, session }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function seedBooking(organizationId: string, hostId: string) {
    return db.transaction().execute(async (trx) => {
      const booking = await trx
        .insertInto('bookings')
        .values({
          organization_id: organizationId,
          title: 'Synthetic team meeting',
          source: 'web',
          start_at: '2027-01-02T09:00Z',
          end_at: '2027-01-02T09:30Z',
          required_host_user_ids: [hostId],
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('booking_hosts')
        .values({ booking_id: booking.id, user_id: hostId })
        .execute()
      return booking
    })
  }

  function cancel(
    f: Fixture,
    options: {
      id?: string
      principal?: Principal
      expectedOrganizationId?: string
      clock?: () => Temporal.Instant
      notify?: BookingNotifier
      service?: Cancel
      access?: Access
    } = {},
  ) {
    const principal = options.principal ?? f.principal
    const access = (options.access ?? teamManagementAccess)(db, async (_c, next) => next())
    return access.write(
      principal,
      principal.organization.id,
      (trx, actor) =>
        (options.service ?? cancelTeamAdminBooking)(
          trx,
          actor,
          options.id ?? f.booking.id,
          options.clock ?? now,
          { reason: 'Schedule conflict', notify: options.notify },
        ),
      { expectedOrganizationId: options.expectedOrganizationId ?? f.team.id },
    )
  }

  const stored = (id: string) =>
    db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const records = (id: string) =>
    db.selectFrom('organization_operations').selectAll().where('booking_id', '=', id).execute()

  async function expectUnchanged(f: Fixture) {
    expect(await stored(f.booking.id)).toEqual(f.booking)
    expect(await records(f.booking.id)).toEqual([])
  }

  it.each(['owner', 'admin', 'member, admin', 'admin, owner'])(
    'allows the current exact %s role and preserves the original host',
    async (role) => {
      const f = await fixture(role)
      await cancel(f)
      expect(await stored(f.booking.id)).toMatchObject({
        status: 'cancelled',
        required_host_user_ids: [f.host.id],
        cancelled_at: new Date(now().toString()),
        cancel_reason: 'Schedule conflict',
      })
      expect(
        await db
          .selectFrom('booking_hosts')
          .select('user_id')
          .where('booking_id', '=', f.booking.id)
          .execute(),
      ).toEqual([{ user_id: f.host.id }])
      expect(await records(f.booking.id)).toMatchObject([
        { actor_user_id: f.manager.id, organization_id: f.team.id, source: 'web' },
      ])
    },
  )

  it.each(['member', 'superadmin', 'administrator', 'team-owner', 'OWNER', ''])(
    'refuses %j even when the same user owns another organization',
    async (role) => {
      const f = await fixture(role)
      await expect(cancel(f)).rejects.toMatchObject(denied)
      await expectUnchanged(f)
    },
  )

  it.each(['removed', 'unverified', 'expired', 'invalidated', 'api_key', 'oauth'])(
    'refuses a %s actor using current database facts',
    async (state) => {
      const f = await fixture()
      let principal: Principal = f.principal
      if (state === 'removed')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', f.team.id)
          .where('userId', '=', f.manager.id)
          .execute()
      if (state === 'unverified')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', f.manager.id)
          .execute()
      if (state === 'expired')
        await db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', f.session.id)
          .execute()
      if (state === 'invalidated')
        await db.deleteFrom('auth.session').where('id', '=', f.session.id).execute()
      if (state === 'api_key') principal = f.team.as(f.manager)
      if (state === 'oauth')
        principal = {
          ...f.team.as(f.manager),
          kind: 'oauth',
          oauthConsentId: randomUUID(),
          clientId: 'https://synthetic.test',
          scopes: [],
        }
      await expect(cancel(f, { principal })).rejects.toMatchObject(denied)
      await expectUnchanged(f)
    },
  )

  async function verifyTargetDenial(service: Cancel) {
    const f = await fixture()
    const personal = await seedBooking(f.manager.principal.organization.id, f.manager.id)
    const otherHost = await createTestUser(db, 'Other team host')
    const outside = await seedBooking(f.other.id, otherHost.id)
    for (const id of [randomUUID(), 'invalid', personal.id, outside.id]) {
      await expect(cancel(f, { id, service })).rejects.toMatchObject(denied)
    }
    expect((await stored(personal.id)).status).toBe('confirmed')
    expect((await stored(outside.id)).status).toBe('confirmed')
    await expect(
      cancel(f, { service, clock: () => Temporal.Instant.from('2027-01-02T09:00Z') }),
    ).rejects.toMatchObject(denied)
    await expectUnchanged(f)
    await cancel(f, { service })
    await expect(cancel(f, { service })).rejects.toMatchObject(denied)
    expect(await records(f.booking.id)).toHaveLength(1)
  }

  it('uses one denial for personal, other-team, missing, started and cancelled bookings', async () => {
    await verifyTargetDenial(cancelTeamAdminBooking)
  })

  async function verifyContext(access: Access) {
    const f = await fixture()
    for (const expectedOrganizationId of ['', 'invalid', f.other.id]) {
      await expect(cancel(f, { access, expectedOrganizationId })).rejects.toMatchObject({
        kind: 'conflict',
        code: 'organization_context_changed',
      })
      await expectUnchanged(f)
    }
    // The principal was resolved before another tab changed the actual session.
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.other.id })
      .where('id', '=', f.session.id)
      .execute()
    await expect(cancel(f, { access })).rejects.toMatchObject({
      kind: 'conflict',
      code: 'organization_context_changed',
    })
    await expectUnchanged(f)
  }

  async function verifyPersonalContext(access: Access) {
    const f = await fixture()
    const personal = f.manager.principal.organization
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: personal.id })
      .where('id', '=', f.session.id)
      .execute()
    const booking = await seedBooking(personal.id, f.manager.id)
    await expect(
      cancel(f, {
        access,
        id: booking.id,
        principal: { ...f.principal, organization: personal },
        expectedOrganizationId: personal.id,
      }),
    ).rejects.toMatchObject(denied)
    expect((await stored(booking.id)).status).toBe('confirmed')
    expect(await records(booking.id)).toEqual([])
  }

  it('refuses a personal organization even when its current session owner is verified', async () => {
    await verifyPersonalContext(teamManagementAccess)
  })

  it('binds the expected organization and the live session through the shared write check', async () => {
    await verifyContext(teamManagementAccess)
  })

  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )

  async function waiting(query: string) {
    await expect
      .poll(
        async () =>
          (
            await owned.pool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
        SELECT FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1
      ) AS waiting`,
              [query],
            )
          ).rows[0]?.waiting,
        { timeout: 3000, interval: 10 },
      )
      .toBe(true)
  }

  it('serializes controlled concurrent cancellations and repeated retries into one operation', async () => {
    const f = await fixture()
    let release = () => {}
    let reached = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      reached = resolve
    })
    let notifications = 0
    const notify: BookingNotifier = async () => {
      notifications++
      reached()
      await hold
    }
    const first = outcome(cancel(f, { notify }))
    await entered
    const second = outcome(cancel(f, { notify }))
    try {
      await waiting('%organization%for update%')
    } finally {
      release()
    }
    expect(await first).toMatchObject({ status: 'fulfilled' })
    expect(await second).toMatchObject({ status: 'rejected', reason: denied })
    await expect(cancel(f, { notify })).rejects.toMatchObject(denied)
    expect(notifications).toBe(1)
    expect(await records(f.booking.id)).toHaveLength(1)
  })

  it.each(['downgrade', 'remove', 'switch'])(
    'rechecks a concurrent %s committed while waiting for shared management locks',
    async (change) => {
      const f = await fixture()
      const client = await owned.pool.connect()
      let pending: ReturnType<typeof outcome> | undefined
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [f.team.id])
        pending = outcome(cancel(f))
        await waiting('%organization%for update%')
        if (change === 'downgrade')
          await client.query(
            'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
            ['member', f.team.id, f.manager.id],
          )
        if (change === 'remove')
          await client.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
            f.team.id,
            f.manager.id,
          ])
        if (change === 'switch')
          await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
            f.other.id,
            f.session.id,
          ])
        await client.query('COMMIT')
      } finally {
        await client.query('ROLLBACK')
        client.release()
        if (pending) await pending
      }
      expect(await pending).toMatchObject({
        status: 'rejected',
        reason: change === 'switch' ? { code: 'organization_context_changed' } : denied,
      })
      await expectUnchanged(f)
    },
  )

  it('rechecks the time after a controlled wait for the booking lock', async () => {
    const f = await fixture()
    let instant = now()
    const client = await owned.pool.connect()
    let pending: ReturnType<typeof outcome> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [f.booking.id])
      pending = outcome(cancel(f, { clock: () => instant }))
      await waiting('%bookings%for update%')
      instant = Temporal.Instant.from('2027-01-02T09:00Z')
    } finally {
      await client.query('ROLLBACK')
      client.release()
      if (pending) await pending
    }
    expect(await pending).toMatchObject({ status: 'rejected', reason: denied })
    await expectUnchanged(f)
  })

  it('keeps validation and unexpected failures distinct from target denials', async () => {
    const f = await fixture()
    const access = teamManagementAccess(db, async (_c, next) => next())
    await expect(
      access.write(
        f.principal,
        f.team.id,
        (trx, actor) =>
          cancelTeamAdminBooking(trx, actor, f.booking.id, now, { reason: 'x'.repeat(1001) }),
        { expectedOrganizationId: f.team.id },
      ),
    ).rejects.toMatchObject({ kind: 'invalid', code: 'invalid_reason' })
    const failure = new Error('synthetic outbox failure')
    await expect(
      cancel(f, {
        notify: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    await expectUnchanged(f)
  })

  it('runs unchanged access and service source copies against the real assertions', async () => {
    const copy = await sourceCopy<{ teamManagementAccess: Access }>(
      './team-management.ts',
      'allowPersonal: false',
      'allowPersonal: false',
    )
    await verifyContext(copy.teamManagementAccess)
    await verifyPersonalContext(copy.teamManagementAccess)
    const service = await sourceCopy<{ cancelTeamAdminBooking: Cancel }>(
      '../../../packages/scheduling/src/team-bookings.ts',
      "error.code === 'booking_not_found'",
      "error.code === 'booking_not_found'",
    )
    await verifyTargetDenial(service.cancelTeamAdminBooking)
  })

  it.each(['booking_not_found', 'booking_cancelled', 'booking_in_past'])(
    'detects disclosure of %s in a service source copy',
    async (code) => {
      const copy = await sourceCopy<{ cancelTeamAdminBooking: Cancel }>(
        '../../../packages/scheduling/src/team-bookings.ts',
        `error.code === '${code}'`,
        'false',
      )
      await expect(verifyTargetDenial(copy.cancelTeamAdminBooking)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it('detects missing expected-organization forwarding in the shared writer source copy', async () => {
    const copy = await sourceCopy<{ teamManagementAccess: Access }>(
      './team-management.ts',
      'options && {\n                expectedOrganizationId: options.expectedOrganizationId,\n                allowPersonal: false,\n              }',
      'undefined',
    )
    await expect(verifyContext(copy.teamManagementAccess)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects missing live-session context comparison in the shared check source copy', async () => {
    const copy = await sourceCopy<{ teamManagementAccess: Access }>(
      './team-management.ts',
      'if (context && session.activeOrganizationId?.toLowerCase() !== organization.id.toLowerCase())',
      'if (false)',
    )
    await expect(verifyContext(copy.teamManagementAccess)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })

  it('detects personal-organization admission in the shared writer source copy', async () => {
    const copy = await sourceCopy<{ teamManagementAccess: Access }>(
      './team-management.ts',
      'allowPersonal: false',
      'allowPersonal: true',
    )
    await expect(verifyPersonalContext(copy.teamManagementAccess)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
})
