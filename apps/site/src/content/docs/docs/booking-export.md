---
title: CSV booking export
description: Download bookings for reporting with bounded streaming, spreadsheet protection and organization permissions.
---

Personal owners and team owners/admins can download bookings from **Bookings** using
**Export bookings as CSV**. Choose a start-time range using the labelled UTC fields.
The panel shows the display time zone used in the CSV. The download
retains the page's current filters and adds the selected bounded range. This feature is
included in self-hosted Hourmere without a separate service or paid feature flag.

## Permissions and personal data

Personal exports contain only the owner's bookings in their personal organization.
Team exports require a current verified browser session and current team owner/admin
membership, including when the caller hosts one of the bookings. An ordinary member
cannot export team data. Team API keys and MCP OAuth grants receive
`403 team_management_access_denied`, matching team-wide booking reads.
Personal REST and CLI API keys require `read` or `full`; `bookings` scope cannot export.
A scope never replaces ownership checks. The credential's organization determines scope;
there is no API-key exception for team owners/admins.

**The file contains personal data**, including invitee names and email addresses; personal files also contain custom answers.
Store it privately, share it only with authorized recipients and delete copies when no
longer needed. Deleting data in Hourmere cannot recall a downloaded file. Exports omit
manage tokens, token hashes, credential data and internal request fingerprints. Personal location
exports describe the chosen option; they do not provide private meeting links.

## REST

`GET /api/v1/bookings/export.csv` returns a download with
`Content-Type: text/csv; charset=utf-8`. Use the same authenticated instance as for the
booking list. The response is not cached.

| Parameter | Meaning |
|---|---|
| `from` | Required RFC 3339 instant. Include bookings starting at or after this instant. |
| `to` | Required RFC 3339 instant. Include bookings starting strictly before this instant. Must be after `from`, at most 366 elapsed days (366 × 24 hours) later. |
| `timeZone` | IANA display time zone, default `UTC`. UTC columns are always included. |
| `status` | Optional `confirmed` or `cancelled`; omission includes both. |
| `eventTypeId` | Optional event type UUID within the authorized organization. |
| `hostUserId` | Optional saved booking host UUID; collective bookings still appear once. |
| `endAfter` | Optional existing list filter: end strictly after the given instant. |
| `endTo` | Optional existing list filter: end at or before the given instant. |
| `order` | `asc` (default) or `desc`, by start time and booking ID. |
| `bom` | `true` adds a UTF-8 byte-order mark for Excel. Default `false` keeps machine-oriented CSV free of a BOM. |
| `expectedOrganizationId` | Optional organization binding for a browser download. A changed current organization refuses the request instead of exporting a different space. |

For a personal export, supply your key privately as described in the [REST quickstart](/docs/rest):

```sh
curl --fail-with-body --get "$HOURMERE_URL/api/v1/bookings/export.csv" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode 'from=2026-11-01T00:00:00Z' \
  --data-urlencode 'to=2026-12-01T00:00:00Z' \
  --data-urlencode 'timeZone=America/Los_Angeles' \
  --data-urlencode 'bom=true' \
  --output bookings.csv
```

For a range defined by local calendar dates, convert each boundary separately in that
time zone. A daylight-saving transition can make a local day 23 or 25 hours; adding
24 elapsed hours is not always the next local midnight. Local start/end values include
their UTC offsets so repeated autumn hours remain distinguishable. For example,
`2026-03-29T01:30:00+01:00` has no bracketed zone suffix; the IANA zone is in
`time_zone`. Spreadsheet date parsing still depends on the chosen import settings.

## Columns

Headers are stable machine-readable names, independent of the admin interface language.
The table below describes the **personal** column set in header order. Team exports use only `id`,
`event_type_id`, `event_type`, `start`, `end`, `start_utc`, `end_utc`, `status`,
`invitee_name`, `invitee_email`, `guests_count`, `hosts`, `cancelled_at` and `time_zone`.
Team `hosts` contains IDs and names only, including for former members; no host email
addresses are exported. Team files exclude booking titles, cancellation reasons, custom
answers, location metadata/links, source attribution and creation timestamps, following
the existing team-admin booking-read data boundary. A deleted event type has an empty title.

| Column | Contents |
|---|---|
| `id` | Booking UUID. |
| `event_type_id` | Associated event type UUID. |
| `event_type` | Event type title. |
| `title` | Booking title. |
| `start` | Start in the requested zone, with UTC offset. |
| `end` | End in the requested zone, with UTC offset. |
| `start_utc` | Start instant in UTC. |
| `end_utc` | End instant in UTC. |
| `status` | Stored booking status, including cancelled predecessors after a reschedule. |
| `invitee_name` | The primary invitee's name. |
| `invitee_email` | The primary invitee's email address. |
| `guests_count` | Number of additional attendees. |
| `hosts` | JSON containing saved booking host IDs and their current names/email addresses. |
| `location_option` | JSON containing the option's ID, kind and label when present, without resolved private links. |
| `answers` | JSON keyed by question ID, preserving the saved responses. |
| `source` | Creation source, including `import` for imported local bookings. |
| `created_at` | UTC creation timestamp. |
| `cancelled_at` | UTC cancellation timestamp, empty when absent. |
| `time_zone` | Requested IANA zone, such as `Europe/Berlin`. |

