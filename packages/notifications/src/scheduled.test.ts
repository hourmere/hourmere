import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { type MailMessage, MailRejectedError } from '@hourmere/mail'
import {
  createNotificationSnapshot,
  type NotificationSettings,
} from '@hourmere/scheduling/notification-settings'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bookingNotificationJob,
  conferenceNotificationAllowed,
  enqueueBookingNotifications,
  type NotificationDeps,
  sendBookingNotification,
} from './index.ts'
import { lockNotificationEmailBudget } from './mail-limits.ts'
import {
  deliverScheduledBookingEmail,
  repairScheduledBookingEmails,
  type ScheduledEmailQueue,
  scheduledBookingEmailJob,
} from './scheduled.ts'

const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const START = NOW.add({ hours: 72 })
const END = START.add({ minutes: 30 })
const roles = { host: true, invitee: true, guests: true }
const rule = (id: string, offsetMinutes: number, recipients = roles) => ({
  id,
  offsetMinutes,
  recipients,
})
const policy = (offsets = [1440, 120]): NotificationSettings => ({
  reminders: offsets.map((v, i) => rule(`r${i}`, v)),
  followUps: [],
})
const date = (v: Temporal.Instant) => new Date(v.epochMilliseconds)
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected fixture row')
  return value
}
const firstTwo = <T>(rows: T[]): [T, T] => [required(rows[0]), required(rows[1])]

