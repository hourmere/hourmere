---
title: MCP quickstart
description: Connect an AI client to Hourmere's remote MCP server using an API key or OAuth.
---

## Connect a client

Create an API key at `/app/api-keys` on your [instance](/docs/self-hosting). The one-time
key creation view provides copy buttons for the key, a curl example, a JSON client config
and a Claude Code command. The configs include your instance's `PUBLIC_URL` and the new key;
save them privately before dismissing the view. The full key is shown only there, never in
the keys list, and cannot be retrieved after dismissal or leaving the page. The new key
appears in the list immediately.

The remote endpoint is `{PUBLIC_URL}/mcp`, using Streamable HTTP. Choose a client that can
send a custom HTTP header on every request. For clients configured with JSON:

```json
{
  "mcpServers": {
    "hourmere": {
      "type": "http",
      "url": "https://hourmere.example.com/mcp",
      "headers": {
        "Authorization": "Bearer hm_…"
      }
    }
  }
}
```

For Claude Code:

```sh
claude mcp add --transport http hourmere 'https://hourmere.example.com/mcp' \
  --header "Authorization: Bearer hm_…"
```

Replace `https://hourmere.example.com` with your instance's `PUBLIC_URL` and `hm_…` with
your API key when using these documentation examples. The JSON shows the connection values;
client-specific configuration keys may differ. Store the real key privately. Hourmere's
MCP server accepts API keys and, when the instance operator enables it, organization-bound
[OAuth 2.1 connections](#connect-with-oauth); API keys keep
working with or without the optional OAuth 2.1 connector flow described below. Session
cookies never authenticate MCP. A browser request from a different origin is refused;
non-browser clients normally send no `Origin` header.

Ask the client to list tools, then call `whoami` to verify the user and organization before
changing bookings. The endpoint is stateless: it does not issue a session ID or maintain a
standing GET event stream. Authentication failures return HTTP 401; rate limits return 429.

## Discover your configuration

Call `whoami` to check the key's organization and `get_profile` for your booking-page handle,
time zone and language. No profile yet returns `profile_not_found`; create one in the web
app or through REST.

| Tool | Input and result |
|---|---|
| `list_event_types` | Optional `limit` and `after`; compact summaries of team types and your personal types in the key's organization. Includes inactive configurations, excludes deleted types. |
| `get_event_type` | An `id` from the list; full configuration, including questions, location and rules. |
| `list_schedules` | Optional `limit` and `after`; summaries of your schedules. Schedules belong to your user across organizations. |
| `get_schedule` | An `id` from the list; weekly working hours in the schedule's IANA time zone. Date overrides are separate. |
| `list_calendar_connections` | No arguments; your connected account emails, calendar names and IDs, safe connection status, conflict settings and write destination. |
| `list_conference_connections` | No arguments; your Zoom connection IDs, account email and display name, identity/meetings mode and safe status. |

Catalog lists return `{ data, nextAfter }`, sorted by ID, with 20 summaries by default and at
most 100 (`limit: 1`–`100`). Pass `after: nextAfter` with the same key and organization until
`nextAfter` is null. Cursors exclude the previous row, even if that row was deleted. Pages
are recalculated, so configuration changes may affect later pages. The list omits large
detail fields; use the corresponding detail tool when needed. Configuration writes and date
overrides remain available through REST and the web app. Always check public availability
with `find_available_slots` before booking an event found in the catalog.

Connection discovery accepts API keys and enabled MCP OAuth grants and reads only your own
metadata, without credentials or provider calls. The user's own API keys can change calendar
conflict selection, the writeback destination, refresh the calendar list and sync now through
REST, and select their own meeting-mode Zoom connection on event types they actually host.
The same organization and ownership checks apply as for browser sessions.
OAuth authorization, code exchange and disconnect require a live browser session;
explicit Zoom credential refresh remains session-only. Settings mutations use REST with an
API key; MCP OAuth grants do not authenticate REST requests.

## Book and manage time

| Tool | Input and result |
|---|---|
| `whoami` | No arguments; shows the key's user, organization and key ID. |
| `find_available_slots` | A booking page's `handle`, `slug`, `startDate`, `endDate`, `timeZone`; returns event details and slots. Dates span at most 62 days inclusive. |
| `create_booking` | `handle`, `slug`, a returned slot's `start`, `invitee`, and an optional `idempotencyKey`; returns the booking and manage token. |
| `reschedule_booking` | Exactly one of hosted `bookingId` or invitee `manageToken`, plus new `start`; returns a replacement booking, with a new token for invitee moves and null for host moves. |
| `cancel_booking` | Either a hosted `bookingId` or an invitee `manageToken`; cancels the booking. |
| `list_bookings` | Lists bookings hosted by the key owner in its organization, with pagination. `order` defaults to `asc`; use `desc` for newest first and keep it unchanged between pages. |

For example, after confirming the booking page, test recipient and time zone with your agent:

```json
{"handle":"ada","slug":"intro","startDate":"2026-11-02","endDate":"2026-11-03","timeZone":"America/Los_Angeles"}
```

Slot results are paginated: `maxSlots` defaults to 100 and accepts 1–500. When `nextAfter`
is non-null, repeat the same query with `after` set to that returned instant. Keep the dates,
handle, slug and time zone unchanged. `nextAfter: null` marks the final page. Both the
structured result and its text copy contain only this page. Availability is recalculated
on every request and can change between pages, so recheck the chosen slot before booking.

Dates must still be in the future and within the event type's booking window. Ask for an
available slot, then pass its exact UTC `start` to `create_booking` with an invitee name,
email and IANA time zone. Booking actions send the normal notifications and project onto a
configured calendar. Use a controlled test address when trying it out.

Optional `invitee.locale` chooses notification language using the
[shared locale registry](/docs/interface-languages), with per-message English fallback.
The same BCP 47 field is accepted by REST and CLI and is retained through booking retries,
reschedules and cancellation; it does not change `timeZone` or UTC result timestamps.

Keep manage tokens privately to reschedule/cancel. A create retry with the same idempotency
key and arguments returns the existing booking but no new manage token. A different booking
needs a new key. Rescheduling is not idempotent. Invitee moves return a new manage token;
the previous API token remains bound to the old cancelled booking. Host moves preserve
the existing invitee token on the successor. An email token always follows the meeting.

Tool results include `structuredContent` and a JSON text copy. Tool failures set `isError`
and return the same stable error codes as REST, such as `slot_unavailable`, `slot_taken`,
`calendar_sync_unavailable` or `idempotency_key_reused`. Use the live `tools/list` schemas for
required fields and limits. The [REST guide](/docs/rest) covers token handling and booking
semantics shared by both interfaces.

## Reschedule as the host

Use `list_bookings` to find a booking you host, then call `reschedule_booking` with
`bookingId` and the new `start`. The key must act in that booking's organization. Give
exactly one of `bookingId` or `manageToken`; both forms share the same availability,
notification and per-user management limits.

Host booking fields include optional `rescheduledToId`: the immediate successor in the same
organization that the caller also hosts, or null when none is available. It is returned even
when the successor falls outside the current page or filters. Public/manage responses omit
it. The predecessor's `status` remains `cancelled`; use `rescheduledToId` to distinguish a
reschedule from a cancellation, and `rescheduledFromId` to trace back to its predecessor.

A move creates a new booking with `rescheduledFromId` pointing to the old one. Retrying the
old ID fails with `booking_cancelled`. If an answer is lost, inspect `list_bookings` before
trying another move. Host moves return `manageToken: null`; the invitee's existing links
continue to work without revealing their secret to the host. The web booking detail page
and `POST /api/v1/bookings/{id}/reschedule` offer the same host action.

## Connect with OAuth

For browser-based AI connectors, the instance operator can set `MCP_OAUTH_ENABLED=true`
with a stable HTTPS `PUBLIC_URL`. The default is `false`; API keys keep working.
Use the same `/mcp` server URL. Hourmere serves OAuth
resource/issuer discovery, supports HTTPS Client ID Metadata Documents and dynamic client
registration, and requires Authorization Code with S256 PKCE and the MCP resource indicator.

Sign in, choose an organization explicitly, and review the app's requested access. MCP
access includes booking details and mutations with your current permissions in that
organization. Optional `offline_access` keeps the connection working after browser sign-out
or session expiry, for at most 30 days from the original approval. Refreshing does not extend
that deadline; reconnect when it expires. Every request checks your current membership and
permissions. Removal from the organization or revocation ends access immediately. Revoke an
app at **Connected apps**; old tokens stop working immediately. API keys remain available
when OAuth is disabled. Calendar connections are configured separately.

OAuth limits apply regardless of `NODE_ENV`: registration allows 5 requests per minute per
IP, authorization 30 and token requests 20. Code exchanges, refreshes and failed token
requests share that token budget; provider 429 responses include `X-Retry-After` seconds
(the authorization entrance limiter uses `Retry-After`). Workers remove DCR
clients without completed consent after 24 hours and clients unused for at least 90 days
(with up to one day of grace for daily activity writes).

## MCP server reference

Hourmere is a remote [Model Context Protocol](https://modelcontextprotocol.io) server, so AI
agents can find free times, book, reschedule, cancel and list bookings with an API key: no
browser, no OAuth consent screen. Tools call the same service layer as the REST API, so an
agent gets exactly the behavior, validation, error codes and permissions a person gets.

## Endpoint

`POST <PUBLIC_URL>/mcp`, e.g. `https://hourmere.example.com/mcp`, on the same server as the
REST API.

For owner-prepared Registry metadata and directory submission requirements, see
[MCP directories](https://github.com/hourmere/hourmere/blob/main/docs/mcp-directories.md). The checked-in metadata is a draft; it does not
assert a live public instance or a published listing.

- **Transport:** Streamable HTTP, built on the official TypeScript SDK
  (`@modelcontextprotocol/server` 2.x).
- **Protocol versions:** `2026-07-28`, and the earlier revisions that start with
  `initialize` (`2025-11-25` and before), which most clients still speak.
- **Stateless:** every JSON-RPC message is its own POST (to `/mcp` or `/mcp/`), answered with JSON or a short SSE
  stream for that request. There are no sessions (`Mcp-Session-Id`) and no standing GET
  stream: `GET` and `DELETE` get 405. Any server instance can answer any request.
- **Limits:** bodies up to 2 MB (the largest legal booking, see
  [API conventions](/docs/api-conventions#validation)); larger ones get 413.
- Responses are never cached (`Cache-Control: no-store`).

## Authentication

Send an API key on every request:

```
Authorization: Bearer hm_…
```

The key acts as the user who created it, in the organization chosen when it was created
(their personal organization by default); `whoami` shows which. Keys are created while signed
in to the web app at `/app/api-keys`. Choose the intended organization, create a key and
copy it once into your secret store. The [quickstart above](#connect-a-client)
covers the connection values and booking flow.

With OAuth disabled, missing credentials get **401** with `WWW-Authenticate: Bearer`; a
malformed, unknown, disabled or deleted key gets 401 with
`WWW-Authenticate: Bearer error="invalid_token"` (RFC 6750), and discovery documents return
404. With OAuth enabled, missing credentials get
`Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`; invalid
tokens include `error="invalid_token"` and the same resource metadata. A token missing
`mcp:tools` gets 403 with `error="insufficient_scope"`, resource metadata and
`scope="mcp:tools"` so the connector can request approval.
Session cookies are never accepted on `/mcp`, even alongside a
key: a JSON-RPC endpoint that cookies could authenticate would let any web page act as a
signed-in visitor (CSRF).

Session cookies never authenticate MCP. API keys keep working when OAuth is disabled;
the optional OAuth flow below grants access only to MCP tools.

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

Access tokens last five minutes. With `offline_access`, the connection survives browser
sign-out and session expiry for at most 30 days from the original consent. Refresh tokens
rotate on use without extending that absolute deadline; reconnect after it expires. Without
`offline_access`, a session-bound access token stops working when its browser session ends.
A 30-second reuse window permits lost-response retries (the replay response is encrypted).
Signing keys are encrypted with `BETTER_AUTH_SECRET`, refresh tokens are hashed. Keep that secret stable.
Reuse detection after that window invalidates refresh tokens for the same client/user
pair across organizations; reconnect affected apps. Direct JWT revocation through the
provider token-revocation endpoint reports `unsupported_token_type`; Connected apps revokes
the whole grant immediately. DPoP-bound tokens require a matching request proof and use PostgreSQL-backed replay
reservations across web instances. Unbound bearer tokens are also supported.

Manage your connections at `/app/connected-apps`. Revocation removes the grant and consent
and revokes its refresh tokens; old JWTs and pending codes remain invalid after reconnection.
Every token issuance, refresh and MCP request checks the current user, grant, consent,
client, verified email and organization membership. Current roles continue to govern each
tool. Organization removal or revocation stops the connection immediately, including offline
access. Browser session liveness is required only for access without `offline_access`.
Native browser consent update/delete endpoints are disabled: use Connected apps so revocation also retires the grant and refresh tokens. OAuth attribution and idempotency use their own consent identifier, separate
from API keys and anonymous public requests. Historical booking attribution survives revocation.

OAuth requests are limited to 120 per minute per consent per web process; the existing
per-user tool limits also apply. Browser connection endpoints allow 30 requests per minute
per IP per process. Provider limits apply in every `NODE_ENV`: dynamic registration allows
5 requests per minute per IP, authorization 30, and the token endpoint 20. The token budget
is shared by code exchanges, refreshes and failed requests from the same IP; exceeding it
returns 429 with Better Auth’s `X-Retry-After` seconds header (the authorization entrance
limiter uses `Retry-After`). Broker calls forward the server's trusted client IP to avoid
a shared provider bucket. Requests rejected before client and redirect validation render an
Hourmere error page; they never redirect to an unvalidated client address.

Every 15 minutes, the worker cleans expired intents and token/assertion records. It also
removes DCR clients that have not completed consent within 24 hours and clients unused for
at least 90 days (up to one extra day allows for coalesced activity writes). A durable
completion/activity record survives revocation; successful approval, token issuance and MCP use refresh activity (writes are coalesced within a day). CIMD and
operator-owned clients are excluded from DCR cleanup. Keep workers running.

Protocol integration tests use synthetic HTTPS metadata, real temporary PostgreSQL databases
and in-process requests. Hosted ChatGPT/claude.ai connections still require an externally
reachable HTTPS deployment and a real connector account; those are not implied by local
protocol tests. Connector availability and setup screens can change.

## Connecting a client

The one-time key creation view at `/app/api-keys` offers both snippets below with your
instance URL and newly created key already filled in. Copy and save them before dismissing
the view or leaving the page. These documentation examples use placeholders: replace
`https://hourmere.example.com` with `PUBLIC_URL` and `hm_…` with your own key.

**Claude Code:**

```sh
claude mcp add --transport http hourmere 'https://hourmere.example.com/mcp' \
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
      "headers": {
        "Authorization": "Bearer hm_…"
      }
    }
  }
}
```

**OAuth connectors:** enable Hourmere's optional [OAuth 2.1 provider](#oauth-21-connectors)
for clients that require browser authorization. Actual hosted ChatGPT/claude.ai acceptance
still requires an externally reachable HTTPS deployment and a real connector account;
local protocol tests do not establish hosted compatibility. For terminal workflows, the
repository's [CLI](/docs/cli) calls the existing API-key tools without a third-party bridge.

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
| `list_calendar_connections` | Your calendar connection status, calendar IDs, conflict settings and write destination; no credentials | read-only |
| `list_conference_connections` | Your Zoom connection IDs, modes and status; no credentials or browser authorization attempts | read-only |
| `find_available_slots` | The event type (title, duration, questions, host's time zone when applicable) and its free slots between two dates | read-only |
| `create_booking` | Books a slot for an invitee; returns the booking and its `manageToken` | open world |
| `reschedule_booking` | Moves a booking you host (`bookingId`, token is null) or one you made (`manageToken`, returns a new token) | destructive, open world |
| `cancel_booking` | Cancels a booking you host (`bookingId`) or one you made (`manageToken`) | destructive, idempotent, open world |
| `list_bookings` | Bookings you host in the key's organization, by start time, a page at a time | read-only |

Configuration discovery starts with `whoami` and `get_profile`. `list_event_types` includes
team event types and your personal types in the key's organization, including inactive
configurations; deleted types and another member's personal types are excluded. Discovery
is not proof of public availability: use `find_available_slots` before booking.
`list_schedules` includes only your schedules, which follow your user across organizations.
Use the corresponding `get_` tool for full details; `get_schedule` returns weekly hours,
not date overrides. Configuration changes and date overrides use the REST API or web app.

The two connection tools take `{}` and call the same services as
`GET /api/v1/calendar-connections` and `GET /api/v1/conference-connections`. They read only
the caller's own connections across organizations and make no provider requests. API keys
and enabled MCP OAuth grants can use both tools. The user's own API keys can change calendar
conflict selection, the writeback destination, refresh the calendar list and sync now through
REST. They can also select their own meeting-mode Zoom connection on event types they
actually host, subject to the same organization permissions as browser sessions.
OAuth authorization, code exchange and disconnect require a live browser session;
explicit Zoom credential refresh remains session-only. No MCP settings mutation tools are
provided. MCP OAuth grants do not authenticate REST requests.

`find_available_slots` and `create_booking` accept exactly one public namespace:
`handle` for `/{handle}/{slug}`, or `teamSlug` for `/team/{teamSlug}/{slug}`. Personal
handles are case-insensitive; team slugs use exact stored case. Old `handle` inputs remain
valid. A collective team type offers only intervals every required host offers; see
[collective scheduling](/docs/collective-scheduling) for its bounds and rescheduling rules.
An activated round-robin type offers the union and assigns one available host. Its booking
result includes safe `assignedHost` name/time zone; retries and rescheduling retain that
selection. See [round-robin scheduling](/docs/round-robin-scheduling).

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

Host booking fields include optional `rescheduledToId`: the immediate successor in the same
organization that the caller also hosts, or null when none is available. It is returned even
when the successor falls outside the current page or filters. Public/manage responses omit
it. The predecessor's `status` remains `cancelled`; use `rescheduledToId` to distinguish a
reschedule from a cancellation, and `rescheduledFromId` to trace back to its predecessor.

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
  has its own. A response token follows host moves, but after an invitee move stays on
  the cancelled booking. An email's token follows the meeting to the booking that
  replaced it ([API conventions](/docs/api-conventions#public-endpoints)).
- **Host moves:** pass `bookingId` from `list_bookings` and a new `start` to
  `reschedule_booking`. You must host the booking in the key's current organization.
  Give exactly one of `bookingId` or `manageToken`. All hosts' current availability is
  checked with the old booking ignored, so the new time may overlap it. A move creates a
  successor and returns `manageToken: null`: manage tokens are the invitee's secret.
  The existing response-token hash moves atomically to the successor, and all earlier
  email links keep following the chain. Retrying the old ID fails with `booking_cancelled`. After a lost response,
  inspect `list_bookings`, `rescheduledToId` and `rescheduledFromId` before deciding what to do next.
  People and REST clients use the same service through `POST /api/v1/bookings/{id}/reschedule`
  (`{ start }`); the admin booking detail page offers the same action and authorized slots.
- **Invitee move limit:** manage-token reschedules share one budget across the whole
  booking chain (default five, configured by `BOOKING_MAX_INVITEE_RESCHEDULES`; zero
  disables them). `booking_reschedule_limit` means contact the host to change it again.
  Cancellation remains available. Host moves are unlimited and do not consume the budget.
- **Emails:** bookings made, moved or cancelled through MCP send the same emails as the
  booking page (hosts, invitee, guests; [Notifications and background jobs](/docs/notifications)).
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
  `booking_cancelled`, `booking_reschedule_limit`, `idempotency_key_reused`, …); `message` is safe to show and may change.
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

## Automatic Meet reconciliation

Collective automatic Meet uses the owner-selected organizer; round robin uses its actual eligible
winner. Public `find_available_slots`/`create_booking` never accept a host selection. Final
invitations wait for readiness. `list_bookings` exposes only the caller's optional ordinary
`calendarCopy` state. `retry_conference({bookingId})` is restricted to the current verified pinned
organizer; `retry_calendar_copy({bookingId})` reconciles the caller's original failed configured
copy. Both reject unknown/force-create fields and never choose a replacement account/calendar.
`conference.errorCode="conference_pending_timeout"` distinguishes exhausted pending polls
from `provider_unavailable`. For that timeout, `retry_conference` (CLI `retry-meeting`)
grants another bounded read/poll budget for the same event and UUID; it does not repeat an
acknowledged PATCH or force-create a new request. A permanently stuck pending UUID needs
the documented operator repair.
See [Automatic Google Meet](/docs/automatic-google-meet) for optional copies and identity policy.


## Automatic Zoom reconciliation

Personal and individual single-host team events may opt into automatic Zoom using the actual
host's private meeting-mode connection. Enabling or changing that configuration accepts the
actual host's session or own API key through REST, with the same organization checks.
Another team administrator cannot select a host's private connection. MCP OAuth grants can
list their own connections but do not authenticate REST settings mutations.
Passive Zoom labels remain unchanged; collective/round-robin
automatic Zoom is rejected. Booking an already configured event uses existing caller authority.

`create_booking` and `list_bookings` use `conference.provider = "zoom"` with pending/ready/failed
status. A participant URL appears only when the current meeting is ready, never in public event
catalogs. `retry_conference({bookingId})` and CLI `npm run --silent cli -- retry-meeting --input retry.json`
(with `{"bookingId":"<id>"}` in the private input file)
retain existing pinned-organizer permissions, including authorized API keys. They reconcile
a known meeting ID without selecting another account or creating a replacement. An unknown
claimed create remains ambiguous even after retry; no force-create/list/adoption argument is
accepted. A private optional ordinary Google copy does not create a second conference or gate
ready Zoom mail. See [Automatic Zoom for one host](/docs/automatic-zoom) for setup and acceptance limits.
