import { z } from 'zod'

/**
 * Shared list/detail whitelist for team administration. Define it independently of the
 * host Booking DTO: adding a host field must never expand a team administrator's view.
 * Conference links (including ready participant links) are deliberately outside this
 * minimum contract, so neither ownership nor stale provider state can disclose one.
 */
export const TeamAdminBookingSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['confirmed', 'cancelled']),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
  eventType: z
    .strictObject({
      id: z.uuid(),
      title: z.string().nullable(),
    })
    .nullable(),
  hosts: z.array(z.strictObject({ userId: z.uuid(), name: z.string() })),
  attendees: z.array(
    z.strictObject({
      name: z.string(),
      email: z.string(),
      timeZone: z.string(),
      isBooker: z.boolean(),
    }),
  ),
})

export type TeamAdminBooking = z.infer<typeof TeamAdminBookingSchema>

export const TeamAdminBookingPageSchema = z.strictObject({
  data: z.array(TeamAdminBookingSchema),
  nextCursor: z.string().nullable(),
})

export type TeamAdminBookingPage = z.infer<typeof TeamAdminBookingPageSchema>

/** Read-only list additions; departure/removal projections retain their original contract. */
export const TeamAdminBookingListItemSchema = TeamAdminBookingSchema.extend({
  eventType: TeamAdminBookingSchema.shape.eventType
    .unwrap()
    .extend({
      publicBookingPath: z
        .string()
        .nullable()
        .describe(
          'Additive, read-only: the public booking path when the event type still exists, is enabled and has a publicly bookable configuration; otherwise null',
        ),
    })
    .nullable(),
  hosts: z.array(
    TeamAdminBookingSchema.shape.hosts.element.extend({
      timeZone: z
        .string()
        .nullable()
        .describe(
          "Additive, read-only: the host's public profile IANA time zone, or null when no profile is available",
        ),
      isCurrentMember: z
        .boolean()
        .nullable()
        .describe(
          'Additive, read-only: whether this saved host is currently a member of the booking team; null when unavailable',
        ),
    }),
  ),
})

export const TeamAdminBookingListPageSchema = TeamAdminBookingPageSchema.extend({
  data: z.array(TeamAdminBookingListItemSchema),
})

export type TeamAdminBookingListPage = z.infer<typeof TeamAdminBookingListPageSchema>

/**
 * Service read model, assembled from already-authorized booking rows and their own
 * booking_hosts / booking_attendees. Hosts are the saved booking hosts, including
 * historical hosts, rather than the event type's current pool. A deleted event type
 * retains its ID with a null title; a missing event association is null.
 *
 * This is a projection boundary, not an access check. Team reads first apply the shared
 * team-management access check and team scope, and load current booking state.
 */
export interface TeamAdminBookingRecord {
  id: string
  status: 'confirmed' | 'cancelled'
  start_at: Date
  end_at: Date
  cancelled_at: Date | null
  event_type_id: string | null
  event_type_title: string | null
  hosts: readonly { user_id: string; name: string }[]
  attendees: readonly {
    name: string
    email: string
    time_zone: string
    is_booker: boolean
  }[]
}

/** Copy only named fields, including inside arrays; never spread a host DTO or DB row. */
export function toTeamAdminBooking(record: TeamAdminBookingRecord): TeamAdminBooking {
  return {
    id: record.id,
    status: record.status,
    start: record.start_at.toISOString(),
    end: record.end_at.toISOString(),
    cancelledAt: record.cancelled_at?.toISOString() ?? null,
    eventType:
      record.event_type_id === null
        ? null
        : { id: record.event_type_id, title: record.event_type_title },
    hosts: record.hosts.map((host) => ({ userId: host.user_id, name: host.name })),
    attendees: record.attendees.map((attendee) => ({
      name: attendee.name,
      email: attendee.email,
      timeZone: attendee.time_zone,
      isBooker: attendee.is_booker,
    })),
  }
}
