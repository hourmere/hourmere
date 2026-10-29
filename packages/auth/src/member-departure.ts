/** Shared transport-neutral failure for the injected scheduling departure service. */
export class MemberDepartureBlockedError extends Error {
  readonly code = 'member_departure_blocked'
  readonly impact: unknown
  readonly handling = {
    eventTypes: 'ask_admin_to_replace_or_remove_host',
    futureBookings: 'coordinate_cancellation',
    inProgressBookings: 'wait_until_end_or_coordinate_offline',
  } as const

  constructor(impact: unknown) {
    super(
      'Ask a team admin to replace or remove your event-type host assignments, and coordinate cancellation of future bookings. For bookings in progress, wait until they end or coordinate offline, then try leaving again.',
    )
    this.impact = impact
  }
}
