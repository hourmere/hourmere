import { randomUUID } from 'node:crypto'
import {
  bookingCalendarJob,
  bookingConferenceJob,
  calendarBookingNotifier,
  conferenceBookingNotifier,
  GOOGLE_CALENDAR_SYNC_SCOPES,
} from '@hourmere/calendars'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { bookingNotificationJob, bookingNotifier } from '@hourmere/notifications'
import { createWebhook, webhookBookingNotifier, webhookDeliveryJob } from '@hourmere/webhooks'
import { type CompiledQuery, Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPublicTeamEventType } from './availability.ts'
import {
  createBookingInTransaction,
  createPublicTeamBooking,
  prepareBookingAttendees,
} from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { lockOrganization } from './hosts.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const start = Temporal.Instant.from('2026-11-02T09:00Z')
const webhookSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }

describe.skipIf(!serverUrl)('booking creation transaction', () => {
  let owned: TestDatabase
  let db: Db
  const providerCalls = {
    mail: vi.fn(async () => {}),
    webhook: vi.fn(async () => 204),
  }
  function queue() {
    return createJobs({
      connectionString: owned.url,
      definitions: [
        bookingConferenceJob({ db }),
        bookingCalendarJob({ db }),
        bookingNotificationJob({
          db,
          mailer: { send: providerCalls.mail },
          publicUrl: 'https://hourmere.example',
          secret: 'synthetic-notification-secret',
        }),
        webhookDeliveryJob({ db, ...webhookSettings, transport: providerCalls.webhook }),
      ],
      maxConnections: 2,
      work: false,
      migrate: true,
    })
  }
  let jobs: ReturnType<typeof queue>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    jobs = queue()
    await jobs.start()
  })

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function setup(automaticMeet = false) {
    const owner = await createTestUser(db, 'Host One')
    const member = await createTestUser(db, 'Host Two')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const hosts = [owner.id, member.id].sort()
    const admin = { ...testContext(db, team.as(owner), now), automaticMeet }
    const fixtures = createFixtures(db)
    for (const userId of hosts) {
      await fixtures.schedule(userId, { timeZone: 'UTC' })
      if (!automaticMeet) continue
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: userId,
          provider: 'google',
          external_account_id: `synthetic-${userId}`,
          credentials: Buffer.from('synthetic-cache-only-credential'),
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const calendar = await db
        .insertInto('calendars')
        .values({
          connection_id: connection.id,
          external_id: 'work',
          name: 'Work',
          access_role: 'owner',
          supports_google_meet: true,
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('profiles')
        .values({
          user_id: userId,
          handle: `host-${userId.slice(0, 8)}`,
          time_zone: 'UTC',
          destination_calendar_id: calendar.id,
        })
        .execute()
    }
    const event = await createEventType(admin, {
      slug: 'round-robin',
      title: 'Team call',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [...hosts].reverse().map((userId) => ({ userId })),
      ...(automaticMeet && { location: { kind: 'google_meet', autoCreate: true } }),
    })
    await activateRoundRobin(admin, event.id)
    const input = {
      handle: admin.principal.organization.slug,
      slug: event.slug,
      start,
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    }
    return { admin, event, hosts, input }
  }

  function bookingLock({ sql: statement, parameters }: CompiledQuery) {
    if (statement.includes('pg_advisory_xact_lock')) return ['host', parameters[0]]
    if (statement.includes('for share of "et"')) return ['event']
    if (statement.includes('for share')) {
      if (statement.includes('from "auth"."organization"')) return ['organization']
      if (statement.includes('from "auth"."user"')) return ['users', ...parameters]
      if (statement.includes('from "auth"."member"')) return ['members', ...parameters.slice(1)]
    }
    if (statement.includes('from "round_robin_state"') && statement.includes('for update'))
      return ['round-robin']
    return undefined
  }

  it('locks the organization, sorted hosts, event, users, members and assignment state in order', async () => {
    const { hosts, input } = await setup()
    const locks: unknown[][] = []
    const loggedDb = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level !== 'query') return
        const lock = bookingLock(event.query)
        if (lock) locks.push(lock)
      },
    })
    await createPublicTeamBooking({ db: loggedDb, now }, input)
    expect(locks).toEqual([
      ['organization'],
      ...hosts.map((id) => ['host', `booking-host:${id}`]),
      ['event'],
      ['users', ...hosts],
      ['members', ...hosts],
      ['round-robin'],
    ])
  })

  it('keeps booking writes and provider intents in the caller transaction', async () => {
    const { admin, event, hosts, input } = await setup(true)
    const organizationId = admin.principal.organization.id
    const { webhook } = await createWebhook(admin, webhookSettings, {
      url: 'https://hooks.example.com/bookings',
      events: ['booking.created'],
    })
    const holdId = randomUUID()
    // Seed a due pending hold on the same slot. Booking expires it while checking availability.
    await db
      .insertInto('bookings')
      .values({
        id: holdId,
        organization_id: organizationId,
        status: 'pending_payment',
        payment_hold_expires_at: sql<Date>`least(clock_timestamp(), ${start.toString()}::timestamptz) - interval '1 minute'`,
        start_at: start.toString(),
        end_at: start.add({ minutes: 30 }).toString(),
        source: 'web',
        title: 'Pending hold',
      })
      .execute()
    await db
      .insertInto('booking_hosts')
      .values(hosts.map((userId) => ({ booking_id: holdId, user_id: userId })))
      .execute()

    const resolve = (trx: Db, options?: { lock?: boolean }) =>
      findPublicTeamEventType(trx, input.handle, input.slug, options)
    const preRead = await resolve(db)
    if (!preRead) throw new Error('Missing seeded event')
    await db
      .updateTable('event_types')
      .set({ title: 'Updated team call' })
      .where('id', '=', event.id)
      .execute()

    const conferenceNotifier = conferenceBookingNotifier(jobs)
    const calendarNotifier = calendarBookingNotifier(jobs)
    const emailNotifier = bookingNotifier(jobs)
    const webhookNotifier = webhookBookingNotifier(jobs, webhookSettings)
    const notify: BookingNotifier = async (trx, change, at) => {
      if (change.type !== 'created') throw new Error('Expected a booking creation')
      await conferenceNotifier(trx, change)
      await emailNotifier(trx, change, at)
      await calendarNotifier(trx, change)
      await webhookNotifier(trx, change, at)
    }

    const bookingRows = (executor: Db) =>
      executor
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', organizationId)
        .execute()
    const deliveries = (executor: Db, bookingId: string) =>
      executor
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('booking_id', '=', bookingId)
        .where('webhook_id', '=', webhook.id)
        .execute()
    const conference = (executor: Db, bookingId: string) =>
      executor
        .selectFrom('booking_conferences')
        .select(['provider', 'state'])
        .where('booking_id', '=', bookingId)
        .executeTakeFirst()
    const queued = (executor: Db, bookingId: string, deliveryId: string) =>
      sql<{ name: string }>`select distinct name from pgboss.job
        where data->>'bookingId' = ${bookingId} or data->>'rootBookingId' = ${bookingId}
           or data->>'deliveryId' = ${deliveryId}
        order by name`.execute(executor)

    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}))
    try {
      const stop = new Error('Caller rolls back after booking')
      let bookingId = ''
      let deliveryId = ''
      const checkEvent = vi.fn(async (current: typeof preRead) => {
        expect(current.title).toBe('Updated team call')
      })
      await expect(
        db.transaction().execute(async (trx) => {
          await lockOrganization(trx, organizationId)
          const result = await createBookingInTransaction(
            { now, automaticMeet: true, notify },
            trx,
            {
              input,
              origin: { source: 'api', apiKeyId: null },
              event: preRead,
              resolve,
              attendees: prepareBookingAttendees(input),
              checkEvent,
            },
          )
          bookingId = result.booking.id
          expect(checkEvent).toHaveBeenCalledOnce()
          expect(await bookingRows(trx)).toEqual(
            expect.arrayContaining([
              { id: holdId, status: 'expired' },
              { id: bookingId, status: 'confirmed' },
            ]),
          )
          expect(await conference(trx, bookingId)).toEqual({
            provider: 'google_meet',
            state: 'pending',
          })
          const captured = await deliveries(trx, bookingId)
          expect(captured).toHaveLength(1)
          deliveryId = captured[0]?.id ?? ''
          expect((await queued(trx, bookingId, deliveryId)).rows.map(({ name }) => name)).toEqual([
            'booking-calendar',
            'booking-conference',
            'booking-notification',
            'webhook-delivery',
          ])
          throw stop
        }),
      ).rejects.toBe(stop)
      expect(await bookingRows(db)).toEqual([{ id: holdId, status: 'pending_payment' }])
      expect(await conference(db, bookingId)).toBeUndefined()
      expect(await deliveries(db, bookingId)).toEqual([])
      expect((await queued(db, bookingId, deliveryId)).rows).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
      expect(providerCalls.mail).not.toHaveBeenCalled()
      expect(providerCalls.webhook).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })
})
