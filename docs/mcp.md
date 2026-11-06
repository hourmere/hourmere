# MCP client setup

The canonical [MCP quickstart](https://hourmere.com/docs/mcp) covers API keys, OAuth,
tools and protocol behavior.

Create an API key at `/app/api-keys`. Choose **Bookings** (`bookings`, the default) for an
AI booking agent, **Read** (`read`) for analytics/reporting, or **Full account access**
(`full`) only for software you trust to change your account configuration. The one-time
view explains the key's scope and what your agent can do. Its copy buttons provide
the key, the curl example, a JSON client config and a Claude Code command. The snippets use
the instance's configured `PUBLIC_URL` and the newly created key. Save them privately
before dismissing the view or leaving the page: the full key cannot be retrieved again and
never appears in the keys list. The new key appears in that list immediately.

For clients that support a remote Streamable HTTP MCP server with custom headers:

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

Configuration keys vary by client; for example, VS Code's `.vscode/mcp.json` uses `servers`
instead of `mcpServers`.

For Claude Code:

```sh
claude mcp add --transport http hourmere 'https://hourmere.example.com/mcp' \
  --header "Authorization: Bearer hm_…"
```

In these documentation examples, replace `https://hourmere.example.com` with the instance's
`PUBLIC_URL` and `hm_…` with your API key. The endpoint is `<PUBLIC_URL>/mcp`; API keys are
sent as `Authorization: Bearer <key>`. Session cookies do not authenticate MCP.

## Key scopes and tool discovery

`tools/list` includes only tools allowed by the key's scope; `whoami` returns `apiKeyScope`.
A direct call to a known disallowed tool returns `isError: true` with `insufficient_scope`;
unknown tools remain protocol errors. The table below comes from the shared authorization
registry, including each tool's modes and CLI equivalents. Regenerate it with
`node scripts/generate-api-key-scope-docs.ts`.

<!-- api-key-scope-table:start -->

| MCP tool | Mode | CLI command | Allowed key scopes |
| --- | --- | --- | --- |
| `whoami` | — | `whoami` | `full, read, bookings` |
| `find_available_slots` | — | `slots` | `full, read, bookings` |
| `find_available_slots` | `personal` | `slots` | `full, read, bookings` |
| `find_available_slots` | `team` | `slots` | `full, read, bookings` |
| `create_booking` | — | `book` | `full, bookings` |
| `create_booking` | `personal` | `book` | `full, bookings` |
| `create_booking` | `team` | `book` | `full, bookings` |
| `create_booking` | `oneTimeLink` | `book` | `full, bookings` |
| `reschedule_booking` | — | `reschedule` | `full, bookings` |
| `reschedule_booking` | `host` | `reschedule` | `full, bookings` |
| `reschedule_booking` | `manageToken` | `reschedule` | `full, bookings` |
| `cancel_booking` | — | `cancel` | `full, bookings` |
| `cancel_booking` | `host` | `cancel` | `full, bookings` |
| `cancel_booking` | `manageToken` | `cancel` | `full, bookings` |
| `list_bookings` | — | `list` | `full, read, bookings` |
| `retry_conference` | — | `retry-meeting` | `full, bookings` |
| `retry_calendar_copy` | — | `retry-calendar-copy` | `full, bookings` |
| `get_profile` | — | `profile` | `full, read, bookings` |
| `list_event_types` | — | `catalog` | `full, read, bookings` |
| `get_event_type` | — | `event` | `full, read, bookings` |
| `set_event_type_notifications` | — | `set-event-notifications` | `full` |
| `list_schedules` | — | `schedules` | `full, read` |
| `get_schedule` | — | `schedule` | `full, read` |
| `create_event_type` | — | `create-event` | `full` |
| `update_event_type` | — | `update-event` | `full` |
| `create_one_time_link` | — | `one-time-links create` | `full, bookings` |
| `list_one_time_links` | — | `one-time-links list` | `full, read` |
| `revoke_one_time_link` | — | `one-time-links revoke` | `full, bookings` |
| `list_calendar_connections` | — | — | `full, read` |
| `list_conference_connections` | — | — | `full, read` |
| `get_event_type_waitlist` | — | `event-waitlist` | `full, read` |
| `set_event_type_waitlist` | — | `set-event-waitlist` | `full` |
| `list_waitlist_entries` | — | `waitlist-entries` | `full, read` |
| `remove_waitlist_entry` | — | `remove-waitlist-entry` | `full` |
| `join_waitlist` | — | `join-waitlist` | `full, bookings` |
| `join_waitlist` | `personal` | `join-waitlist` | `full, bookings` |
| `join_waitlist` | `team` | `join-waitlist` | `full, bookings` |
| `resend_waitlist_verification` | — | `resend-waitlist-verification` | `full, bookings` |
| `resend_waitlist_verification` | `personal` | `resend-waitlist-verification` | `full, bookings` |
| `resend_waitlist_verification` | `team` | `resend-waitlist-verification` | `full, bookings` |

<!-- api-key-scope-table:end -->

Your existing organization, host and ownership permissions still apply. `read` includes
broader account data than `bookings`, while `bookings` can create, move, cancel and repair
existing authorized bookings. Both can expose existing visible attendee details and ready
meeting links. `full` does not authorize browser-only operations or API key management.
MCP OAuth keeps its existing `mcp:tools` grant rather than adopting these API key scopes.

`create_one_time_link` and `revoke_one_time_link` require a `full` or `bookings` API key
and permission to manage the event type; `read` cannot mint or withdraw links.
`list_one_time_links` accepts `full` or `read` keys. Existing authorized `mcp:tools`
OAuth connections retain scheduling access to all three tools. No new scope or
broader account-configuration permission is introduced.

Create takes `eventTypeId`, a retained random `idempotencyKey`, optional `expiresAt` and
optional `prefill` (`name`, `email`). Its full `/book/{token}` URL is shown only in that
response. Copy it privately now; lists and detail reads cannot recover it. A repeat with
the same key and normalized input returns `one_time_link_already_created`, without
minting another token or recovering the URL; changed input returns `idempotency_key_reused`.
Retention or event deletion can eventually remove the retained idempotency marker.
List takes `eventTypeId` and optional `limit`/`after`; revoke takes `eventTypeId` and `id`
and returns metadata in `link`, or null for unknown/unrelated IDs. Used links retain their
state and consuming booking. See [one-time booking links](https://hourmere.com/docs/one-time-links).

Scope cannot be edited. Create a replacement at `/app/api-keys`, update the client and
revoke the old key; reconnect or refresh tool discovery because clients can cache tools.
Old keys and API creations that omit `metadata.scope` retain `full` compatibility; the
web form explicitly defaults to `bookings`. See the [API key guide](api-keys.md) for the
generated REST table, native boundaries, creation contract and replacement steps.

Before upgrading, stop every old web/all/worker and other old key-authenticating process,
apply migrations and restart every role with the new code before allowing scoped keys.
Do not run old and new servers side by side once scoped keys exist: old servers treat
scoped keys as full access. Use the supported backup/restore procedure for rollback.

## Configure an after-booking redirect

`get_event_type` returns `successRedirect`; `create_event_type` and `update_event_type`
accept the same object or `null` as REST, with `full` API key scope. Omission on update
preserves the setting. See [after-booking redirects](https://hourmere.com/docs/after-booking)
for configuration examples, validation fields, privacy warnings and embed permissions.

## Configure meeting lengths

MCP `create_event_type` and `update_event_type` configure event types with the same
validation and permissions as REST. API keys need `full` scope, not `bookings` or `read`.
`durationMinutes` is the default; `allowedDurationsMinutes` is a list of 1–12
distinct whole-minute lengths from 1 to 1440 inclusive, kept in ascending order, and must
include the default. Supplied lengths are sorted before storage.
Creation requires `slug`, `title` and `durationMinutes`; omitting the list creates
`[durationMinutes]`. Updates take a flat object with `id` beside the changed fields.
See [multiple meeting lengths](https://hourmere.com/docs/multiple-durations) for examples,
update compatibility, invitee selection, rescheduling and shared-rule limits.

## Meeting location choices

Configure an ordered `locations` list through the event-type create/update operations,
and choose `locationOptionId` for slot availability and booking. An invitee-phone option additionally requires
`inviteePhone`, normalized to E.164 after removing common phone separators.
CLI `slots` and `book` accept `locationOptionId` in their JSON input files.
Rescheduling keeps the original choice. See [meeting location choices](https://hourmere.com/docs/location-choices)
for configuration examples, public discovery, compatibility and conference rules.
