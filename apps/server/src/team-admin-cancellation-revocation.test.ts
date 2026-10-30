import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
} from '@hourmere/notifications'
import * as scheduling from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import * as openapi from './openapi.ts'
import { CancelBody, ListBookingsQuery } from './routes/bookings.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:4397'
const secret = 'synthetic-cancellation-revocation-secret-000000000000'
const now = () => Temporal.Instant.from('2030-11-03T12:00:00Z')
type Revocation = 'demotion' | 'removal'
type RouteFactory = typeof teamBookingRoutes

// Inject real bindings so unchanged copies retain the HTTP layer's error identity.
// Other workers and production imports retain real source.
function sourceCopy<T>(
  path: string,
  bindings: Record<string, unknown>,
  exported: string[],
  replacements: [string, string][] = [],
): T {
  const location = new URL(path, import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [before, after] of replacements) {
    expect(source.includes(before), 'mutation matches real source').toBe(true)
    source = source.replace(before, after)
  }
  const code = stripTypeScriptTypes(
    source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${code}; return {${exported.join(',')}}`)(
    ...Object.values(bindings),
  ) as T
}

async function copiedRoutes(replacements: [string, string][] = []): Promise<RouteFactory> {
  const shared = sourceCopy<Record<string, unknown>>(
    '../../../packages/auth/src/team-management.ts',
    { sql },
    ['checkTeamManagementAccess', 'TeamManagementError'],
    replacements,
  )
  const access = sourceCopy<Record<string, unknown>>(
    './team-management.ts',
    { ...shared, DomainError, createMiddleware, sql },
    ['teamManagementAccess', 'EXPECTED_ORGANIZATION_HEADER', 'ORGANIZATION_CONTEXT_CHANGED'],
  )
  return sourceCopy<{ teamBookingRoutes: RouteFactory }>(
    './routes/team-bookings.ts',
    { createRoute, z, ...scheduling, ...openapi, ...access, CancelBody, ListBookingsQuery },
    ['teamBookingRoutes'],
  ).teamBookingRoutes
}

describe.skipIf(!bootstrap)(
  'team cancellation ordered with actual administrator revocation',
  () => {
    let owned: TestDatabase
    let db: Db
    let authPool: ReturnType<typeof createAuthPool>
    let auth: Auth
    let jobs: ReturnType<typeof createJobs>
    let notify: scheduling.BookingNotifier
    let app: ReturnType<typeof createApp>
    const sent: MailMessage[] = []

    const mail = () =>
      bookingNotificationJob({
        db,
        secret,
        publicUrl: origin,
        now,
        mailMaxPerHour: 0,
        mailRecipientMaxPerHour: 100,
        mailer: {
          senderEmail: 'calendar@example.test',
          async send(message) {
            sent.push(message)
          },
        },
        log: () => {},
      })

    beforeAll(async () => {
      owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'cancel_revoke' })
      // Six app, four auth, two auth-context and two job connections: at most fourteen.
      owned.pool.options.max = 6
      db = createDb(owned.pool)
      const signup = { mode: 'open', allowedDomains: [] } as const
      authPool = createAuthPool(owned.url, signup)
      authPool.options.max = 4
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      jobs = createJobs({
        connectionString: owned.url,
        definitions: [mail()],
        work: false,
        migrate: true,
        maxConnections: 2,
        log: () => {},
      })
      await jobs.start()
      notify = bookingNotifier(jobs)
      app = application()
    })

    afterAll(async () => {
      const closed = await Promise.allSettled([jobs?.stop(), authPool?.end()])
      closed.push(...(await Promise.allSettled([owned?.drop()])))
      const errors = closed
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Cancellation revocation cleanup failed')
    })

    function application(factory: RouteFactory = teamBookingRoutes) {
      return createApp({
        publicUrl: origin,
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        checkDb: async () => {},
        routes: [factory({ db, now, notify })],
      })
    }

    async function session(user: TestUser, organizationId: string) {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: organizationId,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    }

    async function fixture() {
      const owner = await createTestUser(db, 'Revoking owner')
      const admin = await createTestUser(db, 'Cancelling administrator')
      const host = await createTestUser(db, 'Saved host')
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: host, role: 'member' },
      ])
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', team.id)
        .where('userId', '=', admin.id)
        .executeTakeFirstOrThrow()
      const booking = await seedBooking(team.id, host.id, '2030-11-04T09:00Z', '2030-11-04T09:30Z')
      const nextBooking = await seedBooking(
        team.id,
        host.id,
        '2030-11-04T10:00Z',
        '2030-11-04T10:30Z',
      )
      return {
        owner,
        admin,
        host,
        team,
        memberId: member.id,
        booking,
        nextBooking,
        ownerCookie: await session(owner, team.id),
        adminCookie: await session(admin, team.id),
      }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>

    async function seedBooking(teamId: string, hostId: string, start: string, end: string) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('bookings')
          .values({
            organization_id: teamId,
            title: 'Revocation race meeting',
            source: 'web',
            start_at: start,
            end_at: end,
            required_host_user_ids: [hostId],
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('booking_hosts')
          .values({ booking_id: row.id, user_id: hostId })
          .execute()
        await trx
          .insertInto('booking_attendees')
          .values({
            booking_id: row.id,
            name: 'Synthetic attendee',
            email: 'attendee@example.test',
            time_zone: 'UTC',
            is_booker: true,
          })
          .execute()
        return row
      })
    }

    const headers = (cookie: string, teamId: string) => ({
      cookie,
      origin,
      'content-type': 'application/json',
      'x-expected-organization-id': teamId,
    })
    const cancel = (f: Fixture, target = f.booking.id, instance = app) =>
      instance.request(`/api/v1/team/bookings/${target}/cancel`, {
        method: 'POST',
        headers: headers(f.adminCookie, f.team.id),
        body: JSON.stringify({ reason: 'Original administrator action' }),
      })
    const revoke = (f: Fixture, kind: Revocation) =>
      app.request(
        `/api/auth/organization/${kind === 'demotion' ? 'update-member-role' : 'remove-member'}`,
        {
          method: 'POST',
          headers: headers(f.ownerCookie, f.team.id),
          body: JSON.stringify({
            organizationId: f.team.id,
            ...(kind === 'demotion'
              ? { memberId: f.memberId, role: 'member' }
              : { memberIdOrEmail: f.memberId }),
          }),
        },
      )

    async function assertRevoked(f: Fixture, kind: Revocation) {
      const member = await db
        .selectFrom('auth.member')
        .select('role')
        .where('id', '=', f.memberId)
        .executeTakeFirst()
      expect(member).toEqual(kind === 'demotion' ? { role: 'member' } : undefined)
      const records = await db
        .selectFrom('organization_operations')
        .select(['operation', 'actor_user_id', 'target_user_id', 'previous_role', 'new_role'])
        .where('organization_id', '=', f.team.id)
        .where('target_user_id', '=', f.admin.id)
        .execute()
      expect(records).toEqual([
        {
          operation: kind === 'demotion' ? 'member_role_changed' : 'member_removed',
          actor_user_id: f.owner.id,
          target_user_id: f.admin.id,
          previous_role: 'admin',
          new_role: kind === 'demotion' ? 'member' : null,
        },
      ])
    }

    async function refused(response: Response) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    }

    const operations = (id: string) =>
      db.selectFrom('organization_operations').selectAll().where('booking_id', '=', id).execute()
    async function queued(id: string) {
      return (
        await owned.pool.query<{ id: string; data: unknown }>(
          "SELECT id, data FROM pgboss.job WHERE name=$1 AND data->>'bookingId'=$2 ORDER BY id",
          [BOOKING_NOTIFICATION_JOB, id],
        )
      ).rows
    }
    async function snapshot(id: string) {
      return {
        booking: await db
          .selectFrom('bookings')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
        hosts: await db
          .selectFrom('booking_hosts')
          .selectAll()
          .where('booking_id', '=', id)
          .execute(),
        operations: await operations(id),
        jobs: await queued(id),
        receipts: await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where('booking_id', '=', id)
          .execute(),
      }
    }
    async function assertCancelledOnce(f: Fixture) {
      expect(
        await db
          .selectFrom('bookings')
          .selectAll()
          .where('id', '=', f.booking.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        status: 'cancelled',
        cancelled_at: new Date(now().toString()),
        cancel_reason: 'Original administrator action',
        required_host_user_ids: [f.host.id],
      })
      expect(
        await db
          .selectFrom('booking_hosts')
          .select(['user_id', 'active'])
          .where('booking_id', '=', f.booking.id)
          .execute(),
      ).toEqual([{ user_id: f.host.id, active: false }])
      expect(await operations(f.booking.id)).toMatchObject([
        { operation: 'booking_cancelled', actor_user_id: f.admin.id, source: 'web' },
      ])
      const queuedJobs = await queued(f.booking.id)
      expect(queuedJobs).toHaveLength(1)
      expect(queuedJobs[0]?.data).toEqual({ bookingId: f.booking.id, kind: 'cancelled' })
      const before = sent.length
      for (let attempt = 0; attempt < 2; attempt++)
        for (const job of queuedJobs)
          await mail().handler(BookingNotificationPayload.parse(job.data), {
            id: job.id,
            attempt: 1,
            signal: new AbortController().signal,
          })
      expect(sent.slice(before).map((message) => message.to)).toEqual([
        f.host.email,
        'attendee@example.test',
      ])
      expect(
        await db
          .selectFrom('booking_notifications')
          .select(['kind', 'outcome'])
          .where('booking_id', '=', f.booking.id)
          .execute(),
      ).toEqual([
        { kind: 'cancelled', outcome: 'sent' },
        { kind: 'cancelled', outcome: 'sent' },
      ])
    }

    async function blockedBy(pid: number, query: string) {
      return (
        await owned.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
         WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
          [pid, query],
        )
      ).rows[0]?.pid
    }
    async function waitForBlocker(pid: number, query: string) {
      let blocked: number | undefined
      await expect
        .poll(
          async () => {
            blocked = await blockedBy(pid, query)
            return blocked !== undefined
          },
          { timeout: 5000, interval: 10 },
        )
        .toBe(true)
      return blocked as number
    }
    const backendPid = async (client: PoolClient) =>
      (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number

    it.each<Revocation>(['demotion', 'removal'])(
      'refuses a cancellation requested after actual administrator %s commits',
      async (kind) => {
        const f = await fixture()
        const before = await snapshot(f.booking.id)
        expect((await revoke(f, kind)).status).toBe(200)
        await assertRevoked(f, kind)
        await refused(await cancel(f))
        expect(await snapshot(f.booking.id)).toEqual(before)
      },
      15_000,
    )

    async function verifyRevocationWins(
      kind: Revocation,
      factory: RouteFactory = teamBookingRoutes,
    ) {
      const f = await fixture()
      const before = await snapshot(f.booking.id)
      const nextBefore = await snapshot(f.nextBooking.id)
      const holder = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        // Block the first actor lock, after route middleware has read the old role.
        // The owner's separate identity can revoke through the real auth endpoint.
        await holder.query('SELECT id FROM auth.user WHERE id=$1 FOR UPDATE', [f.admin.id])
        const pid = await backendPid(holder)
        pending = Promise.resolve(cancel(f, f.booking.id, application(factory)))
        await waitForBlocker(pid, '%auth%user%for share%')
        expect((await revoke(f, kind)).status).toBe(200)
        await assertRevoked(f, kind)
        await holder.query('COMMIT')
        await refused(await pending)
        await refused(await cancel(f, f.nextBooking.id))
        expect(await snapshot(f.booking.id)).toEqual(before)
        expect(await snapshot(f.nextBooking.id)).toEqual(nextBefore)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await pending
      }
    }

    it.each<Revocation>(['demotion', 'removal'])(
      'rechecks actual administrator %s committed while cancellation waits for authority',
      async (kind) => {
        await verifyRevocationWins(kind)
      },
      15_000,
    )

    async function verifyCancellationWins(
      kind: Revocation,
      factory: RouteFactory = teamBookingRoutes,
    ) {
      const f = await fixture()
      const before = await snapshot(f.booking.id)
      const nextBefore = await snapshot(f.nextBooking.id)
      const holder = await owned.pool.connect()
      let pending: Promise<Response> | undefined
      let revoking: Promise<Response> | undefined
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [f.booking.id])
        pending = Promise.resolve(cancel(f, f.booking.id, application(factory)))
        const cancellingPid = await waitForBlocker(
          await backendPid(holder),
          '%bookings%for update%',
        )
        let revoked = false
        revoking = Promise.resolve(revoke(f, kind)).then((response) => {
          revoked = true
          return response
        })
        let waiting: number | undefined
        await expect
          .poll(
            async () => {
              waiting = await blockedBy(cancellingPid, '%auth%organization%for update%')
              return waiting !== undefined || revoked
            },
            { timeout: 5000, interval: 10 },
          )
          .toBe(true)
        // A completed revocation is an observable failure, not a timeout-based ordering claim.
        expect(waiting !== undefined ? 'authorization held' : 'revocation committed').toBe(
          'authorization held',
        )
        expect(revoked).toBe(false)
        expect(await snapshot(f.booking.id)).toEqual(before)
        await holder.query('COMMIT')
        expect((await pending).status).toBe(200)
        expect((await revoking).status).toBe(200)
        await assertRevoked(f, kind)
        await refused(await cancel(f, f.nextBooking.id))
        expect(await snapshot(f.nextBooking.id)).toEqual(nextBefore)
        await assertCancelledOnce(f)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
        await Promise.all([pending, revoking])
      }
    }

    it.each<Revocation>(['demotion', 'removal'])(
      'lets an authorized cancellation finish while actual administrator %s waits, then refuses the next write',
      async (kind) => {
        await verifyCancellationWins(kind)
      },
      15_000,
    )

    it.each<Revocation>(['demotion', 'removal'])(
      'runs both %s orderings against untouched source copies',
      async (kind) => {
        const copy = await copiedRoutes()
        await verifyRevocationWins(kind, copy)
        await verifyCancellationWins(kind, copy)
      },
      15_000,
    )

    it.each<Revocation>(['demotion', 'removal'])(
      'detects a stale membership snapshot taken before the authorization lock during %s',
      async (kind) => {
        const source = readFileSync(
          new URL('../../../packages/auth/src/team-management.ts', import.meta.url),
          'utf8',
        )
        // Take the membership snapshot without locks before the authorization locks are held.
        const start = source.indexOf('  const membership = await checkTeamManagementMembership(')
        const end = source.indexOf('  const { personal, role } = membership', start)
        expect(start).toBeGreaterThan(0)
        expect(end).toBeGreaterThan(start)
        const read = source.slice(start, end)
        const unlocked = read.replace('    lock,\n', '    false,\n')
        expect(unlocked).not.toBe(read)
        const copy = await copiedRoutes([
          [read, ''],
          [
            '  await teamSessionUser(db, principal, lock)',
            `${unlocked}  await teamSessionUser(db, principal, lock)`,
          ],
        ])
        await expect(verifyRevocationWins(kind, copy)).rejects.toMatchObject({
          name: 'AssertionError',
          actual: 200,
          expected: 403,
        })
      },
      15_000,
    )

    it.each<Revocation>(['demotion', 'removal'])(
      'detects dropping authorization locks before cancellation persists during %s',
      async (kind) => {
        const copy = await copiedRoutes([
          ['  if (lock) organizationQuery = organizationQuery.forUpdate()', ''],
          ['  if (lock) memberQuery = memberQuery.forShare()', ''],
        ])
        await expect(verifyCancellationWins(kind, copy)).rejects.toMatchObject({
          name: 'AssertionError',
          actual: 'revocation committed',
          expected: 'authorization held',
        })
      },
      15_000,
    )
  },
)
