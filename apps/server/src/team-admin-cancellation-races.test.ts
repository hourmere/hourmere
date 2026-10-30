import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import { createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import * as calendars from '@hourmere/calendars'
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
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as availability from '../../../packages/scheduling/src/availability.ts'
import * as bookingPage from '../../../packages/scheduling/src/booking-page.ts'
import * as conferences from '../../../packages/scheduling/src/conferences.ts'
import * as hosts from '../../../packages/scheduling/src/hosts.ts'
import * as questions from '../../../packages/scheduling/src/questions.ts'
import * as roundRobin from '../../../packages/scheduling/src/round-robin.ts'
import * as text from '../../../packages/scheduling/src/text.ts'
import { createApp } from './app.ts'
import { localeDescription } from './i18n/locale-description.ts'
import * as openapi from './openapi.ts'
import * as rateLimit from './rate-limit.ts'
import { bookingRoutes } from './routes/bookings.ts'
import { teamBookingRoutes } from './routes/team-bookings.ts'
import * as management from './team-management.ts'

const bootstrap = process.env.DATABASE_URL
const origin = 'http://localhost:43891'
const secret = 'synthetic-team-races-session-secret-00000000000000000'
const NOW = Temporal.Instant.from('2030-11-04T08:00Z')
const START = '2030-11-04T09:00:00Z'
const END = '2030-11-04T09:30:00Z'
const MOVED = '2030-11-04T10:00:00Z'
type GuestAction = 'cancel' | 'reschedule'
type GuestRoutes = typeof bookingRoutes

function sourceCopy<T>(source: string, bindings: Record<string, unknown>, exported: string[]): T {
  const code = stripTypeScriptTypes(
    source
      .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, '')
      .replace(/^export\s*\{[^}]*\}\s*from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${code}; return {${exported.join(',')}}`)(
    ...Object.values(bindings),
  ) as T
}

// Copies use real runtime bindings, including the HTTP layer's DomainError identity.
// Other workers keep the real source; neither files nor shared exports are changed.
async function guestRoutesCopy(before: string, after: string): Promise<GuestRoutes> {
  const serviceLocation = new URL('../../../packages/scheduling/src/bookings.ts', import.meta.url)
  const service = readFileSync(serviceLocation, 'utf8')
  expect(service.includes(before), 'mutation matches real booking source').toBe(true)
  const copy = sourceCopy<Record<string, unknown>>(
    service.replace(before, after),
    {
      createHash,
      randomBytes,
      sql,
      ...availability,
      ...bookingPage,
      ...conferences,
      ...hosts,
      ...questions,
      ...roundRobin,
      ...text,
      DomainError: scheduling.DomainError,
    },
    ['cancelManagedBooking', 'rescheduleManagedBooking'],
  )
  const routeLocation = new URL('./routes/bookings.ts', import.meta.url)
  return sourceCopy<{ bookingRoutes: GuestRoutes }>(
    readFileSync(routeLocation, 'utf8'),
    {
      createRoute,
      z,
      ...calendars,
      ...scheduling,
      ...copy,
      createMiddleware,
      localeDescription,
      ...openapi,
      ...rateLimit,
      ...management,
    },
    ['bookingRoutes'],
  ).bookingRoutes
}

describe.skipIf(!bootstrap)(
  'team administrator cancellation lifecycle races',
  { timeout: 20_000 },
  () => {
    let owned: TestDatabase
    let db: Db
    let authPool: ReturnType<typeof createAuthPool>
    let auth: ReturnType<typeof createAuth>
    let jobs: ReturnType<typeof createJobs>
    let app: ReturnType<typeof createApp>
    const sent: MailMessage[] = []
    const mail = () =>
      bookingNotificationJob({
        db,
        secret,
        publicUrl: origin,
        now: () => NOW,
        mailMaxPerHour: 0,
        mailRecipientMaxPerHour: 1000,
        mailRecipientMaxPerDay: 1000,
        mailer: {
          senderEmail: 'calendar@example.test',
          async send(message) {
            sent.push(message)
          },
        },
        log: () => {},
      })

    beforeAll(async () => {
      owned = await createTestDatabase(bootstrap as string, undefined, { tag: 'cancel_races' })
      // Six app, four auth, two auth-context and two job connections: at most fourteen.
      owned.pool.options.max = 6
      db = createDb(owned.pool)
      const signup = { mode: 'closed', allowedDomains: [] } as const
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
      app = application()
    })

    afterAll(async () => {
      try {
        await jobs?.stop()
      } finally {
        try {
          await authPool?.end()
        } finally {
          await owned?.drop()
        }
      }
    })

    function application(guestRoutes: GuestRoutes = bookingRoutes) {
      const plenty = { limit: 100_000, windowSeconds: 60 }
      const rateLimits = { page: plenty, slots: plenty, book: plenty, manage: plenty }
      const deps = { db, now: () => NOW, notify: bookingNotifier(jobs), rateLimits }
      return createApp({
        publicUrl: origin,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        routes: [guestRoutes(deps), teamBookingRoutes(deps)],
      })
    }

    async function session(user: TestUser, teamId: string) {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: teamId,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      return {
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin,
        'X-Expected-Organization-Id': teamId,
      }
    }

    async function fixture() {
      const owner = await createTestUser(db, 'Removing owner')
      const admin = await createTestUser(db, 'Cancelling administrator')
      const host = await createTestUser(db, 'Original booking host')
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: host, role: 'member' },
      ])
      const fx = createFixtures(db)
      await fx.schedule(host.id, { timeZone: 'UTC' })
      const eventId = await fx.eventType(team.id, null, {
        title: 'Concurrent team meeting',
        hosts: [{ userId: host.id }],
      })
      const token = randomBytes(32).toString('base64url')
      const booking = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('bookings')
          .values({
            organization_id: team.id,
            event_type_id: eventId,
            title: 'Concurrent team meeting',
            source: 'web',
            start_at: START,
            end_at: END,
            required_host_user_ids: [host.id],
            manage_token_hash: createHash('sha256').update(token).digest(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('booking_hosts')
          .values({ booking_id: row.id, user_id: host.id })
          .execute()
        await trx
          .insertInto('booking_attendees')
          .values([
            {
              booking_id: row.id,
              name: 'Booking guest',
              email: 'booker@example.test',
              time_zone: 'UTC',
              is_booker: true,
            },
            {
              booking_id: row.id,
              name: 'Additional guest',
              email: 'guest@example.test',
              time_zone: 'UTC',
              is_booker: false,
            },
          ])
          .execute()
        return row.id
      })
      const member = await db
        .selectFrom('auth.member')
        .select('id')
        .where('organizationId', '=', team.id)
        .where('userId', '=', host.id)
        .executeTakeFirstOrThrow()
      return {
        owner,
        admin,
        host,
        team,
        eventId,
        booking,
        token,
        memberId: member.id,
        ownerHeaders: await session(owner, team.id),
        adminHeaders: await session(admin, team.id),
      }
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>

    const post = async (
      path: string,
      headers: Record<string, string>,
      body: unknown = {},
      application = app,
    ) =>
      application.request(`${origin}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const adminCancel = (f: Fixture, application = app) =>
      post(`/api/v1/team/bookings/${f.booking}/cancel`, f.adminHeaders, {}, application)
    const guestAction = (f: Fixture, action: GuestAction, application = app) =>
      post(
        `/api/v1/bookings/manage/${action}`,
        { 'X-Manage-Token': f.token },
        action === 'reschedule' ? { start: MOVED } : {},
        application,
      )
    const removeHost = (f: Fixture) =>
      post('/api/auth/organization/remove-member', f.ownerHeaders, {
        organizationId: f.team.id,
        memberIdOrEmail: f.memberId,
      })

    // Polling observes a real blocking edge; elapsed time never decides who writes first.
    async function waiter(blocker: number, query: string) {
      let pid = 0
      await expect
        .poll(
          async () => {
            const result = await owned.pool.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database()
               AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
              [blocker, query],
            )
            pid = result.rows[0]?.pid ?? 0
            return pid
          },
          { timeout: 5000, interval: 10 },
        )
        .not.toBe(0)
      return pid
    }

    async function organizationWaiter(holderPid: number, winnerPid: number) {
      let blocked: { pid: number; organization: boolean } | undefined
      await expect
        .poll(
          async () => {
            const result = await owned.pool.query<{ pid: number; organization: boolean }>(
              `SELECT pid, query LIKE '%"organization"%' AND
                 $2 = ANY(pg_blocking_pids(pid)) AS organization
             FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> $2
               AND ($1 = ANY(pg_blocking_pids(pid)) OR $2 = ANY(pg_blocking_pids(pid)))
               AND (query LIKE '%"organization"%' OR query LIKE '%"bookings"%')`,
              [holderPid, winnerPid],
            )
            blocked = result.rows[0]
            return blocked !== undefined
          },
          { timeout: 5000, interval: 10 },
        )
        .toBe(true)
      // A rejected lock order has its own observable SQL edge, rather than merely timing out.
      expect(
        blocked?.organization ? 'organization lock held' : 'booking locked before organization',
      ).toBe('organization lock held')
    }

    async function lockedRace(
      f: Fixture,
      first: () => Promise<Response>,
      second: () => Promise<Response>,
      target: 'booking' | 'membership' = 'booking',
    ) {
      const holder = await owned.pool.connect()
      const requests: Promise<Response>[] = []
      try {
        await holder.query('BEGIN')
        await holder.query(
          target === 'booking'
            ? 'SELECT id FROM bookings WHERE id=$1 FOR UPDATE'
            : 'SELECT id FROM auth.member WHERE id=$1 FOR UPDATE',
          [target === 'booking' ? f.booking : f.memberId],
        )
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid
        expect(pid).toBeDefined()
        requests.push(first())
        const winner = await waiter(
          pid as number,
          target === 'booking' ? '%"bookings"%' : '%"member"%',
        )
        requests.push(second())
        // The loser must wait for the winner's parent lock, before it can lock the booking.
        await organizationWaiter(pid as number, winner)
        expect(
          await db
            .selectFrom('bookings')
            .select('status')
            .where('id', '=', f.booking)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'confirmed' })
        expect(await queued(f)).toEqual([])
        await holder.query('COMMIT')
        return await Promise.all(requests)
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        holder.release()
        await Promise.allSettled(requests)
      }
    }

    async function queued(f: Fixture) {
      return (
        await owned.pool.query<{ id: string; data: unknown }>(
          `SELECT j.id, j.data FROM pgboss.job j
         JOIN bookings b ON b.id = (j.data->>'bookingId')::uuid
         WHERE j.name=$1 AND b.organization_id=$2 ORDER BY j.id`,
          [BOOKING_NOTIFICATION_JOB, f.team.id],
        )
      ).rows
    }

    async function assertEffects(
      f: Fixture,
      kind: 'cancelled' | 'rescheduled',
      actorUserId: string | null,
      hostRemoved = false,
    ) {
      const rows = await db
        .selectFrom('bookings')
        .select(['id', 'status', 'rescheduled_from_id', 'required_host_user_ids', 'start_at'])
        .where('organization_id', '=', f.team.id)
        .orderBy('start_at')
        .execute()
      expect(rows).toHaveLength(kind === 'cancelled' ? 1 : 2)
      expect(rows[0]).toMatchObject({
        id: f.booking,
        status: 'cancelled',
        rescheduled_from_id: null,
        required_host_user_ids: [f.host.id],
      })
      const effectiveId = kind === 'cancelled' ? f.booking : (rows[1]?.id as string)
      if (kind === 'rescheduled')
        expect(rows[1]).toMatchObject({
          status: 'confirmed',
          rescheduled_from_id: f.booking,
          required_host_user_ids: [f.host.id],
          start_at: new Date(MOVED),
        })
      const recipients = [
        ...(!hostRemoved ? [f.host.email] : []),
        'booker@example.test',
        'guest@example.test',
      ]
      expect(
        await db
          .selectFrom('booking_hosts')
          .select(['user_id', 'active'])
          .where('booking_id', '=', f.booking)
          .execute(),
      ).toEqual([{ user_id: f.host.id, active: false }])
      const operations = await db
        .selectFrom('organization_operations')
        .select(['operation', 'actor_user_id', 'booking_id'])
        .where('organization_id', '=', f.team.id)
        .where('operation', '=', 'booking_cancelled')
        .execute()
      expect(operations).toEqual(
        kind === 'cancelled'
          ? [{ operation: 'booking_cancelled', actor_user_id: actorUserId, booking_id: f.booking }]
          : [],
      )
      const outbox = await queued(f)
      expect(outbox.map((row) => row.data)).toEqual([{ bookingId: effectiveId, kind }])
      const before = sent.length
      const drain = async () => {
        for (const row of outbox)
          await mail().handler(BookingNotificationPayload.parse(row.data), {
            id: row.id,
            attempt: 1,
            signal: new AbortController().signal,
          })
      }
      await drain()
      expect(
        sent
          .slice(before)
          .map((message) => message.to)
          .sort(),
      ).toEqual(recipients.sort())
      await drain()
      expect(sent).toHaveLength(before + recipients.length)
      expect(
        await db
          .selectFrom('booking_notifications')
          .select(['kind', 'outcome'])
          .where('booking_id', '=', effectiveId)
          .execute(),
      ).toEqual(Array.from({ length: recipients.length }, () => ({ kind, outcome: 'sent' })))
    }

    async function verifyGuestRace(
      action: GuestAction,
      first: 'admin' | 'guest',
      guestRoutes: GuestRoutes = bookingRoutes,
    ) {
      const f = await fixture()
      const raceApp = guestRoutes === bookingRoutes ? app : application(guestRoutes)
      const actions = {
        admin: () => adminCancel(f, raceApp),
        guest: () => guestAction(f, action, raceApp),
      }
      const second = first === 'admin' ? 'guest' : 'admin'
      const results = await lockedRace(f, actions[first], actions[second])
      expect(results.map((response) => response.status)).toEqual([200, 409])
      expect(await results[1]?.json()).toMatchObject({
        error: second === 'admin' ? 'booking_already_cancelled' : 'booking_cancelled',
      })
      const rescheduled = action === 'reschedule' && first === 'guest'
      await assertEffects(
        f,
        rescheduled ? 'rescheduled' : 'cancelled',
        first === 'admin' ? f.admin.id : null,
      )
      // Both original capabilities now address the withdrawn row; retries add no effects.
      expect((await adminCancel(f, raceApp)).status).toBe(409)
      expect((await guestAction(f, action, raceApp)).status).toBe(409)
      expect(await queued(f)).toHaveLength(1)
    }

    it.each(['cancel', 'reschedule'] as const)(
      'commits the administrator cancellation once while the guest %s waits',
      async (action) => verifyGuestRace(action, 'admin'),
    )

    it.each(['cancel', 'reschedule'] as const)(
      'commits the guest %s once while the administrator cancellation waits',
      async (action) => verifyGuestRace(action, 'guest'),
    )

    it.each(['admin', 'removal'] as const)(
      'preserves original booking hosts when %s gets the parent lock first',
      async (first) => {
        const f = await fixture()
        const actions = { admin: () => adminCancel(f), removal: () => removeHost(f) }
        const second = first === 'admin' ? 'removal' : 'admin'
        const responses = await lockedRace(
          f,
          actions[first],
          actions[second],
          first === 'admin' ? 'booking' : 'membership',
        )
        expect(responses.map((response) => response.status)).toEqual([200, 200])
        expect(
          await db.selectFrom('auth.member').select('id').where('id', '=', f.memberId).execute(),
        ).toEqual([])
        expect(
          await db
            .selectFrom('event_types')
            .select('is_active')
            .where('id', '=', f.eventId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ is_active: false })
        expect(
          await db
            .selectFrom('organization_operations')
            .select(['actor_user_id', 'target_user_id'])
            .where('organization_id', '=', f.team.id)
            .where('operation', '=', 'member_removed')
            .execute(),
        ).toEqual([{ actor_user_id: f.owner.id, target_user_id: f.host.id }])
        await assertEffects(f, 'cancelled', f.admin.id, true)
        expect((await adminCancel(f)).status).toBe(409)
        expect((await guestAction(f, 'cancel')).status).toBe(409)
        expect(await queued(f)).toHaveLength(1)
      },
    )

    const guestLocks = {
      cancel: '    await lockCancellationOrganization(trx, parent.organization_id)',
      reschedule: '    await lockOrganization(trx, parent.organization_id)',
    }

    it.each(['cancel', 'reschedule'] as const)(
      'runs unchanged guest %s source copies through the real blocked-writer assertions',
      async (action) => {
        const source = guestLocks[action]
        const copy = await guestRoutesCopy(source, source)
        await verifyGuestRace(action, 'admin', copy)
        await verifyGuestRace(action, 'guest', copy)
      },
    )

    it.each(['cancel', 'reschedule'] as const)(
      'detects a missing guest %s organization lock with a real assertion failure',
      async (action) => {
        const copy = await guestRoutesCopy(guestLocks[action], '')
        await expect(verifyGuestRace(action, 'guest', copy)).rejects.toMatchObject({
          name: 'AssertionError',
          actual: 'booking locked before organization',
          expected: 'organization lock held',
        })
      },
    )

    it.each(['cancel', 'reschedule'] as const)(
      'detects guest %s taking its booking before its organization with a real assertion failure',
      async (action) => {
        const source = guestLocks[action]
        const row = action === 'cancel' ? 'row' : 'old'
        const following = `    const ${row} = await lockManagedBooking(trx, hash)`
        const copy = await guestRoutesCopy(`${source}\n${following}`, `${following}\n${source}`)
        await expect(verifyGuestRace(action, 'admin', copy)).rejects.toMatchObject({
          name: 'AssertionError',
          actual: 'booking locked before organization',
          expected: 'organization lock held',
        })
      },
    )
  },
)
