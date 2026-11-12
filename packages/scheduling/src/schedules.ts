// The caller's schedules (working hours) and their per-date overrides. They belong to the
// user and follow them across organizations; each user has at most one default schedule,
// which event types use unless a host names another.
import { createHash } from 'node:crypto'
import {
  validateDate,
  validateDayIntervals,
  validateWeeklyHours,
  type WallClockInterval,
  type WeeklyHours,
} from '@hourmere/core'
import type { InterfaceLanguage } from '@hourmere/core/language'
import type { Db, Json } from '@hourmere/db'
import { sql } from 'kysely'
import {
  type CatalogPage,
  type CatalogPageInput,
  catalogPage,
  checkedCatalogPage,
} from './catalog-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { engineValidation, isUuid, jsonb, timestamp, validTimeZone } from './internal.ts'
import { cleanText } from './text.ts'

export interface Schedule {
  id: string
  name: string
  /** IANA time zone the weekly hours and overrides are read in. */
  timeZone: string
  weeklyHours: WeeklyHours
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface ScheduleInput {
  name: string
  timeZone: string
  weeklyHours: WeeklyHours
  /** The user's first schedule is always the default. */
  isDefault?: boolean | undefined
}

export type ScheduleUpdate = Partial<ScheduleInput>

/** Replacement hours for one local date; no intervals = unavailable all day. */
export interface ScheduleOverride {
  /** `YYYY-MM-DD` in the schedule's time zone. */
  date: string
  intervals: WallClockInterval[]
}

/** A consistent editor snapshot and opaque optimistic concurrency token. */
export interface ScheduleAvailability {
  schedule: Schedule
  overrides: ScheduleOverride[]
  version: string
}

export interface ScheduleAvailabilityInput extends ScheduleInput {
  /** Token returned by getScheduleAvailability; stale writes fail without changing either part. */
  expectedVersion: string
  /** Complete replacement, including past dates. Omitted dates revert to weekly hours. */
  overrides: ScheduleOverride[]
}

/** Read both parts under the same lock used by every schedule writer. */
export async function getScheduleAvailability(
  ctx: ServiceContext,
  id: string,
): Promise<ScheduleAvailability> {
  return ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, ctx.principal.user.id)
    return availabilitySnapshot(trx, ctx, id)
  })
}

// Keep the three-parameter-per-row insert safely below PostgreSQL’s bind limit.
export const MAX_SCHEDULE_OVERRIDES = 10_000

/** Save the entire editor in one transaction, refusing stale or replayed snapshots. */
export async function saveScheduleAvailability(
  ctx: ServiceContext,
  id: string,
  input: ScheduleAvailabilityInput,
): Promise<ScheduleAvailability> {
  if (Array.isArray(input.overrides) && input.overrides.length > MAX_SCHEDULE_OVERRIDES) {
    throw new DomainError('invalid', 'too_many_overrides')
  }
  const name = validName(input.name)
  const timeZone = validTimeZone(input.timeZone)
  const weeklyHours = validWeeklyHours(input.weeklyHours)
  const isDefault = validIsDefault(input.isDefault)
  if (typeof input.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedVersion)) {
    throw new DomainError('invalid', 'invalid_schedule_version')
  }
  if (!Array.isArray(input.overrides)) {
    throw new DomainError('invalid', 'invalid_schedule_overrides')
  }
  const dates = new Set<string>()
  const overrides = input.overrides.map((override) => {
    const date = validDate(override?.date, 'date')
    if (dates.has(date)) throw new DomainError('invalid', 'duplicate_override_date')
    dates.add(date)
    return { date, intervals: validIntervals(override.intervals, 'intervals') }
  })
  return ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, ctx.principal.user.id)
    const current = await availabilitySnapshot(trx, ctx, id)
    if (current.version !== input.expectedVersion) {
      throw new DomainError(
        'conflict',
        'schedule_conflict',
        'Availability changed; reload before saving',
      )
    }
    if (isDefault === false && current.schedule.isDefault) {
      throw new DomainError(
        'conflict',
        'schedule_is_default',
        'Make another schedule the default instead',
      )
    }
    if (isDefault === true && !current.schedule.isDefault) {
      await unsetDefault(trx, ctx.principal.user.id)
    }
    await trx
      .updateTable('schedules')
      .set({
        name,
        time_zone: timeZone,
        weekly_hours: jsonb(weeklyHours),
        ...(isDefault !== undefined && { is_default: isDefault }),
      })
      .where('id', '=', id)
      .execute()
    await trx.deleteFrom('schedule_overrides').where('schedule_id', '=', id).execute()
    if (overrides.length > 0) {
      await trx
        .insertInto('schedule_overrides')
        .values(
          overrides.map((override) => ({
            schedule_id: id,
            date: override.date,
            intervals: jsonb(override.intervals),
          })),
        )
        .execute()
    }
    return availabilitySnapshot(trx, ctx, id)
  })
}

