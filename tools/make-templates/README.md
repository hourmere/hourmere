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

Send `POST /api/v1/webhooks`, authenticated by that client, with JSON:

```json
{
  "url": "{{MAKE_WEBHOOK_URL}}",
  "events": ["booking.created"],
  "isActive": false
}
```

For the Slack recipe set `events` to `["booking.cancelled"]`. Replace the URL
placeholder with your receiver's HTTPS URL, or your verification relay URL if
using one. Store the response's `secret` immediately in the receiver's secret
store: it is shown once, never recoverable from list responses. No literal signing
secret belongs in a recipe, exported blueprint or ordinary module field.
After configuring verification and the destination, activate it with authenticated
`PATCH /api/v1/webhooks/{id}` and body `{ "isActive": true }`. Events occurring while
inactive are not backfilled. Use the returned webhook ID for `{id}`.

## Verify before side effects

Make **does** support HMAC: its documented
[`sha256(text; encoding; key; key encoding)`](https://help.make.com/text-and-binary-functions#sha256)
returns HMAC when given a key. Configure **Webhooks > Custom webhook** with
**Get request headers = Yes**, **JSON pass-through = Yes**, and
**Get request HTTP method = Yes**. Keep the generated URL private. **IP restrictions**
can allow your known outbound IPs/CIDRs; they are available, but do not replace a
signature. Hourmere cannot add the optional `x-make-apikey` authentication header.
These controls are documented in [Make Webhooks](https://apps.make.com/gateway).

For a native Make verification step, use **Tools > Set variable** named
`expectedSignature`. In the value mapper enter literal `v1=` followed by
`sha256(message; "hex"; signingSecret; "text")`. Here `message` is the mapped
`Webhook-Timestamp`, a literal dot, then the untouched pass-through JSON text;
`signingSecret` is a securely supplied signing-secret value, including its prefix.
These names describe mapper inputs, not Make global variables or pasted literals.
Do not parse/re-encode, trim, or normalize the body before hashing.

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

This documents use of Make's HMAC function, not a verified production security
boundary. The reviewed docs do not establish constant-time comparison, a secret
keychain binding for that formula, or an end-to-end guarantee of exact raw bytes.
Do not paste the secret into Set variable to work around that missing binding.
For production, use an operator-managed verification relay which receives the
original bytes, checks HMAC in constant time and freshness, and durably queues
verified deliveries before acknowledging Hourmere. It can forward to a restricted
Make webhook using Make's API-key authentication. That relay is an operator
prerequisite, not an endpoint or implementation shipped by this task. If no secure
secret binding or relay is available, leave the scenario disabled. A private URL
alone is not signature verification.

After verification, parse the original text with **JSON > Parse JSON**. Define an
object with text fields `id`, `type`, `occurredAt`, and a `data` collection containing
`bookingId`, `organizationId`, nullable `eventTypeId`, `start`, `end`, `status`,
`source`, and nullable `rescheduledFromId`. The
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
must complete within Hourmere's ten-second deadline. If that cannot be guaranteed,
the durable verification relay is required: it acknowledges Hourmere after durable
acceptance and separately manages forwarding/recovery with Make. Make's response
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
