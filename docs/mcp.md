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
`reschedule_booking` and `cancel_booking` by manage token 30 together. Beyond those, the tool
answers `rate_limited` (see [Errors](#errors)).

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

**Claude Desktop and claude.ai:** custom connectors there sign in with OAuth, which Hourmere
does not offer yet (see [What's next](#whats-next)). Meanwhile Claude Desktop can reach the
endpoint through a local bridge that adds the header, such as
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), in `claude_desktop_config.json`.
Pin a version (versions before 0.1.16 have a remote code execution flaw, CVE-2025-6514):

```json
{
  "mcpServers": {
    "hourmere": {
      "command": "npx",
      "args": ["mcp-remote@0.14.3", "https://hourmere.example.com/mcp", "--header", "Authorization:${HOURMERE_AUTH}"],
      "env": { "HOURMERE_AUTH": "Bearer hm_…" }
    }
  }
}
```

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
| `find_available_slots` | The event type (title, duration, questions, host's time zone) and its free slots between two dates | read-only |
| `create_booking` | Books a slot for an invitee; returns the booking and its `manageToken` | open world |
| `reschedule_booking` | Moves a booking to another slot with its `manageToken`; returns the new booking and a new token | destructive, open world |
| `cancel_booking` | Cancels a booking you host (`bookingId`) or one you made (`manageToken`) | destructive, idempotent, open world |
| `list_bookings` | Bookings you host in the key's organization, by start time, a page at a time | read-only |

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
- **Emails:** bookings made, moved or cancelled through MCP send the same emails as the
  booking page (hosts, invitee, guests; [notifications.md](notifications.md)).
- **Retries:** give `create_booking` an `idempotencyKey` (a new random value per booking,
  e.g. a UUIDv4). A retry with the same key and arguments returns the original booking with
  `replayed: true` and `manageToken: null`; the same key with other arguments fails with
  `idempotency_key_reused`. Keys are scoped to your API key. Rescheduling is not idempotent.
- Bookings made through MCP are recorded with source `mcp` and the API key used.

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

- **OAuth 2.1**, so claude.ai and ChatGPT connectors can sign in without copying a key. It
  will be added next to API keys, which keep working: the server will publish its protected
  resource metadata at `/.well-known/oauth-protected-resource/mcp` (now a 404) and name it in
  the 401's `WWW-Authenticate` header, and access tokens will resolve to the same kind of
  caller as keys. The seam is `apps/server/src/mcp/endpoint.ts`.
- Tools for the owner side (profile, schedules, event types), on the services the REST API
  now uses for them.
- Rescheduling as the host (the service layer only reschedules through manage tokens so far).

## Adding a tool

Tools live in `apps/server/src/mcp/`. Each is declared with `defineTool` (`tools.ts`): a
snake_case name, a title, a description written for models (when to use it, what it returns,
units and time zones), a strict zod input schema (reuse the REST route's schemas), an output
schema, all four annotations, and a handler that builds a `ServiceContext` from the caller and
calls the service layer. The framework validates arguments and results, maps `DomainError`
to error results and logs anything else on one escaped line. Register the tool in `server.ts`
and cover it in `apps/server/src/mcp/*.test.ts`.
