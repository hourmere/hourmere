import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type Mailer, type MailMessage, MailRejectedError } from '@hourmere/mail'
import { createPublicBooking } from '@hourmere/scheduling'
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
  async function fixture() {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'notice' })
    const result = await createPublicBooking(
      { db, now: () => NOW },
      {
        handle: host.handle,
        slug: 'notice',
        start: Temporal.Instant.from('2030-11-04T09:00:00Z'),
        invitee: { name: 'Synthetic Booker', email: 'booker@example.test', timeZone: 'UTC' },
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
    return { id, host }
  }

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
