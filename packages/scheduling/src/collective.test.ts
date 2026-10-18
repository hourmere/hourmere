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
  createEventType,
  getEventType,
  listEventTypeHosts,
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

describe.skipIf(!serverUrl)('collective scheduling', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(count = 2) {
    const users = await Promise.all(
      Array.from({ length: count }, (_, index) => createTestUser(db, `Host ${index + 1}`)),
    )
    const owner = required(users[0])
    const team = await createTestTeam(
      db,
      users.map((user, index) => ({ user, role: index === 0 ? 'owner' : 'member' })),
    )
    const ctx = testContext(db, team.as(owner), now)
    const f = createFixtures(db)
    const schedules = await Promise.all(
      users.map((user) => f.schedule(user.id, { timeZone: 'UTC' })),
    )
    const event = await createEventType(ctx, {
      slug: 'collective',
      title: 'Interview',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts: users.map((u) => ({ userId: u.id })),
    })
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
  const range = { start: instant('2026-11-02T00:00Z'), end: instant('2026-11-03T00:00Z') }
  const booking = (
    s: Awaited<ReturnType<typeof setup>>,
    start = '2026-11-02T09:00Z',
    key = randomUUID(),
  ) =>
    createPublicTeamBooking(s.pub, {
      ...s.page,
      start: instant(start),
      idempotencyKey: key,
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
    })
  const code = async (fn: () => Promise<unknown>) => (await domainError(fn)).code

  it('assigns two to eight verified members, normalizes IDs, and preserves omitted configuration', async () => {
    const s = await setup(8)
    expect(s.event.hosts.map((h) => h.userId)).toEqual(s.users.map((u) => u.id).sort())
    expect(s.event.schedulingType).toBe('collective')
    const upper = s.users.map((u) => ({ userId: u.id.toUpperCase() }))
    expect((await updateEventType(s.ctx, s.event.id, { hosts: upper })).hosts).toEqual(
      s.event.hosts,
    )
    const updated = await updateEventType(s.ctx, s.event.id, { title: 'Changed' })
    expect(updated.hosts).toEqual(s.event.hosts)
    expect(updated.schedulingType).toBe('collective')
    expect(
      await code(() => updateEventType(s.ctx, s.event.id, { schedulingType: 'individual' })),
    ).toBe('invalid_hosts')
    expect(
      await code(() =>
        updateEventType(s.ctx, s.event.id, { hosts: [required(upper[0]), required(upper[0])] }),
      ),
    ).toBe('invalid_hosts')
    expect(
      await code(() =>
        updateEventType(s.ctx, s.event.id, { hosts: [...upper, { userId: randomUUID() }] }),
      ),
    ).toBe('invalid_hosts')
    expect(
      await code(() => updateEventType(s.ctx, s.event.id, { scheduleId: s.schedules[0] })),
    ).toBe('invalid_schedule_id')
    expect(
      await code(() =>
        updateEventType(testContext(db, s.team.as(required(s.users[1])), now), s.event.id, {
          hosts: upper,
        }),
      ),
    ).toBe('insufficient_role')
    const outsider = await createTestUser(db)
    expect(
      await code(() =>
        updateEventType(s.ctx, s.event.id, {
          hosts: [{ userId: s.owner.id }, { userId: outsider.id }],
        }),
      ),
    ).toBe('invalid_hosts')
    expect(
      await code(() =>
        createEventType(testContext(db, s.owner.principal, now), {
          slug: 'bad',
          title: 'Bad',
          durationMinutes: 30,
          schedulingType: 'collective',
          hosts: upper.slice(0, 2),
        }),
      ),
    ).toBe('invalid_hosts')
  })

  it('exposes only public names/timezones and paginates the privileged member directory', async () => {
    const s = await setup(3)
    const publicEvent = await getPublicTeamEventType(s.pub, s.page)
    expect(publicEvent.hosts).toHaveLength(3)
    const serialized = JSON.stringify(publicEvent)
    for (const u of s.users) {
      expect(serialized).not.toContain(u.id)
      expect(serialized).not.toContain(u.email)
    }
    expect(serialized).not.toContain(s.team.id)
    const first = await listEventTypeHosts(s.ctx, { limit: 2 })
    expect(first.data).toHaveLength(2)
    const next = await listEventTypeHosts(s.ctx, { limit: 2, after: required(first.nextAfter) })
    expect(next.data).toHaveLength(1)
    expect(new Set([...first.data, ...next.data].map((u) => u.id)).size).toBe(3)
    expect(
      await code(() => listEventTypeHosts(testContext(db, s.team.as(required(s.users[1])), now))),
    ).toBe('insufficient_role')
  })

  it('intersects full intervals, checks every host, and rejects mismatched grids', async () => {
    const s = await setup()
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '10:00', end: '12:00' })) })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    const slots = await listPublicTeamSlots(s.pub, { ...s.page, ...range })
    expect(slots).toHaveLength(4)
    expect(slots[0]?.start).toBe('2026-11-02T10:00:00.000Z')
    expect(await code(() => booking(s))).toBe('slot_unavailable')
    await db
      .updateTable('schedules')
      .set({ weekly_hours: JSON.stringify(weekdays({ start: '09:15', end: '12:15' })) })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    expect(await listPublicTeamSlots(s.pub, { ...s.page, ...range })).toEqual([])
    expect(await code(() => booking(s, '2026-11-02T09:30Z'))).toBe('slot_unavailable')
  })

  it('shares the candidate budget across hosts and handles DST in their own zones', async () => {
    const s = await setup()
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
    await db
      .updateTable('schedules')
      .set({
        time_zone: 'America/New_York',
        weekly_hours: JSON.stringify(weekdays({ start: '09:00', end: '10:00' })),
      })
      .where('id', '=', required(s.schedules[0]))
      .execute()
    await db
      .updateTable('schedules')
      .set({
        time_zone: 'Europe/Berlin',
        weekly_hours: JSON.stringify(weekdays({ start: '15:00', end: '16:00' })),
      })
      .where('id', '=', required(s.schedules[1]))
      .execute()
    expect(
      (await listPublicTeamSlots(s.pub, { ...s.page, ...range })).map((slot) => slot.start),
    ).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-02T14:30:00.000Z'])
  })

  it('records all hosts once, replays safely, and retains originals after configuration changes', async () => {
    const s = await setup()
    const key = randomUUID()
    const created = await booking(s, undefined, key)
    expect((await booking(s, undefined, key)).replayed).toBe(true)
    const row = await db
      .selectFrom('bookings')
      .select('required_host_user_ids')
      .where('id', '=', created.booking.id)
      .executeTakeFirstOrThrow()
    expect(row.required_host_user_ids).toEqual(s.users.map((u) => u.id).sort())
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', created.booking.id)
        .execute(),
    ).toHaveLength(2)
    await expect(
      db
        .updateTable('bookings')
        .set({ required_host_user_ids: [s.owner.id] })
        .where('id', '=', created.booking.id)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' })
    await updateEventType(s.ctx, s.event.id, {
      schedulingType: 'individual',
      hosts: [{ userId: s.owner.id }],
    })
    const moved = await rescheduleManagedBooking(s.pub, required(created.manageToken), {
      start: instant('2026-11-02T10:00Z'),
    })
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', moved.booking.id)
        .execute(),
    ).toHaveLength(2)
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('required_host_user_ids')
          .where('id', '=', moved.booking.id)
          .executeTakeFirstOrThrow()
      ).required_host_user_ids,
    ).toEqual(row.required_host_user_ids)
    const offered = await listManagedSlots(s.pub, required(moved.manageToken), range)
    expect(offered.some((slot) => slot.start === '2026-11-02T10:00:00.000Z')).toBe(true)
  })

  for (const change of ['leave', 'delete', 'unverify'] as const)
    it(`refuses rescheduling when an original required host is unavailable (${change}), while cancellation works`, async () => {
      const s = await setup()
      const created = await booking(s)
      const hostId = required(s.users[1]).id
      if (change === 'leave')
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', s.team.id)
          .where('userId', '=', hostId)
          .execute()
      if (change === 'delete') await db.deleteFrom('auth.user').where('id', '=', hostId).execute()
      if (change === 'unverify')
        await db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', hostId)
          .execute()
      expect(
        await code(() =>
          rescheduleManagedBooking(s.pub, required(created.manageToken), {
            start: instant('2026-11-02T10:00Z'),
          }),
        ),
      ).toBe('booking_hosts_unavailable')
      expect(await code(() => listManagedSlots(s.pub, required(created.manageToken), range))).toBe(
        'booking_hosts_unavailable',
      )
      expect((await cancelManagedBooking(s.pub, required(created.manageToken))).status).toBe(
        'cancelled',
      )
      expect((await getEventType(s.ctx, s.event.id)).id).toBe(s.event.id)
    })

  it('atomically rolls back booking and hosts if an in-transaction notification fails', async () => {
    const s = await setup()
    const error = new Error('synthetic notification rollback')
    await expect(
      createPublicTeamBooking(
        {
          ...s.pub,
          notify: async () => {
            throw error
          },
        },
        {
          ...s.page,
          start: instant('2026-11-02T09:00Z'),
          invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' },
        },
      ),
    ).rejects.toBe(error)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.event.id)
        .execute(),
    ).toEqual([])
  })

  it('serializes shared hosts so buffers and daily limits cannot race', async () => {
    const s = await setup()
    await updateEventType(s.ctx, s.event.id, { bufferAfterMinutes: 15 })
    const outcomes = await Promise.allSettled([booking(s), booking(s, '2026-11-02T09:30Z')])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', s.event.id)
        .execute(),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('booking_hosts as h')
        .innerJoin('bookings as b', 'b.id', 'h.booking_id')
        .select('h.user_id')
        .where('b.event_type_id', '=', s.event.id)
        .execute(),
    ).toHaveLength(2)
    const t = await setup()
    await updateEventType(t.ctx, t.event.id, { maxBookingsPerDay: 1 })
    const capped = await Promise.allSettled([booking(t), booking(t, '2026-11-02T11:00Z')])
    expect(capped.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('locks every shared host across different collective types, including a host sorted last', async () => {
    const s = await setup(3)
    const ids = s.users.map((user) => user.id).sort()
    const shared = required(ids[2])
    await updateEventType(s.ctx, s.event.id, {
      hosts: [{ userId: required(ids[0]) }, { userId: shared }],
      bufferAfterMinutes: 15,
    })
    const other = await createEventType(s.ctx, {
      slug: 'other',
      title: 'Other panel',
      durationMinutes: 30,
      bufferAfterMinutes: 15,
      schedulingType: 'collective',
      hosts: [{ userId: required(ids[1]) }, { userId: shared }],
    })
    let entered: () => void = () => {},
      release: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = createPublicTeamBooking(
      {
        ...s.pub,
        notify: async () => {
          entered()
          await held
        },
      },
      {
        ...s.page,
        start: instant('2026-11-02T09:00Z'),
        invitee: { name: 'First', email: 'first@example.com', timeZone: 'UTC' },
      },
    )
    await reached
    let secondDone = false
    const second = createPublicTeamBooking(s.pub, {
      ...s.page,
      slug: other.slug,
      start: instant('2026-11-02T09:30Z'),
      invitee: { name: 'Second', email: 'second@example.com', timeZone: 'UTC' },
    })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        secondDone = true
      })
    let blocked = false
    try {
      for (let attempt = 0; attempt < 100 && !secondDone; attempt++) {
        const result = await owned.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%') AS blocked",
        )
        if (result.rows[0]?.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally {
      release()
    }
    await first
    const outcome = await second
    expect(blocked).toBe(true)
    expect(outcome).toMatchObject({ error: { code: 'slot_unavailable' } })
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', s.team.id)
        .execute(),
    ).toHaveLength(1)
  })

  it('checks busy time and Google cursor freshness for a non-first host', async () => {
    const s = await setup()
    const hostId = required(s.event.hosts.at(-1)).userId
    const busy = await s.f.calendarBusy(hostId, [['2026-11-02T09:00Z', '2026-11-02T10:00Z']])
    expect(await code(() => booking(s))).toBe('slot_unavailable')
    const slots = await listPublicTeamSlots(s.pub, { ...s.page, ...range })
    expect(slots.some((slot) => slot.start === '2026-11-02T09:00:00.000Z')).toBe(false)
    const calendar = await db
      .selectFrom('calendars')
      .select('connection_id')
      .where('id', '=', busy.calendarId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('calendar_connections')
      .set({ provider: 'google' })
      .where('id', '=', calendar.connection_id)
      .execute()
    expect(await code(() => listPublicTeamSlots(s.pub, { ...s.page, ...range }))).toBe(
      'calendar_sync_unavailable',
    )
    expect(await code(() => booking(s, '2026-11-02T11:00Z'))).toBe('calendar_sync_unavailable')
  })

  it('rechecks administrator authority after waiting for the event configuration lock', async () => {
    const s = await setup()
    const actor = required(s.users[1])
    await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('organizationId', '=', s.team.id)
      .where('userId', '=', actor.id)
      .execute()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM event_types WHERE id=$1 FOR UPDATE', [s.event.id])
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid
    const update = updateEventType(testContext(db, s.team.as(actor), now), s.event.id, {
      title: 'Changed by former admin',
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        )
        if (rows.rows[0]?.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', s.team.id)
        .where('userId', '=', actor.id)
        .execute()
      await blocker.query('COMMIT')
      expect(await update).toMatchObject({ error: { code: 'insufficient_role' } })
      expect((await getEventType(s.ctx, s.event.id)).title).toBe('Interview')
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await update
    }
  })

  it('waits on the personal owner before its organization when account deletion is in progress', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, now)
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('DELETE FROM auth."user" WHERE id=$1', [user.id])
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid
    const create = createEventType(ctx, {
      slug: 'new',
      title: 'Personal',
      durationMinutes: 30,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        )
        if (rows.rows[0]?.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await blocker.query('COMMIT')
      expect(await create).toMatchObject({ error: { code: 'event_type_not_found' } })
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await create
    }
  })

  it('preserves legacy round-robin metadata without rewriting its assignments', async () => {
    const s = await setup()
    await db
      .updateTable('event_types')
      .set({ scheduling_type: 'round_robin' })
      .where('id', '=', s.event.id)
      .execute()
    const before = await getEventType(s.ctx, s.event.id)
    const updated = await updateEventType(s.ctx, s.event.id, { title: 'Legacy metadata' })
    expect(updated.schedulingType).toBe('round_robin')
    expect(updated.hosts).toEqual(before.hosts)
    expect(await code(() => updateEventType(s.ctx, s.event.id, { scheduleId: null }))).toBe(
      'invalid_hosts',
    )
    expect(await code(() => getPublicTeamEventType(s.pub, s.page))).toBe('event_type_not_found')
  })

  it('rechecks the complete configuration after waiting for the sorted host locks', async () => {
    const s = await setup()
    const blocker = await owned.pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `booking-host:${required(s.event.hosts[0]).userId}`,
    ])
    let outcome: Promise<unknown> | undefined
    try {
      outcome = booking(s).then(
        () => 'created',
        (error: unknown) => error,
      )
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        ?.pid
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const active = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        )
        if (active.rows[0]?.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await updateEventType(s.ctx, s.event.id, {
        schedulingType: 'individual',
        hosts: [{ userId: required(s.users[1]).id }],
      })
      await blocker.query('COMMIT')
      expect(await outcome).toMatchObject({ code: 'event_type_not_found' })
      expect(
        await db
          .selectFrom('bookings')
          .select('id')
          .where('event_type_id', '=', s.event.id)
          .execute(),
      ).toEqual([])
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      await outcome
    }
  })
})
