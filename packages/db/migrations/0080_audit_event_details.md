# Audit event details

Replaces `audit_events_details_check` with the 0078 check, changing only the webhook and
Slack destination branches. Both still allow `events` as the only key. When it is present,
its value must now be:

- an array;
- of strings, each a name from the destination's event catalogue: the six webhook events
  (`WEBHOOK_EVENTS`) for `webhook.*`, and the five Slack events (`SLACK_EVENTS`, without
  `booking.attendee_no_show_changed`) for `slack_destination.*`;
- non-empty, and no longer than that catalogue;
- without duplicates.

This is what the application already writes: the stored, validated subscription list.
`packages/webhooks/src/audit-event-catalogue.test.ts` binds both catalogues and bounds to
the code, so adding an event type to either list fails until a new migration updates this
check. Every other branch is byte-for-byte the 0078 branch
(`audit-event-details-migration.test.ts` compares them).

The migration is safe to apply while the previous version is still running: that version
writes only lists that satisfy the new check. The check is added `NOT VALID` and validated
by `VALIDATE CONSTRAINT` in the same file. The runner applies each file in one
transaction, so the `ACCESS EXCLUSIVE` lock that `DROP CONSTRAINT` and `ADD CONSTRAINT`
take is held until commit, including while existing rows are validated. Audited writes
(bookings, management changes) wait for that scan, which grows with the journal: about
0.1 s for 200,000 rows on a development machine. Validating in a separate, later
migration would hold only `SHARE UPDATE EXCLUSIVE`, which lets those writes continue.

If a journal row holds an `events` value outside this shape (possible only for rows written
outside the application), validation fails with SQLSTATE 23514, the transaction rolls
back and the earlier check stays in place. After the upgrade, a change to a webhook or
Slack destination whose stored event list was edited outside the application (a repeated
event, or a Slack destination holding an event Slack does not post) fails with 23514
until that list is corrected through the API.

The migrator applies a missing lower-numbered file after higher ones, so a later change to
`audit_events_details_check` must use a number above 0080; otherwise fresh and upgraded
installations would end with different checks.

`packages/webhooks/src/audit-event-details-migration.test.ts` upgrades a database populated
through the application's own webhook, Slack, no-show, SCIM token and other writers, checks
that every row is preserved, compares the schema with a fresh installation and reruns the
migrations as a no-op. `audit-event-details-coverage.test.ts` drops the check through
`checkConstraintCoverage` and requires a protection assertion to fail.
