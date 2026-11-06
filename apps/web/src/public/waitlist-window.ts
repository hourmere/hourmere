import { addDays, addMonths, type DateKey, parseDateKey, type YearMonth } from './calendar.ts'
import { instantOf } from './time.ts'

export interface WaitlistWindow {
  start: string
  end: string
  timeZone: string
}

export function waitlistOfferEnabled(
  oneTime: boolean,
  enabled: boolean | undefined,
  defaultDuration = true,
): boolean {
  return !oneTime && enabled === true && defaultDuration
}

/** Fixed UTC boundaries, using local calendar days even across DST changes. */
export function waitlistWindow(
  month: YearMonth,
  day: DateKey | null,
  timeZone: string,
  now: number,
): WaitlistWindow | null {
  try {
    const date = day ? parseDateKey(day) : { ...month, day: 1 }
    const next = day ? parseDateKey(addDays(day, 1)) : { ...addMonths(month, 1), day: 1 }
    const first = instantOf(date, 0, 0, timeZone)
    const last = instantOf(next, 0, 0, timeZone)
    // Leave time to review and submit a range that begins today. An expired draft must
    // be refreshed rather than silently changing the boundaries the invitee accepted.
    const start = Math.max(first, now + 5 * 60_000)
    const end = Math.min(last, now + 62 * 86_400_000)
    if (end <= start) return null
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone }
  } catch {
    return null
  }
}
