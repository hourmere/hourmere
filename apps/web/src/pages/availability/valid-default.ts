import type { Schedule } from '../../api/resources.ts'
import { draftFromSchedule, validateSchedule, WEEKDAYS } from './weekly-hours.ts'

/** A default with usable weekly hours, rather than merely any schedule on the account. */
export function validDefault(schedule: Schedule): boolean {
  return schedule.isDefault && validSchedule(schedule)
}

/** Usable weekly hours, including when an event explicitly selects a non-default schedule. */
export function validSchedule(schedule: Schedule): boolean {
  try {
    const hours = schedule.weeklyHours
    if (Object.keys(hours).some((day) => !WEEKDAYS.some((weekday) => weekday.day === day)))
      return false
    // The editor uses 00:00 for end-of-day; the API must store that as 24:00.
    if (Object.values(hours).some((intervals) => intervals.some((hour) => hour.end === '00:00')))
      return false
    const draft = draftFromSchedule(schedule)
    return (
      Object.keys(validateSchedule(draft)).length === 0 &&
      Object.values(hours).some((intervals) => intervals.length > 0)
    )
  } catch {
    return false
  }
}
