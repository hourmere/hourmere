# Slack destinations

Adds an encrypted incoming-webhook URL, destination kind and optional event filter to the
existing transactional webhook outbox. Existing signed endpoints remain `webhook` with
unchanged secrets, payloads and delivery state. Synthetic Slack tests have no booking ID.

Stop all old web, worker and other application processes before migrating; do not run old
workers against this schema. Old workers cannot interpret Slack destinations. Run the
migration and restart all roles on the new code. Back up before upgrading; use the documented
restore procedure to roll back. `WEBHOOK_ENCRYPTION_KEY` protects Slack URLs even when
`WEBHOOKS_ENABLED=false`; preserve that key with backups.
