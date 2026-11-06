const { request, verifyDelivery } = require('./lib.js')

function hook(key, eventType, noun) {
  return {
    key,
    noun: 'Booking',
    display: {
      label: `Booking ${noun}`,
      description: `Triggers when a booking is ${noun.toLowerCase()} in the connected organization.`,
    },
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
        return result.data
          .filter((booking) =>
            eventType === 'booking.rescheduled'
              ? booking.rescheduledFromId
              : eventType === 'booking.cancelled'
                ? !booking.rescheduledToId
                : !booking.rescheduledFromId,
          )
          .map((booking) => ({
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
          }))
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
      ],
    },
  }
}
module.exports = {
  booking_created: hook('booking_created', 'booking.created', 'Created'),
  booking_cancelled: hook('booking_cancelled', 'booking.cancelled', 'Cancelled'),
  booking_rescheduled: hook('booking_rescheduled', 'booking.rescheduled', 'Rescheduled'),
}
