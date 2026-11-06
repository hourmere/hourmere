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

In your Hourmere instance, select the intended space and open **API keys** at
`/app/api-keys`. Name the key for its purpose and select the smallest available scope:

| Purpose | Scope |
| --- | --- |
| Sheets or Slack scenario receiving events | No Hourmere runtime API key needed |
| Find slots and create bookings | **Bookings** (`bookings`) |
| Register, pause or rotate a webhook | **Full account access** (`full`), setup only |
| Inspect webhook delivery metadata | **Read** (`read`), only if needed |

Webhook configuration also requires the organization's owner/admin role (or the owner of
the personal space). An API key remains tied to its organization and creator's permissions.
Copy the new key once into Make's HTTP v4 **Credentials** keychain, using **Authentication
type: API key**. Configure its header name as `Authorization` and its value as `Bearer `
followed by the key. Never place it in ordinary module headers, URLs, variables or recipe
files. Keep setup credentials separate and revoke a temporary setup key after registration.
See [API keys](/docs/api-keys) and Make's
[HTTP credentials settings](https://apps.make.com/http).

## Register one webhook per event scenario

Create a separate **Webhooks → Custom webhook** for each scenario. Set **Get request
headers: Yes** and **JSON pass-through: Yes**. Make documents **IP restrictions**, including
CIDR ranges: use your worker's actual stable public egress addresses if known; Hourmere
does not supply a universal source-IP list. Keep the generated webhook URL private.
See [Make's Custom webhook settings](https://apps.make.com/gateway).

From a trusted REST client, send `POST /api/v1/webhooks`, authenticated with the setup key,
with `Content-Type: application/json` and this body (replace the placeholder URL):

```json
{
  "url": "https://receiver.example.com/replace-with-private-receiver-path",
  "events": ["booking.created"],
  "isActive": false
}
```

Use your verification relay URL, or the private Make webhook URL if using the direct
verification option below. For Slack, register a separate endpoint subscribing only to
`booking.cancelled`. Creation returns `{ "webhook": { "id": "…" }, "secret": "…" }`.
The signing secret is shown once: put it directly in the verifier's private secret store;
listing webhooks cannot recover it. After configuring verification and the destination,
send `PATCH /api/v1/webhooks/{id}` with `{ "isActive": true }`. Events while inactive are
not backfilled. Keep the setup response out of logs and exported scenarios.

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

For direct Make verification, map the pass-through text and request headers into that
calculation, reject missing/malformed headers and timestamps outside a short window
(for example five minutes), and require the signature match before continuing. The reviewed
Make documentation does not establish constant-time comparison or a secret-keychain binding
for this formula. A formula containing a literal signing secret can expose it in scenario
settings or exports. We therefore recommend a verifier you control that stores the secret,
compares digests in constant time, validates freshness and forwards only authenticated
events to Make. This task does not ship that relay. An HTTP verification step inside Make
is another option if it forwards the exact raw body and headers to your verifier and stops
on any failed verification; unverified input still reaches Make in that arrangement.

Deduplicate successful `Webhook-Id` values durably for at least thirty days. Do not mark an
action complete before its destination succeeds. A crash between a Sheets/Slack action and
recording success can still duplicate that action; these recipes do not promise exactly-once
delivery. Use the event ID or booking ID in the destination so duplicates can be reconciled.
Only after verification, use **JSON → Parse JSON**, mapping the original text into **JSON
string** with the recipe's data structure. See [Make's JSON modules](https://apps.make.com/json).

## Booking requests and failures

Follow the HTTP recipe for the existing public slots and booking endpoints. Use a future
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
- Deliveries may repeat or arrive out of order. Rescheduling emits `booking.rescheduled`,
  not an additional cancellation; the cancellation recipe does not report reschedules.
- Hourmere acknowledges delivery on a 2xx response, not on eventual Sheets/Slack completion.
  Without a Webhook response module, Make can acknowledge before downstream work finishes.
  With one configured, every success and duplicate route needs an explicit 200 response;
  the direct chain must finish within Hourmere's ten-second deadline. Use a durable relay
  for slower processing. Monitor Make failures
  and Hourmere delivery metadata separately; there is no Hourmere manual replay endpoint.
- Signing-secret rotation has no grace period or dual signing. Coordinate verifier updates
  with the [webhook rotation procedure](/docs/webhooks#delivery-and-operational-limits).
- Make, Sheets and Slack have their own account, connection and service limits. This offline
  recipe release creates no accounts, credentials or provider connections.
