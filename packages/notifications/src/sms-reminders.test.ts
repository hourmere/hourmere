import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import {
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bookingNotificationJob, bookingNotifier } from './index.ts'
import { scheduledBookingEmailJob } from './scheduled.ts'
import { createFakeSmsProvider, type SmsInput } from './sms-provider.ts'
import {
  bookingSmsReminderJob,
  deliverBookingSmsReminder,
  enqueueBookingSmsReminders,
  type SmsReminderQueue,
  smsReminderText,
} from './sms-reminders.ts'
import { createSmsService } from './sms-service.ts'

const now = Temporal.Instant.from('2030-03-09T17:00:00Z')
const start = now.add({ hours: 48 })
const payload = (bookingId: string) => ({
  bookingId,
  ruleId: 'default-24h',
  startAt: start.toString(),
  dueAt: start.subtract({ hours: 24 }).toString(),
})
const limits = {
  recipientPerHour: 100,
  recipientPerDay: 100,
  instancePerHour: 100,
  organizationPerDay: 100,
}
const secret = 'synthetic-reminder-secret-at-least-32-characters'

describe('SMS reminder text', () => {
  it.each(['en', 'zh-CN', 'de', 'fr', 'es', 'pt-BR'])(
    'localizes %s with business, local time and opt-out',
    (locale) => {
      const text = smsReminderText({
        business: 'Example Business',
        locale,
        timeZone: 'America/Los_Angeles',
        start: new Date(start.epochMilliseconds),
      })
      expect(text).toContain('Example Business')
      expect(text).toContain('STOP')
      expect(text.length).toBeLessThan(220)
      if (locale !== 'en') expect(text).not.toContain('Appointment reminder')
    },
  )
})

