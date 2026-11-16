import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db, isImportedBooking } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { setAttendeeNoShow } from '@hourmere/scheduling'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertBookingLocallyManaged } from '../../scheduling/src/bookings.ts'
import { DomainError } from '../../scheduling/src/errors.ts'
import { isUuid } from '../../scheduling/src/internal.ts'
import { authorizeBookingNoShow } from '../../scheduling/src/no-show.ts'
import { decryptWebhookSecret, webhookSignature } from './crypto.ts'
import {
  type deliverWebhook,
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
    // Concurrent identical marks, a replay and concurrent unmarks: two actual changes.
    await Promise.all([
      setAttendeeNoShow(ctx, bookingId, attendeeId, true),
      setAttendeeNoShow(ctx, bookingId, attendeeId, true),
    ])
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
    const job = webhookDeliveryJob(deps)
    for (const row of rows) {
      const context = { id: randomUUID(), attempt: 1, signal: signal() }
      await job.handler({ deliveryId: row.id }, context)
      // Re-run the real job handler after success, with the same job identity.
      await job.handler({ deliveryId: row.id }, { ...context, attempt: 2 })
    }
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
      expect(body.data.noShowMarkedAt).toBe(
        markedAt === null ? null : new Date(NOW.epochMilliseconds).toISOString(),
      )
      expect(body.data.noShowMarkedBy).toBe(markedAt === null ? null : ctx.principal.user.id)
      expect(request.body).not.toMatch(/invitee@example\.com|Invitee|manage/i)
      expect(request.headers['webhook-event-id']).toBe(body.id)
    }
  })

  it('source-copy mutation detects duplicate delivery capture on a replayed mark', async () => {
    const source = readFileSync(new URL('../../scheduling/src/no-show.ts', import.meta.url), 'utf8')
    const original = source.slice(
      source.indexOf('export async function setAttendeeNoShow('),
      source.indexOf('export async function authorizeBookingNoShow('),
    )
    const guard = 'if ((current.noShowMarkedAt !== null) === noShow) return current'
    expect(original).toContain(guard)
    const copy = stripTypeScriptTypes(original.replace('export ', '').replace(guard, ''))
    const mutant = new Function(
      'DomainError',
      'isUuid',
      'authorizeBookingNoShow',
      'assertBookingLocallyManaged',
      'auditActor',
      'writeAuditEvent',
      `${copy}; return setAttendeeNoShow`,
    )(
      DomainError,
      isUuid,
      authorizeBookingNoShow,
      assertBookingLocallyManaged,
      auditActor,
      writeAuditEvent,
    ) as typeof setAttendeeNoShow
    const { ctx, webhook, bookingId, attendeeId } = await fixture()
    await mutant(ctx, bookingId, attendeeId, true)
    await mutant(ctx, bookingId, attendeeId, true)
    const actual = await deliveries(webhook.id)
    expect(actual).toHaveLength(2)
    expect(() => expect(actual).toHaveLength(1)).toThrow()
  })

  it('source-copy mutation detects a replayed job sending an acknowledged delivery twice', async () => {
    const source = readFileSync(new URL('./delivery.ts', import.meta.url), 'utf8')
    const original = source.slice(
      source.indexOf('export async function deliverWebhook('),
      source.indexOf('export function webhookCleanupJob('),
    )
    const guard = "if (delivery?.status !== 'pending') return false"
    expect(original).toContain(guard)
    const copy = stripTypeScriptTypes(original.replace('export ', '').replace(guard, ''))
    const mutant = new Function(
      'isImportedBooking',
      'decryptWebhookSecret',
      'webhookSignature',
      `${copy}; return deliverWebhook`,
    )(isImportedBooking, decryptWebhookSecret, webhookSignature) as typeof deliverWebhook
    const { ctx, webhook, bookingId, attendeeId } = await fixture()
    await setAttendeeNoShow(ctx, bookingId, attendeeId, true)
    const [row] = await deliveries(webhook.id)
    if (!row) throw new Error('Missing delivery')
    const requests: WebhookRequest[] = []
    const deps = {
      db,
      ...settings,
      now: () => NOW,
      transport: async (request: WebhookRequest) => {
        requests.push(request)
        return 204
      },
    }
    await mutant(deps, row.id, signal())
    await mutant(deps, row.id, signal())
    expect(requests).toHaveLength(2)
    expect(() => expect(requests).toHaveLength(1)).toThrow()
  })
})
