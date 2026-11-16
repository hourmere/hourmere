Migration `0089_change_deadlines.sql` adds two nullable whole-minute columns to
`event_types` and the same two to `bookings`:

- `reschedule_cutoff_minutes`: how long before the start the invitee may no longer
  reschedule through their own link;
- `cancel_cutoff_minutes`: the same for cancelling.

Each value is 1–525600 (one year) when set; NULL means no deadline, which is what every
existing event type and booking gets. No row is rewritten. The booking columns are a
snapshot written when the booking is made (copied from the locked event type row) and
carried unchanged to every successor in its reschedule chain, so editing the event type
later never changes an existing booking. Hosts and team admins are not limited by either
value.

Deploy the migration before the matching application code. The new columns are safe for
old code while NULL; an old process that is still running ignores deadlines configured
after the upgrade, and bookings it creates carry no snapshot. Stop old application roles
before configuring deadlines. Roll back through the documented backup/restore procedure
once a deadline has been configured; old code would ignore it.

Both `ALTER TABLE` statements take an `ACCESS EXCLUSIVE` lock and scan their table once to
check the new constraints against columns that are all NULL; booking writes wait for that
scan, which is short because nothing is rewritten.

The predecessor-data test migrates a populated database at the previous schema, checks
that every existing row and physical tuple is preserved and the new columns are NULL,
compares the resulting schema with a fresh install and verifies that a rerun is a no-op.
`change-deadlines-coverage.test.ts` drops each constraint and requires a protection
assertion to fail.
