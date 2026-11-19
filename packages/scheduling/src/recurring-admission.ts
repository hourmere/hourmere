/** The source default for recurring booking admission while the feature is in development. */
export const RECURRING_BOOKINGS_ENABLED: boolean = false

export interface RecurringBookingAdmissionDeps {
  /** In-process test override supplied by the caller. */
  recurringBookingsEnabled?: boolean | undefined
}

export function recurringBookingAdmissionEnabled(
  deps: RecurringBookingAdmissionDeps = {},
): boolean {
  return deps.recurringBookingsEnabled ?? RECURRING_BOOKINGS_ENABLED
}
