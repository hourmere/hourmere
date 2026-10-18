# MCP server

Hourmere is a remote [Model Context Protocol](https://modelcontextprotocol.io) server, so AI
agents can find free times, book, reschedule, cancel and list bookings with an API key: no
browser, no OAuth consent screen. Tools call the same service layer as the REST API, so an
agent gets exactly the behavior, validation, error codes and permissions a person gets.

## Endpoint

`POST <PUBLIC_URL>/mcp`, e.g. `https://hourmere.example.com/mcp`, on the same server as the
REST API.

- **Transport:** Streamable HTTP, built on the official TypeScript SDK
  (`@modelcontextprotocol/server` 2.x).
- **Protocol versions:** `2026-07-28`, and the earlier revisions that start with
  `initialize` (`2025-11-25` and before), which most clients still speak.
- **Stateless:** every JSON-RPC message is its own POST (to `/mcp` or `/mcp/`), answered with JSON or a short SSE
  stream for that request. There are no sessions (`Mcp-Session-Id`) and no standing GET
  stream: `GET` and `DELETE` get 405. Any server instance can answer any request.
- **Limits:** bodies up to 2 MB (the largest legal booking, see
  [api-conventions.md](api-conventions.md#validation)); larger ones get 413.
- Responses are never cached (`Cache-Control: no-store`).

## Authentication

Send an API key on every request:

```
Authorization: Bearer hm_…
```

The key acts as the user who created it, in the organization chosen when it was created
(their personal organization by default); `whoami` shows which. Keys are created while signed
in to the web app at `/app/api-keys`. Choose the intended organization, create a key and
copy it once into your secret store. The self-hosted [MCP quickstart](../apps/site/src/content/docs/docs/mcp.md)
covers the connection values and booking flow.

A missing key gets **401** with `WWW-Authenticate: Bearer`; a malformed, unknown, disabled
or deleted one gets 401 with `WWW-Authenticate: Bearer error="invalid_token"` (RFC 6750).
With OAuth disabled, discovery documents return 404.
Session cookies are never accepted on `/mcp`, even alongside a
key: a JSON-RPC endpoint that cookies could authenticate would let any web page act as a
signed-in visitor (CSRF).

**Origin:** clients that are not browsers send no `Origin` header and are not affected. A
request that carries one (it comes from a web page) is refused with **403** unless it is
Hourmere's own `PUBLIC_URL` origin. This is the MCP specification's protection against DNS
rebinding; the endpoint does not serve CORS, so browser-based clients on other sites cannot
connect.

**Rate limits:** each key's limit (600 requests a minute, shared with the REST API) counts
every MCP request; beyond it, **429** with `Retry-After`. Tools that act on public booking
pages are also limited per user, all of their keys together, with the numbers the public
endpoints apply per address: `find_available_slots` 120 a minute, `create_booking` 10,
`reschedule_booking` (by host ID or manage token) and `cancel_booking` by manage token 30 together. Beyond those, the tool
answers `rate_limited` (see [Errors](#errors)).

## OAuth 2.1 connectors

Set `MCP_OAUTH_ENABLED=true` on web and worker processes, with a stable HTTPS `PUBLIC_URL`
(loopback HTTP is accepted for development). The default is `false`; API keys keep working.
No Google/Microsoft account, OAuth client registration or calendar credentials are needed:
Hourmere is the authorization server. Restart after configuration changes.

Give the connector `<PUBLIC_URL>/mcp`. Discovery is available at
`/.well-known/oauth-protected-resource/mcp` (also the root alias) and
`/.well-known/oauth-authorization-server/api/auth`; 401 challenges name the resource document.
The issuer is `<PUBLIC_URL>/api/auth`. Clients use Authorization Code with mandatory S256
PKCE and the exact `<PUBLIC_URL>/mcp` resource in authorization and token requests. HTTPS
Client ID Metadata Documents (CIMD) are preferred; Dynamic Client Registration is supported
for older connectors. The bundled transport rejects special-use IPs, pins validated DNS
addresses and refuses redirects. Application metadata is untrusted; no remote logos load.

Sign in, explicitly choose one organization, then approve `mcp:tools` and optionally
`offline_access`. The permission covers all current MCP tools with the user's current
permissions, including attendee data and booking mutations; it grants no REST API or
account/key administration access. Another tab changing the active organization cannot
change that choice. The browser flow uses short-lived signed requests and a session-bound,
one-time intent; restart from the connector if the attempt expires or the page is refreshed.

Access tokens last five minutes. Refresh tokens last 30 days and rotate on use; a 30-second
reuse window permits lost-response retries (the replay response is encrypted). Signing keys
are encrypted with `BETTER_AUTH_SECRET`, refresh tokens are hashed. Keep that secret stable.
Reuse detection after that window invalidates refresh tokens for the same client/user
pair across organizations; reconnect affected apps. Direct JWT revocation through the
provider token-revocation endpoint reports `unsupported_token_type`; Connected apps revokes
the whole grant immediately. DPoP-bound tokens require a matching request proof and use PostgreSQL-backed replay
reservations across web instances. Unbound bearer tokens are also supported.

Manage your connections at `/app/connected-apps`. Revocation removes the grant and consent
and revokes its refresh tokens; old JWTs and pending codes remain invalid after reconnection.
Each MCP request checks the current grant, consent, client, email verification, team
membership and any session binding. Native browser consent update/delete endpoints are
disabled: use Connected apps so revocation also retires the grant and refresh tokens. OAuth attribution and idempotency use their own consent identifier, separate
from API keys and anonymous public requests. Historical booking attribution survives revocation.

OAuth requests are limited to 120 per minute per consent per web process; the existing
per-user tool limits also apply. Browser connection endpoints allow 30 requests per minute
per IP per process. Provider endpoints use Better Auth's own rate limits. The worker cleans
expired intents and token/assertion records every 15 minutes. Keep workers running.

Protocol integration tests use synthetic HTTPS metadata, real temporary PostgreSQL databases
and in-process requests. Hosted ChatGPT/claude.ai connections still require an externally
reachable HTTPS deployment and a real connector account; those are not implied by local
protocol tests. Connector availability and setup screens can change.

## Connecting a client

**Claude Code:**

```sh
claude mcp add --transport http hourmere https://hourmere.example.com/mcp \
  --header "Authorization: Bearer hm_…"
```

**Clients configured with JSON** (Cursor, Windsurf and others that support remote servers
with headers; the exact keys vary by client, e.g. VS Code's `.vscode/mcp.json` uses
`"servers"` instead of `"mcpServers"`):

```json
{
  "mcpServers": {
    "hourmere": {
      "type": "http",
      "url": "https://hourmere.example.com/mcp",
      "headers": { "Authorization": "Bearer hm_…" }
    }
  }
}
```

**OAuth connectors:** enable Hourmere's optional [OAuth 2.1 provider](#oauth-21-connectors)
for clients that require browser authorization. Actual hosted ChatGPT/claude.ai acceptance
still requires an externally reachable HTTPS deployment and a real connector account;
local protocol tests do not establish hosted compatibility. For terminal workflows, the
repository's [CLI](cli.md) calls the existing API-key tools without a third-party bridge.

**By hand**, to check a key (a 2026-07-28 request; `tools/call` adds `Mcp-Name: <tool>`):

```sh
curl https://hourmere.example.com/mcp \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Tools

Booking someone's time works like their booking page: the event type is named by the two
parts of its link, `https://<host>/<handle>/<slug>`.

| Tool | What it does | Hints |
|---|---|---|
| `whoami` | The key's user, the organization it acts in and the key id (same data as `GET /api/v1/me`) | read-only |
| `get_profile` | Your booking-page handle, time zone and language | read-only |
| `list_event_types` | Compact, paginated summaries of visible event types in the key's organization | read-only |
| `get_event_type` | One visible event type's full configuration | read-only |
| `list_schedules` | Compact, paginated summaries of your working-hours schedules | read-only |
| `get_schedule` | One of your schedules, including weekly hours in its time zone | read-only |
| `find_available_slots` | The event type (title, duration, questions, host's time zone when applicable) and its free slots between two dates | read-only |
| `create_booking` | Books a slot for an invitee; returns the booking and its `manageToken` | open world |
| `reschedule_booking` | Moves a booking you host (`bookingId`) or one you made (`manageToken`); returns the new booking and a new token | destructive, open world |
| `cancel_booking` | Cancels a booking you host (`bookingId`) or one you made (`manageToken`) | destructive, idempotent, open world |
| `list_bookings` | Bookings you host in the key's organization, by start time, a page at a time | read-only |

Configuration discovery starts with `whoami` and `get_profile`. `list_event_types` includes
team event types and your personal types in the key's organization, including inactive
configurations; deleted types and another member's personal types are excluded. Discovery
is not proof of public availability: use `find_available_slots` before booking.
`list_schedules` includes only your schedules, which follow your user across organizations.
Use the corresponding `get_` tool for full details; `get_schedule` returns weekly hours,
not date overrides. Configuration changes and date overrides use the REST API or web app.

`find_available_slots` and `create_booking` accept exactly one public namespace:
`handle` for `/{handle}/{slug}`, or `teamSlug` for `/team/{teamSlug}/{slug}`. Personal
handles are case-insensitive; team slugs use exact stored case. Old `handle` inputs remain
valid. A collective team type offers only intervals every required host offers; see
[collective scheduling](collective-scheduling.md) for its bounds and rescheduling rules.
An activated round-robin type offers the union and assigns one available host. Its booking
result includes safe `assignedHost` name/time zone; retries and rescheduling retain that
selection. See [round-robin scheduling](round-robin-scheduling.md).

Both catalog lists accept `limit` (default 20, maximum 100) and `after`. Results are
`{ data, nextAfter }`, sorted by ID. Set `after` to the previous `nextAfter`, keep the same key
and acting organization, and stop at `nextAfter: null`. The cursor is exclusive and remains
usable if that row is deleted. Pages are recalculated; concurrent configuration changes can
affect later pages. Lists contain bounded metadata, not descriptions, questions, location or
weekly hours; each database query fetches at most `limit + 1` summaries.

`list_bookings` defaults to ascending start time (then ID). Set `order: "desc"` for newest
first; keep the same order and filters when following `nextCursor`. The host's Past page
uses descending order for the complete paginated history. Optional `endAfter` (strictly
after) and `endTo` (at or before) filter by booking end time; Upcoming includes in-progress
meetings. Keep filters unchanged while paginating.

Each tool's description and JSON Schemas (`tools/list`) say what it needs and returns; the
fields are those of the REST API (`/api/v1/openapi.json`). Results come as
`structuredContent` and, for older clients, as the same JSON in a text block.

- **Times** are RFC 3339. Results give instants in UTC (`2026-11-02T08:00:00.000Z`).
  `find_available_slots` takes a `timeZone` (an IANA name, e.g. `Europe/Berlin`; numeric
  offsets such as `+01:00` are refused because they ignore daylight saving time) and
  calendar days in it (`startDate`,
  `endDate`, inclusive, at most 62 days), and gives each slot in that zone too
  (`localStart`: `2026-11-02T09:00:00+01:00`). Pass a slot's `start` unchanged to
  `create_booking` or `reschedule_booking`.
- **Slot pages:** `find_available_slots` returns at most `maxSlots` entries (default 100,
  maximum 500). If `nextAfter` is non-null, repeat the same handle, slug, dates and time zone
  with `after=nextAfter`. The cursor excludes the previous start, and `nextAfter: null`
  marks the end. Availability is recalculated each time and can change between pages;
  recheck the chosen time before booking. This bounds both JSON result copies.
- **Manage tokens** are the invitee's secret. Only a hash is stored, so a token is returned
  once: keep it to reschedule or cancel later. The tools also take the token from a link in
  one of the invitee's booking emails (`https://<host>/booking#token=<token>`); each email
  has its own. A token a tool returned stays with its booking (after a reschedule it belongs
  to the cancelled one), while an email's token follows the meeting to the booking that
  replaced it ([api-conventions.md](api-conventions.md#public-endpoints)).
- **Host moves:** pass `bookingId` from `list_bookings` and a new `start` to
  `reschedule_booking`. You must host the booking in the key's current organization.
  Give exactly one of `bookingId` or `manageToken`. All hosts' current availability is
  checked with the old booking ignored, so the new time may overlap it. A move creates a
  successor; retrying the old ID fails with `booking_cancelled`. After a lost response,
  inspect `list_bookings` and `rescheduledFromId` before deciding what to do next.
- **Emails:** bookings made, moved or cancelled through MCP send the same emails as the
  booking page (hosts, invitee, guests; [notifications.md](notifications.md)).
- **Retries:** give `create_booking` an `idempotencyKey` (a new random value per booking,
  e.g. a UUIDv4). A retry with the same key and arguments returns the original booking with
  `replayed: true` and `manageToken: null`; the same key with other arguments fails with
  `idempotency_key_reused`. Keys are scoped to your API key. Rescheduling is not idempotent.
- Bookings made through MCP are recorded with source `mcp` and the API key used.
  Cancellation and reschedule withdrawals keep their own source/key attribution without
  replacing the original creation attribution, including invitee manage-token calls.

## Errors

A tool that fails returns a result with `isError: true` (models see it and can correct
themselves) whose text is the REST API's error body:

```json
{ "error": "slot_taken", "message": "Someone else just booked this time" }
```

- `error` is the same stable code the REST API uses for the same failure (`slot_unavailable`,
  `slot_taken`, `invalid_time_zone`, `invalid_responses`, `booking_not_found`,
  `booking_cancelled`, `idempotency_key_reused`, …); `message` is safe to show and may change.
- Arguments that do not fit the schema get `invalid_request`, with `message` naming the
  fields (`invitee.email: Invalid email address`; long names and messages are shortened).
  Unknown arguments are refused, not ignored. Text with NUL characters or malformed Unicode is
  refused the same way.
- `rate_limited` adds `retryAfterSeconds`.
- `internal_error` means a bug on our side; details go to the server log only.

Requests that are not valid MCP get JSON-RPC errors from the protocol layer: malformed JSON
is `-32700` (HTTP 400), an unknown tool `-32602`. Refusals before the protocol layer (401,
403, 405, 429) use the REST error shape, `{ "error": "unauthorized", "message": "…" }`.

## What's next

- Configuration write tools (profile, schedules, event types), on the services the REST API
  now uses for them. Read-only discovery is available today.

## Adding a tool

Tools live in `apps/server/src/mcp/`. Each is declared with `defineTool` (`tools.ts`): a
snake_case name, a title, a description written for models (when to use it, what it returns,
units and time zones), a strict zod input schema (reuse the REST route's schemas), an output
schema, all four annotations, and a handler that builds a `ServiceContext` from the caller and
calls the service layer. The framework validates arguments and results, maps `DomainError`
to error results and logs anything else on one escaped line. Register the tool in `server.ts`
and cover it in `apps/server/src/mcp/*.test.ts`.

## Automatic Meet reconciliation

Collective automatic Meet uses the owner-selected organizer; round robin uses its actual eligible
winner. Public `find_available_slots`/`create_booking` never accept a host selection. Final
invitations wait for readiness. `list_bookings` exposes only the caller's optional ordinary
`calendarCopy` state. `retry_conference({bookingId})` is restricted to the current verified pinned
organizer; `retry_calendar_copy({bookingId})` reconciles the caller's original failed configured
copy. Both reject unknown/force-create fields and never choose a replacement account/calendar.
See [automatic-google-meet.md](automatic-google-meet.md) for optional copies and identity policy.


## Automatic Zoom reconciliation

Personal and individual single-host team events may opt into automatic Zoom using the actual
host's private meeting-mode connection. Enabling or changing that configuration requires the
actual host's live browser session; API keys/MCP grants and another team administrator cannot
select a private connection. Passive Zoom labels remain unchanged; collective/round-robin
automatic Zoom is rejected. Booking an already configured event uses existing caller authority.

`create_booking` and `list_bookings` use `conference.provider = "zoom"` with pending/ready/failed
status. A participant URL appears only when the current meeting is ready, never in public event
catalogs. `retry_conference({bookingId})` and CLI `npm run --silent cli -- retry-meeting --input retry.json`
(with `{"bookingId":"<id>"}` in the private input file)
retain existing pinned-organizer permissions, including authorized API keys. They reconcile
a known meeting ID without selecting another account or creating a replacement. An unknown
claimed create remains ambiguous even after retry; no force-create/list/adoption argument is
accepted. A private optional ordinary Google copy does not create a second conference or gate
ready Zoom mail. See [automatic-zoom.md](automatic-zoom.md) for setup and acceptance limits.
