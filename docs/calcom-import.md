# Cal.com / cal.diy import

The local operator CLI previews real source and target state and applies the exact reviewed
plan. The explicit `preview` command writes no source, business or import-metadata rows.
There is no import web UI. Use `register-source` once to create a persistent random source
namespace before previewing. Database administration access alone is not owner consent.
Supported source versions are cal.diy `a5ee96f77edd644439e7de8c3255ccb2eb2c5941`
and Cal.com `v6.2.0` (`1c193cca8682b33b9866c792186033f7ef886682`).
An unrecognized scalar, enum or relationship signature is refused. The operator-supplied
version and actual schema fingerprint are retained separately. Do not relabel older databases.

Future accepted personal bookings are candidates for **local-only, read-only busy records**.
They remain managed in the old system. They must never create emails, ICS, management links,
calendar copies, meetings or webhooks. The dedicated import transaction creates none of those records or pg-boss jobs. Existing
waitlist availability triggers can append local scan signals; the preview counts those rows.
They carry no imported attendee data, and imported booking jobs remain ineligible.
All event proposals remain inactive drafts; hidden controls listing visibility separately.
Teams, organizations, managed/multiple-host events, payment and instant features are excluded
or blocked. The structured report lists each detected loss and includes every out-of-scope
category without reading forbidden tables just to count them.

## Prepare a dedicated SELECT-only source role

A source database administrator performs this setup outside the importer. The importer never
creates roles, grants permissions or changes the source. Use a dedicated account that owns
neither the database nor any application relation, has no role memberships or inheritance,
and has no application write privileges or access to other application columns. Revoke
inherited PUBLIC write privileges as necessary, including PUBLIC temporary-table creation.
These PUBLIC changes affect other roles: review the source deployment's grants first and
restore required access to its normal application role explicitly.

In an administrator psql session, replace `source_database` with the controlled source name.
Set the password interactively; never put it in command arguments or shell history.

```sql
CREATE ROLE hourmere_import LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
\password hourmere_import
REVOKE CREATE, TEMPORARY ON DATABASE source_database FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE source_database TO hourmere_import;
GRANT USAGE ON SCHEMA public TO hourmere_import;
ALTER ROLE hourmere_import SET default_transaction_read_only = on;
GRANT SELECT ("id", "email", "emailVerified", "username", "name", "timeZone", "locale", "defaultScheduleId", "organizationId", "movedToProfileId", "bufferTime") ON public."users" TO hourmere_import;
GRANT SELECT ("id", "userId", "organizationId", "username") ON public."Profile" TO hourmere_import;
GRANT SELECT ("id", "userId", "teamId", "profileId", "parentId", "title", "slug", "length", "description", "position", "locations", "bookingFields", "timeZone", "periodType", "periodStartDate", "periodEndDate", "periodDays", "periodCountCalendarDays", "minimumBookingNotice", "beforeEventBuffer", "afterEventBuffer", "hidden", "slotInterval", "offsetStart", "scheduleId", "schedulingType", "disableGuests", "requiresConfirmation", "requiresConfirmationWillBlockSlot", "requiresConfirmationForFreeEmail", "requiresBookerEmailVerification", "bookingRequiresAuthentication", "recurringEvent", "seatsPerTimeSlot", "disableCancelling", "disableRescheduling", "minimumRescheduleNotice", "useBookerTimezone", "restrictionScheduleId", "enablePerHostLocations", "maxActiveBookingsPerBooker", "bookingLimits", "durationLimits", "createdAt", "updatedAt", "price", "isInstantEvent", "assignAllTeamMembers", "assignRRMembersUsingSegment", "rrHostSubsetEnabled", "metadata") ON public."EventType" TO hourmere_import;
GRANT SELECT ("id", "eventTypeId", "label", "type", "options", "required", "placeholder") ON public."EventTypeCustomInput" TO hourmere_import;
GRANT SELECT ("eventTypeId", "userId", "scheduleId", "groupId", "memberId") ON public."Host" TO hourmere_import;
GRANT SELECT ("id", "userId", "name", "timeZone") ON public."Schedule" TO hourmere_import;
GRANT SELECT ("id", "userId", "eventTypeId", "scheduleId", "days", "startTime", "endTime", "date") ON public."Availability" TO hourmere_import;
GRANT SELECT ("id", "userId", "eventTypeId", "title", "startTime", "endTime", "status", "location", "responses", "customInputs", "createdAt", "updatedAt", "rescheduled", "recurringEventId", "paid", "description", "dynamicEventSlugRef", "dynamicGroupSlugRef", "uid", "fromReschedule") ON public."Booking" TO hourmere_import;
GRANT SELECT ("bookingId") ON public."BookingSeat" TO hourmere_import;
GRANT SELECT ("id", "bookingId", "name", "email", "timeZone", "locale") ON public."Attendee" TO hourmere_import;
GRANT SELECT ("id") ON public."Team" TO hourmere_import;
GRANT SELECT ("teamId", "userId") ON public."Membership" TO hourmere_import;
GRANT SELECT ("userId", "startDate", "endDate") ON public."TravelSchedule" TO hourmere_import;
GRANT SELECT ("userId", "start", "end") ON public."OutOfOfficeEntry" TO hourmere_import;
GRANT SELECT ("userId", "countryCode") ON public."UserHolidaySettings" TO hourmere_import;
GRANT SELECT ("id", "eventTypeId") ON public."HostGroup" TO hourmere_import;
GRANT SELECT ("userId", "eventTypeId") ON public."HostLocation" TO hourmere_import;
GRANT SELECT ("A", "B") ON public."_user_eventtype" TO hourmere_import;
GRANT SELECT ("bookingId", "type", "deleted", "meetingUrl") ON public."BookingReference" TO hourmere_import;
GRANT SELECT ("bookingId") ON public."Payment" TO hourmere_import;
```

