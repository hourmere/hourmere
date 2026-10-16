// Booking notifications against a throwaway database, with bookings made by the real booking
// services: who gets which email, at most once, and only while it is still true.
import { createHash } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { type Mailer, type MailMessage, MailRejectedError } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  getManagedBooking,
  type PublicContext,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import ICAL from 'ical.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotificationJob,
  enqueueBookingNotifications,
  type NotificationDeps,
  NotificationRetryError,
  sendBookingNotification,
} from './index.ts'

const serverUrl = process.env.DATABASE_URL
const instant = (iso: string) => Temporal.Instant.from(iso)
// Sunday; the host's Berlin schedule offers Monday and Tuesday 09:00–17:00 (08:00Z–16:00Z).
const NOW = instant('2026-11-01T12:00:00Z')
const START = '2026-11-03T09:00:00Z'
const PUBLIC_URL = 'https://cal.example.com'

/**
 * Records what it sends. `hold` makes sends wait (until the signal aborts), `failFor` makes
 * sends to an address fail like an unreachable server, `refuse` like a server refusing it.
 */
function testMailer() {
  const sent: MailMessage[] = []
  const state: {
    failFor?: string
    refuse: Map<string, number>
    hold?: Promise<void>
    started?: () => void
    aborted: number
  } = { refuse: new Map(), aborted: 0 }
  const mailer: Mailer = {
    async send(message, { signal } = {}) {
      state.started?.()
      if (state.hold) {
        await new Promise<void>((resolve, reject) => {
          state.hold?.then(resolve)
          signal?.addEventListener('abort', () => {
            state.aborted++
            reject(signal.reason)
          })
        })
      }
      if (message.to === state.failFor) throw new Error(`mailbox ${message.to} unavailable`)
      const code = state.refuse.get(message.to)
      if (code) throw new MailRejectedError(code)
      sent.push(message)
    },
  }
  return { mailer, sent, state }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest()
const tokenIn = (message: MailMessage | undefined) =>
  message?.text.match(/#token=([A-Za-z0-9_-]+)&action=reschedule/)?.[1]

function invitation(message: MailMessage | undefined) {
  const content = message?.attachments?.[0]?.content
  if (!content) return undefined
  const calendar = new ICAL.Component(ICAL.parse(content))
  const event = calendar.getFirstSubcomponent('vevent')
  return {
    method: calendar.getFirstPropertyValue('method'),
    uid: event?.getFirstPropertyValue('uid'),
    sequence: event?.getFirstPropertyValue('sequence'),
    summary: event?.getFirstPropertyValue('summary'),
    location: event?.getFirstPropertyValue('location'),
  }
}

describe.skipIf(!serverUrl)('booking notifications', () => {
  let testDb: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  /** A Berlin-scheduled host in New York with one event type, booked by Ada from Tokyo. */
  async function booked(options: { guests?: boolean } = {}) {
    const host = await f.host({ name: 'Grace Hopper', timeZone: 'America/New_York' })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      title: 'Intro call',
      location: { kind: 'link', url: 'https://meet.example.com/abc' },
      questions: [
        { id: 'topic', label: 'What should we talk about?', type: 'long_text', required: false },
      ],
    })
    const result = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'intro',
      start: instant(START),
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'Asia/Tokyo' },
      guests: options.guests ? [{ name: 'Charles Babbage', email: 'charles@example.com' }] : [],
      responses: { topic: 'Engines,\nanalytical ones.' },
    })
    const hostEmail = (
      await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', host.userId)
        .executeTakeFirstOrThrow()
    ).email
    return {
      bookingId: result.booking.id,
      apiToken: result.manageToken as string,
      hostId: host.userId,
      hostEmail,
    }
  }

  const deps = (mailer: Mailer, now = NOW): NotificationDeps => ({
    db,
    mailer,
    publicUrl: PUBLIC_URL,
    now: () => now,
  })

  const records = (bookingId: string) =>
    db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .orderBy('recipient')
      .execute()

  it('confirms to the invitee, guests and host, each in their own time zone', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')

    expect(sent.map((m) => m.to)).toEqual(['ada@example.com', 'charles@example.com', hostEmail])
    const [toInvitee, toGuest, toHost] = sent
    expect(toInvitee?.subject).toBe(
      'Confirmed: Intro call with Grace Hopper on Tue, Nov 3, 6:00 PM (Asia/Tokyo)',
    )
    expect(toInvitee?.text).toContain('Where: https://meet.example.com/abc')
    expect(toInvitee?.text).toMatch(
      /Reschedule: https:\/\/cal\.example\.com\/booking#token=[A-Za-z0-9_-]{43}&action=reschedule/,
    )
    expect(toGuest?.subject).toContain('(Asia/Tokyo)')
    expect(toGuest?.text).not.toContain('token=')
    expect(toHost?.subject).toBe(
      'New booking: Intro call with Ada Lovelace on Tue, Nov 3, 4:00 AM (America/New_York)',
    )
    expect(toHost?.text).toContain('Invitee: Ada Lovelace <ada@example.com>')
    expect(toHost?.text).toContain('Guests: Charles Babbage <charles@example.com>')
    expect(toHost?.text).toContain('What should we talk about?\n  Engines,\n  analytical ones.')
    expect(toHost?.text).not.toContain('token=')

    for (const m of sent) {
      expect(invitation(m)).toMatchObject({
        method: 'REQUEST',
        uid: `${bookingId}@cal.example.com`,
        sequence: 0,
        location: 'https://meet.example.com/abc',
      })
    }
    expect(invitation(toInvitee)?.summary).toBe('Intro call with Grace Hopper')
    expect(invitation(toHost)?.summary).toBe('Intro call with Ada Lovelace')
    expect(toInvitee?.attachments?.[0]?.content).not.toContain('token')
  })

  it("gives the invitee a link secret of the email's own, stored only as a hash", async () => {
    const { bookingId, apiToken } = await booked()
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    const token = tokenIn(sent[0])
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toBe(apiToken)
    const rows = await records(bookingId)
    const withHash = rows.filter((r) => r.manage_token_hash !== null)
    expect(withHash).toHaveLength(1)
    expect(withHash[0]?.recipient).toMatch(/^attendee:/)
    expect(withHash[0]?.manage_token_hash?.equals(sha256(token as string))).toBe(true)
    // The token the booking API returned still opens the booking.
    expect((await getManagedBooking(ctx, apiToken)).id).toBe(bookingId)
  })

  it('never sends the same email twice', async () => {
    const { bookingId } = await booked({ guests: true })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent).toHaveLength(3)
    expect(await records(bookingId)).toHaveLength(3)
  })

  it('retries only the emails that failed', async () => {
    const { bookingId, hostEmail } = await booked()
    const { mailer, sent, state } = testMailer()
    state.failFor = hostEmail
    await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
      'unavailable',
    )
    expect(sent.map((m) => m.to)).toEqual(['ada@example.com'])
    expect((await records(bookingId)).map((r) => r.recipient)).toEqual([
      expect.stringMatching(/^attendee:/),
    ])
    state.failFor = undefined
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual(['ada@example.com', hostEmail])
  })

  it('keeps going past a refused address, and the retry sends only to it', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    state.refuse.set('ada@example.com', 450)
    const attempt = sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    await expect(attempt).rejects.toBeInstanceOf(NotificationRetryError)
    await expect(attempt).rejects.toThrow(
      /refused 1 of 3 emails for now: attendee:[0-9a-f-]{36} \(450\)/,
    )
    await expect(attempt).rejects.not.toThrow(/ada@example\.com/)
    // The guest and the host got theirs on the first attempt.
    expect(sent.map((m) => m.to)).toEqual(['charles@example.com', hostEmail])

    state.refuse.clear()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent.map((m) => m.to)).toEqual(['charles@example.com', hostEmail, 'ada@example.com'])
    expect(tokenIn(sent[2])).toBeTruthy()
  })

  it('gives up on an address refused for good, with one log line and no secret kept', async () => {
    const { bookingId, hostEmail } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    state.refuse.set('ada@example.com', 550)
    const lines: string[] = []
    await sendBookingNotification(
      { ...deps(mailer), log: (l) => lines.push(l) },
      bookingId,
      'confirmed',
    )
    expect(sent.map((m) => m.to)).toEqual(['charles@example.com', hostEmail])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      new RegExp(
        `refused the confirmed email for booking ${bookingId} to attendee:[0-9a-f-]{36} for good`,
      ),
    )
    expect(lines[0]).not.toContain('ada@example.com')
    const rejected = (await records(bookingId)).filter((r) => r.outcome === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.manage_token_hash).toBeNull()

    // Not tried again.
    state.refuse.clear()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent).toHaveLength(2)
  })

  it('stops at once when the mail server fails for everyone', async () => {
    const { bookingId } = await booked({ guests: true })
    const { mailer, sent, state } = testMailer()
    state.failFor = 'ada@example.com'
    await expect(sendBookingNotification(deps(mailer), bookingId, 'confirmed')).rejects.toThrow(
      'unavailable',
    )
    expect(sent).toEqual([])
    expect(await records(bookingId)).toEqual([])
  })

  it('sends one email when two attempts run at the same time', async () => {
    const { bookingId } = await booked()
    const { mailer, sent, state } = testMailer()
    let release!: () => void
    state.hold = new Promise((r) => {
      release = r
    })
    const both = Promise.all([
      sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
      sendBookingNotification(deps(mailer), bookingId, 'confirmed'),
    ])
    await new Promise((r) => setTimeout(r, 200))
    release()
    await both
    expect(sent).toHaveLength(2)
  })

  it('does not hold up a cancellation while an email is being sent', async () => {
    const { bookingId, apiToken } = await booked()
    const { mailer, sent, state } = testMailer()
    let release!: () => void
    state.hold = new Promise((r) => {
      release = r
    })
    const started = new Promise<void>((r) => {
      state.started = r
    })
    const sending = sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    try {
      await started
      // The invitee cancels while the mail server is still taking the confirmation.
      const cancelled = await Promise.race([
        cancelManagedBooking(ctx, apiToken, {}).then(() => 'cancelled'),
        new Promise((r) => setTimeout(() => r('blocked'), 3000)),
      ])
      expect(cancelled).toBe('cancelled')
    } finally {
      release()
      await sending
    }
    expect(sent.length).toBeGreaterThan(0)
  })

  it('tells both sides about a reschedule, with the old time and an updated invitation', async () => {
    const { bookingId, apiToken, hostEmail } = await booked()
    const moved = await rescheduleManagedBooking(ctx, apiToken, {
      start: instant('2026-11-03T13:00:00Z'),
    })
    const { mailer, sent } = testMailer()
    // The old booking's own notifications no longer apply.
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    await sendBookingNotification(deps(mailer), bookingId, 'reminder')
    await sendBookingNotification(deps(mailer), bookingId, 'cancelled')
    expect(sent).toEqual([])

    await sendBookingNotification(deps(mailer), moved.booking.id, 'rescheduled')
    expect(sent.map((m) => m.to)).toEqual(['ada@example.com', hostEmail])
    expect(sent[0]?.subject).toBe(
      'Rescheduled: Intro call with Grace Hopper, now Tue, Nov 3, 10:00 PM (Asia/Tokyo)',
    )
    expect(sent[0]?.text).toContain(
      'Was: Tuesday, November 3, 2026, 6:00 PM – 6:30 PM (Asia/Tokyo)',
    )
    expect(tokenIn(sent[0])).toBeTruthy()
    // Same calendar entry as the original booking, one version later.
    expect(invitation(sent[0])).toMatchObject({
      method: 'REQUEST',
      uid: `${bookingId}@cal.example.com`,
      sequence: 1,
    })
  })

  it('cancels the calendar entry and leaves out manage links once cancelled', async () => {
    const { bookingId, apiToken } = await booked()
    await cancelManagedBooking(ctx, apiToken, { reason: 'Something came up.' })
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'confirmed')
    expect(sent).toEqual([])
    await sendBookingNotification(deps(mailer), bookingId, 'cancelled')
    expect(sent).toHaveLength(2)
    for (const m of sent) {
      expect(m.text).toContain('Reason: Something came up.')
      expect(m.text).not.toContain('token=')
      expect(invitation(m)).toMatchObject({ method: 'CANCEL', sequence: 1 })
    }
    expect((await records(bookingId)).every((r) => r.manage_token_hash === null)).toBe(true)
  })

  it('reminds both sides without an invitation, and not once the meeting has started', async () => {
    const { bookingId } = await booked()
    const late = testMailer()
    await sendBookingNotification(deps(late.mailer, instant(START)), bookingId, 'reminder')
    expect(late.sent).toEqual([])

    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), bookingId, 'reminder')
    expect(sent).toHaveLength(2)
    expect(sent[0]?.subject).toMatch(/^Reminder: Intro call with Grace Hopper on /)
    expect(tokenIn(sent[0])).toBeTruthy()
    expect(sent.every((m) => m.attachments === undefined)).toBe(true)
  })

  it('does nothing for a booking that no longer exists', async () => {
    const { mailer, sent } = testMailer()
    await sendBookingNotification(deps(mailer), '0199f0c4-7a2b-7000-8000-000000000000', 'confirmed')
    expect(sent).toEqual([])
  })

  describe('through the job queue', () => {
    it('queues the email and the reminder with the booking, and sends them from a worker', async () => {
      const { mailer, sent } = testMailer()
      const jobs = createJobs({
        connectionString: testDb.url,
        definitions: [bookingNotificationJob(deps(mailer))],
        work: true,
        migrate: true,
        pollingIntervalSeconds: 0.5,
        log: () => {},
      })
      await jobs.start()
      try {
        const { bookingId } = await booked()
        // As the booking service will: inside the transaction that wrote the booking.
        await expect(
          db.transaction().execute(async (trx) => {
            await enqueueBookingNotifications(
              jobs,
              trx,
              { type: 'created', bookingId, start: instant(START) },
              NOW,
            )
            throw new Error('rolled back')
          }),
        ).rejects.toThrow('rolled back')
        const queued = () =>
          testDb.pool.query<{ data: unknown; start_after: Date; state: string }>(
            'SELECT data, start_after, state FROM pgboss.job WHERE name = $1 ORDER BY start_after',
            [BOOKING_NOTIFICATION_JOB],
          )
        expect((await queued()).rows).toEqual([])

        await db
          .transaction()
          .execute((trx) =>
            enqueueBookingNotifications(
              jobs,
              trx,
              { type: 'created', bookingId, start: instant(START) },
              NOW,
            ),
          )
        const rows = (await queued()).rows
        // Only the booking id and the kind: no secret is ever stored in the queue.
        expect(rows.map((r) => r.data)).toEqual([
          { bookingId, kind: 'confirmed' },
          { bookingId, kind: 'reminder' },
        ])
        expect(rows[1]?.start_after.toISOString()).toBe('2026-11-02T09:00:00.000Z')

        const deadline = Date.now() + 10_000
        while (sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
        expect(sent.map((m) => m.subject)).toEqual([
          expect.stringMatching(/^Confirmed: /),
          expect.stringMatching(/^New booking: /),
        ])
      } finally {
        await jobs.stop()
      }
    })

    it('rolls back and lets go of the database when a worker stops during a slow send', async () => {
      const { bookingId, apiToken } = await booked()
      await cancelManagedBooking(ctx, apiToken, {})
      const { mailer, sent, state } = testMailer()
      state.hold = new Promise(() => {})
      const started = new Promise<void>((r) => {
        state.started = r
      })
      // Its own pool, closed afterwards as the server closes its own on shutdown.
      const pool = createPool(testDb.url)
      const jobs = createJobs({
        connectionString: testDb.url,
        definitions: [bookingNotificationJob({ ...deps(mailer), db: createDb(pool) })],
        work: true,
        migrate: true,
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 1000,
        log: () => {},
      })
      await jobs.start()
      await db
        .transaction()
        .execute((trx) =>
          enqueueBookingNotifications(jobs, trx, { type: 'cancelled', bookingId }, NOW),
        )
      await started
      const before = Date.now()
      await jobs.stop()
      await pool.end()
      expect(Date.now() - before).toBeLessThan(5000)
      expect(state.aborted).toBe(1)
      expect(sent).toEqual([])
      // Rolled back: the email is still owed, and the job will run again.
      expect(await records(bookingId)).toEqual([])
      const job = await testDb.pool.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name = $1 AND data->>'bookingId' = $2",
        [BOOKING_NOTIFICATION_JOB, bookingId],
      )
      expect(job.rows.map((r) => r.state)).toEqual(['retry'])
    })

    it('skips the reminder when the meeting is less than a day away', async () => {
      const queue: { kind: string; startAfter?: unknown }[] = []
      const fake = {
        async enqueue(
          _name: string,
          payload: { kind: string },
          options?: { startAfter?: unknown },
        ) {
          queue.push({ kind: payload.kind, startAfter: options?.startAfter })
          return 'id'
        },
      }
      const bookingId = '0199f0c4-7a2b-7000-8000-000000000001'
      await enqueueBookingNotifications(
        fake,
        db,
        { type: 'rescheduled', bookingId, start: NOW.add({ hours: 23 }) },
        NOW,
      )
      await enqueueBookingNotifications(fake, db, { type: 'cancelled', bookingId }, NOW)
      expect(queue).toEqual([
        { kind: 'rescheduled', startAfter: undefined },
        { kind: 'cancelled', startAfter: undefined },
      ])
    })
  })
})