describe.skipIf(!process.env.DATABASE_URL)('booking SMS reminders', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let jobs: ReturnType<typeof createJobs>
  const fake = createFakeSmsProvider()
  const log = vi.fn()
  let service: ReturnType<typeof createSmsService>
  const deps = () => ({ db, sms: service, now: () => start.subtract({ hours: 24 }), log })
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'sms_reminders',
    })
    db = createDb(owned.pool)
    f = createFixtures(db)
    service = createSmsService({
      db,
      hashSecret: secret,
      provider: fake,
      limits: {
        recipientPerHour: 100,
        recipientPerDay: 100,
        instancePerHour: 100,
        organizationPerDay: 100,
      },
    })
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [
        bookingSmsReminderJob(deps()),
        bookingNotificationJob({
          db,
          secret,
          publicUrl: 'https://example.test',
          mailer: { send: async () => {} },
        }),
        scheduledBookingEmailJob({
          db,
          secret,
          publicUrl: 'https://example.test',
          mailer: { send: async () => {} },
        }),
      ],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
  })
  afterAll(async () => {
    await jobs?.stop()
    await owned?.drop()
  })
  async function setup(enabled = true, consent = true) {
    const host = await f.host()
    const eventTypeId = await f.eventType(host.organizationId, host.userId)
    const bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      start.toString(),
      start.add({ minutes: 30 }).toString(),
      { eventTypeId },
    )
    await sql`UPDATE bookings SET sms_reminders_enabled=${enabled} WHERE id=${bookingId}`.execute(
      db,
    )
    await sql`UPDATE booking_attendees SET sms_phone='+14155550123',sms_consent=${consent} WHERE booking_id=${bookingId}`.execute(
      db,
    )
    return bookingId
  }
  async function enqueue(bookingId: string) {
    await db
      .transaction()
      .execute((tx) => enqueueBookingSmsReminders(jobs as SmsReminderQueue, tx, bookingId, now))
  }
  it('queues through pg-boss at an absolute 24h across DST and sends once on replay', async () => {
    const id = await setup()
    await enqueue(id)
    const rows = await owned.pool.query(
      "SELECT data,start_after FROM pgboss.job WHERE name='booking-sms-reminder' AND data->>'bookingId'=$1",
      [id],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].start_after.toISOString()).toBe('2030-03-10T17:00:00.000Z')
    const before = fake.calls.length
    await deliverBookingSmsReminder(deps(), payload(id))
    await deliverBookingSmsReminder(deps(), payload(id))
    expect(fake.calls.length - before).toBe(1)
    expect(fake.calls.at(-1)?.to).toBe('+****23')
  })
  it('connects actual booking, rescheduling and cancellation to durable SMS jobs', async () => {
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventId = await f.eventType(host.organizationId, host.userId, { slug: 'sms-real' })
    await db
      .updateTable('event_types')
      .set({ sms_reminders_enabled: true })
      .where('id', '=', eventId)
      .execute()
    const ctx = { db, now: () => now, smsRemindersAvailable: true, notify: bookingNotifier(jobs) }
    const created = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'sms-real',
      start: Temporal.Instant.from('2030-03-11T10:00:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC', locale: 'en' },
      inviteePhone: '+1 (415) 555-0123',
      smsConsent: true,
    })
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('sms_reminders_enabled')
          .where('id', '=', created.booking.id)
          .executeTakeFirstOrThrow()
      ).sms_reminders_enabled,
    ).toBe(true)
    const queued = async (id: string) => {
      const rows = await owned.pool.query(
        "SELECT data FROM pgboss.job WHERE name='booking-sms-reminder' AND data->>'bookingId'=$1",
        [id],
      )
      expect(rows.rows).toHaveLength(1)
      return rows.rows[0].data
    }
    const original = await queued(created.booking.id)
    expect(JSON.stringify(original)).not.toContain('4155550123')
    const moved = await rescheduleManagedBooking(ctx, created.manageToken ?? undefined, {
      start: Temporal.Instant.from('2030-03-12T10:00:00Z'),
    })
    const replacement = await queued(moved.booking.id)
    const before = fake.calls.length
    await deliverBookingSmsReminder(
      { ...deps(), now: () => Temporal.Instant.from(original.dueAt) },
      original,
    )
    expect(fake.calls).toHaveLength(before)
    await deliverBookingSmsReminder(
      { ...deps(), now: () => Temporal.Instant.from(replacement.dueAt) },
      replacement,
    )
    await deliverBookingSmsReminder(
      { ...deps(), now: () => Temporal.Instant.from(replacement.dueAt) },
      replacement,
    )
    expect(fake.calls.length - before).toBe(1)
    const cancelled = await rescheduleManagedBooking(
      ctx,
      moved.manageToken ?? created.manageToken ?? undefined,
      { start: Temporal.Instant.from('2030-03-13T10:00:00Z') },
    )
    const last = await queued(cancelled.booking.id)
    await cancelManagedBooking(
      ctx,
      cancelled.manageToken ?? moved.manageToken ?? created.manageToken ?? undefined,
    )
    await deliverBookingSmsReminder(
      { ...deps(), now: () => Temporal.Instant.from(last.dueAt) },
      last,
    )
    expect(fake.calls.length - before).toBe(1)
  })
  it('never sends without affirmative consent or the booking snapshot switch', async () => {
    const before = fake.calls.length
    for (const id of [await setup(false), await setup(true, false)])
      await deliverBookingSmsReminder(deps(), payload(id))
    expect(fake.calls).toHaveLength(before)
  })
  it('cancellation and rescheduling make old jobs inert and queue a replacement', async () => {
    const cancelled = await setup()
    const old = await setup()
    await sql`UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id IN (${cancelled},${old})`.execute(
      db,
    )
    const replacement = await setup()
    await sql`UPDATE bookings SET rescheduled_from_id=${old} WHERE id=${replacement}`.execute(db)
    await enqueue(replacement)
    const before = fake.calls.length
    for (const id of [cancelled, old, replacement])
      await deliverBookingSmsReminder(deps(), payload(id))
    expect(fake.calls.length - before).toBe(1)
  })
  it('retains the booking switch after the event setting changes', async () => {
    const id = await setup()
    await sql`UPDATE event_types SET sms_reminders_enabled=false WHERE id=(SELECT event_type_id FROM bookings WHERE id=${id})`.execute(
      db,
    )
    const before = fake.calls.length
    await deliverBookingSmsReminder(deps(), payload(id))
    expect(fake.calls.length - before).toBe(1)
  })
  it('isolates provider failure and never logs the number or raw error', async () => {
    const id = await setup()
    const sms = createSmsService({
      db,
      hashSecret: secret,
      limits,
      provider: {
        async sendSms(_input: SmsInput) {
          throw new Error('secret +14155550123')
        },
      },
    })
    log.mockClear()
    await expect(
      deliverBookingSmsReminder({ ...deps(), sms }, payload(id)),
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('SMS reminder: sms_delivery_unknown')
    expect(JSON.stringify(log.mock.calls)).not.toContain('+14155550123')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
  it('preserves provider recipient limits', async () => {
    await deliverBookingSmsReminder(deps(), payload(await setup()))
    const id = await setup()
    const before = fake.calls.length
    const sms = createSmsService({
      db,
      hashSecret: secret,
      provider: fake,
      limits: { recipientPerHour: 1 },
    })
    await deliverBookingSmsReminder({ ...deps(), sms }, payload(id))
    expect(fake.calls).toHaveLength(before)
  })
  async function race(factory: typeof createSmsService) {
    const id = await setup()
    const provider = createFakeSmsProvider()
    const sms = factory({ db, hashSecret: secret, provider, limits })
    await deliverBookingSmsReminder(
      {
        ...deps(),
        sms: {
          async sendSms(input) {
            // A cancellation commits after loading the job but before the reservation fence.
            await sql`UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=${id}`.execute(
              db,
            )
            return sms.sendSms(input)
          },
        },
      },
      payload(id),
    )
    expect(provider.calls).toHaveLength(0)
  }
  it('rechecks booking eligibility inside the send reservation transaction', async () => {
    await race(createSmsService)
  })
  it('detects a source-copy mutation removing the final booking eligibility check', async () => {
    const source = await readFile(new URL('./sms-service.ts', import.meta.url), 'utf8')
    const guard = 'input.beforeReserve && !(await input.beforeReserve(tx))'
    expect(source).toContain(guard)
    const dir = await mkdtemp(
      fileURLToPath(new URL('../../../node_modules/.sms-reminder-mutation-', import.meta.url)),
    )
    try {
      const file = `${dir}/service.ts`
      await writeFile(
        file,
        source
          .replace(guard, 'false')
          .replaceAll(
            "'./sms-provider.ts'",
            JSON.stringify(new URL('./sms-provider.ts', import.meta.url).href),
          ),
      )
      const mutation = await import(file)
      await expect(race(mutation.createSmsService)).rejects.toThrow(/length/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
