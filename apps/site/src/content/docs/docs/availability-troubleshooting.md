---
title: Troubleshoot availability
description: See why a time cannot be booked, from the admin, REST, MCP or CLI.
---

When an invitee says “there are no times on Tuesday”, open **Availability → Troubleshoot
availability**. Pick an event type and a day; Hourmere lists every possible start time of
that local day, says which ones can be booked, and gives the reason for each one that
cannot. The same answer is available to agents and scripts through REST, MCP and the CLI.
Troubleshooting reads availability only: it books, reserves or changes nothing.

## Who can use it

- Personal event types: their owner, acting in their personal space.
- Team event types: a current, verified team owner or admin acting in that team.
- API keys need **Full account access** (`full`). `read` and `bookings` keys are refused
  with `insufficient_scope`, because repeated explanations can reveal when someone is busy.
- MCP OAuth connections use the existing `mcp:tools` grant, with the same owner/admin rule.

Everyone else, including ordinary team members, assigned hosts who are not admins and
callers from another organization, gets exactly the same `event_type_not_found` answer as for
an event type that does not exist. The admin page shows this as an access message, never as a
setup problem.

## Use it in the admin

1. Open **Availability** and choose **Troubleshoot availability** (`/app/availability/troubleshoot`).
2. Choose the event type and the day. The time zone defaults to your profile’s; change it to
   read the day as an invitee elsewhere would.
3. Choose **Check this day**.

Times that are only outside your available hours are hidden by default; clear the checkbox to
see them. Team event types name the host each reason belongs to. A reason that affects only part
of a time (a buffer, for example) shows the affected range.

## Reasons

Hourmere shows only reasons its scheduling engine actually reports. Several can apply to one time.

| Code | What it means |
| --- | --- |
| `past` | The time has already passed. |
| `duration_not_offered` | The chosen meeting length is not offered by the event type. |
| `outside_working_hours` | Outside the available hours: weekly hours or a date override for that day. |
| `off_slot_grid` | Inside the available hours but not one of the offered start times. |
| `minimum_notice` | Too soon for the event type’s minimum notice. |
| `booking_window` | Further ahead than people can book. |
| `calendar_busy` | A connected calendar that is checked for conflicts is busy. |
| `buffer_before` / `buffer_after` | The buffer before or after the meeting overlaps another commitment. |
| `daily_limit` / `weekly_limit` / `monthly_limit` | The event type’s booking limit for that host-local period is reached. |
| `host_conflict` | Another Hourmere booking already takes the time. |
| `collective_member_unavailable` | A collective event needs every host, and at least one is not free. |
| `no_eligible_round_robin_host` | No host in the round-robin rotation is free. |

New codes may be added; clients should show unknown codes neutrally. Reasons never contain
calendar event titles, attendees, locations, calendar or event IDs, or booking details: only the
code, the affected interval and, for team event types, the host’s user ID. The response lists
the team’s assigned hosts with their names.

## REST

```sh
curl -H "Authorization: Bearer $HOURMERE_API_KEY" \
  "$HOURMERE_URL/api/v1/event-types/$EVENT_TYPE_ID/availability-troubleshooting?date=2026-11-16&timeZone=Europe/Berlin"
```

Query parameters: `date` (required, `YYYY-MM-DD`), `timeZone` (IANA; defaults to your profile
time zone, else UTC) and `durationMinutes` (defaults to the event length). The response:

```json
{
  "eventTypeId": "…",
  "date": "2026-11-16",
  "timeZone": "Europe/Berlin",
  "durationMinutes": null,
  "rangeStart": "2026-11-15T23:00:00Z",
  "rangeEnd": "2026-11-16T23:00:00Z",
  "hosts": [],
  "slots": [
    { "start": "2026-11-16T08:00:00Z", "end": "2026-11-16T08:30:00Z", "status": "available", "reasons": [] },
    {
      "start": "2026-11-16T08:30:00Z",
      "end": "2026-11-16T09:00:00Z",
      "status": "unavailable",
      "reasons": [{ "code": "calendar_busy", "start": "2026-11-16T08:30:00Z", "end": "2026-11-16T09:00:00Z" }]
    }
  ]
}
```

Errors: `400 invalid_date`, `invalid_time_zone`, `invalid_duration`, `range_too_long`;
`403 insufficient_scope`; `404 event_type_not_found`; `409 calendar_sync_unavailable` when
connected calendars cannot be read right now, or `409 location_unavailable` when the event’s
default location cannot be offered.

## MCP

Call `troubleshoot_availability` with `{ "eventTypeId": "…", "date": "2026-11-16" }` and
optional `timeZone` and `durationMinutes`. `structuredContent` is the same object as the REST
response. Ask an agent, for example: “Why can nobody book my intro call next Tuesday?”

## CLI

```sh
echo '{"eventTypeId":"…","date":"2026-11-16","timeZone":"Europe/Berlin"}' |
  hourmere troubleshoot-availability --input -
```

The CLI prints the same JSON. It needs a `full` key.

## Known limitations

- One local day per request. A DST change day has 23 or 25 hours; start times that do not
  exist locally are skipped and repeated ones use their first occurrence, like ordinary
  availability.
- Explanations reflect the calendar data Hourmere already has. They do not refresh connected
  calendars; if a calendar cannot be read, you get `calendar_sync_unavailable` instead of reasons.
- `outside_working_hours` does not say whether weekly hours or a date override closed the time;
  check both on the schedule.
- The admin page explains the event’s default meeting length and default location. Use REST,
  MCP or the CLI with `durationMinutes` for another offered length.
- Event types with a very fine slot step over many hosts can exceed the candidate budget and
  return `range_too_long`.
