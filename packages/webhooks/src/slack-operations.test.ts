import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deliverWebhook, webhookBookingNotifier } from './delivery.ts'
import {
  createSlackDestination,
  listSlackDestinations,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'
import { slackPayload } from './slack-format.ts'

const now = Temporal.Instant.from('2026-11-01T12:00Z')
const settings = {
  enabled: true,
  encryptionKey: Buffer.alloc(32, 8).toString('base64'),
  publicUrl: 'https://calendar.example.com',
}
const queue = { enqueue: async () => null }
const signal = () => new AbortController().signal
it('bounds escaped untrusted fields below Slack and outbox limits', () => {
  for (const attack of ['😀'.repeat(10000), '<!channel> & @here\n'.repeat(10000)]) {
    const payload = slackPayload({
      type: 'booking.created',
      bookingId: '00000000-0000-7000-8000-000000000001',
      start: '2026-11-01T08:30Z',
      end: '2026-11-01T09:30Z',
      status: 'confirmed',
      eventTypeTitle: attack,
      inviteeName: attack,
      timeZone: 'America/Los_Angeles',
      bookingUrl: `${settings.publicUrl}/app/bookings/00000000-0000-7000-8000-000000000001`,
    })
    const parsed = JSON.parse(payload)
    expect(Buffer.byteLength(payload)).toBeLessThan(8192)
    expect(parsed.text.length).toBeLessThan(3000)
    expect(parsed.text).not.toMatch(/[<>@]/)
    expect(parsed.blocks[0].text).toEqual({ type: 'plain_text', text: parsed.text, emoji: false })
    expect(parsed.text).toContain('2026-11-01T01:30-07:00[America/Los_Angeles]')
    expect(parsed.text).toContain('2026-11-01T01:30-08:00[America/Los_Angeles]')
  }
})

it('omits an oversized escaped operator link without overflowing the snapshot', () => {
  const payload = slackPayload({
    type: 'booking.created',
    bookingId: 'safe-id',
    eventTypeTitle: '&'.repeat(1000),
    inviteeName: '&'.repeat(1000),
    bookingUrl: `https://${'&'.repeat(500)}.example.com/app/bookings/safe-id`,
  })
  const parsed = JSON.parse(payload)
  expect(parsed.text).not.toContain('https://')
  expect(parsed.text.length).toBeLessThan(3000)
  expect(Buffer.byteLength(payload)).toBeLessThan(8192)
})

describe.skipIf(!process.env.DATABASE_URL)('Slack operational safeguards', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture(team = false) {
    const owner = await createTestUser(db)
    const org = team
      ? (await createTestTeam(db, [{ user: owner, role: 'owner' }])).as(owner)
      : owner.principal
    const ctx = testContext(db, org, () => now)
    await db
      .insertInto('profiles')
      .values({
        user_id: owner.id,
        handle: `slack-${owner.id.slice(0, 8)}`,
        time_zone: 'America/Los_Angeles',
      })
      .execute()
    const destination = await createSlackDestination(ctx, settings, {
      url: 'https://hooks.slack.com/services/TTEST/BTEST/synthetic',
      events: ['booking.created', 'booking.cancelled'],
    })
    const activity = await createFixtures(db).eventType(org.organization.id, owner.id, {
      title: 'Activity <!channel> @here',
    })
    const bookingId = await createFixtures(db).booking(
      org.organization.id,
      [owner.id],
      '2026-11-01T08:30Z',
      '2026-11-01T09:30Z',
      {
        eventTypeId: activity,
        attendee: { name: 'Invitee <!here>', email: 'private@example.com' },
      },
    )
    await db
      .updateTable('bookings')
      .set({
        title: 'PRIVATE_BOOKING_TITLE',
        responses: JSON.stringify({ answer: 'PRIVATE_ANSWER' }),
        cancel_reason: 'PRIVATE_REASON',
      })
      .where('id', '=', bookingId)
      .execute()
    const capture = (enabled = true, type: 'created' | 'cancelled' = 'created') =>
      db
        .transaction()
        .execute((trx) =>
          webhookBookingNotifier(queue, { ...settings, enabled })(
            trx,
            { type, bookingId, start: now },
            now,
          ),
        )
    const rows = () =>
      db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', destination.id)
        .orderBy('id')
        .execute()
    return { ctx, destination, bookingId, activity, capture, rows }
  }
  it.each([false, true])('projects useful bounded booking fields for team=%s', async (team) => {
    const f = await fixture(team)
    await f.capture()
    const payload = (await f.rows())[0]?.payload ?? ''
    const text = JSON.parse(payload).text
    expect(text).toContain('Activity &lt;!channel&gt; ＠here')
    expect(text).toContain('Status: confirmed')
    expect(text).toContain(`${settings.publicUrl}/app/bookings/${f.bookingId}`)
    expect(text).toContain(
      team ? '2026-11-01T08:30+00:00[UTC]' : '2026-11-01T01:30-07:00[America/Los_Angeles]',
    )
    if (team) expect(text).not.toContain('Invitee')
    else expect(text).toContain('Invitee: Invitee &lt;!here&gt;')
    for (const value of [
      'PRIVATE_BOOKING_TITLE',
      'PRIVATE_ANSWER',
      'PRIVATE_REASON',
      'private@example.com',
    ])
      expect(payload).not.toContain(value)
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', f.activity)
      .execute()
    await f.capture(true, 'cancelled')
    expect((await f.rows())[1]?.payload).not.toContain('Activity')
  })
  it('honors the operator switch at capture and delivery', async () => {
    const f = await fixture()
    await f.capture(false)
    expect(await f.rows()).toHaveLength(0)
    await f.capture()
    const transport = vi.fn(async () => 200)
    await deliverWebhook(
      { db, ...settings, enabled: false, transport, now: () => now },
      (await f.rows())[0]?.id as string,
      signal(),
    )
    expect(transport).not.toHaveBeenCalled()
    expect((await f.rows())[0]).toMatchObject({
      status: 'skipped',
      last_error: 'disabled',
      attempts: 0,
    })
  })
  it.each([404, 410])(
    'atomically pauses revoked HTTP %s destinations after one attempt',
    async (status) => {
      const f = await fixture()
      await f.capture()
      const sample = await testSlackDestination(f.ctx, settings, f.destination.id, queue)
      const transport = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return status
      })
      await expect(
        Promise.all(
          (await f.rows()).map((row) =>
            deliverWebhook({ db, ...settings, transport, now: () => now }, row.id, signal()),
          ),
        ),
      ).resolves.toEqual([undefined, undefined])
      expect(transport).toHaveBeenCalledTimes(1)
      expect((await listSlackDestinations(f.ctx))[0]).toMatchObject({
        isActive: false,
        pauseReason: 'url_rejected',
      })
      const rows = await f.rows()
      expect(rows.filter((row) => row.status === 'failed')).toHaveLength(1)
      expect(rows.find((row) => row.status === 'failed')).toMatchObject({
        attempts: 1,
        http_status: status,
      })
      expect(rows.filter((row) => row.status === 'skipped')).toHaveLength(1)
      await deliverWebhook(
        { db, ...settings, transport, now: () => now },
        sample.deliveryId,
        signal(),
      )
      expect(transport).toHaveBeenCalledTimes(1)
    },
  )
  it('does not block booking capture during an in-flight Slack network request', async () => {
    const f = await fixture()
    const sample = await testSlackDestination(f.ctx, settings, f.destination.id, queue)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = vi.fn(async () => {
      await held
      return 200
    })
    const send = deliverWebhook(
      { db, ...settings, transport, now: () => now },
      sample.deliveryId,
      signal(),
    )
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
      await expect(
        db.transaction().execute(async (trx) => {
          // A database deadline gives a real assertion failure if the network-time lock
          // is strengthened to an exclusive destination lock.
          await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx)
          await webhookBookingNotifier(queue, settings)(
            trx,
            { type: 'created', bookingId: f.bookingId, start: now },
            now,
          )
        }),
      ).resolves.toBeUndefined()
      expect(await f.rows()).toHaveLength(2)
    } finally {
      release()
      await send
    }
  })
  it('keeps the rejected-URL reason only until the URL is replaced or the destination enabled', async () => {
    const f = await fixture()
    // Each pause uses a new booking event: replaying the same one is deduplicated.
    const pausedBySlack = async (type: 'created' | 'cancelled') => {
      await f.capture(true, type)
      const pending = (await f.rows()).filter((row) => row.status === 'pending')
      for (const row of pending)
        await deliverWebhook(
          { db, ...settings, transport: async () => 410, now: () => now },
          row.id,
          signal(),
        )
      expect((await listSlackDestinations(f.ctx))[0]).toMatchObject({
        isActive: false,
        pauseReason: 'url_rejected',
      })
    }
    const update = (input: Record<string, unknown>) =>
      updateSlackDestination(f.ctx, f.destination.id, input, settings)
    await pausedBySlack('created')
    // Unrelated edits and a repeated pause keep the reason: the saved URL is still rejected.
    expect(await update({ events: ['booking.cancelled', 'booking.created'] })).toMatchObject({
      pauseReason: 'url_rejected',
    })
    expect(await update({ eventTypeId: null })).toMatchObject({ pauseReason: 'url_rejected' })
    expect(await update({ isActive: false })).toMatchObject({ pauseReason: 'url_rejected' })
    expect(
      await update({ url: 'https://hooks.slack.com/services/TNEW/BNEW/replacement' }),
    ).toMatchObject({ isActive: false, pauseReason: null })
    expect(await update({ isActive: true })).toMatchObject({ isActive: true, pauseReason: null })
    await pausedBySlack('cancelled')
    expect(await update({ isActive: true })).toMatchObject({ isActive: true, pauseReason: null })
    // A manual pause never claims that Slack rejected the URL.
    expect(await update({ isActive: false })).toMatchObject({ isActive: false, pauseReason: null })
    await expect(
      db
        .updateTable('webhooks')
        .set({ is_active: true, pause_reason: 'url_rejected' })
        .where('id', '=', f.destination.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('bounds the wait for another Slack sender and leaves the delivery for a later retry', async () => {
    const f = await fixture()
    await f.capture()
    const sample = await testSlackDestination(f.ctx, settings, f.destination.id, queue)
    const [booking] = (await f.rows()).filter((row) => row.id !== sample.deliveryId)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = vi.fn(async () => {
      await held
      return 200
    })
    const deps = { db, ...settings, transport, now: () => now, slackSenderWaitMs: 50 }
    const first = deliverWebhook(deps, booking?.id as string, signal())
    let outcome: unknown
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1), { timeout: 15_000 })
      // The guard timer only stops an unbounded wait from hanging the suite.
      outcome = await Promise.race([
        deliverWebhook(deps, sample.deliveryId, signal()).then(
          () => 'delivered',
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3000)),
      ])
    } finally {
      release()
      await first
    }
    expect(outcome).toEqual(new Error('Webhook delivery deferred'))
    expect(transport).toHaveBeenCalledTimes(1)
    const deferred = (await f.rows()).find((row) => row.id === sample.deliveryId)
    expect(deferred).toMatchObject({ status: 'pending', attempts: 0, last_error: null })
    await deliverWebhook(deps, sample.deliveryId, signal())
    expect(transport).toHaveBeenCalledTimes(2)
    expect((await f.rows()).map((row) => row.status)).toEqual(['delivered', 'delivered'])
  })
  it('applies the bound only to the sender wait, not to the revoked-URL pause', async () => {
    const f = await fixture()
    await f.capture()
    const [delivery] = await f.rows()
    // An in-progress booking capture holds SHARE on the destination; the 404 pause must
    // wait for it however long it takes instead of failing after Slack answered.
    const client = await owned.pool.connect()
    let send: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM webhooks WHERE id = $1 FOR SHARE', [f.destination.id])
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      let settled = false
      send = deliverWebhook(
        { db, ...settings, transport: async () => 404, now: () => now, slackSenderWaitMs: 1 },
        delivery?.id as string,
        signal(),
      ).then(
        () => 'paused',
        (error: unknown) => error,
      )
      void send.finally(() => {
        settled = true
      })
      let queued = false
      while (!settled && !queued)
        queued =
          (
            await owned.pool.query(
              'SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))',
              [pid],
            )
          ).rows.length > 0
      expect(queued).toBe(true)
      await client.query('COMMIT')
      expect(await send).toBe('paused')
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await send
    }
    expect((await listSlackDestinations(f.ctx))[0]).toMatchObject({
      isActive: false,
      pauseReason: 'url_rejected',
    })
  })
})
