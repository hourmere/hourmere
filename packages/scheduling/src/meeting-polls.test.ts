import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { canonicalJson, lockHosts } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import * as Polls from './meeting-polls.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type PollModule = typeof Polls
type Input = Polls.CreateMeetingPollInput
/** Lets a test pin the creation instant through globalThis; unset, the database clock rules. */
const PIN_CLOCK = [
  'const createdAt = await clock(trx)',
  'const createdAt = (globalThis as { meetingPollClock?: string }).meetingPollClock ?? (await clock(trx))',
] as const

/** Imports an isolated copy; the production file is never overwritten. */
async function sourceCopy(...replacements: (readonly [string, string])[]): Promise<PollModule> {
  const location = new URL('./meeting-polls.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.includes(from), `mutation must match source: ${from}`).toBe(true)
    source = source.replace(from, to)
  }
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return guardCopy<PollModule>(
    await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`),
  )
}

/** Source copies load their own DomainError class, so compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) expect.unreachable('expected the operation to fail')
  const domain = error as Partial<DomainError> & {
    pollId?: string | null
    unavailableStarts?: string[]
  }
  return {
    name: error.name,
    kind: domain.kind,
    code: domain.code,
    pollId: domain.pollId,
    unavailableStarts: domain.unavailableStarts,
  }
}

/** Expected success, reported as an assertion so that a throwing mutant is not a crash. */
async function succeeds<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const { name, code } = error as { name?: string; code?: string }
    return expect.unreachable(`expected success, got ${name} ${code}`)
  }
}

function session(principal: Principal): Principal {
  return {
    kind: 'session',
    sessionId: randomUUID(),
    user: principal.user,
    organization: principal.organization,
  }
}

describe.skipIf(!serverUrl)('meeting poll host lifecycle', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'meeting_polls' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function databaseNow() {
    const { rows } = await sql<{
      now: string
    }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`.execute(
      db,
    )
    return Temporal.Instant.from(rows[0]?.now as string)
  }

  /** A whole-hour deadline about a day after the database clock. */
  async function nextDeadline() {
    return (await databaseNow()).round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({
      hours: 24,
    })
  }

  /**
   * Deadline one day from the database clock; candidates deliberately out of order. Whole
   * hours are on every test event's slot grid, as a bookable candidate must be.
   */
  async function input(eventTypeId: string, overrides: Partial<Input> = {}): Promise<Input> {
    const deadline = await nextDeadline()
    return {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 26 }).toString(),
        deadline.add({ hours: 25 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'Europe/Berlin',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
      ...overrides,
    }
  }

  type ScheduleOptions = Parameters<typeof fixtures.schedule>[1]
  /** Every day around the clock in UTC, so any whole-hour candidate is bookable. */
  const ALWAYS: ScheduleOptions = {
    timeZone: 'UTC',
    weeklyHours: {
      ...weekdays({ start: '00:00', end: '24:00' }),
      saturday: [{ start: '00:00', end: '24:00' }],
      sunday: [{ start: '00:00', end: '24:00' }],
    },
  }

  /** A personal event whose owner has a public handle and, by default, no busy hours. */
  async function personal(
    event: Parameters<typeof fixtures.eventType>[2] = {},
    schedule: ScheduleOptions = ALWAYS,
  ) {
    const user = await createTestUser(db, 'Personal Owner')
    const organizationId = user.principal.organization.id
    await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        handle: `poll-${randomBytes(6).toString('hex')}`,
        time_zone: 'UTC',
      })
      .execute()
    await fixtures.schedule(user.id, schedule)
    const eventTypeId = await fixtures.eventType(organizationId, user.id, event)
    return { user, organizationId, eventTypeId, ctx: testContext(db, session(user.principal)) }
  }

  type TeamRole = 'admin' | 'owner' | 'member'
  /** A team event hosted, by default, by the ordinary member alone; everyone is free. */
  async function team(
    event: Parameters<typeof fixtures.eventType>[2] = {},
    {
      hosts = ['member'],
      schedulingType = 'individual',
    }: { hosts?: TeamRole[]; schedulingType?: 'individual' | 'collective' | 'round_robin' } = {},
  ) {
    const admin = await createTestUser(db, 'Team Admin')
    const owner = await createTestUser(db, 'Team Owner')
    const member = await createTestUser(db, 'Configured Host')
    for (const user of [admin, owner, member]) await fixtures.schedule(user.id, ALWAYS)
    const t = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const users = { admin, owner, member }
    const eventTypeId = await fixtures.eventType(t.id, null, {
      hosts: hosts.map((role) => ({ userId: users[role].id })),
      ...event,
    })
    if (schedulingType !== 'individual')
      await db
        .updateTable('event_types')
        .set({ scheduling_type: schedulingType })
        .where('id', '=', eventTypeId)
        .execute()
    if (schedulingType === 'round_robin')
      await db
        .insertInto('round_robin_state')
        .values({ event_type_id: eventTypeId, enabled: true })
        .execute()
    const as = (user: TestUser) => testContext(db, session(t.as(user)))
    return {
      team: t,
      admin,
      owner,
      member,
      organizationId: t.id,
      eventTypeId,
      ctx: as(admin),
      ownerCtx: as(owner),
      memberCtx: as(member),
      as,
    }
  }

  /** A booking with its host rows, written as the booking path stores them. */
  async function book(
    executor: Db,
    organizationId: string,
    hostUserIds: string[],
    start: string,
    {
      minutes = 30,
      eventTypeId = null,
      status = 'confirmed',
      holdExpiresAt = null,
    }: {
      minutes?: number
      eventTypeId?: string | null
      status?: 'confirmed' | 'cancelled' | 'pending_payment'
      holdExpiresAt?: string | null
    } = {},
  ) {
    const row = await executor
      .insertInto('bookings')
      .values({
        organization_id: organizationId,
        event_type_id: eventTypeId,
        status,
        cancelled_at: status === 'cancelled' ? new Date() : null,
        payment_hold_expires_at: holdExpiresAt,
        start_at: start,
        end_at: Temporal.Instant.from(start).add({ minutes }).toString(),
        title: 'Fixture booking',
        manage_token_hash: randomBytes(32),
        source: 'api',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await executor
      .insertInto('booking_hosts')
      .values(hostUserIds.map((user_id) => ({ booking_id: row.id, user_id })))
      .execute()
    return row.id
  }

  /** Create with exactly these candidates and a fresh key. */
  async function propose(
    M: PollModule,
    ctx: ServiceContext,
    eventTypeId: string,
    candidateStarts: string[],
    deadline?: Temporal.Instant,
  ) {
    return M.createMeetingPoll(ctx, {
      ...(await input(eventTypeId)),
      ...(deadline && { deadlineAt: deadline.toString() }),
      candidateStarts,
    })
  }

  /** Whole-hour candidates from a day after a whole-hour deadline, earliest first. */
  async function hourly(count: number) {
    const deadline = await nextDeadline()
    return {
      deadline,
      starts: Array.from({ length: count }, (_, i) => deadline.add({ hours: 25 + i }).toString()),
    }
  }

  async function pollsOf(eventTypeId: string) {
    return db
      .selectFrom('meeting_polls')
      .select('id')
      .where('event_type_id', '=', eventTypeId)
      .execute()
  }

  async function stored(id: string) {
    return db.selectFrom('meeting_polls').selectAll().where('id', '=', id).executeTakeFirst()
  }

  /** Every column fixed at creation, plus the candidate rows. */
  async function fixedSettings(id: string) {
    const row = await db
      .selectFrom('meeting_polls')
      .select([
        'organization_id',
        'event_type_id',
        'title',
        'duration_minutes',
        'display_time_zone',
        'admission_mode',
        'visibility',
        'settings_snapshot',
        'settings_fingerprint',
        'created_by_user_id',
        'source',
        'api_key_id',
        'results_revision',
        sql<string>`deadline_at::text`.as('deadline'),
        sql<string>`created_at::text`.as('created'),
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    const slots = await db
      .selectFrom('meeting_poll_slots')
      .select([
        'id',
        'position',
        sql<string>`start_at::text`.as('s'),
        sql<string>`end_at::text`.as('e'),
      ])
      .where('poll_id', '=', id)
      .orderBy('position')
      .execute()
    return { ...row, settings_fingerprint: row.settings_fingerprint.toString('hex'), slots }
  }

  async function receipts(pollId: string | null, operation?: string) {
    return db
      .selectFrom('meeting_poll_operations')
      .selectAll()
      .$if(pollId !== null, (q) => q.where('poll_id', '=', pollId as string))
      .$if(operation !== undefined, (q) => q.where('operation', '=', operation as string))
      .execute()
  }

  /** A checksum of every row of every table, so that an UPDATE is noticed as well as an INSERT. */
  async function tableCounts() {
    const { rows: tables } = await sql<{ name: string }>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`.execute(db)
    const { rows } = await sql<{ name: string; checksum: string }>`${sql.join(
      tables.map(
        ({ name }) =>
          sql`SELECT ${name}::text AS name, (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) FROM ${sql.raw(name)} AS t) AS checksum`,
      ),
      sql` UNION ALL `,
    )}`.execute(db)
    return Object.fromEntries(rows.map((row) => [row.name, row.checksum]))
  }

  async function scheduled(s: Awaited<ReturnType<typeof team>>, pollId: string) {
    const slot = await db
      .selectFrom('meeting_poll_slots')
      .select(['id', 'start_at', 'end_at'])
      .where('poll_id', '=', pollId)
      .orderBy('position')
      .executeTakeFirstOrThrow()
    const bookingId = await fixtures.booking(
      s.organizationId,
      [s.member.id],
      slot.start_at.toISOString(),
      slot.end_at.toISOString(),
      { eventTypeId: s.eventTypeId },
    )
    await sql`UPDATE meeting_polls SET status = 'scheduled', chosen_slot_id = ${slot.id},
      booking_id = ${bookingId}, scheduled_at = clock_timestamp() WHERE id = ${pollId}`.execute(db)
    return bookingId
  }

  // --- Checks shared by the real module and its mutated source copies ---------------------

  async function verifyStaleRevision(M: PollModule) {
    const s = await team()
    const create = async () => (await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    const advance = (id: string) =>
      Polls.rotateMeetingPollLink(s.ownerCtx, {
        id,
        expectedHostRevision: 1,
        idempotencyKey: randomUUID(),
      })
    const operations: [string, (id: string) => Promise<unknown>][] = [
      ['close', (id) => M.closeMeetingPoll(s.ctx, { id, expectedHostRevision: 1 })],
      ['cancel', (id) => M.cancelMeetingPoll(s.ctx, { id, expectedHostRevision: 1 })],
      ['delete', (id) => M.deleteMeetingPoll(s.ctx, { id, expectedHostRevision: 1 })],
      [
        'rotate',
        (id) =>
          M.rotateMeetingPollLink(s.ctx, {
            id,
            expectedHostRevision: 1,
            idempotencyKey: randomUUID(),
          }),
      ],
    ]
    for (const [name, operation] of operations) {
      const poll = await create()
      await advance(poll.id)
      const before = await stored(poll.id)
      expect(await failure(() => operation(poll.id)), name).toMatchObject({ code: 'poll_changed' })
      expect(await stored(poll.id), name).toEqual(before)
      expect(before?.host_revision, name).toBe(2)
    }
  }

  async function verifyRevisionAdvances(M: PollModule) {
    const s = await team()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    expect(poll.hostRevision).toBe(1)
    const closed = await M.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })
    expect(closed.hostRevision).toBe(2)
    const rotated = await M.rotateMeetingPollLink(s.ctx, {
      id: poll.id,
      expectedHostRevision: 2,
      idempotencyKey: randomUUID(),
    })
    expect(rotated.poll.hostRevision).toBe(3)
    const canceled = await M.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 3 })
    expect(canceled.hostRevision).toBe(4)
    const row = await stored(poll.id)
    expect(row?.host_revision).toBe(4)
    // Host lifecycle never changes the voter-results snapshot revision.
    expect(row?.results_revision).toBe(1)
  }

  async function verifyNoReopening(M: PollModule) {
    const s = await team()
    const early = (await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    const closed = await M.closeMeetingPoll(s.ctx, { id: early.id, expectedHostRevision: 1 })
    expect(closed).toMatchObject({ status: 'closed', hostRevision: 2 })
    // Closed before its deadline, it still reads closed and stays closed after rotation.
    expect((await M.getMeetingPoll(s.ctx, early.id)).status).toBe('closed')
    await M.rotateMeetingPollLink(s.ctx, {
      id: early.id,
      expectedHostRevision: 2,
      idempotencyKey: randomUUID(),
    })
    expect((await M.getMeetingPoll(s.ctx, early.id)).status).toBe('closed')
    expect((await stored(early.id))?.status).toBe('closed')

    const canceled = (await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    await M.cancelMeetingPoll(s.ctx, { id: canceled.id, expectedHostRevision: 1 })
    expect(
      await failure(() => M.closeMeetingPoll(s.ctx, { id: canceled.id, expectedHostRevision: 2 })),
    ).toMatchObject({ code: 'poll_canceled' })
    expect((await stored(canceled.id))?.status).toBe('canceled')
    expect((await M.getMeetingPoll(s.ctx, canceled.id)).status).toBe('canceled')

    const booked = (await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    await scheduled(s, booked.id)
    for (const operation of [M.closeMeetingPoll, M.cancelMeetingPoll])
      expect(
        await failure(() => operation(s.ctx, { id: booked.id, expectedHostRevision: 1 })),
      ).toMatchObject({ code: 'poll_already_scheduled' })
    expect((await stored(booked.id))?.status).toBe('scheduled')
  }

  async function verifyPublicToken(M: PollModule) {
    const s = await team()
    const created = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const id = created.poll.id
    expect(created.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const first = (await stored(id))?.public_token_digest
    expect(first?.equals(Polls.meetingPollPublicTokenDigest(created.publicToken as string))).toBe(
      true,
    )
    await M.closeMeetingPoll(s.ctx, { id, expectedHostRevision: 1 })
    expect((await stored(id))?.public_token_digest?.equals(first as Buffer)).toBe(true)
    const rotated = await M.rotateMeetingPollLink(s.ctx, {
      id,
      expectedHostRevision: 2,
      idempotencyKey: randomUUID(),
    })
    expect(rotated.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(rotated.publicToken).not.toBe(created.publicToken)
    const second = (await stored(id))?.public_token_digest
    expect(second?.equals(Polls.meetingPollPublicTokenDigest(rotated.publicToken as string))).toBe(
      true,
    )
    await M.cancelMeetingPoll(s.ctx, { id, expectedHostRevision: 3 })
    expect((await stored(id))?.public_token_digest?.equals(second as Buffer)).toBe(true)
    // Rotation stays available after cancellation, so a leaked link can still be retired.
    const later = await M.rotateMeetingPollLink(s.ctx, {
      id,
      expectedHostRevision: 4,
      idempotencyKey: randomUUID(),
    })
    expect(
      (await stored(id))?.public_token_digest?.equals(
        Polls.meetingPollPublicTokenDigest(later.publicToken as string),
      ),
    ).toBe(true)

    const invited = await succeeds(async () =>
      M.createMeetingPoll(s.ctx, await input(s.eventTypeId, { admissionMode: 'invited' })),
    )
    expect(invited.publicToken).toBeNull()
    expect((await stored(invited.poll.id))?.public_token_digest).toBeNull()
    expect(
      await failure(() =>
        M.rotateMeetingPollLink(s.ctx, {
          id: invited.poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toMatchObject({ code: 'poll_link_unavailable' })
    const after = await stored(invited.poll.id)
    expect(after?.public_token_digest).toBeNull()
    expect(after?.host_revision).toBe(1)
  }

  async function verifyCreateReplay(M: PollModule) {
    const s = await team()
    const request = await input(s.eventTypeId)
    const { poll } = await M.createMeetingPoll(s.ctx, request)
    const before = await tableCounts()
    // A different session of the same user, with the candidates in another order.
    const replay = await failure(() =>
      M.createMeetingPoll(s.as(s.admin), {
        ...request,
        candidateStarts: [...request.candidateStarts].reverse(),
      }),
    )
    expect(replay).toEqual({
      name: 'DomainError',
      kind: 'conflict',
      code: 'poll_already_created',
      pollId: poll.id,
    })
    expect(
      await failure(() =>
        M.createMeetingPoll(s.ctx, {
          ...request,
          deadlineAt: Temporal.Instant.from(request.deadlineAt).add({ minutes: 1 }).toString(),
        }),
      ),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    expect(
      await failure(() => M.createMeetingPoll(s.ctx, { ...request, visibility: 'aggregate' })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    expect(await tableCounts()).toEqual(before)
  }

  async function verifyRotateReplay(M: PollModule) {
    const s = await team()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const request = { id: poll.id, expectedHostRevision: 1, idempotencyKey: randomUUID() }
    await M.rotateMeetingPollLink(s.ctx, request)
    const digest = (await stored(poll.id))?.public_token_digest
    // The revision advanced, yet the matching retry reports the rotation, not a conflict.
    expect(await failure(() => M.rotateMeetingPollLink(s.ctx, request))).toMatchObject({
      code: 'poll_link_already_rotated',
    })
    expect(
      await failure(() => M.rotateMeetingPollLink(s.ctx, { ...request, expectedHostRevision: 2 })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    const other = (await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    expect(
      await failure(() => M.rotateMeetingPollLink(s.ctx, { ...request, id: other.id })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    const row = await stored(poll.id)
    expect(row?.host_revision).toBe(2)
    expect(row?.public_token_digest?.equals(digest as Buffer)).toBe(true)
    expect((await stored(other.id))?.host_revision).toBe(1)
    expect(await receipts(poll.id, 'rotate_link')).toHaveLength(1)
  }

  async function verifyRoleAuthority(M: PollModule) {
    const s = await team()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    // An ordinary member who is also a configured host gains no poll administration.
    const memberCalls: (() => Promise<unknown>)[] = [
      async () => M.createMeetingPoll(s.memberCtx, await input(s.eventTypeId)),
      () => M.getMeetingPoll(s.memberCtx, poll.id),
      () => M.listMeetingPolls(s.memberCtx),
      () => M.closeMeetingPoll(s.memberCtx, { id: poll.id, expectedHostRevision: 1 }),
      () => M.cancelMeetingPoll(s.memberCtx, { id: poll.id, expectedHostRevision: 1 }),
      () => M.deleteMeetingPoll(s.memberCtx, { id: poll.id, expectedHostRevision: 1 }),
      () =>
        M.rotateMeetingPollLink(s.memberCtx, {
          id: poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
    ]
    for (const call of memberCalls)
      expect(await failure(call)).toMatchObject({
        kind: 'forbidden',
        code: 'team_management_access_denied',
      })
    expect((await stored(poll.id))?.host_revision).toBe(1)
    // A current owner manages polls an admin created.
    expect((await M.getMeetingPoll(s.ownerCtx, poll.id)).id).toBe(poll.id)
  }

  async function verifyTenant(M: PollModule) {
    const s = await team()
    const other = await team()
    const mine = await personal()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    for (const ctx of [other.ctx, mine.ctx]) {
      const calls: (() => Promise<unknown>)[] = [
        () => M.getMeetingPoll(ctx, poll.id),
        () => M.closeMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
        () => M.cancelMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
        () => M.deleteMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
        () =>
          M.rotateMeetingPollLink(ctx, {
            id: poll.id,
            expectedHostRevision: 1,
            idempotencyKey: randomUUID(),
          }),
      ]
      for (const call of calls)
        expect(await failure(call)).toMatchObject({ kind: 'not_found', code: 'poll_not_found' })
      expect((await M.listMeetingPolls(ctx)).data.map((p) => p.id)).not.toContain(poll.id)
      // Another tenant's event type cannot be named either.
      expect(
        await failure(async () => M.createMeetingPoll(ctx, await input(s.eventTypeId))),
      ).toMatchObject({ code: 'event_type_not_found' })
    }
    expect((await stored(poll.id))?.host_revision).toBe(1)
  }

  async function verifyContextHook(M: PollModule) {
    const s = await team()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const seen: (string | undefined)[][] = []
    const lost: ServiceContext = {
      ...s.ctx,
      authorizeOrganizationWrite: async (trx, organizationId, targetId) => {
        // Row locks assign a transaction ID; none may be held before the hook runs.
        const { rows } = await sql<{
          unlocked: boolean
        }>`SELECT pg_current_xact_id_if_assigned() IS NULL AS unlocked`.execute(trx)
        seen.push([organizationId, targetId, rows[0]?.unlocked ? 'first' : 'after locks'])
        throw new DomainError('conflict', 'organization_context_changed')
      },
    }
    const before = await stored(poll.id)
    const counts = await tableCounts()
    const request = await input(s.eventTypeId)
    const calls: (() => Promise<unknown>)[] = [
      () => M.createMeetingPoll(lost, request),
      () => M.closeMeetingPoll(lost, { id: poll.id, expectedHostRevision: 1 }),
      () => M.cancelMeetingPoll(lost, { id: poll.id, expectedHostRevision: 1 }),
      () => M.deleteMeetingPoll(lost, { id: poll.id, expectedHostRevision: 1 }),
      () =>
        M.rotateMeetingPollLink(lost, {
          id: poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
    ]
    for (const call of calls)
      expect(await failure(call)).toMatchObject({ code: 'organization_context_changed' })
    expect(seen).toEqual([
      [s.organizationId, s.eventTypeId, 'first'],
      [s.organizationId, undefined, 'first'],
      [s.organizationId, undefined, 'first'],
      [s.organizationId, undefined, 'first'],
      [s.organizationId, undefined, 'first'],
    ])
    expect(await stored(poll.id)).toEqual(before)
    expect(await tableCounts()).toEqual(counts)
  }

  async function verifyFixedSettings(M: PollModule) {
    const s = await team({
      title: 'Planning',
      questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }],
      allowGuests: true,
      location: { kind: 'in_person', address: 'Main office' },
    })
    const created = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const id = created.poll.id
    const fixed = await fixedSettings(id)
    // Change everything the voter consented to; the poll keeps its creation snapshot.
    await db
      .updateTable('event_types')
      .set({
        title: 'Renamed',
        duration_minutes: 45,
        allowed_durations_minutes: [45],
        questions: JSON.stringify([]),
        allow_guests: false,
        location: JSON.stringify({ kind: 'link', url: 'https://example.com/elsewhere' }),
        minimum_notice_minutes: 600,
      })
      .where('id', '=', s.eventTypeId)
      .execute()
    await db.deleteFrom('event_type_hosts').where('event_type_id', '=', s.eventTypeId).execute()
    await M.closeMeetingPoll(s.ctx, { id, expectedHostRevision: 1 })
    await M.rotateMeetingPollLink(s.ctx, {
      id,
      expectedHostRevision: 2,
      idempotencyKey: randomUUID(),
    })
    await M.cancelMeetingPoll(s.ctx, { id, expectedHostRevision: 3 })
    expect(await fixedSettings(id)).toEqual(fixed)
    const read = await M.getMeetingPoll(s.ctx, id)
    expect(read).toMatchObject({
      title: 'Planning',
      durationMinutes: 30,
      deadlineAt: created.poll.deadlineAt,
      admissionMode: 'public_link',
      visibility: 'private',
      displayTimeZone: 'Europe/Berlin',
      candidates: created.poll.candidates,
    })
  }

  async function verifyNoHolds(M: PollModule) {
    const s = await team({ maxBookingsPerDay: 1 })
    const before = await tableCounts()
    const { poll } = await succeeds(async () =>
      M.createMeetingPoll(s.ctx, await input(s.eventTypeId)),
    )
    const after = await tableCounts()
    const changedTables = Object.keys(after).filter((name) => after[name] !== before[name])
    expect(changedTables.sort()).toEqual([
      'public.meeting_poll_operations',
      'public.meeting_poll_slots',
      'public.meeting_polls',
    ])
    expect(poll.status).toBe('open')
    expect(await receipts(poll.id)).toHaveLength(1)
  }

  // --- Behaviour --------------------------------------------------------------------------

  it('creates an open public-link poll with a one-time link, sorted candidates and a snapshot', async () => {
    const s = await personal({
      title: 'Intro call',
      questions: [{ id: 'notes', label: 'Notes', type: 'short_text', required: false }],
      allowGuests: true,
    })
    await db
      .updateTable('event_types')
      .set({ zoom_connection_id: null, allowed_durations_minutes: [30, 60] })
      .where('id', '=', s.eventTypeId)
      .execute()
    const request = await input(s.eventTypeId, { durationMinutes: 60 })
    const { poll, publicToken } = await Polls.createMeetingPoll(s.ctx, request)
    const deadline = Temporal.Instant.from(request.deadlineAt)
    expect(poll).toMatchObject({
      organizationId: s.organizationId,
      eventTypeId: s.eventTypeId,
      title: 'Intro call',
      durationMinutes: 60,
      displayTimeZone: 'Europe/Berlin',
      admissionMode: 'public_link',
      visibility: 'private',
      deadlineAt: deadline.toString(),
      status: 'open',
      closedAt: null,
      canceledAt: null,
      scheduledAt: null,
      chosenSlotId: null,
      bookingId: null,
      hostRevision: 1,
      createdByUserId: s.user.id,
      source: 'web',
    })
    expect(
      poll.candidates.map(({ startAt, endAt, position }) => ({ startAt, endAt, position })),
    ).toEqual([
      {
        startAt: deadline.add({ hours: 25 }).toString(),
        endAt: deadline.add({ hours: 26 }).toString(),
        position: 0,
      },
      {
        startAt: deadline.add({ hours: 26 }).toString(),
        endAt: deadline.add({ hours: 27 }).toString(),
        position: 1,
      },
    ])
    const row = await stored(poll.id)
    expect(
      row?.public_token_digest?.equals(Polls.meetingPollPublicTokenDigest(publicToken as string)),
    ).toBe(true)
    const snapshot = {
      version: 1,
      title: 'Intro call',
      durationMinutes: 60,
      location: null,
      locations: null,
      questions: [{ id: 'notes', label: 'Notes', type: 'short_text', required: false }],
      schedulingType: 'individual',
      bookingMode: 'individual',
      hostUserIds: [s.user.id],
      allowGuests: true,
    }
    expect(row?.settings_snapshot).toEqual(snapshot)
    expect(row?.settings_fingerprint).toEqual(
      createHash('sha256')
        .update(`hourmere.meeting-poll.settings\0${canonicalJson(snapshot)}`)
        .digest(),
    )
    expect(await Polls.meetingPollEventSettings(db, s.eventTypeId, 60)).toEqual({
      snapshot,
      fingerprint: row?.settings_fingerprint,
    })
    // Reads and lists expose neither the capability nor any stored digest.
    const read = await Polls.getMeetingPoll(s.ctx, poll.id)
    expect(read).toEqual(poll)
    expect((await Polls.listMeetingPolls(s.ctx)).data).toEqual([poll])
    for (const value of [poll, read]) {
      const serialized = JSON.stringify(value)
      expect(serialized.includes(publicToken as string)).toBe(false)
      expect(serialized.includes(row?.public_token_digest?.toString('hex') ?? 'missing')).toBe(
        false,
      )
      expect(/digest|token|fingerprint|snapshot/i.test(serialized)).toBe(false)
    }
    const [receipt] = await receipts(poll.id)
    expect(receipt).toMatchObject({ operation: 'create', booking_id: null, purge_at: null })
    expect(JSON.stringify(receipt).includes(request.idempotencyKey)).toBe(false)
  })

  it('creates invited polls without a public capability and attributes API and agent sources', async () => {
    const s = await personal()
    const invited = await Polls.createMeetingPoll(
      s.ctx,
      await input(s.eventTypeId, { admissionMode: 'invited', visibility: 'aggregate' }),
    )
    expect(invited.publicToken).toBeNull()
    expect(invited.poll).toMatchObject({ admissionMode: 'invited', visibility: 'aggregate' })
    expect((await stored(invited.poll.id))?.public_token_digest).toBeNull()

    const oauth = testContext(db, {
      ...s.user.principal,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'client',
      scopes: ['mcp:tools'],
    })
    const agent = await Polls.createMeetingPoll(oauth, await input(s.eventTypeId))
    expect(agent.poll.source).toBe('mcp')
    expect((await stored(agent.poll.id))?.api_key_id).toBeNull()
  })

  async function verifyValidation(M: PollModule) {
    const s = await personal({ minimumNoticeMinutes: 120 })
    // Unrounded: creation reads the database clock later, so elapsed time only shrinks.
    const now = await databaseNow()
    // A whole hour, so that the accepted candidates sit on the event's slot grid.
    const deadline = now.round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({ hours: 24 })
    const at = (hours: number) => deadline.add({ hours }).toString()
    const state = await tableCounts()
    const cases: [Partial<Input>, string][] = [
      [{ candidateStarts: [at(3)] }, 'invalid_poll'],
      [{ candidateStarts: Array.from({ length: 21 }, (_, i) => at(3 + i)) }, 'poll_limit_exceeded'],
      [
        {
          candidateStarts: [at(3), deadline.add({ hours: 3 }).toString({ timeZone: 'Asia/Tokyo' })],
        },
        'invalid_poll',
      ],
      [{ candidateStarts: [at(3), '2026-12-01T10:00:00'] }, 'invalid_poll'],
      [{ candidateStarts: [at(3), 'not a time'] }, 'invalid_poll'],
      [{ candidateStarts: [at(1), at(3)] }, 'invalid_poll'],
      [{ candidateStarts: [at(0), at(3)] }, 'invalid_poll'],
      [{ candidateStarts: [at(-1), at(3)] }, 'invalid_poll'],
      [{ candidateStarts: [at(3), '9999-12-31T23:59:59.9999995Z'] }, 'invalid_poll'],
      [
        { deadlineAt: now.add({ minutes: 59 }).toString(), candidateStarts: [at(3), at(4)] },
        'invalid_poll',
      ],
      [
        {
          deadlineAt: now.add({ hours: 721 }).toString(),
          candidateStarts: [now.add({ hours: 730 }).toString(), now.add({ hours: 731 }).toString()],
        },
        'invalid_poll',
      ],
      [{ deadlineAt: '10000-01-01T00:00:00Z' }, 'invalid_poll'],
      [{ durationMinutes: 45 }, 'invalid_duration'],
      [{ durationMinutes: 0 }, 'invalid_duration'],
      [{ displayTimeZone: 'Mars/Base' }, 'invalid_time_zone'],
      [{ admissionMode: 'open' as never }, 'invalid_poll'],
      [{ visibility: 'named' as never }, 'invalid_poll'],
      [{ idempotencyKey: '' }, 'invalid_idempotency_key'],
      [{ idempotencyKey: undefined as never }, 'invalid_idempotency_key'],
      [{ token: 'one-time-link' } as never, 'poll_event_unsupported'],
      [{ hosts: [s.user.id] } as never, 'invalid_poll'],
      [{ eventTypeId: 'not-a-uuid' }, 'event_type_not_found'],
    ]
    for (const [override, code] of cases) {
      const request = {
        ...(await input(s.eventTypeId)),
        deadlineAt: deadline.toString(),
        ...override,
      }
      expect(
        await failure(() => M.createMeetingPoll(s.ctx, request)),
        JSON.stringify(override),
      ).toMatchObject({ code })
    }
    expect(await tableCounts()).toEqual(state)
    expect(
      (
        await succeeds(async () =>
          M.createMeetingPoll(
            s.ctx,
            await input(s.eventTypeId, {
              deadlineAt: deadline.toString(),
              candidateStarts: [at(2), at(3)],
            }),
          ),
        )
      ).poll.status,
    ).toBe('open')

    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(
      await failure(async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
    ).toMatchObject({
      code: 'event_type_inactive',
    })
    await db
      .updateTable('event_types')
      .set({ is_active: true, deleted_at: new Date() })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(
      await failure(async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
    ).toMatchObject({
      code: 'event_type_not_found',
    })
    const group = await personal()
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 5 })
      .where('id', '=', group.eventTypeId)
      .execute()
    expect(
      await failure(async () => M.createMeetingPoll(group.ctx, await input(group.eventTypeId))),
    ).toMatchObject({
      code: 'poll_event_unsupported',
    })
  }

  /**
   * Exact inclusive bounds, through a source copy whose only change lets the test pin the
   * creation instant (every other copy in this file carries the same pin).
   */
  async function verifyBounds(M: PollModule) {
    const noticed = await personal({ minimumNoticeMinutes: 120 })
    const immediate = await personal()
    // A whole hour, so every accepted candidate sits on the slot grid.
    const pinned = (await databaseNow()).round({ smallestUnit: 'hour', roundingMode: 'floor' })
    const clock = globalThis as { meetingPollClock?: string }
    clock.meetingPollClock = pinned.toString()
    try {
      const µs = { microseconds: 1 }
      const attempt = async (
        s: Awaited<ReturnType<typeof personal>>,
        deadline: Temporal.Instant,
        earliest: Temporal.Instant,
      ) =>
        M.createMeetingPoll(s.ctx, {
          ...(await input(s.eventTypeId)),
          deadlineAt: deadline.toString(),
          candidateStarts: [earliest.toString(), earliest.add({ hours: 1 }).toString()],
        })
      const min = pinned.add({ hours: 1 })
      const max = pinned.add({ hours: 720 })
      const accepted: [Awaited<ReturnType<typeof personal>>, Temporal.Instant, Temporal.Instant][] =
        [
          [noticed, min, min.add({ hours: 2 })],
          [noticed, max, max.add({ hours: 2 })],
          [immediate, min.add({ hours: 1 }).subtract(µs), min.add({ hours: 1 })],
        ]
      for (const [s, deadline, earliest] of accepted) {
        const { poll } = await succeeds(() => attempt(s, deadline, earliest))
        expect(poll.createdAt).toBe(pinned.toString())
        expect(poll.deadlineAt).toBe(deadline.toString())
      }
      const rejected: [Awaited<ReturnType<typeof personal>>, Temporal.Instant, Temporal.Instant][] =
        [
          [noticed, min.subtract(µs), min.add({ hours: 2 })],
          [noticed, max.add(µs), max.add({ hours: 2 })],
          [noticed, min, min.add({ hours: 2 }).subtract(µs)],
          [immediate, min, min],
        ]
      for (const [s, deadline, earliest] of rejected)
        expect(await failure(() => attempt(s, deadline, earliest))).toMatchObject({
          code: 'invalid_poll',
        })
    } finally {
      delete clock.meetingPollClock
    }
  }

  it('validates candidates, deadlines, durations and unsupported event modes before writing', async () => {
    await verifyValidation(Polls)
  })

  it('accepts both inclusive deadline bounds and the exact minimum notice, and nothing beyond', async () => {
    await verifyBounds(await sourceCopy(PIN_CLOCK))
  })

  it('normalizes instants to database microseconds before storing and fingerprinting', async () => {
    const s = await personal()
    const request = await input(s.eventTypeId)
    // Sub-microsecond, so the stored value is the whole hour on the slot grid.
    const precise = Temporal.Instant.from(request.candidateStarts[0] as string).add({
      nanoseconds: 400,
    })
    const offset = Temporal.Instant.from(request.candidateStarts[1] as string).toString({
      timeZone: 'America/New_York',
    })
    const { rows } = await sql<{
      value: string
    }>`SELECT to_char(${precise.toString()}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`.execute(
      db,
    )
    const rounded = Temporal.Instant.from(rows[0]?.value as string)
    expect(rounded.epochNanoseconds % 1000n).toBe(0n)
    expect(rounded.equals(precise)).toBe(false)
    expect(rounded.toString()).toBe(request.candidateStarts[0])
    const { poll } = await Polls.createMeetingPoll(s.ctx, {
      ...request,
      candidateStarts: [precise.toString(), offset],
    })
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual([
      Temporal.Instant.from(offset).toString(),
      rounded.toString(),
    ])
    expect(poll.candidates[1]?.endAt).toBe(rounded.add({ minutes: 30 }).toString())
    // A retry naming the stored values is the same request.
    expect(
      await failure(() =>
        Polls.createMeetingPoll(s.ctx, {
          ...request,
          candidateStarts: [rounded.toString(), Temporal.Instant.from(offset).toString()],
        }),
      ),
    ).toMatchObject({ code: 'poll_already_created', pollId: poll.id })
    // Two inputs that round to one stored instant are duplicates.
    expect(
      await failure(async () =>
        Polls.createMeetingPoll(s.ctx, {
          ...(await input(s.eventTypeId)),
          candidateStarts: [precise.toString(), rounded.toString()],
        }),
      ),
    ).toMatchObject({ code: 'invalid_poll' })
  })

  it('creates no booking, hold, calendar, delivery or job rows', async () => {
    await verifyNoHolds(Polls)
  })

  it('reads and lists only polls of managed events, newest first with a cursor', async () => {
    const s = await team()
    const other = await team()
    const created = []
    for (let i = 0; i < 3; i++)
      created.push((await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll)
    await Polls.createMeetingPoll(other.ctx, await input(other.eventTypeId))
    const first = await Polls.listMeetingPolls(s.ownerCtx, { limit: 2 })
    expect(first.data.map((poll) => poll.id)).toEqual([created[2]?.id, created[1]?.id])
    expect(first.nextAfter).toEqual(expect.any(String))
    const second = await Polls.listMeetingPolls(s.ownerCtx, {
      limit: 2,
      after: first.nextAfter as string,
    })
    expect(second).toEqual({ data: [created[0]], nextAfter: null })
    for (const [options, code] of [
      [{ limit: 0 }, 'invalid_limit'],
      [{ limit: 101 }, 'invalid_limit'],
      [{ after: 'nope' }, 'invalid_cursor'],
      [
        { after: Buffer.from(JSON.stringify(['x', randomUUID()])).toString('base64url') },
        'invalid_cursor',
      ],
    ] as const)
      expect(await failure(() => Polls.listMeetingPolls(s.ctx, options))).toMatchObject({ code })
    expect(await failure(() => Polls.getMeetingPoll(s.ctx, 'not-a-uuid'))).toMatchObject({
      code: 'poll_not_found',
    })
    expect(await failure(() => Polls.getMeetingPoll(s.ctx, randomUUID()))).toMatchObject({
      code: 'poll_not_found',
    })
  })

  it('refuses other tenants with poll_not_found', async () => {
    await verifyTenant(Polls)
  })

  it('refuses ordinary members and configured hosts and lets current owners manage', async () => {
    await verifyRoleAuthority(Polls)
  })

  async function verifyAuthorityLoss(M: PollModule) {
    const s = await team()
    const request = await input(s.eventTypeId)
    const { poll } = await succeeds(() => M.createMeetingPoll(s.ctx, request))
    const rotation = { id: poll.id, expectedHostRevision: 1, idempotencyKey: randomUUID() }
    await succeeds(() => M.rotateMeetingPollLink(s.ctx, rotation))
    const operations = (ctx: ServiceContext): (() => Promise<unknown>)[] => [
      () => M.createMeetingPoll(ctx, request),
      () => M.rotateMeetingPollLink(ctx, rotation),
      () => M.getMeetingPoll(ctx, poll.id),
      () => M.listMeetingPolls(ctx),
      () => M.closeMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 2 }),
      () => M.cancelMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 2 }),
      () => M.deleteMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 2 }),
      () =>
        M.rotateMeetingPollLink(ctx, {
          ...rotation,
          expectedHostRevision: 2,
          idempotencyKey: randomUUID(),
        }),
    ]
    const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
    // Demotion: the creator's attribution is not enduring authority, even for its replays.
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', s.organizationId)
      .where('userId', '=', s.admin.id)
      .execute()
    for (const call of operations(s.ctx)) expect(await failure(call)).toMatchObject(denied)
    // Departure.
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.organizationId)
      .where('userId', '=', s.admin.id)
      .execute()
    for (const call of operations(s.ctx)) expect(await failure(call)).toMatchObject(denied)
    // A current owner who lost mailbox verification.
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.owner.id)
      .execute()
    for (const call of operations(s.ownerCtx)) expect(await failure(call)).toMatchObject(denied)
    // A member row planted in somebody else's personal space grants nothing there.
    const stranger = await personal()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: stranger.organizationId,
        userId: s.member.id,
        role: 'owner',
        createdAt: new Date(),
      })
      .execute()
    const intruder = testContext(
      db,
      session({ ...s.member.principal, organization: stranger.user.principal.organization }),
    )
    const theirs = await succeeds(async () =>
      M.createMeetingPoll(stranger.ctx, await input(stranger.eventTypeId)),
    )
    for (const call of [
      ...operations(intruder),
      async () => M.createMeetingPoll(intruder, await input(stranger.eventTypeId)),
      () => M.getMeetingPoll(intruder, theirs.poll.id),
    ])
      expect(await failure(call)).toMatchObject(denied)
    const row = await stored(poll.id)
    expect(row?.host_revision).toBe(2)
    expect(await receipts(poll.id)).toHaveLength(2)
  }

  it('rechecks role, membership and verification on every read, write and replay', async () => {
    await verifyAuthorityLoss(Polls)
  })

  it('runs the organization context hook first and writes nothing when the context changed', async () => {
    await verifyContextHook(Polls)
  })

  /** A real, enabled API key of a personal-space user, as the caller resolver would bind it. */
  async function apiKey(
    s: Awaited<ReturnType<typeof personal>>,
    scope: 'full' | 'read' | 'bookings',
  ) {
    const row = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: s.user.id,
        key: createHash('sha256').update(randomUUID()).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope, organizationId: s.organizationId }),
        enabled: true,
        expiresAt: null,
        lastRefillAt: null,
        lastRequest: null,
        name: null,
        permissions: null,
        prefix: null,
        rateLimitEnabled: false,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: null,
        start: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      id: row.id,
      ctx: testContext(db, {
        kind: 'api_key',
        apiKeyId: row.id,
        apiKeyScope: scope,
        user: s.user.principal.user,
        organization: s.user.principal.organization,
      }),
    }
  }

  /** An OAuth grant of the same user; the transport has already validated the consent. */
  function oauthGrant(s: Awaited<ReturnType<typeof personal>>) {
    return testContext(db, {
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'mcp-client',
      scopes: ['mcp:tools'],
      user: s.user.principal.user,
      organization: s.user.principal.organization,
    })
  }

  /**
   * One user's API keys and OAuth grants are separate replay scopes: reusing another
   * credential's idempotency key is a fresh operation, never that credential's replay.
   */
  async function verifyActorIsolation(M: PollModule) {
    const s = await personal()
    const actors = [
      (await apiKey(s, 'bookings')).ctx,
      (await apiKey(s, 'full')).ctx,
      oauthGrant(s),
      oauthGrant(s),
    ]
    const request = await input(s.eventTypeId)
    const created: string[] = []
    for (const ctx of actors)
      created.push((await succeeds(() => M.createMeetingPoll(ctx, request))).poll.id)
    expect(new Set(created).size).toBe(actors.length)
    // Each credential still replays its own creation.
    for (const [index, ctx] of actors.entries())
      expect(await failure(() => M.createMeetingPoll(ctx, request))).toMatchObject({
        code: 'poll_already_created',
        pollId: created[index],
      })

    const id = created[0] as string
    const rotation = { id, expectedHostRevision: 1, idempotencyKey: randomUUID() }
    await succeeds(() => M.rotateMeetingPollLink(actors[0] as ServiceContext, rotation))
    // The same key and request from another credential is a fresh, now stale, rotation.
    for (const ctx of actors.slice(1))
      expect(await failure(() => M.rotateMeetingPollLink(ctx, rotation))).toMatchObject({
        code: 'poll_changed',
      })
    // With a current revision, each other credential's same key rotates the link again.
    for (const [index, ctx] of actors.slice(1).entries()) {
      const rotated = await succeeds(() =>
        M.rotateMeetingPollLink(ctx, { ...rotation, expectedHostRevision: index + 2 }),
      )
      expect(rotated.poll.hostRevision).toBe(index + 3)
      expect(rotated.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    }
    expect(
      await failure(() => M.rotateMeetingPollLink(actors[0] as ServiceContext, rotation)),
    ).toMatchObject({
      code: 'poll_link_already_rotated',
    })
    expect(await receipts(id, 'rotate_link')).toHaveLength(actors.length)
  }

  it('keeps API-key and OAuth-grant receipts apart for one user', async () => {
    await verifyActorIsolation(Polls)
  })

  async function verifyApiKeys(M: PollModule) {
    const s = await personal()
    const key = (scope: 'full' | 'read' | 'bookings') => apiKey(s, scope)
    const bookings = await key('bookings')
    const created = await succeeds(async () =>
      M.createMeetingPoll(bookings.ctx, await input(s.eventTypeId), { source: 'mcp' }),
    )
    expect(created.poll.source).toBe('mcp')
    expect((await stored(created.poll.id))?.api_key_id).toBe(bookings.id)
    const read = await key('read')
    expect((await succeeds(() => M.getMeetingPoll(read.ctx, created.poll.id))).id).toBe(
      created.poll.id,
    )
    const writes: (() => Promise<unknown>)[] = [
      async () => M.createMeetingPoll(read.ctx, await input(s.eventTypeId)),
      () => M.closeMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () => M.cancelMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () => M.deleteMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () =>
        M.rotateMeetingPollLink(read.ctx, {
          id: created.poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
    ]
    for (const call of writes) expect((await failure(call)).name).toBe('ApiKeyScopeError')
    await db
      .updateTable('auth.apikey')
      .set({ enabled: false })
      .where('id', '=', bookings.id)
      .execute()
    expect((await failure(() => M.getMeetingPoll(bookings.ctx, created.poll.id))).name).toBe(
      'InvalidApiKeyError',
    )
    expect(
      (
        await failure(() =>
          M.closeMeetingPoll(bookings.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
        )
      ).name,
    ).toBe('InvalidApiKeyError')
    expect((await stored(created.poll.id))?.host_revision).toBe(1)
  }

  it('enforces API-key scope and live key state', async () => {
    await verifyApiKeys(Polls)
  })

  async function verifyRepeats(M: PollModule) {
    const s = await team()
    const { poll } = await succeeds(async () =>
      M.createMeetingPoll(s.ctx, await input(s.eventTypeId)),
    )
    const closed = await succeeds(() =>
      M.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 }),
    )
    expect(closed).toMatchObject({
      status: 'closed',
      hostRevision: 2,
      closedAt: expect.any(String),
    })
    expect(closed.updatedAt).toBe(closed.closedAt)
    // A repeat returns the current state before the revision check and writes nothing.
    const before = await stored(poll.id)
    expect(
      await succeeds(() => M.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })),
    ).toEqual(closed)
    expect(await stored(poll.id)).toEqual(before)
    const canceled = await succeeds(() =>
      M.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 2 }),
    )
    expect(canceled).toMatchObject({
      status: 'canceled',
      hostRevision: 3,
      closedAt: closed.closedAt,
    })
    const afterCancel = await stored(poll.id)
    expect(
      await succeeds(() => M.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })),
    ).toEqual(canceled)
    expect(await stored(poll.id)).toEqual(afterCancel)

    const open = (
      await succeeds(async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId)))
    ).poll
    expect(
      await succeeds(() => M.cancelMeetingPoll(s.ctx, { id: open.id, expectedHostRevision: 1 })),
    ).toMatchObject({
      status: 'canceled',
      closedAt: null,
      canceledAt: expect.any(String),
    })

    for (const expectedHostRevision of [0, 1.5, Number.NaN, '1' as never])
      expect(
        await failure(() => M.closeMeetingPoll(s.ctx, { id: open.id, expectedHostRevision })),
      ).toMatchObject({
        code: 'invalid_poll',
      })

    await succeeds(() => M.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 3 }))
    expect(await stored(poll.id)).toBeUndefined()
    expect(
      await db
        .selectFrom('meeting_poll_slots')
        .select('id')
        .where('poll_id', '=', poll.id)
        .execute(),
    ).toEqual([])
    expect(
      await failure(() => M.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 3 })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
  }

  it('closes, cancels and deletes with idempotent repeats and current state', async () => {
    await verifyRepeats(Polls)
  })

  async function verifyDeadlineClosure(M: PollModule) {
    const s = await team()
    const { poll } = await succeeds(async () =>
      M.createMeetingPoll(s.ctx, await input(s.eventTypeId)),
    )
    await sql`UPDATE meeting_polls SET created_at = clock_timestamp() - interval '3 hours',
      deadline_at = date_trunc('second', clock_timestamp()) - interval '1 hour' WHERE id = ${poll.id}`.execute(
      db,
    )
    const deadline = await db
      .selectFrom('meeting_polls')
      .select(
        sql<string>`to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as('at'),
      )
      .where('id', '=', poll.id)
      .executeTakeFirstOrThrow()
    const expected = Temporal.Instant.from(deadline.at).toString()
    const read = await succeeds(() => M.getMeetingPoll(s.ctx, poll.id))
    expect(read).toMatchObject({
      status: 'closed',
      closedAt: expected,
      deadlineAt: expected,
      hostRevision: 1,
    })
    expect((await succeeds(() => M.listMeetingPolls(s.ctx))).data[0]).toEqual(read)
    // Closing again is a repeat: no write, no revision check.
    expect(
      await succeeds(() => M.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 7 })),
    ).toEqual(read)
    expect(await stored(poll.id)).toMatchObject({
      status: 'open',
      closed_at: null,
      host_revision: 1,
    })
    // Cancellation records the closure that already happened at the deadline.
    const canceled = await succeeds(() =>
      M.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 }),
    )
    expect(canceled).toMatchObject({ status: 'canceled', hostRevision: 2, closedAt: expected })
    expect((await stored(poll.id))?.closed_at?.toISOString()).toBe(new Date(expected).toISOString())
  }

  it('derives deadline closure from the database clock without a host revision change', async () => {
    await verifyDeadlineClosure(Polls)
  })

  it('never reopens closed, canceled or scheduled polls', async () => {
    await verifyNoReopening(Polls)
  })

  it('advances the host revision on accepted host writes only', async () => {
    await verifyRevisionAdvances(Polls)
  })

  it('refuses a stale expectedHostRevision on close, cancel, delete and rotate-link', async () => {
    await verifyStaleRevision(Polls)
  })

  it('keeps every creation setting fixed through lifecycle writes and event edits', async () => {
    await verifyFixedSettings(Polls)
  })

  it('keeps a public token on public-link polls and none on invited polls', async () => {
    await verifyPublicToken(Polls)
  })

  it('deletes scheduled polls without their booking and keeps only pseudonymous receipts', async () => {
    const s = await team()
    const { poll } = await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    await Polls.rotateMeetingPollLink(s.ctx, {
      id: poll.id,
      expectedHostRevision: 1,
      idempotencyKey: randomUUID(),
    })
    const bookingId = await scheduled(s, poll.id)
    const anonymous = await receipts(poll.id)
    expect(anonymous).toHaveLength(2)
    await Polls.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 2 })
    expect(await stored(poll.id)).toBeUndefined()
    expect(
      await db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', bookingId)
        .executeTakeFirst(),
    ).toEqual({
      status: 'confirmed',
    })
    const retained = await db
      .selectFrom('meeting_poll_operations')
      .selectAll()
      .where(
        'id',
        'in',
        anonymous.map((receipt) => receipt.id),
      )
      .execute()
    expect(retained).toHaveLength(2)
    for (const receipt of retained)
      expect(receipt).toMatchObject({ poll_id: null, booking_id: null, purge_at: expect.any(Date) })
  })

  it('replays creation exactly once per actor scope and conflicts on a changed request', async () => {
    await verifyCreateReplay(Polls)
    const s = await team()
    const request = await input(s.eventTypeId)
    const { poll } = await Polls.createMeetingPoll(s.ctx, request)
    // A different actor using the same key creates its own poll.
    const owners = await Polls.createMeetingPoll(s.ownerCtx, request)
    expect(owners.poll.id).not.toBe(poll.id)
    // Replays precede event-state checks, so a lost response stays recoverable.
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(await failure(() => Polls.createMeetingPoll(s.ctx, request))).toMatchObject({
      code: 'poll_already_created',
      pollId: poll.id,
    })
    // After deletion the tombstone still deduplicates, without naming the poll.
    await Polls.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })
    expect(await failure(() => Polls.createMeetingPoll(s.ctx, request))).toMatchObject({
      code: 'poll_already_created',
      pollId: null,
    })
    expect(
      await failure(() => Polls.createMeetingPoll(s.ctx, { ...request, admissionMode: 'invited' })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
  })

  async function verifyCreateRace(M: PollModule) {
    const s = await team()
    const request = await input(s.eventTypeId)
    // Both creators pass authority; one queues on the event row, the other on its hosts.
    const results = await queuedBehind(
      (trx) =>
        trx
          .selectFrom('event_types')
          .select('id')
          .where('id', '=', s.eventTypeId)
          .forUpdate()
          .execute(),
      () => M.createMeetingPoll(s.ctx, request),
      () => M.createMeetingPoll(s.as(s.admin), request),
    )
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.poll.id] : [],
    )
    expect(created).toHaveLength(1)
    const loser = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect({ code: loser?.reason?.code, pollId: loser?.reason?.pollId }).toEqual({
      code: 'poll_already_created',
      pollId: created[0],
    })
    expect(
      await db
        .selectFrom('meeting_polls')
        .select('id')
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toHaveLength(1)

    // Events with different hosts share no booking lock, so only the receipt lock orders
    // one key reused for another event: the loser conflicts instead of failing on storage.
    const elsewhere = await fixtures.eventType(s.organizationId, null, {
      hosts: [{ userId: s.owner.id }],
    })
    const key = randomUUID()
    const reused = await queuedBehind(
      (trx) =>
        trx
          .selectFrom('event_types')
          .select('id')
          .where('id', 'in', [s.eventTypeId, elsewhere])
          .forUpdate()
          .execute(),
      async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId, { idempotencyKey: key })),
      async () => M.createMeetingPoll(s.ctx, await input(elsewhere, { idempotencyKey: key })),
    )
    expect(reused.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(
      (reused.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason?.code,
    ).toBe('idempotency_key_reused')
  }

  it('serializes two concurrent creations with one key into one poll', async () => {
    await verifyCreateRace(Polls)
  })

  it('replays rotation as a safe conflict and conflicts on a changed request', async () => {
    await verifyRotateReplay(Polls)
  })

  // --- Concurrency ------------------------------------------------------------------------

  /** Hold the poll row, queue `first` then `second` on it, then release them in that order. */
  function queued<A, B>(pollId: string, first: () => Promise<A>, second: () => Promise<B>) {
    return queuedBehind(
      (trx) =>
        trx.selectFrom('meeting_polls').select('id').where('id', '=', pollId).forUpdate().execute(),
      first,
      second,
    )
  }

  /** Hold a lock, queue `first` then `second` behind it, then release them. */
  async function queuedBehind<A, B>(
    hold: (trx: Db) => Promise<unknown>,
    first: () => Promise<A>,
    second: () => Promise<B>,
  ) {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = db.transaction().execute(async (trx) => {
      await hold(trx)
      locked.resolve()
      await release.promise
    })
    await locked.promise
    const waiting = async (count: number) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const { rows } = await sql<{
          count: string
        }>`SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db)
        if (Number(rows[0]?.count) >= count) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`expected ${count} lock waiters`)
    }
    let a: Promise<A> | undefined
    let b: Promise<B> | undefined
    try {
      a = first()
      a.catch(() => undefined)
      await waiting(1)
      b = second()
      b.catch(() => undefined)
      await waiting(2)
    } finally {
      release.resolve()
      await blocker
    }
    return Promise.allSettled([a as Promise<A>, b as Promise<B>])
  }

  const reason = (result: PromiseSettledResult<unknown>) =>
    result.status === 'rejected' ? { code: (result.reason as DomainError).code } : 'fulfilled'

  it('lets exactly one of close and cancel win, with the documented conflict for the other', async () => {
    const s = await team()
    const one = (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    const closeFirst = await queued(
      one.id,
      () => Polls.closeMeetingPoll(s.ctx, { id: one.id, expectedHostRevision: 1 }),
      () => Polls.cancelMeetingPoll(s.ownerCtx, { id: one.id, expectedHostRevision: 1 }),
    )
    expect(closeFirst.map(reason)).toEqual(['fulfilled', { code: 'poll_changed' }])
    expect(await stored(one.id)).toMatchObject({ status: 'closed', host_revision: 2 })

    const two = (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    const cancelFirst = await queued(
      two.id,
      () => Polls.cancelMeetingPoll(s.ownerCtx, { id: two.id, expectedHostRevision: 1 }),
      () => Polls.closeMeetingPoll(s.ctx, { id: two.id, expectedHostRevision: 1 }),
    )
    expect(cancelFirst.map(reason)).toEqual(['fulfilled', { code: 'poll_canceled' }])
    expect(await stored(two.id)).toMatchObject({
      status: 'canceled',
      host_revision: 2,
      closed_at: null,
    })

    for (let round = 0; round < 3; round++) {
      const poll = (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
      const results = await Promise.allSettled([
        Polls.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 }),
        Polls.cancelMeetingPoll(s.ownerCtx, { id: poll.id, expectedHostRevision: 1 }),
      ])
      const outcome = results.map(reason)
      const row = await stored(poll.id)
      expect(row?.host_revision).toBe(2)
      expect(outcome).toEqual(
        row?.status === 'closed'
          ? ['fulfilled', { code: 'poll_changed' }]
          : [{ code: 'poll_canceled' }, 'fulfilled'],
      )
    }
  })

  it('lets exactly one of rotate-link and delete win, with the documented conflict for the other', async () => {
    const s = await team()
    const one = await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const rotateFirst = await queued(
      one.poll.id,
      () =>
        Polls.rotateMeetingPollLink(s.ctx, {
          id: one.poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      () => Polls.deleteMeetingPoll(s.ownerCtx, { id: one.poll.id, expectedHostRevision: 1 }),
    )
    expect(rotateFirst.map(reason)).toEqual(['fulfilled', { code: 'poll_changed' }])
    const rotated = (rotateFirst[0] as PromiseFulfilledResult<Polls.MeetingPollWithLink>).value
    expect(
      (await stored(one.poll.id))?.public_token_digest?.equals(
        Polls.meetingPollPublicTokenDigest(rotated.publicToken as string),
      ),
    ).toBe(true)

    const two = await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const deleteFirst = await queued(
      two.poll.id,
      () => Polls.deleteMeetingPoll(s.ownerCtx, { id: two.poll.id, expectedHostRevision: 1 }),
      () =>
        Polls.rotateMeetingPollLink(s.ctx, {
          id: two.poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
    )
    expect(deleteFirst.map(reason)).toEqual(['fulfilled', { code: 'poll_not_found' }])
    expect(await stored(two.poll.id)).toBeUndefined()
    const tombstones = await db
      .selectFrom('meeting_poll_operations')
      .select('operation')
      .where('poll_id', 'is', null)
      .where(
        'actor_scope_digest',
        '=',
        (await receipts(one.poll.id, 'create'))[0]?.actor_scope_digest as Buffer,
      )
      .execute()
    expect(tombstones.map((row) => row.operation)).toEqual(['create'])

    for (let round = 0; round < 3; round++) {
      const poll = (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
      const results = await Promise.allSettled([
        Polls.rotateMeetingPollLink(s.ctx, {
          id: poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
        Polls.deleteMeetingPoll(s.ownerCtx, { id: poll.id, expectedHostRevision: 1 }),
      ])
      const row = await stored(poll.id)
      expect(results.map(reason)).toEqual(
        row ? ['fulfilled', { code: 'poll_changed' }] : [{ code: 'poll_not_found' }, 'fulfilled'],
      )
      if (row) expect(row.host_revision).toBe(2)
    }
  })

  // --- Availability at creation -----------------------------------------------------------

  /** Refused with every unbookable start, in order, and nothing written for the event. */
  async function refused(operation: Promise<unknown>, eventTypeId: string, starts: string[]) {
    expect(await failure(() => operation)).toMatchObject({
      kind: 'conflict',
      code: 'slot_unavailable',
      unavailableStarts: starts,
    })
    expect(await pollsOf(eventTypeId)).toEqual([])
  }

  /** Weekly hours and date overrides in the host's zone, not the poll's display zone. */
  async function verifyWorkingHours(M: PollModule) {
    const zone = 'Europe/Berlin'
    let monday = Temporal.Now.plainDateISO(zone).add({ days: 3 })
    while (monday.dayOfWeek !== 1) monday = monday.add({ days: 1 })
    const day = (offset: number) => monday.add({ days: offset })
    const at = (date: Temporal.PlainDate, time: string) =>
      date
        .toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(time) })
        .toInstant()
        .toString()
    const s = await personal(
      {},
      {
        timeZone: zone,
        weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
        overrides: [
          { date: day(1).toString(), intervals: [] },
          { date: day(5).toString(), intervals: [{ start: '10:00', end: '12:00' }] },
        ],
      },
    )
    const early = at(day(0), '08:30')
    const late = at(day(0), '17:00')
    const closedTuesday = at(day(1), '10:00')
    const sundayNight = at(day(6), '03:00')
    const open = [at(day(0), '10:00'), at(day(0), '16:30'), at(day(5), '10:00')]
    await refused(
      propose(M, s.ctx, s.eventTypeId, [...open, early, late, closedTuesday, sundayNight]),
      s.eventTypeId,
      [early, late, closedTuesday, sundayNight],
    )
    const { poll } = await succeeds(() => propose(M, s.ctx, s.eventTypeId, open))
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual(open)
  }

  /** Confirmed bookings of this or another event type and calendar busy time all block. */
  async function verifyBusyTime(M: PollModule) {
    const s = await personal()
    const host = [s.user.id]
    const other = await fixtures.eventType(s.organizationId, s.user.id)
    const { deadline, starts } = await hourly(5)
    const [free, sameEvent, otherEvent, calendar, canceled] = starts as [
      string,
      string,
      string,
      string,
      string,
    ]
    await book(db, s.organizationId, host, sameEvent, { eventTypeId: s.eventTypeId })
    await book(db, s.organizationId, host, otherEvent, { eventTypeId: other })
    await fixtures.calendarBusy(s.user.id, [
      [calendar, Temporal.Instant.from(calendar).add({ minutes: 30 }).toString()],
    ])
    await book(db, s.organizationId, host, canceled, {
      eventTypeId: s.eventTypeId,
      status: 'cancelled',
    })
    // The earliest candidate is free, so checking only the first one would accept these.
    await refused(propose(M, s.ctx, s.eventTypeId, starts, deadline), s.eventTypeId, [
      sameEvent,
      otherEvent,
      calendar,
    ])
    await succeeds(() => propose(M, s.ctx, s.eventTypeId, [free, canceled], deadline))
  }

  /** A live payment hold blocks its time like a booking; an expired one does not. */
  async function verifyHolds(M: PollModule) {
    const s = await personal()
    const { deadline, starts } = await hourly(3)
    const [free, held, expired] = starts as [string, string, string]
    await book(db, s.organizationId, [s.user.id], held, {
      eventTypeId: s.eventTypeId,
      status: 'pending_payment',
      holdExpiresAt: held,
    })
    await book(db, s.organizationId, [s.user.id], expired, {
      eventTypeId: s.eventTypeId,
      status: 'pending_payment',
      holdExpiresAt: (await databaseNow()).subtract({ minutes: 1 }).toString(),
    })
    await refused(propose(M, s.ctx, s.eventTypeId, starts, deadline), s.eventTypeId, [held])
    await succeeds(() => propose(M, s.ctx, s.eventTypeId, [free, expired], deadline))
  }

  /** Minimum notice, buffers, the booking window and booking limits apply as when booking. */
  async function verifyEventRules(M: PollModule) {
    // The deadline rule (candidate at least the notice after the deadline) is stricter than
    // the engine's (the notice after now), so a candidate inside the notice is refused first.
    const noticed = await personal({ minimumNoticeMinutes: 180 })
    const deadline = await nextDeadline()
    const after = (hours: number, minutes = 0) => deadline.add({ hours, minutes }).toString()
    expect(
      await failure(() =>
        propose(M, noticed.ctx, noticed.eventTypeId, [after(2), after(5)], deadline),
      ),
    ).toMatchObject({ code: 'invalid_poll' })
    expect(await pollsOf(noticed.eventTypeId)).toEqual([])
    await succeeds(() =>
      propose(M, noticed.ctx, noticed.eventTypeId, [after(3), after(5)], deadline),
    )

    const buffered = await personal({ bufferAfterMinutes: 30, bookingWindowDays: 10 })
    const booked = after(25)
    await book(db, buffered.organizationId, [buffered.user.id], booked, {
      eventTypeId: buffered.eventTypeId,
    })
    const insideBuffer = after(25, 30)
    const beyondWindow = after(24 * 12)
    await refused(
      propose(
        M,
        buffered.ctx,
        buffered.eventTypeId,
        [after(27), insideBuffer, beyondWindow],
        deadline,
      ),
      buffered.eventTypeId,
      [insideBuffer, beyondWindow],
    )
    await succeeds(() =>
      propose(M, buffered.ctx, buffered.eventTypeId, [after(26), after(24 * 7)], deadline),
    )

    const limited = await personal({ maxBookingsPerDay: 1 })
    const dayStart = deadline.toZonedDateTimeISO('UTC').startOfDay().add({ days: 3 }).toInstant()
    await book(
      db,
      limited.organizationId,
      [limited.user.id],
      dayStart.add({ hours: 8 }).toString(),
      {
        eventTypeId: limited.eventTypeId,
      },
    )
    const sameDay = dayStart.add({ hours: 14 }).toString()
    const nextDay = dayStart.add({ hours: 38 }).toString()
    await refused(
      propose(M, limited.ctx, limited.eventTypeId, [sameDay, nextDay], deadline),
      limited.eventTypeId,
      [sameDay],
    )
  }

  /** A collective event needs every host free. */
  async function verifyCollective(M: PollModule) {
    const s = await team({}, { hosts: ['member', 'owner'], schedulingType: 'collective' })
    const { deadline, starts } = await hourly(4)
    const [free, memberBusy, ownerBusy, later] = starts as [string, string, string, string]
    await book(db, s.organizationId, [s.member.id], memberBusy)
    await book(db, s.organizationId, [s.owner.id], ownerBusy)
    await refused(propose(M, s.ctx, s.eventTypeId, starts, deadline), s.eventTypeId, [
      memberBusy,
      ownerBusy,
    ])
    await succeeds(() => propose(M, s.ctx, s.eventTypeId, [free, later], deadline))
  }

  /** A round-robin event needs one eligible pool host free for each candidate. */
  async function verifyRoundRobin(M: PollModule) {
    const s = await team({}, { hosts: ['admin', 'owner', 'member'], schedulingType: 'round_robin' })
    const { deadline, starts } = await hourly(4)
    const [oneFree, allBusy, onlyIneligibleFree, open] = starts as [string, string, string, string]
    await book(db, s.organizationId, [s.owner.id, s.member.id], oneFree)
    await book(db, s.organizationId, [s.admin.id, s.owner.id, s.member.id], allBusy)
    await book(db, s.organizationId, [s.admin.id, s.owner.id], onlyIneligibleFree)
    // An unverified host stays configured but leaves the eligible pool.
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.member.id)
      .execute()
    await refused(propose(M, s.ctx, s.eventTypeId, starts, deadline), s.eventTypeId, [
      allBusy,
      onlyIneligibleFree,
    ])
    const { poll } = await succeeds(() =>
      propose(M, s.ctx, s.eventTypeId, [oneFree, open], deadline),
    )
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual([oneFree, open])
  }

  /** Wall-clock hours resolve in the host's zone on each side of a daylight-saving change. */
  async function verifyTimeZones(M: PollModule) {
    const zone = 'America/New_York'
    const s = await personal(
      { durationMinutes: 60 },
      { timeZone: zone, weeklyHours: weekdays({ start: '09:00', end: '17:00' }) },
    )
    const transition = Temporal.Now.zonedDateTimeISO(zone)
      .add({ days: 7 })
      .getTimeZoneTransition('next') as Temporal.ZonedDateTime
    const weekday = (date: Temporal.PlainDate, step: 1 | -1) => {
      let current = date
      while (current.dayOfWeek > 5) current = current.add({ days: step })
      return current
    }
    const before = weekday(transition.toPlainDate().subtract({ days: 1 }), -1)
    const after = weekday(transition.toPlainDate().add({ days: 1 }), 1)
    const at = (date: Temporal.PlainDate, hour: number) =>
      date
        .toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from({ hour }) })
        .toInstant()
        .toString()
    const offset = (instant: string) =>
      Temporal.Instant.from(instant).toZonedDateTimeISO(zone).offsetNanoseconds
    expect(offset(at(before, 9))).not.toBe(offset(at(after, 9)))
    // With a fixed offset, one of 08:00/09:00 and one of 16:00/17:00 would flip sides.
    const tooEarly = at(after, 8)
    const tooLate = at(after, 17)
    const open = [at(before, 9), at(after, 9), at(after, 16)]
    const display = { displayTimeZone: 'Asia/Tokyo' }
    await refused(
      M.createMeetingPoll(s.ctx, {
        ...(await input(s.eventTypeId, display)),
        candidateStarts: [...open, tooEarly, tooLate],
      }),
      s.eventTypeId,
      [tooEarly, tooLate],
    )
    const { poll } = await succeeds(async () =>
      M.createMeetingPoll(s.ctx, {
        ...(await input(s.eventTypeId, display)),
        candidateStarts: open,
      }),
    )
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual(open)
  }

  /** An event that takes no bookings at all is refused as such, not slot by slot. */
  async function verifyUnbookableEvent(M: PollModule) {
    const s = await team({}, { hosts: ['member', 'owner'], schedulingType: 'collective' })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.member.id)
      .execute()
    expect(
      await failure(async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
    ).toMatchObject({ kind: 'conflict', code: 'event_type_unavailable' })
    // Booking by ID needs a personal owner's public handle, as one-time links do.
    const p = await personal()
    await db.deleteFrom('profiles').where('user_id', '=', p.user.id).execute()
    expect(
      await failure(async () => M.createMeetingPoll(p.ctx, await input(p.eventTypeId))),
    ).toMatchObject({ kind: 'conflict', code: 'event_type_unavailable' })
    expect([...(await pollsOf(s.eventTypeId)), ...(await pollsOf(p.eventTypeId))]).toEqual([])
  }

  /** Hold `hold` in its own transaction until the returned release is awaited. */
  async function holding(hold: (trx: Db) => Promise<unknown>) {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = db.transaction().execute(async (trx) => {
      try {
        await hold(trx)
      } catch (error) {
        locked.reject(error)
        throw error
      }
      locked.resolve()
      await release.promise
    })
    done.catch(() => undefined)
    await locked.promise
    return async () => {
      release.resolve()
      await done
    }
  }

  /** Whether `work` queues behind a lock (`count` waiters in all) or settles first. */
  async function queues(work: Promise<unknown>, count: number): Promise<'queued' | 'settled'> {
    let settled = false
    work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    for (let attempt = 0; attempt < 400; attempt++) {
      if (settled) return 'settled'
      const { rows } = await sql<{
        count: string
      }>`SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db)
      if (Number(rows[0]?.count) >= count) return 'queued'
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`expected ${count} lock waiters or a settled operation`)
  }

  /**
   * A booking that holds its host's booking lock commits first: creation waits for it, then
   * sees the booking and refuses that candidate.
   */
  async function verifyBookingFirst(M: PollModule) {
    const s = await personal()
    const { deadline, starts } = await hourly(2)
    const [taken] = starts as [string]
    const commit = await holding(async (trx) => {
      await lockHosts(trx, [s.user.id])
      await book(trx, s.organizationId, [s.user.id], taken, { eventTypeId: s.eventTypeId })
    })
    const creation = propose(M, s.ctx, s.eventTypeId, starts, deadline)
    let order: 'queued' | 'settled'
    try {
      order = await queues(creation, 1)
    } finally {
      await commit()
    }
    expect(order).toBe('queued')
    await refused(creation, s.eventTypeId, [taken])
  }

  /**
   * Creation that holds the host's booking lock first makes a concurrent booking wait for
   * it; the booking then takes the candidate time, because candidates are not holds.
   */
  async function verifyCreationFirst(M: PollModule) {
    const s = await personal()
    const { deadline, starts } = await hourly(2)
    const [proposed] = starts as [string]
    // Creation takes the host lock, then queues on the event row.
    const release = await holding((trx) =>
      trx
        .selectFrom('event_types')
        .select('id')
        .where('id', '=', s.eventTypeId)
        .forUpdate()
        .execute(),
    )
    const creation = propose(M, s.ctx, s.eventTypeId, starts, deadline)
    let booking: Promise<string> | undefined
    let order: 'queued' | 'settled' | undefined
    try {
      if ((await queues(creation, 1)) === 'queued') {
        booking = db.transaction().execute(async (trx) => {
          await lockHosts(trx, [s.user.id])
          return book(trx, s.organizationId, [s.user.id], proposed, { eventTypeId: s.eventTypeId })
        })
        order = await queues(booking, 2)
      }
    } finally {
      await release()
    }
    expect(order).toBe('queued')
    const { poll } = await succeeds(() => creation)
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual(starts)
    expect(await booking).toEqual(expect.any(String))
  }

  /** Hosts replaced while creation waits for the ones it named are a conflict, not a pass. */
  async function verifyHostChange(M: PollModule) {
    const s = await team({}, { hosts: ['member', 'owner'], schedulingType: 'collective' })
    const named = [s.member.id, s.owner.id]
    const release = await holding((trx) => lockHosts(trx, named))
    const creation = (async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId)))()
    let order: 'queued' | 'settled'
    try {
      order = await queues(creation, 1)
      await db
        .updateTable('event_type_hosts')
        .set({ user_id: s.admin.id })
        .where('event_type_id', '=', s.eventTypeId)
        .where('user_id', '=', s.owner.id)
        .execute()
    } finally {
      await release()
    }
    expect(order).toBe('queued')
    expect(await failure(() => creation)).toMatchObject({
      kind: 'conflict',
      code: 'poll_event_changed',
    })
    expect(await pollsOf(s.eventTypeId)).toEqual([])
  }

  /** One actor's receipts in two organizations are separate, even with one key. */
  async function verifyOrganizationIsolation(M: PollModule) {
    const admin = await createTestUser(db, 'Admin of two teams')
    const host = await createTestUser(db, 'Host of two teams')
    await fixtures.schedule(host.id, ALWAYS)
    const spaces: { ctx: ServiceContext; eventTypeId: string }[] = []
    for (const name of ['First team', 'Second team']) {
      const t = await createTestTeam(
        db,
        [
          { user: admin, role: 'admin' },
          { user: host, role: 'member' },
        ],
        name,
      )
      const eventTypeId = await fixtures.eventType(t.id, null, { hosts: [{ userId: host.id }] })
      spaces.push({ ctx: testContext(db, session(t.as(admin))), eventTypeId })
    }
    const key = randomUUID()
    const created: Polls.MeetingPollWithLink[] = []
    for (const space of spaces)
      created.push(
        await succeeds(async () =>
          M.createMeetingPoll(space.ctx, await input(space.eventTypeId, { idempotencyKey: key })),
        ),
      )
    const [first, second] = created.map((result) => result.poll.id)
    expect(first).not.toBe(second)
    for (const [index, space] of spaces.entries())
      expect(
        await failure(async () =>
          M.createMeetingPoll(space.ctx, await input(space.eventTypeId, { idempotencyKey: key })),
        ),
      ).toMatchObject({ code: 'poll_already_created', pollId: created[index]?.poll.id })
    const rotation = { expectedHostRevision: 1, idempotencyKey: randomUUID() }
    for (const [index, space] of spaces.entries())
      await succeeds(() =>
        M.rotateMeetingPollLink(space.ctx, { ...rotation, id: created[index]?.poll.id as string }),
      )
    for (const [index, space] of spaces.entries())
      expect(
        await failure(() =>
          M.rotateMeetingPollLink(space.ctx, {
            ...rotation,
            id: created[index]?.poll.id as string,
          }),
        ),
      ).toMatchObject({ code: 'poll_link_already_rotated' })
    for (const id of [first, second])
      expect((await receipts(id as string)).map((receipt) => receipt.operation).sort()).toEqual([
        'create',
        'rotate_link',
      ])
  }

  /**
   * The creation instant is read after the host users and members are share-locked, as
   * public booking reads its clock: a creation that waits for a host's user row records a
   * time no earlier than the moment that row was released.
   */
  async function verifyCreationClock(M: PollModule) {
    const s = await team()
    const release = await holding((trx) =>
      trx.selectFrom('auth.user').select('id').where('id', '=', s.member.id).forUpdate().execute(),
    )
    const creation = (async () => M.createMeetingPoll(s.ctx, await input(s.eventTypeId)))()
    let order: 'queued' | 'settled'
    let released: Temporal.Instant
    try {
      order = await queues(creation, 1)
      await new Promise((resolve) => setTimeout(resolve, 250))
      released = await databaseNow()
    } finally {
      await release()
    }
    expect(order).toBe('queued')
    const { poll } = await succeeds(() => creation)
    expect(
      Temporal.Instant.compare(Temporal.Instant.from(poll.createdAt), released),
    ).toBeGreaterThanOrEqual(0)
  }

  /**
   * Collective hosts are judged by their default schedules, as public booking judges them,
   * never by a per-event schedule. A closed default refuses even with an open per-event
   * schedule; an open default accepts even with a closed per-event schedule.
   */
  async function verifyCollectiveDefaultSchedule(M: PollModule) {
    const s = await team({}, { hosts: ['member', 'owner'], schedulingType: 'collective' })
    const assign = async (userId: string, schedule: ScheduleOptions) => {
      const scheduleId = await fixtures.schedule(userId, { ...schedule, isDefault: false })
      await db
        .updateTable('event_type_hosts')
        .set({ schedule_id: scheduleId })
        .where('event_type_id', '=', s.eventTypeId)
        .where('user_id', '=', userId)
        .execute()
    }
    const setDefault = (userId: string, weeklyHours: object) =>
      db
        .updateTable('schedules')
        .set({ weekly_hours: JSON.stringify(weeklyHours) })
        .where('user_id', '=', userId)
        .where('is_default', '=', true)
        .execute()
    const { deadline, starts } = await hourly(2)
    await assign(s.owner.id, ALWAYS)
    await setDefault(s.owner.id, {})
    await refused(propose(M, s.ctx, s.eventTypeId, starts, deadline), s.eventTypeId, starts)

    await setDefault(s.owner.id, (ALWAYS as { weeklyHours: object }).weeklyHours)
    await assign(s.member.id, { timeZone: 'UTC', weeklyHours: {} })
    const { poll } = await succeeds(() => propose(M, s.ctx, s.eventTypeId, starts, deadline))
    expect(poll.candidates.map((candidate) => candidate.startAt)).toEqual(starts)
  }

  it('reads the creation clock after the host user and member locks', async () => {
    await verifyCreationClock(Polls)
  })

  it('judges collective hosts by their default schedules, not per-event ones', async () => {
    await verifyCollectiveDefaultSchedule(Polls)
  })

  it('refuses candidates outside the host’s working hours and date overrides', async () => {
    await verifyWorkingHours(Polls)
  })

  it('refuses candidates over confirmed bookings of any event type and busy calendars', async () => {
    await verifyBusyTime(Polls)
  })

  it('refuses candidates over a live payment hold but not an expired one', async () => {
    await verifyHolds(Polls)
  })

  it('applies minimum notice, buffers, the booking window and booking limits', async () => {
    await verifyEventRules(Polls)
  })

  it('needs every collective host free', async () => {
    await verifyCollective(Polls)
  })

  it('needs one eligible round-robin host free and refuses when all are busy', async () => {
    await verifyRoundRobin(Polls)
  })

  it('resolves working hours in the host’s zone across a daylight-saving change', async () => {
    await verifyTimeZones(Polls)
  })

  it('refuses events that take no bookings with event_type_unavailable', async () => {
    await verifyUnbookableEvent(Polls)
  })

  it('refuses with calendar_sync_unavailable while a host calendar is stale', async () => {
    const s = await personal()
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: s.user.id,
        provider: 'google',
        external_account_id: `acct-${randomUUID()}`,
        credentials: Buffer.from('synthetic-never-used-credential'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Never synced: unknown busy time is not free time.
    await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: `cal-${randomUUID()}`,
        name: 'Work',
        check_conflicts: true,
      })
      .execute()
    expect(
      await failure(async () => Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
    ).toMatchObject({ kind: 'conflict', code: 'calendar_sync_unavailable' })
    expect(await pollsOf(s.eventTypeId)).toEqual([])
  })

  it('waits for a booking that holds the host lock and then refuses its time', async () => {
    await verifyBookingFirst(Polls)
  })

  it('makes a racing booking wait for creation, which holds no time', async () => {
    await verifyCreationFirst(Polls)
  })

  it('refuses with poll_event_changed when hosts change while creation waits', async () => {
    await verifyHostChange(Polls)
  })

  it('keeps one actor’s receipts separate per organization with the same key', async () => {
    await verifyOrganizationIsolation(Polls)
  })

  // --- Mutation checks --------------------------------------------------------------------

  const verifications = [
    verifyStaleRevision,
    verifyRevisionAdvances,
    verifyNoReopening,
    verifyPublicToken,
    verifyCreateReplay,
    verifyRotateReplay,
    verifyRoleAuthority,
    verifyAuthorityLoss,
    verifyApiKeys,
    verifyTenant,
    verifyContextHook,
    verifyFixedSettings,
    verifyNoHolds,
    verifyRepeats,
    verifyDeadlineClosure,
    verifyValidation,
    verifyBounds,
    verifyCreateRace,
    verifyActorIsolation,
    verifyWorkingHours,
    verifyBusyTime,
    verifyHolds,
    verifyEventRules,
    verifyCollective,
    verifyRoundRobin,
    verifyTimeZones,
    verifyUnbookableEvent,
    verifyBookingFirst,
    verifyCreationFirst,
    verifyHostChange,
    verifyOrganizationIsolation,
    verifyCreationClock,
    verifyCollectiveDefaultSchedule,
  ]

  // Every check in sequence, including the lock races, so allow more than one check's time.
  it('passes every protection check through the pinned-clock source copy', async () => {
    const copy = await sourceCopy(PIN_CLOCK)
    for (const verify of verifications) await verify(copy)
  }, 60_000)

  type Mutation = [string, (M: PollModule) => Promise<void>, ...(readonly [string, string])[]]
  const mutations: Mutation[] = [
    [
      'close ignores expectedHostRevision',
      verifyStaleRevision,
      [
        "if (poll.status === 'scheduled') throw alreadyScheduled()\n    requireHostRevision(poll, request.expectedHostRevision)\n    await hostWrite(trx, poll, { status: 'closed'",
        "if (poll.status === 'scheduled') throw alreadyScheduled()\n    await hostWrite(trx, poll, { status: 'closed'",
      ],
    ],
    [
      'cancel ignores expectedHostRevision',
      verifyStaleRevision,
      [
        'requireHostRevision(poll, request.expectedHostRevision)\n    // Voting already closed',
        '// Voting already closed',
      ],
    ],
    [
      'delete ignores expectedHostRevision',
      verifyStaleRevision,
      [
        'requireHostRevision(poll, request.expectedHostRevision)\n    const deleted',
        'const deleted',
      ],
    ],
    [
      'rotate-link ignores expectedHostRevision',
      verifyStaleRevision,
      [
        'requireHostRevision(poll, request.expectedHostRevision)\n    const publicToken',
        'const publicToken',
      ],
    ],
    [
      'host writes keep the old revision',
      verifyRevisionAdvances,
      ['host_revision: poll.host_revision + 1,', 'host_revision: poll.host_revision,'],
    ],
    [
      'close accepts a canceled poll',
      verifyNoReopening,
      [
        "if (poll.status === 'canceled')\n      throw new DomainError('conflict', 'poll_canceled', 'This poll was canceled')",
        '',
      ],
    ],
    [
      'reads derive status from the deadline alone',
      verifyNoReopening,
      [
        "status: row.deadlinePassed ? 'closed' : (row.status as MeetingPollStatus),",
        "status: row.deadlinePassed ? 'closed' : ('open' as MeetingPollStatus),",
      ],
    ],
    [
      'cancel retires the public link',
      verifyPublicToken,
      [
        '      canceled_at: poll.at,\n      ...(deadlineClosed',
        '      canceled_at: poll.at,\n      public_token_digest: null as never,\n      ...(deadlineClosed',
      ],
    ],
    [
      'rotation keeps the old capability',
      verifyPublicToken,
      ['{ public_token_digest: meetingPollPublicTokenDigest(publicToken) }', '{}'],
    ],
    [
      'invited polls get a public capability',
      verifyPublicToken,
      ["request.admissionMode === 'public_link' ? randomBytes(32)", 'true ? randomBytes(32)'],
    ],
    [
      'create replay ignores the request fingerprint',
      verifyCreateReplay,
      [
        'if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()\n      throw new MeetingPollAlreadyCreatedError',
        'throw new MeetingPollAlreadyCreatedError',
      ],
    ],
    [
      'create skips its receipt lookup',
      verifyCreateReplay,
      [
        'const previous = await lockedReceipt(trx, receipt)\n    if (previous) {\n      if',
        'const previous = undefined as any\n    if (previous) {\n      if',
      ],
    ],
    [
      'create fingerprints candidates in request order',
      verifyCreateReplay,
      ['      candidateStarts: starts,\n', '      candidateStarts: request.candidates,\n'],
    ],
    [
      'same-key creates do not serialize on the receipt',
      verifyCreateRace,
      ['SELECT pg_advisory_xact_lock(hashtextextended(', 'SELECT abs(hashtextextended('],
    ],
    [
      'receipts are scoped to the user instead of the credential',
      verifyActorIsolation,
      [
        "  const actor =\n    principal.kind === 'api_key'\n      ? { kind: 'api_key', id: principal.apiKeyId.toLowerCase() }\n      : principal.kind === 'oauth'\n        ? { kind: 'oauth', id: principal.oauthConsentId.toLowerCase() }\n        : { kind: 'session', id: principal.user.id.toLowerCase() }\n",
        "  const actor = { kind: 'user', id: principal.user.id.toLowerCase() }\n",
      ],
    ],
    [
      'receipt lookups ignore the organization',
      verifyOrganizationIsolation,
      [
        "    .where('organization_id', '=', receipt.organizationId)\n    .where('operation', '=', receipt.operation)",
        "    .where('operation', '=', receipt.operation)",
      ],
    ],
    [
      'rotate checks the revision before its receipt',
      verifyRotateReplay,
      [
        '    // A lost successful response stays recoverable after the revision has advanced.\n',
        '    requireHostRevision(poll, request.expectedHostRevision)\n',
      ],
    ],
    [
      'rotate replay ignores the request fingerprint',
      verifyRotateReplay,
      [
        "if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()\n      throw new DomainError(\n        'conflict',\n        'poll_link_already_rotated'",
        "throw new DomainError(\n        'conflict',\n        'poll_link_already_rotated'",
      ],
    ],
    [
      'team members manage polls',
      verifyRoleAuthority,
      ["if (!personal && !roles.includes('owner') && !roles.includes('admin')) throw denied()", ''],
    ],
    [
      'unverified actors keep authority',
      verifyAuthorityLoss,
      ['if (!actor?.emailVerified) throw denied()', ''],
    ],
    [
      'departed members keep authority',
      verifyAuthorityLoss,
      [
        'if (!membership) throw denied()\n  const roles = membership.role',
        "const roles = (membership?.role ?? 'owner')",
      ],
    ],
    [
      'a member row in another personal space grants authority',
      verifyAuthorityLoss,
      ['if (personal && personal.user_id !== principal.user.id) throw denied()', ''],
    ],
    [
      'create replays before authorization',
      verifyAuthorityLoss,
      [
        '    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)\n',
        "    const early = await trx.selectFrom('meeting_poll_operations').select('poll_id').where('organization_id', '=', ctx.principal.organization.id).where('operation', '=', 'create').where('idempotency_key_digest', '=', sha256('idempotency-key', request.idempotencyKey)).executeTakeFirst()\n    if (early) throw new MeetingPollAlreadyCreatedError(early.poll_id)\n    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)\n",
      ],
    ],
    [
      'rotate replays before authorization',
      verifyAuthorityLoss,
      [
        '    const poll = await lockManagedPoll(trx, ctx, request.id)\n    const receipt',
        "    const early = await trx.selectFrom('meeting_poll_operations').select('poll_id').where('operation', '=', 'rotate_link').where('idempotency_key_digest', '=', sha256('idempotency-key', key)).executeTakeFirst()\n    if (early) throw new DomainError('conflict', 'poll_link_already_rotated')\n    const poll = await lockManagedPoll(trx, ctx, request.id)\n    const receipt",
      ],
    ],
    [
      'read-scope keys write',
      verifyApiKeys,
      [
        "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope === 'read')\n    throw new ApiKeyScopeError()",
        '',
      ],
    ],
    [
      'disabled keys keep working',
      verifyApiKeys,
      ["if (principal.kind === 'api_key') await requireActiveApiKey(db, principal, Date.now)", ''],
    ],
    [
      'host writes are not scoped to the organization',
      verifyTenant,
      [
        ".where('id', '=', id)\n    .where('organization_id', '=', ctx.principal.organization.id)\n    .forUpdate()",
        ".where('id', '=', id)\n    .forUpdate()",
      ],
    ],
    [
      'host writes skip the organization context hook',
      verifyContextHook,
      ['  await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)\n', ''],
    ],
    [
      'create skips the organization context hook',
      verifyContextHook,
      [
        '    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)\n',
        '',
      ],
    ],
    [
      'host writes run the context hook after taking locks',
      verifyContextHook,
      [
        '  await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)\n  const authority = await lockAuthority(trx, ctx)\n',
        '  const authority = await lockAuthority(trx, ctx)\n  await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id)\n',
      ],
    ],
    [
      'create runs the context hook after taking locks',
      verifyContextHook,
      [
        '    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)\n    const authority = await lockAuthority(trx, ctx)\n',
        '    const authority = await lockAuthority(trx, ctx)\n    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, request.eventTypeId)\n',
      ],
    ],
    [
      'host writes refresh the title from the event',
      verifyFixedSettings,
      [
        '.set({ ...changes, host_revision',
        '.set({ ...changes, title: sql`(SELECT title FROM event_types WHERE id = meeting_polls.event_type_id)`, host_revision',
      ],
    ],
    [
      'rotation re-snapshots current event settings',
      verifyFixedSettings,
      [
        "const publicToken = randomBytes(32).toString('base64url')\n    await hostWrite(",
        "const publicToken = randomBytes(32).toString('base64url')\n    const current = await meetingPollEventSettings(trx, (await trx.selectFrom('meeting_polls').select('event_type_id').where('id', '=', poll.id).executeTakeFirstOrThrow()).event_type_id, 30)\n    await trx.updateTable('meeting_polls').set({ settings_snapshot: JSON.stringify(current.snapshot), settings_fingerprint: current.fingerprint }).where('id', '=', poll.id).execute()\n    await hostWrite(",
      ],
    ],
    [
      'create places a booking hold',
      verifyNoHolds,
      [
        '    await insertReceipt(trx, receipt, poll.id, createdAt)\n    return',
        "    await insertReceipt(trx, receipt, poll.id, createdAt)\n    await trx.insertInto('bookings').values({ organization_id: ctx.principal.organization.id, event_type_id: event.id, status: 'confirmed', start_at: starts[0], end_at: Temporal.Instant.from(starts[0]).add({ minutes: durationMinutes }).toString(), title: 'hold', manage_token_hash: randomBytes(32), source }).execute()\n    return",
      ],
    ],
    [
      'create consumes an event booking limit',
      verifyNoHolds,
      [
        '    await insertReceipt(trx, receipt, poll.id, createdAt)\n    return',
        "    await insertReceipt(trx, receipt, poll.id, createdAt)\n    await trx.updateTable('event_types').set({ max_bookings_per_day: 0 }).where('id', '=', event.id).execute()\n    return",
      ],
    ],
    [
      'close checks the revision before its repeat',
      verifyRepeats,
      [
        "    if (poll.effectiveStatus === 'closed') return loadPoll(trx, ctx, poll.id)\n",
        "    requireHostRevision(poll, request.expectedHostRevision)\n    if (poll.effectiveStatus === 'closed') return loadPoll(trx, ctx, poll.id)\n",
      ],
    ],
    [
      'cancel checks the revision before its repeat',
      verifyRepeats,
      [
        "    if (poll.status === 'canceled') return loadPoll(trx, ctx, poll.id)\n",
        "    requireHostRevision(poll, request.expectedHostRevision)\n    if (poll.status === 'canceled') return loadPoll(trx, ctx, poll.id)\n",
      ],
    ],
    [
      'host writes ignore a passed deadline',
      verifyDeadlineClosure,
      [
        "poll.status === 'open' && deadlinePassed ? 'closed' : (poll.status as MeetingPollStatus)",
        '(poll.status as MeetingPollStatus)',
      ],
    ],
    [
      'reads ignore a passed deadline',
      verifyDeadlineClosure,
      [
        "status: row.deadlinePassed ? 'closed' : (row.status as MeetingPollStatus),",
        'status: row.status as MeetingPollStatus,',
      ],
    ],
    [
      'cancel forgets the deadline closure',
      verifyDeadlineClosure,
      ['      ...(deadlineClosed ? { closed_at: poll.deadline } : {}),\n', ''],
    ],
    [
      'duplicate candidates reach storage',
      verifyValidation,
      [
        "    if (starts.length !== request.candidates.length)\n      throw invalidPoll('candidateStarts must not contain the same instant twice')\n",
        '',
      ],
    ],
    [
      'group seat events are accepted',
      verifyValidation,
      ["if (event.booking_mode !== 'individual')", 'if (false)'],
    ],
    [
      'capability fields are treated as unknown fields',
      verifyValidation,
      ['if (TOKEN_FIELDS.has(field))', 'if (false)'],
    ],
    [
      'the minimum notice is ignored',
      verifyValidation,
      ['if (earliest <= deadline || earliest - deadline < notice)', 'if (earliest <= deadline)'],
    ],
    [
      'the one-hour deadline bound is exclusive',
      verifyBounds,
      [
        'elapsed < BigInt(MEETING_POLL_LIMITS.minDeadlineSeconds)',
        'elapsed <= BigInt(MEETING_POLL_LIMITS.minDeadlineSeconds)',
      ],
    ],
    [
      'the 30-day deadline bound is exclusive',
      verifyBounds,
      [
        'elapsed > BigInt(MEETING_POLL_LIMITS.maxDeadlineSeconds)',
        'elapsed >= BigInt(MEETING_POLL_LIMITS.maxDeadlineSeconds)',
      ],
    ],
    [
      'the minimum notice is exclusive',
      verifyBounds,
      ['earliest - deadline < notice', 'earliest - deadline <= notice'],
    ],
    [
      'a candidate may start at the deadline',
      verifyBounds,
      ['if (earliest <= deadline ||', 'if (earliest < deadline ||'],
    ],
    [
      'create skips availability validation',
      verifyBusyTime,
      [
        '    await requireBookableCandidates(trx, bookable, starts, durationMinutes, createdAt)\n',
        '',
      ],
    ],
    [
      'create validates only the first candidate',
      verifyCollective,
      ['  for (const start of starts) {\n', '  for (const start of starts.slice(0, 1)) {\n'],
    ],
    [
      'round-robin intersects its pool instead of uniting it',
      verifyRoundRobin,
      [
        '? await unionRoundRobinSlots(\n            trx,\n            event.id,\n            event.eligibleHostUserIds,\n            from,\n            to,\n            now,\n            durationMinutes,\n          )',
        '? await intersectSlots(trx, event.id, event.eligibleHostUserIds, from, to, now, undefined, true, durationMinutes)',
      ],
    ],
    [
      'create checks availability without the host booking locks (booking first)',
      verifyBookingFirst,
      ['    await lockHosts(trx, hostUserIds)\n', ''],
    ],
    [
      'create checks availability without the host booking locks (creation first)',
      verifyCreationFirst,
      ['    await lockHosts(trx, hostUserIds)\n', ''],
    ],
    [
      'create ignores hosts that changed while it waited',
      verifyHostChange,
      ['  if (event.hostUserIds.join() !== lockedHostUserIds.join()) throw eventChanged()\n', ''],
    ],
    [
      'the creation clock is read before the host booking locks',
      verifyCreationClock,
      [
        '    await lockHosts(trx, hostUserIds)\n',
        '    const early = await clock(trx)\n    await lockHosts(trx, hostUserIds)\n',
      ],
      ['?? (await clock(trx))', '?? early'],
    ],
    [
      'the creation clock is read before the host users and members are locked',
      verifyCreationClock,
      ['    const bookable = await lockBookableEvent(trx, event.id, hostUserIds)\n', ''],
      [
        '    await requireBookableCandidates(trx, bookable,',
        '    const bookable = await lockBookableEvent(trx, event.id, hostUserIds)\n    await requireBookableCandidates(trx, bookable,',
      ],
    ],
    [
      'collective hosts use their per-event schedules',
      verifyCollectiveDefaultSchedule,
      ["            event.schedulingType === 'collective',\n", '            false,\n'],
    ],
  ]

  // Only a failed assertion counts: a mutant that crashes or cannot load is not a detection.
  it.each(mutations)('detects the mutation: %s', async (_name, verify, ...replacements) => {
    const mutated = await sourceCopy(PIN_CLOCK, ...replacements)
    await expectKilled(mutated, verify)
  })
})
