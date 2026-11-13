// Plain-language view of the availability troubleshooting API. Only reason codes the
// scheduling engine actually emits get specific wording; anything else stays neutral.
import type { Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { MessageKey } from '../../i18n/translate.ts'

export type Troubleshooting = Schemas['AvailabilityTroubleshooting']
export type TroubleshootSlot = Troubleshooting['slots'][number]
export type TroubleshootReason = TroubleshootSlot['reasons'][number]

export const REASON_TEXT: Readonly<Record<string, MessageKey>> = {
  past: 'This time has already passed.',
  duration_not_offered: 'This meeting length is not offered for this event type.',
  outside_working_hours: 'Outside the available hours (weekly hours or a date override).',
  off_slot_grid: 'Inside the available hours, but not one of the offered start times.',
  minimum_notice: 'Too soon: the minimum notice before a booking has not been met.',
  booking_window: 'Too far ahead: beyond how far in advance people can book.',
  calendar_busy: 'A connected calendar shows this time as busy.',
  buffer_before: 'The buffer before the meeting overlaps another commitment.',
  buffer_after: 'The buffer after the meeting overlaps another commitment.',
  daily_limit: 'The daily booking limit for this event type has been reached.',
  weekly_limit: 'The weekly booking limit for this event type has been reached.',
  monthly_limit: 'The monthly booking limit for this event type has been reached.',
  host_conflict: 'Another booking already takes this time.',
  collective_member_unavailable: 'Not every required host is free.',
  no_eligible_round_robin_host: 'No host in the rotation is free.',
}

/** The plain-language reason; codes added later read neutrally instead of guessing. */
export function reasonText(code: string): MessageKey {
  return Object.hasOwn(REASON_TEXT, code)
    ? (REASON_TEXT[code] as MessageKey)
    : 'Another scheduling rule applies.'
}

/**
 * A team reason's host: their name when the response lists them, otherwise a neutral label.
 * Personal event types carry no host on their reasons.
 */
export function reasonHost(
  reason: TroubleshootReason,
  hosts: Troubleshooting['hosts'],
): { kind: 'none' } | { kind: 'named'; name: string } | { kind: 'unnamed' } {
  if (reason.hostUserId === undefined) return { kind: 'none' }
  const host = hosts.find((candidate) => candidate.userId === reason.hostUserId)
  return host ? { kind: 'named', name: host.name } : { kind: 'unnamed' }
}

/** Times whose only reason is being outside the available hours; hidden by default. */
export function onlyOutsideHours(slot: TroubleshootSlot): boolean {
  return (
    slot.status === 'unavailable' &&
    slot.reasons.length > 0 &&
    slot.reasons.every((reason) => reason.code === 'outside_working_hours')
  )
}

export type Failure =
  | { kind: 'no_access' }
  | { kind: 'calendars_unreadable' }
  | { kind: 'location_unavailable' }
  | { kind: 'invalid'; code: string | undefined }
  | { kind: 'error' }

/**
 * The API answers non-managers exactly like a missing event type. That is an access state,
 * never a sign of missing configuration, and unreadable calendars are a temporary state.
 */
export function classifyFailure(error: unknown): Failure {
  if (!(error instanceof RequestError)) return { kind: 'error' }
  if (error.status === 404 && error.code === 'event_type_not_found') return { kind: 'no_access' }
  if (error.status === 403) return { kind: 'no_access' }
  if (error.status === 409 && error.code === 'calendar_sync_unavailable')
    return { kind: 'calendars_unreadable' }
  if (error.status === 409 && error.code === 'location_unavailable')
    return { kind: 'location_unavailable' }
  if (error.status === 400) return { kind: 'invalid', code: error.code }
  return { kind: 'error' }
}

/** The UTC offset of `timeZone` at `iso`, e.g. "GMT-04:00". */
export function zoneOffset(timeZone: string, iso: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(iso))
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  )
}

/**
 * On a day whose clocks change, local labels repeat or run backwards (01:00 – 01:00 on the
 * autumn change). A time whose offset differs from the day's start, or changes within the
 * time, needs its zone name to be unambiguous.
 */
export function needsZoneLabel(
  timeZone: string,
  dayStart: string,
  start: string,
  end: string,
): boolean {
  const day = zoneOffset(timeZone, dayStart)
  return zoneOffset(timeZone, start) !== day || zoneOffset(timeZone, end) !== day
}

/** Event types the API will explain to this caller: their own, or any team type for owners/admins. */
export function troubleshootableEventTypes<T extends { ownerUserId: string | null }>(
  eventTypes: readonly T[],
  me: { userId: string; personalSpace: boolean },
  teamRoles: readonly string[],
): { offered: T[]; hiddenTeamTypes: number } {
  const manager =
    !me.personalSpace && teamRoles.some((role) => role === 'owner' || role === 'admin')
  const offered = eventTypes.filter((event) =>
    event.ownerUserId === null ? manager : event.ownerUserId === me.userId,
  )
  return {
    offered,
    hiddenTeamTypes: eventTypes.filter((event) => event.ownerUserId === null && !manager).length,
  }
}
