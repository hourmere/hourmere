const { NO_SHOW_EVENT, request, verifyDelivery } = require('./lib.js')

const noShow = {
  sample: {
    attendeeId: '00000000-0000-4000-8000-000000000005',
    noShowMarkedAt: '2026-12-02T10:05:00Z',
    noShowMarkedBy: '00000000-0000-4000-8000-000000000006',
  },
  outputFields: [
    { key: 'attendeeId', label: 'Attendee ID' },
    { key: 'noShowMarkedAt', label: 'No-Show Marked At' },
    { key: 'noShowMarkedBy', label: 'No-Show Marked By' },
  ],
}

function hook(key, eventType, noun, display) {
  const attendance = eventType === NO_SHOW_EVENT
  return {
    key,
    noun,
    display,
    operation: {
      type: 'hook',
      performSubscribe: async (z, bundle) => {
        const result = await request(z, bundle, '/webhooks', {
          method: 'POST',
          body: { url: bundle.targetUrl, events: [eventType] },
        })
        return { id: result.webhook.id, secret: result.secret }
      },
      performUnsubscribe: async (z, bundle) =>
        request(z, bundle, `/webhooks/${encodeURIComponent(bundle.subscribeData.id)}`, {
          method: 'DELETE',
          allowDeletedWebhook: true,
        }),
      perform: (z, bundle) => verifyDelivery(z, bundle, eventType),
      performList: async (z, bundle) => {
        const result = await request(z, bundle, '/bookings', {
          params: {
            limit: 25,
            order: 'desc',
            ...(eventType === 'booking.cancelled' ? { status: 'cancelled' } : {}),
          },
        })
        const project = (booking) => ({
          id: `sample:${eventType}:${booking.id}`,
          type: eventType,
          occurredAt: eventType === 'booking.cancelled' ? booking.cancelledAt : booking.createdAt,
          bookingId: booking.id,
          // Host booking reads do not expose the organization ID. Live deliveries do.
          organizationId: null,
          eventTypeId: booking.eventTypeId,
          start: booking.start,
          end: booking.end,
          status: booking.status,
          source: booking.source,
          rescheduledFromId: booking.rescheduledFromId,
        })
        // Only current marks are visible in booking reads; unmarking leaves no sample.
        if (attendance)
          return result.data.flatMap((booking) =>
            booking.attendees
              .filter((attendee) => attendee.id && attendee.noShowMarkedAt)
              .map((attendee) => ({
                ...project(booking),
                id: `sample:${eventType}:${booking.id}:${attendee.id}`,
                occurredAt: attendee.noShowMarkedAt,
                attendeeId: attendee.id,
                noShowMarkedAt: attendee.noShowMarkedAt,
                noShowMarkedBy: attendee.noShowMarkedBy ?? null,
              })),
          )
        return result.data
          .filter((booking) =>
            eventType === 'booking.rescheduled'
              ? booking.rescheduledFromId
              : eventType === 'booking.cancelled'
                ? !booking.rescheduledToId
                : !booking.rescheduledFromId,
          )
          .map(project)
      },
      sample: {
        id: 'sample-event',
        type: eventType,
        occurredAt: '2026-12-01T10:00:00Z',
        bookingId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        eventTypeId: '00000000-0000-4000-8000-000000000003',
        source: 'api',
        rescheduledFromId:
          eventType === 'booking.rescheduled' ? '00000000-0000-4000-8000-000000000004' : null,
        start: '2026-12-02T10:00:00Z',
        end: '2026-12-02T10:30:00Z',
        status: eventType === 'booking.cancelled' ? 'cancelled' : 'confirmed',
        ...(attendance && noShow.sample),
      },
      outputFields: [
        { key: 'id', label: 'Event ID' },
        { key: 'bookingId', label: 'Booking ID' },
        { key: 'organizationId', label: 'Organization ID' },
        { key: 'eventTypeId', label: 'Event Type ID' },
        { key: 'source' },
        { key: 'rescheduledFromId', label: 'Previous Booking ID' },
        { key: 'type' },
        { key: 'occurredAt' },
        { key: 'start' },
        { key: 'end' },
        { key: 'status' },
        ...(attendance ? noShow.outputFields : []),
      ],
    },
  }
}
const lifecycle = (key, eventType, change) =>
  hook(key, eventType, 'Booking', {
    label: `Booking ${change}`,
    description: `Triggers when a booking is ${change.toLowerCase()} in the connected organization.`,
  })
module.exports = {
  booking_created: lifecycle('booking_created', 'booking.created', 'Created'),
  booking_cancelled: lifecycle('booking_cancelled', 'booking.cancelled', 'Cancelled'),
  booking_rescheduled: lifecycle('booking_rescheduled', 'booking.rescheduled', 'Rescheduled'),
  booking_attendee_no_show_changed: hook(
    'booking_attendee_no_show_changed',
    NO_SHOW_EVENT,
    'Attendee',
    {
      label: 'Attendee No-Show Changed',
      description:
        'Triggers when a host marks or unmarks a booking attendee as a no-show in the connected organization.',
    },
  ),
}
