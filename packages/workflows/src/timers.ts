// Workflow timer calculations (docs/workflows.md, "Triggers, conditions and snapshots" and
// "Scheduling, races and delivery guarantees"). Capture and dispatch apply these pure rules: the
// due instant of a run, the skip that capture records when a run is too close or already past,
// and the dispatch window that closes at the late bound. Every instant is a UTC
// `Temporal.Instant` and every offset or delay is elapsed minutes, so no wall clock, time zone,
// calendar day or DST change can move a due instant. The caller passes every instant, `now`
// included: nothing here reads a clock, the database or a transport.

import { REMINDER_MIN_GAP } from '@hourmere/scheduling'
import type { WorkflowSkipReason } from './audit.ts'
import type { WorkflowTrigger } from './definition.ts'
import {
  WORKFLOW_MAX_LATE_MINUTES,
  WORKFLOW_MAX_OFFSET_MINUTES,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
} from './limits.ts'

/** The saved booking instants that timers are anchored to. */
export interface WorkflowBookingInstants {
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
}

/** A timer: a whole number of elapsed minutes before or after the booking's start or end. */
export interface WorkflowTimer {
  readonly anchor: 'start' | 'end'
  readonly direction: 'before' | 'after'
  readonly offsetMinutes: number
}

/** What capture records instead of a pending run when the run is too close or already past. */
export type WorkflowCaptureSkipReason = Extract<
  WorkflowSkipReason,
  'minimum_gap' | 'offset_not_future'
>

/** A run's timing, decided once when capture creates the run. */
export interface WorkflowRunTiming {
  /** The instant the run becomes due. */
  readonly dueAt: Temporal.Instant
  /**
   * The late bound: the first instant at which dispatch skips the run as `expired`. It is the
   * due instant plus WORKFLOW_MAX_LATE_MINUTES, and never later than the start for a
   * before-start run.
   */
  readonly expiresAt: Temporal.Instant
  /** Set when capture records the run as skipped instead of pending. */
  readonly skipReason: WorkflowCaptureSkipReason | undefined
}

/** Where an instant falls against a run's timing: early, dispatchable, or expired for good. */
export type WorkflowDispatchWindow = 'not_due' | 'open' | 'expired'

type TimerTrigger = Extract<WorkflowTrigger, { offsetMinutes: number }>

/** A whole number of minutes from `minimum` to WORKFLOW_MAX_OFFSET_MINUTES, or a RangeError. */
function minutesWithin(value: number, minimum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > WORKFLOW_MAX_OFFSET_MINUTES)
    throw new RangeError(
      `A workflow ${name} must be a whole number of minutes from ${minimum} to ${WORKFLOW_MAX_OFFSET_MINUTES}`,
    )
  return value
}

/** The due instant of a timer: its anchor moved by the offset in elapsed minutes. */
export function workflowTimerDueAt(
  timer: WorkflowTimer,
  booking: WorkflowBookingInstants,
): Temporal.Instant {
  const minutes = minutesWithin(
    timer.offsetMinutes,
    WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
    'timer offset',
  )
  const anchor = timer.anchor === 'start' ? booking.start : booking.end
  return timer.direction === 'before' ? anchor.subtract({ minutes }) : anchor.add({ minutes })
}

/** The timer that a before-start or after-end trigger sets. */
function triggerTimer(trigger: TimerTrigger): WorkflowTimer {
  return trigger.type === 'before_start'
    ? { anchor: 'start', direction: 'before', offsetMinutes: trigger.offsetMinutes }
    : { anchor: 'end', direction: 'after', offsetMinutes: trigger.offsetMinutes }
}

/**
 * Decides a run's timing when capture creates it. `capturedAt` is the instant at which the
 * booking change (creation, reschedule or cancellation) was judged.
 *
 * - A timer trigger is due at its anchor moved by its offset. A due instant at or before
 *   `capturedAt` is skipped as `offset_not_future`. A before-start due instant must also
 *   strictly exceed the existing reminder gap (REMINDER_MIN_GAP) after `capturedAt`; at or
 *   before that gap it is skipped as `minimum_gap`. When both apply, `offset_not_future` wins,
 *   as it does for reminders.
 * - A lifecycle trigger is due its delay after `capturedAt`. A zero delay is due at once and,
 *   like any lifecycle run, is never skipped at capture.
 *
 * Every run expires WORKFLOW_MAX_LATE_MINUTES after it is due; a before-start run also expires
 * when the booking starts, whichever comes first.
 */
export function workflowRunTiming(
  trigger: WorkflowTrigger,
  booking: WorkflowBookingInstants,
  capturedAt: Temporal.Instant,
): WorkflowRunTiming {
  if (trigger.type !== 'before_start' && trigger.type !== 'after_end') {
    const dueAt = capturedAt.add({
      minutes: minutesWithin(trigger.delayMinutes, 0, 'lifecycle delay'),
    })
    return {
      dueAt,
      expiresAt: dueAt.add({ minutes: WORKFLOW_MAX_LATE_MINUTES }),
      skipReason: undefined,
    }
  }
  const beforeStart = trigger.type === 'before_start'
  const dueAt = workflowTimerDueAt(triggerTimer(trigger), booking)
  const lateBound = dueAt.add({ minutes: WORKFLOW_MAX_LATE_MINUTES })
  const expiresAt =
    beforeStart && Temporal.Instant.compare(booking.start, lateBound) < 0
      ? booking.start
      : lateBound
  let skipReason: WorkflowCaptureSkipReason | undefined
  if (Temporal.Instant.compare(dueAt, capturedAt) <= 0) skipReason = 'offset_not_future'
  else if (beforeStart && Temporal.Instant.compare(dueAt, capturedAt.add(REMINDER_MIN_GAP)) <= 0)
    skipReason = 'minimum_gap'
  return { dueAt, expiresAt, skipReason }
}

/**
 * Where `now` falls against a run's timing. Dispatch may send only while `open`: from the due
 * instant up to, but not including, the late bound. At the late bound or beyond, the run is
 * `expired` and is skipped permanently; before the due instant it is `not_due`. The window does
 * not repeat the capture decision: a run that capture skipped is never pending, so dispatch
 * never asks about it.
 */
export function workflowDispatchWindow(
  timing: Pick<WorkflowRunTiming, 'dueAt' | 'expiresAt'>,
  now: Temporal.Instant,
): WorkflowDispatchWindow {
  if (Temporal.Instant.compare(now, timing.expiresAt) >= 0) return 'expired'
  return Temporal.Instant.compare(now, timing.dueAt) < 0 ? 'not_due' : 'open'
}
