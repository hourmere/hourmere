import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { checkTeamManagementAccess, TeamManagementError } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bookingPageQuery, encodeBookingCursor } from './booking-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { MemberDepartureBookingSchema } from './member-departure-impact.ts'
import {
  getLatestTeamMemberRemovalHandling,
  getTeamMemberRemovalHandling,
  MemberRemovalHandlingSchema,
} from './member-removal.ts'
import { toTeamAdminBooking } from './team-admin-booking.ts'
import { countTeamBookings, readTeamBookingPage } from './team-bookings.ts'
import { createFixtures, createTestTeam, createTestUser } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
type Read = typeof getTeamMemberRemovalHandling
type LatestRead = typeof getLatestTeamMemberRemovalHandling
type Change = readonly [string, string]
type Source = 'handling' | 'team' | 'page'

function copies(change?: Change, target: Source = 'handling'): { read: Read; latest: LatestRead } {
  function compile(path: string, sourceTarget: Source) {
    let source = readFileSync(path, 'utf8')
    if (change && sourceTarget === target) {
      expect(source.includes(change[0]), 'mutation must match source').toBe(true)
      source = source.replace(...change)
    }
    return stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
      /\bexport /g,
      '',
    )
  }
  let page = { bookingPageQuery, encodeBookingCursor }
  let team = { countTeamBookings, readTeamBookingPage }
  if (target === 'page') {
    page = new Function(
      'DomainError',
      'isUuid',
      `${compile('packages/scheduling/src/booking-page.ts', 'page')}; return { bookingPageQuery, encodeBookingCursor }`,
    )(DomainError, isUuid) as typeof page
  }
  if (target !== 'handling') {
    const bindings = { sql, ...page, DomainError, isUuid, toTeamAdminBooking }
    team = new Function(
      ...Object.keys(bindings),
      `${compile('packages/scheduling/src/team-bookings.ts', 'team')}; return { countTeamBookings, readTeamBookingPage }`,
    )(...Object.values(bindings)) as typeof team
  }
  const bindings = {
    checkTeamManagementAccess,
    TeamManagementError,
    sql,
    z,
    DomainError,
    isUuid,
    MemberDepartureBookingSchema,
    ...team,
  }
  return new Function(
    ...Object.keys(bindings),
    `${compile('packages/scheduling/src/member-removal.ts', 'handling')}; return { read: getTeamMemberRemovalHandling, latest: getLatestTeamMemberRemovalHandling }`,
  )(...Object.values(bindings)) as { read: Read; latest: LatestRead }
}
const sourceCopy = (change?: Change, target?: Source) => copies(change, target).read

