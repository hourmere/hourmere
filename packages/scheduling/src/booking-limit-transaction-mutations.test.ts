import * as Crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as Kysely from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Availability from './availability.ts'
import * as BookingPage from './booking-page.ts'
import * as Conferences from './conferences.ts'
import type { PublicContext } from './context.ts'
import * as Errors from './errors.ts'
import * as Hosts from './hosts.ts'
import * as NotificationSettings from './notification-settings.ts'
import * as OneTimeLinks from './one-time-links.ts'
import * as Questions from './questions.ts'
import * as RoundRobin from './round-robin.ts'
import * as SuccessRedirect from './success-redirect.ts'
import { createFixtures, type EventTypeFixture, type Fixtures } from './testing.ts'
import * as Text from './text.ts'
import * as Waitlist from './waitlist.ts'
import * as WaitlistBooking from './waitlist-booking.ts'

type BookingModule = Pick<
  typeof import('./bookings.ts'),
  'createPublicBooking' | 'rescheduleManagedBooking'
>
type Change = readonly [string, string]
const dependencies: Record<string, object> = {
  'node:crypto': Crypto,
  kysely: Kysely,
  './availability.ts': Availability,
  './booking-page.ts': BookingPage,
  './conferences.ts': Conferences,
  './errors.ts': Errors,
  './hosts.ts': Hosts,
  './notification-settings.ts': NotificationSettings,
  './one-time-links.ts': OneTimeLinks,
  './questions.ts': Questions,
  './round-robin.ts': RoundRobin,
  './success-redirect.ts': SuccessRedirect,
  './text.ts': Text,
  './waitlist.ts': Waitlist,
  './waitlist-booking.ts': WaitlistBooking,
}

/** Only an in-memory source copy changes; dependencies remain the real service modules. */
function sourceCopy(change?: Change, findSlots = Availability.findSlots): BookingModule {
  let source = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replaceAll(...change)
  }
  source = stripTypeScriptTypes(source).replace(/^export \{[^}]*\} from '[^']+'\n/gm, '')
  const bindings: Record<string, unknown> = {}
  source = source.replace(
    /^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm,
    (_, specifiers: string, specifier: string) => {
      const module = dependencies[specifier] as Record<string, unknown> | undefined
      if (!module) throw new Error(`Missing source-copy dependency: ${specifier}`)
      for (const item of specifiers.split(',')) {
        const [name, alias] = item.trim().split(/\s+as\s+/)
        if (!name) continue
        if (!(name in module)) throw new Error(`Missing source-copy binding: ${name}`)
        bindings[alias ?? name] = name === 'findSlots' ? findSlots : module[name]
      }
      return ''
    },
  )
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return { createPublicBooking, rescheduleManagedBooking }`,
  )(...Object.values(bindings)) as BookingModule
}

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const NOW = instant('2026-11-01T00:00Z')
const invitee = { name: 'Synthetic invitee', email: 'invitee@example.com', timeZone: 'UTC' }
const periods = [
  {
    period: 'weekly',
    limits: { maxBookingsPerWeek: 1 },
    first: '2026-11-02T12:00Z',
    second: '2026-11-06T12:00Z',
  },
  {
    period: 'monthly',
    limits: { maxBookingsPerMonth: 1 },
    first: '2026-11-02T12:00Z',
    second: '2026-11-23T12:00Z',
  },
] as const
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing test fixture')
  return value
}
const deferred = () => {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// One pool, at most two booking transactions plus one observer connection at a time.
describe.skipIf(!serverUrl)('booking limit transaction source-copy mutation controls', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'limit_tx_mut' })
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now: () => NOW }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(limits: EventTypeFixture) {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      ...limits,
      slug: 'limited',
    })
    const request = (date: string, idempotencyKey?: string) => ({
      handle: host.handle,
      slug: 'limited',
      start: instant(date),
      invitee,
      idempotencyKey,
    })
    return { eventTypeId, request }
  }

  it.each(periods)(
    'detects removal of the host lock for concurrent $period capacity',
    { timeout: 20_000 },
    async ({ limits, first, second }) => {
      const verify = async (change?: Change) => {
        const s = await setup(limits)
        const firstSnapshot = deferred()
        const release = deferred()
        let snapshots = 0
        const copy = sourceCopy(change, async (...args) => {
          const slots = await Availability.findSlots(...args)
          snapshots++
          if (snapshots === 1) {
            firstSnapshot.resolve()
            await release.promise
          }
          return slots
        })
        const one = copy.createPublicBooking(ctx, s.request(first))
        one.catch(() => {})
        await firstSnapshot.promise
        const two = copy.createPublicBooking(ctx, s.request(second))
        two.catch(() => {})
        let observed = false
        try {
          // With the lock, writer two must wait. Without it, both snapshots are empty
          // before writer one may insert. This makes the lost-capacity race deterministic.
          for (let attempt = 0; attempt < 500; attempt++) {
            const { rows } = await owned.pool.query<{ waiting: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE datname=current_database() AND wait_event='advisory') AS waiting`,
            )
            if (snapshots >= 2 || rows[0]?.waiting) {
              observed = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        } finally {
          release.resolve()
        }
        const results = await Promise.allSettled([one, two])
        expect(observed, 'observe the second snapshot or advisory-lock waiter').toBe(true)
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(
          await db
            .selectFrom('bookings')
            .select('id')
            .where('event_type_id', '=', s.eventTypeId)
            .where('status', '=', 'confirmed')
            .execute(),
        ).toHaveLength(1)
      }
      await verify()
      await expect(verify(['await lockHosts(trx, et.hostUserIds)', ''])).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it.each(periods)(
    'detects removal of the in-transaction offered-slot check for $period capacity',
    async ({ limits, first, second }) => {
      const verify = async (change?: Change) => {
        const s = await setup(limits)
        const copy = sourceCopy(change)
        await copy.createPublicBooking(ctx, s.request(first))
        await expect(copy.createPublicBooking(ctx, s.request(second))).rejects.toMatchObject({
          code: 'slot_unavailable',
        })
      }
      await verify()
      await expect(
        verify([
          'if (!slots.some((s) => s.start.equals(q.start) && s.end.equals(q.end)))',
          'if (false)',
        ]),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )

  it.each(periods)(
    'detects removal of self-exclusion when rescheduling within a full $period period',
    async ({ limits, first, second }) => {
      const verify = async (change?: Change) => {
        const s = await setup(limits)
        const copy = sourceCopy(change)
        const initial = await copy.createPublicBooking(ctx, s.request(first))
        await expect(
          copy.rescheduleManagedBooking(ctx, required(initial.manageToken), {
            start: instant(second),
          }),
        ).resolves.toMatchObject({
          booking: { status: 'confirmed', rescheduledFromId: initial.booking.id },
        })
      }
      await verify()
      await expect(verify(['excludeBookingId: old.id,', ''])).rejects.toMatchObject({
        name: 'AssertionError',
      })
    },
  )

  it.each(periods)(
    'detects removal of successful replay before the consumed $period limit check',
    async ({ limits, first }) => {
      const verify = async (change?: Change) => {
        const s = await setup(limits)
        const copy = sourceCopy(change)
        const request = s.request(first, Crypto.randomUUID())
        const initial = await copy.createPublicBooking(ctx, request)
        await expect(copy.createPublicBooking(ctx, request)).resolves.toMatchObject({
          replayed: true,
          booking: { id: initial.booking.id },
        })
      }
      await verify()
      await expect(
        verify(['if (replay) return { ...replay, replayed: true }', '']),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})