async function availabilitySnapshot(
  db: Db,
  ctx: ServiceContext,
  id: string,
): Promise<ScheduleAvailability> {
  const row = await ownSchedule(db, ctx, id)
  // Keep PostgreSQL's full timestamp precision; JS Date would lose microseconds.
  // xmin also changes for same-content updates, preventing replay and change/revert ABA.
  const revision = await db
    .selectFrom('schedules')
    .select([
      sql<string>`updated_at::text`.as('updated'),
      sql<string>`xmin::text`.as('transaction'),
    ])
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow()
  const overrides = (
    await db
      .selectFrom('schedule_overrides')
      .select(['date', 'intervals'])
      .where('schedule_id', '=', row.id)
      .orderBy('date')
      .execute()
  ).map(toOverride)
  const schedule = toSchedule(row)
  const version = createHash('sha256')
    .update(JSON.stringify({ schedule, overrides, revision }))
    .digest('hex')
  return { schedule, overrides, version }
}

export const SCHEDULE_NAME_MAX_LENGTH = 100

const notFound = () => new DomainError('not_found', 'schedule_not_found')

/** The caller's schedules, oldest first. */
export async function listSchedules(ctx: ServiceContext): Promise<Schedule[]> {
  const rows = await ctx.db
    .selectFrom('schedules')
    .selectAll()
    .where('user_id', '=', ctx.principal.user.id)
    .orderBy('id')
    .execute()
  return rows.map(toSchedule)
}

export async function getSchedule(ctx: ServiceContext, id: string): Promise<Schedule> {
  return toSchedule(await ownSchedule(ctx.db, ctx, id))
}

export type ScheduleSummary = Pick<Schedule, 'id' | 'name' | 'timeZone' | 'isDefault'>

/** Compact, bounded discovery of the caller's schedules, which follow them across organizations. */
export async function listScheduleCatalog(
  ctx: ServiceContext,
  input: CatalogPageInput = {},
): Promise<CatalogPage<ScheduleSummary>> {
  const { limit, after } = checkedCatalogPage(input)
  let query = ctx.db
    .selectFrom('schedules')
    .select(['id', 'name', 'time_zone', 'is_default'])
    .where('user_id', '=', ctx.principal.user.id)
  if (after !== undefined) query = query.where('id', '>', after)
  const rows = await query
    .orderBy('id')
    .limit(limit + 1)
    .execute()
  return catalogPage(
    rows.map((r) => ({ id: r.id, name: r.name, timeZone: r.time_zone, isDefault: r.is_default })),
    limit,
  )
}

/**
 * Creates a schedule. It becomes the default when asked to or when the user has no
 * default yet (their first schedule); the previous default then stops being one.
 */
export async function createSchedule(ctx: ServiceContext, input: ScheduleInput): Promise<Schedule> {
  const name = validName(input.name)
  const timeZone = validTimeZone(input.timeZone)
  const weeklyHours = validWeeklyHours(input.weeklyHours)
  const isDefault = validIsDefault(input.isDefault) ?? false
  const userId = ctx.principal.user.id
  const row = await ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, userId)
    const hasDefault = await trx
      .selectFrom('schedules')
      .select('id')
      .where('user_id', '=', userId)
      .where('is_default', '=', true)
      .executeTakeFirst()
    if (hasDefault && isDefault) await unsetDefault(trx, userId)
    return trx
      .insertInto('schedules')
      .values({
        user_id: userId,
        name,
        time_zone: timeZone,
        weekly_hours: jsonb(weeklyHours),
        is_default: isDefault || !hasDefault,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  })
  return toSchedule(row)
}

/**
 * Confirms starter working hours after personal profile setup. Repeated confirmations
 * return the existing default unchanged; any existing schedules without a default need
 * the user's explicit choice in the availability editor instead. The interface language
 * at confirmation names a new schedule; later language changes do not rename it.
 */
