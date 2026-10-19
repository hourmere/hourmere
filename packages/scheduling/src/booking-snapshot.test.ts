import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { createFixtures, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2026-11-01T12:00:00Z')
const CANCELLED_AT = NOW.add({ minutes: 5 })
const SUCCESSOR_CANCELLED_AT = NOW.add({ minutes: 10 })
const REASON = 'The invitee cancelled during hydration'
const SUCCESSOR_REASON = 'The successor was cancelled before hydration'
const readers = ['public manage', 'host detail', 'host list'] as const
type Reader = (typeof readers)[number]
type Provider = 'zoom' | 'google_meet'
type Mover = 'host' | 'invitee'

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

  async function setup(provider: Provider | null, pinOrganizer = false) {
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'snapshot' })
    const result = await createPublicBooking(ctx, {
      handle: host.handle,
      slug: 'snapshot',
      start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    })
    const organizer = pinOrganizer
      ? await db
          .selectFrom('auth.user')
          .select('email')
          .where('id', '=', host.userId)
          .executeTakeFirstOrThrow()
      : undefined
    const url =
      provider === 'zoom'
        ? 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
        : 'https://meet.google.com/aaa-bbbb-ccc'
    // A ready worker result, without making any provider request.
    if (provider)
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
            ...(organizer
              ? { invitation_organizer_email: organizer.email, invitation_organizer_name: 'Host' }
              : {}),
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
      const booking = listed.data.find((booking) => booking.id === result.booking.id)
      expect(booking).toBeDefined()
      return booking as NonNullable<typeof booking>
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
    const move = async (mover: Mover, cancelSuccessor: boolean) => {
      const moved =
        mover === 'host'
          ? await rescheduleHostBooking(
              { ...service, now: () => CANCELLED_AT },
              result.booking.id,
              { start: Temporal.Instant.from('2026-11-02T10:00:00Z') },
            )
          : await rescheduleManagedBooking(
              { ...ctx, now: () => CANCELLED_AT },
              result.manageToken as string,
              { start: Temporal.Instant.from('2026-11-02T10:00:00Z') },
            )
      if (cancelSuccessor)
        await cancelHostBooking(
          { ...service, now: () => SUCCESSOR_CANCELLED_AT },
          moved.booking.id,
          { reason: SUCCESSOR_REASON },
        )
      return moved
    }
    return { ...result, host, service, url, read, cancel, move }
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

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const mover of ['host', 'invitee'] as const) {
      for (const cancelSuccessor of [false, true]) {
        it.each(readers)(
          `%s hydrates the old ${provider} booking when ${mover} reschedules${cancelSuccessor ? ' and cancels the successor' : ''} between reads`,
          async (reader) => {
            const b = await setup(provider)
            let successorId: string | undefined
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
                if (initial && !successorId) {
                  expect(initial.status).toBe('confirmed')
                  successorId = (await b.move(mover, cancelSuccessor)).booking.id
                  const pointer = await db
                    .selectFrom('booking_conferences')
                    .select('booking_id')
                    .where('root_booking_id', '=', b.booking.id)
                    .executeTakeFirstOrThrow()
                  expect(pointer.booking_id).toBe(successorId)
                }
                const hydrated = result.rows.find(
                  (row) =>
                    row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location'),
                )
                if (hydrated) {
                  joined = true
                  expect(successorId).toBeDefined()
                  expect(hydrated.booking_status).toBe('cancelled')
                  expect(hydrated.state).toBeNull()
                }
                return result
              },
            })
            const current = await b.read(reader, observed)
            expect(successorId).toBeDefined()
            expect(joined).toBe(true)
            expect(lockingRead).toBe(false)
            // No part of successor Y's state belongs to this response for old X,
            // including Y's later cancellation time and reason.
            expect(current.id).toBe(b.booking.id)
            expect(current.status).toBe('cancelled')
            expect(current.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
            expect(current.cancelReason).toBeNull()
            expect(current.conference).toBeUndefined()
            expect(current.location).toEqual({ kind: provider, autoCreate: true })
            const next = await b.read(reader)
            if (reader === 'public manage' && mover === 'host') {
              expect(next.id).toBe(successorId)
              expect(next.rescheduledFromId).toBe(b.booking.id)
              expect(next.status).toBe(cancelSuccessor ? 'cancelled' : 'confirmed')
              expect(next.cancelledAt).toBe(cancelSuccessor ? '2026-11-01T12:10:00.000Z' : null)
              expect(next.cancelReason).toBe(cancelSuccessor ? SUCCESSOR_REASON : null)
            } else {
              expect(next.id).toBe(b.booking.id)
              expect(next.status).toBe('cancelled')
              expect(next.conference).toBeUndefined()
            }
          },
        )
      }

      it.each(readers)(
        `%s keeps the complete earlier ${provider} snapshot when ${mover} reschedules after hydration`,
        async (reader) => {
          const b = await setup(provider)
          let moved = false
          const observed = db.withPlugin({
            transformQuery: ({ node }) => node,
            async transformResult({ result }) {
              if (
                !moved &&
                result.rows.some(
                  (row) =>
                    row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location'),
                )
              ) {
                moved = true
                await b.move(mover, true)
              }
              return result
            },
          })
          const current = await b.read(reader, observed)
          expect(moved).toBe(true)
          expect(current.id).toBe(b.booking.id)
          expect(current.status).toBe('confirmed')
          expect(current.cancelledAt).toBeNull()
          expect(current.cancelReason).toBeNull()
          expect(current.conference).toEqual({ provider, status: 'ready', errorCode: null })
          expect(current.location?.url).toBe(b.url)
        },
      )
    }
  }

  it.each(readers)(
    '%s hydrates cancellation for a booking with no conference intent',
    async (reader) => {
      const b = await setup(null)
      let cancelled = false
      const observed = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (
            !cancelled &&
            result.rows.some((row) => row.id === b.booking.id && Object.hasOwn(row, 'responses'))
          ) {
            cancelled = true
            await b.cancel(false)
          }
          return result
        },
      })
      const current = await b.read(reader, observed)
      expect(cancelled).toBe(true)
      expect(current.status).toBe('cancelled')
      expect(current.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
      expect(current.cancelReason).toBe(REASON)
      expect(current.conference).toBeUndefined()
      expect(current.location).toBeNull()
    },
  )

  for (const provider of ['zoom', 'google_meet'] as const) {
    it.each(readers)(
      `%s hydrates the resolved ${provider} location when provisioning commits between reads`,
      async (reader) => {
        const b = await setup(provider)
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('bookings')
            .set({ location: JSON.stringify({ kind: provider, autoCreate: true }) })
            .where('id', '=', b.booking.id)
            .execute()
          await trx
            .updateTable('booking_conferences')
            .set({ state: 'pending' })
            .where('booking_id', '=', b.booking.id)
            .execute()
        })
        let provisioned = false
        const observed = db.withPlugin({
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            if (
              !provisioned &&
              result.rows.some((row) => row.id === b.booking.id && Object.hasOwn(row, 'responses'))
            ) {
              provisioned = true
              await db.transaction().execute(async (trx) => {
                await trx
                  .updateTable('bookings')
                  .set({
                    location: JSON.stringify({ kind: provider, autoCreate: true, url: b.url }),
                  })
                  .where('id', '=', b.booking.id)
                  .execute()
                await trx
                  .updateTable('booking_conferences')
                  .set({ state: 'ready' })
                  .where('booking_id', '=', b.booking.id)
                  .execute()
              })
            }
            return result
          },
        })
        const current = await b.read(reader, observed)
        expect(provisioned).toBe(true)
        expect(current.status).toBe('confirmed')
        expect(current.conference).toEqual({ provider, status: 'ready', errorCode: null })
        expect(current.location?.url).toBe(b.url)
      },
    )
  }

  it('hydrates every id in a mixed host list, including a moved pointer and no intent', async () => {
    const b = await setup('zoom')
    await f.eventType(b.host.organizationId, b.host.userId, { slug: 'plain' })
    const plain = await createPublicBooking(ctx, {
      handle: b.host.handle,
      slug: 'plain',
      start: Temporal.Instant.from('2026-11-02T11:00:00Z'),
      invitee: { name: 'Plain invitee', email: 'plain@example.com', timeZone: 'UTC' },
    })
    let changed = false
    let hydrationQueries = 0
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (
          !changed &&
          result.rows.some((row) => row.id === b.booking.id && Object.hasOwn(row, 'responses'))
        ) {
          expect(result.rows).toHaveLength(2)
          changed = true
          await b.move('host', true)
          await cancelManagedBooking(
            { ...ctx, now: () => CANCELLED_AT },
            plain.manageToken as string,
            {
              reason: REASON,
            },
          )
        }
        if (result.rows.some((row) => Object.hasOwn(row, 'booking_location'))) {
          hydrationQueries++
          expect(result.rows.map((row) => row.booking_id).sort()).toEqual(
            [b.booking.id, plain.booking.id].sort(),
          )
        }
        return result
      },
    })
    const current = await listHostBookings({ ...b.service, db: observed })
    expect(changed).toBe(true)
    expect(hydrationQueries).toBe(1)
    expect(current.data).toHaveLength(2)
    for (const booking of current.data) {
      expect(booking.status).toBe('cancelled')
      expect(booking.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
      expect(booking.cancelReason).toBe(booking.id === plain.booking.id ? REASON : null)
      expect(booking.conference).toBeUndefined()
      expect(booking.location?.url).toBeUndefined()
    }
  })

  it('keeps duplicate conference pointers on the same cancellation snapshot', async () => {
    const b = await setup('zoom')
    const otherRoot = await f.booking(
      b.host.organizationId,
      [],
      '2026-11-02T11:00:00Z',
      '2026-11-02T11:30:00Z',
    )
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: otherRoot,
        booking_id: b.booking.id,
        organization_id: b.host.organizationId,
        organizer_user_id: b.host.userId,
        provider: 'zoom',
        zoom_connection_id: randomUUID(),
        zoom_user_id: 'synthetic-duplicate-zoom-identity',
        state: 'ready',
        applied_revision: 0,
      })
      .execute()
    let cancelled = false
    let joined = false
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (
          !cancelled &&
          result.rows.some((row) => row.id === b.booking.id && Object.hasOwn(row, 'responses'))
        ) {
          cancelled = true
          await b.cancel(true)
        }
        const hydrated = result.rows.filter(
          (row) => row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location'),
        )
        if (hydrated.length) {
          joined = true
          expect(hydrated).toHaveLength(2)
          for (const row of hydrated) expect(row.booking_status).toBe('cancelled')
        }
        return result
      },
    })
    const current = await b.read('host list', observed)
    expect(cancelled && joined).toBe(true)
    expect(current.status).toBe('cancelled')
    expect(current.cancelledAt).toBe('2026-11-01T12:05:00.000Z')
    expect(current.cancelReason).toBe(REASON)
    expect(current.conference).toEqual({ provider: 'zoom', status: 'ready', errorCode: null })
    expect(current.location).toEqual({ kind: 'zoom', autoCreate: true })
  })

  it('fails closed for any unavailable duplicate organizer regardless of joined row order', async () => {
    const b = await setup('google_meet')
    const otherRoot = await f.booking(
      b.host.organizationId,
      [],
      '2026-11-02T11:00:00Z',
      '2026-11-02T11:30:00Z',
    )
    await db
      .insertInto('booking_conferences')
      .values({
        root_booking_id: otherRoot,
        booking_id: b.booking.id,
        organization_id: b.host.organizationId,
        organizer_user_id: b.host.userId,
        invitation_organizer_name: 'Unavailable organizer',
        invitation_organizer_email: 'different-identity@example.com',
        provider: 'google_meet',
        state: 'ready',
        applied_revision: 0,
      })
      .execute()
    for (const reverse of [false, true]) {
      const observed = db.withPlugin({
        transformQuery: ({ node }) => node,
        async transformResult({ result }) {
          if (result.rows.some((row) => Object.hasOwn(row, 'booking_location'))) {
            expect(result.rows).toHaveLength(2)
            return reverse ? { ...result, rows: [...result.rows].reverse() } : result
          }
          return result
        },
      })
      const current = await b.read('host detail', observed)
      expect(current.status).toBe('confirmed')
      expect(current.conference).toEqual({
        provider: 'google_meet',
        status: 'failed',
        errorCode: 'organizer_unavailable',
      })
      expect(current.location).toEqual({ kind: 'google_meet', autoCreate: true })
    }
  })

  for (const provider of ['zoom', 'google_meet'] as const) {
    for (const afterHydration of [false, true]) {
      it.each(readers)(
        `%s reads ${provider} organizer eligibility from hydration when identity changes ${afterHydration ? 'after' : 'before'} that snapshot`,
        async (reader) => {
          const b = await setup(provider, true)
          let changed = false
          const observed = db.withPlugin({
            transformQuery: ({ node }) => node,
            async transformResult({ result }) {
              const reached = result.rows.some((row) =>
                afterHydration
                  ? row.booking_id === b.booking.id && Object.hasOwn(row, 'booking_location')
                  : row.id === b.booking.id && Object.hasOwn(row, 'responses'),
              )
              if (!changed && reached) {
                changed = true
                await db
                  .updateTable('auth.user')
                  .set({ emailVerified: false })
                  .where('id', '=', b.host.userId)
                  .execute()
              }
              return result
            },
          })
          const current = await b.read(reader, observed)
          expect(changed).toBe(true)
          expect(current.status).toBe('confirmed')
          expect(current.conference).toEqual({
            provider,
            status: afterHydration ? 'ready' : 'failed',
            errorCode: afterHydration ? null : 'organizer_unavailable',
          })
          expect(current.location?.url).toBe(afterHydration ? b.url : undefined)
          expect((await b.read(reader)).conference?.status).toBe('failed')
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
