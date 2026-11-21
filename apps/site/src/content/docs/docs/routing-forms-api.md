---
title: Routing forms for agents and integrations
description: Publish routing forms, submit answers, and hand off or book an offered time through REST, MCP and the CLI.
---

Routing forms are off by default. On self-hosted Hourmere, set
`ROUTING_FORMS_ENABLED=true` and restart the server to enable them. Hourmere operates
the setting on Cloud. See [Routing forms](/docs/routing-forms#availability-and-the-operator-setting)
for deployment steps and handle collision recovery.
Use the examples below once `GET /api/v1/instance` reports `routingFormsEnabled: true`.

## Availability and credentials

The generated API key scope tables list the routing operations. The instance's OpenAPI
document at `/api/v1/openapi.json` also lists the REST operations and describes their disabled
responses. These references describe the API contract even when `routingFormsEnabled` is `false`.
After transport checks, a routing REST operation returns `404 routing_forms_disabled` while off.
MCP `tools/list` omits all eleven dedicated routing tools while off. A direct `tools/call`
to one of them returns a tool error with `routing_forms_disabled`. The CLI reports the same code
on stderr and exits with status 1. When routing is on, tool discovery still applies the key's scope.

The shared `create_booking`, `get_booking` and `export_bookings` tools stay listed for eligible
credentials. While routing is off, new requests with `routeToken` and exports with
`includeRoutingAnswers: true` return `routing_forms_disabled`. Exact authorized replays of
committed routed bookings still work. Authorized booking reads still return saved snapshots.

Use the instance origin for all requests. Supply an API key as `Authorization: Bearer <key>`
for REST or MCP, or connect to MCP using an authorized OAuth grant. For the CLI, set
`HOURMERE_URL` and `HOURMERE_API_KEY`. Send JSON with `--input FILE` or `--input -` for stdin.
Keep answers and capabilities in private JSON input and out of command arguments, shell history,
and diagnostic logs. See the [REST](/docs/rest), [MCP](/docs/mcp), and [CLI](/docs/cli) guides.

## Configure and publish a form

Use the personal owner or a current team owner or admin credential for the form's organization.
For API keys, list and get accept `read` or `full`. Create, update, publish, preview and archive
require `full`. REST session writes require `X-Expected-Organization-Id` and a same-origin
`Origin` or `Referer`. Session preview also requires the same-origin check and can use
`X-Expected-Organization-Id` to pin the workspace.

| REST method and path | MCP tool | CLI command |
| --- | --- | --- |
| `GET /api/v1/routing-forms` | `list_routing_forms` | `hourmere routing-forms list` |
| `GET /api/v1/routing-forms/{id}` | `get_routing_form` | `hourmere routing-forms get` |
| `POST /api/v1/routing-forms` | `create_routing_form` | `hourmere routing-forms create` |
| `PATCH /api/v1/routing-forms/{id}` | `update_routing_form` | `hourmere routing-forms update` |
| `POST /api/v1/routing-forms/{id}/preview` | `preview_routing_form` | `hourmere routing-forms preview` |
| `POST /api/v1/routing-forms/{id}/publish` | `publish_routing_form` | `hourmere routing-forms publish` |
| `DELETE /api/v1/routing-forms/{id}` | `archive_routing_form` | `hourmere routing-forms archive` |

List takes `{"limit":20}` in MCP and the CLI, or `?limit=20` in REST. Pass `nextCursor` as
`cursor` for the next page. Get takes `{"id":"<form UUID>"}` in MCP and the CLI, or the ID
in the REST path. Get returns the saved draft, its `draftRevision`, and any published target health.

Use this JSON for create on all three interfaces. Generate a fresh UUID for `requestId` and for
each question. Use each question UUID in its mapping, preview and submission. Replace
`eventTypeId` with an eligible event type ID from the same workspace.
This example sends every submission to the fallback event and maps a routing question to a
booking field. Save it to `create.json` for the CLI.

```json
{
  "slug": "consultation",
  "title": "Request a consultation",
  "requestId": "9e45702c-da7a-47fb-9e86-3fba15cd39fd",
  "questions": [
    {
      "id": "7db8c949-7e6d-44cf-a50f-126496fc8e53",
      "type": "email",
      "label": "Email address",
      "required": true
    }
  ],
  "fallback": {
    "kind": "event",
    "eventTypeId": "<event type UUID>",
    "mappings": [
      {
        "questionId": "7db8c949-7e6d-44cf-a50f-126496fc8e53",
        "destination": { "kind": "inviteeEmail" }
      }
    ]
  }
}
```

```sh
hourmere routing-forms create --input create.json
```

Creation returns a disabled, unpublished draft. For the operations below, replace the sample
`expectedRevision` with the latest `draftRevision` from the form. In REST, put `id` in the
URL and omit it from the JSON body. In MCP and the CLI, include it in the JSON.

Edit the draft with `update_routing_form` or `hourmere routing-forms update`.

```json
{
  "id": "<form UUID>",
  "expectedRevision": 1,
  "title": "Book a consultation"
}
```

Preview the saved draft with `preview_routing_form` or `hourmere routing-forms preview`.

```json
{
  "id": "<form UUID>",
  "answers": {
    "7db8c949-7e6d-44cf-a50f-126496fc8e53": "alex@example.com"
  }
}
```

Publish with `publish_routing_form` or `hourmere routing-forms publish`.

```json
{
  "id": "<form UUID>",
  "expectedRevision": 2,
  "requestId": "5c0ac678-4a09-4ef0-a611-e3ff3567941f"
}
```

Enable through update with `{"id":"<form UUID>","expectedRevision":3,"enabled":true}`.
When you no longer need the form, archive it with `archive_routing_form` or
`hourmere routing-forms archive` and `{"id":"<form UUID>","expectedRevision":4}`.

An update replaces any draft arrays you send. Preview returns the matched rule, resolved target
and any target failures. It stores no answers and issues no capability. Publish rechecks targets
and mappings, then returns `{ form, version }`. The `version` is immutable. After publishing,
use the `draftRevision` in `form` when enabling. Archive disables the form and preserves its
slug and history. Confirm the intended form before archiving.

Use a separate random `requestId` for each create and publish operation. For retries, keep the same
credential, request ID and input. A publish retry returns the original version and the current form.
After `routing_revision_conflict`, get the form again and review the changes before continuing.

## Read a published form and submit answers

| REST method and path | MCP tool | CLI command |
| --- | --- | --- |
| `GET /api/v1/public/-/routing/{handle}/{slug}` or `GET /api/v1/public/-/routing/teams/{teamSlug}/{slug}` | `get_public_routing_form` | `hourmere routing-forms public` |
| `POST /api/v1/public/-/routing/{handle}/{slug}/route` or `POST /api/v1/public/-/routing/teams/{teamSlug}/{slug}/route` | `route_lead` | `hourmere routing-forms route` |

Public REST accepts anonymous requests. When supplying a bearer key, use `read`, `bookings`
or `full` for metadata, and `bookings` or `full` for submission. MCP and the CLI require
authentication with the same key scopes. Authorized MCP OAuth also works.

In MCP and the CLI, pass `{"handle":"ada","slug":"consultation"}` to read a personal form.
For a team form, pass `{"teamSlug":"advisory-team","slug":"consultation"}`. Ask the invitee
for the published questions returned by metadata. Only submit answers they provide.
Use the returned `versionId`. Key answers by question UUID and use option UUIDs for select
answers. Omit an unanswered optional question or send `null`. Here is `submit.json` for
`route_lead` or the CLI. For REST, put the address in the URL and send only `versionId` and `answers`.

```json
{
  "handle": "ada",
  "slug": "consultation",
  "versionId": "<published version UUID>",
  "answers": { "7db8c949-7e6d-44cf-a50f-126496fc8e53": "alex@example.com" }
}
```

```sh
hourmere routing-forms route --input submit.json --output outcome.json
```

If the server returns `routing_form_changed`, fetch metadata again and review the answers with the
invitee before resubmitting. A successful submission returns one of two outcomes.

- `kind: "message"` gives plain text to show the invitee.
- `kind: "continuation"` gives a `routeToken`, `continuationUrl`, and `expiresAt`.
  CLI stdout redacts the token and URL. `--output` saves the full result in a new private
  file with mode `0600`.

The selected event may be hidden. The public form and continuation omit reusable booking
addresses, rules, and host pools. Ordinary direct addresses follow their own booking rules.
Submission alone creates no booking and sends no notification.

## Hand off to the invitee or complete a booking

For a handoff, share the server's `continuationUrl` unchanged in a private conversation with the
invitee. Include the absolute `expiresAt` and let the invitee choose and book on that page.
Anyone with the link can use it until expiry or consumption. The token expires 30 minutes after
issuance. Opening the link, resolving details, and reading slots leave the token usable until its
original expiry. Only a committed booking consumes it. If it expires, ask the invitee to open
the original form again.

To book for the invitee, send the token in the JSON body. Keep it out of query strings and logs.
REST accepts these calls anonymously or with a `bookings` or `full` key. MCP and the CLI use
`bookings` or `full` keys, and MCP also accepts authorized OAuth.

| REST method and path | MCP tool | CLI command |
| --- | --- | --- |
| `POST /api/v1/routing-continuations/resolve` | `resolve_routing_continuation` | `hourmere routing-forms resolve` |
| `POST /api/v1/routing-continuations/slots` | `find_routed_slots` | `hourmere routing-forms slots` |
| `POST /api/v1/routing-continuations/bookings` | `create_booking` | `hourmere book` |

Resolve takes `{"routeToken":"<private route token>"}`. Read the current event details and
editable `prefill`. For slots, add a range of RFC 3339 timestamps. The example uses the event's
defaults. To choose a different length or location, use `durationMinutes` or `locationOptionId`
from the current event details and pass the same choices when booking. The returned `slots` are
available times, with no reservation.

```json
{
  "routeToken": "<private route token>",
  "start": "2027-06-01T09:00:00Z",
  "end": "2027-06-02T09:00:00Z"
}
```

Get the invitee's approval for the slot and confirm the booking details with them. Use the exact
slot `start` returned. Include any required booking-question answers in `responses`. Use
`routeToken` as the only event selector. Omit `handle`, `teamSlug`, `slug`, `oneTimeToken`, and
`waitlistToken`. The following is `booking.json` for MCP or the CLI. For REST, send
`idempotencyKey` as the `Idempotency-Key` header and omit it from the body.

```json
{
  "routeToken": "<private route token>",
  "start": "2027-06-01T15:30:00Z",
  "invitee": {
    "name": "Alex Morgan",
    "email": "alex@example.com",
    "timeZone": "America/New_York"
  },
  "idempotencyKey": "7b7df042-9c8d-45bd-8e1c-a24d080d943d"
}
```

```sh
hourmere book --input booking.json --output booked.json
```

Generate a random idempotency key per booking. After a lost response, retry with the same
booking input, route token, idempotency key and credential. An exact replay returns the
original booking with `manageToken: null`, even after expiry or disablement. A failed booking
leaves the token usable until its original expiry, subject to current form and target availability.
For `routing_unavailable` on a new booking attempt, ask the invitee to restart from the form.
A routed booking ends at the normal confirmation without an after-booking redirect.

## Read or export saved answers

A booked host in the acting organization can use `GET /api/v1/bookings/{id}`, MCP `get_booking`,
or `hourmere booking --input booking-id.json` with `{"bookingId":"<booking UUID>"}`. Saved
routing provenance and original answers appear in `routing` on applicable bookings. The invitee
can read their own answer snapshot with `GET /api/v1/bookings/manage` and `X-Manage-Token`.
Those authorized reads continue to work when routing is off. Form management alone grants no
access to bookings or to unbooked submissions.

To export saved routing answers, use a personal owner credential and opt in. REST accepts
`includeRoutingAnswers=true` on `GET /api/v1/bookings/export.csv`. Supply `from` and `to`
as query parameters. MCP `export_bookings` takes the JSON below and returns an authenticated
download path. Download from the same instance with an authorized `read` or `full` API key.
The CLI uses the same JSON or accepts `--include-routing-answers true`.

```json
{
  "from": "2027-06-01T00:00:00Z",
  "to": "2027-07-01T00:00:00Z",
  "includeRoutingAnswers": true
}
```

```sh
hourmere export --input export.json --output bookings.csv
```

Keep downloaded files private. The opt-in covers saved booking snapshots only. Leave it unset
or set it to `false` for a standard export. Team exports reject the opt-in. See [Booking export](/docs/booking-export).
