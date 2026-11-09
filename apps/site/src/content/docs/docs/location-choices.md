---
title: Meeting location choices
description: Offer meeting locations, collect a phone number and preserve the invitee’s choice.
---

Offer up to five meeting locations on one event type. Invitees choose a location on the
public booking form; the default starts selected. A single option does not show a choice.
Personal, team, embedded and one-time booking pages support the same form, including a
required phone field when the host will call the invitee. Choose the location before
choosing a time so availability reflects that option. This feature is included in
self-hosted installations without an additional setting or subscription.

## Configure locations

Use REST `POST /api/v1/event-types` or `PATCH /api/v1/event-types/{id}`, MCP
`create_event_type` / `update_event_type`, or CLI `create-event` / `update-event`.
Configuration writes require a **Full account access** API key and the existing owner or
team permissions. The web event editor shows a read-only notice when multiple options
are configured, with instructions to manage them through REST, MCP or CLI. It preserves
those options when saving unchanged legacy location settings.

`locations` is an ordered list of 1–5 options, or `null` to clear it. Each option needs a
stable `id` and a distinct kind. IDs contain 1–64 ASCII letters, digits, underscores or
hyphens, excluding `__proto__`. Optional labels are public single-line text of up to 100
characters. At most one option has `isDefault: true`; otherwise the first is the default.

For example, save this JSON and run `hourmere create-event --input event-request.json`:

```json
{
  "slug": "introduction",
  "title": "Introduction",
  "durationMinutes": 30,
  "locations": [
    { "id": "office", "kind": "in_person", "address": "100 Example Street", "isDefault": true },
    { "id": "call", "kind": "phone", "askInvitee": true }
  ]
}
```

| Kind | Settings |
|---|---|
| `in_person` | `address`: single line, 1–500 characters. |
| `link` | `url`: absolute HTTP(S) URL, up to 2000 characters. |
| `phone` | Either a host `number` or `askInvitee: true`. Numbers use E.164: `+`, then 7–15 digits, starting with a nonzero digit. |
| `google_meet` | Optional `autoCreate: true` uses the existing automatic Meet rules. |
| `zoom` | Optional `autoCreate: true` uses the existing automatic Zoom rules. |

Meet and Zoom without `autoCreate` are passive labels; they do not create meetings.
Automatic options require the appropriate connected account and destination settings.
See [automatic Google Meet](/docs/automatic-google-meet) and [automatic Zoom](/docs/automatic-zoom).
Every automatic option is validated, including options that are not the default.

Read the saved configuration with REST `GET /api/v1/event-types/{id}`, MCP
`get_event_type`, or CLI `event`. Updates replace the complete list; omission preserves it.
Keep IDs when editing settings or reordering. Allocate a new ID when removing and recreating
an option or changing its kind, so an older open page cannot select a different option.

The compatibility field `location` is derived from the default option. Do not send both
`location` and `locations`. Echoing an unchanged `location` preserves the list. A different
legacy value cannot overwrite multiple or labelled options: `location_options_conflict`
asks the client to update `locations`. Configure invitee phone collection through
`locations`; new legacy `location: {"kind":"phone","askInvitee":true}` writes remain rejected.

## Book a location

Public discovery exposes only option IDs, kinds, public labels, the default marker and
whether a phone number is required. Host numbers, addresses, saved URLs and connected
account details are not exposed before booking. Treat labels as public content.

REST booking creation and MCP `create_booking` accept `locationOptionId` and, for the
invitee-phone option, `inviteePhone`. The CLI `book` accepts the same fields in its JSON
input. For example, add these fields to an ordinary personal, team or one-time booking request:

```json
{
  "locationOptionId": "call",
  "inviteePhone": "+14155550123"
}
```

Slot queries also accept `locationOptionId` (REST query parameter, MCP
`find_available_slots`, or CLI `slots` JSON input). Automatic Meet availability and
round-robin assignment use the same Meet-eligible host pool; fairness chooses among
those eligible hosts.

Invitee phone input accepts spaces, parentheses, hyphens and periods and normalizes
them to E.164: `+` followed by 7–15 digits **in total**, including the country code,
with a nonzero first digit. Extensions and local numbers without a country code are invalid.

Omitting the choice uses the default. A removed or unknown ID returns
`invalid_location_choice`; an absent or invalid required phone returns
`invalid_invitee_phone`. A chosen automatic location that cannot be provided for the
assigned host returns `location_unavailable`, without silently switching hosts or locations.
An event with exactly one location keeps its earlier behavior when the choice is omitted,
whatever that option's ID: slot lookup and booking return the existing automatic-meeting
readiness codes (such as `automatic_meet_unavailable`), and the booking stores that location's
settings as configured. Choosing that option explicitly uses `location_unavailable`.
Retain the same idempotency key and input for retries; changing the choice or phone with
the same key is a different request.

The booking stores the selected option and resolved details. Confirmation and management
pages, host booking details, host/invitee emails and calendar invitations use the saved
location. An invitee-provided phone number is visible only to hosts, authorized host
administration and the invitee themself. Guest emails and calendar invitations use
neutral phone-call text without the number. Phone details explain whether the host
calls the invitee or the invitee calls the host. Choosing an automatic
video option starts the existing conference workflow, with pending/failure handling and
ready-link invitations; other options create no conference.

## Rescheduling and limits

- Rescheduling preserves the original choice and phone/address/link, even if the host edits
  or removes that option. Changing the location during a reschedule is unavailable through
  every interface. Automatic meetings keep their existing conference and organizer.
- There is at most one option of each kind, so multiple addresses or phone numbers cannot
  be offered together. Options share hosts, durations, questions and booking rules.
- Automatic Zoom supports only individual events with one authorized host. Collective and
  round-robin Zoom remain unsupported. Meet uses the required collective organizer or the
  actual assigned round-robin host; it never borrows another host’s connection.
- Group-seat events have internal service support but are not enabled in public pages,
  event editors or REST/MCP/CLI configuration. Internal seats use the shared slot’s
  default location and conference; per-invitee location selection and phone collection
  are unavailable for group seats.
