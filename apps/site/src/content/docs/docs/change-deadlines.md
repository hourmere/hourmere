---
title: Reschedule and cancel deadlines
description: Stop invitees from moving or cancelling a booking through their link shortly before it starts.
---

Set how long before a meeting starts its invitee can no longer reschedule, and separately
no longer cancel, through their own management link. Hosts keep full control: they can
still move or cancel the booking themselves. Deadlines are available on self-hosted
installations and through the event-type editor, REST, MCP and CLI.

## How a deadline works

Each event type has two optional settings, both in whole minutes before the start:

- **Reschedule deadline** (`rescheduleCutoffMinutes`): from this point the invitee can no
  longer choose another time.
- **Cancel deadline** (`cancelCutoffMinutes`): from this point the invitee can no longer
  cancel.

Each accepts a whole number from **1 to 525600** (one year), or no value for no deadline.
No deadline is the default: the invitee can change the booking until it starts. The two
deadlines are independent; for example, rescheduling can close 48 hours before the start
(`2880`) while cancelling stays open until 24 hours before (`1440`).

A change is allowed strictly before the deadline instant. At exactly the deadline, and
afterwards, it is refused. Minutes are elapsed time: across a daylight-saving change, a
1440-minute deadline is exactly 24 hours before the start, which can be a different
wall-clock time on the previous day.

### Each booking keeps its own deadlines

A booking stores the deadlines that applied when it was booked. Changing the event type
later **never changes existing bookings**: they keep their earlier deadline, or their lack
of one. Bookings made before upgrading to a version with this feature have no deadline.

A rescheduled booking keeps the original booking's deadlines, whether the invitee or a
host moved it; they are not read again from the event type. The deadline always counts
back from the booking's current start, so after a move it follows the new time.

## Configure an event type

Open **Event types**, edit the event, and set the reschedule and cancel deadlines beside
the other scheduling rules. Leave a deadline blank for none. Save the event to apply it to
new bookings.

### REST

Send `rescheduleCutoffMinutes` and `cancelCutoffMinutes` with `POST /api/v1/event-types`
or `PATCH /api/v1/event-types/{id}`. API keys need `full` scope and the usual
organization, role and ownership permissions. For example, PATCH:

```json
{
  "rescheduleCutoffMinutes": 2880,
  "cancelCutoffMinutes": 1440
}
```

Omission on creation means no deadline; omission on update preserves the saved value, and
`null` removes a deadline. Event-type reads return both fields. Values outside 1–525600,
fractions and non-numbers are rejected with `400 invalid_request`, never rounded or clamped.

### MCP and CLI

MCP `create_event_type` and `update_event_type` accept the same fields; `get_event_type`
returns them. Updates use a flat object with `id` alongside changed fields:

```json
{
  "id": "<event-type-uuid>",
  "rescheduleCutoffMinutes": 2880,
  "cancelCutoffMinutes": 1440
}
```

The CLI passes the same JSON to MCP. Save that object in `event-update.json`, then run:

```sh
hourmere update-event --input event-update.json
```

`create-event` accepts the same fields along with `slug`, `title` and `durationMinutes`,
and `event` returns the saved settings. See the [REST guide](/docs/rest),
[MCP guide](/docs/mcp) and [CLI guide](/docs/cli) for client setup.

## What invitees see

While a change is still open, the booking management page says until when the invitee can
reschedule or cancel online. After a deadline, the page explains that the change is no
longer available online and asks the invitee to contact the host, instead of showing that
button.

The deadlines apply to every use of the invitee's management link: the management page,
the public REST endpoints called with `X-Manage-Token`
(`GET /api/v1/bookings/manage/slots`, `POST /api/v1/bookings/manage/reschedule` and
`POST /api/v1/bookings/manage/cancel`), and MCP `reschedule_booking` and `cancel_booking`
called with `manageToken`. After the reschedule deadline, slot lookup through the link is
refused as well.

`GET /api/v1/bookings/manage` returns `changeDeadlines` with `rescheduleBy` and `cancelBy`:
the ISO instants from which each change is refused, or `null` when there is no deadline.

## What hosts and team admins can do

Hosts are not limited by either deadline. They can reschedule and cancel inside it from
the booking detail page, REST, MCP or CLI with `bookingId`. Team admins can still cancel
team bookings from the dashboard. A host move does not reset the deadline: the booking
keeps its original minutes, counted from the new start.

### Requests to choose another time

The invitee answers a [request to choose another time](/docs/request-reschedule) through
their management link, so the reschedule deadline applies. A request expires after
48 hours, when the meeting starts, or at the booking's reschedule deadline, whichever comes
first. Once that deadline has passed, sending a request is refused with
`409 booking_reschedule_deadline_passed`; move the booking yourself instead.

## Interactions with other rules

- **Minimum notice** still decides which new times the invitee can choose. If minimum
  notice allows it, a booking can move to a time that is already inside its own deadline;
  the deadline applies to the booking being changed, not to the new time.
- **Booking window** is unaffected.
- **Invitee reschedule limit** (five moves per booking chain by default) still applies
  independently.
- **Paid bookings:** invitee management of paid bookings is not available yet
  (`409 paid_booking_management_unavailable`). Their deadlines are stored but change
  nothing yet.
- **Group seats:** each seat booking keeps its own deadlines. After the deadline, an
  invitee cannot move a seat to another time; choosing the same time again is not refused,
  because it changes nothing.
- **Imported bookings** remain read-only (`409 imported_booking_read_only`).

## Error codes

| Status and code | Meaning |
|---|---|
| 409 `booking_reschedule_deadline_passed` | The invitee's reschedule deadline has passed; contact the host. Also returned when a host sends a request to choose another time after that deadline. |
| 409 `booking_cancel_deadline_passed` | The invitee's cancel deadline has passed; contact the host. |

Other checks come first: an unknown token returns `404 booking_not_found`, a cancelled
booking `409 booking_cancelled`, and a booking that has started `409 booking_in_past`.
MCP and CLI return the same codes as REST. An answer to a host's request that carries
`rescheduleRequestId` gets `409 reschedule_request_changed` instead once the reschedule
deadline has passed, because the request expired at that deadline; load the booking again.

## Known limitations

- Deadlines are whole minutes before the start. Business days and wall-clock rules such
  as "noon the day before" are not supported.
- Confirmation and reminder emails do not state the deadline yet; the management page
  does.
- Existing bookings are never updated when the event type changes. This is by design.
- A [Cal.com import](/docs/calcom-import) does not import Cal.com's equivalent settings.
- If a host reschedules a booking, the deadline counts from the new start time.
