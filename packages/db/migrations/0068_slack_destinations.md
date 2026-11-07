# Slack destinations

Adds an encrypted incoming-webhook URL, destination kind and optional event filter to the
existing transactional webhook outbox. Existing signed endpoints remain `webhook` with
unchanged secrets, payloads and delivery state. Synthetic Slack tests have no booking ID.
`pause_reason` is `url_rejected` only while a Slack destination is paused because Slack
answered 404 or 410; manual pauses and every generic webhook keep it null.

A synthetic test delivery stores its own event ID in `webhook_deliveries.request_id`.
Migration 0064 made `(webhook_id, booking_id, event_type, request_id)` unique with
`NULLS NOT DISTINCT`; samples have no booking, so without a distinct value a second test
after a finished one would be dropped as a duplicate. On rows with a null `booking_id`,
`request_id` is that sample discriminator, not a reschedule-request ID.

Stop all old web, worker and other application processes before migrating; do not run old
workers against this schema. Old workers cannot interpret Slack destinations. Run the
migration and restart all roles on the new code. Back up before upgrading; use the documented
restore procedure to roll back. `WEBHOOK_ENCRYPTION_KEY` protects Slack URLs even when
`WEBHOOKS_ENABLED=false`; preserve that key with backups.
