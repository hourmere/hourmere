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
| `list_calendar_connections` | — | — | `full, read` |
| `list_conference_connections` | — | — | `full, read` |

<!-- api-key-scope-table:end -->

Your existing organization, host and ownership permissions still apply. `read` includes
broader account data than `bookings`, while `bookings` can create, move, cancel and repair
existing authorized bookings. Both can expose existing visible attendee details and ready
meeting links. `full` does not authorize browser-only operations or API key management.
MCP OAuth keeps its existing `mcp:tools` grant rather than adopting these API key scopes.

Scope cannot be edited. Create a replacement at `/app/api-keys`, update the client and
revoke the old key; reconnect or refresh tool discovery because clients can cache tools.
Old keys and API creations that omit `metadata.scope` retain `full` compatibility; the
web form explicitly defaults to `bookings`. See the [API key guide](api-keys.md) for the
generated REST table, native boundaries, creation contract and replacement steps.

Before upgrading, stop every old web/all/worker and other old key-authenticating process,
apply migrations and restart every role with the new code before allowing scoped keys.
Do not run old and new servers side by side once scoped keys exist: old servers treat
scoped keys as full access. Use the supported backup/restore procedure for rollback.
