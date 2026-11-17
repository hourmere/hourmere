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
API configuration writes require a **Full account access** API key and the existing owner
or team permissions. In the web event editor, choose one location in the initial form.
Expand the location settings to add, edit or reorder choices and choose the default.
Saving another setting preserves the ordered choices and their identities.

In **Event types**, create or edit an event, then expand **Location options and conferencing**:

1. Choose **Add location option** and fill in the address, phone number or custom link.
   For a phone call, enable **Invitee provides a phone number** when the host should call;
   otherwise enter the host number for the invitee to call.
2. Give options optional public labels, such as “Office visit” or “Video call”. Do not
   put private contact details in these labels.
3. Use **Move location up** / **Move location down** to change the displayed order, and
   **Default location** to select the initial choice. Reordering preserves the chosen default.
4. Remove unwanted options, then save the event. Changes apply to future bookings;
   existing bookings keep their saved location.

The essentials-only form still starts with one location. Expanding it preserves that
choice, including a preselected video provider. If you add Google Meet or Zoom as an
alternative, its automatic-creation checkbox appears too; Zoom also needs the host's
authorized meetings account. A collective automatic Meet option needs a required host
selected as its organizer, even when another location is the default.

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

The saved details below appear in the booking confirmation, emails and calendar
invitations (ICS), subject to the recipient-specific phone rules.

| Option | Before booking | After booking |
|---|---|---|
| In person | Kind and optional public label | Saved address |
| Invitee calls host | Phone kind and optional public label; no host number | Host number and call instructions |
| Host calls invitee | Phone kind and a required invitee phone field | Host/invitee receive the collected number and call instructions; guests receive neutral phone-call text without that number |
| Custom link | Kind and optional public label; no saved URL | Saved meeting link |
| Google Meet or Zoom | Kind and optional public label | Automatic meetings follow pending/ready/failure status; the generated join link is sent when ready. Without automatic creation, only the meeting kind is available. |

For agent discovery, REST `GET /api/v1/public/{handle}/{slug}` (or
`GET /api/v1/public/teams/{teamSlug}/{slug}`) returns the safe `locations` list.
MCP `find_available_slots` and CLI `slots` include it in `eventType.locations` alongside
the slots. Ask the invitee which option they want, then query slots again with its
`locationOptionId` and pass the same ID when booking. REST slot responses contain slots;
read their choices from the public event-type endpoint. Do not use a private owner
configuration response as public discovery.

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
settings as configured. Public booking pages omit the choice for a single option in both
slot queries and booking requests, while still collecting a required invitee phone number.
Choosing that option explicitly through an API client uses `location_unavailable`.
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
- “Ask the invitee” collects a phone number for a host-initiated call. It does not let an
  invitee supply an arbitrary address or meeting URL, or offer both phone directions
  on the same event type.
- Automatic Zoom supports only individual events with one authorized host. Collective and
  round-robin Zoom remain unsupported. Meet uses the required collective organizer or the
  actual assigned round-robin host; it never borrows another host’s connection.
- Group mode is not available in event editors or REST/MCP/CLI configuration.
  Internally seeded group types show remaining seats on public booking pages and embeds,
  with full times omitted. Seats use the shared slot’s
  default location and conference; per-invitee location selection and phone collection
  are unavailable for group seats.
