import {
  type DateOverride,
  validateDate,
  validateDayIntervals,
  validateTimeZone,
  validateWeeklyHours,
  type WallClockInterval,
  type Weekday,
} from '@hourmere/core'
import { cleanText } from '../../scheduling/src/text.ts'
import type { MatchedUser, PlanProblem, SourceRow, SourceSnapshot } from './types.ts'

export interface SchedulePlan {
  sourceId: number
  sourceUserId: number
  targetUserId: string
  name: string
  timeZone: string
  requiresTimezoneConfirmation: boolean
  sourceIsDefault: boolean
  /** Preserving an existing target default requires a later explicit decision. */
  isDefault: false
  weeklyHours: Record<Weekday, WallClockInterval[]>
  overrides: DateOverride[]
  valid: boolean
}
const weekdays: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]
const emptyWeek = (): Record<Weekday, WallClockInterval[]> => ({
  sunday: [],
  monday: [],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
})

function clock(value: unknown): { minutes: number; secondsLost: boolean } | null {
  const match =
    typeof value === 'string' ? /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value) : null
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59)
    return null
  return {
    minutes: Number(match[1]) * 60 + Number(match[2]),
    secondsLost: Number(match[3] ?? 0) !== 0 || Number(match[4] ?? 0) !== 0,
  }
}
const renderClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

function union(intervals: WallClockInterval[]): WallClockInterval[] {
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start))
  const result: { start: string; end: string }[] = []
  for (const interval of sorted) {
    const last = result.at(-1)
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end
    } else result.push({ ...interval })
  }
  return result
}

