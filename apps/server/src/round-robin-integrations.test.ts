import { randomUUID } from 'node:crypto'
import {
  bookingCalendarJob,
  calendarBookingNotifier,
  GOOGLE_CALENDAR_SYNC_SCOPES,
  tokenAad,
} from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import {
  bookingNotificationJob,
  bookingNotifier,
  sendBookingNotification,
} from '@hourmere/notifications'
import {
  activateRoundRobin,
  type BookingNotifier,
  cancelManagedBooking,
  createEventType,
  createPublicTeamBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import {
  createWebhook,
  deliverWebhook,
  webhookBookingNotifier,
  webhookDeliveryJob,
} from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeBookingCalendar } from '../../../packages/calendars/src/booking-events.ts'
import {
  calendarEncryptionKey,
  encryptCredential,
} from '../../../packages/calendars/src/credentials.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../../packages/calendars/src/testing.ts'

const bootstrap = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 41).toString('base64') }
const required = <T>(v: T | undefined | null): T => {
  if (v == null) throw Error('Missing fixture')
  return v
}

describe.skipIf(!bootstrap)('round-robin winner-only durable integrations', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(bootstrap as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup() {
    const users = await Promise.all([0, 1, 2].map((i) => createTestUser(db, `Pool ${i}`)))
    const owner = required(users[0]),
      team = await createTestTeam(
        db,
        users.map((user, i) => ({ user, role: i ? 'member' : 'owner' })),
      )
    const ctx = testContext(db, team.as(owner), now),
      f = createFixtures(db)
    for (const user of users) {
      await f.schedule(user.id, { timeZone: 'UTC' })
      const account = `synthetic-${user.id}`
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: user.id,
          provider: 'google',
          external_account_id: account,
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
          credentials: encryptCredential(
            calendarEncryptionKey(TEST_CALENDAR_KEY),
            tokenAad(user.id, account),
            JSON.stringify({
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
              expiresAt: now().epochMilliseconds + 3_600_000,
            }),
          ),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const cal = await db
        .insertInto('calendars')
        .values({
          connection_id: connection.id,
          external_id: `cal-${user.id}`,
          name: 'Synthetic destination',
          access_role: 'owner',
          time_zone: 'UTC',
          check_conflicts: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('profiles')
        .values({
          user_id: user.id,
          handle: `round-${randomUUID().slice(0, 8)}`,
          time_zone: 'UTC',
          destination_calendar_id: cal.id,
        })
        .execute()
    }
    const event = await createEventType(ctx, {
      slug: 'round',
      title: 'Synthetic round robin',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: users.map((u) => ({ userId: u.id })),
    })
    await activateRoundRobin(ctx, event.id)
    const { webhook } = await createWebhook(ctx, settings, {
      url: 'https://hooks.example.com/synthetic-round',
      events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
    })
    const provider = fakeGoogle(),
      messages: MailMessage[] = [],
      events = new Map<string, Record<string, unknown>>()
    let imports = 0
    provider.controls.eventHook = async (url, init) => {
      const cal = decodeURIComponent(required(url.pathname.split('/')[4]))
      if (init.method === 'POST') {
        imports++
        const row = { ...JSON.parse(String(init.body)), id: `event-${cal}`, etag: '"1"' }
        events.set(cal, row)
        return Response.json(row)
      }
      if (init.method === 'PATCH') {
        const row = { ...events.get(cal), ...JSON.parse(String(init.body)), etag: '"2"' }
        events.set(cal, row)
        return Response.json(row)
      }
      return Response.json({ items: events.has(cal) ? [events.get(cal)] : [] })
    }
    const mail = {
      db,
      now,
      publicUrl: 'http://localhost:5173',
      mailer: {
        send: async (m: MailMessage) => {
          messages.push(m)
        },
      },
    }
    const calendar = {
      db,
      google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      now: () => now().epochMilliseconds,
    }
    const jobs = createJobs({
      connectionString: owned.url,
      work: false,
      migrate: true,
      definitions: [
        bookingNotificationJob(mail),
        bookingCalendarJob(calendar),
        webhookDeliveryJob({ db, ...settings }),
      ],
    })
    await jobs.start()
    return {
      users,
      ctx,
      team,
      event,
      webhook,
      mail,
      calendar,
      jobs,
      messages,
      events,
      imports: () => imports,
    }
  }
  type Setup = Awaited<ReturnType<typeof setup>>
  const input = (s: Setup, start = '2026-11-02T09:00Z') => ({
    handle: s.ctx.principal.organization.slug,
    slug: 'round',
    start: Temporal.Instant.from(start),
    idempotencyKey: randomUUID(),
    invitee: { name: 'Synthetic invitee', email: 'round-invitee@example.com', timeZone: 'UTC' },
  })
  function notifier(s: Setup, fail?: string): BookingNotifier {
    const queue = {
      enqueue: async (
        name: Parameters<typeof s.jobs.enqueue>[0],
        payload: Parameters<typeof s.jobs.enqueue>[1],
        options?: Parameters<typeof s.jobs.enqueue>[2],
      ) => {
        if (name === fail) throw Error(`Synthetic ${name} enqueue failure`)
        return s.jobs.enqueue(name, payload, options)
      },
    }
    const email = bookingNotifier(queue),
      calendar = calendarBookingNotifier(queue),
      webhook = webhookBookingNotifier(queue, settings)
    return async (trx, event, time) => {
      await email(trx, event, time)
      await calendar(trx, event)
      await webhook(trx, event, time)
    }
  }
  const sequence = (s: Setup) =>
    db
      .selectFrom('round_robin_state')
      .select('next_sequence')
      .where('event_type_id', '=', s.event.id)
      .executeTakeFirstOrThrow()

  for (const fail of ['booking-notification', 'booking-calendar', 'webhook-delivery'])
    it(`rolls back sequence, winner and all outbox writes when ${fail} enqueue fails`, async () => {
      const s = await setup()
      const jobsBefore = Number(
        (await owned.pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n,
      )
      try {
        await expect(
          createPublicTeamBooking({ db, now, notify: notifier(s, fail) }, input(s)),
        ).rejects.toThrow(`Synthetic ${fail} enqueue failure`)
        expect((await sequence(s)).next_sequence).toBe('0')
        expect(
          await db
            .selectFrom('bookings')
            .select('id')
            .where('event_type_id', '=', s.event.id)
            .execute(),
        ).toEqual([])
        expect(
          await db
            .selectFrom('booking_calendar_targets')
            .selectAll()
            .where(
              'user_id',
              'in',
              s.users.map((u) => u.id),
            )
            .execute(),
        ).toEqual([])
        expect(
          await db
            .selectFrom('webhook_deliveries')
            .select('id')
            .where('webhook_id', '=', s.webhook.id)
            .execute(),
        ).toEqual([])
        expect(
          (await owned.pool.query('SELECT count(*)::int AS n FROM pgboss.job')).rows[0].n,
        ).toBe(jobsBefore)
        expect(
          (
            await db
              .selectFrom('event_type_hosts')
              .select('last_assigned_sequence')
              .where('event_type_id', '=', s.event.id)
              .execute()
          ).every((h) => h.last_assigned_sequence === '0'),
        ).toBe(true)
        expect(s.messages).toEqual([])
        expect(s.imports()).toBe(0)
      } finally {
        await s.jobs.stop()
      }
    })

  it('delivers only to the assigned host and invitee with one UID through replay, move and cancel', async () => {
    const s = await setup(),
      pub = { db, now, notify: notifier(s) },
      request = input(s)
    try {
      const created = await createPublicTeamBooking(pub, request),
        replay = await createPublicTeamBooking(pub, request)
      expect(replay.booking.id).toBe(created.booking.id)
      expect(replay.replayed).toBe(true)
      const winner = required(
        (
          await db
            .selectFrom('booking_hosts')
            .select('user_id')
            .where('booking_id', '=', created.booking.id)
            .execute()
        )[0],
      ).user_id
      const selected = required(s.users.find((u) => u.id === winner))
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .select('user_id')
          .where('root_booking_id', '=', created.booking.id)
          .execute(),
      ).toEqual([{ user_id: winner }])
      await sendBookingNotification(s.mail, created.booking.id, 'confirmed')
      await sendBookingNotification(s.mail, created.booking.id, 'confirmed')
      expect(s.messages.map((m) => m.to).sort()).toEqual(
        [selected.email, 'round-invitee@example.com'].sort(),
      )
      expect(
        s.messages.every((m) =>
          m.attachments?.[0]?.content.includes(`UID:${created.booking.id}@hourmere`),
        ),
      ).toBe(true)
      await writeBookingCalendar(s.calendar, created.booking.id)
      await writeBookingCalendar(s.calendar, created.booking.id)
      expect(s.imports()).toBe(1)
      expect(s.events.size).toBe(1)
      const moved = await rescheduleManagedBooking(pub, created.manageToken as string, {
        start: Temporal.Instant.from('2026-11-02T10:00Z'),
      })
      await sendBookingNotification(s.mail, moved.booking.id, 'rescheduled')
      await writeBookingCalendar(s.calendar, moved.booking.id)
      expect(s.messages).toHaveLength(4)
      expect(
        [...s.events.values()].every(
          (e) => e.sequence === 1 && e.iCalUID === `${created.booking.id}@hourmere`,
        ),
      ).toBe(true)
      await cancelManagedBooking(pub, moved.manageToken as string)
      await sendBookingNotification(s.mail, moved.booking.id, 'cancelled')
      await writeBookingCalendar(s.calendar, moved.booking.id)
      expect(s.messages).toHaveLength(6)
      expect(
        s.messages.every((m) => m.to === selected.email || m.to === 'round-invitee@example.com'),
      ).toBe(true)
      expect(s.imports()).toBe(1)
      expect(
        [...s.events.values()].every((e) => e.status === 'cancelled' && e.sequence === 2),
      ).toBe(true)
      expect((await sequence(s)).next_sequence).toBe('1')
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', s.webhook.id)
        .execute()
      expect(deliveries.map((d) => d.event_type).sort()).toEqual([
        'booking.cancelled',
        'booking.created',
        'booking.rescheduled',
      ])
      expect(s.users.every((u) => !JSON.stringify(deliveries).includes(u.email))).toBe(true)
      let requests = 0
      const deps = {
        db,
        ...settings,
        now,
        transport: async () => {
          requests++
          return 204
        },
      }
      for (const delivery of deliveries) {
        await deliverWebhook(deps, delivery.id, new AbortController().signal)
        await deliverWebhook(deps, delivery.id, new AbortController().signal)
      }
      expect(requests).toBe(3)
    } finally {
      await s.jobs.stop()
    }
  })
})
