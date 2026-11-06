import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db, isImportedBooking } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { webhookAttendeeNoShowNotifier } from './delivery.ts'
import { createWebhook, WEBHOOK_EVENTS } from './service.ts'

const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 9).toString('base64') }
const now = Temporal.Instant.from('2030-11-03T12:00Z')

describe.skipIf(!process.env.DATABASE_URL)('private attendee no-show webhooks', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'noshow_hooks',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  async function fixture() {
    const user = await createTestUser(db)
    const { webhook } = await createWebhook(testContext(db, user.principal), settings, {
      url: 'https://hooks.example.com/attendance',
      events: [...WEBHOOK_EVENTS],
    })
    const bookingId = await createFixtures(db).booking(
      user.principal.organization.id,
      [user.id],
      '2030-11-03T09:00Z',
      '2030-11-03T09:30Z',
    )
    const event = {
      bookingId,
      attendeeId: randomUUID(),
      noShowMarkedAt: now.toString(),
      noShowMarkedBy: user.id,
    }
    return { webhook, event }
  }
  const rows = (id: string) =>
    db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', id)
      .orderBy('id')
      .execute()

  it('captures every transition with distinct IDs and only bounded attendance metadata', async () => {
    const { webhook, event } = await fixture()
    const queue = { enqueue: vi.fn(async () => randomUUID()) }
    const notify = webhookAttendeeNoShowNotifier(queue, settings)
    for (const change of [event, { ...event, noShowMarkedAt: null, noShowMarkedBy: null }, event]) {
      await db.transaction().execute((trx) => notify(trx, change, now))
    }
    const deliveries = await rows(webhook.id)
    expect(deliveries).toHaveLength(3)
    expect(new Set(deliveries.map((row) => row.event_id)).size).toBe(3)
    expect(queue.enqueue).toHaveBeenCalledTimes(3)
    expect(
      deliveries.filter((row) => JSON.parse(row.payload).data.noShowMarkedAt === null),
    ).toHaveLength(1)
    for (const row of deliveries) {
      const payload = JSON.parse(row.payload)
      expect(payload.type).toBe('booking.attendee_no_show_changed')
      expect(Object.keys(payload.data).sort()).toEqual(
        [
          'attendeeId',
          'bookingId',
          'end',
          'eventTypeId',
          'noShowMarkedAt',
          'noShowMarkedBy',
          'organizationId',
          'rescheduledFromId',
          'source',
          'start',
          'status',
        ].sort(),
      )
      expect(payload.data.attendeeId).toBe(event.attendeeId)
      expect([null, event.noShowMarkedAt]).toContain(payload.data.noShowMarkedAt)
    }
  })

  it('rolls attendance capture back if queueing fails and captures nothing when disabled', async () => {
    const { webhook, event } = await fixture()
    const queue = {
      enqueue: vi.fn(async (): Promise<string> => {
        throw new Error('queue unavailable')
      }),
    }
    await expect(
      db
        .transaction()
        .execute((trx) => webhookAttendeeNoShowNotifier(queue, settings)(trx, event, now)),
    ).rejects.toThrow('queue unavailable')
    expect(await rows(webhook.id)).toEqual([])
    queue.enqueue.mockClear()
    await db
      .transaction()
      .execute((trx) => webhookAttendeeNoShowNotifier(queue, { enabled: false })(trx, event, now))
    expect(queue.enqueue).not.toHaveBeenCalled()
    expect(await rows(webhook.id)).toEqual([])
  })

  it('source-copy negative control detects a missing global capture guard', async () => {
    const source = readFileSync(new URL('./delivery.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function captureBookingWebhook(')
    const end = source.indexOf('export function webhookDeliveryJob', start)
    const original = source.slice(start, end)
    expect(original).toContain('if (!settings.enabled) return')
    const mutant = stripTypeScriptTypes(original.replace('if (!settings.enabled) return', ''))
    const capture = new Function(
      'randomUUID',
      'isImportedBooking',
      'sql',
      'WEBHOOK_DELIVERY_JOB',
      `${mutant}; return captureBookingWebhook`,
    )(randomUUID, isImportedBooking, sql, 'webhook-delivery')
    const { webhook, event } = await fixture()
    await db
      .transaction()
      .execute((trx) =>
        capture(
          { enqueue: async () => randomUUID() },
          { enabled: false },
          trx,
          { type: 'attendee_no_show_changed', ...event },
          now,
        ),
      )
    const actual = await rows(webhook.id)
    expect(() => expect(actual).toEqual([])).toThrow()
  })
})
