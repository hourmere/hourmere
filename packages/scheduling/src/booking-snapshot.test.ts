import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelManagedBooking,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const CANCELLED_AT = NOW.add({ minutes: 5 })
const REASON = 'The invitee cancelled during hydration'
const readers = ['public manage', 'host detail', 'host list'] as const
type Reader = (typeof readers)[number]
type Provider = 'zoom' | 'google_meet'

describe.skipIf(!serverUrl)('booking hydration snapshot', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(provider: Provider) {
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'snapshot' })
    const result = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'snapshot',
      start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    })
    const url =
      provider === 'zoom'
        ? 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
        : 'https://meet.google.com/aaa-bbbb-ccc'
    // A ready worker result, without making any provider request.
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bookings')
        .set({ location: JSON.stringify({ kind: provider, autoCreate: true, url }) })
        .where('id', '=', result.booking.id)
        .execute()
      await trx
        .insertInto('booking_conferences')
        .values({
          root_booking_id: result.booking.id,
          booking_id: result.booking.id,
          organization_id: host.organizationId,
          organizer_user_id: host.userId,
          provider,
          state: 'ready',
          applied_revision: 0,
          ...(provider === 'zoom'
            ? { zoom_connection_id: randomUUID(), zoom_user_id: 'synthetic-zoom-identity' }
            : {}),
        })
        .execute()
    })
    const service: ServiceContext = {
      ...ctx,
      principal: {
        kind: 'session',
        sessionId: 'snapshot-session',
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: '', slug: '', personal: true },
      },
    }
    const read = async (reader: Reader, observed = db) => {
      const context = { ...service, db: observed }
      if (reader === 'public manage')
        return getManagedBooking(context, result.manageToken as string)
      if (reader === 'host detail') return getHostBooking(context, result.booking.id)
      const listed = await listHostBookings(context)
      expect(listed.data).toHaveLength(1)
      return listed.data[0] as NonNullable<(typeof listed.data)[0]>
    }
    const cancel = async (cleanup: boolean) => {
      await cancelManagedBooking(
        { ...ctx, now: () => CANCELLED_AT },
        result.manageToken as string,
        {
          reason: REASON,
        },
      )
      if (cleanup) {
        // The worker completes cancellation in one transaction: no link remains and
        // the ready state means that the latest desired revision has been applied.
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('bookings')
            .set({ location: JSON.stringify({ kind: provider, autoCreate: true }) })
            .where('id', '=', result.booking.id)
            .execute()
          await trx
            .updateTable('booking_conferences')
            .set({ state: 'ready', applied_revision: sql`revision` })
            .where('booking_id', '=', result.booking.id)
            .execute()
        })
      }
    }
    return { ...result, url, read, cancel }
  }

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const cleanup of [false, true]) {
      it.each(readers)(
        `%s uses the cancelled ${provider} snapshot when cancellation ${cleanup ? 'and cleanup commit' : 'commits'} between booking and conference reads`,
        async (reader) => {
          const b = await setup(provider)
          let cancelled = false
          let joined = false
          let lockingRead = false
          const observed = db.withPlugin({
            transformQuery: ({ node }) => {
              lockingRead ||= JSON.stringify(node).includes('ForUpdate')
              return node
            },
            async transformResult({ result }) {
              const initial = result.rows.find(
                (row) => row.id === b.booking.id && Object.hasOwn(row, 'responses'),
              )
              if (initial && !cancelled) {
                expect(initial.status).toBe('confirmed')
                expect(initial.cancelled_at).toBeNull()
                expect(initial.cancel_reason).toBeNull()
                cancelled = true
                await b.cancel(cleanup)
              }
              const conference = result.rows.find(
                (row) => row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location'),
              )
              if (conference) {
                joined = true
                expect(cancelled).toBe(true)
                expect(conference.booking_status).toBe('cancelled')
                expect(conference.state).toBe(cleanup ? 'ready' : 'pending')
              }
              return result
            },
          })
          const current = await b.read(reader, observed)
          expect(cancelled && joined).toBe(true)
          expect(lockingRead).toBe(false)
          expect(current.status).toBe('cancelled')
          expect(current.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
          expect(current.cancelReason).toBe(REASON)
          expect(current.conference).toEqual({
            provider,
            status: cleanup ? 'ready' : 'pending',
            errorCode: null,
          })
          expect(current.location).toEqual({ kind: provider, autoCreate: true })
        },
      )
    }
  }

  it.each(readers)(
    '%s keeps the complete earlier snapshot when cancellation commits after the conference join',
    async (reader) => {
      const b = await setup('zoom')
      let cancelled = false
      const observed = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (
            !cancelled &&
            result.rows.some(
              (row) => row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location'),
            )
          ) {
            cancelled = true
            await b.cancel(true)
          }
          return result
        },
      })
      const current = await b.read(reader, observed)
      expect(cancelled).toBe(true)
      expect(current.status).toBe('confirmed')
      expect(current.cancelledAt).toBeNull()
      expect(current.cancelReason).toBeNull()
      expect(current.conference?.status).toBe('ready')
      expect(current.location?.url).toBe(b.url)
      const next = await b.read(reader)
      expect(next.status).toBe('cancelled')
      expect(next.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
      expect(next.cancelReason).toBe(REASON)
      expect(next.location?.url).toBeUndefined()
    },
  )
})
