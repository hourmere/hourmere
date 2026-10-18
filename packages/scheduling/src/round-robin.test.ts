import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPublicTeamEventType, listPublicTeamSlots } from './availability.ts'
import {
  cancelManagedBooking,
  createPublicTeamBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import {
  activateRoundRobin,
  createEventType,
  getEventType,
  updateEventType,
} from './event-types.ts'
import { listManagedSlots } from './manage.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  domainError,
  testContext,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00Z')
const instant = Temporal.Instant.from
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing test fixture')
  return value
}

describe.skipIf(!serverUrl)('round-robin scheduling', () => {
  let owned: TestDatabase, db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(count = 2, activate = true) {
    const users = await Promise.all(
      Array.from({ length: count }, (_, index) => createTestUser(db, `Host ${index + 1}`)),
    )
    const owner = required(users[0]),
      team = await createTestTeam(
        db,
        users.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
      )
    const ctx = testContext(db, team.as(owner), now),
      f = createFixtures(db)
    const schedules = await Promise.all(
      users.map((user) => f.schedule(user.id, { timeZone: 'UTC' })),
    )
    const created = await createEventType(ctx, {
      slug: 'round',
      title: 'Team call',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: users.map((u) => ({ userId: u.id })),
    })
    const event = activate ? await activateRoundRobin(ctx, created.id) : created
    return {
      users,
      owner,
      team,
      ctx,
      f,
      schedules,
      event,
      pub: { db, now },
      page: { handle: ctx.principal.organization.slug, slug: event.slug },
    }
  }
  type Setup = Awaited<ReturnType<typeof setup>>
  const range = { start: instant('2026-11-02T00:00Z'), end: instant('2026-11-03T00:00Z') }
  const request = (s: Setup, start = '2026-11-02T09:00Z', key: string = randomUUID()) => ({
    ...s.page,
    start: instant(start),
    idempotencyKey: key,
    invitee: { name: 'Synthetic invitee', email: 'invitee@example.com', timeZone: 'UTC' },
  })
  const book = (s: Setup, start?: string, key?: string) =>
    createPublicTeamBooking(s.pub, request(s, start, key))
  const code = async (fn: () => Promise<unknown>) => (await domainError(fn)).code
  const state = (s: Setup) =>
    db
      .selectFrom('round_robin_state')
      .select(['enabled', 'next_sequence'])
      .where('event_type_id', '=', s.event.id)
      .executeTakeFirst()
  async function waitForBlocker(pid: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await owned.pool.query<{ blocked: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
        [pid],
      )
      if (result.rows[0]?.blocked) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Expected an observed PostgreSQL lock waiter')
  }
  const outcome = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
  const host = async (id: string) =>
    (
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', id)
        .executeTakeFirstOrThrow()
    ).user_id

  it('requires explicit activation and retains exact monotonic state on metadata, host and mode changes', async () => {
    const s = await setup(2, false)
    expect(s.event.roundRobinActive).toBe(false)
    expect(await code(() => getPublicTeamEventType(s.pub, s.page))).toBe('event_type_not_found')
    await updateEventType(s.ctx, s.event.id, { isActive: false })
    await updateEventType(s.ctx, s.event.id, { isActive: true })
    expect((await getEventType(s.ctx, s.event.id)).roundRobinActive).toBe(false)
    expect(await code(() => book(s))).toBe('event_type_not_found')
    await updateEventType(s.ctx, s.event.id, { title: 'Saved metadata' })
    await updateEventType(s.ctx, s.event.id, {
      schedulingType: 'round_robin',
      hosts: s.event.hosts,
    })
    expect((await getEventType(s.ctx, s.event.id)).roundRobinActive).toBe(false)
    await activateRoundRobin(s.ctx, s.event.id)
    const a = await book(s)
    expect((await state(s))?.next_sequence).toBe('1')
    const last = await db
      .selectFrom('event_type_hosts')
      .select(['user_id', 'last_assigned_sequence'])
      .where('event_type_id', '=', s.event.id)
      .orderBy('user_id')
      .execute()
    await updateEventType(s.ctx, s.event.id, { hosts: s.event.hosts, description: 'Pool saved' })
    expect(
      await db
        .selectFrom('event_type_hosts')
        .select(['user_id', 'last_assigned_sequence'])
        .where('event_type_id', '=', s.event.id)
        .orderBy('user_id')
        .execute(),
    ).toEqual(last)
    await updateEventType(s.ctx, s.event.id, { schedulingType: 'collective', hosts: s.event.hosts })
    expect((await state(s))?.enabled).toBe(false)
    await updateEventType(s.ctx, s.event.id, {
      schedulingType: 'round_robin',
      hosts: s.event.hosts,
    })
    expect((await getEventType(s.ctx, s.event.id)).roundRobinActive).toBe(false)
    expect((await state(s))?.next_sequence).toBe('1')
    await activateRoundRobin(s.ctx, s.event.id)
    expect((await state(s))?.next_sequence).toBe('1')
    const b = await book(s, '2026-11-02T10:00Z')
    expect(await host(a.booking.id)).not.toBe(await host(b.booking.id))
    expect((await state(s))?.next_sequence).toBe('2')
  })

  it('supports one to eight normalized distinct team hosts and prevents personal/non-admin activation', async () => {
    const one = await setup(1)
    expect((await book(one)).booking.assignedHost?.name).toBe(one.owner.name)
    const eight = await setup(8)
    await updateEventType(eight.ctx, eight.event.id, {
      hosts: eight.event.hosts.map((h) => ({ userId: h.userId.toUpperCase() })),
    })
    expect(
      await code(() =>
        updateEventType(eight.ctx, eight.event.id, {
          hosts: [...eight.event.hosts, { userId: randomUUID() }],
        }),
      ),
    ).toBe('invalid_hosts')
    const duplicate = required(eight.event.hosts[0])
    expect(
      await code(() =>
        updateEventType(eight.ctx, eight.event.id, {
          hosts: [duplicate, { userId: duplicate.userId.toUpperCase() }],
        }),
      ),
    ).toBe('invalid_hosts')
    expect(
      await code(() =>
        activateRoundRobin(
          testContext(db, eight.team.as(required(eight.users[1])), now),
          eight.event.id,
        ),
      ),
    ).toBe('insufficient_role')
    expect(
      await code(() =>
        createEventType(testContext(db, one.owner.principal, now), {
          slug: 'bad',
          title: 'Bad',
          durationMinutes: 30,
          schedulingType: 'round_robin',
          hosts: [{ userId: one.owner.id }],
        }),
      ),
    ).toBe('invalid_hosts')
    expect(
      await code(() =>
        updateEventType(one.ctx, one.event.id, { scheduleId: required(one.schedules[0]) }),
      ),
    ).toBe('invalid_schedule_id')
  })

  it('unions complete intervals across disjoint and misaligned grids without leaking pool availability', async () => {
    const s = await setup()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '09:00', end: '10:00' })) })
      .where('id', '=', required(s.schedules[0]))
      .execute()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '11:15', end: '12:15' })) })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    const slots = await listPublicTeamSlots(s.pub, { ...s.page, ...range })
    expect(slots.map((slot) => slot.start)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:30:00.000Z',
      '2026-11-02T11:15:00.000Z',
      '2026-11-02T11:45:00.000Z',
    ])
    expect(Object.keys(required(slots[0])).sort()).toEqual(['end', 'start'])
    const publicEvent = await getPublicTeamEventType(s.pub, s.page)
    expect(publicEvent.schedulingType).toBe('round_robin')
    expect(publicEvent.hosts).toBeUndefined()
    for (const user of s.users) {
      expect(JSON.stringify(publicEvent)).not.toContain(user.id)
      expect(JSON.stringify(publicEvent)).not.toContain(user.email)
    }
    const winner = await book(s, '2026-11-02T11:15Z')
    expect(await host(winner.booking.id)).toBe(required(s.users[1]).id)
    expect(Object.keys(required(winner.booking.assignedHost)).sort()).toEqual(['name', 'timeZone'])
  })

  it('rotates deterministically, replays without reassignment, and does not rewind for cancel or history deletion', async () => {
    const s = await setup(3),
      ids = s.users.map((u) => u.id).sort(),
      key = randomUUID()
    const a = await book(s, undefined, key)
    const replay = await book(s, undefined, key)
    expect(replay.replayed).toBe(true)
    expect(replay.booking.assignedHost).toEqual(a.booking.assignedHost)
    expect(await host(a.booking.id)).toBe(ids[0])
    expect((await state(s))?.next_sequence).toBe('1')
    const b = await book(s, '2026-11-02T10:00Z'),
      c = await book(s, '2026-11-02T11:00Z')
    expect([await host(b.booking.id), await host(c.booking.id)]).toEqual(ids.slice(1))
    await cancelManagedBooking(s.pub, a.manageToken as string)
    await db.deleteFrom('bookings').where('id', '=', a.booking.id).execute()
    expect((await state(s))?.next_sequence).toBe('3')
    expect(await host((await book(s, '2026-11-02T12:00Z')).booking.id)).toBe(ids[0])
  })

  it('compares sequence values beyond Number precision without exposing them', async () => {
    const s = await setup(),
      ids = s.users.map((u) => u.id).sort()
    await db
      .updateTable('round_robin_state')
      .set({ next_sequence: '9007199254740995' })
      .where('event_type_id', '=', s.event.id)
      .execute()
    await db
      .updateTable('event_type_hosts')
      .set({ last_assigned_sequence: '9007199254740993' })
      .where('event_type_id', '=', s.event.id)
      .where('user_id', '=', required(ids[0]))
      .execute()
    await db
      .updateTable('event_type_hosts')
      .set({ last_assigned_sequence: '9007199254740992' })
      .where('event_type_id', '=', s.event.id)
      .where('user_id', '=', required(ids[1]))
      .execute()
    const created = await book(s)
    expect(await host(created.booking.id)).toBe(ids[1])
    expect((await state(s))?.next_sequence).toBe('9007199254740996')
    expect(JSON.stringify(created.booking)).not.toContain('900719925474099')
    expect(JSON.stringify(await getEventType(s.ctx, s.event.id))).not.toContain('sequence')
  })

  it('rolls fairness and all selected-host booking rows back when an integration fails', async () => {
    const s = await setup()
    await expect(
      createPublicTeamBooking(
        {
          ...s.pub,
          notify: async () => {
            throw new Error('Synthetic failure')
          },
        },
        request(s),
      ),
    ).rejects.toThrow('Synthetic failure')
    expect((await state(s))?.next_sequence).toBe('0')
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.event.id)
        .execute(),
    ).toEqual([])
    expect(
      (
        await db
          .selectFrom('event_type_hosts')
          .select('last_assigned_sequence')
          .where('event_type_id', '=', s.event.id)
          .execute()
      ).every((h) => h.last_assigned_sequence === '0'),
    ).toBe(true)
  })

  it('keeps the original assigned host and default schedule after mode/pool changes without advancing fairness', async () => {
    const s = await setup(),
      created = await book(s),
      assigned = await host(created.booking.id)
    const custom = await s.f.schedule(assigned, {
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '15:00', end: '16:00' }),
      isDefault: false,
    })
    await updateEventType(s.ctx, s.event.id, {
      schedulingType: 'individual',
      hosts: [{ userId: assigned }],
      scheduleId: custom,
    })
    const moved = await rescheduleManagedBooking(s.pub, created.manageToken as string, {
      start: instant('2026-11-02T10:00Z'),
    })
    expect(await host(moved.booking.id)).toBe(assigned)
    expect((await state(s))?.next_sequence).toBe('1')
    expect(moved.booking.assignedHost).toEqual(created.booking.assignedHost)
    expect(
      (await listManagedSlots(s.pub, moved.manageToken as string, range)).some(
        (slot) => slot.start === '2026-11-02T10:00:00.000Z',
      ),
    ).toBe(true)
    await expect(
      db
        .updateTable('bookings')
        .set({ hosts_use_default_schedule: false })
        .where('id', '=', moved.booking.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', assigned)
      .execute()
    expect(
      await code(() =>
        rescheduleManagedBooking(s.pub, moved.manageToken as string, {
          start: instant('2026-11-02T11:00Z'),
        }),
      ),
    ).toBe('booking_hosts_unavailable')
    expect((await cancelManagedBooking(s.pub, moved.manageToken as string)).status).toBe(
      'cancelled',
    )
  })

  for (const change of ['leave', 'unverify', 'delete'] as const)
    it(`does not assign an ineligible configured host (${change})`, async () => {
      const s = await setup(),
        ids = s.users.map((u) => u.id).sort(),
        withdrawn = required(ids[0])
      if (change === 'leave')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', s.team.id)
          .where('userId', '=', withdrawn)
          .execute()
      if (change === 'unverify')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', withdrawn)
          .execute()
      if (change === 'delete')
        await db.deleteFrom('auth.user').where('id', '=', withdrawn).execute()
      const created = await book(s)
      expect(await host(created.booking.id)).toBe(ids[1])
      expect((await state(s))?.next_sequence).toBe('1')
    })

  it('skips only known calendar unavailability and reports it when all slots are indeterminate', async () => {
    const s = await setup(),
      ids = s.users.map((u) => u.id).sort(),
      stale = required(ids[0]),
      fresh = required(ids[1])
    const calendar = await s.f.calendarBusy(stale, [])
    const connection = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', calendar.calendarId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('id', '=', connection.connection_id)
      .execute()
    expect((await listPublicTeamSlots(s.pub, { ...s.page, ...range })).length).toBeGreaterThan(0)
    expect(await host((await book(s)).booking.id)).toBe(fresh)
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{}' })
      .where('user_id', '=', fresh)
      .execute()
    expect(await code(() => listPublicTeamSlots(s.pub, { ...s.page, ...range }))).toBe(
      'calendar_sync_unavailable',
    )
    expect(await code(() => book(s, '2026-11-02T11:00Z'))).toBe('calendar_sync_unavailable')
    expect((await state(s))?.next_sequence).toBe('1')
  })

  it('shares candidate budget and serializes concurrent same-key or distinct-key requests', async () => {
    const s = await setup(2)
    await updateEventType(s.ctx, s.event.id, { slotStepMinutes: 1 })
    expect(
      await code(() =>
        listPublicTeamSlots(s.pub, {
          ...s.page,
          start: instant('2026-11-02T00:00Z'),
          end: instant('2026-11-12T00:00Z'),
        }),
      ),
    ).toBe('range_too_long')
    await updateEventType(s.ctx, s.event.id, { slotStepMinutes: 30 })
    const key = randomUUID(),
      same = await Promise.all([book(s, undefined, key), book(s, undefined, key)])
    expect(same[0]?.booking.id).toBe(same[1]?.booking.id)
    expect(same.filter((value) => value.replayed)).toHaveLength(1)
    expect((await state(s))?.next_sequence).toBe('1')
    const other = await book(s)
    expect(await host(other.booking.id)).not.toBe(await host(required(same[0]).booking.id))
    expect((await state(s))?.next_sequence).toBe('2')
    expect(await code(() => book(s))).toBe('slot_unavailable')
  })
  it('does not swallow an unknown schedule parse error after finding an available candidate', async () => {
    const s = await setup(),
      ids = s.users.map((u) => u.id).sort()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: '{"monday":"invalid"}' })
      .where('user_id', '=', required(ids[1]))
      .execute()
    await expect(listPublicTeamSlots(s.pub, { ...s.page, ...range })).rejects.toThrow()
    await expect(book(s)).rejects.toThrow()
    expect((await state(s))?.next_sequence).toBe('0')
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.event.id)
        .execute(),
    ).toEqual([])
  })

  it('gives one priority turn to a new member while preserving existing last sequences', async () => {
    const s = await setup(),
      a = await book(s),
      b = await book(s, '2026-11-02T10:00Z')
    const before = await db
      .selectFrom('event_type_hosts')
      .select(['user_id', 'last_assigned_sequence'])
      .where('event_type_id', '=', s.event.id)
      .orderBy('user_id')
      .execute()
    const newcomer = await createTestUser(db, 'New host')
    await s.f.member(newcomer.id, s.team.id)
    await s.f.schedule(newcomer.id, { timeZone: 'UTC' })
    await updateEventType(s.ctx, s.event.id, { hosts: [...s.event.hosts, { userId: newcomer.id }] })
    const updated = await db
      .selectFrom('event_type_hosts')
      .select(['user_id', 'last_assigned_sequence'])
      .where('event_type_id', '=', s.event.id)
      .where('user_id', '!=', newcomer.id)
      .orderBy('user_id')
      .execute()
    expect(updated).toEqual(before)
    expect(await host((await book(s, '2026-11-02T11:00Z')).booking.id)).toBe(newcomer.id)
    expect(await host((await book(s, '2026-11-02T12:00Z')).booking.id)).toBe(
      await host(a.booking.id),
    )
    expect(await host((await book(s, '2026-11-02T13:00Z')).booking.id)).toBe(
      await host(b.booking.id),
    )
    expect((await state(s))?.next_sequence).toBe('5')
  })

  for (const change of ['pool', 'unverify', 'leave'] as const)
    it(`rechecks ${change} committed while a booking waits for its complete advisory lock set`, async () => {
      const s = await setup(),
        ids = s.users.map((u) => u.id).sort()
      const blocker = await owned.pool.connect()
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `booking-host:${ids[0]}`,
      ])
      const pid = required(
        (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0],
      ).pid
      const pending = outcome(book(s))
      try {
        await waitForBlocker(pid)
        if (change === 'pool')
          await updateEventType(s.ctx, s.event.id, { hosts: [{ userId: required(ids[1]) }] })
        if (change === 'unverify')
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', required(ids[0]))
            .execute()
        if (change === 'leave')
          await db
            .deleteFrom('auth.member')
            .where('organizationId', '=', s.team.id)
            .where('userId', '=', required(ids[0]))
            .execute()
        await blocker.query('COMMIT')
        const result = await pending
        if (change === 'pool') {
          expect(result).toMatchObject({ error: { code: 'event_type_not_found' } })
          expect((await state(s))?.next_sequence).toBe('0')
        } else {
          expect(result).toHaveProperty('value')
          if ('value' in result) expect(await host(result.value.booking.id)).toBe(ids[1])
          expect((await state(s))?.next_sequence).toBe('1')
        }
      } finally {
        await blocker.query('ROLLBACK').catch(() => {})
        blocker.release()
        await pending
      }
    })

  for (const resource of ['event', 'organization'] as const)
    for (const withdrawal of ['demote', 'remove'] as const)
      it(`rechecks activation authority after ${resource} wait and administrator ${withdrawal}`, async () => {
        const s = await setup(2, false),
          actor = required(s.users[1])
        await db
          .updateTable('auth.member')
          .set({ role: 'admin' })
          .where('organizationId', '=', s.team.id)
          .where('userId', '=', actor.id)
          .execute()
        const blocker = await owned.pool.connect()
        await blocker.query('BEGIN')
        await blocker.query(
          resource === 'event'
            ? 'SELECT id FROM event_types WHERE id=$1 FOR UPDATE'
            : 'SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE',
          [resource === 'event' ? s.event.id : s.team.id],
        )
        const pid = required(
          (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0],
        ).pid
        const pending = outcome(
          activateRoundRobin(testContext(db, s.team.as(actor), now), s.event.id),
        )
        try {
          await waitForBlocker(pid)
          if (withdrawal === 'demote')
            await db
              .updateTable('auth.member')
              .set({ role: 'member' })
              .where('organizationId', '=', s.team.id)
              .where('userId', '=', actor.id)
              .execute()
          else
            await db
              .deleteFrom('auth.member')
              .where('organizationId', '=', s.team.id)
              .where('userId', '=', actor.id)
              .execute()
          await blocker.query('COMMIT')
          expect(await pending).toMatchObject({ error: { code: 'insufficient_role' } })
          expect(await state(s)).toBeUndefined()
          expect(await code(() => book(s))).toBe('event_type_not_found')
        } finally {
          await blocker.query('ROLLBACK').catch(() => {})
          blocker.release()
          await pending
        }
      })

  it('holds accepted administrator authority while waiting for fairness state, then lets revocation commit', async () => {
    const s = await setup(2, false),
      actor = required(s.users[1])
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', actor.id)
      .execute()
    await db.insertInto('round_robin_state').values({ event_type_id: s.event.id }).execute()
    const blocker = await owned.pool.connect(),
      revoker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query(
      'SELECT event_type_id FROM round_robin_state WHERE event_type_id=$1 FOR UPDATE',
      [s.event.id],
    )
    const statePid = required(
      (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0],
    ).pid
    const activation = outcome(
      activateRoundRobin(testContext(db, s.team.as(actor), now), s.event.id),
    )
    let revoked: Promise<unknown> | undefined
    try {
      await waitForBlocker(statePid)
      const activatePid = required(
        (
          await owned.pool.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
            [statePid],
          )
        ).rows[0],
      ).pid
      revoked = revoker.query(
        'UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3',
        ['member', s.team.id, actor.id],
      )
      await waitForBlocker(activatePid)
      await blocker.query('COMMIT')
      expect(await activation).toHaveProperty('value')
      await revoked
      expect((await state(s))?.enabled).toBe(true)
      expect(
        await code(() => activateRoundRobin(testContext(db, s.team.as(actor), now), s.event.id)),
      ).toBe('insufficient_role')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await activation
      await revoked
      revoker.release()
    }
  })

  it('serializes a shared host sorted last across events, then allows membership withdrawal', async () => {
    const s = await setup(3),
      ids = s.users.map((u) => u.id).sort(),
      shared = required(ids[2])
    await updateEventType(s.ctx, s.event.id, {
      hosts: [{ userId: required(ids[0]) }, { userId: shared }],
      bufferAfterMinutes: 15,
    })
    const other = await createEventType(s.ctx, {
      slug: 'other-round',
      title: 'Other',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [{ userId: required(ids[1]) }, { userId: shared }],
      bufferAfterMinutes: 15,
    })
    await activateRoundRobin(s.ctx, other.id)
    await db.deleteFrom('schedules').where('user_id', 'in', ids.slice(0, 2)).execute()
    let entered: () => void = () => {},
      release: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstPid = 0
    const first = createPublicTeamBooking(
      {
        ...s.pub,
        notify: async (trx) => {
          firstPid = required(
            await trx
              .selectNoFrom((eb) => eb.fn<number>('pg_backend_pid', []).as('pid'))
              .executeTakeFirst(),
          ).pid
          entered()
          await held
        },
      },
      request(s),
    )
    await reached
    const second = outcome(
      createPublicTeamBooking(s.pub, { ...request(s, '2026-11-02T09:30Z'), slug: other.slug }),
    )
    try {
      await waitForBlocker(firstPid)
    } finally {
      release()
    }
    const created = await first
    expect(await host(created.booking.id)).toBe(shared)
    expect(await second).toMatchObject({ error: { code: 'slot_unavailable' } })
    expect((await state(s))?.next_sequence).toBe('1')
    expect(
      (
        await db
          .selectFrom('round_robin_state')
          .select('next_sequence')
          .where('event_type_id', '=', other.id)
          .executeTakeFirst()
      )?.next_sequence,
    ).toBe('0')
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', shared)
      .execute()
    expect(
      await code(() =>
        rescheduleManagedBooking(s.pub, created.manageToken as string, {
          start: instant('2026-11-02T10:00Z'),
        }),
      ),
    ).toBe('booking_hosts_unavailable')
  })
  it('unions DST-fold intervals as distinct instants and deduplicates the complete interval', async () => {
    const s = await setup()
    await db
      .updateTable('schedules')
      .set({
        time_zone: 'America/New_York',
        weekly_hours: '{"sunday":[{"start":"01:00","end":"03:00"}]}',
      })
      .where(
        'user_id',
        'in',
        s.users.map((u) => u.id),
      )
      .execute()
    // The engine offers the earlier occurrence of a repeated local wall time.
    // A UTC host supplies the later fold instants; union must keep both as distinct.
    await db
      .updateTable('schedules')
      .set({ time_zone: 'UTC', weekly_hours: '{"sunday":[{"start":"06:00","end":"07:00"}]}' })
      .where('user_id', '=', required(s.users[1]).id)
      .execute()
    const result = await listPublicTeamSlots(
      { db, now: () => instant('2026-10-30T00:00Z') },
      { ...s.page, start: instant('2026-11-01T00:00Z'), end: instant('2026-11-02T00:00Z') },
    )
    expect(result.map((s) => s.start)).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T07:30:00.000Z',
    ])
    expect(new Set(result.map((s) => `${s.start}/${s.end}`)).size).toBe(result.length)
  })

  it('keeps each host daily cap under concurrent distinct-key allocation', async () => {
    const s = await setup()
    await updateEventType(s.ctx, s.event.id, { maxBookingsPerDay: 1 })
    const results = await Promise.all(
      ['09:00', '10:00', '11:00'].map((time) => outcome(book(s, `2026-11-02T${time}Z`))),
    )
    const successes = results.flatMap((r) => ('value' in r ? [r.value] : []))
    expect(successes).toHaveLength(2)
    expect(new Set(await Promise.all(successes.map((r) => host(r.booking.id)))).size).toBe(2)
    expect(results.filter((r) => 'error' in r)).toEqual([
      { error: expect.objectContaining({ code: 'slot_unavailable' }) },
    ])
    expect((await state(s))?.next_sequence).toBe('2')
  })

  it('retains accepted verified membership until the selected booking has committed', async () => {
    const s = await setup(1)
    let entered: () => void = () => {},
      release: () => void = () => {},
      pid = 0
    const reached = new Promise<void>((resolve) => {
        entered = resolve
      }),
      held = new Promise<void>((resolve) => {
        release = resolve
      })
    const pending = createPublicTeamBooking(
      {
        ...s.pub,
        notify: async (trx) => {
          pid = required(
            await trx
              .selectNoFrom((eb) => eb.fn<number>('pg_backend_pid', []).as('pid'))
              .executeTakeFirst(),
          ).pid
          entered()
          await held
        },
      },
      request(s),
    )
    await reached
    const revoker = await owned.pool.connect()
    const withdrawn = revoker.query(
      'DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2',
      [s.team.id, s.owner.id],
    )
    try {
      await waitForBlocker(pid)
    } finally {
      release()
    }
    const booked = await pending
    await withdrawn
    revoker.release()
    expect(await host(booked.booking.id)).toBe(s.owner.id)
    expect((await state(s))?.next_sequence).toBe('1')
    expect(await code(() => book(s, '2026-11-02T10:00Z'))).toBe('event_type_not_found')
    expect((await cancelManagedBooking(s.pub, booked.manageToken as string)).status).toBe(
      'cancelled',
    )
  })
})
