import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer, MailMessage } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchConferenceNotifications,
  type NotificationDeps,
  type NotificationKind,
  sendBookingNotification,
} from './index.ts'
import {
  notificationEmailCleanupJob,
  notificationRecipientHash,
  purgeNotificationEmailSends,
} from './mail-limits.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00Z')
const EMAIL = 'ada@example.test'

describe.skipIf(!serverUrl)('durable notification mail limits (real PostgreSQL)', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let now = NOW
  let sent: MailMessage[]
  let logs: string[]
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
    now = NOW
    sent = []
    logs = []
  })
  const deps = (overrides: Partial<NotificationDeps> = {}): NotificationDeps => ({
    db,
    publicUrl: 'https://hourmere.example',
    now: () => now,
    log: (line) => logs.push(line),
    mailer: { send: async (message) => void sent.push(message) },
    ...overrides,
  })
  async function booked(guests = false, email = EMAIL) {
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'limits', allowGuests: guests })
    const result = await createPublicBooking(
      { db, now: () => NOW },
      {
        handle: host.handle,
        slug: 'limits',
        start: Temporal.Instant.from('2026-11-03T09:00Z'),
        invitee: { name: 'Synthetic Ada', email, timeZone: 'UTC' },
        guests: guests ? [{ name: 'Synthetic Guest', email: 'guest@example.test' }] : [],
      },
    )
    if (!result.manageToken) throw new Error('Synthetic booking needs a management token')
    return { id: result.booking.id, token: result.manageToken, host }
  }
  async function history(count: number, email: string | null = EMAIL, at = now) {
    if (!count) return
    await db
      .insertInto('notification_email_sends')
      .values(
        Array.from({ length: count }, () => ({
          recipient_hash: email === null ? null : notificationRecipientHash(email),
          sent_at: new Date(at.epochMilliseconds),
        })),
      )
      .execute()
  }
  const receipts = (id: string) =>
    db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', id)
      .orderBy('recipient')
      .execute()
  const ledger = () => db.selectFrom('notification_email_sends').selectAll().execute()

  it('sends the fifth normalized recipient email, then suppresses the sixth across bookings', async () => {
    await history(4, '  ADA@EXAMPLE.TEST ')
    const first = await booked(false, 'Ada@Example.Test')
    await sendBookingNotification(deps(), first.id, 'confirmed')
    expect(sent).toHaveLength(2)
    const second = await booked()
    await sendBookingNotification(deps(), second.id, 'confirmed')
    expect(sent).toHaveLength(3)
    expect(
      (await receipts(second.id)).find((r) => r.recipient.startsWith('attendee:')),
    ).toMatchObject({
      outcome: 'suppressed',
      suppression_reason: 'recipient_hourly_limit',
      manage_token_hash: null,
    })
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'warn',
        event: 'notification_email_suppressed',
        bookingId: second.id,
        kind: 'confirmed',
        reason: 'recipient_hourly_limit',
        recipientHash: notificationRecipientHash(EMAIL).toString('hex'),
      },
    ])
    expect(logs.join('\n')).not.toMatch(/ada@|example\.test/i)
    expect((await ledger()).filter((r) => r.recipient_hash === null)).toHaveLength(2)
  })

  it.each(['confirmed', 'rescheduled', 'cancelled', 'reminder'] as const)(
    'suppresses invitee and guest %s mail while delivering the host',
    async (kind: NotificationKind) => {
      const original = await booked(true)
      let id = original.id
      if (kind === 'rescheduled') {
        const moved = await rescheduleManagedBooking({ db, now: () => now }, original.token, {
          start: Temporal.Instant.from('2026-11-03T10:00Z'),
        })
        id = moved.booking.id
      } else if (kind === 'cancelled')
        await cancelManagedBooking({ db, now: () => now }, original.token)
      await history(5)
      await history(5, 'guest@example.test')
      await sendBookingNotification(deps(), id, kind)
      expect(sent).toHaveLength(1)
      const rows = await receipts(id)
      expect(rows.filter((row) => row.outcome === 'suppressed')).toHaveLength(2)
      expect(rows.find((row) => row.recipient.startsWith('host:'))?.outcome).toBe('sent')
    },
  )

  it('enforces the daily rolling window independently of the hourly window', async () => {
    await history(19, EMAIL, now.subtract({ hours: 2 }))
    await history(5, EMAIL, now.subtract({ hours: 24 }))
    const first = await booked()
    await sendBookingNotification(deps(), first.id, 'confirmed')
    const second = await booked()
    await sendBookingNotification(deps(), second.id, 'confirmed')
    expect(sent).toHaveLength(3)
    expect((await receipts(second.id)).find((r) => r.outcome === 'suppressed')).toMatchObject({
      suppression_reason: 'recipient_daily_limit',
    })
  })

  it('excludes sends exactly one hour old from the hourly window', async () => {
    await history(5, EMAIL, now.subtract({ hours: 1 }))
    const { id } = await booked()
    await sendBookingNotification(deps(), id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect(logs).toEqual([])
  })

  it('suppresses invitees at the instance cap and reserves the last twenty percent for hosts', async () => {
    await history(99, null)
    const first = await booked()
    await sendBookingNotification(deps(), first.id, 'confirmed')
    expect(sent).toHaveLength(1)
    expect((await receipts(first.id)).find((r) => r.outcome === 'suppressed')).toMatchObject({
      suppression_reason: 'instance_hourly_limit',
    })
    await history(19, null)
    const second = await booked(false, 'second@example.test')
    await sendBookingNotification(deps(), second.id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect((await ledger()).length).toBe(120)
    const third = await booked(false, 'third@example.test')
    await sendBookingNotification(deps(), third.id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect((await receipts(third.id)).every((row) => row.outcome === 'suppressed')).toBe(true)
    expect(logs.map((line) => JSON.parse(line).reason)).toEqual(
      Array.from({ length: 4 }, () => 'instance_hourly_limit'),
    )
  })

  it('disables the instance cap with zero while retaining the recipient cap', async () => {
    await history(150, null)
    await history(5)
    const { id } = await booked()
    await sendBookingNotification(deps({ mailMaxPerHour: 0 }), id, 'confirmed')
    expect(sent).toHaveLength(1)
    expect((await receipts(id)).find((r) => r.outcome === 'suppressed')?.suppression_reason).toBe(
      'recipient_hourly_limit',
    )
  })

  it('does not resend a suppressed recipient when a later failed guest retries after the window', async () => {
    await history(5)
    const { id } = await booked(true)
    let fail = true
    const mailer: Mailer = {
      async send(message) {
        if (fail && message.to === 'guest@example.test') throw new Error('Synthetic SMTP failure')
        sent.push(message)
      },
    }
    await expect(sendBookingNotification(deps({ mailer }), id, 'confirmed')).rejects.toThrow(
      'Synthetic SMTP failure',
    )
    expect(sent).toHaveLength(1)
    expect(await receipts(id)).toHaveLength(2)
    fail = false
    now = now.add({ hours: 2 })
    await sendBookingNotification(deps({ mailer }), id, 'confirmed')
    await sendBookingNotification(deps({ mailer }), id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect(sent.some((message) => message.to === EMAIL)).toBe(false)
    expect(logs).toHaveLength(1)
    expect(await receipts(id)).toHaveLength(3)
    // Only actual successful SMTP deliveries consume slots; the failed attempt rolls back.
    expect(await ledger()).toHaveLength(7)
  })

  it.each(['recipient', 'instance'] as const)(
    'serializes concurrent workers spending the last %s slot',
    async (budget) => {
      const first = await booked()
      const second = await booked()
      await history(budget === 'recipient' ? 4 : 98, budget === 'recipient' ? EMAIL : null)
      const config = deps({
        mailMaxPerHour: budget === 'recipient' ? 0 : 100,
        mailer: {
          async send(message) {
            // Give the other worker time to race its check before this SMTP acceptance.
            await new Promise((resolve) => setTimeout(resolve, 30))
            sent.push(message)
          },
        },
      })
      await Promise.all([
        sendBookingNotification(config, first.id, 'confirmed'),
        sendBookingNotification(config, second.id, 'confirmed'),
      ])
      expect(sent.filter((message) => message.to === EMAIL)).toHaveLength(
        budget === 'recipient' ? 1 : 0,
      )
      expect(sent).toHaveLength(budget === 'recipient' ? 3 : 2)
      expect((await receipts(first.id)).concat(await receipts(second.id))).toHaveLength(4)
    },
  )

  it('retains recipient accounting when a booking is deleted', async () => {
    const first = await booked()
    await sendBookingNotification(deps(), first.id, 'confirmed')
    await db.deleteFrom('bookings').where('id', '=', first.id).execute()
    expect(await ledger()).toHaveLength(2)
    const second = await booked()
    await sendBookingNotification(deps({ mailRecipientMaxPerHour: 1 }), second.id, 'confirmed')
    expect(sent).toHaveLength(3)
    expect((await receipts(second.id)).find((r) => r.outcome === 'suppressed')).toBeDefined()
  })

  it('finishes a suppressed conference outbox without retrying it later', async () => {
    const { id, host } = await booked()
    await db
      .updateTable('bookings')
      .set({ location: { kind: 'google_meet', autoCreate: true } })
      .where('id', '=', id)
      .execute()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: id,
        booking_id: id,
        organization_id: host.organizationId,
        organizer_user_id: host.userId,
        state: 'failed',
        error_code: 'provider_unavailable',
      })
      .execute()
    await db
      .insertInto('booking_conference_notifications')
      .values({
        booking_id: id,
        kind: 'conference_failed',
        due_at: new Date(now.epochMilliseconds),
      })
      .execute()
    await history(120, null)
    await dispatchConferenceNotifications(deps())
    now = now.add({ hours: 2 })
    await dispatchConferenceNotifications(deps())
    expect(sent).toHaveLength(0)
    expect(await receipts(id)).toHaveLength(2)
    expect((await receipts(id)).every((row) => row.outcome === 'suppressed')).toBe(true)
    expect(
      await db
        .selectFrom('booking_conference_notifications')
        .select(['delivered', 'attempts', 'last_error', 'exhausted_at'])
        .where('booking_id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ delivered: true, attempts: 1, last_error: null, exhausted_at: null })
  })

  it('purges only accounting older than two days and schedules the cleanup', async () => {
    await history(1, EMAIL, now.subtract({ hours: 48 }).subtract({ milliseconds: 1 }))
    await history(1, EMAIL, now.subtract({ hours: 48 }))
    await history(1, null)
    expect(
      (await purgeNotificationEmailSends(db, new Date(now.epochMilliseconds))).numDeletedRows,
    ).toBe(1n)
    expect(await ledger()).toHaveLength(2)
    const job = notificationEmailCleanupJob({ db, now: () => now })
    expect(job.name).toBe('notification-email-cleanup')
    expect(job.schedule).toEqual({ cron: '17 * * * *', payload: {} })
    now = now.add({ hours: 49 })
    await job.handler(
      {},
      { id: 'synthetic-cleanup', attempt: 1, signal: new AbortController().signal },
    )
    expect(await ledger()).toHaveLength(0)
    expect((await purgeNotificationEmailSends(db)).numDeletedRows).toBe(0n)
  })
})
