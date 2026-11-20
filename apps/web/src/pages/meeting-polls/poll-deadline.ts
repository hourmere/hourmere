import { offsetAt, wallTime } from '../../public/time.ts'

/** Resolve a wall time without shifting a missing hour or silently choosing a repeated hour. */
export function pollDeadlineInstants(local: string, timeZone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return []
  const wall = Date.parse(`${local}:00Z`)
  if (!Number.isFinite(wall)) return []
  const before = wall - offsetAt(wall - 86_400_000, timeZone)
  const after = wall - offsetAt(wall + 86_400_000, timeZone)
  return [...new Set([before, after])]
    .filter((candidate) => pollDeadlineLocal(candidate, timeZone) === local)
    .sort((a, b) => a - b)
    .map((candidate) => new Date(candidate).toISOString())
}

export function pollDeadlineLocal(instant: number, timeZone: string) {
  const { year, month, day, hour, minute } = wallTime(instant, timeZone)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`
}
