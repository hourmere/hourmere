import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  DEFAULT_NOTIFICATIONS,
  type NotificationSettings,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeBookingConference } from '../../calendars/src/conferences.ts'
import {
  bookingNotifier,
  dispatchConferenceNotifications,
  type NotificationDeps,
  sendBookingNotification,
} from './index.ts'
import { deliverScheduledBookingEmail } from './scheduled.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const START = Temporal.Instant.from('2026-11-03T09:00:00Z')
const custom: NotificationSettings = {
  reminders: [
    {
      id: 'custom-day',
      offsetMinutes: 1440,
      recipients: { host: true, invitee: true, guests: true },
    },
  ],
  followUps: [
    { id: 'after', offsetMinutes: 5, recipients: { host: false, invitee: true, guests: false } },
  ],
}

async function sourceCopy<T>(
  path: string,
  exported: string,
  replacement: readonly [string, string],
) {
  const url = new URL(path, import.meta.url)
  let source = readFileSync(url, 'utf8')
  expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
  source = stripTypeScriptTypes(source.replace(...replacement))
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  return new Function(
    ...Object.keys(dependencies),
    `${source.replace(/\bexport /g, '')}; return ${exported}`,
  )(...Object.values(dependencies)) as T
}
const conferenceSourceCopy = (replacement: readonly [string, string]) =>
  sourceCopy<typeof writeBookingConference>(
    '../../calendars/src/conferences.ts',
    'writeBookingConference',
    replacement,
  )

