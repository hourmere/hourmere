# API keys

API keys let scripts and AI agents use REST, MCP and the CLI as you, in one organization.
Choose a scope to limit what each key can do. Your role, ownership and resource visibility
still apply; a scope grants no additional access.

## Create a scoped key

Sign in to your instance and open **API keys** at `/app/api-keys`. Choose the intended
organization, give the key a recognizable name, choose its scope and optionally set an expiry.

- **Bookings** (`bookings`) is the web form's default, recommended for AI booking agents.
  It can read your profile, visible event types, available slots and bookings you host;
  create, reschedule and cancel bookings; and retry an existing booking's conference or your
  original calendar copy, subject to the existing host checks. It cannot read raw schedules,
  account connections, webhooks or analytics, or change account settings.
- **Read** (`read`) suits analytics and reporting. It can read the existing data you
  can access, including bookings, schedules, analytics and safe integration/webhook metadata,
  but cannot create, move or cancel bookings or change settings.
- **Full account access** (`full`) permits every operation that accepts your API key,
  including account configuration changes and booking actions. Give it only to software you
  trust with that access. Browser-only operations still require a browser session.

These scopes are not a simple ladder: `read` sees more configuration than `bookings`, while
`bookings` can change bookings. Neither scope anonymizes data. Existing visible booking
responses can contain attendee names, email addresses, answers and ready meeting links.
Bookings scope can manage bookings you already host, including ones created with another
key; it is not restricted to bookings that this key created. Booking actions can send normal
notifications and trigger configured integrations.

Copy the full key into your secret store when it is created. The one-time view also explains
the selected scope and provides REST/MCP examples with the instance URL and key filled in.
The full key cannot be retrieved after dismissing the view or leaving the page; the list
shows safe metadata, including the scope. Legacy keys appear as `full`.

The CLI cannot create or revoke keys. Create a scoped key in this web page, then supply it
through `HOURMERE_API_KEY`; `whoami` shows its organization and `apiKeyScope`.

## Replace a key to change scope

A key's scope is immutable. Use its **Create replacement** shortcut to prefill a new key,
choose the scope you need, create it and copy it privately. Update the client to use the
replacement, then revoke the old key. Creating a replacement does not revoke the old key.
The shortcut adds a localized replacement suffix to the name and selects the closest
available expiry period to the original key's lifetime (or **Never** for a non-expiring key).
Review the displayed expiry before creating it. Switching from an unsaved draft asks before
discarding it. After creation, the one-time view links to the old key, whose row keeps a
revocation reminder with its name and key prefix until you revoke it or leave the page.
Reconnect MCP clients or refresh their tool list after switching keys, because clients may
cache the tools they discovered. Switching your active web space does not retarget an
existing key. Native owner-authorized organization metadata updates retain the key's scope.

## API compatibility and errors

Native key creation uses `POST /api/auth/api-key/create` with a signed-in browser session.
Send the scope inside `metadata`, for example:

```json
{
  "name": "Booking agent",
  "metadata": {
    "organizationId": "<organization UUID>",
    "scope": "bookings"
  }
}
```

`metadata.scope` accepts exactly `full`, `read` or `bookings`. For compatibility, omitting
it creates a `full` key, including when metadata is absent or null. The web form explicitly
sends `bookings` by default. A top-level `scope` or `scopes` is invalid, as are arrays,
combined scopes and unknown values (`400 INVALID_METADATA`). Legacy keys were migrated to
`full`; malformed stored scope metadata fails authentication rather than widening access.
Any attempt to include `metadata.scope` in a key update is refused with
`400 API_KEY_SCOPE_IMMUTABLE`, even if the value is unchanged. Create a replacement instead.

Key create/get/list/update/delete routes under `/api/auth/api-key/` require their native
owner session (or trusted server authority); an API key cannot administer keys. Any
`Authorization` header is refused with `403 SESSION_REQUIRED`, even with a session cookie.
Other `/api/auth/*` routes retain their native authentication. MCP OAuth grants retain their
existing `mcp:tools` permission; these API key scopes do not change OAuth access.

A valid key used for a disallowed REST operation gets HTTP **403** with
`{ "error": "insufficient_scope", "message": "This API key does not allow this operation." }`.
Invalid, expired or revoked keys get **401** instead. `Authorization` takes precedence over
cookies and never falls back to them. Public booking and manage-token REST endpoints remain
available without an API key; when one is supplied, it must be valid and allow the operation
in addition to any required manage token. Scope is a limit on that credential, not a sandbox
that removes separate public or management-link capabilities.

