---
title: Marking no-shows
description: Record attendance privately for individual invitees and guests through the dashboard, REST, MCP or CLI.
---

Hosts can mark an attendee as a no-show after the booking's scheduled start, or remove
that mark if it was a mistake. Open the booking's detail in **Bookings** and use the
action next to the attendee. Team owners and admins can also do this from the team's
booking detail. The feature is included in self-hosted installations without a plan gate.

## Who and what the mark describes

A mark belongs to one attendee on one booking, including a guest. It never marks all
attendees at once. Group seats and their guests remain independent. For a collective
meeting, all actual booking hosts see and can change the same attendee marks. For a
round-robin booking, only the assigned booking host has host authority; other pool
members do not. Current team owners and admins can manage either kind of team booking.
Being an event type's creator, an ordinary team member, or the holder of an invitee's
management link does not grant attendance management permission.

The server checks the scheduled start as an absolute instant. Exactly at the start is
too early; it must be later. Local clock display, time zones and daylight-saving changes
do not change that boundary. Cancelled bookings and imported read-only bookings refuse
both marking and unmarking. Requests for another attendee or organization confer no access.

The stored mark records the marking account ID and instant. Repeating the same mark
preserves that original attribution and time; repeating an unmark is also harmless.
Unmarking clears both fields. Competing requests serialize, so the final stored state
reflects one ordered sequence of changes. This is current state, not a permanent audit
history of every correction.

## REST, MCP and CLI

Authenticated booking reads include attendee IDs and optional `noShowMarkedAt` and
`noShowMarkedBy` fields. A null timestamp means unmarked. Clients must tolerate absent
fields from older servers. Use the attendee ID, not an email address or display name. For a known booking ID,
`GET /api/v1/bookings/{id}/attendees`, MCP `get_booking_attendees` and CLI
`booking-attendees` return the authorized attendee list and current markers. These
reads also work for team owners/admins who are not booked hosts; the existing general
booking list remains host-scoped. Obtain a team booking ID from the team dashboard.

```http
PATCH /api/v1/bookings/{bookingId}/attendees/{attendeeId}/no-show
Content-Type: application/json
Authorization: Bearer hm_…

{"noShow":true}
```

Send `{"noShow":false}` to remove the mark. The response contains `attendeeId`,
`noShowMarkedAt` and `noShowMarkedBy`. MCP uses `set_attendee_no_show` with
`bookingId`, `attendeeId` and `noShow`. The CLI exposes the same tool as `set-no-show`;
run `hourmere set-no-show --help` for the input format.

API keys need `bookings` or `full` to change attendance; `read` can inspect authorized
attendee markers but cannot change them. Existing host,
organization and verified-membership checks still apply. MCP OAuth retains its existing
`mcp:tools` grant. No new API-key scope is introduced.

## Privacy and other booking behavior

The marker is private administrative metadata. Invitee booking and management pages,
public booking responses and emails do not show it. Marking or unmarking sends no email,
changes no calendar event or conference, and does not release capacity or change booking
status. Existing reminders and follow-ups retain their schedules and eligibility rules;
a follow-up may still be sent to an attendee marked as a no-show.

Cancellation keeps any historical marker on the cancelled booking. A reschedule creates
a new booking with fresh, unmarked attendee records; it does not transfer a previous
meeting's attendance judgment. Cancelled predecessors cannot be edited.

When enabled and explicitly subscribed, [webhooks](/docs/webhooks) emit
`booking.attendee_no_show_changed` for each actual mark or unmark, in the same transaction.
Exact replays emit nothing. The payload includes the attendee ID and marker fields but
no attendee name, email, management link or other contact details. Existing subscriptions
are unchanged; opt in to the new event. Normal delivery retry and ordering limitations apply.

## Known limitations

There is no automatic attendance detection, attendance export, aggregate no-show report,
penalty, refund, or attendance-based follow-up rule. The stored fields are available for
future reporting/export work. A marker is a host's judgment, not evidence from a meeting
provider. Corrections overwrite current state; webhook retention is not a permanent audit
log. Imported bookings remain managed in their original system.