`metadata` privileges are necessary for audited JSON-path projections. The importer never
returns full metadata. Booking `uid` and `fromReschedule` privileges are used only in the
fixed lineage comparison; neither capability is returned. Payment and seat tables are
checked only for association existence. Booking references are extracted only for unresolved
eligible booking locations and use only the audited minimum columns. No credential,
password, session, MFA, payment payload, provider event ID or host administration link is read.
Empty calendar reference URLs are ignored when resolving an existing video meeting; unsafe
nonempty URLs still block the booking, including after their contents have been redacted.

Booking text, answers and locations are read only for strictly future accepted bookings whose
current event relationships prove personal, single-host scope. Future pending/awaiting-host
and out-of-scope bookings retain only the identifiers, status and times needed to report their
blockers. Attendees and location references are read only for the personal accepted candidates.
Past/already-started rows and future cancelled/rejected rows are counted in SQL by matched
owner; their payloads are not transferred. `bookingExclusionCounts` reports `pastOrStarted`
and `terminal` separately, and `summary.excludedBookings` totals those excluded source rows.
`summary.excluded` continues to count structured exclusion problem entries. Reschedule
successor dependencies carry only identifiers, status, times and derived lineage flags;
they are not separate busy-record candidates. Raw booking capabilities never leave SQL.

The extractor uses one connection (`max=1`), a `REPEATABLE READ READ ONLY` transaction,
`SET LOCAL timezone='UTC'`, a fixed catalog search path, 15-second statement,
2-second lock and 15-second idle-transaction limits. It verifies the actual transaction
read-only/isolation/timezone settings. All data queries are fixed, parameterized,
public-schema-qualified and bounded. Extraction commits and closes before parsing;
failures roll back and close. Row/byte caps fail the entire extraction without partial output.

## Protected inputs

Use owner-only regular files (mode `0600`), outside the repository. Symlinks, group/world
permissions and oversized files are refused. Keep the source DSN in a separate protected file,
or set `CALCOM_IMPORT_SOURCE_URL` through your existing secret manager. Choose exactly one.
Neither the DSN nor credentials belong in argv, logs, reports, commits or the plan.
Do not use automatically discovered databases or an untrusted connection URL.

The target connection uses a separate protected `targetConnectionFile`, or
`CALCOM_IMPORT_TARGET_URL` (exactly one). Both connections are opened with bounded pools;
source extraction closes immediately after its read-only snapshot. Do not use the source
connection as the target, or place either connection in arguments or reports.

The protected configuration uses actual target UUIDs and explicit decisions:

