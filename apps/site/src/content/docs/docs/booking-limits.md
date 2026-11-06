---
title: Booking limits
description: Set daily, weekly and monthly booking allowances for an event type.
---

Set a maximum number of bookings per day, week or month in the event-type editor,
REST, MCP or CLI. All three limits are available on self-hosted installations.

## Configure an event type

Open **Event types**, edit the event, and set the daily, weekly or monthly booking
limit beside the other scheduling rules. Leave a limit blank for no ceiling for
that period. Each configured limit must be a whole number from **1 to 1000**.
Save the event to apply the changes.

Limits cannot decrease as periods get longer: day ≤ week, week ≤ month, and day ≤
month whenever both values in a pair are set. The day/month rule also applies when
the weekly limit is blank. For example, day 2, week 5 and month 20 is valid; day 2
and week 1 is not. These checks compare configured allowances, even though a calendar
week can cross a month boundary.

Saving unrelated metadata preserves limits you did not edit. Clearing one input
removes only that period's ceiling. Lowering a limit **does not cancel or change
existing bookings**. A period already at or above its new limit accepts no further
bookings until capacity becomes available.

## Periods and time zones

The host's effective availability schedule supplies the IANA time zone: the selected
schedule for that host, or their default schedule where applicable. The invitee's
display zone, profile zone and database zone do not change the count.

- A day runs from local midnight to the next local date.
- An ISO week starts on **Monday** and ends before the following Monday. It may
  cross a month or year boundary.
- A month starts on its first local date and ends before the first date of the next
  calendar month. It is not a rolling 30-day window.

A booking belongs to each period according to its **start instant's local date**,
including when the meeting ends in another period. Period starts are inclusive and
ends are exclusive. Calendar boundaries follow the schedule's time zone, including
daylight-saving changes, leap days and months of different lengths; they are not
fixed multiples of 24 hours.

## What counts

Only non-cancelled bookings of this event type assigned to the evaluated host count.
All offered meeting lengths share the same allowances. Other event types can block
overlapping time but do not consume this event type's allowance.

Personal and individual team events count their one host. Collective events require
capacity for every required host in that host's schedule zone. Round-robin events
check each candidate separately and consume only the assigned host's capacity.

Availability hides starts when any configured period is full. Creation and rescheduling
check the same limits when committing, so simultaneous requests cannot exceed a ceiling.
A successful idempotent booking replay returns the original booking even if it used the
last allowance. Rescheduling checks the destination periods while excluding its own
predecessor; a failed move keeps the original booking. Cancellation frees capacity.

## REST, MCP and CLI

The JSON fields are `maxBookingsPerDay`, `maxBookingsPerWeek` and
`maxBookingsPerMonth`. Each accepts an integer from 1 to 1000 or `null` to remove that
ceiling. Omission on creation means no ceiling; omission on update preserves the
existing value. Updates validate the combined saved and supplied values.

Authenticated event-type reads return these fields. REST uses
`POST /api/v1/event-types` and `PATCH /api/v1/event-types/{id}`; API keys need `full`
scope and the usual organization, role and ownership permissions. For example, PATCH:

```json
{
  "maxBookingsPerDay": 2,
  "maxBookingsPerWeek": 5,
  "maxBookingsPerMonth": 20
}
```

MCP `create_event_type` and `update_event_type` accept the same fields. Updates use a
flat object with `id` alongside changed fields:

```json
{
  "id": "<event-type-uuid>",
  "maxBookingsPerWeek": 5,
  "maxBookingsPerMonth": 20
}
```

For the CLI, save that object in `event-update.json`, then run:

```sh
hourmere update-event --input event-update.json
```

`create-event` accepts the same limit fields along with `slug`, `title` and
`durationMinutes`. MCP `get_event_type` and CLI `event` return the settings. These
surfaces use the same service validation; out-of-range, fractional and inconsistent
limits are rejected rather than rounded or silently clamped. REST returns
`400 invalid_request` for wrong types or fractional numbers and `400 invalid_event_type`
for integer bounds or inconsistent ceilings; MCP and CLI preserve those error codes. See the
[REST guide](/docs/rest), [MCP guide](/docs/mcp) and [CLI guide](/docs/cli) for client setup.

## Current limitations

- There is no organization-wide or round-robin pool-wide quota; ceilings are per
  event type and actual host.
- Limits count bookings, not attendees, guests, minutes or meeting lengths.
- Weeks start on Monday; a custom week start and rolling seven-day or thirty-day
  windows are not supported.
- Limits control new availability and booking writes. They do not remove existing
  reservations after a policy change.