export async function confirmDefaultSchedule(
  ctx: ServiceContext,
  language: InterfaceLanguage = 'en',
): Promise<{ schedule: Schedule; created: boolean }> {
  const userId = ctx.principal.user.id
  return ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, userId)
    // Read stored identity and time zone: a caller's session/API-key name can be stale.
    const profile = await trx
      .selectFrom('profiles')
      .innerJoin('auth.user', 'auth.user.id', 'profiles.user_id')
      .select(['auth.user.name', 'profiles.time_zone'])
      .where('profiles.user_id', '=', userId)
      .executeTakeFirst()
    if (!profile?.name.trim()) {
      throw new DomainError(
        'conflict',
        'setup_profile_required',
        'Complete your profile and display name before confirming working hours',
      )
    }
    const schedules = await trx
      .selectFrom('schedules')
      .selectAll()
      .where('user_id', '=', userId)
      .execute()
    const existing = schedules.find((schedule) => schedule.is_default)
    if (existing) return { schedule: toSchedule(existing), created: false }
    if (schedules.length > 0) {
      throw new DomainError(
        'conflict',
        'setup_default_schedule_required',
        'Choose an existing schedule as your default in Availability',
      )
    }
    const weeklyHours: WeeklyHours = {
      monday: [{ start: '09:00', end: '17:00' }],
      tuesday: [{ start: '09:00', end: '17:00' }],
      wednesday: [{ start: '09:00', end: '17:00' }],
      thursday: [{ start: '09:00', end: '17:00' }],
      friday: [{ start: '09:00', end: '17:00' }],
    }
    const row = await trx
      .insertInto('schedules')
      .values({
        user_id: userId,
        name: language === 'zh-CN' ? '工作时间' : 'Working hours',
        time_zone: validTimeZone(profile.time_zone),
        weekly_hours: jsonb(weeklyHours),
        is_default: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { schedule: toSchedule(row), created: true }
  })
}

/**
 * Changes the given fields. `isDefault: true` makes this the default (and the previous
 * default an ordinary schedule); the default cannot be unset directly, only replaced
 * (409 `schedule_is_default`), so event types always have a schedule to fall back to.
 */
export async function updateSchedule(
  ctx: ServiceContext,
  id: string,
  input: ScheduleUpdate,
): Promise<Schedule> {
  const changes: { name?: string; time_zone?: string; weekly_hours?: string } = {}
  if (input.name !== undefined) changes.name = validName(input.name)
  if (input.timeZone !== undefined) changes.time_zone = validTimeZone(input.timeZone)
  if (input.weeklyHours !== undefined)
    changes.weekly_hours = jsonb(validWeeklyHours(input.weeklyHours))
  const isDefault = validIsDefault(input.isDefault)
  const userId = ctx.principal.user.id
  const row = await ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, userId)
    const current = await ownSchedule(trx, ctx, id)
    if (isDefault === false && current.is_default) {
      throw new DomainError(
        'conflict',
        'schedule_is_default',
        'Make another schedule the default instead',
      )
    }
    const makeDefault = isDefault === true && !current.is_default
    if (makeDefault) await unsetDefault(trx, userId)
    if (!makeDefault && Object.keys(changes).length === 0) return current
    return trx
      .updateTable('schedules')
      .set({ ...changes, ...(makeDefault && { is_default: true }) })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow()
  })
  return toSchedule(row)
}

/**
 * Deletes a schedule with its overrides. Event types that used it fall back to their
 * host's default schedule. The default schedule can only be deleted when it is the
 * user's last one (409 `schedule_is_default` otherwise).
 */
export async function deleteSchedule(ctx: ServiceContext, id: string): Promise<void> {
  const userId = ctx.principal.user.id
  await ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, userId)
    const current = await ownSchedule(trx, ctx, id)
    if (current.is_default) {
      const other = await trx
        .selectFrom('schedules')
        .select('id')
        .where('user_id', '=', userId)
        .where('id', '<>', current.id)
        .executeTakeFirst()
      if (other) {
        throw new DomainError(
          'conflict',
          'schedule_is_default',
          'Make another schedule the default before deleting this one',
        )
      }
    }
    await trx.deleteFrom('schedules').where('id', '=', current.id).execute()
  })
}

/** Overrides of one of the caller's schedules, by date; `from` and `to` are inclusive. */
export async function listScheduleOverrides(
  ctx: ServiceContext,
  scheduleId: string,
  range: { from?: string | undefined; to?: string | undefined } = {},
): Promise<ScheduleOverride[]> {
  const from = range.from === undefined ? undefined : validDate(range.from, 'from')
  const to = range.to === undefined ? undefined : validDate(range.to, 'to')
  if (from !== undefined && to !== undefined && from > to) {
    throw new DomainError('invalid', 'invalid_date_range', 'from must not be after to')
  }
  const schedule = await ownSchedule(ctx.db, ctx, scheduleId)
  let query = ctx.db
    .selectFrom('schedule_overrides')
    .select(['date', 'intervals'])
    .where('schedule_id', '=', schedule.id)
    .orderBy('date')
  if (from !== undefined) query = query.where('date', '>=', from)
  if (to !== undefined) query = query.where('date', '<=', to)
  return (await query.execute()).map(toOverride)
}

/**
 * Sets the hours of one date of one of the caller's schedules, replacing any override it
 * had. `created` tells whether the date had none.
 */