Answers use one JSON column instead of one column per question because an export can
span event types with different questions and historical edits. Stable question IDs keep
the header unchanged and preserve arrays and other answer types without a separate
discovery pass over all bookings. JSON values are then quoted as ordinary CSV cells.

Cells use RFC 4180 quoting: commas, semicolons, quotes and line breaks are preserved, double quotes
are doubled, and record boundaries use CRLF. A cell that begins with `=`, `+`, `-`, `@`,
tab or carriage return, including after leading whitespace, receives an apostrophe
prefix. A trigger after a comma, including intervening whitespace, also prefixes the
entire cell. A trigger after a semicolon receives an apostrophe immediately after that
semicolon, protecting against common locale list-separator splitting even in a complete
comma-delimited row. Cells containing semicolons are quoted as well.
JSON serialization escapes semicolons as `\u003b` before CSV protection, so parsing the
JSON preserves the original values. Programmatic JSON consumers must remove the single
leading protection apostrophe, when present, before parsing the JSON.
For reliable interpretation use **Data → From Text/CSV** and explicitly choose the comma
delimiter and text column types for untrusted fields. This is defense in depth, not a
universal guarantee across spreadsheet applications: alternate delimiter/quote handling,
full-width formula characters and re-saving or stripping apostrophes can bypass protections.
Do not remove protection before opening untrusted data in a spreadsheet.

## MCP and CLI

For personal organizations, MCP `export_bookings` takes the same filters with a boolean `bom`. It validates the
range and authorization and returns a small download pointer, not CSV rows. This keeps
large files out of the agent's context. The pointer contains no credentials and grants
no access on its own; downloading requires authentication and checks permissions again.
The REST download accepts a `read`/`full` API key or a browser session, not an MCP OAuth
token. OAuth-connected personal agents can provide the pointer for an authorized user
to download. Team exports are browser-only: neither MCP nor CLI can obtain a team pointer.

The CLI `export` command streams that download to stdout or to `--output FILE`, using
the same key. Put the query in a private JSON input file:

```json
{
  "from": "2026-11-01T00:00:00Z",
  "to": "2026-12-01T00:00:00Z",
  "timeZone": "America/Los_Angeles",
  "bom": true
}
```

```sh
npm run --silent cli -- export --input export-request.json --output bookings.csv
# Or stream to another program through stdout:
npm run --silent cli -- export --input export-request.json
```

## Limits and known limitations

- Rows are read with keyset pagination in batches of 100, rather than loading the full
  result in memory. Only one export per organization can run at a time, enforced in
  PostgreSQL across web processes. Another active download receives
  `409 export_in_progress`; wait for it to finish before retrying. There is also a
  process-wide cap configured by `BOOKING_EXPORT_MAX_CONCURRENT` (default 2, valid 1–8;
  empty means unset; invalid settings prevent startup). A full process cap returns `409 export_busy` before acquiring
  a database connection. Each user can run only one export per process across personal
  and team spaces; another request receives `409 export_user_in_progress`. The user
  limit and process cap are per process, not cluster-wide. Each stream is cut off after 30 seconds without a reader pull,
  as well as after a five-minute overall deadline, returning its connection. Its
  repeatable-read snapshot reflects the data at export start, so changes committed
  later appear only in a new export. A disconnect, stalled reader or deadline releases
  the export slot.
- Exports are read-only. Repeating a download neither creates bookings nor sends
  notifications. Personal imported bookings retain `source=import`; imported bookings remain managed in their
  original system. A reschedule leaves its cancelled predecessor and a new booking;
  each appears when it matches the selected range and status.
- For stored group seats, each booking is a separate row with that seat's invitee and
  answers for personal exports (team exports omit answers). Hosts come from the shared
  slot, including cancelled-seat history; answers
  and contacts from other seats are never folded into the row.
- There is no scheduled export, email delivery, saved report or resumable download.
  The browser prepares the download in memory and shows failed-request errors in the panel;
  narrow team ranges for large downloads. For large personal exports, prefer CLI streaming.
  The CLI removes an output file it created if the download fails, and reports API error
  codes such as `export_busy` or `organization_context_changed`. Stdout and other HTTP
  clients can retain partial bytes: discard them and request a new export.
- There is no attendance/no-show column because attendance tracking is not available
  in this version. A past confirmed booking does not prove that anyone attended.
- CSV is a reporting format, not a database backup or a booking import format.
