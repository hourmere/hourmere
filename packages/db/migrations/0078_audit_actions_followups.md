# Audit actions follow-ups

Replaces `audit_events_details_check` with the same check plus one branch: the
`booking.attendee_no_show_changed` action requires exactly `attendeeId` (a lowercase UUID
string) and `noShow` (`marked` or `unmarked`). Every other action keeps its earlier detail
rule, so existing journal rows are unchanged and still valid.

The migration is safe to apply while the previous version is still running: that version
never writes the new action. Apply it before starting the new version (automatic with
`AUTO_MIGRATE=true`); the new version's no-show changes fail against the old check.
Re-adding the check briefly locks `audit_events` while existing rows are validated.

`audit-actions-followups-migration.test.ts` upgrades a populated database, checks that every
row is preserved, compares the schema with a fresh installation and reruns the migrations as
a no-op. `audit-actions-followups-coverage.test.ts` drops the check through
`checkConstraintCoverage` and requires a protection assertion to fail.
