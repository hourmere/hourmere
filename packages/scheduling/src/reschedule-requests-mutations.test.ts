import * as Crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as HourmereDb from '@hourmere/db'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as Kysely from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Availability from './availability.ts'
import * as BookingPage from './booking-page.ts'
import * as Conferences from './conferences.ts'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import * as Errors from './errors.ts'
import * as GroupSeatAdmission from './group-seat-admission.ts'
import * as Hosts from './hosts.ts'
import * as NotificationSettings from './notification-settings.ts'
import * as OneTimeLinks from './one-time-links.ts'
import * as Questions from './questions.ts'
import * as RoundRobin from './round-robin.ts'
import * as SuccessRedirect from './success-redirect.ts'
import { createFixtures } from './testing.ts'
import * as Text from './text.ts'
import * as Waitlist from './waitlist.ts'
import * as WaitlistBooking from './waitlist-booking.ts'

type BookingModule = Pick<
  typeof import('./bookings.ts'),
  | 'requestReschedule'
  | 'expireRescheduleRequest'
  | 'cancelManagedBooking'
  | 'rescheduleManagedBooking'
>
type Change = readonly [string, string]
const dependencies: Record<string, object> = {
  'node:crypto': Crypto,
  kysely: Kysely,
  '@hourmere/db': HourmereDb,
  './availability.ts': Availability,
  './booking-page.ts': BookingPage,
  './conferences.ts': Conferences,
  './errors.ts': Errors,
  './hosts.ts': Hosts,
  './group-seat-admission.ts': GroupSeatAdmission,
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
    `${source.replace(/\bexport /g, '')}; return { requestReschedule, expireRescheduleRequest, cancelManagedBooking, rescheduleManagedBooking }`,
  )(...Object.values(bindings)) as BookingModule
}

const serverUrl = process.env.DATABASE_URL
const now = Temporal.Instant.from('2026-11-01T12:00:00Z')
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing fixture')
  return value
}
describe.skipIf(!serverUrl)('reschedule request source-copy mutations', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup() {
    const f = createFixtures(db),
      host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
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
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const created = await (await import('./bookings.ts')).createPublicBooking(pub, {
      handle: host.handle,
      slug: 'intro',
      start: Temporal.Instant.from('2026-11-02T09:00Z'),
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    })
    return { ctx, pub, created, events }
  }
  const cases: { name: string; change: Change; verify: (copy: BookingModule) => Promise<void> }[] =
    [
      {
        name: 'host membership authorization',
        change: [".where('booking_hosts.user_id', '=', ctx.principal.user.id)", ''],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(
              {
                ...ctx,
                principal: {
                  ...ctx.principal,
                  user: { ...ctx.principal.user, id: Crypto.randomUUID() },
                },
              },
              created.booking.id,
              { idempotencyKey: Crypto.randomUUID() },
            ),
          ).rejects.toMatchObject({ code: 'booking_not_found' })
        },
      },
      {
        name: 'plain-text note validation',
        change: ['hostNote: input.note', "hostNote: ''"],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(ctx, created.booking.id, {
              idempotencyKey: Crypto.randomUUID(),
              note: 'bad\tcontrol',
            }),
          ).rejects.toMatchObject({ kind: 'invalid' })
        },
      },
      {
        name: 'idempotent request notification',
        change: [
          'if (previous) {',
          "if (previous) { await ctx.notify?.(trx,{type:'reschedule_requested',bookingId:id,requestId:previous.id},ctx.now());",
        ],
        verify: async (copy) => {
          const { ctx, created, events } = await setup(),
            input = { idempotencyKey: Crypto.randomUUID() }
          await copy.requestReschedule(ctx, created.booking.id, input)
          await copy.requestReschedule(ctx, created.booking.id, input)
          expect(events.filter((e) => e.type === 'reschedule_requested')).toHaveLength(1)
        },
      },
      {
        name: 'future booking guard',
        change: ['assertChangeable(row, now)', 'void row'],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(
              { ...ctx, now: () => Temporal.Instant.from('2026-11-03T12:00Z') },
              created.booking.id,
              { idempotencyKey: Crypto.randomUUID() },
            ),
          ).rejects.toMatchObject({ code: 'booking_in_past' })
        },
      },
      {
        name: 'expiry deadline',
        change: [".where('expires_at', '<=', new Date(now.epochMilliseconds))", ''],
        verify: async (copy) => {
          const { ctx, pub, created, events } = await setup()
          const req = await copy.requestReschedule(ctx, created.booking.id, {
            idempotencyKey: Crypto.randomUUID(),
          })
          await copy.expireRescheduleRequest(pub, required(req.pendingReschedule).id)
          expect(events.filter((e) => e.type === 'reschedule_request_expired')).toHaveLength(0)
        },
      },
      {
        name: 'expiry replay state',
        change: [".where('state', '=', 'pending')", ''],
        verify: async (copy) => {
          const { ctx, pub, created, events } = await setup()
          const req = await copy.requestReschedule(ctx, created.booking.id, {
            idempotencyKey: Crypto.randomUUID(),
          })
          const later = { ...pub, now: () => Temporal.Instant.from(created.booking.start) }
          await copy.expireRescheduleRequest(later, required(req.pendingReschedule).id)
          await copy.expireRescheduleRequest(later, required(req.pendingReschedule).id)
          expect(events.filter((e) => e.type === 'reschedule_request_expired')).toHaveLength(1)
        },
      },
      {
        name: 'cancellation resolves request',
        change: ["await resolveRescheduleRequest(db, row.id, 'cancelled', now)", ''],
        verify: async (copy) => {
          const { ctx, pub, created } = await setup()
          const req = await copy.requestReschedule(ctx, created.booking.id, {
            idempotencyKey: Crypto.randomUUID(),
          })
          await copy.cancelManagedBooking(pub, required(created.manageToken), {
            rescheduleRequestId: required(req.pendingReschedule).id,
          })
          expect(
            (
              await db
                .selectFrom('booking_reschedule_requests')
                .select('state')
                .where('id', '=', required(req.pendingReschedule).id)
                .executeTakeFirst()
            )?.state,
          ).toBe('cancelled')
        },
      },
      {
        name: 'picking resolves request',
        change: ["await resolveRescheduleRequest(trx, old.id, 'picked', now)", ''],
        verify: async (copy) => {
          const { ctx, pub, created } = await setup()
          const req = await copy.requestReschedule(ctx, created.booking.id, {
            idempotencyKey: Crypto.randomUUID(),
          })
          await copy.rescheduleManagedBooking(pub, required(created.manageToken), {
            start: Temporal.Instant.from('2026-11-02T10:00Z'),
            rescheduleRequestId: required(req.pendingReschedule).id,
          })
          expect(
            (
              await db
                .selectFrom('booking_reschedule_requests')
                .select('state')
                .where('id', '=', required(req.pendingReschedule).id)
                .executeTakeFirst()
            )?.state,
          ).toBe('picked')
        },
      },
    ]
  for (const item of cases)
    it(item.name, async () => {
      await item.verify(sourceCopy())
      await expect(item.verify(sourceCopy(item.change))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
})
