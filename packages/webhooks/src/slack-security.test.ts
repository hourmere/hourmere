import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decryptWebhookSecret } from './crypto.ts'
import { deliverWebhook, type WebhookQueue } from './delivery.ts'
import {
  createSlackDestination,
  deleteSlackDestination,
  listSlackDestinations,
  testSlackDestination,
  updateSlackDestination,
} from './slack.ts'

const url = 'https://hooks.slack.com/services/TTEST/BTEST/synthetic-original'
const replacement = 'https://hooks.slack.com/services/TNEW/BNEW/synthetic-replacement'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 8).toString('base64') }
const now = Temporal.Instant.from('2026-11-01T12:00Z')

describe.skipIf(!process.env.DATABASE_URL)('Slack configuration protections', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function fixture() {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, () => now)
    const destination = await createSlackDestination(ctx, settings, {
      url,
      events: ['booking.created'],
    })
    return { user, ctx, destination }
  }
  it('bounds concurrent samples and retry pressure on the shared queue to one pending job per destination', async () => {
    const { ctx, destination } = await fixture()
    const enqueue = vi.fn(async () => null)
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        testSlackDestination(ctx, settings, destination.id, { enqueue }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    for (const result of results.filter((result) => result.status === 'rejected'))
      expect(result.reason).toMatchObject({ code: 'slack_test_pending', kind: 'conflict' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const pending = await db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', destination.id)
      .execute()
    expect(pending).toHaveLength(1)
    const delivery = pending[0]
    if (!delivery) throw new Error('Missing delivery')
    const transport = vi.fn(async () => 429)
    for (let attempt = 1; attempt <= 13; attempt++) {
      await expect(
        deliverWebhook(
          { db, ...settings, transport, now: () => now },
          delivery.id,
          new AbortController().signal,
          attempt,
        ),
      ).rejects.toThrow('Webhook delivery failed')
      if (attempt < 13)
        await expect(
          testSlackDestination(ctx, settings, destination.id, { enqueue }),
        ).rejects.toMatchObject({ code: 'slack_test_pending' })
    }
    expect(transport).toHaveBeenCalledTimes(13)
    expect(enqueue).toHaveBeenCalledTimes(1)
    await expect(testSlackDestination(ctx, settings, destination.id, { enqueue })).resolves.toEqual(
      { deliveryId: expect.any(String) },
    )
    expect(enqueue).toHaveBeenCalledTimes(2)
  })
  it('allows another sample after successful delivery without colliding with retained history', async () => {
    const { ctx, destination } = await fixture()
    const enqueue = vi.fn(async () => null)
    const first = await testSlackDestination(ctx, settings, destination.id, { enqueue })
    const transport = vi.fn(async () => 200)
    await deliverWebhook(
      { db, ...settings, transport, now: () => now },
      first.deliveryId,
      new AbortController().signal,
    )
    await expect(testSlackDestination(ctx, settings, destination.id, { enqueue })).resolves.toEqual(
      { deliveryId: expect.any(String) },
    )
    const rows = await db
      .selectFrom('webhook_deliveries')
      .select(['id', 'status', 'request_id'])
      .where('webhook_id', '=', destination.id)
      .execute()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === first.deliveryId)?.status).toBe('delivered')
    expect(new Set(rows.map((row) => row.request_id)).size).toBe(2)
    expect(rows.every((row) => row.request_id !== null)).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(2)
  })
  it('refuses sample enqueue when outbound webhooks are disabled', async () => {
    const { ctx, destination } = await fixture()
    const enqueue = vi.fn(async () => null)
    await expect(
      testSlackDestination(ctx, { ...settings, enabled: false }, destination.id, { enqueue }),
    ).rejects.toMatchObject({ code: 'slack_unavailable' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', destination.id)
        .execute(),
    ).toEqual([])
  })
  it('enqueues the sample on the exact transaction containing its uncommitted delivery row', async () => {
    const { ctx, destination } = await fixture()
    const enqueue: WebhookQueue['enqueue'] = async (name, payload, options) => {
      expect(name).toBe('webhook-delivery')
      const transaction = options?.transaction as Db | undefined
      expect(transaction?.isTransaction).toBe(true)
      expect(options?.singletonKey).toBe(payload.deliveryId)
      if (!transaction) throw new Error('Missing transaction')
      const inside = await transaction
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('id', '=', payload.deliveryId)
        .executeTakeFirst()
      expect(inside?.id).toBe(payload.deliveryId)
      const outside = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('id', '=', payload.deliveryId)
        .executeTakeFirst()
      expect(outside).toBeUndefined()
      throw new Error('rollback sample')
    }
    await expect(testSlackDestination(ctx, settings, destination.id, { enqueue })).rejects.toThrow(
      'rollback sample',
    )
    expect(
      await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', destination.id)
        .execute(),
    ).toEqual([])
  })
  it('masks and encrypts replacement URLs with destination AAD and uses the new URL on the next delivery', async () => {
    const { ctx, destination } = await fixture()
    const sample = await testSlackDestination(ctx, settings, destination.id, {
      enqueue: async () => null,
    })
    const updated = await updateSlackDestination(
      ctx,
      destination.id,
      { url: replacement },
      settings,
    )
    const list = await listSlackDestinations(ctx)
    const row = await db
      .selectFrom('webhooks')
      .selectAll()
      .where('id', '=', destination.id)
      .executeTakeFirstOrThrow()
    for (const visible of [JSON.stringify(updated), JSON.stringify(list), row.url]) {
      expect(visible).not.toContain('synthetic-replacement')
      expect(visible).not.toContain('synthetic-original')
      expect(visible).toContain('https://hooks.slack.com/services/••••')
    }
    const ciphertext = row.url_ciphertext
    if (!ciphertext) throw new Error('Missing ciphertext')
    expect(ciphertext.toString()).not.toContain(replacement)
    expect(() =>
      decryptWebhookSecret(
        ciphertext,
        settings.encryptionKey,
        `${destination.id}:url`,
        destination.organizationId,
      ),
    ).not.toThrow()
    expect(
      decryptWebhookSecret(
        ciphertext,
        settings.encryptionKey,
        `${destination.id}:url`,
        destination.organizationId,
      ),
    ).toBe(replacement)
    expect(() =>
      decryptWebhookSecret(
        ciphertext,
        settings.encryptionKey,
        destination.id,
        destination.organizationId,
      ),
    ).toThrow()
    await expect(
      updateSlackDestination(
        ctx,
        destination.id,
        { url: 'https://evil.test/services/T/B/C' },
        settings,
      ),
    ).rejects.toMatchObject({ code: 'invalid_slack_destination' })
    const unchanged = await db
      .selectFrom('webhooks')
      .select('url_ciphertext')
      .where('id', '=', destination.id)
      .executeTakeFirstOrThrow()
    expect(unchanged.url_ciphertext).toEqual(row.url_ciphertext)
    const transport = vi.fn(async () => 200)
    await deliverWebhook(
      { db, ...settings, transport, now: () => now },
      sample.deliveryId,
      new AbortController().signal,
    )
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: replacement }))
  })
  it.each(['update', 'delete', 'test'] as const)(
    '%s waiting for in-flight delivery never blocks new bookings through an organization lock',
    async (operation) => {
      const { user, ctx, destination } = await fixture()
      const fixtures = createFixtures(db)
      // Create the event type before taking locks so only the booking insert is under test.
      const bookingId = await fixtures.booking(
        destination.organizationId,
        [user.id],
        '2026-11-03T09:00Z',
        '2026-11-03T09:30Z',
      )
      const client = await owned.pool.connect()
      let change: Promise<unknown> | undefined
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM webhooks WHERE id=$1 FOR SHARE', [destination.id])
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]
          ?.pid
        change = (
          operation === 'update'
            ? updateSlackDestination(ctx, destination.id, { isActive: false }, settings)
            : operation === 'delete'
              ? deleteSlackDestination(ctx, destination.id)
              : testSlackDestination(ctx, settings, destination.id, { enqueue: async () => null })
        ).catch((error) => error)
        await vi.waitFor(async () => {
          const result = await owned.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(result.rows.length).toBeGreaterThan(0)
        })
        // INSERT copies realistic existing booking data and exercises its organization FK.
        await expect(
          db.transaction().execute(async (trx) => {
            await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx)
            await sql`INSERT INTO bookings (organization_id, event_type_id, start_at, end_at, status, title, source)
          SELECT organization_id, event_type_id, start_at + interval '1 day', end_at + interval '1 day', status, title, source
          FROM bookings WHERE id = ${bookingId}::uuid`.execute(trx)
          }),
        ).resolves.toBeUndefined()
      } finally {
        await client.query('ROLLBACK')
        client.release()
        await change
      }
    },
  )
})
