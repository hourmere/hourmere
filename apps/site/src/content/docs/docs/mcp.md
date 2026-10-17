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

## Book and manage time

| Tool | Input and result |
|---|---|
| `whoami` | No arguments; shows the key's user, organization and key ID. |
| `find_available_slots` | A booking page's `handle`, `slug`, `startDate`, `endDate`, `timeZone`; returns event details and slots. Dates span at most 62 days inclusive. |
| `create_booking` | `handle`, `slug`, a returned slot's `start`, `invitee`, and an optional `idempotencyKey`; returns the booking and manage token. |
| `reschedule_booking` | `manageToken` and new `start`; returns a replacement booking and token. |
| `cancel_booking` | Either a hosted `bookingId` or an invitee `manageToken`; cancels the booking. |
| `list_bookings` | Lists bookings hosted by the key owner in its organization, with pagination. |

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
semantics shared by both interfaces. Hosting/catalog tools and host-side rescheduling are
not implemented yet.
