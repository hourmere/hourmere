import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import { bookingNotificationJob, bookingNotifier } from '@hourmere/notifications'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import {
  createWebhook,
  webhookBookingNotifier,
  webhookDeliveryJob,
  webhookSignature,
} from '@hourmere/webhooks'
import { expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { productionAppOptions } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost:4387'
const invitee = { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC', locale: 'en' }
const unavailable = async (): Promise<never> => {
  throw new Error('Unexpected dependency in the booking lifecycle test')
}
type Booked = { booking: { id: string; status: string; rescheduledFromId: string | null } }

it.skipIf(!serverUrl)(
  'keeps public booking, manage links and their delivery independent of host SSO',
  async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const db = createDb(owned.pool)
    const secret = randomBytes(32).toString('base64')
    const config = loadConfig({
      DATABASE_URL: owned.url,
      PUBLIC_URL: publicUrl,
      BETTER_AUTH_SECRET: secret,
    })
    const pool = createAuthPool(owned.url, config.signup)
    const auth = createAuth({
      db,
      pool,
      signup: config.signup,
      baseURL: publicUrl,
      secret,
      mailer: { send: unavailable },
    })

    const webhookSettings = { enabled: true, encryptionKey: Buffer.alloc(32, 7).toString('base64') }
    const messages: MailMessage[] = []
    const requests: { body: string; timestamp: string; signature: string }[] = []
    const mailJob = bookingNotificationJob({
      db,
      secret,
      publicUrl,
      mailer: {
        async send(message) {
          messages.push(message)
        },
      },
    })
    const webhookJob = webhookDeliveryJob({
      db,
      ...webhookSettings,
      async transport({ body, headers }) {
        requests.push({
          body,
          timestamp: headers['webhook-timestamp'] ?? '',
          signature: headers['webhook-signature'] ?? '',
        })
        return 204
      },
    })
    const jobs = createJobs({
      connectionString: owned.url,
      definitions: [mailJob, webhookJob],
      work: false,
      migrate: true,
    })

    try {
      await jobs.start()
      const host = await createTestUser(db, 'Team host')
      const team = await createTestTeam(db, [{ user: host, role: 'owner' }])
      const hostContext = testContext(db, team.as(host))
      const f = createFixtures(db)
      await f.schedule(host.id, { timeZone: 'UTC' })
      const eventId = await f.eventType(team.id, null, {
        slug: 'intro',
        hosts: [{ userId: host.id }],
      })
      const { webhook, secret: webhookSecret } = await createWebhook(hostContext, webhookSettings, {
        url: 'https://hooks.example.com/bookings',
        events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
      })
      await db
        .insertInto('sso_policies')
        .values({ organization_id: team.id, require_sso: true })
        .execute()

      const mail = bookingNotifier(jobs)
      const webhookCapture = webhookBookingNotifier(jobs, webhookSettings)
      const app = createApp(
        productionAppOptions({
          config,
          db,
          auth,
          resolveCaller: createCallerResolver({ auth, db }),
          resolveMcpOAuth: unavailable,
          checkDb: unavailable,
          waitlist: { verify: unavailable, remove: unavailable },
          invitationMailLimits: { secret },
          webhookSettings,
          webhookQueue: jobs,
          async notify(trx, event, now) {
            await mail(trx, event, now)
            await webhookCapture(trx, event, now)
          },
          notifyAttendeeNoShow: unavailable,
          googleCalendar: undefined,
          microsoftCalendar: undefined,
          zoomConference: undefined,
          enqueueCalendarSync: unavailable,
          enqueueCalendarWritebackRecovery: unavailable,
          mailboxProofQueue: { enqueue: unavailable },
        }),
      )
      const session = await db.transaction().execute((trx) =>
        createBrowserSession(
          trx,
          { secret, publicUrl },
          {
            userId: host.id,
            organizationId: team.id,
            now: Temporal.Now.instant().toString(),
            headers: new Headers(),
          },
        ),
      )
      const privateRead = await app.request(`/api/v1/event-types/${eventId}`, {
        headers: {
          cookie: session.cookie.split(';')[0] as string,
          'x-expected-organization-id': team.id,
        },
      })
      expect(privateRead.status).toBe(403)
      expect(await privateRead.json()).toEqual({ error: 'sso_required' })

      async function deliver(
        bookingId: string,
        kind: 'confirmed' | 'rescheduled' | 'cancelled',
        event: string,
        subject: RegExp,
      ) {
        const delivery = await db
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('webhook_id', '=', webhook.id)
          .where('booking_id', '=', bookingId)
          .where('event_type', '=', event)
          .executeTakeFirstOrThrow()
        const {
          rows: [notification],
        } = await owned.pool.query<{ id: string; data: unknown }>(
          "SELECT id, data FROM pgboss.job WHERE name = $1 AND data->>'bookingId' = $2 AND data->>'kind' = $3",
          [mailJob.name, bookingId, kind],
        )
        const {
          rows: [queuedWebhook],
        } = await owned.pool.query<{ id: string; data: unknown }>(
          "SELECT id, data FROM pgboss.job WHERE name = $1 AND data->>'deliveryId' = $2",
          [webhookJob.name, delivery.id],
        )
        if (!notification || !queuedWebhook)
          throw new Error('Booking change did not enqueue both delivery jobs')
        const run = { signal: new AbortController().signal, attempt: 1 }
        const before = messages.length
        await mailJob.handler(mailJob.payload.parse(notification.data), {
          ...run,
          id: notification.id,
        })
        await webhookJob.handler(webhookJob.payload.parse(queuedWebhook.data), {
          ...run,
          id: queuedWebhook.id,
        })
        expect(
          messages
            .slice(before)
            .map(({ to }) => to)
            .sort(),
        ).toEqual([host.email, invitee.email].sort())
        const email = messages.slice(before).find(({ to }) => to === invitee.email)
        expect(email?.subject).toMatch(subject)
        expect(
          await db
            .selectFrom('webhook_deliveries')
            .select(['status', 'attempts'])
            .where('id', '=', delivery.id)
            .executeTakeFirst(),
        ).toEqual({ status: 'delivered', attempts: 1 })
        const request = requests.at(-1)
        expect(JSON.parse(request?.body ?? 'null')).toMatchObject({
          type: event,
          data: { bookingId, organizationId: team.id },
        })
        expect(
          request?.signature ===
            webhookSignature(webhookSecret, request?.timestamp ?? '', request?.body ?? ''),
        ).toBe(true)
        return email
      }

      const post = (path: string, body: unknown, token?: string) =>
        app.request(path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token && { 'x-manage-token': token }),
          },
          body: JSON.stringify(body),
        })
      let day = Temporal.Now.plainDateISO('UTC').add({ days: 4 })
      while (day.dayOfWeek > 5) day = day.add({ days: 1 })
      const start = (plainTime: string) =>
        day.toZonedDateTime({ timeZone: 'UTC', plainTime }).toInstant().toString()

      // docs/sso.md, Browser proof and Acceptance, preserve durable booking delivery and public manage links.
      const created = await post(
        `/api/v1/public/teams/${team.as(host).organization.slug}/intro/bookings`,
        { start: start('10:00'), invitee },
      )
      expect(created.status).toBe(201)
      const { booking: original } = (await created.json()) as Booked
      expect(original.status).toBe('confirmed')
      const confirmation = await deliver(
        original.id,
        'confirmed',
        'booking.created',
        /^Confirmed: Intro call/,
      )
      const token = confirmation?.text.match(/#token=([A-Za-z0-9_-]{43})&action=reschedule/)?.[1]
      if (!token) throw new Error('Confirmation email did not contain the invitee manage link')

      const moved = await post(
        '/api/v1/bookings/manage/reschedule',
        { start: start('12:00') },
        token,
      )
      expect(moved.status).toBe(200)
      const { booking: successor } = (await moved.json()) as Booked
      expect(successor).toMatchObject({ status: 'confirmed', rescheduledFromId: original.id })
      await deliver(successor.id, 'rescheduled', 'booking.rescheduled', /^Rescheduled: Intro call/)

      const cancelled = await post('/api/v1/bookings/manage/cancel', {}, token)
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({ id: successor.id, status: 'cancelled' })
      await deliver(successor.id, 'cancelled', 'booking.cancelled', /^Cancelled: Intro call/)
      expect(requests).toHaveLength(3)
    } finally {
      await jobs.stop()
      await pool.end()
      await owned.drop()
    }
  },
)
