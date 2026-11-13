import { randomUUID } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cancelManagedBooking, createPublicTeamBooking } from '../../scheduling/src/bookings.ts'
import { createFixtures } from '../../scheduling/src/testing.ts'
import { applyExtractedImport } from './apply.ts'
import { checkSourceMutation } from './mutation-testing.ts'
import {
  buildPreview,
  extractForPreview,
  registerImportSource,
  type SourceInput,
} from './preview.ts'
import { createSourceFixture } from './source-fixture.ts'
import { type parserContext, readTargetState } from './target.ts'

describe.skipIf(!process.env.DATABASE_URL)('import preview group-slot occupancy', () => {
  let target: TestDatabase
  let source: Awaited<ReturnType<typeof createSourceFixture>>
  const users: string[] = []
  const organizations: string[] = []
  beforeAll(async () => {
    target = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'import_groups',
    })
    source = await createSourceFixture('cal.diy-a5ee96f77edd')
  }, 30_000)
  afterEach(async () => {
    await target.pool.query('DELETE FROM auth.organization WHERE id=ANY($1::uuid[])', [
      organizations.splice(0),
    ])
    await target.pool.query('DELETE FROM auth."user" WHERE id=ANY($1::uuid[])', [users.splice(0)])
  })
  afterAll(async () => {
    try {
      await source?.drop()
    } finally {
      await target?.drop()
    }
  }, 60_000)
  async function setup(bufferAfterMinutes = 0) {
    const db = createDb(target.pool)
    const fixtures = createFixtures(db)
    const host = await fixtures.host({
      handle: `group-${randomUUID().slice(0, 8)}`,
      timeZone: 'UTC',
    })
    users.push(host.userId)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      'owner@example.test',
      host.userId,
    ])
    await fixtures.schedule(host.userId, { timeZone: 'UTC' })
    const teamSlug = `team-${randomUUID().slice(0, 8)}`
    const teamId = await fixtures.organization(teamSlug)
    organizations.push(teamId)
    await fixtures.member(host.userId, teamId, 'owner')
    const event = await fixtures.eventType(teamId, host.userId, {
      slug: 'group',
      durationMinutes: 60,
      bookingWindowDays: null,
      bufferAfterMinutes,
    })
    await target.pool.query(
      "UPDATE event_types SET booking_mode='group',group_capacity=2,owner_user_id=NULL WHERE id=$1",
      [event],
    )
    const input: SourceInput = {
      connectionString: source.connectionString,
      sourceId: randomUUID(),
      sourceVersion: 'cal.diy-a5ee96f77edd',
      selectedUserIds: [1],
      utcTimestampsConfirmed: true,
      authorization: {
        operatorUserId: host.userId,
        operatorAuthorized: true,
        owners: [{ sourceUserId: 1, targetUserId: host.userId, importPersonalData: true }],
      },
      bookingDecisions: [
        { sourceBookingId: 1000, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
      ],
    }
    const snapshot = await extractForPreview(target.pool, input, '2040-01-01T00:00:00.000Z')
    input.sourceId = await registerImportSource(target.pool, snapshot, input.authorization)
    const { connectionString: _connectionString, ...options } = input
    const read = () =>
      readTargetState(target.pool, input.sourceId, input.authorization, snapshot.cutoff)
    const ctx = { db, now: () => Temporal.Instant.from('2040-12-31T00:00:00Z') }
    const book = (start = '2041-01-01T10:00:00Z') =>
      createPublicTeamBooking(ctx, {
        handle: teamSlug,
        slug: 'group',
        start: Temporal.Instant.from(start),
        invitee: { name: 'Guest', email: 'guest@example.test', timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      })
    return { input, snapshot, options, read, ctx, book }
  }
  it('blocks a slot overlap in preview and apply, then permits import after the final seat cancels', async () => {
    const f = await setup()
    const seat = await f.book()
    const state = await f.read()
    expect(state.groupOccupancy).toHaveLength(1)
    const plan = buildPreview(f.snapshot, state, f.options)
    expect(plan.blocked).toBe(true)
    expect(plan.impacts).toContainEqual({
      code: 'target_overlap',
      sourceBookingId: 1000,
      relatedId: state.groupOccupancy[0]?.group_slot_id,
    })
    await checkSourceMutation(
      new URL('./preview.ts', import.meta.url),
      'for (const slot of state.groupOccupancy)',
      'for (const slot of state.groupOccupancy.slice(0, 0))',
      (m) => m.buildPreview as typeof buildPreview,
      (build) =>
        expect(build(f.snapshot, state, f.options).impacts).toContainEqual({
          code: 'target_overlap',
          sourceBookingId: 1000,
          relatedId: state.groupOccupancy[0]?.group_slot_id,
        }),
    )
    expect(plan.plan.problems).toContainEqual(
      expect.objectContaining({
        code: 'booking_target_overlap',
        source: { table: 'Booking', id: 1000 },
      }),
    )
    expect(
      await applyExtractedImport(target.pool, plan, f.input, async () => f.snapshot),
    ).toMatchObject({ code: 'IMPORT_PREVIEW_BLOCKED', committed: false })
    await cancelManagedBooking(f.ctx, seat.manageToken as string)
    expect((await f.read()).groupOccupancy).toEqual([])
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      'AND h.active AND h.user_id=ANY($1::uuid[])',
      'AND h.user_id=ANY($1::uuid[])',
      (m) => m.readTargetState as typeof readTargetState,
      async (read) =>
        expect(
          (await read(target.pool, f.input.sourceId, f.input.authorization, f.snapshot.cutoff))
            .groupOccupancy,
        ).toEqual([]),
    )
    const clear = buildPreview(f.snapshot, await f.read(), f.options)
    expect(clear.blocked).toBe(false)
    expect(
      await applyExtractedImport(target.pool, clear, f.input, async () => f.snapshot),
    ).toMatchObject({ status: 'applied', committed: true })
  })
  it('fingerprints a new nonoverlapping slot and refuses the stale preview before writing', async () => {
    const f = await setup()
    const before = await f.read()
    const plan = buildPreview(f.snapshot, before, f.options)
    expect(plan.blocked).toBe(false)
    await f.book('2041-01-01T12:00:00Z')
    const after = await f.read()
    expect(after.bookings).toEqual(before.bookings)
    expect(buildPreview(f.snapshot, after, f.options).targetFingerprint).not.toBe(
      plan.targetFingerprint,
    )
    expect(
      await applyExtractedImport(target.pool, plan, f.input, async () => f.snapshot),
    ).toMatchObject({ code: 'IMPORT_TARGET_CHANGED', committed: false })
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      'bookings, groupOccupancy, waitlistEvents, items,',
      'bookings, groupOccupancy: [], waitlistEvents, items,',
      (m) => m.readTargetState as typeof readTargetState,
      async (read) => {
        const state = await read(
          target.pool,
          f.input.sourceId,
          f.input.authorization,
          f.snapshot.cutoff,
        )
        expect(buildPreview(f.snapshot, state, f.options).targetFingerprint).not.toBe(
          plan.targetFingerprint,
        )
      },
    )
  })
  it('reports a group buffer after the slot ends, including across the preview cutoff', async () => {
    const f = await setup(30)
    await f.book('2041-01-01T09:00:00Z')
    const snapshot = { ...f.snapshot, cutoff: '2041-01-01T10:00:00.000Z' }
    const state = await readTargetState(
      target.pool,
      f.input.sourceId,
      f.input.authorization,
      snapshot.cutoff,
    )
    expect(state.groupOccupancy).toHaveLength(1)
    const preview = buildPreview(snapshot, state, f.options)
    expect(preview.blocked).toBe(false)
    expect(preview.impacts).toContainEqual({
      code: 'buffer_impact',
      sourceBookingId: 1000,
      relatedId: state.groupOccupancy[0]?.group_slot_id,
    })
    await checkSourceMutation(
      new URL('./preview.ts', import.meta.url),
      '...state.groupOccupancy.filter',
      '...state.groupOccupancy.slice(0, 0).filter',
      (m) => m.buildPreview as typeof buildPreview,
      (build) =>
        expect(build(snapshot, state, f.options).impacts).toContainEqual({
          code: 'buffer_impact',
          sourceBookingId: 1000,
          relatedId: state.groupOccupancy[0]?.group_slot_id,
        }),
    )
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      "upper(h.period)+s.buffer_after_minutes*interval '1 minute'>$2::timestamptz",
      'upper(h.period)>$2::timestamptz',
      (m) => m.readTargetState as typeof readTargetState,
      async (read) =>
        expect(
          (await read(target.pool, f.input.sourceId, f.input.authorization, snapshot.cutoff))
            .groupOccupancy,
        ).toHaveLength(1),
    )
  })
  it('kills source-copy omissions of group reads and parser busy intervals', async () => {
    const f = await setup()
    await f.book()
    const state = await f.read()
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      'h.booking_id IS NULL AND h.group_slot_id IS NOT NULL',
      'false AND h.booking_id IS NULL AND h.group_slot_id IS NOT NULL',
      (m) => m.readTargetState as typeof readTargetState,
      async (read) =>
        expect(
          (await read(target.pool, f.input.sourceId, f.input.authorization, f.snapshot.cutoff))
            .groupOccupancy,
        ).toHaveLength(1),
    )
    await checkSourceMutation(
      new URL('./target.ts', import.meta.url),
      'state.groupOccupancy.map',
      'state.groupOccupancy.slice(0, 0).map',
      (m) => m.parserContext as typeof parserContext,
      (context) =>
        expect(context(state, f.input.authorization).busy).toContainEqual({
          targetUserId: f.input.authorization.operatorUserId,
          start: '2041-01-01T10:00:00.000Z',
          end: '2041-01-01T11:00:00.000Z',
        }),
    )
  })
})
