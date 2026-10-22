import { randomUUID } from 'node:crypto'
import { calendarBookingNotifier } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { bookingNotifier, sendBookingNotification } from '@hourmere/notifications'
import {
  cancelManagedBooking,
  createEventType,
  createPublicTeamBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { createWebhook, webhookBookingNotifier } from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeBookingCalendar } from '../../../packages/calendars/src/booking-events.ts'
import {
  calendarEncryptionKey,
  encryptCredential,
} from '../../../packages/calendars/src/credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '../../../packages/calendars/src/google.ts'
import { tokenAad } from '../../../packages/calendars/src/index.ts'
import { fakeGoogle, TEST_CALENDAR_KEY } from '../../../packages/calendars/src/testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00Z')

describe.skipIf(!serverUrl)(
  'collective notifications and calendar targets (synthetic only)',
  () => {
    let owned: TestDatabase
    let db: Db
    beforeAll(async () => {
      owned = await createTestDatabase(serverUrl as string)
      db = createDb(owned.pool)
    })
    afterAll(async () => {
      await owned?.drop()
    })
    it('delivers to every host, keeps one UID through retry/move/cancel and writes one target per host atomically', async () => {
      const owner = await createTestUser(db, 'Owner')
      const second = await createTestUser(db, 'Second host')
      const users = [owner, second]
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: second, role: 'member' },
      ])
      const f = createFixtures(db)
      const calendars: string[] = []
      const provider = fakeGoogle()
      const events = new Map<string, Record<string, unknown>>()
      provider.controls.eventHook = async (url, init) => {
        const calendar = decodeURIComponent(url.pathname.split('/')[4] ?? '')
        if (init.method === 'POST') {
          const value = JSON.parse(String(init.body)) as Record<string, unknown>
          const event = { ...value, id: `event-${calendar}`, etag: '"v1"' }
          events.set(calendar, event)
          return Response.json(event)
        }
        if (init.method === 'PATCH') {
          const prior = events.get(calendar)
          if (!prior) return Response.json({}, { status: 404 })
          const event = { ...prior, ...JSON.parse(String(init.body)), etag: '"v2"' }
          events.set(calendar, event)
          return Response.json(event)
        }
        const current = events.get(calendar)
        return Response.json({ items: current ? [current] : [] })
      }
      for (const user of users) {
        await f.schedule(user.id, { timeZone: 'UTC' })
        await db
          .insertInto('profiles')
          .values({
            user_id: user.id,
            handle: `collective-${randomUUID().slice(0, 8)}`,
            time_zone: 'UTC',
          })
          .execute()
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
                accessToken: 'fake-access',
                refreshToken: 'fake-refresh',
                expiresAt: now().epochMilliseconds + 3_600_000,
              }),
            ),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const calendar = await db
          .insertInto('calendars')
          .values({
            connection_id: connection.id,
            external_id: `calendar-${user.id}`,
            name: 'Synthetic calendar',
            check_conflicts: false,
            access_role: 'owner',
            time_zone: 'UTC',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        calendars.push(calendar.id)
        await db
          .updateTable('profiles')
          .set({ destination_calendar_id: calendar.id })
          .where('user_id', '=', user.id)
          .execute()
      }
      const ctx = testContext(db, team.as(owner), now)
      const event = await createEventType(ctx, {
        slug: 'team',
        title: 'Collective interview',
        durationMinutes: 30,
        schedulingType: 'collective',
        hosts: users.map((u) => ({ userId: u.id })),
      })
      const webhookSettings = {
        enabled: true,
        encryptionKey: Buffer.alloc(32, 19).toString('base64'),
      }
      const { webhook } = await createWebhook(ctx, webhookSettings, {
        url: 'https://hooks.example.com/collective',
        events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
      })
      const webhookNotify = webhookBookingNotifier({ enqueue: async () => null }, webhookSettings)
      const calendarNotify = calendarBookingNotifier({
        enqueue: async (_name, _payload, options) => {
          expect(Boolean(options?.transaction)).toBe(true)
          return null
        },
      })
      const emailNotify = bookingNotifier({
        enqueue: async (_name, _payload, options) => {
          expect(Boolean(options?.transaction)).toBe(true)
          return null
        },
      })
      const pub: PublicContext = {
        db,
        now,
        notify: async (trx, event, at) => {
          await calendarNotify(trx, event)
          await emailNotify(trx, event, at)
          await webhookNotify(trx, event, at)
        },
      }
      const input = {
        handle: ctx.principal.organization.slug,
        slug: event.slug,
        start: Temporal.Instant.from('2026-11-03T09:00Z'),
        invitee: { name: 'Synthetic invitee', email: 'invitee@example.com', timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      }
      const created = await createPublicTeamBooking(pub, input)
      expect((await createPublicTeamBooking(pub, input)).replayed).toBe(true)
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .select('calendar_id')
          .where('root_booking_id', '=', created.booking.id)
          .execute(),
      ).toHaveLength(2)
      const messages: MailMessage[] = []
      const mailDeps = {
        db,
        now,
        secret: 'synthetic-notification-secret',
        publicUrl: 'http://localhost:5111',
        mailer: {
          send: async (message: MailMessage) => {
            messages.push(message)
          },
        },
      }
      await sendBookingNotification(mailDeps, created.booking.id, 'confirmed')
      await sendBookingNotification(mailDeps, created.booking.id, 'confirmed')
      expect(messages.map((message) => message.to).sort()).toEqual(
        [...users.map((u) => u.email), 'invitee@example.com'].sort(),
      )
      for (const message of messages)
        expect(message.attachments?.[0]?.content).toContain(`UID:${created.booking.id}@hourmere`)
      const deps = {
        db,
        google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
        now: () => now().epochMilliseconds,
      }
      await writeBookingCalendar(deps, created.booking.id)
      await writeBookingCalendar(deps, created.booking.id)
      expect(events.size).toBe(2)
      expect(
        [...events.values()].every((value) => value.iCalUID === `${created.booking.id}@hourmere`),
      ).toBe(true)
      const moved = await rescheduleManagedBooking(pub, created.manageToken as string, {
        start: Temporal.Instant.from('2026-11-03T10:00Z'),
      })
      await sendBookingNotification(mailDeps, moved.booking.id, 'rescheduled')
      await writeBookingCalendar(deps, moved.booking.id)
      expect(messages).toHaveLength(6)
      expect(
        [...events.values()].every(
          (value) => value.sequence === 1 && value.iCalUID === `${created.booking.id}@hourmere`,
        ),
      ).toBe(true)
      await cancelManagedBooking(pub, moved.manageToken as string)
      await sendBookingNotification(mailDeps, moved.booking.id, 'cancelled')
      await writeBookingCalendar(deps, moved.booking.id)
      expect(messages).toHaveLength(9)
      expect(
        [...events.values()].every((value) => value.sequence === 2 && value.status === 'cancelled'),
      ).toBe(true)
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .select('calendar_id')
          .where('root_booking_id', '=', created.booking.id)
          .execute(),
      ).toHaveLength(2)
      expect(calendars).toHaveLength(2)
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .select(['event_type', 'payload'])
        .where('webhook_id', '=', webhook.id)
        .orderBy('created_at')
        .execute()
      expect(deliveries.map((delivery) => delivery.event_type)).toEqual([
        'booking.created',
        'booking.rescheduled',
        'booking.cancelled',
      ])
      expect(JSON.stringify(deliveries)).not.toContain('invitee@example.com')
      for (const user of users) expect(JSON.stringify(deliveries)).not.toContain(user.email)
      const before = await db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', team.id)
        .execute()
      await expect(
        createPublicTeamBooking(
          {
            ...pub,
            notify: async (...args) => {
              await pub.notify?.(...args)
              throw new Error('Synthetic transactional rollback')
            },
          },
          {
            ...input,
            start: Temporal.Instant.from('2026-11-03T11:00Z'),
            idempotencyKey: randomUUID(),
          },
        ),
      ).rejects.toThrow('Synthetic transactional rollback')
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('organization_id', '=', team.id)
          .execute(),
      ).toHaveLength(before.length)
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('webhook_id', '=', webhook.id)
          .execute(),
      ).toHaveLength(3)
      expect(
        await db
          .selectFrom('booking_calendar_targets')
          .select('calendar_id')
          .where('root_booking_id', '=', created.booking.id)
          .execute(),
      ).toHaveLength(2)
      expect(
        provider.calls.filter(
          (call) => call.init.method === 'POST' && call.url.pathname.endsWith('/import'),
        ),
      ).toHaveLength(2)
    })
  },
)
