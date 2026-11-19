import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  cancelTeamBookingInTransaction,
  createPublicTeamBooking,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import { createFinalizeFixture } from './meeting-poll-finalize-fixture.ts'
import { bookingMeetingPollLinked } from './meeting-poll-outcomes.ts'

const serverUrl = process.env.DATABASE_URL
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>
type Path = 'host' | 'manage link' | 'team admin' | 'reschedule request'

const LOCK = /\bfor (update|share|key share|no key update)\b|pg_advisory/i
const POLL_LOOKUP = /join meeting_polls p\b/i

describe('meeting poll booking link invariant', () => {
  // The lifecycle writes read the poll link before their locks (meetingPollChainLinked).
  // That is sound only while finalize alone writes booking_id and nothing re-points it.
  it('lets only finalize write a poll booking_id', () => {
    const writers: string[] = []
    const write =
      /updateTable\(\s*'meeting_polls'|insertInto\(\s*'meeting_polls'|\bUPDATE\s+meeting_polls\b|\bINSERT\s+INTO\s+meeting_polls\b/gi
    for (const base of ['apps', 'packages']) {
      for (const entry of readdirSync(join(ROOT, base), { recursive: true }) as string[]) {
        if (/node_modules|[/\\]dist[/\\]/.test(entry) || entry.endsWith('.test.ts')) continue
        // The 0071 constraint assertion suite writes rows directly to prove the constraints.
        if (entry.endsWith('meeting-poll-protections.ts')) continue
        if (!/\.(ts|sql)$/.test(entry)) continue
        const path = join(ROOT, base, entry)
        const text = readFileSync(path, 'utf8')
        for (const match of text.matchAll(write)) {
          const rest = text.slice(match.index)
          const end = Math.min(
            ...['.execute', '`', ';\n'].map((stop) => {
              const at = rest.indexOf(stop, match[0].length)
              return at < 0 ? rest.length : at
            }),
          )
          if (rest.slice(0, end).includes('booking_id'))
            writers.push(relative(ROOT, path).replaceAll('\\', '/'))
        }
      }
    }
    expect(writers).toEqual(['packages/scheduling/src/meeting-poll-finalize.ts'])
    const host = readFileSync(join(ROOT, 'packages/scheduling/src/meeting-polls.ts'), 'utf8')
    const columns = host.match(/const HOST_WRITE_COLUMNS = new Set\(\[([^\]]*)\]\)/)
    assert.ok(columns, 'host poll writes keep an explicit column allowlist')
    expect(columns[1]).not.toContain('booking_id')
  })
})

describe.skipIf(!serverUrl)('meeting poll updates from booking lifecycle paths', () => {
  let owned: TestDatabase
  let db: Db
  let logged: Db
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_updates' })
    db = createDb(owned.pool)
    logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function linkedBooking() {
    const f = await createFinalizeFixture(db)
    const booker = await f.addVoter()
    const other = await f.addVoter()
    const { booking } = await finalizeMeetingPoll(f.ctx, await f.input([booker]))
    return { f, bookingId: booking.id, other }
  }

  async function ordinaryBooking() {
    const f = await createFinalizeFixture(db)
    const slug = `ordinary-${randomUUID().slice(0, 8)}`
    await f.fixtures.eventType(f.organizationId, null, {
      slug,
      hosts: [{ userId: f.owner.id }],
    })
    const { booking } = await createPublicTeamBooking(
      { db, now: f.ctx.now },
      {
        handle: f.ctx.principal.organization.slug,
        slug,
        start: f.start,
        invitee: { name: 'Ordinary invitee', email: 'ordinary@example.com', timeZone: 'UTC' },
      },
    )
    return { f, bookingId: booking.id }
  }

  /** A known manage token for the booking, as the booking API would have returned it. */
  async function manageToken(bookingId: string) {
    const token = randomBytes(32).toString('base64url')
    await db
      .updateTable('bookings')
      .set({ manage_token_hash: createHash('sha256').update(token).digest() })
      .where('id', '=', bookingId)
      .execute()
    return token
  }

  async function run(path: Path, action: 'cancel' | 'move', f: Fixture, bookingId: string) {
    const ctx = { ...f.ctx, db: logged }
    const start = Temporal.Instant.from(f.alternative.startAt)
    if (path === 'host')
      return action === 'cancel'
        ? cancelHostBooking(ctx, bookingId)
        : rescheduleHostBooking(ctx, bookingId, { start })
    if (path === 'team admin') {
      assert.equal(action, 'cancel')
      const actor = { userId: f.owner.id, organizationId: f.organizationId }
      // As the team route: the link is read before the write check takes its locks.
      const meetingPollLinked = await bookingMeetingPollLinked(logged, f.organizationId, bookingId)
      return logged
        .transaction()
        .execute((trx) =>
          cancelTeamBookingInTransaction(trx, actor, bookingId, f.ctx.now, { meetingPollLinked }),
        )
    }
    const token = await manageToken(bookingId)
    let rescheduleRequestId: string | undefined
    if (path === 'reschedule request') {
      await requestReschedule(f.ctx, bookingId, { idempotencyKey: randomUUID() })
      rescheduleRequestId = (
        await db
          .selectFrom('booking_reschedule_requests')
          .select('id')
          .where('booking_id', '=', bookingId)
          .executeTakeFirstOrThrow()
      ).id
    }
    statements.length = 0
    const publicCtx = { db: logged, now: f.ctx.now }
    return action === 'cancel'
      ? cancelManagedBooking(publicCtx, token, { rescheduleRequestId })
      : rescheduleManagedBooking(publicCtx, token, { start, rescheduleRequestId })
  }

  const cases: [Path, 'cancel' | 'move'][] = [
    ['host', 'cancel'],
    ['host', 'move'],
    ['manage link', 'cancel'],
    ['manage link', 'move'],
    ['team admin', 'cancel'],
    ['reschedule request', 'cancel'],
    ['reschedule request', 'move'],
  ]

  it.each(cases)(
    '%s %s runs no poll lookup under its locks for an ordinary booking',
    async (path, action) => {
      const { f, bookingId } = await ordinaryBooking()
      statements.length = 0
      await run(path, action, f, bookingId)
      const firstLock = statements.findIndex((text) => LOCK.test(text))
      expect(firstLock).toBeGreaterThan(0)
      expect(statements.slice(0, firstLock).some((text) => POLL_LOOKUP.test(text))).toBe(true)
      expect(statements.slice(firstLock).filter((text) => POLL_LOOKUP.test(text))).toEqual([])
    },
  )

  it.each(cases)('%s %s queues the poll update for a poll booking', async (path, action) => {
    const { f, bookingId, other } = await linkedBooking()
    statements.length = 0
    await run(path, action, f, bookingId)
    const firstLock = statements.findIndex((text) => LOCK.test(text))
    expect(
      statements.slice(firstLock).filter((text) => POLL_LOOKUP.test(text) && LOCK.test(text)),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select(['voter_id', 'sequence'])
        .where('poll_id', '=', f.poll.id)
        .where('kind', '=', 'booking_update')
        .execute(),
    ).toEqual([{ voter_id: other.id, sequence: 0 }])
  })

  it('links a poll only to the booking its finalize transaction inserted', async () => {
    const { f, bookingId } = await linkedBooking()
    const { rows } = await sql<{ same: boolean }>`
      SELECT p.xmin = b.xmin AS same FROM meeting_polls p JOIN bookings b ON b.id = p.booking_id
       WHERE p.id = ${f.poll.id}`.execute(db)
    expect(rows).toEqual([{ same: true }])
    expect(await bookingMeetingPollLinked(db, f.organizationId, bookingId)).toBe(true)
  })

  it('takes the poll row lock before queuing a booking update', async () => {
    const { f, bookingId, other } = await linkedBooking()
    // A no-key update leaves the deliveries' foreign key check free; only the poll row lock waits.
    let cancel: Promise<unknown> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await sql`SELECT FROM meeting_polls WHERE id = ${f.poll.id} FOR NO KEY UPDATE`.execute(trx)
        const {
          rows: [holder],
        } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
        assert.ok(holder)
        cancel = cancelHostBooking(f.ctx, bookingId).then(
          () => 'cancelled',
          (error: unknown) => error,
        )
        await vi.waitFor(
          async () => {
            const { rows } = await sql`SELECT pid FROM pg_stat_activity
              WHERE datname = current_database() AND ${holder.pid} = ANY(pg_blocking_pids(pid))`.execute(
              db,
            )
            expect(rows).toHaveLength(1)
          },
          { timeout: 5000, interval: 25 },
        )
      })
    } finally {
      expect(await cancel).toBe('cancelled')
    }
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select('voter_id')
        .where('poll_id', '=', f.poll.id)
        .where('kind', '=', 'booking_update')
        .execute(),
    ).toEqual([{ voter_id: other.id }])
  })
})
