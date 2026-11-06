import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebhook } from './service.ts'

const target =
  process.env.HOURMERE_SILENCE_MUTATION_TARGET === 'delivery.ts'
    ? (process.env.HOURMERE_SILENCE_MUTATION_FILE as string)
    : './delivery.ts'
const { deliverWebhook, webhookBookingNotifier }: typeof import('./delivery.ts') = await import(
  target
)
const NOW = Temporal.Instant.from('2030-11-03T12:00:00Z')
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }

describe.skipIf(!process.env.DATABASE_URL)(
  'imported bookings stay local across webhook workers',
  () => {
    let database: TestDatabase
    let db: Db
    let bookingId: string
    let organizationId: string
    let webhookId: string
    beforeAll(async () => {
      database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'silent_hooks',
      })
      db = createDb(database.pool)
    })
    afterAll(async () => database?.drop())
    beforeEach(async () => {
      const user = await createTestUser(db)
      organizationId = user.principal.organization.id
      const ctx = testContext(db, user.principal, () => NOW)
      webhookId = (
        await createWebhook(ctx, settings, {
          url: 'https://hooks.example.com/hook',
          events: ['booking.created'],
        })
      ).webhook.id
      bookingId = await createFixtures(db).booking(
        organizationId,
        [user.id],
        '2030-11-04T09:00Z',
        '2030-11-04T09:30Z',
        { source: 'import' },
      )
    })
    it('webhook capture produces no durable deliveries or queue jobs', async () => {
      const queue = { enqueue: vi.fn(async () => randomUUID()) }
      await db
        .transaction()
        .execute((trx) =>
          webhookBookingNotifier(queue, settings)(
            trx,
            { type: 'created', bookingId, start: NOW.add({ hours: 21 }) },
            NOW,
          ),
        )
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('booking_id', '=', bookingId)
          .execute(),
      ).toEqual([])
    })
    it('stale durable deliveries produce zero HTTP calls and do not consume retry attempts', async () => {
      const delivery = await db
        .insertInto('webhook_deliveries')
        .values({
          organization_id: organizationId,
          webhook_id: webhookId,
          booking_id: bookingId,
          event_id: randomUUID(),
          event_type: 'booking.created',
          payload: '{}',
          created_at: NOW.toString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const transport = vi.fn(async () => 200)
      await deliverWebhook(
        { db, ...settings, transport, now: () => NOW },
        delivery.id,
        new AbortController().signal,
      )
      expect(transport).not.toHaveBeenCalled()
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select(['status', 'attempts'])
          .where('id', '=', delivery.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'pending', attempts: 0 })
    })
  },
)