describe.skipIf(!serverUrl)('member removal handling service', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture(role = 'owner') {
    const actor = await createTestUser(db, 'Handling owner')
    const removed = await createTestUser(db, 'Removed host')
    const other = await createTestUser(db, 'Remaining host')
    const team = await createTestTeam(db, [
      { user: actor, role },
      { user: other, role: 'member' },
    ])
    const { id: sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: actor.id,
        token: randomBytes(24).toString('base64url'),
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: operationId } = await db
      .insertInto('organization_operations')
      .values({
        organization_id: team.id,
        operation: 'member_removed',
        actor_user_id: actor.id,
        target_user_id: removed.id,
        previous_role: 'member',
        source: 'web',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ctx: ServiceContext = {
      db,
      now,
      principal: { ...team.as(actor), kind: 'session', sessionId },
    }
    const eventId = await createFixtures(db).eventType(team.id, null, {
      hosts: [{ userId: removed.id }],
    })
    return { actor, removed, other, team, eventId, ctx, input: { teamId: team.id, operationId } }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function booking(
    f: Fixture,
    start: string,
    options: {
      teamId?: string
      eventId?: string
      hostId?: string
      cancelled?: boolean
      end?: string
    } = {},
  ) {
    const id = randomUUID()
    await db
      .insertInto('bookings')
      .values({
        id,
        organization_id: options.teamId ?? f.team.id,
        event_type_id: options.eventId ?? f.eventId,
        start_at: start,
        end_at: options.end ?? Temporal.Instant.from(start).add({ minutes: 30 }).toString(),
        title: 'private-handling-booking',
        responses: JSON.stringify({ secret: 'private-handling-answer' }),
        location: JSON.stringify({ kind: 'link', url: 'https://private.invalid/meeting' }),
        manage_token_hash: randomBytes(32),
        source: 'web',
        status: options.cancelled ? 'cancelled' : 'confirmed',
        cancelled_at: options.cancelled ? new Date() : null,
      })
      .execute()
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: id, user_id: options.hostId ?? f.removed.id })
      .execute()
    return id
  }

  async function verify(read: Read) {
    const f = await fixture()
    const ongoing = await booking(f, '2026-11-01T12:00:00Z')
    const future = await booking(f, '2026-11-02T09:00:00Z')
    await booking(f, '2026-11-01T11:30:00Z')
    await booking(f, '2026-11-03T09:00:00Z', { cancelled: true })
    await booking(f, '2026-11-04T09:00:00Z', { hostId: f.other.id })
    const personalEvent = await createFixtures(db).eventType(f.team.id, f.removed.id, {})
    await booking(f, '2026-11-05T09:00:00Z', { eventId: personalEvent })
    const foreign = await createTestTeam(db, [{ user: f.removed, role: 'member' }])
    const foreignEvent = await createFixtures(db).eventType(foreign.id, null, {
      hosts: [{ userId: f.removed.id }],
    })
    await booking(f, '2026-11-06T09:00:00Z', { teamId: foreign.id, eventId: foreignEvent })

    const first = MemberRemovalHandlingSchema.parse(await read(f.ctx, { ...f.input, limit: 1 }))
    expect(first.reason).toBe('member_removed')
    expect(first.memberUserId).toBe(f.removed.id)
    expect(first.bookings.totalCount).toBe(2)
    expect(first.bookings.data.map((item) => item.id)).toEqual([ongoing])
    expect(first.bookings.data[0]).toMatchObject({
      inProgress: true,
      handling: 'wait_until_end_or_coordinate_offline',
    })
    expect(first.bookings.nextCursor).toEqual(expect.any(String))
    const second = MemberRemovalHandlingSchema.parse(
      await read(f.ctx, { ...f.input, limit: 1, cursor: first.bookings.nextCursor as string }),
    )
    expect(second.bookings.totalCount).toBe(2)
    expect(second.bookings.data.map((item) => item.id)).toEqual([future])
    expect(second.bookings.data[0]).toMatchObject({
      inProgress: false,
      handling: 'coordinate_cancellation',
    })
    expect(second.bookings.nextCursor).toBeNull()
    expect(JSON.stringify(first)).not.toContain('private-handling')
    expect(JSON.stringify(second)).not.toContain('private.invalid')
  }

  it('reads a removed host with precise bounded pages and the administration whitelist', async () => {
    await verify(getTeamMemberRemovalHandling)
    await verify(sourceCopy())
  })
  it.each<[Source, Change]>([
    ['team', [".where('b.organization_id', '=', teamId)", '']],
    ['team', [".where('event.owner_user_id', 'is', null)", '']],
    ['team', [".where('assigned_host.user_id', '=', hostUserId as string)", '']],
    ['page', [".$if(status !== undefined, (q) => q.where('b.status', '=', status as string))", '']],
    [
      'page',
      [
        ".$if(endAfter !== undefined, (q) =>\n      q.where((eb) => eb('b.end_at', '>', timestamptz(eb, endAfter as Temporal.Instant))),\n    )",
        '',
      ],
    ],
    [
      'handling',
      ['Temporal.Instant.compare(start, now) <= 0', 'Temporal.Instant.compare(start, now) < -1'],
    ],
    [
      'handling',
      [
        "inProgress ? 'wait_until_end_or_coordinate_offline'",
        "false ? 'wait_until_end_or_coordinate_offline'",
      ],
    ],
    ['handling', ['      totalCount,', '      totalCount: data.length,']],
  ])('detects handling projection mutation in %s: %s', async (target, change) => {
    await expect(verify(sourceCopy(change, target))).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  async function verifyMatchingCount(read: Read) {
    const f = await fixture()
    const first = await booking(f, '2026-11-02T09:00:00Z')
    const personal = await createFixtures(db).eventType(f.team.id, f.removed.id, {})
    const filtered = await booking(f, '2026-11-03T09:00:00Z', { eventId: personal })
    const last = await booking(f, '2026-11-04T09:00:00Z')
    const ids: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const result = await read(f.ctx, { ...f.input, limit: 1, cursor })
      expect(result.bookings.totalCount).toBe(2)
      ids.push(...result.bookings.data.map((item) => item.id))
      cursor = result.bookings.nextCursor ?? undefined
      if (cursor === undefined) break
    }
    expect(cursor).toBeUndefined()
    expect(ids).toEqual([first, last])
    expect(ids).not.toContain(filtered)
    expect(ids).toHaveLength(2)
  }

  it('counts the same filtered booking set across every handling page', async () => {
    await verifyMatchingCount(getTeamMemberRemovalHandling)
    await verifyMatchingCount(sourceCopy())
  })
  it('detects a handling count that omits the shared event filter', async () => {
    const read = sourceCopy(
      [
        'const { query } = teamBookingQuery(ctx, teamId, input, hostUserId, teamEventTypesOnly)',
        'const { query } = teamBookingQuery(ctx, teamId, input, hostUserId)',
      ],
      'team',
    )
    await expect(verifyMatchingCount(read)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  async function verifyDenial(read: Read, kind: 'member' | 'foreign' | 'role_record' | 'leave') {
    const f = await fixture(kind === 'member' ? 'member' : 'owner')
    if (kind === 'foreign') {
      const foreign = await createTestTeam(db, [{ user: f.actor, role: 'owner' }])
      await db
        .updateTable('organization_operations')
        .set({ organization_id: foreign.id })
        .where('id', '=', f.input.operationId)
        .execute()
    } else if (kind === 'role_record') {
      await db
        .updateTable('organization_operations')
        .set({ operation: 'member_role_changed', new_role: 'admin' })
        .where('id', '=', f.input.operationId)
        .execute()
    } else if (kind === 'leave') {
      await db
        .updateTable('organization_operations')
        .set({ actor_user_id: f.removed.id })
        .where('id', '=', f.input.operationId)
        .execute()
    }
    const result = await read(f.ctx, f.input).catch((error: unknown) => error)
    expect(result).toMatchObject({ kind: 'forbidden', code: 'team_management_access_denied' })
  }
  it.each(['member', 'foreign', 'role_record', 'leave'] as const)(
    'denies an inaccessible %s handling record',
    async (kind) => verifyDenial(getTeamMemberRemovalHandling, kind),
  )
  it.each<[Parameters<typeof verifyDenial>[1], Change]>([
    [
      'member',
      [
        'await checkTeamManagementAccess(ctx.db, ctx.principal, input.teamId, false, {\n      expectedOrganizationId: input.teamId,\n      allowPersonal: false,\n    })',
        'await Promise.resolve()',
      ],
    ],
    ['foreign', [".where('organization_id', '=', input.teamId)", '']],
    ['role_record', [".where('operation', '=', 'member_removed')", '']],
    ['leave', [".whereRef('actor_user_id', '!=', 'target_user_id')", '']],
  ])('detects bypassing %s handling access', async (kind, change) => {
    await expect(verifyDenial(sourceCopy(change), kind)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  async function verifyLatest(read: LatestRead) {
    const f = await fixture()
    await db
      .updateTable('organization_operations')
      .set({ occurred_at: new Date('2026-10-28T10:00:00Z') })
      .where('id', '=', f.input.operationId)
      .execute()
    const record = {
      organization_id: f.team.id,
      operation: 'member_removed',
      actor_user_id: f.actor.id,
      target_user_id: f.removed.id,
      previous_role: 'member',
      source: 'web',
    }
    const latest = await db
      .insertInto('organization_operations')
      .values({ ...record, occurred_at: new Date('2026-10-28T11:00:00Z') })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('organization_operations')
      .values({
        ...record,
        target_user_id: f.other.id,
        occurred_at: new Date('2026-10-28T12:00:00Z'),
      })
      .execute()
    const result = await read(f.ctx, { teamId: f.team.id, memberUserId: f.removed.id })
    expect(result.id).toBe(latest.id)
    expect(result.memberUserId).toBe(f.removed.id)
  }
  it('discovers only the requested member latest removal after native revocation', async () => {
    await verifyLatest(getLatestTeamMemberRemovalHandling)
    await verifyLatest(copies().latest)
  })
  it.each<Change>([
    ["query = query.where('target_user_id', '=', input.memberUserId)", 'query = query'],
    [".orderBy('occurred_at', 'desc')", ".orderBy('occurred_at', 'asc')"],
  ])('detects broken latest-record discovery %s', async (before, after) => {
    await expect(verifyLatest(copies([before, after]).latest)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
