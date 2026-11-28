---
title: API keys
description: Choose and replace scoped API keys for REST, MCP and the CLI.
---

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

Routing operations return `routing_forms_disabled` while routing is off.
Routing is on by default. Self-hosted operators can turn it off by setting
`ROUTING_FORMS_ENABLED=false` and restarting the server. While off, the tables still
list routing operations and MCP discovery omits the dedicated routing tools. Form management requires
the personal owner or a current team owner or admin in addition to the listed key scope.
See [routing credentials and examples](/docs/routing-forms-api#availability-and-credentials).

Team booking bulk cancellation preview, confirmation and status return 404 until release.

<!-- api-key-scope-table:start -->

### Operation groups

| Operation group | `full` | `read` | `bookings` |
| --- | --- | --- | --- |
| Booking actions and repairs | Allowed | — | Allowed |
| Booking workflow reads | Allowed | Allowed | Allowed |
| Other account reads | Allowed | Allowed | — |
| Account settings and configuration writes | Allowed | — | — |
| Browser session operations | — | — | — |
| Audit log reads | Allowed | — | — |
| Availability diagnostics | Allowed | — | — |
| Public instance and API metadata | Allowed | Allowed | Allowed |

### REST operations

| Method and path | Authentication boundary | Allowed key scopes |
| --- | --- | --- |
| `POST /api/v1/meeting-polls` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/invitations` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/invitations/{voterId}/resend` | Session or API key | `full, bookings` |
| `DELETE /api/v1/meeting-polls/{id}/voters/{voterId}` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/remove-unverified` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/rotate-link` | Session or API key | `full, bookings` |
| `GET /api/v1/meeting-polls` | Session or API key | `full, read, bookings` |
| `GET /api/v1/meeting-polls/{id}` | Session or API key | `full, read, bookings` |
| `GET /api/v1/meeting-polls/{id}/results` | Session or API key | `full, read, bookings` |
| `POST /api/v1/meeting-polls/{id}/close` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/cancel` | Session or API key | `full, bookings` |
| `DELETE /api/v1/meeting-polls/{id}` | Session or API key | `full, bookings` |
| `POST /api/v1/meeting-polls/{id}/finalize` | Session or API key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/read` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/meeting-polls/enroll` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/recover` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/verify` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/vote` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/withdraw` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/meeting-polls/reminder-opt-out` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/booking-handoffs/offer` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/booking-handoffs/answer` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/analytics/bookings` | Session or API key | `full, read` |
| `GET /api/v1/routing-forms` | Session or API key | `full, read` |
| `GET /api/v1/routing-forms/{id}` | Session or API key | `full, read` |
| `POST /api/v1/routing-forms` | Session or API key | `full` |
| `PATCH /api/v1/routing-forms/{id}` | Session or API key | `full` |
| `DELETE /api/v1/routing-forms/{id}` | Session or API key | `full` |
| `POST /api/v1/routing-forms/{id}/publish` | Session or API key | `full` |
| `POST /api/v1/routing-forms/{id}/preview` | Session or API key | `full` |
| `GET /api/v1/organizations/{organizationId}/provisioning-tokens` | Browser session only | — |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens` | Browser session only | — |
| `POST /api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate` | Browser session only | — |
| `DELETE /api/v1/organizations/{organizationId}/provisioning-tokens/{id}` | Browser session only | — |
| `GET /api/v1/audit-events` | Session or API key | `full` |
| `GET /api/v1/audit-log/settings` | Session or API key | `full` |
| `PUT /api/v1/audit-log/settings` | Session or API key | `full` |
| `GET /api/v1/branding` | Session or API key | `full, read` |
| `GET /api/v1/branding/logo/{hash}` | Session or API key | `full, read` |
| `PATCH /api/v1/branding` | Session or API key | `full` |
| `POST /api/v1/branding/logo` | Session or API key | `full` |
| `GET /api/v1/book/{token}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/book/{token}/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/book/{token}/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/bookings/{id}/attendees` | Session or API key | `full, read, bookings` |
| `GET /api/v1/group-occurrences/{id}/attendees` | Session or API key | `full, read, bookings` |
| `POST /api/v1/group-occurrences/{id}/cancel` | Session or API key | `full, bookings` |
| `GET /api/v1/bookings` | Session or API key | `full, read, bookings` |
| `GET /api/v1/bookings/export.csv` | Session or API key | `full, read` |
| `GET /api/v1/bookings/{id}` | Session or API key | `full, read, bookings` |
| `GET /api/v1/bookings/{id}/organization` | Browser session only | — |
| `POST /api/v1/bookings/{id}/calendar-copy/retry` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/cancel` | Session or API key | `full, bookings` |
| `PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/conference/retry` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/reschedule` | Session or API key | `full, bookings` |
| `POST /api/v1/bookings/{id}/request-reschedule` | Session or API key | `full, bookings` |
| `GET /api/v1/bookings/{id}/slots` | Session or API key | `full, read, bookings` |
| `GET /api/v1/bookings/manage` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/bookings/manage/cancel` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/bookings/manage/reschedule` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/bookings/manage/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/calendar-connections` | Session or API key | `full, read` |
| `DELETE /api/v1/calendar-connections/{id}` | Browser session only | — |
| `POST /api/v1/calendar-connections/{id}/refresh` | Session or API key | `full` |
| `POST /api/v1/calendar-connections/caldav/discover` | Browser session only | — |
| `POST /api/v1/calendar-connections/caldav` | Browser session only | — |
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
| `PUT /api/v1/event-types/{id}/notifications` | Session or API key | `full` |
| `GET /api/v1/event-types/{id}/waitlist` | Session or API key | `full, read` |
| `PUT /api/v1/event-types/{id}/waitlist` | Session or API key | `full` |
| `GET /api/v1/event-types/{id}/waitlist/entries` | Session or API key | `full, read` |
| `DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}` | Session or API key | `full` |
| `POST /api/v1/open-time-snippets` | Session or API key | `full, read, bookings` |
| `GET /api/v1/event-types/{id}/availability-troubleshooting` | Session or API key | `full` |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links` | Session or API key | `full, read` |
| `POST /api/v1/event-types/{eventTypeId}/one-time-links` | Session or API key | `full, bookings` |
| `GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Session or API key | `full, read` |
| `DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}` | Session or API key | `full, bookings` |
| `POST /api/v1/event-types/{id}/duplicate` | Session or API key | `full` |
| `POST /api/v1/event-types/{id}/round-robin/activate` | Session or API key | `full` |
| `GET /api/v1/instance` | Public; no key needed | `full, read, bookings` |
| `GET /api/v1/instance/embed` | Browser session only | — |
| `GET /api/v1/mcp-oauth/connections` | Browser session only | — |
| `DELETE /api/v1/mcp-oauth/connections/{id}` | Browser session only | — |
| `POST /api/v1/mcp-oauth/consent` | Browser session only | — |
| `POST /api/v1/mcp-oauth/request` | Browser session only | — |
| `POST /api/v1/mcp-oauth/select` | Browser session only | — |
| `GET /api/v1/me` | Session or API key | `full, read, bookings` |
| `GET /api/v1/profile` | Session or API key | `full, read, bookings` |
| `PUT /api/v1/profile` | Session or API key | `full` |
| `PATCH /api/v1/profile/name` | Session or API key | `full` |
| `GET /api/v1/public/branding/{organizationId}/logo/{hash}` | Public; no key needed | `full, read, bookings` |
| `GET /api/v1/public/{handle}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/-/routing/{handle}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/-/routing/teams/{teamSlug}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/-/routing/{handle}/{slug}/route` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/-/routing/teams/{teamSlug}/{slug}/route` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/public/{handle}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/routing-continuations/resolve` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/routing-continuations/slots` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/routing-continuations/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/{handle}/{slug}/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/{handle}/{slug}/checkout` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/checkout/status` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/checkout/cancel` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/public/{handle}/{slug}/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/teams/{handle}/{slug}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `GET /api/v1/public/teams/{handle}` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/teams/{handle}/{slug}/bookings` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/public/teams/{handle}/{slug}/slots` | Public or manage token; check a supplied key | `full, read, bookings` |
| `POST /api/v1/public/{handle}/{slug}/waitlist` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/{handle}/{slug}/waitlist/resend` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/teams/{handle}/{slug}/waitlist` | Public or manage token; check a supplied key | `full, bookings` |
| `POST /api/v1/public/teams/{handle}/{slug}/waitlist/resend` | Public or manage token; check a supplied key | `full, bookings` |
| `GET /api/v1/readiness/self` | Browser session only | — |
| `GET /api/v1/schedules` | Session or API key | `full, read` |
| `POST /api/v1/schedules` | Session or API key | `full` |
| `GET /api/v1/schedules/{id}` | Session or API key | `full, read` |
| `GET /api/v1/schedules/{id}/availability` | Session or API key | `full, read` |
| `PUT /api/v1/schedules/{id}/availability` | Session or API key | `full` |
| `DELETE /api/v1/schedules/{id}` | Session or API key | `full` |
| `PATCH /api/v1/schedules/{id}` | Session or API key | `full` |
| `GET /api/v1/schedules/{id}/overrides` | Session or API key | `full, read` |
| `PUT /api/v1/schedules/{id}/overrides/{date}` | Session or API key | `full` |
| `DELETE /api/v1/schedules/{id}/overrides/{date}` | Session or API key | `full` |
| `POST /api/v1/schedules/default` | Session or API key | `full` |
| `GET /api/v1/team/bookings` | Browser session only | — |
| `GET /api/v1/team/bookings/{id}` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/cancel` | Browser session only | — |
| `GET /api/v1/team/bookings/{id}/handoff-preview` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/handoff-offers` | Browser session only | — |
| `GET /api/v1/team/bookings/{id}/handoff-offers/{offerId}` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/withdraw` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/resend` | Browser session only | — |
| `POST /api/v1/team/bookings/{id}/handoff-offers/{offerId}/apply` | Browser session only | — |
| `POST /api/v1/team/bookings/bulk-cancellations/preview` | Browser session only | — |
| `POST /api/v1/team/bookings/bulk-cancellations/{id}/confirm` | Browser session only | — |
| `GET /api/v1/team/bookings/bulk-cancellations/{id}` | Browser session only | — |
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
| `GET /api/v1/slack-destinations` | Session or API key | `full, read` |
| `POST /api/v1/slack-destinations` | Session or API key | `full` |
| `PATCH /api/v1/slack-destinations/{id}` | Session or API key | `full` |
| `DELETE /api/v1/slack-destinations/{id}` | Session or API key | `full` |
| `POST /api/v1/slack-destinations/{id}/test` | Session or API key | `full` |
| `GET /api/v1/webhooks` | Session or API key | `full, read` |
| `POST /api/v1/webhooks` | Session or API key | `full` |
| `DELETE /api/v1/webhooks/{id}` | Session or API key | `full` |
| `PATCH /api/v1/webhooks/{id}` | Session or API key | `full` |
| `GET /api/v1/webhooks/{id}/deliveries` | Session or API key | `full, read` |
| `POST /api/v1/webhooks/{id}/rotate-secret` | Session or API key | `full` |
| `DELETE /api/v1/workflows/{id}` | Session or API key | `full` |
| `PATCH /api/v1/workflows/{id}` | Session or API key | `full` |
| `POST /api/v1/workflows` | Session or API key | `full` |
| `POST /api/v1/workflows/preview` | Session or API key | `full` |
| `GET /api/v1/workflows` | Session or API key | `full, read` |
| `GET /api/v1/workflows/{id}` | Session or API key | `full, read` |
| `GET /api/v1/workflows/{id}/runs` | Session or API key | `full, read` |
| `POST /api/v1/team/sso/domains` | Browser session only | — |
| `POST /api/v1/team/sso/domains/{domainId}/verify` | Browser session only | — |
| `DELETE /api/v1/team/sso/domains/{domainId}` | Browser session only | — |
| `POST /api/v1/team/sso/providers` | Browser session only | — |
| `PATCH /api/v1/team/sso/providers/{providerId}` | Browser session only | — |
| `DELETE /api/v1/team/sso/providers/{providerId}` | Browser session only | — |
| `POST /api/v1/team/sso/providers/{providerId}/test` | Browser session only | — |
| `POST /api/v1/team/sso/providers/{providerId}/activation` | Browser session only | — |
| `POST /api/v1/team/sso/providers/{providerId}/link` | Browser session only | — |
| `DELETE /api/v1/team/sso/providers/{providerId}/link` | Browser session only | — |
| `DELETE /api/v1/team/sso/providers/{providerId}/links/{linkId}` | Browser session only | — |
| `POST /api/v1/team/sso/delegations` | Browser session only | — |
| `DELETE /api/v1/team/sso/delegations/{bindingId}` | Browser session only | — |
| `POST /api/v1/team/sso/recovery` | Browser session only | — |
| `POST /api/v1/team/sso/recovery/{enrollmentId}/accept` | Browser session only | — |
| `POST /api/v1/team/sso/recovery/use` | Browser session only | — |
| `GET /api/v1/team/sso/providers` | Session or API key | `full, read` |
| `GET /api/v1/team/sso/policy` | Session or API key | `full, read` |
| `PUT /api/v1/team/sso/policy` | Browser session only | — |
| `GET /api/v1/openapi.json` | Public; no key needed | `full, read, bookings` |

### MCP tools and CLI commands

| MCP tool | Mode | CLI command | Allowed key scopes |
| --- | --- | --- | --- |
| `create_meeting_poll` | — | `polls create` | `full, bookings` |
| `invite_meeting_poll_voters` | — | `polls invite` | `full, bookings` |
| `resend_meeting_poll_invitation` | — | `polls resend-invitation` | `full, bookings` |
| `remove_meeting_poll_voter` | — | `polls remove-voter` | `full, bookings` |
| `remove_unverified_meeting_poll_voters` | — | `polls remove-unverified` | `full, bookings` |
| `rotate_meeting_poll_link` | — | `polls rotate-link` | `full, bookings` |
| `list_meeting_polls` | — | `polls list` | `full, read, bookings` |
| `get_meeting_poll` | — | `polls get` | `full, read, bookings` |
| `get_meeting_poll_results` | — | `polls results` | `full, read, bookings` |
| `close_meeting_poll` | — | `polls close` | `full, bookings` |
| `cancel_meeting_poll` | — | `polls cancel` | `full, bookings` |
| `delete_meeting_poll` | — | `polls delete` | `full, bookings` |
| `finalize_meeting_poll` | — | `polls finalize` | `full, bookings` |
| `read_meeting_poll` | — | `polls view` | `full, read, bookings` |
| `enroll_meeting_poll_voter` | — | `polls join` | `full, bookings` |
| `recover_meeting_poll_voter` | — | `polls recover` | `full, bookings` |
| `verify_meeting_poll_voter` | — | `polls verify` | `full, bookings` |
| `submit_meeting_poll_vote` | — | `polls vote` | `full, bookings` |
| `withdraw_meeting_poll_vote` | — | `polls withdraw` | `full, bookings` |
| `opt_out_meeting_poll_reminder` | — | `polls reminder-opt-out` | `full, bookings` |
| `read_booking_handoff_offer` | — | `booking-handoff offer` | `full, read, bookings` |
| `answer_booking_handoff_offer` | — | `booking-handoff answer` | `full, bookings` |
| `list_routing_forms` | — | `routing-forms list` | `full, read` |
| `get_routing_form` | — | `routing-forms get` | `full, read` |
| `create_routing_form` | — | `routing-forms create` | `full` |
| `update_routing_form` | — | `routing-forms update` | `full` |
| `archive_routing_form` | — | `routing-forms archive` | `full` |
| `publish_routing_form` | — | `routing-forms publish` | `full` |
| `preview_routing_form` | — | `routing-forms preview` | `full` |
| `get_public_routing_form` | — | `routing-forms public` | `full, read, bookings` |
| `get_public_team` | — | `team-home` | `full, read, bookings` |
| `route_lead` | — | `routing-forms route` | `full, bookings` |
| `resolve_routing_continuation` | — | `routing-forms resolve` | `full, bookings` |
| `find_routed_slots` | — | `routing-forms slots` | `full, bookings` |
| `list_audit_events` | — | `audit-log list` | `full` |
| `get_audit_log_settings` | — | `audit-log settings` | `full` |
| `set_audit_log_settings` | — | `audit-log set-retention` | `full` |
| `get_branding` | — | `branding get` | `full, read` |
| `set_branding` | — | `branding set` | `full` |
| `list_slack_destinations` | — | `slack list` | `full, read` |
| `create_slack_destination` | — | `slack create` | `full` |
| `update_slack_destination` | — | `slack update` | `full` |
| `delete_slack_destination` | — | `slack delete` | `full` |
| `test_slack_destination` | — | `slack test` | `full` |
| `list_webhooks` | — | `webhooks list` | `full, read` |
| `create_webhook` | — | `webhooks create` | `full` |
| `update_webhook` | — | `webhooks update` | `full` |
| `delete_webhook` | — | `webhooks delete` | `full` |
| `rotate_webhook_secret` | — | `webhooks rotate-secret` | `full` |
| `list_webhook_deliveries` | — | `webhooks deliveries` | `full, read` |
| `whoami` | — | `whoami` | `full, read, bookings` |
| `find_available_slots` | — | `slots` | `full, read, bookings` |
| `find_available_slots` | `personal` | `slots` | `full, read, bookings` |
| `find_available_slots` | `team` | `slots` | `full, read, bookings` |
| `create_booking` | — | `book` | `full, bookings` |
| `create_booking` | `personal` | `book` | `full, bookings` |
| `create_booking` | `team` | `book` | `full, bookings` |
| `create_booking` | `oneTimeLink` | `book` | `full, bookings` |
| `create_booking` | `routed` | `book` | `full, bookings` |
| `request_reschedule` | — | `request-reschedule` | `full, bookings` |
| `reschedule_booking` | — | `reschedule` | `full, bookings` |
| `reschedule_booking` | `host` | `reschedule` | `full, bookings` |
| `reschedule_booking` | `manageToken` | `reschedule` | `full, bookings` |
| `cancel_booking` | — | `cancel` | `full, bookings` |
| `cancel_booking` | `host` | `cancel` | `full, bookings` |
| `cancel_booking` | `manageToken` | `cancel` | `full, bookings` |
| `list_bookings` | — | `list` | `full, read, bookings` |
| `get_booking` | — | `booking` | `full, read, bookings` |
| `set_attendee_no_show` | — | `set-no-show` | `full, bookings` |
| `get_booking_attendees` | — | `booking-attendees` | `full, read, bookings` |
| `get_group_occurrence_attendees` | — | `group-attendees` | `full, read, bookings` |
| `cancel_group_occurrence` | — | `cancel-group` | `full, bookings` |
| `export_bookings` | — | `export` | `full, read` |
| `get_booking_activity` | — | `booking-activity` | `full, read` |
| `retry_conference` | — | `retry-meeting` | `full, bookings` |
| `retry_calendar_copy` | — | `retry-calendar-copy` | `full, bookings` |
| `get_profile` | — | `profile` | `full, read, bookings` |
| `list_event_types` | — | `catalog` | `full, read, bookings` |
| `get_event_type` | — | `event` | `full, read, bookings` |
| `set_event_type_notifications` | — | `set-event-notifications` | `full` |
| `list_schedules` | — | `schedules` | `full, read` |
| `get_schedule` | — | `schedule` | `full, read` |
| `get_schedule_availability` | — | `schedule-availability` | `full, read` |
| `save_schedule_availability` | — | `save-availability` | `full` |
| `duplicate_event_type` | — | `duplicate-event` | `full` |
| `create_event_type` | — | `create-event` | `full` |
| `update_event_type` | — | `update-event` | `full` |
| `generate_open_time_snippet` | — | `open-time-snippet` | `full, read, bookings` |
| `troubleshoot_availability` | — | `troubleshoot-availability` | `full` |
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
| `delete_workflow` | — | `workflows delete` | `full` |
| `preview_workflow` | — | `workflows preview` | `full` |
| `update_workflow` | — | `workflows update` | `full` |
| `create_workflow` | — | `workflows create` | `full` |
| `list_sso_providers` | — | `sso providers list` | `full, read` |
| `get_sso_policy` | — | `sso policy` | `full, read` |
| `list_workflows` | — | `workflows list` | `full, read` |
| `get_workflow` | — | `workflows get` | `full, read` |
| `list_workflow_runs` | — | `workflows runs` | `full, read` |

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

OIDC and SAML single sign-on are on by default. The operator can turn either protocol
off with `SSO_OIDC_ENABLED=false` or `SSO_SAML_ENABLED=false`. Requests that add trust
through a disabled protocol return `404 sso_disabled`, including sign-in, linking, provider
setup and delegation binding. Domain setup, just-in-time admission and recovery enrollment
require at least one enabled protocol. A team needs a usable provider on an enabled
protocol to start requiring SSO. The reads `list_sso_providers` and `get_sso_policy`
(CLI `sso providers list` / `sso policy`) remain available to team owners and administrators.
Stored enforcement still applies. Turning a protocol off suspends its existing proofs and
delegations. Re-enabling it restores their use before the original deadline if they still
meet the other validity checks. Machine reads without a usable delegation on an enforced
team return `sso_required`. Enrolled owners can use browser recovery, and trust-reducing
operations retain their usual authorization and proof requirements.

OIDC 和 SAML 单点登录默认开启。运营者可设置 `SSO_OIDC_ENABLED=false` 或
`SSO_SAML_ENABLED=false` 来关闭对应协议。通过已关闭协议增加信任的请求（如登录、关联、配置身份提供方和绑定
委托）返回 `404 sso_disabled`。设置域名、即时入组和恢复登记需要至少启用一种协议；开启强制单点
登录需要该协议上有可用的身份提供方。上述两个读取操作对团队所有者和管理员保持可用。已保存的
强制要求继续生效。关闭协议会暂停其证明和委托，在原到期时间前重新启用且证明或委托仍有效时
可以恢复使用。通过机器客户端读取已强制 SSO 的团队时仍需有效委托，否则返回 `sso_required`。
已登记的所有者可通过浏览器恢复，降低信任的操作仍需通过原有的权限和证明验证。

Booking workflow reads (`GET /api/v1/workflows`, `GET /api/v1/workflows/{id}` and
`GET /api/v1/workflows/{id}/runs`) require a `read` or `full` key and remain available
while workflows are off. Disabling a workflow without other edits and deleting it
also remain available with a `full` key. Ownership and current team roles still apply.
While workflows are off, `tools/list` omits the workflow tools.

Creation, synthetic preview (`POST /api/v1/workflows/preview`), enabling and other edits
require a `full` key and return `404 workflows_disabled` while workflows are off. A key
whose scope does not allow a workflow operation still gets `insufficient_scope` first.

中文：工作流关闭时，有权限的调用者仍可使用 `read` 或 `full` 密钥读取工作流和执行历史，
使用 `full` 密钥仅停用工作流或删除工作流。创建、合成预览、启用及其他修改返回
`404 workflows_disabled`。MCP 工具列表隐藏工作流工具。

CSV export through API keys is limited to the owner's personal organization (`read` or
`full`). Team-wide CSV exports retain the existing browser-session-only team-admin access
and field rules; a team key, even an owner's `full` key, receives
`team_management_access_denied`. See [CSV booking export](https://hourmere.com/docs/booking-export).
