// Invitee change deadlines: how long before a booking starts its invitee may no longer
// reschedule or cancel through their own link (the manage page, REST or MCP with a manage
// token). Each booking keeps the minutes that applied when it was booked (bookings
// .reschedule_cutoff_minutes / cancel_cutoff_minutes, carried along its reschedule chain),
// so editing the event type later never changes an existing booking. Hosts and team admins
// are never limited by them. The minutes are elapsed time, so a deadline across a daylight
// saving change is still exactly that many minutes before the start.
import { DomainError } from './errors.ts'

/** One year, the same ceiling as minimum notice (and the database CHECK). */
export const CHANGE_CUTOFF_MAX_MINUTES = 525_600

export type ChangeKind = 'reschedule' | 'cancel'

/** The minutes a booking stores; null = no deadline (the invitee may change it until it starts). */
export interface ChangeCutoffs {
  rescheduleCutoffMinutes: number | null
  cancelCutoffMinutes: number | null
}

export const NO_CHANGE_CUTOFFS: ChangeCutoffs = {
  rescheduleCutoffMinutes: null,
  cancelCutoffMinutes: null,
}

/** The snapshot columns of a booking row, as stored. */
export interface ChangeCutoffColumns {
  reschedule_cutoff_minutes: number | null
  cancel_cutoff_minutes: number | null
}

export function cutoffsOf(row: ChangeCutoffColumns): ChangeCutoffs {
  return {
    rescheduleCutoffMinutes: row.reschedule_cutoff_minutes,
    cancelCutoffMinutes: row.cancel_cutoff_minutes,
  }
}

export function cutoffColumns(cutoffs: ChangeCutoffs): ChangeCutoffColumns {
  return {
    reschedule_cutoff_minutes: cutoffs.rescheduleCutoffMinutes,
    cancel_cutoff_minutes: cutoffs.cancelCutoffMinutes,
  }
}

/** The first instant at which the invitee may no longer make this change; null = none. */
export function changeDeadline(
  start: Temporal.Instant,
  minutes: number | null,
): Temporal.Instant | null {
  return minutes === null ? null : start.subtract({ minutes })
}

/**
 * Refuses an invitee change at or after its deadline. Call it only once the booking is
 * locked and known to be confirmed and not yet started, with the clock sampled after the
 * locks: a request that waited past the deadline is refused.
 */
export function assertInviteeChangeOpen(
  kind: ChangeKind,
  start: Temporal.Instant,
  cutoffs: ChangeCutoffs,
  now: Temporal.Instant,
): void {
  const deadline = changeDeadline(
    start,
    kind === 'reschedule' ? cutoffs.rescheduleCutoffMinutes : cutoffs.cancelCutoffMinutes,
  )
  if (deadline === null || Temporal.Instant.compare(now, deadline) < 0) return
  throw kind === 'reschedule'
    ? new DomainError(
        'conflict',
        'booking_reschedule_deadline_passed',
        'The deadline for rescheduling this booking online has passed. Contact the host to change it.',
      )
    : new DomainError(
        'conflict',
        'booking_cancel_deadline_passed',
        'The deadline for cancelling this booking online has passed. Contact the host to cancel it.',
      )
}

/** A stored or requested cutoff: null, or whole minutes from 1 to one year. */
export function validCutoff(value: unknown, field: string): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CHANGE_CUTOFF_MAX_MINUTES
  ) {
    throw new DomainError(
      'invalid',
      'invalid_event_type',
      `${field} must be a whole number of minutes from 1 to ${CHANGE_CUTOFF_MAX_MINUTES}, or null`,
    )
  }
  return value
}