MCP `tools/list` includes only tools allowed by the key's scope. A direct `tools/call` for a
known disallowed tool returns a tool error (`isError: true`) with `insufficient_scope`;
unknown tool names remain protocol errors. CLI commands use the same MCP checks and report
`insufficient_scope` on stderr with exit code **1**. Choose an appropriate replacement key
instead of retrying a forbidden action.

## Upgrade safely

Build the new version, stop every old web/all/worker process and any other old process that
can authenticate or write API keys, apply migrations, then start every role with the new
code before creating or using scoped keys. **Do not run old and new servers side by side
once scoped keys exist:** old code treats these keys as full access. Follow the supported
backup/restore procedure for rollback; do not simply restart an old binary against scoped
keys or rewrite them to `full`.

## Operation reference

The tables below are generated from the shared authorization registry in
`packages/auth/src/api-key-operations.ts`. Run `node scripts/generate-api-key-scope-docs.ts`
after changing that registry; a consistency test checks the repository and published copies.
Each listed scope is an additional requirement, never a grant of role or resource access.
“—” means no API key scope authorizes the operation. Public metadata needs no key. For
public booking and manage-token rows, the scope applies only when a bearer key is supplied;
credential-free public and independent manage-token behavior is unchanged. Every MCP mode
is listed explicitly. CLI `--help`, no arguments and `--version` are local and require no key.
New operations require explicit classification; `read` and `bookings` do not gain access
because an endpoint uses GET or a tool advertises itself as read-only.

<!-- api-key-scope-table:start -->

### Operation groups

| Operation group | `full` | `read` | `bookings` |
| --- | --- | --- | --- |
| Other account reads | Allowed | Allowed | — |
| Booking workflow reads | Allowed | Allowed | Allowed |
| Booking actions and repairs | Allowed | — | Allowed |
| Browser session operations | — | — | — |
| Account settings and configuration writes | Allowed | — | — |
| Public instance and API metadata | Allowed | Allowed | Allowed |

### REST operations

