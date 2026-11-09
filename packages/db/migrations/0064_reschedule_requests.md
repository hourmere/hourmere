# Reschedule requests

Adds an overlay to confirmed bookings rather than a booking status. Pending requests keep
existing booking-host exclusion blocks, calendar events, conferences and reminders intact.
Each booking has at most one pending request. A new request replaces it; the booking and
idempotency key pair is unique so retries do not enqueue duplicate mail. All lifecycle
writers lock the original booking before changing the request. Pick receipts identify the
single successor; cancellation and expiry retain terminal request history.

The scheduling constant `RESCHEDULE_REQUEST_TIMEOUT_HOURS` is 48; the deadline is capped
at the original booking start. Expiry preserves the booking. Request notification kinds
and per-request webhook receipts extend existing contracts without rewriting old rows.

`reschedule-requests-migration.test.ts` migrates a predecessor database with a real booking
and webhook receipt, verifies preservation and the single-pending constraint, then verifies
fresh installation and no-op migration replays. Existing public rows are not rewritten.
