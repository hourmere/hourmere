# Workflow webhook delivery identity

Migration 0147 adds nullable `workflow_run_id` as a receipt ID without a foreign key.
`workflow.executed` rows require it and leave `request_id` null. The widened event check
accepts all six existing kinds. Booking, reschedule-request, attendance and Slack test
rows keep their existing identities and payloads. Adding the column without a default
requires no backfill or table rewrite.

The runner holds an `ACCESS EXCLUSIVE` lock on `webhook_deliveries` from `ADD COLUMN`
through commit. The migration builds the replacement unique index before swapping out
the old constraint, then validates the checks in one `ALTER TABLE`. The runner wraps the
file and its ledger write in one transaction, so concurrent index creation is unavailable.
The index build and check validation can delay reads and writes on large installations.
Schedule a quiet maintenance window. A lock wait over five seconds aborts the migration
and leaves it pending for a retry.

Stop old web and worker processes before migrating and restart all roles on the new
version. The old capture statement needs the four-column arbiter, while the new capture
statement needs the five-column arbiter installed by this migration.
