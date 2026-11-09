# n8n integration

The [n8n guide](https://hourmere.com/docs/n8n) covers installation, credentials,
booking actions, signed triggers and receipt limitations.

Hourmere Trigger supports six events: `booking.created`, `booking.cancelled`,
`booking.rescheduled`, `booking.reschedule_requested`,
`booking.reschedule_request_expired` and `booking.attendee_no_show_changed`.
The last appears as **Attendee No-Show Changed**, matching the Zapier trigger.

Select the new event explicitly in existing workflows. Its signed payload includes
`data.bookingId`, `data.attendeeId`, `data.noShowMarkedAt` and `data.noShowMarkedBy`
alongside the usual booking fields. Both marker fields are null when unmarked;
`data.requestId` is absent. Use the event `id` for downstream deduplication and
booking/attendee IDs to match attendance records. Payloads contain no attendee
contact details or management links.

Signature verification, the five-minute timestamp tolerance and ten-minute receipt
window are unchanged. Receipts remain best-effort across workers and restarts;
use a persistent unique constraint for durable downstream idempotency.
