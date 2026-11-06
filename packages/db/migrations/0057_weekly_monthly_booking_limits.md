Migration `0057_weekly_monthly_booking_limits.sql` adds nullable integer weekly and
monthly ceilings to `event_types`. Both default to NULL, preserving unlimited weekly
and monthly capacity for existing event types. Existing daily limits, event fields,
bookings, timestamps and physical tuples are preserved.

Each ceiling is 1–1000 when set. Every configured longer-period ceiling must be at
least the configured shorter-period ceiling, including day/month when week is NULL.
This rejects descending configuration; it does not imply that calendar weeks are
contained in calendar months. See the booking-limit contract in `docs/data-model.md`
for time zones, period boundaries and host scope.

Deploy the migration before the matching application code. Stop all old application
roles before enabling weekly or monthly limits: old processes do not enforce them.
The added columns remain safe for old code while NULL. No bookings are cancelled or
rewritten when a limit is lowered. Roll back through the documented backup/restore
procedure once a new limit has been configured; old code would ignore it.

The predecessor-data test migrates a populated 0053 database (or the latest available
predecessor before 0057), checks every existing column and physical tuple, compares
the resulting schema with a fresh install, and verifies no-op migration reruns.
