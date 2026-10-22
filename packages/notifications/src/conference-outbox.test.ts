import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type Mailer, type MailMessage, MailRejectedError } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dispatchConferenceNotifications } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Expected the controlled database barrier to be reached')
}

describe.skipIf(!serverUrl)('bounded conference notification outbox (real PostgreSQL)', () => {
  let owned: TestDatabase
  let db: Db
  let now = NOW
  let logs: string[]
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
    now = NOW
    logs = []
  })
  const deps = (mailer: Mailer) => ({
    db,
    mailer,
    now: () => now,
    publicUrl: 'https://hourmere.example',
    log: (line: string) => logs.push(line),
  })
  const row = (id: string) =>
    db
      .selectFrom('booking_conference_notifications')
      .selectAll()
      .where('booking_id', '=', id)
      .executeTakeFirstOrThrow()
  async function fixture(guests = false) {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'notice', allowGuests: guests })
    const result = await createPublicBooking(
      { db, now: () => NOW },
      {
        handle: host.handle,
        slug: 'notice',
        start: Temporal.Instant.from('2030-11-04T09:00:00Z'),
        invitee: { name: 'Synthetic Booker', email: 'booker@example.test', timeZone: 'UTC' },
        guests: guests ? [{ name: 'Synthetic Guest', email: 'guest@example.test' }] : [],
      },
    )
    const id = result.booking.id
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
    if (!result.manageToken) throw new Error('Synthetic booking needs a management token')
    return { id, host, token: result.manageToken }
  }

  it('excludes guests from the failure notice and its durable recipient receipts', async () => {
    const { id } = await fixture(true)
    const messages: MailMessage[] = []
    await dispatchConferenceNotifications(
      deps({
        send: async (message) => {
          messages.push(message)
        },
      }),
    )
    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.to)).not.toContain('guest@example.test')
    expect(messages.every((message) => !message.attachments?.length)).toBe(true)
    const receipts = await db
      .selectFrom('booking_notifications')
      .selectAll()
      .where('booking_id', '=', id)
      .execute()
    expect(receipts).toHaveLength(2)
    expect((await row(id)).delivered).toBe(true)
  })

  for (const change of ['cancel', 'reschedule', 'started'] as const) {
    it(`marks a ${change} notice skipped without a delivery attempt or recipient receipt`, async () => {
      const { id, token } = await fixture()
      if (change === 'cancel') await cancelManagedBooking({ db, now: () => now }, token)
      else if (change === 'reschedule')
        await rescheduleManagedBooking({ db, now: () => now }, token, {
          start: Temporal.Instant.from('2030-11-04T11:00Z'),
        })
      else {
        await db
          .updateTable('booking_conference_notifications')
          .set({ kind: 'confirmed' })
          .where('booking_id', '=', id)
          .execute()
        now = Temporal.Instant.from('2030-11-04T09:00Z')
      }
      let calls = 0
      const config = deps({
        send: async () => {
          calls++
        },
      })
      await dispatchConferenceNotifications(config)
      await dispatchConferenceNotifications(config)
      expect(calls).toBe(0)
      expect(await row(id)).toMatchObject({
        delivered: false,
        attempts: 0,
        exhausted_at: null,
        lease_id: null,
        last_error: null,
        skipped_at: new Date(now.epochMilliseconds),
      })
      expect(
        await db
          .selectFrom('booking_notifications')
          .selectAll()
          .where('booking_id', '=', id)
          .execute(),
      ).toHaveLength(0)
    })
  }

  for (const kind of ['confirmed', 'conference_failed'] as const) {
    it(`does not claim ${kind} while the conference state gate is closed`, async () => {
      const { id } = await fixture()
      await db
        .updateTable('booking_conference_notifications')
        .set({ kind })
        .where('booking_id', '=', id)
        .execute()
      await db
        .updateTable('booking_conferences')
        .set({ state: 'pending' })
        .where('booking_id', '=', id)
        .execute()
      let calls = 0
      await dispatchConferenceNotifications(
        deps({
          send: async () => {
            calls++
          },
        }),
      )
      expect(calls).toBe(0)
      expect(await row(id)).toMatchObject({
        delivered: false,
        attempts: 0,
        skipped_at: null,
        lease_id: null,
      })
    })
  }

  it('skips an obsolete failure notice after recovery and still sends the recovered invitation', async () => {
    const { id } = await fixture()
    await db
      .updateTable('bookings')
      .set({
        location: {
          kind: 'google_meet',
          autoCreate: true,
          url: 'https://meet.google.com/abc-defg-hij',
        },
      })
      .where('id', '=', id)
      .execute()
    await db
      .updateTable('booking_conferences')
      .set({ state: 'ready', applied_revision: 0, error_code: null })
      .where('booking_id', '=', id)
      .execute()
    await db
      .insertInto('booking_conference_notifications')
      .values({ booking_id: id, kind: 'confirmed', due_at: new Date(now.epochMilliseconds) })
      .execute()
    const messages: MailMessage[] = []
    await dispatchConferenceNotifications(
      deps({
        send: async (message) => {
          messages.push(message)
        },
      }),
    )
    expect(messages).toHaveLength(2)
    expect(
      messages.every((message) => message.attachments?.[0]?.content.includes('METHOD:REQUEST')),
    ).toBe(true)
    const notices = await db
      .selectFrom('booking_conference_notifications')
      .selectAll()
      .where('booking_id', '=', id)
      .execute()
    expect(notices.find((notice) => notice.kind === 'conference_failed')).toMatchObject({
      delivered: false,
      skipped_at: new Date(now.epochMilliseconds),
      attempts: 0,
    })
    expect(notices.find((notice) => notice.kind === 'confirmed')).toMatchObject({
      delivered: true,
      skipped_at: null,
      attempts: 1,
    })
  })

  it('records a closed gate during delivery as skipped after only the committed host receipt', async () => {
    const { id } = await fixture()
    const messages: MailMessage[] = []
    await dispatchConferenceNotifications(
      deps({
        send: async (message) => {
          messages.push(message)
          await db
            .updateTable('booking_conferences')
            .set({ state: 'pending' })
            .where('booking_id', '=', id)
            .execute()
        },
      }),
    )
    expect(messages).toHaveLength(1)
    expect(await row(id)).toMatchObject({
      delivered: false,
      attempts: 1,
      skipped_at: new Date(now.epochMilliseconds),
      lease_id: null,
      exhausted_at: null,
    })
    expect(
      await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', id)
        .execute(),
    ).toHaveLength(1)
    await db
      .updateTable('booking_conferences')
      .set({ state: 'failed' })
      .where('booking_id', '=', id)
      .execute()
    now = now.add({ hours: 1 })
    await dispatchConferenceNotifications(
      deps({
        send: async (message) => {
          messages.push(message)
        },
      }),
    )
    expect(messages).toHaveLength(1)
  })

  it('records a closed invitation URL gate at delivery entry as skipped without fabricating receipts', async () => {
    const { id } = await fixture()
    await db
      .updateTable('booking_conferences')
      .set({ state: 'ready', applied_revision: 0, error_code: null })
      .where('booking_id', '=', id)
      .execute()
    await db
      .updateTable('booking_conference_notifications')
      .set({ kind: 'confirmed' })
      .where('booking_id', '=', id)
      .execute()
    let calls = 0
    await dispatchConferenceNotifications(
      deps({
        send: async () => {
          calls++
        },
      }),
    )
    expect(calls).toBe(0)
    expect(await row(id)).toMatchObject({
      delivered: false,
      attempts: 1,
      skipped_at: new Date(now.epochMilliseconds),
    })
    expect(
      await db
        .selectFrom('booking_notifications')
        .selectAll()
        .where('booking_id', '=', id)
        .execute(),
    ).toHaveLength(0)
  })

  it('does not steal a live ten-minute lease after the first one-minute retry delay', async () => {
    const { id } = await fixture()
    const entered = gate(),
      hold = gate()
    let calls = 0
    const config = deps({
      send: async () => {
        calls++
        entered.release()
        await hold.promise
      },
    })
    const first = dispatchConferenceNotifications(config)
    let second: Promise<void> | undefined
    try {
      await entered.promise
      const originalLease = (await row(id)).lease_id
      now = NOW.add({ minutes: 2 })
      let secondFinished = false
      second = dispatchConferenceNotifications(config).then(() => {
        secondFinished = true
      })
      await until(async () => secondFinished || (await row(id)).attempts > 1)
      expect((await row(id)).attempts).toBe(1)
      expect((await row(id)).lease_id).toBe(originalLease)
      expect(calls).toBe(1)
    } finally {
      hold.release()
      await Promise.all([first, second])
    }
    expect(calls).toBe(2)
    expect((await row(id)).delivered).toBe(true)
  })

  for (const code of [450, 550]) {
    it(`bounds persistent ${code} refusal across cron runs, with exponential delay and post-start cap`, async () => {
      const { id } = await fixture()
      let calls = 0
      const config = deps({
        send: async () => {
          calls++
          throw new MailRejectedError({ responseCode: code, atRecipient: true })
        },
      })
      const delays = [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600, 3600, 3600, 3600]
      for (const [index, delay] of delays.entries()) {
        const attempt = index + 1
        const started = now.epochMilliseconds
        await dispatchConferenceNotifications(config)
        const current = await row(id)
        expect(current.attempts).toBe(attempt)
        expect(current.due_at.getTime() - started).toBe(delay * 1000)
        expect(current.delivered).toBe(false)
        expect(current.lease_id).toBeNull()
        expect(current.exhausted_at !== null).toBe(attempt === 13)
        const before = calls
        now = Temporal.Instant.fromEpochMilliseconds(current.due_at.getTime() - 1)
        await dispatchConferenceNotifications(config)
        expect(calls).toBe(before)
        expect((await row(id)).attempts).toBe(attempt)
        now = now.add({ milliseconds: 1 })
      }
      expect(calls).toBe(26)
      now = NOW.add({ hours: 24 * 8 })
      for (let run = 0; run < 25; run++) await dispatchConferenceNotifications(config)
      expect(calls).toBe(26)
      expect((await row(id)).attempts).toBe(13)
      expect(logs.filter((line) => line.includes('exhausted'))).toHaveLength(1)
    })
  }

  it('budgets transport failures per booking without starving a healthy booking or storing raw errors', async () => {
    const first = await fixture()
    const second = await fixture()
    const badHost = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', first.host.userId)
      .executeTakeFirstOrThrow()
    const sent: MailMessage[] = []
    await expect(
      dispatchConferenceNotifications(
        deps({
          send: async (message) => {
            if (message.to === badHost.email)
              throw new Error('synthetic-private-recipient@example.test synthetic-private-link')
            sent.push(message)
          },
        }),
      ),
    ).resolves.toBeUndefined()
    expect((await row(first.id)).last_error).toBe('delivery_failed')
    expect((await row(first.id)).delivered).toBe(false)
    expect((await row(second.id)).delivered).toBe(true)
    expect(sent).toHaveLength(2)
    expect(JSON.stringify(await row(first.id))).not.toContain('synthetic-private')
    expect(logs.join(' ')).not.toContain('synthetic-private')
  })

  it('retries only the temporarily refused booker after the host receipt committed', async () => {
    const { id } = await fixture()
    const delivered: string[] = []
    let refuse = true
    const config = deps({
      send: async (message) => {
        if (message.to === 'booker@example.test' && refuse)
          throw new MailRejectedError({ responseCode: 450, atRecipient: true })
        delivered.push(message.to)
      },
    })
    await dispatchConferenceNotifications(config)
    expect(delivered).toHaveLength(1)
    now = Temporal.Instant.fromEpochMilliseconds((await row(id)).due_at.getTime())
    refuse = false
    await dispatchConferenceNotifications(config)
    await dispatchConferenceNotifications(config)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toBe('booker@example.test')
    expect((await row(id)).attempts).toBe(2)
    expect((await row(id)).delivered).toBe(true)
  })

  it('commits a single claim across dispatchers and holds no booking/outbox row locks over SMTP', async () => {
    const { id } = await fixture()
    const entered = gate()
    const hold = gate()
    let calls = 0
    const config = deps({
      send: async () => {
        calls++
        entered.release()
        await hold.promise
      },
    })
    const sending = dispatchConferenceNotifications(config)
    try {
      await entered.promise
      expect((await row(id)).attempts).toBe(1)
      expect((await row(id)).lease_id).not.toBeNull()
      const client = await owned.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE NOWAIT', [id])
        await client.query(
          'SELECT booking_id FROM booking_conference_notifications WHERE booking_id=$1 FOR UPDATE NOWAIT',
          [id],
        )
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      await dispatchConferenceNotifications(config)
      expect(calls).toBe(1)
      expect((await row(id)).attempts).toBe(1)
    } finally {
      hold.release()
      await sending
    }
    expect(calls).toBe(2)
    expect((await row(id)).delivered).toBe(true)
  })

  it('fences an expired worker from later recipients and the replacement claim completion', async () => {
    const { id } = await fixture()
    const firstEntered = gate()
    const firstHold = gate()
    const secondHold = gate()
    let secondRecipientStarted = false
    const sent: string[] = []
    const first = dispatchConferenceNotifications(
      deps({
        send: async (m) => {
          firstEntered.release()
          await firstHold.promise
          sent.push(m.to)
        },
      }),
    )
    let second: Promise<void> | undefined
    try {
      await firstEntered.promise
      const originalLease = (await row(id)).lease_id
      now = NOW.add({ minutes: 11 })
      second = dispatchConferenceNotifications(
        deps({
          send: async (m) => {
            secondRecipientStarted = true
            await secondHold.promise
            sent.push(m.to)
          },
        }),
      )
      await until(async () => (await row(id)).attempts === 2)
      const replacementLease = (await row(id)).lease_id
      expect(replacementLease).not.toBe(originalLease)
      firstHold.release()
      await first
      await until(async () => secondRecipientStarted || (await row(id)).delivered)
      expect(secondRecipientStarted).toBe(true)
      const current = await row(id)
      expect(current.delivered).toBe(false)
      expect(current.lease_id).toBe(replacementLease)
    } finally {
      firstHold.release()
      secondHold.release()
      await Promise.all([first, second])
    }
    expect(sent).toHaveLength(2)
    expect(sent.filter((address) => address === 'booker@example.test')).toHaveLength(1)
    expect((await row(id)).delivered).toBe(true)
  })

  it('does not fabricate delivery when its lease expires during a real user lock wait', async () => {
    const { id, host } = await fixture()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM auth."user" WHERE id=$1 FOR UPDATE', [host.userId])
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    expect(blockerPid).toBeTypeOf('number')
    let calls = 0
    const config = deps({
      send: async () => {
        calls++
      },
    })
    const sending = dispatchConferenceNotifications(config)
    let held = true
    try {
      await until(async () => {
        const result = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',
          [blockerPid],
        )
        return (await row(id)).attempts === 1 && result.rows[0]?.blocked === true
      })
      now = now.add({ minutes: 11 })
      await blocker.query('ROLLBACK')
      held = false
      await sending
      expect(calls).toBe(0)
      expect((await row(id)).delivered).toBe(false)
      expect((await row(id)).attempts).toBe(1)
      await dispatchConferenceNotifications(config)
      expect(calls).toBe(2)
      expect((await row(id)).attempts).toBe(2)
      expect((await row(id)).delivered).toBe(true)
    } finally {
      if (held) await blocker.query('ROLLBACK')
      blocker.release()
      await sending
    }
  })

  it('checks its lease after waiting for the pinned organizer before the original booker send', async () => {
    const { id, host } = await fixture()
    await db
      .updateTable('bookings')
      .set({
        location: {
          kind: 'google_meet',
          autoCreate: true,
          url: 'https://meet.google.com/abc-defg-hij',
        },
      })
      .where('id', '=', id)
      .execute()
    await db
      .updateTable('booking_conferences')
      .set({ state: 'ready', applied_revision: 0, error_code: null })
      .where('root_booking_id', '=', id)
      .execute()
    await db
      .updateTable('booking_conference_notifications')
      .set({ kind: 'confirmed' })
      .where('booking_id', '=', id)
      .execute()
    const entered = gate(),
      hold = gate(),
      messages: MailMessage[] = []
    const config = deps({
      send: async (message) => {
        messages.push(message)
        if (messages.length === 1) {
          entered.release()
          await hold.promise
        }
      },
    })
    const sending = dispatchConferenceNotifications(config)
    const blocker = await owned.pool.connect()
    let acquiring: Promise<unknown> | undefined
    try {
      await entered.promise
      await blocker.query('BEGIN')
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      expect(pid).toBeDefined()
      acquiring = blocker.query('SELECT id FROM auth."user" WHERE id=$1 FOR UPDATE', [host.userId])
      await until(
        async () =>
          (
            await owned.pool.query<{ blocked: boolean }>(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [pid],
            )
          ).rows[0]?.blocked === true,
      )
      hold.release()
      await acquiring
      await until(
        async () =>
          (
            await owned.pool.query<{ blocked: boolean }>(
              'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked',
              [pid],
            )
          ).rows[0]?.blocked === true,
      )
      now = NOW.add({ minutes: 11 })
      await blocker.query('ROLLBACK')
      await sending
      expect(messages).toHaveLength(1)
      expect(messages[0]?.to).not.toBe('booker@example.test')
      expect((await row(id)).delivered).toBe(false)
      expect((await row(id)).attempts).toBe(1)
      await dispatchConferenceNotifications(config)
      expect(messages).toHaveLength(2)
      expect(messages[1]?.to).toBe('booker@example.test')
      expect((await row(id)).attempts).toBe(2)
      expect((await row(id)).delivered).toBe(true)
    } finally {
      hold.release()
      await acquiring?.catch(() => {})
      await blocker.query('ROLLBACK')
      blocker.release()
      await sending
    }
  })

  it('turns an expired final claim into an inspectable failure without a fourteenth send', async () => {
    const { id } = await fixture()
    await db
      .updateTable('booking_conference_notifications')
      .set({
        attempts: 13,
        lease_id: randomUUID(),
        lease_until: new Date(now.epochMilliseconds - 1),
      })
      .where('booking_id', '=', id)
      .execute()
    let calls = 0
    const config = deps({
      send: async () => {
        calls++
      },
    })
    await dispatchConferenceNotifications(config)
    await dispatchConferenceNotifications(config)
    const current = await row(id)
    expect(calls).toBe(0)
    expect(current.attempts).toBe(13)
    expect(current.delivered).toBe(false)
    expect(current.exhausted_at).not.toBeNull()
    expect(current.last_error).toBe('attempt_expired')
    expect(current.lease_id).toBeNull()
    expect(logs.filter((line) => line.includes('exhausted'))).toHaveLength(1)
  })

  it('caps expired final-claim cleanup at one hundred rows without sending or faking receipts', async () => {
    const { host } = await fixture()
    const f = createFixtures(db)
    for (let index = 0; index < 100; index++) {
      const start = Temporal.Instant.from('2030-11-04T09:00Z').add({ hours: index + 1 })
      const id = await f.booking(
        host.organizationId,
        [host.userId],
        start.toString(),
        start.add({ minutes: 30 }).toString(),
      )
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
    }
    await db
      .updateTable('booking_conference_notifications')
      .set({
        attempts: 13,
        lease_id: randomUUID(),
        lease_until: new Date(now.epochMilliseconds - 1),
      })
      .execute()
    let calls = 0
    const config = deps({
      send: async () => {
        calls++
      },
    })
    await dispatchConferenceNotifications(config)
    const first = await db.selectFrom('booking_conference_notifications').selectAll().execute()
    expect(first).toHaveLength(101)
    expect(first.filter((notice) => notice.exhausted_at !== null)).toHaveLength(100)
    expect(first.every((notice) => !notice.delivered && notice.attempts === 13)).toBe(true)
    expect(logs.filter((line) => line.includes('exhausted'))).toHaveLength(100)
    await dispatchConferenceNotifications(config)
    const second = await db.selectFrom('booking_conference_notifications').selectAll().execute()
    expect(second.every((notice) => notice.exhausted_at !== null && !notice.delivered)).toBe(true)
    expect(logs.filter((line) => line.includes('exhausted'))).toHaveLength(101)
    expect(calls).toBe(0)
    expect(await db.selectFrom('booking_notifications').selectAll().execute()).toHaveLength(0)
  })

  it('keeps REQUEST pending while its pinned organizer is unverified instead of fabricating delivery', async () => {
    const { id, host } = await fixture()
    await db
      .updateTable('bookings')
      .set({
        location: {
          kind: 'google_meet',
          autoCreate: true,
          url: 'https://meet.google.com/abc-defg-hij',
        },
      })
      .where('id', '=', id)
      .execute()
    await db
      .updateTable('booking_conferences')
      .set({ state: 'ready', applied_revision: 0, error_code: null })
      .where('root_booking_id', '=', id)
      .execute()
    await db
      .updateTable('booking_conference_notifications')
      .set({ kind: 'confirmed' })
      .where('booking_id', '=', id)
      .execute()
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', host.userId)
      .execute()
    const messages: MailMessage[] = []
    const config = deps({
      send: async (message) => {
        messages.push(message)
      },
    })
    await dispatchConferenceNotifications(config)
    expect(messages).toHaveLength(0)
    expect((await row(id)).delivered).toBe(false)
    expect((await row(id)).attempts).toBe(1)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', host.userId)
      .execute()
    now = Temporal.Instant.fromEpochMilliseconds((await row(id)).due_at.getTime())
    await dispatchConferenceNotifications(config)
    expect(messages).toHaveLength(2)
    expect(
      messages.every((message) => message.attachments?.[0]?.content.includes('METHOD:REQUEST')),
    ).toBe(true)
    expect((await row(id)).delivered).toBe(true)
  })

  it('persists a consumed interrupted attempt then propagates shutdown and recovers only when due', async () => {
    const { id } = await fixture()
    const entered = gate()
    const controller = new AbortController()
    const sending = dispatchConferenceNotifications(
      deps({
        send: async (_message, { signal } = {}) => {
          entered.release()
          await new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
          )
        },
      }),
      controller.signal,
    )
    const outcome = sending.then(
      () => 'unexpected-success',
      () => 'aborted',
    )
    await entered.promise
    controller.abort(new Error('synthetic shutdown'))
    expect(await outcome).toBe('aborted')
    expect((await row(id)).last_error).toBe('interrupted')
    expect((await row(id)).attempts).toBe(1)
    expect((await row(id)).lease_id).toBeNull()
    let calls = 0
    const recovery = deps({
      send: async () => {
        calls++
      },
    })
    await dispatchConferenceNotifications(recovery)
    expect(calls).toBe(0)
    now = now.add({ minutes: 1 })
    await dispatchConferenceNotifications(recovery)
    expect(calls).toBe(2)
    expect((await row(id)).attempts).toBe(2)
    expect((await row(id)).delivered).toBe(true)
  })
})