describe.skipIf(!process.env.DATABASE_URL)('durable configured booking messages', () => {
  let fixture: TestDatabase
  let db: Db
  let f: Fixtures
  let jobs: ReturnType<typeof createJobs>
  let sent: MailMessage[]
  let now: Temporal.Instant
  let deps: NotificationDeps
  let during: ((m: MailMessage) => Promise<void>) | undefined
  let refuse: ((m: MailMessage) => void) | undefined
  const queue = (): ScheduledEmailQueue => jobs as ScheduledEmailQueue
  beforeAll(async () => {
    fixture = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'scheduled_mail',
    })
    db = createDb(fixture.pool)
    f = createFixtures(db)
    deps = {
      db,
      mailer: {
        async send(m) {
          await during?.(m)
          refuse?.(m)
          sent.push(m)
        },
      },
      secret: 'synthetic-schedule-secret',
      publicUrl: 'https://schedule.example.com',
      now: () => now,
      log: () => {},
    }
    jobs = createJobs({
      connectionString: fixture.url,
      definitions: [bookingNotificationJob(deps), scheduledBookingEmailJob(deps)],
      work: false,
      migrate: true,
      maxConnections: 2,
      log: () => {},
    })
    await jobs.start()
  })
  afterAll(async () => {
    await jobs?.stop()
    await fixture?.drop()
  })
  beforeEach(async () => {
    sent = []
    now = NOW
    during = undefined
    refuse = undefined
    await db.deleteFrom('notification_email_sends').execute()
  })
  async function setup(settings = policy(), start = START, end = END, guests = false) {
    const host = await f.host()
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      questions: [{ id: 'answer', label: 'Private answer' }],
    })
    const bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      start.toString(),
      end.toString(),
      { eventTypeId },
    )
    await db
      .updateTable('bookings')
      .set({
        notification_snapshot: JSON.stringify(createNotificationSnapshot(settings)),
        responses: JSON.stringify({ answer: 'Secret detail' }),
      })
      .where('id', '=', bookingId)
      .execute()
    if (guests)
      await db
        .insertInto('booking_attendees')
        .values({
          booking_id: bookingId,
          name: 'Guest',
          email: `guest-${randomUUID()}@example.com`,
          is_booker: false,
          time_zone: 'Europe/Berlin',
        })
        .execute()
    await db
      .transaction()
      .execute((trx) =>
        enqueueBookingNotifications(jobs, trx, { type: 'created', bookingId, start }, now),
      )
    return { bookingId, host, eventTypeId }
  }
  const rows = (bookingId: string) =>
    db
      .selectFrom('booking_scheduled_messages')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('due_at')
      .execute()
  async function run(id: string, at?: Temporal.Instant) {
    if (at) now = at
    await deliverScheduledBookingEmail(deps, id)
  }
  const receipts = (id: string) =>
    db.selectFrom('booking_notifications').selectAll().where('booking_id', '=', id).execute()
  it('sends all five reminders and three follow-ups independently and retains rule identity', async () => {
    const settings = {
      reminders: [3000, 2000, 1000, 600, 120].map((v, i) => rule(`before-${i}`, v)),
      followUps: [5, 60, 120].map((v, i) => rule(`after-${i}`, v)),
    }
    const { bookingId } = await setup(settings, START, END, true)
    const messages = await rows(bookingId)
    expect(messages).toHaveLength(8)
    expect(
      (
        await fixture.pool.query(
          `SELECT data FROM pgboss.job WHERE name='scheduled-booking-email' AND data->>'messageId'=ANY($1::text[])`,
          [messages.map((r) => r.id)],
        )
      ).rows.map((r) => r.data),
    ).toEqual(expect.arrayContaining(messages.map((r) => ({ messageId: r.id }))))
    for (const m of messages)
      await run(m.id, Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime()))
    expect(sent).toHaveLength(24)
    expect((await receipts(bookingId)).map((r) => r.message_key).sort()).toEqual(
      messages.flatMap((m) => [m.rule_id, m.rule_id, m.rule_id]).sort(),
    )
    expect((await rows(bookingId)).every((r) => r.state === 'completed' && r.attempts === 1)).toBe(
      true,
    )
    await Promise.all(messages.map((m) => deliverScheduledBookingEmail(deps, m.id)))
    expect(sent).toHaveLength(24)
    expect(sent.every((m) => !m.attachments)).toBe(true)
    const followups = sent.filter((m) => m.subject.includes('Scheduled meeting time ended'))
    expect(followups).toHaveLength(9)
    expect(
      followups.every((m) => !m.text.includes('#token=') && !m.text.includes('Secret detail')),
    ).toBe(true)
  })
  it('keeps strict reminder equality and records ineligible rows without catch-up', async () => {
    const start = NOW.add({ hours: 25 })
    const { bookingId } = await setup(
      { reminders: [rule('equal', 1440), rule('past', 2000), rule('valid', 1439)], followUps: [] },
      start,
      start.add({ minutes: 30 }),
    )
    const result = await rows(bookingId)
    expect(result.find((r) => r.rule_id === 'equal')).toMatchObject({
      state: 'skipped',
      skip_reason: 'minimum_gap',
      attempts: 0,
    })
    expect(result.find((r) => r.rule_id === 'past')).toMatchObject({
      state: 'skipped',
      skip_reason: 'offset_not_future',
    })
    expect(result.find((r) => r.rule_id === 'valid')).toMatchObject({ state: 'pending' })
    await run(result.find((r) => r.rule_id === 'equal')?.id as string, start.subtract({ hours: 1 }))
    expect(sent).toEqual([])
  })
  it('rolls schedule and jobs back with the booking transaction and rejects a null new singleton', async () => {
    const host = await f.host()
    const bookingId = await f.booking(
      host.organizationId,
      [host.userId],
      START.toString(),
      END.toString(),
    )
    await db
      .updateTable('bookings')
      .set({ notification_snapshot: JSON.stringify(createNotificationSnapshot(policy())) })
      .where('id', '=', bookingId)
      .execute()
    const beforeJobs = Number(
      (
        await fixture.pool.query(
          `SELECT count(*) FROM pgboss.job WHERE name='scheduled-booking-email'`,
        )
      ).rows[0].count,
    )
    const schedule = () =>
      db.transaction().execute(async (trx) => {
        await enqueueBookingNotifications(
          jobs,
          trx,
          { type: 'created', bookingId, start: START },
          now,
        )
        throw Error('rollback')
      })
    await expect(schedule()).rejects.toThrow('rollback')
    expect(await rows(bookingId)).toEqual([])
    expect(
      Number(
        (
          await fixture.pool.query(
            `SELECT count(*) FROM pgboss.job WHERE name='scheduled-booking-email'`,
          )
        ).rows[0].count,
      ),
    ).toBe(beforeJobs)
    expect(
      (
        await fixture.pool.query(`SELECT id FROM pgboss.job WHERE data->>'bookingId'=$1`, [
          bookingId,
        ])
      ).rows,
    ).toEqual([])
    const nullQueue = { enqueue: async () => null }
    await expect(
      db
        .transaction()
        .execute((trx) =>
          enqueueBookingNotifications(
            nullQueue,
            trx,
            { type: 'created', bookingId, start: START },
            now,
          ),
        ),
    ).rejects.toThrow('exact new job identity')
    expect(await rows(bookingId)).toEqual([])
  })
  it('ignores early wakes and live duplicate claims without incrementing attempts', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    await run(m.id)
    expect((await rows(bookingId))[0]).toMatchObject({ attempts: 0, state: 'pending' })
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => (entered = r))
    const hold = new Promise<void>((r) => (release = r))
    during = async () => {
      entered()
      await hold
    }
    now = Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime())
    const first = run(m.id)
    await started
    await run(m.id)
    expect((await rows(bookingId))[0]).toMatchObject({ attempts: 1, state: 'processing' })
    release()
    await first
    expect(sent).toHaveLength(2)
    expect((await rows(bookingId))[0]).toMatchObject({ attempts: 1, state: 'completed' })
  })
  it('retries only missing recipients, preserves permanent rejection and bounds all-permanent failures', async () => {
    const { bookingId } = await setup(policy(), START, END, true)
    const m = required((await rows(bookingId))[0])
    let rejected = false
    refuse = (message) => {
      if (message.to.startsWith('guest-')) {
        rejected = true
        throw new MailRejectedError({ atRecipient: true, responseCode: 550, enhancedCode: '5.1.1' })
      }
    }
    await run(m.id, Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime()))
    expect(rejected).toBe(true)
    expect(sent).toHaveLength(2)
    expect((await receipts(bookingId)).filter((r) => r.outcome === 'rejected')).toHaveLength(1)
    await run(m.id)
    expect(sent).toHaveLength(2)
    const { bookingId: all } = await setup({
      reminders: [rule('one', 120, { host: false, invitee: true, guests: false })],
      followUps: [],
    })
    const one = required((await rows(all))[0])
    refuse = () => {
      throw new MailRejectedError({ atRecipient: true, responseCode: 550, enhancedCode: '5.1.1' })
    }
    await run(one.id, Temporal.Instant.fromEpochMilliseconds(one.due_at.getTime()))
    expect((await rows(all))[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(await receipts(all)).toEqual([])
    refuse = undefined
    now = now.add({ minutes: 1 })
    await run(one.id)
    expect((await rows(all))[0]).toMatchObject({ state: 'completed', attempts: 2 })
  })
  it('keeps follow-up on its end-based window and expires at exactly due plus 24 hours', async () => {
    const { bookingId } = await setup({
      reminders: [],
      followUps: [rule('ended', 5), rule('expire', 10)],
    })
    const [one, two] = firstTwo(await rows(bookingId))
    await run(one.id, END)
    expect(sent).toEqual([])
    expect((await rows(bookingId))[0]?.attempts).toBe(0)
    await run(one.id, END.add({ minutes: 5 }))
    expect(sent).toHaveLength(2)
    await run(two.id, END.add({ minutes: 10, hours: 24 }))
    expect((await rows(bookingId))[1]).toMatchObject({
      state: 'skipped',
      skip_reason: 'delivery_window_expired',
      attempts: 0,
    })
  })
  it.each(['cancel', 'anchor'] as const)(
    'rechecks %s after waiting for the shared budget lock',
    async (action) => {
      const { bookingId } = await setup({
        reminders: [],
        followUps: [rule('after', 5, { host: false, invitee: true, guests: false })],
      })
      const m = required((await rows(bookingId))[0])
      now = END.add({ minutes: 5 })
      let held!: () => void
      let release!: () => void
      const acquired = new Promise<void>((r) => (held = r))
      const wait = new Promise<void>((r) => (release = r))
      const blocker = db.transaction().execute(async (trx) => {
        await lockNotificationEmailBudget(trx)
        held()
        await wait
      })
      await acquired
      const pending = run(m.id)
      let waiting = false
      for (let i = 0; i < 500; i++) {
        const count = await fixture.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
        )
        if ((count.rows[0]?.n ?? 0) > 0) {
          waiting = true
          break
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(waiting).toBe(true)
      if (action === 'cancel')
        await db
          .updateTable('bookings')
          .set({ status: 'cancelled', cancelled_at: date(now) })
          .where('id', '=', bookingId)
          .execute()
      else
        await db
          .updateTable('bookings')
          .set({ end_at: date(END.add({ minutes: 1 })) })
          .where('id', '=', bookingId)
          .execute()
      release()
      await blocker
      await pending
      expect(sent).toEqual([])
      expect(await receipts(bookingId)).toEqual([])
      expect((await rows(bookingId))[0]).toMatchObject({
        state: 'skipped',
        skip_reason: action === 'cancel' ? 'booking_cancelled' : 'anchor_changed',
      })
    },
  )
  it('suppression is terminal per rule and later offsets remain independent', async () => {
    const { bookingId } = await setup({
      reminders: [
        rule('a', 120, { host: false, invitee: true, guests: false }),
        rule('b', 60, { host: false, invitee: true, guests: false }),
      ],
      followUps: [],
    })
    const [one, two] = firstTwo(await rows(bookingId))
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: null, sent_at: date(START.subtract({ minutes: 121 })) })
      .execute()
    const limits = { ...deps, mailMaxPerHour: 1 }
    now = START.subtract({ minutes: 120 })
    await deliverScheduledBookingEmail(limits, one.id)
    expect((await receipts(bookingId))[0]).toMatchObject({
      message_key: 'a',
      outcome: 'suppressed',
      manage_token_hash: null,
    })
    await db
      .updateTable('booking_scheduled_messages')
      .set({ state: 'pending' })
      .where('id', '=', one.id)
      .execute()
    now = START.subtract({ minutes: 60 })
    await deliverScheduledBookingEmail({ ...deps, mailMaxPerHour: 0 }, one.id)
    expect(sent).toEqual([])
    await deliverScheduledBookingEmail({ ...deps, mailMaxPerHour: 0 }, two.id)
    expect(sent).toHaveLength(1)
    expect((await receipts(bookingId)).find((r) => r.message_key === 'a')?.outcome).toBe(
      'suppressed',
    )
  })
  it('repairs lost jobs without resetting attempts and retires a crashed final claim', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    now = Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime())
    await fixture.pool.query(
      `UPDATE pgboss.job SET state='completed',completed_on=pgboss.job_now() WHERE id=$1`,
      [m.last_job_id],
    )
    await db
      .updateTable('booking_scheduled_messages')
      .set({ attempts: 12 })
      .where('id', '=', m.id)
      .execute()
    await repairScheduledBookingEmails(deps, queue())
    const repaired = required((await rows(bookingId))[0])
    expect(repaired.attempts).toBe(12)
    expect(repaired.last_job_id).not.toBe(m.last_job_id)
    expect(
      await jobs.hasLiveScheduledBookingEmailJob({ id: m.last_job_id as string, messageId: m.id }),
    ).toBe(false)
    expect(
      await jobs.hasLiveScheduledBookingEmailJob({
        id: repaired.last_job_id as string,
        messageId: m.id,
      }),
    ).toBe(true)
    await db
      .updateTable('booking_scheduled_messages')
      .set({
        state: 'processing',
        attempts: 13,
        claim_token: randomUUID(),
        lease_until: new Date(0),
      })
      .where('id', '=', m.id)
      .execute()
    await repairScheduledBookingEmails(deps, queue())
    expect((await rows(bookingId))[0]).toMatchObject({
      attempts: 13,
      state: 'failed',
      claim_token: null,
      lease_until: null,
    })
    await run(m.id)
    expect(sent).toEqual([])
  })
  it('rejects stale legacy reminder jobs and legacy conference-outbox paths for custom snapshots', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    now = Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime())
    expect(await conferenceNotificationAllowed(db, bookingId, 'reminder')).toBe(false)
    await sendBookingNotification(deps, bookingId, 'reminder')
    expect(sent).toEqual([])
    await run(m.id)
    expect(sent).toHaveLength(2)
    expect((await receipts(bookingId)).every((r) => r.message_key !== '')).toBe(true)
  })
  it('a stale completion cannot overwrite a successor claim or resend completed recipients', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    const successor = randomUUID()
    let changed = false
    during = async () => {
      if (changed) return
      changed = true
      await db
        .updateTable('booking_scheduled_messages')
        .set({ attempts: 2, claim_token: successor })
        .where('id', '=', m.id)
        .execute()
    }
    await run(m.id, Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime()))
    expect(sent).toHaveLength(1)
    expect((await rows(bookingId))[0]).toMatchObject({
      state: 'processing',
      attempts: 2,
      claim_token: successor,
    })
    during = undefined
    await db
      .updateTable('booking_scheduled_messages')
      .set({ lease_until: new Date(0) })
      .where('id', '=', m.id)
      .execute()
    await run(m.id)
    expect((await rows(bookingId))[0]).toMatchObject({
      state: 'processing',
      attempts: 2,
      claim_token: successor,
    })
    expect(sent).toHaveLength(1)
    now = now.add({ minutes: 1 })
    await run(m.id)
    expect(sent).toHaveLength(2)
    expect((await rows(bookingId))[0]).toMatchObject({
      state: 'completed',
      attempts: 3,
      claim_token: null,
    })
  })
  it('a transient final attempt is terminal and repair cannot start a fourteenth send', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    await db
      .updateTable('booking_scheduled_messages')
      .set({ attempts: 12 })
      .where('id', '=', m.id)
      .execute()
    refuse = () => {
      throw Error('Synthetic transport unavailable')
    }
    await run(m.id, Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime()))
    expect((await rows(bookingId))[0]).toMatchObject({
      state: 'failed',
      attempts: 13,
      error_code: 'delivery_failed',
    })
    refuse = undefined
    now = now.add({ hours: 1 })
    await repairScheduledBookingEmails(deps, queue())
    await run(m.id)
    expect((await rows(bookingId))[0]).toMatchObject({ state: 'failed', attempts: 13 })
    expect(sent).toEqual([])
  })
  it('an invalid missing snapshot rule is a terminal configuration failure', async () => {
    const { bookingId } = await setup()
    const m = required((await rows(bookingId))[0])
    await db
      .updateTable('bookings')
      .set({
        notification_snapshot: JSON.stringify(
          createNotificationSnapshot({ reminders: [], followUps: [] }),
        ),
      })
      .where('id', '=', bookingId)
      .execute()
    await run(m.id, Temporal.Instant.fromEpochMilliseconds(m.due_at.getTime()))
    expect((await rows(bookingId))[0]).toMatchObject({ state: 'failed', attempts: 1 })
    expect(sent).toEqual([])
  })
  it('reminders expire at start while neutral follow-ups skip an unavailable organizer', async () => {
    const { bookingId, host } = await setup({
      reminders: [rule('before', 120)],
      followUps: [rule('after', 5)],
    })
    const [before, after] = firstTwo(await rows(bookingId))
    await run(before.id, START)
    expect((await rows(bookingId))[0]).toMatchObject({
      state: 'skipped',
      skip_reason: 'meeting_started',
      attempts: 0,
    })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', host.userId)
      .execute()
    await run(after.id, END.add({ minutes: 5 }))
    expect((await rows(bookingId))[1]).toMatchObject({
      state: 'skipped',
      skip_reason: 'no_organizer',
      attempts: 1,
    })
    expect(sent).toEqual([])
  })
  it('fair bounded repair progresses past a poison singleton across more than 100 rows', async () => {
    const host = await f.host()
    const settings = { reminders: [rule('fair', 120)], followUps: [] }
    const bookings = await db
      .insertInto('bookings')
      .values(
        Array.from({ length: 101 }, () => ({
          organization_id: host.organizationId,
          start_at: date(START),
          end_at: date(END),
          title: 'Fair repair',
          manage_token_hash: Buffer.from(randomUUID()),
          source: 'api',
          notification_snapshot: JSON.stringify(createNotificationSnapshot(settings)),
        })),
      )
      .returning('id')
      .execute()
    const ids = bookings.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
    await db
      .insertInto('booking_scheduled_messages')
      .values(
        bookings.map((booking, i) => ({
          id: ids[i] as string,
          organization_id: host.organizationId,
          booking_id: booking.id,
          kind: 'reminder',
          rule_id: 'fair',
          anchor_start_at: date(START),
          anchor_end_at: date(END),
          due_at: date(NOW),
          expires_at: date(START),
          next_attempt_at: date(NOW),
        })),
      )
      .execute()
    const enqueued: string[] = []
    const repaired: ScheduledEmailQueue = {
      enqueue: async (_name, { messageId }) => {
        if (messageId === ids[0]) return null
        enqueued.push(messageId)
        return randomUUID()
      },
      hasLiveScheduledBookingEmailJob: async () => false,
      retireExpiredScheduledBookingEmailJobs: async () => {},
    }
    await repairScheduledBookingEmails(deps, repaired)
    expect(enqueued).toHaveLength(99)
    await repairScheduledBookingEmails(deps, repaired)
    expect(enqueued).toHaveLength(100)
    expect(enqueued).toContain(ids[100])
    expect(
      await db
        .selectFrom('booking_scheduled_messages')
        .selectAll()
        .where('id', '=', ids[0] as string)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'pending', attempts: 0, last_job_id: null })
  })
  it.each([
    ['America/Los_Angeles', '2026-03-08T10:30:00Z'],
    ['America/Los_Angeles', '2026-11-01T09:30:00Z'],
    ['Europe/Berlin', '2026-03-29T01:30:00Z'],
    ['Europe/Berlin', '2026-10-25T01:30:00Z'],
  ])('uses elapsed minutes across both DST directions in %s at %s', async (zone, startText) => {
    const start = Temporal.Instant.from(startText)
    now = start.subtract({ hours: 50 })
    const { bookingId } = await setup(
      { reminders: [rule('absolute-before', 1440)], followUps: [rule('absolute-after', 1440)] },
      start,
      start.add({ minutes: 30 }),
    )
    await db
      .updateTable('booking_attendees')
      .set({ time_zone: zone, locale: 'zh-CN' })
      .where('booking_id', '=', bookingId)
      .execute()
    const [before, after] = firstTwo(await rows(bookingId))
    expect(before.due_at.toISOString()).toBe(
      new Date(start.epochMilliseconds - 86400000).toISOString(),
    )
    expect(after.due_at.toISOString()).toBe(
      new Date(start.epochMilliseconds + 1800000 + 86400000).toISOString(),
    )
    expect(before.due_at.getTime()).toBe(start.epochMilliseconds - 1440 * 60000)
    expect(after.due_at.getTime()).toBe(start.epochMilliseconds + 30 * 60000 + 1440 * 60000)
    await run(before.id, Temporal.Instant.fromEpochMilliseconds(before.due_at.getTime()))
    await run(after.id, Temporal.Instant.fromEpochMilliseconds(after.due_at.getTime()))
    expect(sent.some((m) => m.subject.startsWith('会议时间已结束：'))).toBe(true)
  })
})
