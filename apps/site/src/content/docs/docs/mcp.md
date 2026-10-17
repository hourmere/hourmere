---
title: MCP quickstart
description: Connect an AI client to Hourmere's remote MCP server using an API key.
---

## Connect a client

Create an API key at `/app/api-keys` on your [instance](/docs/self-hosting). The remote endpoint
is `{PUBLIC_URL}/mcp`, using Streamable HTTP. Choose a client that can send a custom HTTP
header on every request:

```json
{
  "mcpServers": {
    "hourmere": {
      "type": "http",
      "url": "https://meet.example.com/mcp",
      "headers": { "Authorization": "Bearer <your API key>" }
    }
  }
}
```

This shows the connection values; client-specific configuration keys may differ. Store the
real key privately. Hourmere currently accepts API keys, with no OAuth 2.1 connector flow.
An OAuth-only client cannot connect directly yet. Browser session cookies do not authenticate
MCP. A browser request from a different origin is refused; non-browser clients normally send
no `Origin` header.

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

Catalog lists return `{ data, nextAfter }`, sorted by ID, with 20 summaries by default and at
most 100 (`limit: 1`–`100`). Pass `after: nextAfter` with the same key and organization until
`nextAfter` is null. Cursors exclude the previous row, even if that row was deleted. Pages
are recalculated, so configuration changes may affect later pages. The list omits large
detail fields; use the corresponding detail tool when needed. Configuration writes and date
overrides remain available through REST and the web app. Always check public availability
with `find_available_slots` before booking an event found in the catalog.

## Book and manage time

| Tool | Input and result |
|---|---|
| `whoami` | No arguments; shows the key's user, organization and key ID. |
| `find_available_slots` | A booking page's `handle`, `slug`, `startDate`, `endDate`, `timeZone`; returns event details and slots. Dates span at most 62 days inclusive. |
| `create_booking` | `handle`, `slug`, a returned slot's `start`, `invitee`, and an optional `idempotencyKey`; returns the booking and manage token. |
| `reschedule_booking` | Exactly one of hosted `bookingId` or invitee `manageToken`, plus new `start`; returns a replacement booking and token. |
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

Keep manage tokens privately to reschedule/cancel. A create retry with the same idempotency
key and arguments returns the existing booking but no new manage token. A different booking
needs a new key. Rescheduling is not idempotent and returns a new manage token; the previous
API token remains bound to the old cancelled booking. An email token follows the meeting.

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

A move creates a new booking with `rescheduledFromId` pointing to the old one. Retrying the
old ID fails with `booking_cancelled`. If an answer is lost, inspect `list_bookings` before
trying another move. The returned new manage token is shown once, as with an invitee move.

## Connect with OAuth

For browser-based AI connectors, the instance operator can set `MCP_OAUTH_ENABLED=true`
with a stable HTTPS `PUBLIC_URL`. Use the same `/mcp` server URL. Hourmere serves OAuth
resource/issuer discovery, supports HTTPS Client ID Metadata Documents and dynamic client
registration, and requires Authorization Code with S256 PKCE and the MCP resource indicator.

Sign in, choose an organization explicitly, and review the app's requested access. MCP
access includes booking details and mutations with your current permissions in that
organization. Optional offline access keeps the connection for up to 30 days. Revoke an
app at **Connected apps**; old tokens stop working immediately. API keys remain available
when OAuth is disabled. Calendar connections are configured separately.
