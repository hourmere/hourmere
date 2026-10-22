import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { createPublicBooking } from '@hourmere/scheduling'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type NotificationDeps, sendBookingNotification } from './index.ts'
import { notificationRecipientHash, signInRecipientHash } from './mail-limits.ts'
import { deliverSignInEmail, queuedSignInEmail, type SignInEmailDeps } from './sign-in.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = new Date('2026-11-01T12:00Z')
const EMAIL = 'ada@example.test'
const secret = randomBytes(32).toString('base64')
const publicUrl = 'https://hourmere.example'

describe.skipIf(!serverUrl)('durable sign-in mail limits (real PostgreSQL)', () => {
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
    await db.deleteFrom('sign_in_emails').execute()
    await db.deleteFrom('auth.verification').execute()
    await db.deleteFrom('notification_email_sends').execute()
    now = NOW
    sent = []
    logs = []
  })
  const deps = (overrides: Partial<SignInEmailDeps> = {}): SignInEmailDeps => ({
    db,
    publicUrl,
    secret,
    signup: { mode: 'open', allowedDomains: [] },
    now: () => now,
    mailer: { send: async (message) => void sent.push(message) },
    log: (line) => logs.push(line),
    ...overrides,
  })
  const bookingDeps = (overrides: Partial<NotificationDeps> = {}): NotificationDeps => ({
    db,
    publicUrl,
    secret,
    now: () => Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    mailer: { send: async (message) => void sent.push(message) },
    log: (line) => logs.push(line),
    ...overrides,
  })
  const rows = () => db.selectFrom('sign_in_emails').selectAll().execute()
  const ledger = () => db.selectFrom('notification_email_sends').selectAll().execute()
  async function queued(email = EMAIL) {
    const token = randomBytes(32).toString('base64url')
    const proof = await db
      .insertInto('auth.verification')
      .values({
        identifier: `magic-link:${createHash('sha256').update(token).digest('base64url')}`,
        value: JSON.stringify({ type: 'magic-link', email }),
        expiresAt: new Date(now.getTime() + 15 * 60_000),
      })
      .returning(['id', 'expiresAt'])
      .executeTakeFirstOrThrow()
    let emailId = ''
    await queuedSignInEmail(
      {
        enqueue: async (_name, payload) => {
          emailId = payload.emailId
          return randomUUID()
        },
      },
      deps(),
    )({ email, url: `${publicUrl}/sign-in/confirm#token=${token}&callbackURL=/app` })
    return { id: emailId, proof }
  }
  async function history(count: number, hash: Buffer | null, at = now) {
    await db
      .insertInto('notification_email_sends')
      .values(Array.from({ length: count }, () => ({ recipient_hash: hash, sent_at: at })))
      .execute()
  }
  async function booked() {
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'limits' })
    return createPublicBooking(
      { db, now: () => Temporal.Instant.fromEpochMilliseconds(now.getTime()) },
      {
        handle: host.handle,
        slug: 'limits',
        start: Temporal.Instant.from('2026-11-03T09:00Z'),
        invitee: { name: 'Synthetic Ada', email: EMAIL, timeZone: 'UTC' },
      },
    )
  }

  it('sends the fifth hourly email, then permanently drops the sixth with a private WARN', async () => {
    await history(4, signInRecipientHash('  ADA@EXAMPLE.TEST ', secret))
    const first = await queued('Ada@Example.Test')
    await deliverSignInEmail(deps(), first.id)
    expect(sent).toHaveLength(1)
    expect(await ledger()).toHaveLength(5)
    expect(
      (await ledger()).every((row) =>
        row.recipient_hash?.equals(signInRecipientHash(EMAIL, secret)),
      ),
    ).toBe(true)
    const second = await queued()
    await deliverSignInEmail(deps(), second.id)
    expect(sent).toHaveLength(1)
    expect(await rows()).toEqual([])
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'warn',
        event: 'sign_in_email_suppressed',
        reason: 'recipient_hourly_limit',
        recipientHash: signInRecipientHash(EMAIL, secret).toString('hex'),
      },
    ])
    expect(logs.join('\n')).not.toMatch(/ada@|example\.test|token=|sign-in\/confirm/i)
    now = new Date(now.getTime() + 2 * 3_600_000)
    await deliverSignInEmail(deps(), second.id)
    expect(sent).toHaveLength(1)
    expect(await ledger()).toHaveLength(5)
    expect(logs).toHaveLength(1)
  })

  it('sends the twentieth daily email and suppresses the next independently of hourly counts', async () => {
    const hash = signInRecipientHash(EMAIL, secret)
    await history(19, hash, new Date(now.getTime() - 2 * 3_600_000))
    await history(5, hash, new Date(now.getTime() - 24 * 3_600_000))
    await deliverSignInEmail(deps(), (await queued()).id)
    await deliverSignInEmail(deps(), (await queued()).id)
    expect(sent).toHaveLength(1)
    expect(await ledger()).toHaveLength(25)
    expect(JSON.parse(logs[0] as string).reason).toBe('recipient_daily_limit')
    expect(await rows()).toEqual([])
  })

  it('logs suppression only after the outbox deletion commits', async () => {
    await history(5, signInRecipientHash(EMAIL, secret))
    const row = await queued()
    try {
      await owned.pool.query(
        `CREATE FUNCTION test_fail_sign_in_suppression_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced suppression commit failure'; END $$`,
      )
      await owned.pool.query(
        'CREATE CONSTRAINT TRIGGER test_fail_sign_in_suppression AFTER DELETE ON sign_in_emails DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_sign_in_suppression_commit()',
      )
      await expect(deliverSignInEmail(deps(), row.id)).rejects.toThrow(
        'forced suppression commit failure',
      )
      expect(sent).toEqual([])
      expect(await ledger()).toHaveLength(5)
      expect((await rows()).map((value) => value.id)).toEqual([row.id])
      expect(logs).toEqual([])
    } finally {
      await owned.pool.query(
        'DROP TRIGGER IF EXISTS test_fail_sign_in_suppression ON sign_in_emails',
      )
      await owned.pool.query('DROP FUNCTION IF EXISTS test_fail_sign_in_suppression_commit()')
    }
    await deliverSignInEmail(deps(), row.id)
    expect(sent).toEqual([])
    expect(await rows()).toEqual([])
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        level: 'warn',
        event: 'sign_in_email_suppressed',
        reason: 'recipient_hourly_limit',
        recipientHash: signInRecipientHash(EMAIL, secret).toString('hex'),
      },
    ])
  })

  it('excludes sends exactly one hour old from the hourly window', async () => {
    await history(5, signInRecipientHash(EMAIL, secret), new Date(now.getTime() - 3_600_000))
    await deliverSignInEmail(deps(), (await queued()).id)
    expect(sent).toHaveLength(1)
    expect(logs).toEqual([])
  })

  it.each(['booking', 'sign-in'] as const)(
    'keeps recipient accounting separate from existing %s mail',
    async (kind) => {
      await history(
        20,
        kind === 'booking'
          ? notificationRecipientHash(EMAIL, secret)
          : signInRecipientHash(EMAIL, secret),
      )
      if (kind === 'booking') await deliverSignInEmail(deps(), (await queued()).id)
      else await sendBookingNotification(bookingDeps(), (await booked()).booking.id, 'confirmed')
      expect(sent.filter((message) => message.to.toLowerCase() === EMAIL)).toHaveLength(1)
      expect(logs).toEqual([])
    },
  )

  it('counts sign-in toward the instance cap and keeps its reserve until the host floor', async () => {
    await history(99, null)
    await deliverSignInEmail(deps(), (await queued()).id)
    expect(await ledger()).toHaveLength(100)
    const booking = await booked()
    await sendBookingNotification(bookingDeps(), booking.booking.id, 'confirmed')
    expect(sent).toHaveLength(2)
    expect(
      await db
        .selectFrom('booking_notifications')
        .select(['outcome', 'suppression_reason'])
        .where('booking_id', '=', booking.booking.id)
        .where('recipient', 'like', 'attendee:%')
        .executeTakeFirstOrThrow(),
    ).toEqual({ outcome: 'suppressed', suppression_reason: 'instance_hourly_limit' })
    await history(18, null)
    await deliverSignInEmail(deps(), (await queued()).id)
    expect(await ledger()).toHaveLength(120)
    await deliverSignInEmail(deps(), (await queued()).id)
    expect(sent).toHaveLength(3)
    expect(await ledger()).toHaveLength(120)
    expect(await rows()).toEqual([])
    expect(logs.map((line) => JSON.parse(line).reason)).toEqual([
      'instance_hourly_limit',
      'instance_hourly_limit',
    ])
  })

  it('honors configured sign-in limits while zero disables only the instance cap', async () => {
    await history(150, null)
    await history(1, signInRecipientHash(EMAIL, secret))
    await deliverSignInEmail(
      deps({ mailMaxPerHour: 0, signInMailMaxPerHour: 2, signInMailMaxPerDay: 3 }),
      (await queued()).id,
    )
    await deliverSignInEmail(
      deps({ mailMaxPerHour: 0, signInMailMaxPerHour: 2, signInMailMaxPerDay: 3 }),
      (await queued()).id,
    )
    expect(sent).toHaveLength(1)
    expect(JSON.parse(logs[0] as string).reason).toBe('recipient_hourly_limit')
    now = new Date(now.getTime() + 2 * 3_600_000)
    await deliverSignInEmail(
      deps({ mailMaxPerHour: 0, signInMailMaxPerHour: 2, signInMailMaxPerDay: 2 }),
      (await queued()).id,
    )
    expect(sent).toHaveLength(1)
    expect(JSON.parse(logs[1] as string).reason).toBe('recipient_daily_limit')
  })

  it('rolls back a failed send without consuming budget and never resends a successful job', async () => {
    await history(4, signInRecipientHash(EMAIL, secret))
    const row = await queued()
    await expect(
      deliverSignInEmail(
        deps({
          mailer: {
            send: async () => {
              throw new Error('Synthetic SMTP failure')
            },
          },
        }),
        row.id,
      ),
    ).rejects.toThrow('Sign-in email could not be sent')
    expect(await ledger()).toHaveLength(4)
    expect((await rows()).map((value) => value.id)).toEqual([row.id])
    await deliverSignInEmail(deps(), row.id)
    await deliverSignInEmail(deps(), row.id)
    expect(sent).toHaveLength(1)
    expect(await ledger()).toHaveLength(5)
    expect(await rows()).toEqual([])
  })

  it('serializes concurrent sign-in workers spending the last recipient slot', async () => {
    await history(4, signInRecipientHash(EMAIL, secret))
    const first = await queued()
    const second = await queued()
    const config = deps({
      mailer: {
        send: async (message) => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          sent.push(message)
        },
      },
    })
    await Promise.all([deliverSignInEmail(config, first.id), deliverSignInEmail(config, second.id)])
    expect(sent).toHaveLength(1)
    expect(await ledger()).toHaveLength(5)
    expect(await rows()).toEqual([])
    expect(logs).toHaveLength(1)
  })

  it('shares the booking lock so a slow host send cannot overspend the final instance slot', async () => {
    await history(119, null)
    const booking = await booked()
    const row = await queued()
    let release = () => {}
    let reached = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const sending = new Promise<void>((resolve) => {
      reached = resolve
    })
    const delivery = sendBookingNotification(
      bookingDeps({
        mailer: {
          send: async (message) => {
            reached()
            await held
            sent.push(message)
          },
        },
      }),
      booking.booking.id,
      'confirmed',
    )
    await sending
    const signIn = deliverSignInEmail(deps(), row.id)
    try {
      await vi.waitFor(async () => {
        const blocked = await owned.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'",
        )
        expect(blocked.rows.length).toBeGreaterThan(0)
      })
    } finally {
      release()
      await Promise.all([delivery, signIn])
    }
    expect(sent).toHaveLength(1)
    expect(sent.some((message) => message.to === EMAIL)).toBe(false)
    expect(await ledger()).toHaveLength(120)
    expect(await rows()).toEqual([])
  })

  it.each(['expired', 'consumed', 'outbox-expired'] as const)(
    'rechecks a %s proof after waiting for the shared mail budget lock',
    async (mode) => {
      const row = await queued()
      if (mode === 'expired')
        await db
          .updateTable('sign_in_emails')
          .set({ expires_at: new Date(row.proof.expiresAt.getTime() + 60_000) })
          .where('id', '=', row.id)
          .execute()
      const blocker = await owned.pool.connect()
      let delivery: Promise<void> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(1852798057, 1835100524)')
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid
        delivery = deliverSignInEmail(deps(), row.id)
        await vi.waitFor(async () => {
          const waiting = await owned.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(waiting.rows.length).toBeGreaterThan(0)
        })
        if (mode === 'consumed')
          await db.deleteFrom('auth.verification').where('id', '=', row.proof.id).execute()
        else if (mode === 'outbox-expired') {
          await db
            .updateTable('auth.verification')
            .set({ expiresAt: new Date(row.proof.expiresAt.getTime() + 60_000) })
            .where('id', '=', row.proof.id)
            .execute()
          now = row.proof.expiresAt
        } else now = row.proof.expiresAt
        await blocker.query('COMMIT')
        await delivery
        expect(sent).toEqual([])
        expect(await ledger()).toEqual([])
        expect(await rows()).toEqual([])
      } finally {
        await blocker.query('ROLLBACK')
        await delivery
        blocker.release()
      }
    },
  )
})
