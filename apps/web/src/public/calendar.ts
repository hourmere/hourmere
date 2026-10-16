// Calendar dates without a time zone: `YYYY-MM-DD` keys, months and the month grid. Date.UTC
// does the arithmetic, so the browser's own zone never enters into it.

/** A calendar date, `YYYY-MM-DD`. */
export type DateKey = string

export interface YearMonth {
  year: number
  /** 1–12. */
  month: number
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function toDateKey({ year, month, day }: YearMonth & { day: number }): DateKey {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

export function parseDateKey(key: DateKey): YearMonth & { day: number } {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

const utcOf = (key: DateKey) => {
  const { year, month, day } = parseDateKey(key)
  return Date.UTC(year, month - 1, day)
}

const keyOfUtc = (ms: number): DateKey => {
  const d = new Date(ms)
  return toDateKey({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() })
}

export function addDays(key: DateKey, days: number): DateKey {
  return keyOfUtc(utcOf(key) + days * 86_400_000)
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(key: DateKey): number {
  return new Date(utcOf(key)).getUTCDay()
}

export function monthOf(key: DateKey): YearMonth {
  const { year, month } = parseDateKey(key)
  return { year, month }
}

export function addMonths({ year, month }: YearMonth, months: number): YearMonth {
  const index = year * 12 + (month - 1) + months
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month)
}

export function daysInMonth({ year, month }: YearMonth): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The same day of the month in another month, clamped to its length (31 → 30). */
export function sameDayIn(key: DateKey, target: YearMonth): DateKey {
  const { day } = parseDateKey(key)
  return toDateKey({ ...target, day: Math.min(day, daysInMonth(target)) })
}

/**
 * The month as six weeks of seven days starting on `firstDay` (0 = Sunday), with null for the
 * days before and after the month. Always six rows, so the grid keeps its height.
 */
export function monthGrid(ym: YearMonth, firstDay: number): (DateKey | null)[][] {
  const first = toDateKey({ ...ym, day: 1 })
  const lead = (weekdayOf(first) - firstDay + 7) % 7
  const length = daysInMonth(ym)
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const day = week * 7 + weekday - lead + 1
      return day >= 1 && day <= length ? toDateKey({ ...ym, day }) : null
    }),
  )
}

// Regions whose weeks start on Sunday or Saturday, for browsers without Intl week info.
const SUNDAY_FIRST = new Set(
  'US CA MX BR JP KR TW HK IL IN PH ZA AU SA PE CO VE GT HN NI PA DO PR SV PY BO KE ET TH ID'.split(
    ' ',
  ),
)
const SATURDAY_FIRST = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '))

/** The weekday the locale's weeks start on: 0 = Sunday, 1 = Monday, 6 = Saturday. */
export function firstDayOfWeek(locale: string): number {
  try {
    const intl = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = intl.getWeekInfo?.() ?? intl.weekInfo
    if (info) return info.firstDay % 7
    const region = intl.maximize().region ?? ''
    if (SUNDAY_FIRST.has(region)) return 0
    if (SATURDAY_FIRST.has(region)) return 6
  } catch {
    // A locale Intl does not accept: fall through to Monday.
  }
  return 1
}
