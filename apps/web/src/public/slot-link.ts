export type SlotIntent =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'valid'; start: string; end: string; durationMinutes: number }

const firstInstant = Date.parse('0001-01-01T00:00:00.000Z')
const lastInstant = Date.parse('9999-12-31T23:59:59.999Z')
const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/

/** Parse hints only; the caller must restrict the route and freshly check exact availability. */
export function parseSlotLink(search: string, pathname = ''): SlotIntent {
  const invalid: SlotIntent = { status: 'invalid' }
  // URLSearchParams tolerates malformed percent sequences and replaces invalid UTF-8.
  // Decode explicitly before reading it so these cannot become partially valid hints.
  try {
    decodeURIComponent(search.replaceAll('+', ' '))
  } catch {
    return invalid
  }
  const params = new URLSearchParams(search)
  const starts = params.getAll('start')
  const durations = params.getAll('durationMinutes')
  if (starts.length === 0 && durations.length === 0) return { status: 'none' }
  if (new TextEncoder().encode(pathname + search).byteLength > 2048) return invalid
  if (starts.length !== 1 || durations.length !== 1) return invalid
  const start = starts[0] ?? ''
  const duration = durations[0] ?? ''
  if (!/^[1-9]\d{0,3}$/.test(duration) || String(Number(duration)) !== duration) return invalid
  const durationMinutes = Number(duration)
  if (durationMinutes > 1440) return invalid
  const match = instantPattern.exec(start)
  if (!match || match[0] !== start) return invalid
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = Number(match[9] ?? 0)
  const offsetMinute = Number(match[10] ?? 0)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  // Date.parse alone normalizes impossible calendar dates, including February 30.
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (monthDays[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return invalid
  const startAt = Date.parse(start)
  // These are elapsed minutes, independent of any display or host time zone.
  const endAt = startAt + durationMinutes * 60_000
  if (
    !Number.isFinite(startAt) ||
    startAt < firstInstant ||
    startAt > lastInstant ||
    endAt > lastInstant
  )
    return invalid
  return {
    status: 'valid',
    start: new Date(startAt).toISOString(),
    end: new Date(endAt).toISOString(),
    durationMinutes,
  }
}