describe.skipIf(!serverUrl)('scheduled mail lifecycle and conference races', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let sent: MailMessage[]
  let now = NOW

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'schedule_races' })
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    now = NOW
    sent = []
    await db.deleteFrom('notification_email_sends').execute()
  })
  const queue = { enqueue: async () => randomUUID() }
  const deps = (): NotificationDeps => ({
    db,
    now: () => now,
    publicUrl: 'https://hourmere.example',
    secret: 'synthetic-race-secret',
    log: () => {},
    mailer: {
      send: async (m) => {
        sent.push(m)
      },
    },
  })

  async function booked(settings = custom) {
    const host = await f.host()
    await f.schedule(host.userId)
    const typeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      allowGuests: true,
    })
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify(settings) })
      .where('id', '=', typeId)
      .execute()
    const ctx = { db, now: () => now, notify: bookingNotifier(queue) }
    const result = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'intro',
      start: START,
      invitee: { name: 'Invitee', email: `${host.userId}@example.com`, timeZone: 'Europe/Berlin' },
      guests: [{ name: 'Guest', email: `guest-${host.userId}@example.com` }],
    })
    if (!result.manageToken) throw new Error('Fixture did not return a manage token')
    const rows = () =>
      db
        .selectFrom('booking_scheduled_messages')
        .selectAll()
        .where('booking_id', '=', result.booking.id)
        .orderBy('due_at')
        .execute()
    return { host, ctx, result, rows, token: result.manageToken }
  }

  async function waitForBudgetLock() {
    for (let i = 0; i < 500; i++) {
      const current = await owned.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
      )
      if ((current.rows[0]?.n ?? 0) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Scheduled worker never reached the mail budget lock')
  }

  it.each(['cancel', 'reschedule', 'anchor'] as const)(
    'rereads lifecycle after a budget wait: %s',
    async (change) => {
      const b = await booked()
      const row = (await b.rows())[0]
      if (!row) throw new Error('Missing scheduled reminder')
      now = Temporal.Instant.from(row.due_at.toISOString())
      const holder = await owned.pool.connect()
      await holder.query('SELECT pg_advisory_lock(1852798057,1835100524)')
      const pending = deliverScheduledBookingEmail(deps(), row.id)
      pending.catch(() => {})
      try {
        await waitForBudgetLock()
        if (change === 'cancel') await cancelManagedBooking(b.ctx, b.token)
        else if (change === 'reschedule')
          await rescheduleManagedBooking(b.ctx, b.token, {
            start: START.add({ hours: 1 }),
          })
        else
          await db
            .updateTable('bookings')
            .set({ end_at: START.add({ minutes: 45 }).toString() })
            .where('id', '=', b.result.booking.id)
            .execute()
      } finally {
        await holder.query('SELECT pg_advisory_unlock(1852798057,1835100524)')
        holder.release()
      }
      await pending
      expect(sent).toHaveLength(0)
      expect(
        await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where('booking_id', '=', b.result.booking.id)
          .execute(),
      ).toHaveLength(0)
      expect((await b.rows())[0]?.state).toBe('skipped')
    },
  )

  async function verifyMeetingStartedBeforeSend(deliver = deliverScheduledBookingEmail) {
    const b = await booked()
    const row = (await b.rows())[0]
    if (!row) throw new Error('Missing scheduled reminder')
    now = Temporal.Instant.from(row.due_at.toISOString())
    const holder = await owned.pool.connect()
    await holder.query('SELECT pg_advisory_lock(1852798057,1835100524)')
    const pending = deliver(deps(), row.id)
    pending.catch(() => {})
    try {
      await waitForBudgetLock()
      now = START
    } finally {
      await holder.query('SELECT pg_advisory_unlock(1852798057,1835100524)')
      holder.release()
    }
    await pending
    expect(sent).toHaveLength(0)
    expect(
      await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', b.result.booking.id)
        .execute(),
    ).toHaveLength(0)
    expect(
      (await b.rows())[0],
      'start-boundary skips retain the actual lifecycle reason',
    ).toMatchObject({
      state: 'skipped',
      skip_reason: 'meeting_started',
      attempts: 1,
      claim_token: null,
      lease_until: null,
    })
  }

  it('records meeting_started when the reminder reaches start during a mail budget wait', async () => {
    await verifyMeetingStartedBeforeSend()
  })

  it('kills a source-copy mutation that mislabels an overtaken reminder as booking_cancelled', async () => {
    const deliver = await sourceCopy<typeof deliverScheduledBookingEmail>(
      './scheduled.ts',
      'deliverScheduledBookingEmail',
      ['obsoleteReason(current, clock(deps))', "'booking_cancelled'"],
    )
    await expect(verifyMeetingStartedBeforeSend(deliver)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: expect.objectContaining({ skip_reason: 'booking_cancelled' }),
      expected: expect.objectContaining({ skip_reason: 'meeting_started' }),
    })
  })

  it('cancels between recipients without holding a booking or message lock over SMTP', async () => {
    const b = await booked()
    const row = (await b.rows())[0]
    if (!row) throw new Error('Missing scheduled reminder')
    now = Temporal.Instant.from(row.due_at.toISOString())
    const config = deps()
    config.mailer = {
      send: async (m) => {
        sent.push(m)
        if (sent.length === 1) {
          await db.transaction().execute(async (trx) => {
            await trx
              .selectFrom('bookings')
              .select('id')
              .where('id', '=', b.result.booking.id)
              .forUpdate()
              .noWait()
              .executeTakeFirstOrThrow()
            await trx
              .selectFrom('booking_scheduled_messages')
              .select('id')
              .where('id', '=', row.id)
              .forUpdate()
              .noWait()
              .executeTakeFirstOrThrow()
          })
          await cancelManagedBooking(b.ctx, b.token)
        }
      },
    }
    await deliverScheduledBookingEmail(config, row.id)
    expect(sent).toHaveLength(1)
    expect((await b.rows()).every((m) => m.state === 'skipped')).toBe(true)
    expect(
      await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', b.result.booking.id)
        .execute(),
    ).toHaveLength(1)
  })

  it('retains the documented SMTP-accepted but commit-failed duplicate window', async () => {
    const b = await booked({
      reminders: [
        {
          id: 'commit-window',
          offsetMinutes: 120,
          recipients: { host: false, invitee: true, guests: false },
        },
      ],
      followUps: [],
    })
    const row = (await b.rows())[0]
    if (!row) throw new Error('Missing scheduled reminder')
    now = Temporal.Instant.from(row.due_at.toISOString())
    await owned.pool.query(`
      CREATE SEQUENCE smtp_commit_probe;
      CREATE FUNCTION fail_first_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF nextval('smtp_commit_probe')=1 THEN RAISE EXCEPTION 'synthetic commit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE CONSTRAINT TRIGGER smtp_commit_probe AFTER INSERT ON booking_notifications
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_first_receipt_commit();
    `)
    try {
      await deliverScheduledBookingEmail(deps(), row.id)
      expect(sent).toHaveLength(1)
      expect(
        await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where('booking_id', '=', b.result.booking.id)
          .execute(),
      ).toHaveLength(0)
      expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toHaveLength(0)
      const pending = (await b.rows())[0]
      expect(pending).toMatchObject({ state: 'pending', attempts: 1 })
      if (!pending) throw new Error('Missing retry schedule')
      now = Temporal.Instant.from(pending.next_attempt_at.toISOString())
      await deliverScheduledBookingEmail(deps(), row.id)
      expect(sent).toHaveLength(2)
      expect(
        await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where('booking_id', '=', b.result.booking.id)
          .execute(),
      ).toHaveLength(1)
      expect(await db.selectFrom('notification_email_sends').selectAll().execute()).toHaveLength(1)
      expect((await b.rows())[0]).toMatchObject({ state: 'completed', attempts: 2 })
    } finally {
      await owned.pool.query(
        'DROP TRIGGER smtp_commit_probe ON booking_notifications; DROP FUNCTION fail_first_receipt_commit(); DROP SEQUENCE smtp_commit_probe',
      )
    }
  })

  async function conference(
    b: Awaited<ReturnType<typeof booked>>,
    writer = writeBookingConference,
  ) {
    const user = await db
      .selectFrom('auth.user')
      .select(['name', 'email'])
      .where('id', '=', b.host.userId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('bookings')
      .set({ location: JSON.stringify({ kind: 'zoom', autoCreate: true }) })
      .where('id', '=', b.result.booking.id)
      .execute()
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: b.result.booking.id,
        booking_id: b.result.booking.id,
        organization_id: b.host.organizationId,
        organizer_user_id: b.host.userId,
        provider: 'zoom',
        zoom_connection_id: randomUUID(),
        zoom_user_id: 'synthetic-host',
        invitation_organizer_name: user.name,
        invitation_organizer_email: user.email,
        next_attempt_at: new Date(now.epochMilliseconds),
      })
      .execute()
    return () =>
      writer(
        {
          db,
          now: () => now.epochMilliseconds,
          zoomConferenceWork: async () => ({
            url: 'https://zoom.us/j/123456789',
            meetingId: '123456789',
          }),
        },
        b.result.booking.id,
      )
  }

  it.each([true, false])(
    'conference readiness guards legacy reminder insertion (custom=%s)',
    async (configurable) => {
      const b = await booked(configurable ? custom : DEFAULT_NOTIFICATIONS)
      const ready = await conference(b)
      await ready()
      const outbox = await db
        .selectFrom('booking_conference_notifications')
        .selectAll()
        .where('booking_id', '=', b.result.booking.id)
        .execute()
      expect(outbox.filter((n) => n.kind === 'reminder')).toHaveLength(configurable ? 0 : 1)
      expect(await b.rows()).toHaveLength(configurable ? 2 : 0)
      now = START.subtract({ hours: 24 })
      if (configurable) {
        const row = (await b.rows())[0]
        if (!row) throw new Error('Missing scheduled reminder')
        // Both stale generic and conference outbox jobs must refuse custom reminder delivery.
        await db
          .insertInto('booking_conference_notifications')
          .values({
            booking_id: b.result.booking.id,
            kind: 'reminder',
            due_at: new Date(now.epochMilliseconds),
          })
          .execute()
        await Promise.all([
          sendBookingNotification(deps(), b.result.booking.id, 'reminder'),
          dispatchConferenceNotifications(deps()),
          deliverScheduledBookingEmail(deps(), row.id),
        ])
        const receipts = await db
          .selectFrom('booking_notifications')
          .select(['message_key'])
          .where('booking_id', '=', b.result.booking.id)
          .where('kind', '=', 'reminder')
          .execute()
        expect(receipts).toHaveLength(3)
        expect(receipts.every((r) => r.message_key === 'custom-day')).toBe(true)
      } else {
        await Promise.all([
          sendBookingNotification(deps(), b.result.booking.id, 'reminder'),
          dispatchConferenceNotifications(deps()),
        ])
        const receipts = await db
          .selectFrom('booking_notifications')
          .select(['message_key'])
          .where('booking_id', '=', b.result.booking.id)
          .where('kind', '=', 'reminder')
          .execute()
        expect(receipts).toHaveLength(3)
        expect(receipts.every((r) => r.message_key === '')).toBe(true)
      }
      expect(sent.filter((m) => /remind|提醒/i.test(m.subject))).toHaveLength(3)
    },
  )

  it('kills a source-copy mutation that restores the legacy conference reminder in custom mode', async () => {
    const writer = await conferenceSourceCopy([
      'if (!configurable && reminder.getTime() > now.getTime() + 60 * 60_000)',
      'if (reminder.getTime() > now.getTime() + 60 * 60_000)',
    ])
    const verify = async (write: typeof writer) => {
      const b = await booked()
      await (await conference(b, write))()
      expect(
        await db
          .selectFrom('booking_conference_notifications')
          .selectAll()
          .where('booking_id', '=', b.result.booking.id)
          .where('kind', '=', 'reminder')
          .execute(),
        'custom readiness must not manufacture a fixed reminder',
      ).toHaveLength(0)
    }
    await verify(writeBookingConference)
    await expect(verify(writer)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  async function verifyReadinessWake(writer: typeof writeBookingConference) {
    const settings = {
      reminders: [1440, 1200, 1000, 800, 600].map((offsetMinutes, i) => ({
        id: `wake-${i}`,
        offsetMinutes,
        recipients: { host: true, invitee: true, guests: true },
      })),
      followUps: [],
    }
    const b = await booked(settings)
    const ready = await conference(b, writer)
    const rows = await b.rows()
    const states = ['pending', 'failed', 'completed', 'skipped', 'pending']
    const attempts = [4, 13, 1, 0, 13]
    now = START.subtract({ minutes: 30 })
    for (const [i, row] of rows.entries()) {
      await db
        .updateTable('booking_scheduled_messages')
        .set({
          state: states[i],
          attempts: attempts[i],
          next_attempt_at: new Date(now.add({ hours: 2 }).epochMilliseconds),
        })
        .where('id', '=', row.id)
        .execute()
    }
    const before = await b.rows()
    await ready()
    const after = await b.rows()
    expect(
      after[0]?.next_attempt_at.toISOString(),
      'readiness wakes the existing pending rule',
    ).toBe(now.toString({ smallestUnit: 'millisecond' }))
    expect(after[0]?.attempts, 'readiness retains attempts').toBe(4)
    expect(after.slice(1), 'readiness never revives terminal or exhausted messages').toEqual(
      before.slice(1),
    )
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
  }

  it('conference readiness wakes only existing pending eligible messages without resetting attempts', async () => {
    await verifyReadinessWake(writeBookingConference)
  })

  it.each([
    ['terminal state fence', "AND state='pending'", ''],
    ['attempt budget fence', 'AND attempts < 13', ''],
  ])('kills removal of the conference readiness %s in a source copy', async (_, from, to) => {
    const writer = await conferenceSourceCopy([from, to])
    await expect(verifyReadinessWake(writer)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
