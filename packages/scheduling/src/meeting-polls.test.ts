import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import * as Polls from './meeting-polls.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type PollModule = typeof Polls
type Input = Polls.CreateMeetingPollInput

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
  return import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`)
}

/** Source copies load their own DomainError class, so compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) throw new Error('expected the operation to fail')
  const domain = error as Partial<DomainError> & { pollId?: string | null }
  return { name: error.name, kind: domain.kind, code: domain.code, pollId: domain.pollId }
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

  /** Deadline one day from the database clock; candidates deliberately out of order. */
  async function input(eventTypeId: string, overrides: Partial<Input> = {}): Promise<Input> {
    const deadline = (await databaseNow())
      .round({ smallestUnit: 'minute', roundingMode: 'ceil' })
      .add({ hours: 24 })
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

  async function personal(event: Parameters<typeof fixtures.eventType>[2] = {}) {
    const user = await createTestUser(db, 'Personal Owner')
    const organizationId = user.principal.organization.id
    const eventTypeId = await fixtures.eventType(organizationId, user.id, event)
    return { user, organizationId, eventTypeId, ctx: testContext(db, session(user.principal)) }
  }

  async function team(event: Parameters<typeof fixtures.eventType>[2] = {}) {
    const admin = await createTestUser(db, 'Team Admin')
    const owner = await createTestUser(db, 'Team Owner')
    const member = await createTestUser(db, 'Configured Host')
    const t = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(t.id, null, {
      hosts: [{ userId: member.id }, { userId: admin.id }],
      ...event,
    })
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

  /** Row counts of every table, to prove that creation writes only poll storage. */
  async function tableCounts() {
    const { rows: tables } = await sql<{ name: string }>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`.execute(db)
    const counts: Record<string, number> = {}
    for (const { name } of tables) {
      const { rows } = await sql<{
        count: string
      }>`SELECT count(*)::text AS count FROM ${sql.raw(name)}`.execute(db)
      counts[name] = Number(rows[0]?.count)
    }
    return counts
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

    const invited = await M.createMeetingPoll(
      s.ctx,
      await input(s.eventTypeId, { admissionMode: 'invited' }),
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
      authorizeOrganizationWrite: async (_trx, organizationId, targetId) => {
        seen.push([organizationId, targetId])
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
      [s.organizationId, s.eventTypeId],
      [s.organizationId, undefined],
      [s.organizationId, undefined],
      [s.organizationId, undefined],
      [s.organizationId, undefined],
    ])
    expect(await stored(poll.id)).toEqual(before)
    expect(await tableCounts()).toEqual(counts)
  }

  async function verifyFixedSettings(M: PollModule) {
    const s = await team({
      title: 'Planning',
      questions: [{ id: 'topic', label: 'Topic', type: 'text', required: true }],
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
    const s = await team()
    // Busy time and booking limits exist, yet a proposal reserves nothing.
    await fixtures.calendarBusy(s.member.id, [['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']])
    const before = await tableCounts()
    const { poll } = await M.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const after = await tableCounts()
    const changedTables = Object.keys(after).filter((name) => after[name] !== before[name])
    expect(changedTables.sort()).toEqual([
      'public.meeting_poll_operations',
      'public.meeting_poll_slots',
      'public.meeting_polls',
    ])
    expect(after['public.meeting_polls']).toBe((before['public.meeting_polls'] ?? 0) + 1)
    expect(after['public.meeting_poll_slots']).toBe((before['public.meeting_poll_slots'] ?? 0) + 2)
    expect(poll.status).toBe('open')
  }

  // --- Behaviour --------------------------------------------------------------------------

  it('creates an open public-link poll with a one-time link, sorted candidates and a snapshot', async () => {
    const s = await personal({
      title: 'Intro call',
      questions: [{ id: 'notes', label: 'Notes', type: 'text', required: false }],
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
      questions: [{ id: 'notes', label: 'Notes', type: 'text', required: false }],
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

  it('validates candidates, deadlines, durations and unsupported event modes before writing', async () => {
    const s = await personal({ minimumNoticeMinutes: 120 })
    // Unrounded: creation reads the database clock later, so elapsed time only shrinks.
    const now = await databaseNow()
    const deadline = now.add({ hours: 24 })
    const at = (hours: number) => deadline.add({ hours }).toString()
    const counts = await tableCounts()
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
        await failure(() => Polls.createMeetingPoll(s.ctx, request)),
        JSON.stringify(override),
      ).toMatchObject({
        code,
      })
    }
    expect(await tableCounts()).toEqual(counts)

    // Both deadline bounds are inclusive elapsed time from the database creation instant.
    const accepted = [
      {
        deadlineAt: now.add({ hours: 1, minutes: 1 }).toString(),
        candidateStarts: [now.add({ hours: 4 }).toString(), now.add({ hours: 5 }).toString()],
      },
      {
        deadlineAt: now.add({ hours: 720 }).toString(),
        candidateStarts: [now.add({ hours: 723 }).toString(), now.add({ hours: 724 }).toString()],
      },
      { deadlineAt: deadline.toString(), candidateStarts: [at(2), at(3)] },
    ]
    for (const override of accepted)
      expect(
        (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId, override))).poll.status,
      ).toBe('open')

    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(
      await failure(async () => Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
    ).toMatchObject({
      code: 'event_type_inactive',
    })
    await db
      .updateTable('event_types')
      .set({ is_active: true, deleted_at: new Date() })
      .where('id', '=', s.eventTypeId)
      .execute()
    expect(
      await failure(async () => Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))),
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
      await failure(async () => Polls.createMeetingPoll(group.ctx, await input(group.eventTypeId))),
    ).toMatchObject({
      code: 'poll_event_unsupported',
    })
  })

  it('normalizes instants to database microseconds before storing and fingerprinting', async () => {
    const s = await personal()
    const request = await input(s.eventTypeId)
    const precise = Temporal.Instant.from(request.candidateStarts[0] as string).add({
      nanoseconds: 1_234_567,
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

  it('rechecks role, membership and verification on every read, write and replay', async () => {
    const s = await team()
    const request = await input(s.eventTypeId)
    const { poll } = await Polls.createMeetingPoll(s.ctx, request)
    const operations = (ctx: ServiceContext): (() => Promise<unknown>)[] => [
      () => Polls.createMeetingPoll(ctx, request),
      () => Polls.getMeetingPoll(ctx, poll.id),
      () => Polls.listMeetingPolls(ctx),
      () => Polls.closeMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
      () => Polls.cancelMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
      () => Polls.deleteMeetingPoll(ctx, { id: poll.id, expectedHostRevision: 1 }),
      () =>
        Polls.rotateMeetingPollLink(ctx, {
          id: poll.id,
          expectedHostRevision: 1,
          idempotencyKey: randomUUID(),
        }),
    ]
    const denied = { kind: 'forbidden', code: 'team_management_access_denied' }
    // Demotion: the creator's attribution is not enduring authority, even for its replay.
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
    // An owner who lost mailbox verification.
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', s.owner.id)
      .execute()
    for (const call of operations(s.ownerCtx)) expect(await failure(call)).toMatchObject(denied)
    // A principal claiming somebody else's personal space.
    const stranger = await personal()
    const intruder = testContext(
      db,
      session({ ...s.member.principal, organization: stranger.user.principal.organization }),
    )
    for (const call of operations(intruder)) expect(await failure(call)).toMatchObject(denied)
    expect((await stored(poll.id))?.host_revision).toBe(1)
    expect(await receipts(poll.id)).toHaveLength(1)
  })

  it('runs the organization context hook first and writes nothing when the context changed', async () => {
    await verifyContextHook(Polls)
  })

  it('enforces API-key scope and live key state', async () => {
    const s = await personal()
    const key = async (scope: 'full' | 'read' | 'bookings') => {
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
          ...s.user.principal,
          kind: 'api_key',
          apiKeyId: row.id,
          apiKeyScope: scope,
        }),
      }
    }
    const bookings = await key('bookings')
    const created = await Polls.createMeetingPoll(bookings.ctx, await input(s.eventTypeId), {
      source: 'mcp',
    })
    expect(created.poll.source).toBe('mcp')
    expect((await stored(created.poll.id))?.api_key_id).toBe(bookings.id)
    const read = await key('read')
    expect((await Polls.getMeetingPoll(read.ctx, created.poll.id)).id).toBe(created.poll.id)
    const writes: (() => Promise<unknown>)[] = [
      async () => Polls.createMeetingPoll(read.ctx, await input(s.eventTypeId)),
      () => Polls.closeMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () => Polls.cancelMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () => Polls.deleteMeetingPoll(read.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
      () =>
        Polls.rotateMeetingPollLink(read.ctx, {
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
    expect((await failure(() => Polls.getMeetingPoll(bookings.ctx, created.poll.id))).name).toBe(
      'InvalidApiKeyError',
    )
    expect(
      (
        await failure(() =>
          Polls.closeMeetingPoll(bookings.ctx, { id: created.poll.id, expectedHostRevision: 1 }),
        )
      ).name,
    ).toBe('InvalidApiKeyError')
    expect((await stored(created.poll.id))?.host_revision).toBe(1)
  })

  it('closes, cancels and deletes with idempotent repeats and current state', async () => {
    const s = await team()
    const { poll } = await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))
    const closed = await Polls.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })
    expect(closed).toMatchObject({
      status: 'closed',
      hostRevision: 2,
      closedAt: expect.any(String),
    })
    expect(closed.updatedAt).toBe(closed.closedAt)
    // A repeat returns the current state before the revision check and writes nothing.
    const before = await stored(poll.id)
    expect(await Polls.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })).toEqual(
      closed,
    )
    expect(await stored(poll.id)).toEqual(before)
    const canceled = await Polls.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 2 })
    expect(canceled).toMatchObject({
      status: 'canceled',
      hostRevision: 3,
      closedAt: closed.closedAt,
    })
    const afterCancel = await stored(poll.id)
    expect(await Polls.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })).toEqual(
      canceled,
    )
    expect(await stored(poll.id)).toEqual(afterCancel)

    const open = (await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))).poll
    expect(
      await Polls.cancelMeetingPoll(s.ctx, { id: open.id, expectedHostRevision: 1 }),
    ).toMatchObject({
      status: 'canceled',
      closedAt: null,
      canceledAt: expect.any(String),
    })

    for (const expectedHostRevision of [0, 1.5, Number.NaN, '1' as never])
      expect(
        await failure(() => Polls.closeMeetingPoll(s.ctx, { id: open.id, expectedHostRevision })),
      ).toMatchObject({ code: 'invalid_poll' })

    await Polls.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 3 })
    expect(await stored(poll.id)).toBeUndefined()
    expect(
      await db
        .selectFrom('meeting_poll_slots')
        .select('id')
        .where('poll_id', '=', poll.id)
        .execute(),
    ).toEqual([])
    expect(
      await failure(() => Polls.deleteMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 3 })),
    ).toMatchObject({ code: 'poll_not_found' })
  })

  it('derives deadline closure from the database clock without a host revision change', async () => {
    const s = await team()
    const { poll } = await Polls.createMeetingPoll(s.ctx, await input(s.eventTypeId))
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
    const read = await Polls.getMeetingPoll(s.ctx, poll.id)
    expect(read).toMatchObject({
      status: 'closed',
      closedAt: expected,
      deadlineAt: expected,
      hostRevision: 1,
    })
    expect((await Polls.listMeetingPolls(s.ctx)).data[0]).toEqual(read)
    // Closing again is a repeat: no write, no revision check.
    expect(await Polls.closeMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 7 })).toEqual(
      read,
    )
    expect(await stored(poll.id)).toMatchObject({
      status: 'open',
      closed_at: null,
      host_revision: 1,
    })
    const canceled = await Polls.cancelMeetingPoll(s.ctx, { id: poll.id, expectedHostRevision: 1 })
    expect(canceled).toMatchObject({ status: 'canceled', hostRevision: 2, closedAt: null })
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

  it('deletes scheduled polls without their booking and keeps only anonymous receipts', async () => {
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

  it('serializes two concurrent creations with one key into one poll', async () => {
    const s = await team()
    const request = await input(s.eventTypeId)
    const results = await Promise.allSettled([
      Polls.createMeetingPoll(s.ctx, request),
      Polls.createMeetingPoll(s.as(s.admin), request),
    ])
    const created = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.poll.id] : [],
    )
    expect(created).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'poll_already_created', pollId: created[0] })
    expect(
      await db
        .selectFrom('meeting_polls')
        .select('id')
        .where('event_type_id', '=', s.eventTypeId)
        .execute(),
    ).toHaveLength(1)
  })

  it('replays rotation as a safe conflict and conflicts on a changed request', async () => {
    await verifyRotateReplay(Polls)
  })

  // --- Concurrency ------------------------------------------------------------------------

  /** Hold the poll row, queue `first` then `second` on it, then release them in that order. */
  async function queued<A, B>(pollId: string, first: () => Promise<A>, second: () => Promise<B>) {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('meeting_polls')
        .select('id')
        .where('id', '=', pollId)
        .forUpdate()
        .execute()
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

  // --- Mutation checks --------------------------------------------------------------------

  it('passes every protection check through an unmodified source copy', async () => {
    const copy = await sourceCopy()
    for (const verify of [
      verifyStaleRevision,
      verifyRevisionAdvances,
      verifyNoReopening,
      verifyPublicToken,
      verifyCreateReplay,
      verifyRotateReplay,
      verifyRoleAuthority,
      verifyTenant,
      verifyContextHook,
      verifyFixedSettings,
      verifyNoHolds,
    ])
      await verify(copy)
  })

  const mutations: [string, (M: PollModule) => Promise<void>, ...(readonly [string, string])[]][] =
    [
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
          "requireHostRevision(poll, request.expectedHostRevision)\n    await hostWrite(trx, poll, { status: 'canceled'",
          "await hostWrite(trx, poll, { status: 'canceled'",
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
          "{ status: 'canceled', canceled_at: poll.at }",
          "{ status: 'canceled', canceled_at: poll.at, public_token_digest: null as never }",
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
        [
          "if (!personal && !roles.includes('owner') && !roles.includes('admin')) throw denied()",
          '',
        ],
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
    ]

  it.each(mutations)('detects the mutation: %s', async (_name, verify, ...replacements) => {
    const mutated = await sourceCopy(...replacements)
    const outcome = await verify(mutated).then(
      () => 'survived',
      () => 'killed',
    )
    expect(outcome).toBe('killed')
  })
})
