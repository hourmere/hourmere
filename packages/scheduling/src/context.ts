import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { SuccessRedirectPolicy } from './success-redirect.ts'

/**
 * A change to a booking that people are told about (https://hourmere.com/docs/notifications). Only ids and
 * the start: whoever is notified loads the rest when it acts, and must check then that the
 * booking is still as described.
 */
export type BookingEvent =
  | { type: 'created'; bookingId: string; start: Temporal.Instant }
  /** `bookingId` is the new booking, the one that replaced the old. */
  | { type: 'rescheduled'; bookingId: string; start: Temporal.Instant }
  | { type: 'cancelled'; bookingId: string }

/**
 * Called by the booking services inside the transaction that makes the change, with that
 * transaction and the instant the service used for its checks; whatever it writes through
 * `trx` commits or rolls back with the booking. If it throws, the change fails. The server
 * queues the notification jobs here (enqueueBookingNotifications); scheduling itself knows
 * nothing about jobs or email.
 */
export type BookingNotifier = (trx: Db, event: BookingEvent, now: Temporal.Instant) => Promise<void>

/**
 * What a service function receives for an authenticated call. REST routes and MCP tools
 * build it the same way, so people and agents get exactly the same behavior.
 */
export interface ServiceContext {
  db: Db
  /** Host-written follow-up body text; enabled unless the operator explicitly disables it. */
  followUpHostNotesEnabled?: boolean | undefined
  successRedirectPolicy?: SuccessRedirectPolicy | undefined
  /** Explicit instance capability; defaults off. */
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  principal: Principal
  /** The clock, injectable for tests. */
  now: () => Temporal.Instant
  /** Told about booking changes in their transaction; nobody is told when absent. */
  notify?: BookingNotifier | undefined
  /** Optional web draft binding, rechecked inside the organization write's transaction. */
  authorizeOrganizationWrite?:
    | ((trx: Db, organizationId: string, targetId?: string) => Promise<void>)
    | undefined
}

/** For unauthenticated flows such as public booking pages and invitee links. */
export interface PublicContext {
  db: Db
  successRedirectPolicy?: SuccessRedirectPolicy | undefined
  /** Maximum invitee moves across one booking chain; defaults to 5, and 0 disables them. */
  bookingMaxInviteeReschedules?: number | undefined
  /** Explicit instance capability; defaults off. */
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  now: () => Temporal.Instant
  /** Told about booking changes in their transaction; nobody is told when absent. */
  notify?: BookingNotifier | undefined
}