| Method and path | Authentication boundary | Allowed key scopes |
| --- | --- | --- |
| `GET /api/v1/analytics/bookings` | Session or API key | `full, read` |
| `GET /api/v1/bookings` | Session or API key | `full, read, bookings` |
| `GET /api/v1/bookings/{id}` | Session or API key | `full, read, bookings` |
| `POST /api/v1/bookings/{id}/calendar-copy/retry` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/cancel` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/conference/retry` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/reschedule` | Session or API key | `full, bookings` |
| `GET /api/v1/bookings/{id}/slots` | Session or API key | `full, read, bookings` |
| `GET /api/v1/bookings/manage` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/bookings/manage/cancel` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/bookings/manage/reschedule` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/bookings/manage/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/calendar-connections` | Session or API key | `full, read` |
| `DELETE /api/v1/calendar-connections/{id}` | Browser session only | — |
| `POST /api/v1/calendar-connections/{id}/refresh` | Session or API key | `full` |
| `POST /api/v1/calendar-connections/google/authorize` | Browser session only | — |
| `POST /api/v1/calendar-connections/microsoft/authorize` | Browser session only | — |
| `PUT /api/v1/calendar-destination` | Session or API key | `full` |
| `PATCH /api/v1/calendars/{id}` | Session or API key | `full` |
| `POST /api/v1/calendars/{id}/sync` | Session or API key | `full` |
| `GET /api/v1/conference-connections` | Session or API key | `full, read` |
| `DELETE /api/v1/conference-connections/{id}` | Browser session only | — |
| `POST /api/v1/conference-connections/{id}/authorize-meetings` | Browser session only | — |
| `POST /api/v1/conference-connections/{id}/reconnect` | Browser session only | — |
| `POST /api/v1/conference-connections/{id}/refresh` | Browser session only | — |
| `POST /api/v1/conference-connections/zoom/authorize` | Browser session only | — |
| `POST /api/v1/conference-connections/zoom/authorize-meetings` | Browser session only | — |
| `GET /api/v1/event-type-hosts` | Session or API key | `full, read` |
| `GET /api/v1/event-types` | Session or API key | `full, read, bookings` |
| `POST /api/v1/event-types` | Session or API key | `full` |
| `GET /api/v1/event-types/{id}` | Session or API key | `full, read, bookings` |
| `DELETE /api/v1/event-types/{id}` | Session or API key | `full` |
| `PATCH /api/v1/event-types/{id}` | Session or API key | `full` |
| `POST /api/v1/event-types/{id}/round-robin/activate` | Session or API key | `full` |
| `GET /api/v1/instance` | Public; no key needed | `full, read, bookings` |
| `GET /api/v1/mcp-oauth/connections` | Browser session only | — |
| `DELETE /api/v1/mcp-oauth/connections/{id}` | Browser session only | — |
| `POST /api/v1/mcp-oauth/consent` | Browser session only | — |
| `POST /api/v1/mcp-oauth/request` | Browser session only | — |
| `POST /api/v1/mcp-oauth/select` | Browser session only | — |
| `GET /api/v1/me` | Session or API key | `full, read, bookings` |
| `GET /api/v1/profile` | Session or API key | `full, read, bookings` |
| `PUT /api/v1/profile` | Session or API key | `full` |
| `PATCH /api/v1/profile/name` | Session or API key | `full` |
| `GET /api/v1/public/{handle}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/{handle}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/{handle}/{slug}/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/public/{handle}/{slug}/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/teams/{handle}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/teams/{handle}/{slug}/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/public/teams/{handle}/{slug}/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/readiness/self` | Browser session only | — |
| `GET /api/v1/schedules` | Session or API key | `full, read` |
| `POST /api/v1/schedules` | Session or API key | `full` |
| `GET /api/v1/schedules/{id}` | Session or API key | `full, read` |
| `DELETE /api/v1/schedules/{id}` | Session or API key | `full` |
| `PATCH /api/v1/schedules/{id}` | Session or API key | `full` |
| `GET /api/v1/schedules/{id}/overrides` | Session or API key | `full, read` |
| `PUT /api/v1/schedules/{id}/overrides/{date}` | Session or API key | `full` |
| `DELETE /api/v1/schedules/{id}/overrides/{date}` | Session or API key | `full` |
| `POST /api/v1/schedules/default` | Session or API key | `full` |
| `GET /api/v1/team/bookings` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/cancel` | Browser session only | — |
| `GET /api/v1/team/invitations` | Browser session only | — |
| `GET /api/v1/team/invitations/{invitationId}` | Browser session only | — |
| `POST /api/v1/team/invitations/{invitationId}/cancel` | Browser session only | — |
| `GET /api/v1/team/member-removals/{operationId}` | Browser session only | — |
| `GET /api/v1/team/members/{memberUserId}/departure-impact` | Browser session only | — |
| `POST /api/v1/team/members/{memberUserId}/removal` | Browser session only | — |
| `GET /api/v1/team/members/{memberUserId}/removal-handling` | Browser session only | — |
| `POST /api/v1/teams/{teamId}/leave` | Browser session only | — |
| `GET /api/v1/teams/{teamId}/member-readiness` | Browser session only | — |
| `GET /api/v1/teams/{teamId}/readiness` | Browser session only | — |
| `GET /api/v1/webhooks` | Session or API key | `full, read` |
| `POST /api/v1/webhooks` | Session or API key | `full` |
| `DELETE /api/v1/webhooks/{id}` | Session or API key | `full` |
| `PATCH /api/v1/webhooks/{id}` | Session or API key | `full` |
| `GET /api/v1/webhooks/{id}/deliveries` | Session or API key | `full, read` |
| `POST /api/v1/webhooks/{id}/rotate-secret` | Session or API key | `full` |
| `GET /api/v1/openapi.json` | Public; no key needed | `full, read, bookings` |

### MCP tools and CLI commands

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
| `list_schedules` | — | `schedules` | `full, read` |
| `get_schedule` | — | `schedule` | `full, read` |
| `list_calendar_connections` | — | — | `full, read` |
| `list_conference_connections` | — | — | `full, read` |

### Native protocol boundaries

These routes keep their own authentication; API key scopes do not authorize them.

| Method and path | Authentication boundary |
| --- | --- |
| `GET /api/health` | Public health check; no key needed |
| `GET /api/calendar/google/callback` | Browser session and bound OAuth state |
| `GET /api/calendar/microsoft/callback` | Browser session and bound OAuth state |
| `GET /api/conference/zoom/callback` | Browser session and bound OAuth state |
| `POST /api/conference/zoom/events` | Provider signature |

<!-- api-key-scope-table:end -->
