import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { checkTeamManagementAccess, type Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  BOOKING_NOTIFICATION_JOB,
  BookingNotificationPayload,
  bookingNotificationJob,
  bookingNotifier,
  type NotificationQueue,
} from '@hourmere/notifications'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import { createPublicTeamBookingSeries } from './recurring-creation.ts'
import { expandRecurringRule } from './recurring-rules.ts'
import { cancelTeamAdminBooking } from './team-bookings.ts'
import { createFixtures, createTestTeam, createTestUser } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2030-11-03T12:00Z')
const firstLocalStart = '2030-11-04T09:00+00:00'
const invitee = { name: 'Booker', email: 'booker@example.test', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('team administrator cancellation of a series member', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_series' })
    owned.pool.options.max = 7
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const admin = await createTestUser(db, 'Team administrator')
    const host = await createTestUser(db, 'Original host')
    const team = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: host, role: 'member' },
    ])
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: admin.id,
        token: randomBytes(24).toString('base64url'),
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const principal: Principal = {
      kind: 'session',
      user: admin,
      organization: team.as(admin).organization,
      sessionId: session.id,
    }
    const fixtures = createFixtures(db)
    const slug = 'team-appointment'
    await fixtures.schedule(host.id, { timeZone: 'UTC' })
    const eventTypeId = await fixtures.eventType(team.id, null, {
      slug,
      hosts: [{ userId: host.id }],
    })
    const timeZone = 'UTC'
    const durationMinutes = 30
    const rule = { pattern: 'weekly', count: 2 } as const
    await db
      .updateTable('event_types')
      .set({
        recurrence: JSON.stringify({ timeZone, allowedPatterns: ['weekly'], maxOccurrences: 2 }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const expanded = expandRecurringRule({
      firstLocalStart,
      rule,
      timeZone,
      durationMinutes,
      now: now(),
    })
    const publicInput = { handle: principal.organization.slug, slug, invitee }
    const series = await createPublicTeamBookingSeries(
      { db, now },
      {
        ...publicInput,
        firstLocalStart,
        rule,
        idempotencyKey: randomUUID(),
        expectedPreview: {
          eventRevision: '0',
          timeZone,
          durationMinutes,
          rule,
          occurrences: expanded.map(({ ordinal, localStart, start, end, offset }) => ({
            ordinal,
            localStart,
            start: start?.toString() ?? null,
            end: end?.toString() ?? null,
            offset,
          })),
        },
      },
      {
        recurringBookingsEnabled: true,
        actorDigest: createHash('sha256').update('synthetic team series actor').digest(),
      },
    )
    const ordinary = await createPublicTeamBooking(
      { db, now },
      { ...publicInput, start: Temporal.Instant.from(firstLocalStart).add({ hours: 2 }) },
    )
    const [member, sibling] = series.occurrences
    if (!member || !sibling) throw new Error('Expected two series members')
    return { host, team, principal, series, member, sibling, ordinary }
  }

  async function blockedRelation(pids: number[], signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      const { rows } = await owned.pool.query<{ relation: string }>(
        `SELECT relation::regclass::text AS relation FROM pg_locks
         WHERE locktype = 'tuple' AND pg_blocking_pids(pid) && $1::integer[]`,
        [pids],
      )
      if (rows[0]) return rows[0].relation
      await setTimeout(10, undefined, { signal })
    }
  }

  it.each(['a series member', 'an ordinary booking'] as const)(
    'cancels %s with the expected row order and ordinary mail',
    async (kind) => {
      const { host, team, principal, series, member, sibling, ordinary } = await fixture()
      const signal = AbortSignal.timeout(5000)
      const inSeries = kind === 'a series member'
      const bookingId = inSeries ? member.bookingId : ordinary.booking.id
      const enqueue = vi.fn<NotificationQueue['enqueue']>(async () => null)
      const cancel = () =>
        db.transaction().execute(async (trx) => {
          const actor = await checkTeamManagementAccess(trx, principal, team.id, true, {
            allowPersonal: false,
            expectedOrganizationId: team.id,
          })
          await cancelTeamAdminBooking(trx, actor, bookingId, now, {
            expectedOrganizationId: team.id,
            notify: bookingNotifier({ enqueue }),
          })
        })

      const targets = [
        ['auth.organization', 'id', team.id],
        ['booking_series', 'id', series.seriesId],
        ['bookings', 'id', bookingId],
        ['booking_hosts', 'booking_id', bookingId],
      ] as const
      const holders: { client: PoolClient; pid: number }[] = []
      let pending: Promise<PromiseSettledResult<void>[]> | undefined
      try {
        for (const [relation, column, id] of targets) {
          const client = await owned.pool.connect()
          const holder = { client, pid: 0 }
          holders.push(holder)
          const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          if (!rows[0]) throw new Error('Missing PostgreSQL backend PID')
          holder.pid = rows[0].pid
          await client.query('BEGIN')
          await client.query(`SELECT ${column} FROM ${relation} WHERE ${column} = $1 FOR UPDATE`, [
            id,
          ])
        }
        pending = Promise.allSettled([cancel()])
        for (const [index, [relation]] of targets.entries()) {
          if (relation === 'booking_series' && !inSeries) continue
          expect(
            await blockedRelation(
              holders.map(({ pid }) => pid),
              signal,
            ),
          ).toBe(relation)
          expect(enqueue).not.toHaveBeenCalled()
          await holders[index]?.client.query('COMMIT')
        }
        expect(await pending).toEqual([{ status: 'fulfilled', value: undefined }])
      } finally {
        for (const { client } of holders) {
          await client.query('ROLLBACK').finally(() => client.release())
        }
        await pending
      }

      const readBookingStatus = (id: string) =>
        db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()
      expect(await readBookingStatus(bookingId)).toEqual({ status: 'cancelled' })
      expect(await readBookingStatus(sibling.bookingId)).toEqual({ status: 'confirmed' })
      expect(
        await db
          .selectFrom('booking_series')
          .select('revision')
          .where('id', '=', series.seriesId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revision: inSeries ? '2' : '1' })
      await expect(cancel()).rejects.toMatchObject({ code: 'booking_already_cancelled' })
      expect(enqueue.mock.calls.map(([name, payload]) => [name, payload])).toEqual([
        [BOOKING_NOTIFICATION_JOB, { bookingId, kind: 'cancelled' }],
      ])
      const sent: string[] = []
      const mail = bookingNotificationJob({
        db,
        now,
        secret: 'synthetic-cancellation-fixture',
        publicUrl: 'https://hourmere.example.test',
        mailMaxPerHour: 0,
        mailer: {
          senderEmail: 'calendar@example.test',
          async send(message) {
            sent.push(message.to)
          },
        },
        log: () => {},
      })
      await mail.handler(BookingNotificationPayload.parse(enqueue.mock.calls[0]?.[1]), {
        id: randomUUID(),
        attempt: 1,
        signal,
      })
      expect(sent.sort()).toEqual([host.email, invitee.email].sort())
    },
  )
})
