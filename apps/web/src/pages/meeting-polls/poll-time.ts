import { utcOffset, type zoned } from '../../format.ts'

export function pollTimeRange(format: ReturnType<typeof zoned>, start: string, end: string) {
  const startOffset = utcOffset(format.timeZone, new Date(start))
  const endOffset = utcOffset(format.timeZone, new Date(end))
  if (startOffset !== endOffset)
    return `${format.dateTime(start)} ${startOffset} – ${format.dateTime(end)} ${endOffset}`
  return `${format.dateTimeRange(start, end)} ${startOffset}`
}
