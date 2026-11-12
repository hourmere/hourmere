---
title: Ask an invitee to choose another time
description: Request a new meeting time while keeping the original booking confirmed.
---

Open a future booking you host and choose **Request reschedule**. Add an optional note,
then send the request. The invitee receives an email with their private management link.
They can choose a new time from the usual availability picker or cancel the booking.
The same feature is available on self-hosted installations, REST, MCP and CLI.

## What happens to the original booking

The original time stays booked and blocks availability. Calendar entries, meeting links
and reminders remain in effect until the meeting is moved or cancelled. This preserves
the time both sides already agreed to while the invitee considers alternatives; no
alternative is reserved merely by opening the picker.

A request expires after 48 elapsed hours, or when the original meeting starts, whichever
comes first. If it expires, the original booking stays in place and the hosts receive an
email. A delayed worker may deliver that notice later. Sending another request replaces
the previous request. You can still move or cancel the booking yourself.

When the invitee picks a time, the normal rescheduling rules apply, including notice,
booking windows, buffers, booking limits, calendar conflicts and required hosts. The
usual calendar, conference and reminder updates run, and hosts receive the normal
reschedule confirmation. Collective and round-robin bookings keep their ordinary
invitee-reschedule host rules.

## Notes and delivery

Notes are plain text, at most 2000 UTF-16 code units (some characters use two units).
Line breaks are allowed; tabs and unsupported controls are rejected. Line endings and
bidirectional formatting controls are normalized like follow-up notes. The note appears
only in the email body, never its subject. Formatting, links and placeholders are not
generated from the note. Request emails are translated into English, Simplified Chinese,
German, French, Spanish and Brazilian Portuguese using the invitee's saved locale.

[Email budgets and retries](/docs/notifications) still apply. Saving a request does not
prove delivery; a message can be suppressed by the recipient or instance limit. No email
is sent to guests just to ask the booker for another time. Hosts receive the ordinary
pick confirmation, or the expiry notice if no replacement is chosen.

## API and agents

Send `POST /api/v1/bookings/{id}/request-reschedule` with a UUID `idempotencyKey` and optional
`note`. It returns the booking with `pendingReschedule` containing `id`, `expiresAt` and
`note`. A session write must supply the usual expected organization header. API keys need
`bookings` or `full` scope and must belong to an authorized host.

Booking responses include the optional `isGroupSeat: true` flag for group-seat bookings;
other bookings omit it. REST, MCP and CLI clients can use this flag to skip unsupported
reschedule requests for group seats. Its absence does not guarantee the action is allowed;
the other booking and authorization rules still apply.

MCP exposes `request_reschedule` with `bookingId`, `idempotencyKey` and optional `note`.
CLI exposes `request-reschedule`; use `--help` for the matching options. Keep the same key
and body when retrying a lost response. Changing the note with the same key fails;
use a fresh key for a deliberate replacement request.

Managed pick and cancellation accept `rescheduleRequestId`, the `pendingReschedule.id`
being answered. Keep it with the selected time when retrying. It prevents a stale tab from
answering a newer request and makes the same answer safe to replay. A replayed pick can
return `manageToken: null`; keep the existing emailed management link. Clients that omit
the request identity retain ordinary management semantics and should not automatically
retry a move. Responses are additive; ignore unknown fields and error codes.

Webhook subscriptions can opt into `booking.reschedule_requested` and
`booking.reschedule_request_expired`. Both include a `requestId` and leave the booking's
status `confirmed`. Neither includes the note or private management link.

## Known limitations

- Imported bookings are read-only; request a change in their original system.
- Group-seat bookings do not support this action.
- The timeout is fixed at 48 hours, capped by the meeting start; it is not configurable.
- Expiry keeps the original meeting. It does not cancel the meeting or free the slot.
- A request does not bypass the instance's invitee reschedule limit or unavailable hosts.
- Email delivery can be delayed or suppressed. Pending status is not a delivery receipt.
