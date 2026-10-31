import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as availability from './availability.ts'
import * as bookingPage from './booking-page.ts'
import {
  assertInviteeRescheduleAllowed,
  type CreateBookingInput,
  canonicalJson,
  createPublicBooking,
  createPublicTeamBooking,
  getHostBooking,
  getManagedBooking,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import * as conferences from './conferences.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import * as hosts from './hosts.ts'
import { listHostBookingSlots, listManagedSlots } from './manage.ts'
import { validateResponses } from './questions.ts'
import * as roundRobin from './round-robin.ts'
import * as successRedirect from './success-redirect.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type Fixtures,
  testContext,
} from './testing.ts'
import { cleanText } from './text.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const now = () => instant('2026-11-01T00:00Z')
const invitee = { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' }
const api = {
  createPublicBooking,
  createPublicTeamBooking,
  rescheduleManagedBooking,
  rescheduleHostBooking,
}
type Api = typeof api
type Change = readonly [string, string]
type ManageApi = {
  listManagedSlots: typeof listManagedSlots
  listHostBookingSlots: typeof listHostBookingSlots
}

function manageSourceCopy(change?: Change): ManageApi {
  let source = readFileSync('packages/scheduling/src/manage.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = {
    ...availability,
    assertInviteeRescheduleAllowed,
    getHostBooking,
    getManagedBooking,
    DomainError,
    ...hosts,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { listManagedSlots, listHostBookingSlots }`,
  )(...Object.values(bindings)) as ManageApi
}

/** Mutations compile an isolated source copy, leaving the working implementation intact. */
function sourceCopy(change?: Change): Api {
  let source = readFileSync('packages/scheduling/src/bookings.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(
    source
      .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
      .replace(/^export \{[^\n]+\} from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    createHash,
    randomBytes,
    sql,
    ...availability,
    ...bookingPage,
    ...conferences,
    DomainError,
    ...hosts,
    validateResponses,
    ...roundRobin,
    ...successRedirect,
    cleanText,
  }
  return new Function(
    ...Object.keys(bindings),
    `${source}; return { createPublicBooking, createPublicTeamBooking, rescheduleManagedBooking, rescheduleHostBooking }`,
  )(...Object.values(bindings)) as Api
}

describe.skipIf(!serverUrl)('multiple duration bookings', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  let ctx: PublicContext
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
    ctx = { db, now }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(options: Parameters<Fixtures['eventType']>[2] = {}) {
    const host = await f.host()
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'durations',
      durationMinutes: 30,
      ...options,
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', eventTypeId)
      .execute()
    const input = (start = '2026-11-02T09:00Z', more: Partial<CreateBookingInput> = {}) => ({
      handle: host.handle,
      slug: 'durations',
      start: instant(start),
      invitee,
      ...more,
    })
    const service: ServiceContext = {
      ...ctx,
      principal: {
        kind: 'session',
        sessionId: 'synthetic-duration-session',
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, slug: '', name: '', personal: true },
      },
    }
    return { ...host, eventTypeId, input, service }
  }

  async function team(schedulingType: 'collective' | 'round_robin') {
    const owner = await createTestUser(db, 'Owner')
    const second = await createTestUser(db, 'Second host')
    const organization = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: second, role: 'member' },
    ])
    const service = testContext(db, organization.as(owner), now)
    await f.schedule(owner.id, { timeZone: 'UTC' })
    await f.schedule(second.id, { timeZone: 'UTC' })
    const event = await createEventType(service, {
      slug: 'durations',
      title: 'Team durations',
      durationMinutes: 30,
      schedulingType,
      hosts: [{ userId: owner.id }, { userId: second.id }],
    })
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [15, 30, 60] })
      .where('id', '=', event.id)
      .execute()
    if (schedulingType === 'round_robin') await activateRoundRobin(service, event.id)
    const input = {
      handle: service.principal.organization.slug,
      slug: 'durations',
      start: instant('2026-11-02T09:00Z'),
      durationMinutes: 60,
      invitee,
    }
    return { event, owner, second, organization, input }
  }

  it.each([15, 30, 60, undefined])(
    'stores the actual selected %s minute interval',
    async (durationMinutes) => {
      const s = await setup()
      const result = await createPublicBooking(ctx, s.input(undefined, { durationMinutes }))
      const minutes = durationMinutes ?? 30
      expect(result.booking.start).toBe('2026-11-02T09:00:00.000Z')
      expect(
        instant(result.booking.start).until(instant(result.booking.end)).total({ unit: 'minutes' }),
      ).toBe(minutes)
      const persisted = await db
        .selectFrom('bookings')
        .select(['start_at', 'end_at'])
        .where('id', '=', result.booking.id)
        .executeTakeFirstOrThrow()
      expect(persisted.end_at.getTime() - persisted.start_at.getTime()).toBe(minutes * 60_000)
      expect(result.booking).not.toHaveProperty('durationMinutes')
    },
  )

  it.each([0, -15, 16, 15.5, 1441, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid selected duration %s before writing',
    async (durationMinutes) => {
      const s = await setup()
      await expect(
        createPublicBooking(ctx, s.input(undefined, { durationMinutes })),
      ).rejects.toMatchObject({
        kind: 'invalid',
        code: 'invalid_duration',
      })
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', s.eventTypeId)
          .execute(),
      ).toHaveLength(0)
    },
  )

  it('keeps legacy idempotency fingerprints and replays before changed duration rules', async () => {
    const s = await setup()
    const request = s.input(undefined, { idempotencyKey: 'legacy-duration-request' })
    const first = await createPublicBooking(ctx, request)
    const expected = createHash('sha256')
      .update(
        canonicalJson({
          eventTypeId: s.eventTypeId,
          start: request.start.toString(),
          invitee,
          guests: [],
          responses: {},
        }),
      )
      .digest()
    const stored = await db
      .selectFrom('bookings')
      .select('idempotency_fingerprint')
      .where('id', '=', first.booking.id)
      .executeTakeFirstOrThrow()
    expect(stored.idempotency_fingerprint?.equals(expected)).toBe(true)
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const replay = await createPublicBooking(ctx, request)
    expect(replay.booking).toEqual(first.booking)
    expect(replay.replayed).toBe(true)
    expect(replay.manageToken === null).toBe(true)
  })

  async function verifySelectedReplay(implementation: Api) {
    const s = await setup()
    const request = s.input(undefined, {
      durationMinutes: 15,
      idempotencyKey: 'selected-duration-request',
    })
    const first = await implementation.createPublicBooking(ctx, request)
    await expect(
      implementation.createPublicBooking(ctx, { ...request, durationMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const replay = await implementation.createPublicBooking(ctx, request)
    expect(replay.booking).toEqual(first.booking)
    expect(replay.replayed).toBe(true)
    expect(replay.manageToken === null).toBe(true)
  }

  it('distinguishes selected durations in the idempotency scope while retaining replays', () =>
    verifySelectedReplay(api))

  it.each(['invitee', 'host'] as const)(
    'preserves a removed original duration on an omitted %s reschedule and permits a valid replacement',
    async (mover) => {
      const s = await setup()
      const original = await createPublicBooking(ctx, s.input(undefined, { durationMinutes: 15 }))
      await db
        .updateTable('event_types')
        .set({ duration_minutes: 60, allowed_durations_minutes: [30, 60] })
        .where('id', '=', s.eventTypeId)
        .execute()
      expect((await getManagedBooking(ctx, original.manageToken as string)).end).toBe(
        original.booking.end,
      )
      const range = { start: instant('2026-11-02T10:00Z'), end: instant('2026-11-02T10:15Z') }
      const slots =
        mover === 'invitee'
          ? await listManagedSlots(ctx, original.manageToken as string, range)
          : await listHostBookingSlots(s.service, original.booking.id, range)
      expect(slots).toEqual([
        { start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:15:00.000Z' },
      ])
      const move = async (durationMinutes?: number) =>
        mover === 'invitee'
          ? rescheduleManagedBooking(ctx, original.manageToken as string, {
              start: instant('2026-11-02T10:00Z'),
              durationMinutes,
            })
          : rescheduleHostBooking(s.service, original.booking.id, {
              start: instant('2026-11-02T10:00Z'),
              durationMinutes,
            })
      await expect(move(15)).rejects.toMatchObject({ code: 'invalid_duration' })
      const preserved = await move()
      expect(preserved.booking.end).toBe('2026-11-02T10:15:00.000Z')
      const replaced =
        mover === 'invitee'
          ? await rescheduleManagedBooking(ctx, preserved.manageToken as string, {
              start: instant('2026-11-02T11:00Z'),
              durationMinutes: 30,
            })
          : await rescheduleHostBooking(s.service, preserved.booking.id, {
              start: instant('2026-11-02T11:00Z'),
              durationMinutes: 30,
            })
      expect(replaced.booking.end).toBe('2026-11-02T11:30:00.000Z')
      const predecessor = await db
        .selectFrom('bookings')
        .select(['start_at', 'end_at', 'status'])
        .where('id', '=', original.booking.id)
        .executeTakeFirstOrThrow()
      expect(predecessor.start_at.toISOString()).toBe(original.booking.start)
      expect(predecessor.end_at.toISOString()).toBe(original.booking.end)
      expect(predecessor.status).toBe('cancelled')
    },
  )

  it('serializes the same slot requested with different durations', async () => {
    const s = await setup()
    const results = await Promise.allSettled(
      [15, 60].map((durationMinutes) =>
        createPublicBooking(ctx, s.input(undefined, { durationMinutes })),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'slot_unavailable' },
    })
    const rows = await db
      .selectFrom('bookings')
      .select(['start_at', 'end_at'])
      .where('event_type_id', '=', s.eventTypeId)
      .execute()
    expect(rows).toHaveLength(1)
    const winner = results.find((result) => result.status === 'fulfilled')
    if (winner?.status !== 'fulfilled') throw new Error('Missing winning booking')
    expect(rows[0]?.end_at.toISOString()).toBe(winner.value.booking.end)
  })

  it('applies buffers and daily limits to actual selected intervals', async () => {
    const s = await setup({ bufferAfterMinutes: 15, maxBookingsPerDay: 2, slotStepMinutes: 15 })
    const first = await createPublicBooking(ctx, s.input(undefined, { durationMinutes: 60 }))
    expect(first.booking.end).toBe('2026-11-02T10:00:00.000Z')
    await expect(
      createPublicBooking(ctx, s.input('2026-11-02T10:00Z', { durationMinutes: 15 })),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    await createPublicBooking(ctx, s.input('2026-11-02T10:15Z', { durationMinutes: 15 }))
    await expect(
      createPublicBooking(ctx, s.input('2026-11-02T11:00Z', { durationMinutes: 60 })),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
  })

  async function verifySelected(implementation: Api) {
    const s = await setup()
    await expect(
      implementation.createPublicBooking(ctx, s.input(undefined, { durationMinutes: 15 })),
    ).resolves.toMatchObject({ booking: { end: '2026-11-02T09:15:00.000Z' } })
  }

  async function verifySnapshot(implementation: Api) {
    const s = await setup()
    const original = await implementation.createPublicBooking(
      ctx,
      s.input(undefined, { durationMinutes: 15 }),
    )
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(
      implementation.rescheduleManagedBooking(ctx, original.manageToken as string, {
        start: instant('2026-11-02T10:00Z'),
      }),
    ).resolves.toMatchObject({ booking: { end: '2026-11-02T10:15:00.000Z' } })
  }

  async function verifyRescheduleSelection(implementation: Api) {
    for (const mover of ['invitee', 'host'] as const) {
      const s = await setup()
      const original = await implementation.createPublicBooking(
        ctx,
        s.input(undefined, { durationMinutes: 15 }),
      )
      const selected = { start: instant('2026-11-02T10:00Z'), durationMinutes: 60 }
      const pending =
        mover === 'invitee'
          ? implementation.rescheduleManagedBooking(ctx, original.manageToken as string, selected)
          : implementation.rescheduleHostBooking(s.service, original.booking.id, selected)
      await expect(pending).resolves.toMatchObject({ booking: { end: '2026-11-02T11:00:00.000Z' } })
    }
  }

  async function verifyTeam(implementation: Api, schedulingType: 'collective' | 'round_robin') {
    const s = await team(schedulingType)
    const pending = implementation.createPublicTeamBooking(ctx, s.input)
    await expect(pending).resolves.toMatchObject({ booking: { end: '2026-11-02T10:00:00.000Z' } })
    const result = await pending
    const assigned = await db
      .selectFrom('booking_hosts')
      .select('user_id')
      .where('booking_id', '=', result.booking.id)
      .execute()
    expect(assigned).toHaveLength(schedulingType === 'collective' ? 2 : 1)
  }

  it.each(['collective', 'round_robin'] as const)(
    'uses the selected duration for %s host assignment',
    (type) => verifyTeam(api, type),
  )

  it('passes the same duration assertions for an unmodified source copy', async () => {
    const copy = sourceCopy()
    await verifySelected(copy)
    await verifySelectedReplay(copy)
    await verifySnapshot(copy)
    await verifyRescheduleSelection(copy)
    await verifyTeam(copy, 'round_robin')
  })

  async function verifyManagedSelection(copy: ManageApi) {
    const s = await setup()
    const original = await createPublicBooking(ctx, s.input(undefined, { durationMinutes: 15 }))
    const range = {
      start: instant('2026-11-02T10:00Z'),
      end: instant('2026-11-02T10:30Z'),
      durationMinutes: 30,
    }
    const expected = [{ start: '2026-11-02T10:00:00.000Z', end: '2026-11-02T10:30:00.000Z' }]
    await expect(
      copy.listManagedSlots(ctx, original.manageToken as string, range),
    ).resolves.toEqual(expected)
    await expect(copy.listHostBookingSlots(s.service, original.booking.id, range)).resolves.toEqual(
      expected,
    )
  }

  async function verifyManagedSnapshotCap(copy: ManageApi) {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ allowed_durations_minutes: [1, 30, 60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const original = await createPublicBooking(ctx, s.input(undefined, { durationMinutes: 1 }))
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    await expect(
      copy.listManagedSlots(ctx, original.manageToken as string, {
        start: instant('2026-11-02T00:00Z'),
        end: instant('2026-12-02T00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'range_too_long' })
  }

  it('keeps managed duration selection and snapshot candidate bounds in an unmodified source copy', async () => {
    const copy = manageSourceCopy()
    await verifyManagedSelection(copy)
    await verifyManagedSnapshotCap(copy)
  })

  it.each<[string, Change, (copy: ManageApi) => Promise<unknown>]>([
    [
      'managed duration forwarding',
      [
        'snapshot.hosts_use_default_schedule,\n    durationMinutes,',
        'snapshot.hosts_use_default_schedule,',
      ],
      verifyManagedSelection,
    ],
    [
      'original-duration candidate bounds',
      [
        "Temporal.Instant.from(booking.end)\n          .since(Temporal.Instant.from(booking.start))\n          .total('minutes')",
        'eventType.duration_minutes',
      ],
      verifyManagedSnapshotCap,
    ],
  ])('detects removal of %s with a real assertion failure', async (_, change, verify) => {
    const copy = manageSourceCopy(change)
    await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })

  it.each<[string, Change, (copy: Api) => Promise<unknown>]>([
    [
      'selected booking duration',
      ['selectDurationMinutes(current, input.durationMinutes)', 'current.durationMinutes'],
      verifySelected,
    ],
    [
      'selected slot duration forwarding',
      ['durationMinutes: q.durationMinutes,', ''],
      verifySelected,
    ],
    [
      'duration-sensitive idempotency',
      ['durationMinutes: input.durationMinutes,', ''],
      verifySelectedReplay,
    ],
    [
      'original duration snapshot',
      [
        "toInstant(old.end_at).since(toInstant(old.start_at)).total({ unit: 'minutes' })",
        'eventType.duration_minutes',
      ],
      verifySnapshot,
    ],
    [
      'invitee reschedule duration forwarding',
      [
        'return rescheduleLocked(ctx, trx, old, start, origin, false, durationMinutes)',
        'return rescheduleLocked(ctx, trx, old, start, origin, false)',
      ],
      verifyRescheduleSelection,
    ],
    [
      'host reschedule duration forwarding',
      ['true,\n      durationMinutes,', 'true,'],
      verifyRescheduleSelection,
    ],
    [
      'round-robin selected duration forwarding',
      ['now,\n              durationMinutes: input.durationMinutes,', 'now,'],
      (copy) => verifyTeam(copy, 'round_robin'),
    ],
  ])('detects removal of %s with a real assertion failure', async (_, change, verify) => {
    const copy = sourceCopy(change)
    await expect(verify(copy)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
