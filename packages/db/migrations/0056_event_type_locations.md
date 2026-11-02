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
edits still work; explicit changed lists take precedence. An unchanged compatibility
value preserves the entire list. A changed single unlabelled option keeps its ID for
settings edits and receives a new ID for a kind change or recreation. Changing or
clearing several options or a labelled option through `location` fails with
`location_options_conflict` (SQLSTATE `P0001`); use `locations` explicitly. Unrelated
edits preserve the complete list. Booking inserts without a snapshot copy their resolved location;
later resolved-location changes never change the chosen snapshot.

The migration rewrites event and booking rows with a location and briefly takes the
ordinary ALTER TABLE locks. Stop old application roles before upgrading and restart
all roles with matching code before configuring multiple options. Legacy writers
cannot preserve an invitee choice. Roll back using the supported database backup and
restore procedure rather than running an older application against this schema.

The migration test populates the latest available predecessor (0053), preserves
all historical columns, compares the
upgraded schema with a fresh install, and verifies migration reruns make no writes.

Keep number 0056. Gaps 0054/0055 are expected and harmless: the runner records files by
name/checksum and applies any unapplied file, rather than requiring contiguous numbers.
At the round-2 check, origin/main ends at 0053, PR #214 uses 0057 and PR #212 uses 0058;
no open PR supplies 0054/0055. A database that already ran 0056 may therefore apply a
later-arriving lower-numbered file after it. The trigger preserves location echoes and
same-kind edits of a single unlabelled option, so ordinary compatibility normalization
can still run. A migration changing several options or a labelled option must replace
`locations` explicitly; it must not guess through the compatibility field. The regression
test exercises gap arrival, later legacy-column writes, fresh install and no-op reruns.
The currently open 0057/0058 migrations do not write `event_types.location`.

This SQL is still unpublished on main; round 2 corrects its trigger in place before
release. Never replace an applied migration checksum in a deployed database.
