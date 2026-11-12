import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findSlots } from './availability.ts'
import { createPublicBooking } from './bookings.ts'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import { type Change, sourceCopy } from './reschedule-request-source-copy.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-11-01T12:00Z')
const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error('Missing fixture')
  return value
}

describe.skipIf(!serverUrl)('reschedule request expiry serialization', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  function scenario(change?: Change) {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // findSlots runs after managedRequest has read pending, with the booking row locked,
    // but before the move resolves the request. Expiry must wait at exactly this point.
    const copy = sourceCopy(change, async (...args) => {
      entered.resolve()
      await release.promise
      return findSlots(...args)
    })
    return { copy, entered, release }
  }

  async function verify({ copy, entered, release }: ReturnType<typeof scenario>) {
    const fixtures = createFixtures(db)
    const host = await fixtures.host()
    await fixtures.schedule(host.userId)
    await fixtures.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const events: BookingEvent[] = []
    const pub: PublicContext = {
      db,
      now: () => now,
      notify: async (_trx, event) => {
        events.push(event)
      },
    }
    const ctx: ServiceContext = {
      ...pub,
      principal: {
        kind: 'session',
        sessionId: 'test',
        user: { id: host.userId, name: 'Host', email: 'host@example.test' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const created = await createPublicBooking(pub, {
      handle: host.handle,
      slug: 'intro',
      start: Temporal.Instant.from('2026-11-02T09:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
    })
    const requested = await copy.requestReschedule(ctx, created.booking.id, {
      idempotencyKey: randomUUID(),
    })
    const requestId = required(requested.pendingReschedule).id
    const picking = copy.rescheduleManagedBooking(pub, required(created.manageToken), {
      start: Temporal.Instant.from('2026-11-02T10:00Z'),
      rescheduleRequestId: requestId,
    })
    let expiring: Promise<void> | undefined
    try {
      await entered.promise
      let expiryFinished = false
      expiring = copy
        .expireRescheduleRequest(
          { ...pub, now: () => Temporal.Instant.from(created.booking.start) },
          requestId,
        )
        .finally(() => {
          expiryFinished = true
        })
      // Observe PostgreSQL's actual lock wait, not a timing-dependent sleep. The mutant
      // instead completes expiry while pick is paused and deterministically corrupts state.
      await expect
        .poll(
          async () => {
            if (expiryFinished) return true
            const waiting = await owned.pool.query<{ waiting: boolean }>(`
          select exists (
            select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like 'select "id" from "bookings"%for update%'
          ) as waiting
        `)
            return waiting.rows[0]?.waiting === true
          },
          { timeout: 5000 },
        )
        .toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled([picking, ...(expiring ? [expiring] : [])])
    }
    const moved = await picking
    await expiring
    expect(moved.booking.rescheduledFromId).toBe(created.booking.id)
    expect(
      await db
        .selectFrom('booking_reschedule_requests')
        .select(['state', 'picked_booking_id'])
        .where('id', '=', requestId)
        .executeTakeFirst(),
    ).toEqual({ state: 'picked', picked_booking_id: moved.booking.id })
    expect(events.filter((event) => event.type === 'reschedule_request_expired')).toHaveLength(0)
  }

  it('holds expiry behind a pick that already checked its pending request', async () => {
    await verify(scenario())
  })
  it('detects removal of the expiry booking lock with a real state assertion', async () => {
    // Construct before the rejection matcher so a missing mutation cannot satisfy it.
    const mutated = scenario([
      ".where('id', '=', request.booking_id)\n      .forUpdate()",
      ".where('id', '=', request.booking_id)",
    ])
    await expect(verify(mutated)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: { state: 'expired', picked_booking_id: null },
      expected: { state: 'picked', picked_booking_id: expect.any(String) },
    })
  })
})
