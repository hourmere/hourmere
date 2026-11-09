# Attendee no-show markers

Adds nullable `booking_attendees.no_show_marked_at` and `no_show_marked_by`, constrained
as a pair. Existing attendees remain unmarked. The actor UUID is an audit snapshot, not a
cascading account foreign key.

The webhook subscription and delivery event checks are widened to include
`booking.attendee_no_show_changed`; nothing else about webhooks changes. In particular,
0064's unique delivery key `(webhook_id, booking_id, event_type, request_id)` with
`NULLS NOT DISTINCT` stays as it is, and so does the capture statement's `ON CONFLICT`
target.

Attendance deliveries reuse `webhook_deliveries.request_id`, a plain `uuid` column without
a foreign key, as a per-change receipt identity: capture stores the change's freshly
generated event ID there, inside the transaction that changes the marker. Each transition
therefore gets its own delivery under the existing key, while lifecycle receipts (NULL
request) and reschedule-request receipts (the request's ID) deduplicate exactly as before.
The value is only a receipt key: attendance payloads never contain `data.requestId`, and
it does not identify a reschedule request.

The migration is safe to apply while the previous version is still running. Previous
code only writes the five older events, which the widened checks accept, and its capture
statement keeps its arbiter. Apply it before starting the new version (automatic with
`AUTO_MIGRATE=true`). Adding the checks briefly locks `booking_attendees`, `webhooks` and
`webhook_deliveries` while existing rows are validated.

`no-show-migration.test.ts` upgrades a populated database from every earlier migration,
checks that rows and the delivery indexes are preserved, compares the schema with a fresh
installation, reruns the migrations as a no-op, and runs the previous capture statement
against the upgraded schema.
