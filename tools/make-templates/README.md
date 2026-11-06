# Make scenario recipes

These are **manual build recipes, not importable Make blueprints**. The official
[blueprints guide](https://help.make.com/blueprints) documents JSON export/import,
connections and the 2 MB import limit, but does not provide the complete versioned
module/settings schema needed to generate these scenarios offline. We have not
created a Make account, called its APIs or tested an import. The `.recipe.json`
files are Hourmere validation manifests; do not import them into Make.

Build a new scenario using one of these exact settings guides:

- [New Hourmere booking → Google Sheets row](booking-created-sheets.md).
- [Booking cancelled → Slack message](booking-cancelled-slack.md).
- [Find available slots and create a booking](find-slots-create-booking.md).

After building and checking your own scenario, Make's scenario menu offers
**Export blueprint**. To reuse that actual export, create a new scenario, choose
**Import blueprint**, choose the JSON file and save, then configure your own
connections and scheduling. Review exports for private URLs, credentials and
sample personal data before sharing. No exported scenario is supplied here.

## Register the webhook

The two event recipes need no Hourmere API key during normal execution. An owner
or admin registers each endpoint once using a `full` key tied to the correct
organization. `read` and `bookings` cannot register webhooks. Create a temporary
key at `/app/api-keys`, select **Full account access**, and store its one-time value
in your REST client's secret store; revoke it after setup if no longer needed.
Use the [webhook guide](../../apps/site/src/content/docs/docs/webhooks.md) to enable
webhooks on the instance and run a worker. Self-hosting has the same capability.

Register from a trusted local shell outside Make. Save the temporary full key in a
private file (one line, mode 600); never paste it into Make or command history.
Create a private `webhook-registration.json` file with this body, replacing the
explicit placeholder with your private Make receiver URL:

```json
{
  "url": "<YOUR_MAKE_WEBHOOK_URL>",
  "events": ["booking.created"],
  "isActive": false
}
```

For Slack use `["booking.cancelled"]`. The following Bash example reads the key
from a file and sends `POST /api/v1/webhooks`; neither the key nor the one-time
response appears in terminal output or curl arguments. Do not enable shell tracing
or curl verbose output. Replace the example origin and private file paths locally.

```bash
umask 077
HOURMERE_KEY_FILE='<YOUR_PRIVATE_API_KEY_FILE>'
HOURMERE_SETUP_RESPONSE='<YOUR_PRIVATE_SETUP_RESPONSE_FILE>'
curl --fail-with-body --silent --show-error \
  --request POST 'https://hourmere.example.com/api/v1/webhooks' \
  --header @<(printf 'Authorization: Bearer '; cat "$HOURMERE_KEY_FILE") \
  --header 'Content-Type: application/json' \
  --data-binary @webhook-registration.json \
  --output "$HOURMERE_SETUP_RESPONSE"
```

Read the saved response privately: `webhook.id` identifies the endpoint and `secret`
is shown once, never recoverable from list responses. Put the **entire secret** in
the Make Data store record described below. No literal signing secret belongs in a
recipe, exported blueprint or formula. Keep the response file private and delete it
once the secret is safely stored. After verification and destination setup, activate
using the same external client with `PATCH /api/v1/webhooks/{id}` and body
`{ "isActive": true }` (replace `{id}` with `webhook.id`):

```bash
curl --fail-with-body --silent --show-error \
  --request PATCH 'https://hourmere.example.com/api/v1/webhooks/{id}' \
  --header @<(printf 'Authorization: Bearer '; cat "$HOURMERE_KEY_FILE") \
  --header 'Content-Type: application/json' \
  --data '{"isActive":true}' \
  --output /dev/null
```

Events while inactive are not backfilled. Revoke the temporary setup key after setup.
No Hourmere API key is stored in Make: the public HTTP recipe also needs none.

## Verify before side effects

Make **does** support HMAC: its documented
[`sha256(text; encoding; key; key encoding)`](https://help.make.com/text-and-binary-functions#sha256)
returns HMAC when given a key. Configure **Webhooks > Custom webhook** with
**Get request headers = Yes**, **JSON pass-through = Yes**, and
**Get request HTTP method = Yes**. Keep the generated URL private. **IP restrictions**
can allow your known outbound IPs/CIDRs; they are available, but do not replace a
signature. Hourmere cannot add the optional `x-make-apikey` authentication header.
These controls are documented in [Make Webhooks](https://apps.make.com/gateway).

Use native Make verification for these recipes. In **Scenario settings** (gear
icon), enable **Keep data confidential = Yes** before the first run. Create a
separate Data store named `Hourmere signing secrets` with a text field
`signingSecret`; add a record keyed by your endpoint ID and privately paste its
one-time secret into that record. Add **Data store > Get a record** after the
webhook module, selecting that fixed record key (never a key supplied by the
incoming request). Map its `signingSecret` output into the HMAC formula. Data store
records are separate from blueprint settings; do not put the secret in Set variable,
custom variables or literal formula text. See [Data stores](https://help.make.com/l6du-data-stores)
and [Keep data confidential](https://help.make.com/scenario-settings).

Before the Iterator, route a missing or empty header array directly to the 401
response; an Iterator with no items cannot reach the later rejection route.
Normalize request header **names only** to lowercase before lookup. For an array
of `{name, value}` records, add **Iterator** over the headers, then **Array
aggregator** with fields `name = lower(name)` and `value = value`, preserving every
value unchanged. Name the aggregated array `normalizedHeaders` in the expressions
below (replace that label with the mapped array output). Reject duplicate required
header names: each filtered array must have length exactly 1. Hourmere sends
lowercase names, but this normalization also handles intermediaries changing case.

| Input | Case-insensitive lookup after name normalization |
| --- | --- |
| Timestamp | `get(map(normalizedHeaders; "value"; "name"; "webhook-timestamp"); 1)` |
| Signature | `get(map(normalizedHeaders; "value"; "name"; "webhook-signature"); 1)` |
| Delivery ID | `get(map(normalizedHeaders; "value"; "name"; "webhook-id"); 1)` |
| Event ID | `get(map(normalizedHeaders; "value"; "name"; "webhook-event-id"); 1)` |

These expressions use Make's documented [array functions](https://help.make.com/array-functions),
but the webhook header output shape and expressions have not been live-tested.
Inspect a synthetic first delivery to confirm the actual `name`/`value` keys and
pass-through byte fidelity before activating real deliveries; adapt the iterator
mapping if its output uses different keys. Preserve the original body and method
outputs across aggregation. Do not lowercase the JSON body or header values.

Use **Tools > Set variable** named `expectedSignature`. In the value mapper enter
literal `v1=` followed by `sha256(message; "hex"; signingSecret; "text")`.
Here `message` is the extracted timestamp, a literal dot, then the untouched
pass-through JSON text; `signingSecret` is the mapped Data store field, including
its prefix, as UTF-8 text without base64 decoding. Do not parse/re-encode, trim,
or normalize the body before hashing.

Add a router before JSON parsing. Its valid route has a filter: request method equals `POST`; timestamp consists
only of Unix-second digits and lies within 300 seconds of current UTC time;
signature matches `v1=` plus 64 lowercase hex characters and equals the computed
value; both delivery and event ID headers are present. Missing inputs must reject.
Make the router's fallback rejection route end in **Webhooks > Webhook response**,
**Status = 401**, **Body = Rejected**. Never route rejection to Sheets or Slack.
Configure response modules on the other terminal routes too: a successfully
recorded delivery ends with **Status = 200**, **Body = Accepted**; an already
completed delivery ends with **Status = 200**, **Body = Already processed**.
Verified events excluded by the event/organization filter also need a terminal
**Status = 200**, **Body = Ignored** route. Do not leave a filtered branch waiting
without a response. A failed side effect or receipt write must not return success.

The Data store plus **Keep data confidential** is the native path used here,
not a claim that Make cannot access the secret. Make staff/platform access and team
members with scenario or Data store access remain risks; they can access processed
data or modify the scenario. Restrict those permissions. Confidential mode prevents
processed payloads being retained in execution logs, but cannot erase earlier
history or protect other stored records. It also limits troubleshooting. Review
existing history and incomplete executions separately, restrict their visibility,
and remove sensitive retained data under your retention policy.

Make does not document constant-time comparison or guaranteed end-to-end raw-byte
preservation. Verify byte fidelity with synthetic deliveries. An operator-run relay
that checks the original bytes, constant-time HMAC and freshness and durably queues
verified events is an optional stronger alternative; no relay is shipped here.
A relay can forward to a restricted Make webhook with Make API-key authentication.
A private URL alone is not signature verification.

After verification, parse the original text with **JSON > Parse JSON**. Define an
object with text fields `payload:id`, `payload:type`, `payload:occurredAt`, and a
`data` collection containing `payload:data.bookingId`, `payload:data.organizationId`,
nullable `payload:data.eventTypeId`, `payload:data.start`, `payload:data.end`,
`payload:data.status`, `payload:data.source`, and nullable `payload:data.rescheduledFromId`.
The `payload:` labels identify validated references; enter only the underlying field
names in Make, with `data.` paths nested inside the `data` collection. The
[JSON guide](https://apps.make.com/json) explains the data structure and JSON string
fields. Filter the parsed event type and expected organization before acting.

Deduplicate successful deliveries by `Webhook-Id` for at least 30 days. Keep that
ID in the output so an uncertain write can be reconciled before repeating it.
Hourmere retries delivery and ordering is not guaranteed. A side effect followed
by a failed receipt write can duplicate a row/message; these recipes do not promise
exactly-once delivery. Use sequential processing for one scenario plus a durable
receipt store, and coordinate any additional consumers separately.

For the two event recipes, create a Make data store named `Hourmere delivery
receipts`, with text fields `outputId` and `completedAt`. Add **Data store > Check
the Existence of a Record** after verification: **Data store** = this store,
**Key** = original `Webhook-Id`. Continue to Sheets/Slack only when the result is
false. After the side effect, add **Data store > Add/Replace a Record**, same store
and key, **Overwrite an existing record = No**, `outputId` = returned row/message
identifier, `completedAt` = current UTC timestamp. A receipt-write error must stop
for reconciliation, not replay the side effect. Retain records at least 30 days;
manually remove only older completed receipts after checking pending recoveries.
See [Make data stores](https://help.make.com/l6du-data-stores) for these modules
and account storage allowances. This store is not a transaction with Sheets/Slack.

Make's default early acknowledgement applies only when the scenario has no
Webhook response module. Adding even a rejection-only response module changes
that behavior for the scenario; it does not preserve early success acknowledgement
on other branches. Use all the explicit terminal responses above. For direct
Hourmere delivery, verification, the side effect, the receipt write and the response
must complete within Hourmere's ten-second deadline. For slower work, an optional
operator-run durable relay can acknowledge Hourmere after durable acceptance and
separately manage forwarding/recovery with Make; direct delivery otherwise risks
timeouts and duplicate attempts. Make's response
waiting period does not extend Hourmere's deadline. In a scenario without response
modules, later failures can already be acknowledged; retain incomplete executions
and monitor Make. A response module alone is not a durable queue. Webhooks contain no
invitee names, email addresses, answers or management links. Rescheduling emits
its own event, not a second cancellation.

## Make documentation reviewed

Reviewed on 2026-11-06; module settings below are recipe choices, not claims of
live validation:

- [Scenario blueprints](https://help.make.com/blueprints): exported JSON and importing.
- [Webhooks](https://apps.make.com/gateway): custom webhook, headers, pass-through,
  IP restrictions, optional API-key authentication and responses.
- [Text and binary functions](https://help.make.com/text-and-binary-functions#sha256): keyed SHA-256.
- [HTTP](https://apps.make.com/http): v4 request settings and credentials.
- [API key authentication](https://apps.make.com/api-key-authentication-type): keychain and allowed origins.
- [JSON](https://apps.make.com/json): parsing into mapped fields.
- [Error handlers](https://help.make.com/error-handlers) and
  [Retry](https://help.make.com/retry-error-handler): incomplete executions and retry settings.
- [Google Sheets](https://apps.make.com/google-sheets) and
  [Slack](https://apps.make.com/slack): account connections.

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