export function parseSchedules(
  snapshot: SourceSnapshot,
  matchedUsers: Map<number, MatchedUser>,
  problems: PlanProblem[],
): SchedulePlan[] {
  const plans: SchedulePlan[] = []
  const allAvailability = snapshot.tables.Availability ?? []
  for (const row of allAvailability.filter((a) => a.scheduleId == null)) {
    problems.push({
      code: 'availability_legacy_ignored',
      severity: 'excluded',
      source: { table: 'Availability', id: row.id as number },
      message:
        'Legacy user or event availability is not consumed by either supported baseline and is not combined with schedule availability.',
    })
  }
  for (const schedule of snapshot.tables.Schedule ?? []) {
    const user = matchedUsers.get(schedule.userId as number)
    if (!user) continue
    const sourceId = schedule.id as number
    const startProblems = problems.length
    const add = (
      code: string,
      severity: PlanProblem['severity'],
      message: string,
      row?: SourceRow,
    ) =>
      problems.push({
        code,
        severity,
        source: {
          table: row ? 'Availability' : 'Schedule',
          id: row ? (row.id as number) : sourceId,
        },
        message,
      })
    const name = cleanText(schedule.name, { max: 100 })
    if (!name) {
      add(
        'schedule_name',
        'import_blocker',
        'The schedule name must be valid single-line text of at most one hundred characters.',
      )
      continue
    }
    let timeZone: string
    const requiresTimezoneConfirmation = schedule.timeZone == null
    try {
      timeZone = validateTimeZone(schedule.timeZone ?? user.sourceTimezone)
    } catch {
      add(
        'schedule_timezone',
        'import_blocker',
        'The schedule time zone is invalid; a fixed offset or unknown zone cannot be imported.',
      )
      continue
    }
    if (requiresTimezoneConfirmation)
      add(
        'schedule_timezone_proposal',
        'activation_blocker',
        'The schedule has no explicit time zone; its proposed user or event zone needs owner confirmation because the source may use a delegated calendar zone.',
      )
    const sourceUser = snapshot.tables.users?.find((u) => u.id === user.sourceId)
    const plan: SchedulePlan = {
      sourceId,
      sourceUserId: user.sourceId,
      targetUserId: user.targetUserId,
      name,
      timeZone,
      requiresTimezoneConfirmation,
      sourceIsDefault: sourceUser?.defaultScheduleId === sourceId,
      isDefault: false,
      weeklyHours: emptyWeek(),
      overrides: [],
      valid: true,
    }
    const dates = new Map<
      string,
      { empty: boolean; intervals: WallClockInterval[]; rows: SourceRow[] }
    >()
    for (const row of allAvailability.filter((a) => a.scheduleId === sourceId)) {
      if (row.userId != null && row.userId !== user.sourceId) {
        add(
          'availability_owner',
          'import_blocker',
          'Availability belongs to a different user than its schedule.',
          row,
        )
        continue
      }
      const start = clock(row.startTime)
      const end = clock(row.endTime)
      if (!start || !end) {
        add(
          'availability_clock',
          'import_blocker',
          'Availability must contain valid source wall-clock TIME values.',
          row,
        )
        continue
      }
      if (start.secondsLost || end.secondsLost)
        add(
          'availability_seconds',
          'warning',
          'Source availability ignores seconds and fractions; the same values are truncated to minutes without rounding.',
          row,
        )
      const date = row.date
      if (date != null) {
        let key: string
        try {
          key = validateDate(date)
        } catch {
          add(
            'availability_date',
            'import_blocker',
            'The availability override must contain a valid unshifted calendar DATE.',
            row,
          )
          continue
        }
        const value = dates.get(key) ?? { empty: false, intervals: [], rows: [] }
        dates.set(key, value)
        value.rows.push(row)
        if (start.minutes === 0 && end.minutes === 0) {
          value.empty = true
          continue
        }
        if (start.minutes >= end.minutes) {
          add(
            'availability_interval',
            'import_blocker',
            'A date interval is zero length or crosses midnight; its meaning cannot be guessed.',
            row,
          )
          continue
        }
        value.intervals.push({
          start: renderClock(start.minutes),
          end: renderClock(end.minutes === 1439 ? 1440 : end.minutes),
        })
      } else {
        if (
          !Array.isArray(row.days) ||
          row.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
          new Set(row.days).size !== row.days.length
        ) {
          add(
            'availability_weekday',
            'import_blocker',
            'Availability weekdays must be distinct integers from Sunday zero through Saturday six.',
            row,
          )
          continue
        }
        if (start.minutes >= end.minutes) {
          add(
            'availability_interval',
            'import_blocker',
            'A weekly interval is zero length or crosses midnight; its meaning cannot be guessed.',
            row,
          )
          continue
        }
        if (row.days.length === 0)
          add(
            'availability_no_days',
            'warning',
            'A weekly availability row has no selected days and therefore contributes no available time.',
            row,
          )
        for (const day of row.days as number[]) {
          const key = weekdays[day] as Weekday
          plan.weeklyHours[key].push({
            start: renderClock(start.minutes),
            end: renderClock(end.minutes === 1439 ? 1440 : end.minutes),
          })
        }
      }
      if (end.minutes === 1439)
        add(
          'availability_end_of_day',
          'warning',
          'The source end-of-day marker 23:59 is represented as 24:00.',
          row,
        )
    }
    for (const day of weekdays) plan.weeklyHours[day] = union(plan.weeklyHours[day])
    for (const [date, value] of [...dates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (value.empty && value.intervals.length > 0) {
        for (const row of value.rows)
          add(
            'availability_empty_conflict',
            'import_blocker',
            'An unavailable marker and nonempty intervals share a date; the override is ambiguous.',
            row,
          )
        continue
      }
      plan.overrides.push({ date, intervals: value.empty ? [] : union(value.intervals) })
    }
    try {
      validateWeeklyHours(plan.weeklyHours)
      for (const override of plan.overrides) validateDayIntervals(override.intervals)
    } catch {
      add(
        'schedule_validation',
        'import_blocker',
        'The mapped schedule does not satisfy target availability validation.',
      )
    }
    plan.valid = !problems.slice(startProblems).some((p) => p.severity === 'import_blocker')
    plans.push(plan)
  }
  return plans
}
