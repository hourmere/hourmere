# Audit actions follow-ups

Replaces `audit_events_details_check` with the same check plus two branches:

- `booking.attendee_no_show_changed` requires exactly `attendeeId` (a lowercase UUID
  string) and `noShow` (`marked` or `unmarked`);
- the `slack_destination.*` actions (`created`, `updated`, `deleted`, `paused`, `resumed`,
  `tested`) allow only `events`, like the webhook actions.

The new `scim_token.created`, `scim_token.rotated` and `scim_token.revoked` actions fall to
the existing rule that requires empty details. Every other action keeps its earlier detail
rule, so existing journal rows are unchanged and still valid.

The migration is safe to apply while the previous version is still running: that version
never writes the new actions. Apply it before starting the new version (automatic with
`AUTO_MIGRATE=true`); against the old check, the new version's no-show changes and Slack
destination changes fail.
Re-adding the check briefly locks `audit_events` while existing rows are validated.

The migrator applies a missing lower-numbered file after higher ones, so a later change to
`audit_events_details_check` must use a number above 0078; otherwise fresh and upgraded
installations would end with different checks.

`audit-actions-followups-migration.test.ts` upgrades a populated database, checks that every
row is preserved, compares the schema with a fresh installation and reruns the migrations as
a no-op. `audit-actions-followups-coverage.test.ts` drops the check through
`checkConstraintCoverage` and requires a protection assertion to fail.
