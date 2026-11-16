import { createHmac, timingSafeEqual } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { setAttendeeNoShow } from '@hourmere/scheduling'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  deliverWebhook,
  webhookAttendeeNoShowNotifier,
  webhookBookingNotifier,
  webhookDeliveryJob,
} from './delivery.ts'
import { createWebhook } from './service.ts'
import type { WebhookRequest } from './transport.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-03T12:00:00Z')
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 7).toString('base64') }
const signal = () => new AbortController().signal

/** A receiver's verification, written independently of the server's signing helper. */
function verifies(secret: string, request: WebhookRequest): boolean {
  const timestamp = request.headers['webhook-timestamp'] ?? ''
  const header = request.headers['webhook-signature'] ?? ''
  if (!/^v1=[0-9a-f]{64}$/.test(header)) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${request.body}`).digest()
  return timingSafeEqual(Buffer.from(header.slice(3), 'hex'), expected)
}

describe.skipIf(!serverUrl)('no-show webhook delivery through the real marking service', () => {
  let owned: TestDatabase
  let db: Db
  let jobs: ReturnType<typeof createJobs<ReturnType<typeof webhookDeliveryJob>[]>>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'noshow_delivery' })
    db = createDb(owned.pool)
    jobs = createJobs({
      connectionString: owned.url,
      definitions: [webhookDeliveryJob({ db, ...settings })],
      work: false,
      migrate: true,
    })
    await jobs.start()
  })
  afterAll(async () => {
    await jobs?.stop()
    await owned?.drop()
  })

  async function fixture() {
    const user = await createTestUser(db)
    const ctx = {
      ...testContext(db, user.principal, () => NOW),
      notifyAttendeeNoShow: webhookAttendeeNoShowNotifier(jobs, settings),
    }
    const { webhook, secret } = await createWebhook(ctx, settings, {
      url: 'https://hooks.example.com/attendance',
      events: ['booking.created', 'booking.attendee_no_show_changed'],
    })
    const bookingId = await createFixtures(db).booking(
      user.principal.organization.id,
      [user.id],
      '2026-11-03T09:00Z',
      '2026-11-03T09:30Z',
    )
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow()
    return { ctx, webhook, secret, bookingId, attendeeId: attendee.id }
  }
  const deliveries = (webhookId: string) =>
    db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', webhookId)
      .orderBy('created_at')
      .orderBy('id')
      .execute()

  it('signs no-show deliveries exactly like booking.created, with one delivery per actual change', async () => {
    const { ctx, webhook, secret, bookingId, attendeeId } = await fixture()
    await db
      .transaction()
      .execute((trx) =>
        webhookBookingNotifier(jobs, settings)(
          trx,
          { type: 'created', bookingId, start: Temporal.Instant.from('2026-11-03T09:00Z') },
          NOW,
        ),
      )
    // A mark, its replay and two concurrent identical unmarks: two actual changes.
    await setAttendeeNoShow(ctx, bookingId, attendeeId, true)
    await setAttendeeNoShow(ctx, bookingId, attendeeId, true)
    await Promise.all([
      setAttendeeNoShow(ctx, bookingId, attendeeId, false),
      setAttendeeNoShow(ctx, bookingId, attendeeId, false),
    ])
    const rows = await deliveries(webhook.id)
    expect(rows.map((row) => row.event_type)).toEqual([
      'booking.created',
      'booking.attendee_no_show_changed',
      'booking.attendee_no_show_changed',
    ])
    expect(new Set(rows.map((row) => row.event_id)).size).toBe(3)

    const requests: WebhookRequest[] = []
    const deps = {
      db,
      ...settings,
      transport: async (request: WebhookRequest) => {
        requests.push(request)
        return 204
      },
      now: () => NOW,
    }
    for (const row of rows) await deliverWebhook(deps, row.id, signal())
    // A replayed delivery job after success sends nothing again.
    for (const row of rows) await deliverWebhook(deps, row.id, signal())
    expect(requests).toHaveLength(3)
    const [created, marked, unmarked] = requests
    if (!created || !marked || !unmarked) throw new Error('Missing requests')
    for (const request of requests) {
      expect(Object.keys(request.headers).sort()).toEqual(Object.keys(created.headers).sort())
      expect(verifies(secret, request)).toBe(true)
      expect(verifies(`${secret}x`, request)).toBe(false)
    }
    expect(marked.url).toBe(created.url)
    const createdBody = JSON.parse(created.body)
    for (const [request, markedAt] of [
      [marked, NOW.toString()],
      [unmarked, null],
    ] as const) {
      const body = JSON.parse(request.body)
      expect(Object.keys(body).sort()).toEqual(Object.keys(createdBody).sort())
      expect(body.type).toBe('booking.attendee_no_show_changed')
      // Only the three attendance fields are added to what booking events already expose.
      expect(
        Object.keys(body.data)
          .filter((key) => !(key in createdBody.data))
          .sort(),
      ).toEqual(['attendeeId', 'noShowMarkedAt', 'noShowMarkedBy'])
      expect(body.data.attendeeId).toBe(attendeeId)
      expect(body.data.noShowMarkedAt === null ? null : NOW.toString()).toBe(markedAt)
      expect(request.body).not.toMatch(/invitee@example\.com|Invitee|manage/i)
      expect(request.headers['webhook-event-id']).toBe(body.id)
    }
  })
})
