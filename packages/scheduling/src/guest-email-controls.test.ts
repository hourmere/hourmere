import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPublicEventType, getPublicTeamEventType } from './availability.ts'
import {
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext } from './context.ts'
import {
  createEventType,
  getEventType,
  listEventTypeCatalog,
  updateEventType,
} from './event-types.ts'
import { putProfile } from './profile.ts'
import { createSchedule } from './schedules.ts'
import { createTestTeam, createTestUser, domainError, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
const start = Temporal.Instant.from('2026-11-02T09:00Z')
const guest = { name: 'Guest', email: 'guest@example.com' }
const invitee = { name: 'Invitee', email: 'invitee@example.com', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('guest email controls', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(allowGuests?: boolean, teamPage = false) {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, now)
    const handle = `host-${randomUUID().slice(0, 8)}`
    await putProfile(ctx, { handle, timeZone: 'UTC', locale: 'en' })
    await createSchedule(ctx, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '12:00' }),
    })
    const team = teamPage ? await createTestTeam(db, [{ user, role: 'owner' }]) : undefined
    const admin = team ? testContext(db, team.as(user), now) : ctx
    const event = await createEventType(admin, {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
      ...(allowGuests === undefined ? {} : { allowGuests }),
    })
    const target = {
      handle: admin.principal.organization.personal ? handle : admin.principal.organization.slug,
      slug: event.slug,
    }
    const notify = vi.fn(async () => {})
    const pub = { db, now, notify }
    const book = (extra = {}, context: PublicContext = pub) =>
      (teamPage ? createPublicTeamBooking : createPublicBooking)(context, {
        ...target,
        start,
        invitee,
        guests: [guest],
        ...extra,
      })
    return { user, ctx: admin, event, target, pub, notify, book }
  }
  async function waitForBlocker(pid: number) {
    for (let i = 0; i < 500; i++) {
      const { rows } = await owned.pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
        [pid],
      )
      if (rows.length) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('no owned query waited for expected blocker')
  }
  it('defaults both service and raw SQL configurations to no guests', async () => {
    const s = await setup()
    expect(s.event.allowGuests).toBe(false)
    expect((await getPublicEventType(s.pub, s.target)).allowGuests).toBe(false)
    const { id } = await db
      .insertInto('event_types')
      .values({
        organization_id: s.event.organizationId,
        owner_user_id: s.user.id,
        slug: 'raw-default',
        title: 'Raw',
        duration_minutes: 30,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    expect(
      (await owned.pool.query('SELECT allow_guests FROM event_types WHERE id=$1', [id])).rows,
    ).toEqual([{ allow_guests: false }])
    expect((await domainError(() => s.book())).code).toBe('guests_not_allowed')
    expect(s.notify).not.toHaveBeenCalled()
    expect(
      (await owned.pool.query('SELECT id FROM bookings WHERE event_type_id=$1', [s.event.id])).rows,
    ).toEqual([])
    expect((await s.book({ guests: [] })).booking.attendees).toHaveLength(1)
  })
  it.each([false, true])(
    'blocks personal/team booking with no side effects (team=%s)',
    async (team) => {
      const s = await setup(false, team)
      const page = await (team ? getPublicTeamEventType : getPublicEventType)(s.pub, s.target)
      expect(page.allowGuests).toBe(false)
      expect((await domainError(() => s.book())).code).toBe('guests_not_allowed')
      expect(s.notify).not.toHaveBeenCalled()
      expect(
        (await owned.pool.query('SELECT id FROM bookings WHERE event_type_id=$1', [s.event.id]))
          .rows,
      ).toEqual([])
      await updateEventType(s.ctx, s.event.id, { allowGuests: true })
      expect((await s.book()).booking.attendees).toHaveLength(2)
      expect(s.notify).toHaveBeenCalledTimes(1)
    },
  )
  it('permits ten guests after opt-in, keeps the cap, and preserves the flag on unrelated edits', async () => {
    const s = await setup(true)
    expect((await updateEventType(s.ctx, s.event.id, { title: 'Renamed' })).allowGuests).toBe(true)
    expect((await listEventTypeCatalog(s.ctx)).data[0]?.allowGuests).toBe(true)
    const guests = Array.from({ length: 10 }, (_, i) => ({
      name: `Guest ${i}`,
      email: `guest${i}@example.com`,
    }))
    expect((await domainError(() => s.book({ guests: [...guests, guest] }))).code).toBe(
      'too_many_guests',
    )
    expect((await s.book({ guests })).booking.attendees).toHaveLength(11)
  })
  it('replays an existing guest booking after opt-out, while blocking fresh keys', async () => {
    const s = await setup(true)
    const idempotencyKey = randomUUID()
    const first = await s.book({ idempotencyKey })
    await updateEventType(s.ctx, s.event.id, { allowGuests: false })
    const again = await s.book({ idempotencyKey })
    expect(again).toEqual({ booking: first.booking, manageToken: null, replayed: true })
    expect(s.notify).toHaveBeenCalledTimes(1)
    expect((await domainError(() => s.book({ idempotencyKey: randomUUID() }))).code).toBe(
      'guests_not_allowed',
    )
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it('keeps old guest recipients on rescheduling and cancellation after opt-out', async () => {
    const s = await setup(true)
    const first = await s.book()
    await updateEventType(s.ctx, s.event.id, { allowGuests: false })
    const moved = await rescheduleManagedBooking(s.pub, first.manageToken as string, {
      start: start.add({ hours: 1 }),
    })
    expect(moved.booking.attendees).toEqual(first.booking.attendees)
    const cancelled = await cancelManagedBooking(s.pub, moved.manageToken as string)
    expect(cancelled.attendees).toEqual(first.booking.attendees)
    expect(cancelled.status).toBe('cancelled')
    expect(s.notify.mock.calls).toHaveLength(3)
  })
  it('rechecks opt-out after waiting for the host advisory lock', async () => {
    const s = await setup(true)
    const client = await owned.pool.connect()
    const key = `booking-host:${s.user.id}`
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const pending = s.book()
    pending.catch(() => {})
    try {
      await waitForBlocker(pid)
      await updateEventType(s.ctx, s.event.id, { allowGuests: false })
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
      client.release()
    }
    expect((await domainError(() => pending)).code).toBe('guests_not_allowed')
    expect(s.notify).not.toHaveBeenCalled()
  }, 10000)
  it('waits for an in-flight settings change and reads the committed opt-out', async () => {
    const s = await setup(true)
    const client = await owned.pool.connect()
    await client.query('BEGIN')
    await client.query('UPDATE event_types SET allow_guests=false WHERE id=$1', [s.event.id])
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    const pending = s.book()
    pending.catch(() => {})
    try {
      await waitForBlocker(pid)
    } finally {
      await client.query('COMMIT')
      client.release()
    }
    expect((await domainError(() => pending)).code).toBe('guests_not_allowed')
    expect(s.notify).not.toHaveBeenCalled()
  }, 10000)
  it.each([false, true])(
    'holds approval through commit before a settings update can finish (team=%s)',
    async (team) => {
      const s = await setup(true, team)
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const reached = new Promise<void>((r) => {
        entered = r
      })
      const pending = s.book(
        {},
        {
          ...s.pub,
          notify: async () => {
            entered()
            await gate
          },
        },
      )
      pending.catch(() => {})
      await reached
      const updater = await owned.pool.connect()
      const pid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      let finished = false
      const update = updater
        .query('UPDATE event_types SET allow_guests=false WHERE id=$1', [s.event.id])
        .then(() => {
          finished = true
        })
      update.catch(() => {})
      try {
        for (let i = 0; i < 500; i++) {
          const { rows } = await owned.pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
            [pid],
          )
          if (rows[0]?.wait_event_type === 'Lock') break
          if (i === 499) throw new Error('settings update was not blocked')
          await new Promise((r) => setTimeout(r, 10))
        }
        expect(finished).toBe(false)
      } finally {
        release()
        await pending
        await update
        updater.release()
      }
      expect((await getEventType(s.ctx, s.event.id)).allowGuests).toBe(false)
      expect((await pending).booking.attendees).toHaveLength(2)
    },
    10000,
  )
  it('limits opt-in to the owner/admin and the active organization', async () => {
    const owner = await createTestUser(db),
      member = await createTestUser(db),
      admin = await createTestUser(db),
      outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
      { user: admin, role: 'admin' },
    ])
    const ctx = (u: typeof owner) => testContext(db, team.as(u), now)
    const event = await createEventType(ctx(owner), {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
    })
    expect(
      (await domainError(() => updateEventType(ctx(member), event.id, { allowGuests: true }))).code,
    ).toBe('insufficient_role')
    expect(
      (
        await domainError(() =>
          updateEventType(testContext(db, outsider.principal), event.id, { allowGuests: true }),
        )
      ).code,
    ).toBe('event_type_not_found')
    expect((await updateEventType(ctx(admin), event.id, { allowGuests: true })).allowGuests).toBe(
      true,
    )
  })
  it.each([null, 'true', 0, {}, []].map((value) => [value]))(
    'refuses nonboolean allowGuests %j',
    async (value) => {
      const s = await setup()
      const allowGuests = value as unknown as boolean
      expect(
        (await domainError(() => updateEventType(s.ctx, s.event.id, { allowGuests }))).code,
      ).toBe('invalid_event_type')
      expect(
        (
          await domainError(() =>
            createEventType(s.ctx, { title: 'Bad', slug: 'bad', durationMinutes: 30, allowGuests }),
          )
        ).code,
      ).toBe('invalid_event_type')
      expect((await getEventType(s.ctx, s.event.id)).allowGuests).toBe(false)
    },
  )
})
