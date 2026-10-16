// Test support for service and route tests, in a throwaway database (see
// @hourmere/db/testing):
// - createTestUser / createTestTeam: real users, personal organizations and teams, and the
//   principals a resolver would produce for them;
// - createFixtures: rows for the scheduling tables written with plain SQL, so tests set up
//   hosts, schedules and event types without depending on the owner-side services.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { ensurePersonalOrganization, type Principal } from '@hourmere/auth'
import type { WallClockInterval, WeeklyHours } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'

export interface TestUser {
  id: string
  name: string
  email: string
  /** The user acting in their personal organization through an API key. */
  principal: Principal
}

export interface TestTeam {
  id: string
  /** `user` acting in this team; they must be one of its members. */
  as: (user: TestUser) => Principal
}

const unique = () => randomBytes(4).toString('hex')

/** Inserts a verified user with their personal organization. */
export async function createTestUser(db: Db, name = 'Test User'): Promise<TestUser> {
  const email = `${unique()}@example.com`
  const { id } = await db
    .insertInto('auth.user')
    .values({ name, email, emailVerified: true })
    .returning('id')
    .executeTakeFirstOrThrow()
  const organizationId = await ensurePersonalOrganization(db, id)
  const organization = await db
    .selectFrom('auth.organization')
    .select(['id', 'name', 'slug'])
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow()
  const user = { id, name, email }
  return {
    ...user,
    principal: {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      user,
      organization: { ...organization, personal: true },
    },
  }
}

/** Inserts a team organization with these members; roles as Better Auth stores them. */
export async function createTestTeam(
  db: Db,
  members: { user: TestUser; role: string }[],
  name = 'Test Team',
): Promise<TestTeam> {
  const createdAt = new Date()
  const organization = await db
    .insertInto('auth.organization')
    .values({ name, slug: `team-${unique()}`, createdAt })
    .returning(['id', 'name', 'slug'])
    .executeTakeFirstOrThrow()
  if (members.length) {
    await db
      .insertInto('auth.member')
      .values(
        members.map(({ user, role }) => ({
          organizationId: organization.id,
          userId: user.id,
          role,
          createdAt,
        })),
      )
      .execute()
  }
  return {
    id: organization.id,
    as: (user) => ({ ...user.principal, organization: { ...organization, personal: false } }),
  }
}

/** Runs `fn` and returns the DomainError it throws; fails if it throws anything else. */
export async function domainError(fn: () => Promise<unknown>): Promise<DomainError> {
  const error = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof DomainError)) {
    throw new Error(`expected a DomainError, got ${inspect(error)}`)
  }
  return error
}

/** A ServiceContext for `principal`, with the real clock unless one is given. */
export function testContext(
  db: Db,
  principal: Principal,
  now: () => Temporal.Instant = () => Temporal.Now.instant(),
): ServiceContext {
  return { db, principal, now }
}

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

  /**
   * Busy intervals mirrored into one new calendar of the user. Bounds are Postgres range
   * bounds, so `-infinity` and `infinity` work too.
   */
  async function calendarBusy(
    userId: string,
    intervals: [string, string][],
    { checkConflicts = true }: { checkConflicts?: boolean } = {},
  ): Promise<{ calendarId: string; externalEventIds: string[] }> {
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
    const externalEventIds: string[] = []
    for (const [start, end] of intervals) {
      const externalEventId = `evt-${unique()}`
      externalEventIds.push(externalEventId)
      await db
        .insertInto('calendar_busy')
        .values({
          calendar_id: calendar.id,
          external_event_id: externalEventId,
          period: `[${start},${end})`,
        })
        .execute()
    }
    return { calendarId: calendar.id, externalEventIds }
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
