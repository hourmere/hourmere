---
title: Make
description: Connect Hourmere booking webhooks and REST requests to Make with exact module recipes.
---

Use Hourmere's existing REST API and signed webhooks with Make. The
[scenario recipes](https://github.com/hourmere/hourmere/blob/main/tools/make-templates/README.md)
give exact module settings for **New Hourmere booking → Google Sheets row**,
**Booking cancelled → Slack message**, and **Find available slots and create a booking**.
All Hourmere capabilities used here are available to self-hosters, without a billing gate.

## Recipes and blueprint import

These are manual build recipes, **not importable Make blueprints**. We reviewed the official
documentation on 2026-11-06. Make documents exporting/importing JSON containing modules,
settings and mappings, but the pages reviewed do not provide a complete serialization
schema for constructing those modules offline. We have not created a Make account or
tested import or execution against Make. The repository JSON recipe files are validation
manifests; do not select them in **Import blueprint**.

Build each scenario using the linked recipe. If you later export your configured scenario,
Make's documented import procedure is: create a new scenario, open the upper-right
three-dot menu, choose **Import blueprint**, choose the JSON file and save. Configure your
own connections, review mappings, then save the scenario. Imports must be below 2 MB.
Export from the same menu with **Export blueprint**. Inspect exports for private values
before sharing. See [Make's blueprint guide](https://help.make.com/blueprints).

## Prepare Hourmere and credentials

Complete your profile, availability and event type first. Make must be able to reach your
Hourmere HTTPS origin with a trusted certificate; a private localhost deployment is not
directly reachable from Make. For outbound events, enable `WEBHOOKS_ENABLED`, configure
`WEBHOOK_ENCRYPTION_KEY` on every web/worker process and run a worker as described in
[Booking webhooks](/docs/webhooks#enable-and-configure).

Use no Hourmere API key inside Make for any of these templates:

| Purpose | Credential |
| --- | --- |
| Sheets or Slack scenario receiving events | Webhook signing secret in a Make Data store; no Hourmere runtime API key |
| Find slots and create bookings | **No authentication**; these are public endpoints |
| Register, pause or rotate a webhook | **Full account access** (`full`), setup only in a trusted REST client outside Make |
| Inspect webhook delivery metadata | **Read** (`read`), only if needed outside these templates |

No key is the least-privilege choice for public requests. A leaked `bookings` key
could list, cancel and reschedule every booking in its organization, exposing invitee
data; these templates never need it. Supplying it adds no attribution: public bookings
still have source `web` and no API-key ID.

Webhook configuration requires the organization's owner/admin role (or the personal
space owner). Create a temporary **Full account access** key at `/app/api-keys` in the
intended space, keep it in a private local file, use it only from your trusted REST
client, then revoke it after setup. Never paste it into Make. See [API keys](/docs/api-keys).

## Webhook events

Hourmere webhooks deliver the events below. The two event recipes use only
`booking.created` and `booking.cancelled`; there is no Make recipe for the other events.
Every event carries the snapshot fields shown in
[Booking webhooks](/docs/webhooks#payload-and-signatures); the last column lists the
fields an event adds.

| Event | Make recipe | Additional payload fields |
| --- | --- | --- |
| `booking.created` | [Google Sheets row](https://github.com/hourmere/hourmere/blob/main/tools/make-templates/booking-created-sheets.md) | None |
| `booking.cancelled` | [Slack message](https://github.com/hourmere/hourmere/blob/main/tools/make-templates/booking-cancelled-slack.md) | None |
| `booking.rescheduled` | None | None |
| `booking.reschedule_requested` | None | `data.requestId` |
| `booking.reschedule_request_expired` | None | `data.requestId` |
| `booking.attendee_no_show_changed` | None | `data.attendeeId`, `data.noShowMarkedAt`, `data.noShowMarkedBy` |

To build your own scenario for another event, register only that event, reuse the
verification and receipt steps below, and map an added field only in a scenario
registered for its event. For `booking.attendee_no_show_changed`, both marker fields
are null when a mark is removed; the payload has no attendee name or contact details.
See [Marking no-shows](/docs/no-shows).

## Register one webhook per event scenario

Create a separate **Webhooks → Custom webhook** for each scenario. Set **Get request
headers: Yes** and **JSON pass-through: Yes**. Make documents **IP restrictions**, including
CIDR ranges: use your worker's actual stable public egress addresses if known; Hourmere
does not supply a universal source-IP list. Keep the generated webhook URL private.
See [Make's Custom webhook settings](https://apps.make.com/gateway).

From a trusted REST client outside Make, send `POST /api/v1/webhooks` with the full
setup key and `Content-Type: application/json`:

```json
{
  "url": "<YOUR_MAKE_WEBHOOK_URL>",
  "events": ["booking.created"],
  "isActive": false
}
```

Use the private Make URL, or an optional operator-run relay URL. For Slack subscribe
only to `booking.cancelled`. Follow the [file-based curl example](https://github.com/hourmere/hourmere/blob/main/tools/make-templates/README.md#register-the-webhook):
it reads the full key from a private file without putting it in curl arguments and
writes the one-time response to a private file. Creation returns `webhook.id` and
`secret`; put the entire secret in the Make Data store described below. Lists cannot
recover it. After configuring verification and the destination, send
`PATCH /api/v1/webhooks/{id}` with `{ "isActive": true }`. Events while inactive are
not backfilled. Keep the setup response out of logs and exported scenarios, delete
the private response file after storing the secret, and revoke the temporary key.

Hourmere cannot add Make's optional `x-make-apikey` header to outbound deliveries. Do not
enable that requirement for a direct Hourmere-to-Make webhook. A trusted relay can add it
when forwarding verified events. A secret URL and IP restrictions are additional controls,
not signature verification.

## Verify before parsing or acting

Make does have HMAC support: its
[text and binary functions](https://help.make.com/text-and-binary-functions) document
`sha256(text; encoding; key; key encoding)` and state that providing a key computes
HMAC-SHA256. Use lowercase hex output. The message is the `Webhook-Timestamp` header,
a literal period, then the exact original JSON text. The key is the **entire UTF-8 signing
secret, including its prefix**, without base64 decoding. The expected signature is `v1=`
followed by that digest. Do not parse and reserialize the body before hashing.

Use the native verification path in the [shared recipe](https://github.com/hourmere/hourmere/blob/main/tools/make-templates/README.md#verify-before-side-effects).
Before the first run, open **Scenario settings** (gear icon) and enable **Keep data
confidential = Yes**. Create a Data store `Hourmere signing secrets` with a text field
`signingSecret`, store the one-time secret in a record keyed by your endpoint ID, and
use **Data store → Get a record** with that fixed key. Map the returned field into
`sha256(message; "hex"; signingSecret; "text")`, prefixing the result with `v1=`.
The secret stays out of formula literals and blueprint settings. Do not use ordinary
variables as secret storage. See [Make Data stores](https://help.make.com/l6du-data-stores)
and [confidential execution settings](https://help.make.com/scenario-settings).

Enable **Get request HTTP method = Yes** in addition to headers and JSON pass-through.
Route a missing or empty header array to 401 before the Iterator.
Normalize header names with **Iterator** then **Array aggregator**, mapping
`name = lower(name)` and preserving `value`; call that output `normalizedHeaders`.
The timestamp expression is
`get(map(normalizedHeaders; "value"; "name"; "webhook-timestamp"); 1)`;
the signature expression is
`get(map(normalizedHeaders; "value"; "name"; "webhook-signature"); 1)`.
The README gives the delivery/event ID expressions too. Hourmere sends lowercase
header names. These expressions assume a `name`/`value` header array; this shape has
not been verified in a live Make run. Inspect a synthetic delivery and adjust the
mapping to the actual output keys before activation. Preserve values and raw body
unchanged; confirm pass-through byte fidelity. See [Make array functions](https://help.make.com/array-functions).

Reject missing or duplicate required headers, a method other than `POST`, a timestamp
that is not Unix-second digits or is more than **300 seconds** from current UTC time,
and any signature other than `v1=` plus 64 lowercase hex characters matching the
computed signature. Only the valid route may parse JSON and reach Sheets or Slack.
Use explicit terminal responses: rejection 401, success/duplicate/ignored event 200;
a failed destination or receipt write must not return success.

Residual risks remain: Make staff/platform access and team members with scenario or
Data store access can expose the secret or modify the scenario. Confidential mode
keeps processed payloads out of execution logs and limits troubleshooting, but does
not erase old history or protect other retained records. Restrict access and review
existing history and incomplete executions under your retention policy. Incomplete
bundles can retain sensitive inputs and already processed responses; delete them after
reconciliation. Confidential logs do not mean zero platform storage. Make does
not document constant-time comparison or end-to-end byte fidelity. An operator-run
relay with constant-time verification and durable acceptance is an **optional stronger
alternative**, not shipped here; it is not a prerequisite for these native recipes.

Deduplicate successful `Webhook-Id` values durably for at least thirty days. Do not mark an
action complete before its destination succeeds. A crash between a Sheets/Slack action and
recording success can still duplicate that action; these recipes do not promise exactly-once
delivery. Use the event ID or booking ID in the destination so duplicates can be reconciled.
Only after verification, use **JSON → Parse JSON**, mapping the original text into **JSON
string** with the recipe's data structure. See [Make's JSON modules](https://apps.make.com/json).

## Booking requests and failures

Follow the HTTP recipe with **Authentication type = No authentication** for both
public endpoints. Enable **Scenario settings → Keep data confidential = Yes** before
running: with **Parse response = Yes**, Make otherwise retains `manageToken` and invitee
data in execution logs. Confidential mode limits troubleshooting; restrict scenario,
store and incomplete-execution access, and retain durable intent records only as long
as recovery requires. Use a future
UTC range, choose a returned slot unchanged and preserve the same `durationMinutes` for
lookup and booking. Generate and persist one `Idempotency-Key` per logical booking before
the POST. Reuse it and the identical request body for uncertain outcomes and retries.

Do not retry all failures indiscriminately: on **409**, inspect the error code and refetch
slots for a taken slot; an idempotency-key conflict needs reconciliation. Current request validation uses **400**; correct the rejected input before submitting
a new intent. Keep a defensive **422** branch for an upstream validation response, without
claiming Hourmere currently returns 422 for booking validation. On **429**, wait for the
`Retry-After` delay before retrying with the same key and body, with a bounded attempt budget.
Retain failures for operator review instead of treating them as success. Make's
[error-handler documentation](https://help.make.com/error-handlers) describes Retry storing
incomplete executions for automatic/manual retries; it does not establish that arbitrary
HTTP `Retry-After` headers are automatically honored. The recipe describes explicit delay
handling. See also [REST quickstart](/docs/rest).

## Known limitations

- There is no native Hourmere Make app, import-verified blueprint or live Make acceptance.
  Module names/settings may evolve; confirm them against the linked official documentation.
- Webhooks omit invitee names, email addresses, answers and management links. Sheets and
  Slack recipes use only the minimal event snapshot; they cannot map absent contact data.
- The recipes cover only `booking.created` and `booking.cancelled`; other webhook events,
  including attendee no-show changes, have no Make recipe.
- Deliveries may repeat or arrive out of order. Rescheduling emits `booking.rescheduled`,
  not an additional cancellation; the cancellation recipe does not report reschedules.
- Hourmere acknowledges delivery on a 2xx response, not on eventual Sheets/Slack completion.
  Without a Webhook response module, Make can acknowledge before downstream work finishes.
  With one configured, every success and duplicate route needs an explicit 200 response;
  the direct chain must finish within Hourmere's ten-second deadline. An optional operator-run
  durable relay can accommodate slower processing; direct delivery risks timeouts and
  duplicates if it exceeds that deadline. Monitor Make failures
  and Hourmere delivery metadata separately; there is no Hourmere manual replay endpoint.
- Signing-secret rotation has no grace period or dual signing. Coordinate verifier updates
  with the [webhook rotation procedure](/docs/webhooks#delivery-and-operational-limits).
- Make, Sheets and Slack have their own account, connection and service limits. This offline
  recipe release creates no accounts, credentials or provider connections.

## Validated field references

These field paths are checked against Hourmere's API and webhook contracts.

```hourmere-fields
{
  "requests": [
    {
      "method": "POST",
      "path": "/api/v1/webhooks",
      "body": [
        "url",
        "events",
        "isActive"
      ],
      "response": {
        "201": [
          "webhook.id",
          "secret"
        ]
      }
    },
    {
      "method": "PATCH",
      "path": "/api/v1/webhooks/{id}",
      "body": [
        "isActive"
      ]
    }
  ],
  "webhookEvents": [
    "booking.created",
    "booking.cancelled"
  ],
  "webhookPayloadFields": [
    "id",
    "type",
    "occurredAt",
    "data.bookingId",
    "data.organizationId",
    "data.eventTypeId",
    "data.start",
    "data.end",
    "data.status",
    "data.source",
    "data.rescheduledFromId"
  ]
}
```
