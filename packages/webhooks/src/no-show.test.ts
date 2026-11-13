import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db, isImportedBooking } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { webhookAttendeeNoShowNotifier, webhookBookingNotifier } from './delivery.ts'
import { createWebhook, WEBHOOK_EVENTS } from './service.ts'
import { SLACK_EVENTS, slackPayload } from './slack-format.ts'

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
    // Each change's event ID is its receipt identity under 0064's unchanged unique key.
    for (const row of deliveries) expect(row.request_id).toBe(row.event_id)
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
      expect(payload.data).not.toHaveProperty('requestId')
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

  const lifecycleTypes = ['created', 'cancelled', 'rescheduled'] as const
  async function captureLifecycleReplay(
    type: (typeof lifecycleTypes)[number],
    notifier = webhookBookingNotifier,
  ) {
    const { webhook, event } = await fixture()
    const queue = { enqueue: vi.fn(async () => randomUUID()) }
    const notify = notifier(queue, settings)
    const lifecycle = { type, bookingId: event.bookingId, start: now }
    await db.transaction().execute((trx) => notify(trx, lifecycle, now))
    await db
      .transaction()
      .execute((trx) => webhookAttendeeNoShowNotifier(queue, settings)(trx, event, now))
    await db.transaction().execute((trx) => notify(trx, lifecycle, now))
    return { deliveries: await rows(webhook.id), queue }
  }

  function expectLifecycleDeduplication(
    deliveries: Awaited<ReturnType<typeof rows>>,
    type: (typeof lifecycleTypes)[number],
  ) {
    const lifecycle = deliveries.filter((row) => row.event_type === `booking.${type}`)
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]?.request_id).toBeNull()
    expect(JSON.parse(lifecycle[0]?.payload ?? '{}').data).not.toHaveProperty('requestId')
  }

  it.each(lifecycleTypes)(
    'deduplicates repeated %s capture around an attendance change with a NULL request receipt',
    async (type) => {
      const { deliveries, queue } = await captureLifecycleReplay(type)
      expectLifecycleDeduplication(deliveries, type)
      const attendance = deliveries.filter(
        (row) => row.event_type === 'booking.attendee_no_show_changed',
      )
      expect(attendance).toHaveLength(1)
      expect(attendance[0]?.request_id).toBe(attendance[0]?.event_id)
      expect(deliveries).toHaveLength(2)
      expect(queue.enqueue).toHaveBeenCalledTimes(2)
    },
  )

  function captureCopy(before: string, after: string) {
    const source = readFileSync(new URL('./delivery.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function captureBookingWebhook(')
    const end = source.indexOf('export function webhookDeliveryJob', start)
    const original = source.slice(start, end)
    expect(original).toContain(before)
    const mutant = stripTypeScriptTypes(original.replace(before, after))
    return new Function(
      'randomUUID',
      'isImportedBooking',
      'sql',
      'WEBHOOK_DELIVERY_JOB',
      'SLACK_EVENTS',
      'slackPayload',
      `${mutant}; return captureBookingWebhook`,
    )(randomUUID, isImportedBooking, sql, 'webhook-delivery', SLACK_EVENTS, slackPayload)
  }

  it('source-copy negative control detects a missing global capture guard', async () => {
    const capture = captureCopy('if (!settings.enabled) return', '')
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

  it('source-copy negative control detects a missing per-change receipt identity', async () => {
    const capture = captureCopy(
      "event.type === 'attendee_no_show_changed' ? eventId : requestId",
      'requestId',
    )
    const { webhook, event } = await fixture()
    for (const change of [event, { ...event, noShowMarkedAt: null, noShowMarkedBy: null }])
      await db
        .transaction()
        .execute((trx) =>
          capture(
            { enqueue: async () => randomUUID() },
            settings,
            trx,
            { type: 'attendee_no_show_changed', ...change },
            now,
          ),
        )
    const actual = await rows(webhook.id)
    expect(() => expect(actual).toHaveLength(2)).toThrow()
  })

  it.each(lifecycleTypes)(
    'source-copy negative control detects per-change receipt identities breaking %s deduplication',
    async (type) => {
      const capture = captureCopy(
        "event.type === 'attendee_no_show_changed' ? eventId : requestId",
        'eventId',
      )
      const { deliveries } = await captureLifecycleReplay(
        type,
        (queue, options) => (trx, event, at) => capture(queue, options, trx, event, at),
      )
      expect(() => expectLifecycleDeduplication(deliveries, type)).toThrow()
    },
  )
})
