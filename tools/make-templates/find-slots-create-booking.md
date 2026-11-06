# Find available slots and create a booking

Manual recipe for a personal booking page. The sibling `.recipe.json` is an offline
validation manifest, not a Make blueprint. Use a currently enabled event type with
no required custom questions for the minimal body below; otherwise include its
required `responses` using the existing public event-type contract.

## Credentials and input

Create a key at `/app/api-keys` with **Bookings** scope. It can also manage existing
authorized bookings, so use an appropriate account. Save its one-time value directly
in **HTTP v4 > Make a request > Authentication type = API key > Credentials > Add**:

| Keychain field | Setting |
| --- | --- |
| Name | `Hourmere bookings` |
| Key | `Bearer ` followed by the newly created key, entered only in this credential dialog |
| API key placement | In the header |
| API key parameter name | `Authorization` |
| Restrict requests to service URLs | On |
| Allowed service origins | Your exact Hourmere HTTPS origin |

Do not put authorization in module Headers, query parameters, JSON bodies, variables
or exported files. Make documents these fields in its
[API-key keychain guide](https://apps.make.com/api-key-authentication-type).

Prepare one durable booking-intent record containing: personal `handle`, `slug`,
range `start` and `end` (ISO instants with offsets), invitee name/email/IANA time zone,
optional allowed `durationMinutes`, and a random UUIDv4 `idempotencyKey`. Generate
the key once and persist it before any POST. Do not generate it inside a retried
HTTP module, derive it from personal data, or regenerate after a timeout. Keep the
selected start and complete request body with this record. Process one intent at a
time; manual scheduling is sufficient for this recipe.

## Request settings

Use **HTTP v4 > Make a request** for both modules. Choose the `Hourmere bookings`
Credentials, **Parse response = Yes**, **Return error if HTTP request fails = No**,
**Allow redirects = No**, **Share cookies with other HTTP modules = No**, and
**Timeout = 30** seconds. Leave pagination unset. Returning status responses as data
lets the router inspect both status and `Retry-After`; transport failures still
need the error handler below. These are choices using the
[documented HTTP fields](https://apps.make.com/http).

1. **Availability module**: Method `GET`; URL
   `{{HOURMERE_BASE_URL}}/api/v1/public/{handle}/{slug}/slots`, substituting the
   encoded personal handle and slug. Query parameters `start` and `end` map to
   the input range; optional `durationMinutes` maps to the selected duration.
   Headers and body are empty. A 200 response has a `data` array of slots.
   Add a filter for status 200 and a nonempty `data` array; stop with “No slots
   available” on an empty array. For this recipe select the first slot, persist
   its `start`, and submit that exact instant. Do not reconstruct local wall time
   (especially across DST). A slot is an offer, not a reservation.
2. **Create module**: Method `POST`; URL
   `{{HOURMERE_BASE_URL}}/api/v1/public/{handle}/{slug}/bookings`. Add the sole custom
   header `Idempotency-Key` mapped from the persisted record. Set **Body content
   type = application/JSON**, **Body input method = Data structure**. Define:

   | Field | Type | Mapping |
   | --- | --- | --- |
   | `start` | Text | Persisted selected slot start |
   | `durationMinutes` | Number, optional | Same duration as availability; omit if not selected |
   | `invitee` | Collection | Nested fields below |
   | `invitee.name` | Text | Input invitee name |
   | `invitee.email` | Text | Input invitee email |
   | `invitee.timeZone` | Text | Input IANA time zone |

   Use the data structure so mapped strings are JSON-escaped. Do not send `end`
   or an invented `source` value. Success is 201; a matching idempotent replay is
   200. Save the booking ID. The original creation's management token is sensitive
   and not recoverable by replay; keep it out of logs and downstream messages.

## Status routes and recovery

After **each** HTTP module add a router with mutually exclusive numeric status
filters. Only the availability 200/nonempty route can reach creation, and only
creation 200/201 can mark the intent successful. Add a fallback that stores a
sanitized failure for review and stops without booking or retrying.

| Status | Exact route behavior |
| --- | --- |
| 409 | Store the response `error`; stop. For `slot_taken`, `slot_unavailable` or `booking_changed`, obtain fresh availability and explicit selection before creating a new intent/key. For `idempotency_key_reused`, fix the reused-key/input mismatch; never retry blindly. |
| 400 or 422 | Mark intent `needs-correction`; record `error` and optional `field`, then stop. Correct input deliberately before creating a new intent. Current Hourmere booking validation uses 400; 422 is a defensive route, not a claimed documented response. |
| 429 | Read the case-insensitive `Retry-After` response header. Hourmere returns delay seconds. Persist `nextAttemptAt = response receipt time + delay`, the unchanged request body, and the same key. Stop this execution. |
| 401 or 403 | Stop for credential/scope review; do not fall back to anonymous requests. |
| Other status, including 5xx | Store an uncertain outcome for review; no automatic fresh-key retry. |

For the 429 route, accept only a nonnegative integer delay. For a missing or malformed
header, stop for manual review; do not retry immediately. Resume the saved intent
manually **at or after `nextAttemptAt`**, with the same method/body/key; cap retries
at three and then require review. This deliberately uses a persisted/manual delay,
not an unverified claim that Make's automatic Retry honors the header. If automating
later, schedule a separate due-record consumer using that timestamp and preserve
the same bounded-attempt rule. A POST retry must not rerun slot selection or change
its body. A GET retry can repeat the original range.

Enable **Store incomplete executions = Yes**. Right-click each HTTP module, choose
**Add error handler > Retry**, and set **Automatically complete execution = No**.
For transport errors, review and resume the incomplete execution with its saved
inputs; an uncertain POST must retain the same idempotency key and body. Never use
Resume to turn failure into a synthetic successful booking. Make documents this
[manual retry setting](https://help.make.com/retry-error-handler); no automatic
`Retry-After` behavior is assumed.

No Make account, provider connection or live booking was created for this recipe.
The durable input/receipt store is operator configuration. Public availability and
booking also work without a key, but this recipe uses the scoped keychain; a supplied
invalid or disallowed key is rejected. No new REST, MCP or CLI capability is added.
