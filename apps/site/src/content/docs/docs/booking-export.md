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
Team exports require current team owner/admin membership, including when the caller hosts
one of the bookings. An ordinary member cannot export team data. REST and CLI API keys
require `read` or `full`; `bookings` scope cannot export. A scope never replaces the
ownership or role check. The organization associated with the credential determines the
export's organization.

**The file contains personal data**, including invitee names, email addresses and answers.
Store it privately, share it only with authorized recipients and delete copies when no
longer needed. Deleting data in Hourmere cannot recall a downloaded file. Exports omit
manage tokens, token hashes, credential data and internal request fingerprints. Location
exports describe the chosen option; they do not provide private meeting links.

## REST

`GET /api/v1/bookings/export.csv` returns a download with
`Content-Type: text/csv; charset=utf-8`. Use the same authenticated instance as for the
booking list. The response is not cached.

| Parameter | Meaning |
|---|---|
| `from`, `to` | Required RFC 3339 instants. Include bookings starting at or after `from` and strictly before `to`. Maximum range: 366 elapsed days (366 × 24 hours). |
| `timeZone` | IANA display time zone, default `UTC`. UTC columns are always included. |
| `status` | Optional `confirmed` or `cancelled`; omission includes both. |
| `eventTypeId` | Optional event type UUID within the authorized organization. |
| `hostUserId` | Optional saved booking host UUID; collective bookings still appear once. |
| `endAfter`, `endTo` | Optional existing list filters: end strictly after, or at/before, the given instant. |
| `order` | `asc` (default) or `desc`, by start time and booking ID. |
| `bom` | `true` adds a UTF-8 byte-order mark for Excel. Default `false` keeps machine-oriented CSV free of a BOM. |
| `expectedOrganizationId` | Optional organization binding for a browser download. A changed current organization refuses the request instead of exporting a different space. |

Supply your key privately as described in the [REST quickstart](/docs/rest):

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
their UTC offsets so repeated autumn hours remain distinguishable.

## Columns

Headers are stable machine-readable names, independent of the admin interface language.

| Column | Contents |
|---|---|
| `id` | Booking UUID. |
| `event_type_id` | Associated event type UUID. |
| `event_type` | Event type title. |
| `title` | Booking title. |
| `start`, `end` | Start/end in the requested zone, with UTC offset. |
| `start_utc`, `end_utc` | The same instants in UTC. |
| `status` | Stored booking status, including cancelled predecessors after a reschedule. |
| `invitee_name`, `invitee_email` | The booking's primary invitee. |
| `guests_count` | Number of additional attendees. |
| `hosts` | JSON containing saved booking host IDs and their current names/email addresses. |
| `location_option` | JSON containing the option's ID, kind and label when present, without resolved private links. |
| `answers` | JSON keyed by question ID, preserving the saved responses. |
| `source` | Creation source, including `import` for imported local bookings. |
| `created_at`, `cancelled_at` | UTC creation/cancellation timestamps; empty cancellation value when absent. |

Answers use one JSON column instead of one column per question because an export can
span event types with different questions and historical edits. Stable question IDs keep
the header unchanged and preserve arrays and other answer types without a separate
discovery pass over all bookings. JSON values are then quoted as ordinary CSV cells.

Cells use RFC 4180 quoting: commas, quotes and line breaks are preserved, double quotes
are doubled, and record boundaries use CRLF. A cell that begins with `=`, `+`, `-`, `@`,
tab or carriage return, including after leading whitespace, receives an apostrophe
prefix. This treats spreadsheet formulas as text. JSON strings are contained within a
JSON object/array rather than becoming independent spreadsheet cells. Do not strip the
protection before opening untrusted data in a spreadsheet.

## MCP and CLI

MCP `export_bookings` takes the same filters with a boolean `bom`. It validates the
range and authorization and returns a small download pointer, not CSV rows. This keeps
large files out of the agent's context. The pointer contains no credentials and grants
no access on its own; downloading requires authentication and checks permissions again.
The REST download accepts a `read`/`full` API key or a browser session, not an MCP OAuth
token. OAuth-connected agents can provide the pointer for an authorized user to download.

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
  `409 export_in_progress`; wait for it to finish before retrying. Each export has a
  five-minute deadline and holds one database connection while streaming. Its
  repeatable-read snapshot reflects the data at export start, so changes committed
  later appear only in a new export. A disconnect or deadline releases the export slot.
- Exports are read-only. Repeating a download neither creates bookings nor sends
  notifications. Imported bookings retain `source=import` and remain managed in their
  original system. A reschedule leaves its cancelled predecessor and a new booking;
  each appears when it matches the selected range and status.
- For stored group seats, each booking is a separate row with that seat's invitee and
  answers. Hosts come from the shared slot, including cancelled-seat history; answers
  and contacts from other seats are never folded into the row.
- There is no scheduled export, email delivery, saved report or resumable download.
  A failed or interrupted transfer may leave an incomplete local file; discard it and
  request a new export, using a smaller range if needed.
- There is no attendance/no-show column because attendance tracking is not available
  in this version. A past confirmed booking does not prove that anyone attended.
- CSV is a reporting format, not a database backup or a booking import format.
