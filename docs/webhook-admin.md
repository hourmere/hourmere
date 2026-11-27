# Signed webhook administration design

## Decisions

Add **Webhooks** under **Settings → Integrations** for the current personal or team
space. Keep **Slack booking notifications** separate in the same settings area. The
workflow editor on main already lists eligible signed endpoints for its action picker.
That picker remains a consumer of the endpoint list. The settings design uses the six
existing signed webhook operations for configuration and delivery history. For operator
setup and receiver behavior, see [Booking webhooks](../apps/site/src/content/docs/docs/webhooks.md).

## Existing REST, MCP and CLI operations

| REST | Operation ID | MCP tool | CLI command | API key scope |
|---|---|---|---|---|
| `GET /api/v1/webhooks` | `listWebhooks` | `list_webhooks` | `webhooks list` | `read`, `full` |
| `POST /api/v1/webhooks` | `createWebhook` | `create_webhook` | `webhooks create` | `full` |
| `PATCH /api/v1/webhooks/{id}` | `updateWebhook` | `update_webhook` | `webhooks update` | `full` |
| `DELETE /api/v1/webhooks/{id}` | `deleteWebhook` | `delete_webhook` | `webhooks delete` | `full` |
| `POST /api/v1/webhooks/{id}/rotate-secret` | `rotateWebhookSecret` | `rotate_webhook_secret` | `webhooks rotate-secret` | `full` |
| `GET /api/v1/webhooks/{id}/deliveries` | `listWebhookDeliveries` | `list_webhook_deliveries` | `webhooks deliveries` | `read`, `full` |