```json
{
  "sourceId": "00000000-0000-4000-8000-000000000001",
  "sourceVersion": "cal.diy-a5ee96f77edd",
  "selectedUserIds": [1],
  "utcTimestampsConfirmed": true,
  "sourceConnectionFile": "/private/calcom-source-connection",
  "targetConnectionFile": "/private/hourmere-target-connection",
  "authorization": {
    "operatorUserId": "019a4321-1234-7000-8000-000000000001",
    "operatorAuthorized": true,
    "owners": [{
      "sourceUserId": 1,
      "targetUserId": "019a4321-1234-7000-8000-000000000001",
      "importPersonalData": true
    }]
  },
  "bookingDecisions": [{
    "sourceBookingId": 10,
    "sourceUserId": 1,
    "singleHostAndAttendeeRolesConfirmed": true
  }]
}
```

Record each target owner's informed opt-in outside the tool before setting their choice to
true, including confirmation of the historical single host and attendee roles. The local
operator must also be authorized to perform this migration. The booleans record these
explicit decisions; the CLI cannot establish consent merely from a database administrator
connection. The operator and owners must be existing verified accounts; every source user
must map to exactly the target UUID chosen by that owner and its existing personal
organization, with current owner membership. The tool creates no accounts, teams or grants.
Apply requires the same authorization decisions as preview and rechecks target permissions.

`utcTimestampsConfirmed` attests the source deployment's historical UTC convention for
`timestamp without time zone`; changing the transaction timezone alone cannot prove it.
Target identities, profiles, handles, slugs, schedules, default schedule, hosts, attendees,
bookings, mappings and migration checksums come from real database reads. A failed lookup
is an error, never an empty configuration. Existing profiles and defaults are preserved.

Optional `resolutions` supplies explicitly chosen replacements, for example
`{"handles":{"1":"chosen-handle"},"slugs":{"100":"chosen-slug"}}`. Re-preview after
editing it. Existing handles/slugs are never overwritten and suffixes are never guessed.
Optional `exclusions` narrows an initial batch explicitly, for example
`{"bookings":[1000],"events":[100],"acknowledged":true}`. Schedules can also be excluded.
The report lists every exclusion; remaining dependents still block if their dependency is
missing. Excluding a previously imported entity does not erase its attribution or targets.

Only trim+lowercase email matching is allowed, with both accounts verified, a unique match
and an existing personal organization. Unmatched users' dependency rows are not extracted.
Before confirming each booking, its source owner must verify the historical single host and
attendee roles; the current event owner cannot prove historical ownership. Old bookings
without `responses.email` also require `bookerAttendeeId`. Never choose the first attendee.
Optional `acceptMissingLocation` and `recurringOccurrencesComplete` record explicit source
owner decisions, and default to false. They cannot override invalid data or unsafe links.

## Register, preview and apply

Run once per **real source instance** (omit `sourceId` for this command):

```sh
npm run import-calcom --workspace @hourmere/import-calcom -- register-source --config /private/import.json
```

Save the returned random `sourceId` in the protected configuration. Reuse it for reruns and
backups of this same instance. Never generate a new namespace to bypass a conflict, or reuse
one for a different instance. Namespace identity, schema fingerprint and version are immutable.

```sh
npm run import-calcom --workspace @hourmere/import-calcom -- preview --config /private/import.json --out /private/reviewed-plan.json --report /private/reviewed-report.txt
# Preview with Chinese operator headings:
npm run import-calcom --workspace @hourmere/import-calcom -- preview --config /private/import.json --out /private/another-plan.json --lang zh-CN
npm run import-calcom --workspace @hourmere/import-calcom -- apply --config /private/import.json --plan /private/reviewed-plan.json
```

Outputs are new owner-only regular files (`0600`), created exclusively: existing files and
symlinks are refused. Human-readable console output masks email addresses and includes
counts by entity/reason, old/proposed addresses, UTC/local booking times, overlaps, buffers,
daily counts, loss codes, table row counts and the zero-external-effects guarantee. Machine
JSON and the optional authorized private report also contain names, emails, questions,
answers, private join links and inference-sensitive hashes: protect them as migration data.
Neither contains DSNs, source management capabilities, credentials or provider payloads.
No report is uploaded or sent to anyone. Structured parser problems retain static English
messages; operator headings and guidance support English and Simplified Chinese.

Review all defaults, timezone proposals, question/option conversions, omitted policies and
unimportable future bookings in the private plan. Draft events always remain inactive,
even when the source event was merely hidden. Reconnect calendars/conferences separately;
activation requires a later explicit owner review. Historical booking times are retained
outside current hours or across buffer/daily-limit differences, and remain busy.

