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

/** Leave paths must retain at least one current owner under the organization write lock. */
export class MemberDepartureOwnerRequiredError extends Error {
  readonly code = 'member_departure_owner_required'
  readonly handling = { owner: 'another_owner_is_needed_before_you_can_leave' } as const

  constructor() {
    super('Another owner is needed before you can leave.')
  }
}
