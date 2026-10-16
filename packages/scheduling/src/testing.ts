// Test support: rows for the scheduling tables written with plain SQL, so service and route
// tests set up hosts, schedules and event types without depending on the owner-side services.
import { createHash, randomBytes } from 'node:crypto'
import type { WallClockInterval, WeeklyHours } from '@hourmere/core'
import type { Db } from '@hourmere/db'

export interface EventTypeFixture {
  slug?: string
  title?: string
  description?: string | null
  durationMinutes?: number
  slotStepMinutes?: number | null
  bufferBeforeMinutes?: number
  bufferAfterMinutes?: number
  minimumNoticeMinutes?: number
  bookingWindowDays?: number | null
  maxBookingsPerDay?: number | null
  location?: Record<string, unknown> | null
  questions?: unknown[]
  isActive?: boolean
  deletedAt?: string | null
  /** Hosts with their per-event-type schedule (null = default). Defaults to the owner. */
  hosts?: { userId: string; scheduleId?: string | null }[]
}

export const weekdays = (...intervals: WallClockInterval[]): WeeklyHours => ({
  monday: intervals,
  tuesday: intervals,
  wednesday: intervals,
  thursday: intervals,
  friday: intervals,
})

export function createFixtures(db: Db) {
  let seq = 0
  const unique = () => `${++seq}${randomBytes(3).toString('hex')}`

  async function user(name = 'Host'): Promise<string> {
    const row = await db
      .insertInto('auth.user')
      .values({ name, email: `user-${unique()}@example.com`, emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async function organization(slug = `org-${unique()}`): Promise<string> {
    const row = await db
      .insertInto('auth.organization')
      .values({ name: slug, slug, createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  async function member(userId: string, organizationId: string, role = 'member'): Promise<void> {
    await db
      .insertInto('auth.member')
      .values({ userId, organizationId, role, createdAt: new Date() })
      .execute()
  }

  /** A user with a personal organization (as sign-up creates it) and, unless null, a profile. */
  async function host({
    name = 'Ada Lovelace',
    handle = `host-${unique()}`,
    timeZone = 'Europe/Berlin',
  }: {
    name?: string
    handle?: string | null
    timeZone?: string
  } = {}) {
    const userId = await user(name)
    const organizationId = await organization()
    await member(userId, organizationId, 'owner')
    await db
      .insertInto('personal_organizations')
      .values({ user_id: userId, organization_id: organizationId })
      .execute()
    if (handle !== null) {
      await db
        .insertInto('profiles')
        .values({ user_id: userId, handle, time_zone: timeZone })
        .execute()
    }
    return { userId, organizationId, handle: handle ?? '' }
  }

  async function schedule(
    userId: string,
    {
      timeZone = 'Europe/Berlin',
      weeklyHours = weekdays({ start: '09:00', end: '17:00' }),
      isDefault = true,
      overrides = [],
    }: {
      timeZone?: string
      weeklyHours?: WeeklyHours
      isDefault?: boolean
      overrides?: { date: string; intervals: WallClockInterval[] }[]
    } = {},
  ): Promise<string> {
    const row = await db
      .insertInto('schedules')
      .values({
        user_id: userId,
        name: `Schedule ${unique()}`,
        time_zone: timeZone,
        weekly_hours: JSON.stringify(weeklyHours),
        is_default: isDefault,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const o of overrides) {
      await db
        .insertInto('schedule_overrides')
        .values({ schedule_id: row.id, date: o.date, intervals: JSON.stringify(o.intervals) })
        .execute()
    }
    return row.id
  }

  async function eventType(
    organizationId: string,
    ownerUserId: string | null,
    o: EventTypeFixture = {},
  ): Promise<string> {
    const row = await db
      .insertInto('event_types')
      .values({
        organization_id: organizationId,
        owner_user_id: ownerUserId,
        slug: o.slug ?? `event-${unique()}`,
        title: o.title ?? 'Intro call',
        description: o.description ?? null,
        duration_minutes: o.durationMinutes ?? 30,
        slot_step_minutes: o.slotStepMinutes ?? null,
        buffer_before_minutes: o.bufferBeforeMinutes ?? 0,
        buffer_after_minutes: o.bufferAfterMinutes ?? 0,
        minimum_notice_minutes: o.minimumNoticeMinutes ?? 0,
        booking_window_days: o.bookingWindowDays ?? null,
        max_bookings_per_day: o.maxBookingsPerDay ?? null,
        location: o.location ? JSON.stringify(o.location) : null,
        questions: JSON.stringify(o.questions ?? []),
        is_active: o.isActive ?? true,
        deleted_at: o.deletedAt ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const hosts = o.hosts ?? (ownerUserId ? [{ userId: ownerUserId }] : [])
    for (const h of hosts) {
      await db
        .insertInto('event_type_hosts')
        .values({ event_type_id: row.id, user_id: h.userId, schedule_id: h.scheduleId ?? null })
        .execute()
    }
    return row.id
  }

  /** Busy intervals mirrored into one new calendar of the user. */
  async function calendarBusy(
    userId: string,
    intervals: [string, string][],
    { checkConflicts = true }: { checkConflicts?: boolean } = {},
  ): Promise<void> {
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: userId,
        provider: 'google',
        external_account_id: `acct-${unique()}`,
        credentials: Buffer.from('ciphertext'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: `cal-${unique()}`,
        name: 'Work',
        check_conflicts: checkConflicts,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const [start, end] of intervals) {
      await db
        .insertInto('calendar_busy')
        .values({
          calendar_id: calendar.id,
          external_event_id: `evt-${unique()}`,
          period: `[${start},${end})`,
        })
        .execute()
    }
  }

  /** A booking with its host rows, in one transaction as the application writes it. */
  async function booking(
    organizationId: string,
    hostUserIds: string[],
    start: string,
    end: string,
    {
      eventTypeId = null,
      status = 'confirmed',
      attendee = { name: 'Invitee', email: 'invitee@example.com' },
    }: {
      eventTypeId?: string | null
      status?: 'confirmed' | 'cancelled'
      attendee?: { name: string; email: string } | null
    } = {},
  ): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('bookings')
        .values({
          organization_id: organizationId,
          event_type_id: eventTypeId,
          status,
          cancelled_at: status === 'cancelled' ? new Date() : null,
          start_at: start,
          end_at: end,
          title: 'Fixture booking',
          manage_token_hash: createHash('sha256').update(unique()).digest(),
          source: 'api',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      for (const userId of hostUserIds) {
        await trx
          .insertInto('booking_hosts')
          .values({ booking_id: row.id, user_id: userId })
          .execute()
      }
      if (attendee) {
        await trx
          .insertInto('booking_attendees')
          .values({ booking_id: row.id, ...attendee, time_zone: 'UTC', is_booker: true })
          .execute()
      }
      return row.id
    })
  }

  return { user, organization, member, host, schedule, eventType, calendarBusy, booking }
}

export type Fixtures = ReturnType<typeof createFixtures>
