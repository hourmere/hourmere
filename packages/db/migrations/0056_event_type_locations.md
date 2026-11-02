Migration `0056_event_type_locations.sql` adds nullable `event_types.locations` and
`bookings.location_option` JSON columns. Every non-null event location becomes the
single option `[{"id":"legacy",...location}]`; every non-null resolved booking
location becomes `{"id":"legacy",...location}`. Null remains null. Existing columns,
including resolved conference URLs, booking history and timestamps, are preserved.
Historical resolved booking payloads with custom kinds are retained verbatim in
their snapshots; new event options still accept only the five supported kinds.

An ordered list contains one to five options with distinct IDs and kinds, and at most
one explicit default. Database checks enforce structural invariants; the scheduling
service validates kind-specific settings. `event_types.location` remains the default
option without its ID, label or default marker. Legacy location-only inserts and
edits still work; explicit changed lists take precedence. Unrelated edits preserve
the complete list. Booking inserts without a snapshot copy their resolved location;
later resolved-location changes never change the chosen snapshot.

The migration rewrites event and booking rows with a location and briefly takes the
ordinary ALTER TABLE locks. Stop old application roles before upgrading and restart
all roles with matching code before configuring multiple options. Legacy writers
cannot preserve an invitee choice. Roll back using the supported database backup and
restore procedure rather than running an older application against this schema.

The migration test populates the latest available predecessor (0053), preserves
all historical columns, compares the
upgraded schema with a fresh install, and verifies migration reruns make no writes.
