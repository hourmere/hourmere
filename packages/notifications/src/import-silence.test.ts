import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDeps } from './index.ts'
import type { ScheduledEmailQueue } from './scheduled.ts'
import { alignSmtpDateNowWithDatabase } from './testing-clock.ts'

const moduleFor = (name: string) =>
  process.env.HOURMERE_SILENCE_MUTATION_TARGET === name
    ? (process.env.HOURMERE_SILENCE_MUTATION_FILE as string)
    : `./${name}`
const {
  conferenceNotificationAllowed,
  dispatchConferenceNotifications,
  enqueueBookingNotifications,
  sendBookingNotification,
  sendOnce,
}: typeof import('./index.ts') = await import(moduleFor('index.ts'))
const {
  deliverScheduledBookingEmail,
  enqueueScheduledBookingEmails,
  repairScheduledBookingEmails,
}: typeof import('./scheduled.ts') = await import(moduleFor('scheduled.ts'))
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const START = NOW.add({ hours: 72 })
const SNAPSHOT = {
  version: 1,
  executionMode: 'configurable',
  notifications: {
    reminders: [
      {
        id: 'reminder',
        offsetMinutes: 120,
        recipients: { host: true, invitee: true, guests: true },
      },
    ],
    followUps: [],
  },
}

describe.skipIf(!process.env.DATABASE_URL)(
  'imported bookings stay local across mail workers',
  () => {
    let database: TestDatabase
    let db: Db
    let bookingId: string
    let organizationId: string
    let userId: string
    let sent: MailMessage[]
    let deps: NotificationDeps
    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'silent_mail',
      })
      db = createDb(database.pool)
    })
    afterAll(async () => database?.drop())
    beforeEach(async () => {
      await alignSmtpDateNowWithDatabase(db)
      const f = createFixtures(db)
      const host = await f.host()
      organizationId = host.organizationId
      userId = host.userId
      bookingId = await f.booking(
        organizationId,
        [userId],
        START.toString(),
        START.add({ minutes: 30 }).toString(),
        { source: 'import' },
      )
      await db
        .updateTable('bookings')
        .set({ notification_snapshot: JSON.stringify(SNAPSHOT) })
        .where('id', '=', bookingId)
        .execute()
      sent = []
      deps = {
        db,
        mailer: {
          send: async (message) => {
            sent.push(message)
          },
        },
        secret: 'synthetic-import-silence',
        publicUrl: 'https://synthetic.example',
        now: () => NOW,
        log: () => {},
      }
    })
    const queue = () =>
      ({
        enqueue: vi.fn(async () => randomUUID()),
        hasLiveScheduledBookingEmailJob: vi.fn(async () => false),
        retireExpiredScheduledBookingEmailJobs: vi.fn(async () => {}),
      }) satisfies ScheduledEmailQueue
    async function message() {
      return (
        await db
          .insertInto('booking_scheduled_messages')
          .values({
            organization_id: organizationId,
            booking_id: bookingId,
            kind: 'reminder',
            rule_id: 'reminder',
            anchor_start_at: START.toString(),
            anchor_end_at: START.add({ minutes: 30 }).toString(),
            due_at: NOW.toString(),
            expires_at: START.toString(),
            next_attempt_at: NOW.toString(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    }
    const receipts = () =>
      db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .execute()

    it('notification enqueue creates no immediate or scheduled artifacts', async () => {
      const q = queue()
      await db
        .transaction()
        .execute((trx) =>
          enqueueBookingNotifications(q, trx, { type: 'created', bookingId, start: START }, NOW),
        )
      expect(q.enqueue).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('booking_scheduled_messages')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it('scheduled enqueue independently refuses stale configured snapshots', async () => {
      const q = queue()
      await db.transaction().execute((trx) => enqueueScheduledBookingEmails(q, trx, bookingId, NOW))
      expect(q.enqueue).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('booking_scheduled_messages')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it.each(['confirmed', 'rescheduled', 'cancelled', 'reminder', 'conference_failed'] as const)(
      'notification policy refuses %s for imports',
      async (kind) => {
        expect(await conferenceNotificationAllowed(db, bookingId, kind, true)).toBe(false)
        await sendBookingNotification(deps, bookingId, kind)
        expect(sent).toEqual([])
        expect(await receipts()).toEqual([])
      },
    )
    it('sendOnce cannot mint manage links or send follow-up through a stale worker', async () => {
      const compose = vi.fn(() => ({
        to: 'synthetic@example.com',
        subject: 'Synthetic',
        text: 'Synthetic',
      }))
      expect(
        await sendOnce(
          deps,
          {
            bookingId,
            kind: 'follow_up',
            recipient: `attendee:${randomUUID()}`,
            email: 'synthetic@example.com',
            conferenceRevision: undefined,
          },
          true,
          compose,
          () => NOW,
          undefined,
          undefined,
        ),
      ).toBe('overtaken')
      expect(compose).not.toHaveBeenCalled()
      expect(sent).toEqual([])
      expect(await receipts()).toEqual([])
    })
    it('scheduled worker ignores seeded pending rows after restart without claims or receipts', async () => {
      const id = await message()
      await deliverScheduledBookingEmail(deps, id)
      expect(
        await db
          .selectFrom('booking_scheduled_messages')
          .select(['state', 'attempts'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'pending', attempts: 0 })
      expect(sent).toEqual([])
      expect(await receipts()).toEqual([])
    })
    it('scheduled repair never recreates queue jobs for seeded pending rows', async () => {
      const id = await message()
      const q = queue()
      await repairScheduledBookingEmails(deps, q)
      expect(q.enqueue).not.toHaveBeenCalled()
      expect(q.hasLiveScheduledBookingEmailJob).not.toHaveBeenCalled()
      expect(q.retireExpiredScheduledBookingEmailJobs).not.toHaveBeenCalled()
      expect(
        (
          await db
            .selectFrom('booking_scheduled_messages')
            .select('last_job_id')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).last_job_id,
      ).toBeNull()
    })
    it('conference outbox reaches ordinary mail behind 100 stale imported notices', async () => {
      const ids = Array.from({ length: 100 }, () => randomUUID())
      await db
        .insertInto('bookings')
        .values(
          ids.map((id) => ({
            id,
            organization_id: organizationId,
            start_at: START.toString(),
            end_at: START.add({ minutes: 30 }).toString(),
            title: 'Synthetic stale notice',
            source: 'import',
            import_questions: '[]',
            location: JSON.stringify({ kind: 'google_meet', autoCreate: true }),
          })),
        )
        .execute()
      const ordinary = await createFixtures(db).booking(
        organizationId,
        [userId],
        START.add({ hours: 1 }).toString(),
        START.add({ hours: 1, minutes: 30 }).toString(),
      )
      await db
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: 'google_meet', autoCreate: true }) })
        .where('id', '=', ordinary)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values(
          [...ids, ordinary].map((id) => ({
            root_booking_id: id,
            booking_id: id,
            organization_id: organizationId,
            organizer_user_id: userId,
            state: 'failed',
            error_code: 'provider_unavailable',
          })),
        )
        .execute()
      await db
        .insertInto('booking_conference_notifications')
        .values(
          [...ids, ordinary].map((id) => ({
            booking_id: id,
            kind: 'conference_failed',
            due_at: new Date(NOW.epochMilliseconds - (id === ordinary ? 0 : 1000)),
          })),
        )
        .execute()
      await dispatchConferenceNotifications(deps)
      expect(sent).toHaveLength(2)
      expect(
        (
          await db
            .selectFrom('booking_conference_notifications')
            .select('delivered')
            .where('booking_id', '=', ordinary)
            .executeTakeFirstOrThrow()
        ).delivered,
      ).toBe(true)
      expect(
        (
          await db
            .selectFrom('booking_conference_notifications')
            .select('attempts')
            .where('booking_id', 'in', ids)
            .execute()
        ).every((row) => row.attempts === 0),
      ).toBe(true)
      await dispatchConferenceNotifications(deps)
      expect(sent).toHaveLength(2)
    })
    it('conference outbox repair ignores seeded ready notices without delivery attempts', async () => {
      await db
        .updateTable('bookings')
        .set({
          location: JSON.stringify({
            kind: 'google_meet',
            autoCreate: true,
            url: 'https://meet.google.com/abc-defg-hij',
          }),
        })
        .where('id', '=', bookingId)
        .execute()
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: bookingId,
          booking_id: bookingId,
          organization_id: organizationId,
          organizer_user_id: userId,
          state: 'ready',
          applied_revision: 0,
        })
        .execute()
      await db
        .insertInto('booking_conference_notifications')
        .values({ booking_id: bookingId, kind: 'confirmed', due_at: NOW.toString() })
        .execute()
      await expect(dispatchConferenceNotifications(deps)).resolves.toBeUndefined()
      expect(
        await db
          .selectFrom('booking_conference_notifications')
          .select(['attempts', 'delivered', 'skipped_at'])
          .where('booking_id', '=', bookingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ attempts: 0, delivered: false, skipped_at: null })
      expect(sent).toEqual([])
      expect(await receipts()).toEqual([])
    })
  },
)