Use a short operator-managed cutover window that freezes source changes. The importer never
writes to the source to freeze it. Apply re-extracts with the original UTC cutoff and compares
the full selected allowlist and safety dependencies, source schema, authorization decisions,
target migration version and relevant target hashes. A changed email, status, reschedule,
question/option, default schedule, membership or mapped target invalidates the plan. Database
wall time is checked before new writes and again before commit; a booking that has started
makes an uncommitted plan expire. A fully committed, unchanged replay remains a no-op after
its booking starts. Source and target are separate systems, so changes after extraction still
require the operator's cutover freeze.

All selected users form one bounded atomic target transaction; source-namespace locking
serializes competing applies. During this short transaction a bounded table write barrier
pauses target configuration, identity, booking and relevant waitlist writes instance-wide.
Reads continue. Busy targets can refuse with a safe concurrency/lock-timeout code; retry
after a new preview. Schedule/profile changes and predicate insertions cannot race the
reviewed target snapshot. For separate owner batches use separate previews with the same
source namespace and each user's explicit choice. Any unresolved import blocker or overlap
prevents the complete selected batch. No partial user, cancelled placeholder, omitted host,
disabled exclusion constraint or automatic upsert is used. The normal host exclusion and
slug/attribution uniqueness constraints remain the final concurrency checks.

First writes and immutable `import_items` mappings commit together. An unchanged rerun is a
no-op; changed source or mapped target hashes produce conflicts for a new preview and manual
resolution. After a lost response, retry the same plan: the complete ledger and each mapped
entity’s source and target hashes establish a no-op without making external calls. Changes
to an existing non-imported schedule or an unrelated account’s sign-up/profile do not change
this committed result. The broad target snapshot still protects an uncommitted plan; changes
before its first apply require a new preview. Deleted or soft-deleted targets leave
minimal numeric-source tombstones with no answers, labels, emails, fingerprints or target UUID;
a rerun cannot recreate them. Account deletion still erases its personal business data.

Apply reports `applied`, `noop` or `failed`, committed state, entity counts, failure stage,
entity/source key and stable safe codes. A crash before commit rolls back every row; a lost
connection during commit can make the response uncertain, so rerun the same plan to discover
the committed ledger. Driver text, causes, paths and credentials are never reported.
Exit `0` means successful preview/apply/no-op; `2` means preview blockers; `1` means refusal or
failed apply. `IMPORT_APPLIED` means `applied` with `committed: true`.
`IMPORT_NOOP` means the complete unchanged mapping was already committed: `noop` with
`committed: true`, no newly created entities and no external effects, including after unrelated
target changes. `IMPORT_PARTIAL_MAPPING` means only part of the batch is mapped and the
attempt failed with `committed: false`; it does not describe a complete unchanged import.
Stable refusal codes include `IMPORT_SOURCE_CHANGED`, `IMPORT_TARGET_CHANGED`,
`IMPORT_PLAN_EXPIRED`, `IMPORT_BOOKING_OVERLAP` and `IMPORT_CONCURRENT_CHANGE`.

Rollback is deliberately not automatic. A separately reviewed local cleanup must preview
current target hashes, touch only this user's unchanged newly created records and produce no
cancellation delivery. Never delete source data, existing target data or tombstones to rerun.
Changes to imported bookings in the source only appear in a new difference preview; releasing
local busy time or taking over management needs a later reconciliation design.

Imported bookings expose `source: "import"` and
`managementPolicy: "local_only_read_only"` to authorized REST/MCP/CLI readers. Admin list/detail
screens label the original-system ownership and hide move/cancel/retry actions. Management
links and ICS downloads are unavailable. All cancellation, reschedule, retry, notification,
reminder/follow-up, repair, conference, calendar reconnect/recovery and webhook paths recheck
the durable policy, including stale artifacts and connected reschedule chains. They never
send mail/ICS, create or change provider objects, or manufacture suppressed/sent receipts.

Operational limits remain 25 selected users, 10,000 rows per table, 50,000 source rows,
1 MiB per source JSON value and 32 MiB per snapshot/private plan. Oversized selections fail
without partial extraction or partial application. Target fields retain normal validation:
20 questions, 50 options, 12 durations, one booker plus ten guests. Pools stay bounded.

The earlier extraction-only parser remains available explicitly as `parse --config ...` for
synthetic/offline operator snapshots. Its `target` input is unverified, it creates no executable
preview, and it cannot apply data. Production migration uses the real-target commands above.
