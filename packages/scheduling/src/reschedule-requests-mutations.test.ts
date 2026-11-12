import * as Crypto from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import {
  assertManageRequestIsolation,
  assertOrganizationIsolation,
} from './reschedule-request-isolation-testing.ts'
import { type BookingModule, type Change, sourceCopy } from './reschedule-request-source-copy.ts'
import { createFixtures } from './testing.ts'

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
      ...(['session', 'api_key'] as const).map((kind) => ({
        name: `request organization isolation for ${kind}`,
        change: [
          ".where('id', '=', id)\n      .where('organization_id', '=', ctx.principal.organization.id)\n      .where((eb) =>",
          ".where('id', '=', id)\n      .where((eb) =>",
        ] as Change,
        verify: (copy: BookingModule) => assertOrganizationIsolation(db, copy, kind),
      })),
      ...(['pending', 'picked', 'cancelled'] as const).flatMap((state) =>
        (['pick', 'cancel'] as const)
          .filter(
            (action) =>
              state === 'pending' || (state === 'picked' ? action === 'pick' : action === 'cancel'),
          )
          .map((action) => ({
            name: `manage token booking scope for ${state} request ${action}`,
            change: [
              ".where((eb) =>\n      eb.or([eb('booking_id', '=', bookingId), eb('picked_booking_id', '=', bookingId)]),\n    )",
              '',
            ] as Change,
            verify: (copy: BookingModule) =>
              assertManageRequestIsolation(db, copy, setup, state, action),
          })),
      ),
      {
        name: 'group-seat capability marker',
        change: ['...(r.group_slot_id ? { isGroupSeat: true } : {}),', ''],
        verify: async (copy) => {
          const { groupFixture, occupiedSlot } = await import(
            '../../db/src/group-seats-fixtures.ts'
          )
          const group = await groupFixture(owned.pool)
          const occupied = await occupiedSlot(group)
          const { ctx } = await setup()
          const groupCtx: ServiceContext = {
            ...ctx,
            principal: {
              ...ctx.principal,
              user: { ...ctx.principal.user, id: group.host },
              organization: { ...ctx.principal.organization, id: group.organization },
            },
          }
          expect(
            (await copy.getHostBooking(groupCtx, required(occupied.bookings[0]))).isGroupSeat,
          ).toBe(true)
        },
      },
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
        name: 'note validation exposes only the public field path',
        change: [".replace('notifications.followUps[0].hostNote: ', '')", ''],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(ctx, created.booking.id, {
              idempotencyKey: Crypto.randomUUID(),
              note: 'bad\tcontrol',
            }),
          ).rejects.toMatchObject({
            name: 'DomainError',
            kind: 'invalid',
            code: 'invalid_request',
            message: 'note: must not contain control characters other than LF',
          })
        },
      },
      {
        name: 'service note errors remain typed client errors',
        change: [
          '    if (!parsed.success)\n      throw new DomainError(',
          '    if (!parsed.success) throw parsed.error\n    if (!parsed.success)\n      throw new DomainError(',
        ],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(ctx, created.booking.id, {
              idempotencyKey: Crypto.randomUUID(),
              note: 'bad\tcontrol',
            }),
          ).rejects.toMatchObject({
            name: 'DomainError',
            kind: 'invalid',
            code: 'invalid_request',
            message: 'note: must not contain control characters other than LF',
          })
        },
      },
      {
        name: 'plain-text note validation',
        change: ['hostNote: note', "hostNote: ''"],
        verify: async (copy) => {
          const { ctx, created } = await setup()
          await expect(
            copy.requestReschedule(ctx, created.booking.id, {
              idempotencyKey: Crypto.randomUUID(),
              note: 'bad\tcontrol',
            }),
          ).rejects.toMatchObject({ name: 'DomainError', kind: 'invalid', code: 'invalid_request' })
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
