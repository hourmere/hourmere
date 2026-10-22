import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  cancelManagedBooking,
  createPublicBooking,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  dispatchConferenceNotifications,
  NotificationRetryError,
  sendBookingNotification,
} from './index.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2030-11-03T12:00Z')
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe.skipIf(!serverUrl)('conference lifecycle after real identity lock waits', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
    const probe = createPool(owned.url)
    try {
      await expect(probe.query('SELECT 1')).rejects.toMatchObject({ code: '3D000' })
    } finally {
      await probe.end()
    }
  })
  beforeEach(async () => {
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
  })
  async function blockedBy(pid: number, ownsLock: boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const result = await owned.pool.query<{ blocked: boolean }>(
        ownsLock
          ? 'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked'
          : 'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
        [pid],
      )
      if (result.rows[0]?.blocked) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Expected the real identity row-lock barrier')
  }

  for (const path of ['outbox', 'legacy', 'legacy-null'] as const) {
    for (const lock of ['user', 'member'] as const) {
      for (const change of ['cancel', 'reschedule', 'revision'] as const) {
        it(`${path} rechecks ${change} after the organizer ${lock} lock wait`, async () => {
          const f = createFixtures(db)
          const host = await f.host()
          await f.schedule(host.userId)
          await f.eventType(host.organizationId, host.userId, { slug: 'wait' })
          const original = await createPublicBooking(
            { db, now: () => NOW },
            {
              handle: host.handle,
              slug: 'wait',
              start: Temporal.Instant.from('2030-11-04T09:00Z'),
              invitee: {
                name: 'Synthetic Booker',
                email: 'booker@example.test',
                timeZone: 'UTC',
              },
            },
          )
          const token = original.manageToken
          if (token === null) throw new Error('Synthetic new booking needs its manage token')
          const id = original.booking.id
          const organizer = await db
            .selectFrom('auth.user')
            .select(['name', 'email'])
            .where('id', '=', host.userId)
            .executeTakeFirstOrThrow()
          await db
            .updateTable('bookings')
            .set({
              location: {
                kind: 'google_meet',
                autoCreate: true,
                url: 'https://meet.google.com/abc-defg-hij',
              },
            })
            .where('id', '=', id)
            .execute()
          await db
            .insertInto('booking_conferences')
            .values({
              root_booking_id: id,
              booking_id: id,
              organization_id: host.organizationId,
              organizer_user_id: host.userId,
              invitation_organizer_name: path === 'legacy-null' ? null : organizer.name,
              invitation_organizer_email: path === 'legacy-null' ? null : organizer.email,
              state: 'ready',
              applied_revision: 0,
            })
            .execute()
          if (path === 'outbox')
            await db
              .insertInto('booking_conference_notifications')
              .values({ booking_id: id, kind: 'confirmed', due_at: NOW.toString() })
              .execute()
          const entered = gate(),
            hold = gate(),
            messages: MailMessage[] = []
          let now = NOW
          const deps = {
            db,
            now: () => now,
            secret: 'synthetic-notification-secret',
            publicUrl: 'https://hourmere.example',
            log: () => {},
            mailer: {
              send: async (message: MailMessage) => {
                messages.push(message)
                if (messages.length === 1) {
                  entered.release()
                  await hold.promise
                }
              },
            },
          }
          const sending = (
            path === 'outbox'
              ? dispatchConferenceNotifications(deps)
              : sendBookingNotification(deps, id, 'confirmed')
          ).then(
            () => undefined,
            (error: unknown) => error,
          )
          const blocker = await db.startTransaction().execute()
          let finished = false
          let acquiring: Promise<unknown> | undefined
          try {
            await entered.promise
            const pid = (
              await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(blocker)
            ).rows[0]?.pid
            expect(pid).toBeTypeOf('number')
            acquiring =
              lock === 'user'
                ? sql`SELECT id FROM auth."user" WHERE id=${host.userId} FOR UPDATE`.execute(
                    blocker,
                  )
                : sql`SELECT id FROM auth.member WHERE "userId"=${host.userId} AND "organizationId"=${host.organizationId} FOR UPDATE`.execute(
                    blocker,
                  )
            await blockedBy(pid as number, false)
            hold.release()
            await acquiring
            await blockedBy(pid as number, true)
            expect(messages).toHaveLength(1)
            expect(messages[0]?.to).toBe(organizer.email)
            if (path === 'outbox') {
              const claimed = await db
                .selectFrom('booking_conference_notifications')
                .select(['attempts', 'lease_until'])
                .where('booking_id', '=', id)
                .executeTakeFirstOrThrow()
              expect(claimed.attempts).toBe(1)
              expect(claimed.lease_until?.getTime()).toBeGreaterThan(NOW.epochMilliseconds)
            }
            if (change === 'cancel') {
              // A separate real service transaction commits while identity is still blocked.
              const cancelled = await cancelManagedBooking({ db, now: () => NOW }, token)
              expect(cancelled.status).toBe('cancelled')
            } else if (change === 'reschedule') {
              // Rescheduling also locks host identity. Reuse the controlled blocker transaction
              // to execute the real service body and commit the move before releasing the waiter.
              // This is a transaction-level regression, not a separate HTTP concurrency claim.
              const inBlocker = new Proxy(blocker, {
                get(target, property) {
                  if (property === 'transaction')
                    return () => ({ execute: (run: (trx: Db) => unknown) => run(blocker) })
                  const value = Reflect.get(target, property, target)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              }) as Db
              const moved = await rescheduleManagedBooking(
                { db: inBlocker, now: () => NOW },
                token,
                { start: Temporal.Instant.from('2030-11-04T11:00Z') },
              )
              expect(moved.booking.rescheduledFromId).toBe(id)
              expect(moved.booking.status).toBe('confirmed')
            } else {
              await blocker
                .updateTable('booking_conferences')
                .set({ revision: 1, applied_revision: 1 })
                .where('root_booking_id', '=', id)
                .execute()
              await blocker
                .updateTable('bookings')
                .set({
                  location: {
                    kind: 'google_meet',
                    autoCreate: true,
                    url: 'https://meet.google.com/xyz-abcd-efg',
                  },
                })
                .where('id', '=', id)
                .execute()
            }
            await blocker.commit().execute()
            finished = true
            const outcome = await sending
            expect(messages).toHaveLength(1)
            expect(messages[0]?.attachments?.[0]?.content).toContain('METHOD:REQUEST')
            expect(
              await db
                .selectFrom('booking_notifications')
                .select('recipient')
                .where('booking_id', '=', id)
                .execute(),
            ).toEqual([{ recipient: `host:${host.userId}` }])
            expect(now).toBe(NOW)
            if (change === 'revision') {
              if (path === 'outbox') {
                const notice = await db
                  .selectFrom('booking_conference_notifications')
                  .selectAll()
                  .where('booking_id', '=', id)
                  .executeTakeFirstOrThrow()
                expect(notice.delivered).toBe(false)
                expect(notice.last_error).toBe('recipient_retry')
                now = Temporal.Instant.fromEpochMilliseconds(notice.due_at.getTime())
                await dispatchConferenceNotifications(deps)
              } else {
                expect(outcome).toBeInstanceOf(NotificationRetryError)
                await sendBookingNotification(deps, id, 'confirmed')
              }
              expect(messages).toHaveLength(2)
              expect(messages[1]?.to).toBe('booker@example.test')
              expect(messages[1]?.text).toContain('https://meet.google.com/xyz-abcd-efg')
              expect(messages[1]?.text).not.toContain('https://meet.google.com/abc-defg-hij')
            } else {
              expect(outcome).toBeUndefined()
              if (path === 'outbox') {
                const notice = await db
                  .selectFrom('booking_conference_notifications')
                  .selectAll()
                  .where('booking_id', '=', id)
                  .executeTakeFirstOrThrow()
                expect(notice.delivered).toBe(false)
                expect(notice.skipped_at).toEqual(new Date(NOW.epochMilliseconds))
                expect(notice.exhausted_at).toBeNull()
              }
              expect(
                await db
                  .selectFrom('bookings')
                  .select('status')
                  .where('id', '=', id)
                  .executeTakeFirstOrThrow(),
              ).toEqual({ status: 'cancelled' })
            }
          } finally {
            hold.release()
            await acquiring?.catch(() => {})
            if (!finished) await blocker.rollback().execute()
            await sending
          }
        }, 10000)
      }
    }
  }
})