export async function putScheduleOverride(
  ctx: ServiceContext,
  scheduleId: string,
  date: string,
  intervals: readonly WallClockInterval[],
): Promise<{ override: ScheduleOverride; created: boolean }> {
  const day = validDate(date, 'date')
  const hours = jsonb(validIntervals(intervals, 'intervals'))
  return ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, ctx.principal.user.id)
    const schedule = await ownSchedule(trx, ctx, scheduleId)
    const row = await trx
      .insertInto('schedule_overrides')
      .values({ schedule_id: schedule.id, date: day, intervals: hours })
      .onConflict((oc) => oc.columns(['schedule_id', 'date']).doUpdateSet({ intervals: hours }))
      .returning(['date', 'intervals', sql<boolean>`old.schedule_id IS NULL`.as('created')])
      .executeTakeFirstOrThrow()
    await touchSchedule(trx, schedule.id)
    return { override: toOverride(row), created: row.created }
  })
}

/** Removes the override of one date, so the weekly hours apply again. */
export async function deleteScheduleOverride(
  ctx: ServiceContext,
  scheduleId: string,
  date: string,
): Promise<void> {
  const day = validDate(date, 'date')
  await ctx.db.transaction().execute(async (trx) => {
    await lockSchedulesOf(trx, ctx.principal.user.id)
    const schedule = await ownSchedule(trx, ctx, scheduleId)
    const result = await trx
      .deleteFrom('schedule_overrides')
      .where('schedule_id', '=', schedule.id)
      .where('date', '=', day)
      .executeTakeFirst()
    if (result.numDeletedRows === 0n) {
      throw new DomainError('not_found', 'schedule_override_not_found')
    }
    await touchSchedule(trx, schedule.id)
  })
}

// The existing updated_at trigger advances the parent revision for legacy override writes.
async function touchSchedule(db: Db, id: string) {
  await db.updateTable('schedules').set({ updated_at: sql`now()` }).where('id', '=', id).execute()
}

type ScheduleRow = Awaited<ReturnType<typeof ownSchedule>>

/** One of the caller's schedules; another user's is as good as missing. */
async function ownSchedule(db: Db, ctx: ServiceContext, id: string) {
  if (!isUuid(id)) throw notFound()
  const row = await db
    .selectFrom('schedules')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', ctx.principal.user.id)
    .executeTakeFirst()
  if (!row) throw notFound()
  return row
}

/**
 * Serializes changes to one user's set of schedules, so two requests cannot both decide
 * that a schedule is the first (default) one or that the default is not the last one.
 * Held until the transaction ends.
 */
async function lockSchedulesOf(trx: Db, userId: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.schedules:${userId}`}, 0))`.execute(
    trx,
  )
}

async function unsetDefault(trx: Db, userId: string) {
  // Before setting the new default: the partial unique index allows one per user.
  await trx
    .updateTable('schedules')
    .set({ is_default: false })
    .where('user_id', '=', userId)
    .where('is_default', '=', true)
    .execute()
}

/** One line of text (see text.ts). */
function validName(value: unknown): string {
  const name = cleanText(value, { max: SCHEDULE_NAME_MAX_LENGTH })
  if (name === undefined) {
    throw new DomainError(
      'invalid',
      'invalid_schedule',
      `name must be one line of 1–${SCHEDULE_NAME_MAX_LENGTH} characters without control characters`,
    )
  }
  return name
}

function validIsDefault(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new DomainError('invalid', 'invalid_schedule', 'isDefault must be true or false')
  }
  return value
}

/** Checked by the engine's own rules; stored with only `start` and `end`. */
function validWeeklyHours(value: unknown): WeeklyHours {
  engineValidation('invalid_weekly_hours', () => validateWeeklyHours(value))
  const days = Object.entries(value as WeeklyHours).filter(([, intervals]) => intervals)
  return Object.fromEntries(
    days.map(([day, intervals]) => [
      day,
      (intervals ?? []).map(({ start, end }) => ({ start, end })),
    ]),
  )
}

function validIntervals(value: unknown, path: string): WallClockInterval[] {
  engineValidation('invalid_intervals', () => validateDayIntervals(value, path))
  return (value as readonly WallClockInterval[]).map(({ start, end }) => ({ start, end }))
}

/** A `YYYY-MM-DD` date Postgres can store (it has no year 0). */
function validDate(value: unknown, path: string): string {
  const date = engineValidation('invalid_date', () => validateDate(value, path))
  if (date < '0001-01-01') {
    throw new DomainError('invalid', 'invalid_date', `${path} must be in the years 0001 to 9999`)
  }
  return date
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    weeklyHours: row.weekly_hours as WeeklyHours,
    isDefault: row.is_default,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function toOverride(row: { date: string; intervals: Json }): ScheduleOverride {
  return { date: row.date, intervals: row.intervals as unknown as WallClockInterval[] }
}