The dashboard uses the typed same-origin REST client with the session cookie. REST list
returns an array. MCP and CLI list return `{ data }`. REST delete returns `204 No Content`.
MCP and CLI return `{ deleted: true }`, and the CLI requires `--yes`. Create and rotation
return their secrets in the successful response. CLI callers can choose a new private
`--output` file. See the [MCP webhook guide](mcp.md#manage-booking-webhooks) and
[parity registry](../scripts/interface-parity.json).

## Permissions and space changes

- A verified personal owner manages their personal endpoints. Only verified, current
  owners and admins manage a team's endpoints. Team members, including booking hosts,
  lack this access. Gate navigation and the settings panel on the signed-in space and
  shared team-management state. While authority is loading or cannot be checked, use a
  loading or neutral access state. The server checks live membership for each request.
- Send `X-Expected-Organization-Id` on every dashboard read and write, using the space
  where the view or action opened. REST allows the header to be omitted on reads for
  existing clients and requires it on session writes. Session writes also use the
  existing same-origin check. The header supplies an expectation, and the server checks
  current authority and rechecks context inside the write transaction.
- At the context check, a still-authorized stale team gets `409 organization_context_changed`.
  A write from the caller's own stale personal space gets the same 409. A read expecting a different
  personal space, an inaccessible expected team, or another user's personal space gets
  `403 team_management_access_denied`. A missing or malformed write header gets 409 and
  a malformed read header gets 403. Ordinary members get 403 with the header, or
  `insufficient_role` on legacy headerless reads. For an authorized caller, a missing or
  foreign endpoint ID gets the same `404 webhook_not_found`. Input and operator policy
  checks can reject writes before context is checked.
- REST API keys ignore the browser header and use their bound organization and the scope
  in the table. The `bookings` scope grants no webhook operations. MCP API keys use those
  same scopes. Authorized `mcp:tools` OAuth grants can call the tools with their bound
  organization and the same membership and role checks. The CLI uses MCP with an API key.

## Data and presentation

The existing `webhooks` and `webhook_deliveries` tables hold organization-owned signed
endpoints and their deliveries. Signing secrets are stored as authenticated encrypted
ciphertext. The settings page uses the existing response fields and requires no schema
change. See [Booking webhooks in the data model](data-model.md#booking-webhooks).

| View | Data and behavior |
|---|---|
| Endpoint list and selection | List all endpoints, up to ten per space including paused endpoints. Show destination origin as plain text, an endpoint ID to distinguish entries on the same origin, subscription labels, and the configured state **Enabled** or **Paused**. Open the configuration and history for a selected ID from the loaded list. The metadata also includes `organizationId`, `createdAt` and `updatedAt`. |
| Create | Require a URL and at least one distinct supported event. Start with **Enabled** checked, which matches the default `isActive: true`. Send `{ url, events, isActive }`. Trust server validation for destination policy, including operator-allowed private HTTP(S) destinations. Validation does not verify the receiver. A successful 201 returns `{ webhook, secret }`. |
| Edit subscriptions and pause or resume | Keep the URL read-only. Send only `events` when editing subscriptions and only `isActive` when changing state. A pause-only update stays available after the operator revokes a destination. An accepted update returns fresh endpoint metadata. An in-flight attempt can finish before a pause takes effect. Skipped deliveries stay skipped after resuming. |
| Rotate signing secret | Confirm the hard switch before submitting. Prepare the receiver to install the new secret immediately. Every subsequent attempt, including a retry of an older delivery, uses the new secret. The response is `{ secret }`. The server signs each attempt with one secret and offers no grace period. |
| Delete | Confirm the selected endpoint and the permanent loss of its retained history. After 204, close the selection and refresh the list. Old queued jobs safely skip. Workflows reference the endpoint ID, so creating a replacement does not repoint them. |
| Delivery history | Fetch on opening history. Show event type, status, attempt count, HTTP status and safe error labels when present, with localized timestamps. The whitelist is `id`, `eventId`, `eventType`, `bookingId`, `status`, `attempts`, `httpStatus`, `lastError`, `createdAt`, `lastAttemptAt`, `deliveredAt`. Include IDs as text where useful for diagnosis. The booking ID is a required UUID, including for workflow deliveries. History contains no payloads, response bodies, signatures, headers or secrets. |

The event choices are `booking.created`, `booking.rescheduled`, `booking.cancelled`,
`booking.reschedule_requested`, `booking.reschedule_request_expired`,
`booking.attendee_no_show_changed` and `workflow.executed`. Use the existing instance
metadata at `GET /api/v1/instance` to offer **adding** the workflow kind only when
`workflowsEnabled` is true. A failed metadata request leaves workflow availability
unknown. A stored workflow subscription remains visible and can be kept or removed
even while workflows are off. On creation, adding it while workflows are off returns
`workflows_disabled` before destination policy or `webhooks_disabled`. Event enums in
responses are open. Show a neutral label for an unknown kind. If a stored subscription
contains one, keep subscription editing unavailable until the client understands all
the saved kinds. Pause and resume omit `events` and preserve the stored list.

History shows up to 50 entries per page from the last 30 elapsed days, newest first by
delivery ID. Start without `after`. Offer **Load older deliveries** with the returned
`nextAfter` as `after` until it is null. Append within the selected endpoint and reset
the cursor on endpoint change or refresh. A pending delivery can already have a failed
attempt. Use `status` as the outcome and distinguish `pending`, `delivered`, `failed`
and `skipped`. Show a neutral fallback for unrecognized error codes and a placeholder
for null metadata. An empty successful first page reports no retained deliveries in the
window.

### Browser handling

Keep data and pending actions scoped to the current account, opening organization and
selection. Use `cache: 'no-store'` for webhook requests. Abort obsolete reads and ignore
late results after an observed context change. On return to a backgrounded tab, wait
for session refresh before revealing a secret from a pending response. Clear rows,
cursors, drafts, confirmations and any revealed secret when the account or space
changes or when access is denied. Treat a returned endpoint with a different
`organizationId` as a context failure. Shared
session handling covers expiry. A context conflict requires a deliberate reload and
fresh confirmation of any action in the resulting space.

Show the secret from create or rotation once in a short-lived view with an explicit
**Copy signing secret** action and selectable text. Clear it on dismiss, navigation,
access loss or space change. Keep secrets and full destination URLs out of persistent
client state, browser history, telemetry, logs, and error details. URL paths and
queries can contain credentials. Limit full URL display to the create input while
editing. Render saved origins without clickable receiver links. Do not connect to the
receiver from the browser.

Use existing settings panels, a stacked layout on narrow screens and existing focus
and form conventions. Confirm rotation and deletion with named controls and return
focus to the invoking control or the list heading if it was removed. Use text for
status and announce loading, save outcomes and history pagination. Add all labels and
error copy to both admin catalogues at implementation. The initial copy includes these labels.

| English | 简体中文 |
|---|---|
| Webhooks | Webhook |
| No webhook endpoints yet. | 尚未添加 Webhook 端点。 |
| Webhook endpoints are unavailable. | 当前无法访问 Webhook 端点。 |
| Copy signing secret | 复制签名密钥 |
| Load older deliveries | 加载更早的投递记录 |
| No deliveries retained in the last 30 days. | 最近 30 天没有保留的投递记录。 |

## Failure and recovery

| Server outcome | Dashboard behavior |
|---|---|
| Loading, transport failure, or general read error | Show loading or a neutral read error and a read retry action. Show empty states only after a successful empty response. |
| `401 unauthorized`, `403 team_management_access_denied` or `403 insufficient_role` | Apply the existing sign-in or access state and clear the affected workspace data and actions. |
| `409 organization_context_changed` | Stop the action and show the shared context conflict with reload. A late response for the prior space cannot reopen the view or reveal its secret. |
| `404 webhook_not_found` | Close the stale endpoint and reload its space's list. Use the same message for a deleted endpoint or an ID outside the space. |
| `404 workflows_disabled` | Explain the workflow subscription constraint, refresh instance metadata and preserve the user's other choices while still in the same authorized space. |
| `409 webhooks_disabled` | Explain that creation or rotation is unavailable on this instance. Existing reads, updates subject to policy, and deletion remain available. `isActive` describes the endpoint configuration and provides no instance or receiver health signal. |
| `409 webhook_limit_reached` | Refresh the list and explain the ten-endpoint limit. Pausing an endpoint leaves it in the count. |
| `400 invalid_webhook` or `400 invalid_request` | Keep the authorized draft and show localized validation guidance. Use stable error codes and avoid echoing the destination or raw diagnostics. |
| `400 invalid_cursor` | Clear the cursor and offer to reload history from the first page. |
| Write outcome unknown | Prevent concurrent submissions in the view and avoid automatic resubmission. Reload the list and reconcile before a fresh action. Create can have committed without returning a secret. Require the user to confirm the intended endpoint by ID before a new, explicit rotation because multiple endpoints can share a URL. An uncertain rotation may already have replaced the old secret. |

## API gaps outside this design

| Missing signed webhook capability | Existing behavior the dashboard can use |
|---|---|
| Single-endpoint GET | Select the endpoint in the bounded list. |
| Test send or reachability probe | Trigger a subscribed booking event in an authorized test space and inspect delivery history. The Slack sample operation applies to Slack only. |
| Manual retry or replay | Delivery workers handle automatic retries. History is read-only. |
| Destination URL update | Create a separate replacement endpoint, coordinate the receiver and any workflow references, and explicitly retire the previous endpoint. |
| Read back a signing secret or stage a rotation with dual signing | Store the one-time response in the receiver's secret store. A fresh rotation replaces the current secret. |
| Instance webhook capability or health discovery | Render the last confirmed endpoint state and handle `webhooks_disabled` on create or rotate. Instance metadata only helps with the workflow event option. |
| Per-delivery payload, response body or attempt trace | Render the existing bounded metadata. |
| Check for dependent workflows as part of a webhook action | Warn that workflow actions reference endpoint IDs. Replacement and deletion require explicit coordination. |

## Test plan for implementation

- Exercise personal owner and team owner/admin paths, plus member denial, demotion,
  session expiry and space switching in another tab. Verify the opening header on all
  six operations. For late list, history, create and rotate responses, verify that the
  client discards previous-space metadata and secrets once it observes space or access
  changes. Verify the tab-return refresh before disclosing a pending secret.
  Use the existing real Postgres
  [context](../apps/server/src/webhook-context.test.ts) and
  [REST](../apps/server/src/routes/webhooks.test.ts) tests for server authority.
- Cover list and history loading, empty and error states, pagination resets, optional
  metadata and unknown event types. Cover disabled workflows, kept or removed existing
  workflow subscriptions, full capacity and revoked destination policy. Check that
  pause writes only `{ isActive: false }` and delete and rotation confirm exactly one
  request. Exercise ambiguous create or rotation responses without automatic retries.
- Use synthetic data and fake delivery transport. Verify one-time secret cleanup and
  that no credential-bearing path or query is shown in list, history, errors or browser
  artifacts. Run keyboard and responsive checks in light and dark, English and
  Simplified Chinese. Verify clear focus and announcements, including after delete.
- Keep the [interface parity guard](../scripts/interface-parity.test.ts) and existing
  [MCP](../apps/server/src/mcp/webhooks.test.ts) and [CLI](../tools/cli/src/webhooks.test.ts)
  coverage. The design's [doc-fact test](../scripts/webhook-admin-doc-facts.test.ts)
  binds the operation table to the registered interfaces and API key scopes.

## One-day implementation steps

| Step | Depends on | Acceptance for that day |
|---|---|---|
| Settings entry and list | Accepted design | Personal owners and team owners/admins can open the page and inspect configured endpoints in their current space. Denied, stale and unknown access states disclose no endpoint data. |
| Configuration and one-time secrets | Settings entry and list | Create, edit subscriptions, pause/resume, rotate and delete use the existing session APIs. Confirm destructive actions and exercise one-time disclosure, ambiguous writes and context loss. |
| Delivery history and browser checks | Settings entry and list, Configuration and one-time secrets | Read bounded history and load older entries. Verify context isolation, keyboard and narrow-screen behavior in both locales, and update the user-facing Webhook guide for the shipped UI. |
