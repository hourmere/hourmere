---
title: MCP quickstart
description: Connect an AI client to Hourmere's remote MCP server using an API key or OAuth.
---

For `create_one_time_link`, `list_one_time_links` and `revoke_one_time_link`, see
[one-time booking links](/docs/one-time-links). Creation returns a private URL once;
list results never contain its token or hash. Create/revoke require a `bookings` or `full` API key;
listing requires `read` or `full`. Existing OAuth `mcp:tools` grants can use all three tools
within the account’s organization and event-type permissions.

## Connect a client

Create an API key at `/app/api-keys` on your [instance](/docs/self-hosting). Choose
**Bookings** (`bookings`, the default) for AI booking agents, **Read** (`read`) for analytics
and reporting, or **Full account access** (`full`) only for software you trust with account
configuration changes. The one-time view explains the key's scope and what the agent can do,
and provides copy buttons for the key, a curl example, a JSON client config
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

## API key scopes

`tools/list` includes only tools allowed by the key's scope. `whoami` returns `apiKeyScope`
alongside the user and organization. Calling a known disallowed tool directly returns
`isError: true` with `insufficient_scope`; unknown tools remain protocol errors. Clients may
cache discovery: reconnect or refresh the tool list after switching keys.

The table is generated from the shared authorization registry, including each mode and CLI
equivalent. Your current role, organization, ownership and host restrictions still apply.
`bookings` can manage bookings you already host, including ones created by other keys;
`read` sees broader account data but cannot change bookings. Neither removes existing
visible attendee details, answers or ready meeting links. Normal booking actions can send
notifications and trigger configured integrations.

Routing operations return `routing_forms_disabled` until an operator enables routing.

<!-- api-key-scope-table:start -->

| MCP tool | Mode | CLI command | Allowed key scopes |
| --- | --- | --- | --- |
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
| `list_routing_forms` | — | `routing-forms list` | `full, read` |
| `get_routing_form` | — | `routing-forms get` | `full, read` |
| `create_routing_form` | — | `routing-forms create` | `full` |
| `update_routing_form` | — | `routing-forms update` | `full` |
| `archive_routing_form` | — | `routing-forms archive` | `full` |
| `publish_routing_form` | — | `routing-forms publish` | `full` |
| `preview_routing_form` | — | `routing-forms preview` | `full` |
| `get_public_routing_form` | — | `routing-forms public` | `full, read, bookings` |
| `route_lead` | — | `routing-forms route` | `full, bookings` |
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
| `request_reschedule` | — | `request-reschedule` | `full, bookings` |
| `reschedule_booking` | — | `reschedule` | `full, bookings` |
| `reschedule_booking` | `host` | `reschedule` | `full, bookings` |
| `reschedule_booking` | `manageToken` | `reschedule` | `full, bookings` |
| `cancel_booking` | — | `cancel` | `full, bookings` |
| `cancel_booking` | `host` | `cancel` | `full, bookings` |
| `cancel_booking` | `manageToken` | `cancel` | `full, bookings` |
| `list_bookings` | — | `list` | `full, read, bookings` |
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

<!-- api-key-scope-table:end -->

SSO is being built and is not available yet. The SSO operations in these tables return
`404 sso_disabled` until an operator can enable the protocol; OIDC and SAML currently
remain hard-off in code, so no setting enables them. MCP omits `list_sso_providers`
and `get_sso_policy` from `tools/list` while off; direct MCP calls and CLI
`sso providers list` / `sso policy` report `sso_disabled` for otherwise allowed scopes.

SSO 正在开发中，尚不可用。表中的 SSO 操作在运营者能够启用协议之前返回
`404 sso_disabled`；目前 OIDC 和 SAML 在代码中保持关闭，任何配置均无法启用。
关闭时 MCP 工具列表不包含上述工具；允许范围内的直接调用和 CLI 命令返回相同错误。

`list_workflows` and `get_workflow` are listed before booking workflows are available:
until they are enabled, `tools/list` omits them and a direct call by a `read` or `full` key
returns `isError: true` with `workflows_disabled` (a `bookings` key still gets
`insufficient_scope`). `workflows list`, `workflows get` and `workflows create` report the same codes.
`create_workflow` requires full scope and accepts `owner`, a retained `idempotencyKey`,
and the definition fields (`name`, `scope`, `trigger`, `actions`, optional `enabled` and
`conditions`). Identical normalized retries return the stored definition; changed input
conflicts. IDs are server-generated, unknown fields are rejected, and webhook actions
are not available yet.

Scope is immutable: use **Create replacement** on `/app/api-keys`, update the client and
revoke the old key. Legacy keys and native API creations that omit `metadata.scope` retain
`full` compatibility; the web form explicitly sends `bookings` by default. `full` still
cannot authorize browser-only operations or key management. MCP OAuth retains its existing
`mcp:tools` access rather than adopting API key scopes. See [API keys](/docs/api-keys) for the
generated REST table, native boundaries and complete replacement/creation contract.

When upgrading, stop every old web/all/worker and other old key-authenticating process,
apply migrations, then restart all roles with the new code before using scoped keys.
**Do not run old and new servers side by side once scoped keys exist:** old code treats
them as full access. Follow the supported backup/restore procedure for rollback.

## Generate open-time email snippets

Call `generate_open_time_snippet` with exactly one of `eventTypeId` or `slug`, required
`from` and `to` instants (at most 31 elapsed days), and optional `count` (1–10, default 3),
`locale`, `displayTimeZone` and `durationMinutes`. The tool returns `slots` with direct
booking links plus rendered `text` and `html`, using the same formatter as the admin picker.
Use it to draft “three times next week”; it neither sends email nor reserves times.
Personal owners and team owners/admins can call it with `read`, `bookings` or `full` keys,
or an authorized `mcp:tools` OAuth connection. The instance must enable
`SLOT_SNIPPETS_ENABLED`. When off (the default), `generate_open_time_snippet` is absent
from `tools/list`; a direct call returns JSON-RPC error `-32602` with
`Tool generate_open_time_snippet not found`. See [the agent guide](/docs/open-time-snippets) for the full JSON example,
profile defaults, empty-result handling, DST boundaries and taken-time fallback.

## Explain why times cannot be booked

Call `troubleshoot_availability` with `eventTypeId` and a local `date` (`YYYY-MM-DD`), plus
optional `timeZone` and `durationMinutes`. Its `structuredContent` matches the REST response:
`available` slots have empty reasons; unavailable slots list blocking reasons in priority
order. Personal owners and current team owners/admins may call it with a `full` key or an
`mcp:tools` OAuth grant. `read`/`bookings` keys get `insufficient_scope`; other unauthorized
callers get the same `event_type_not_found` as an unknown event.

`calendar_sync_unavailable` means selected Google/CalDAV cached snapshots cannot establish
fresh, complete availability; it does not mean a known busy event or missing setup. The tool
does not refresh providers. CalDAV busy sync and write-back exist as internal services but
are not exposed through user connection flows yet. Microsoft connections currently list
calendars only: there is no busy sync or sync-freshness check. An available explanation does
not establish that an Outlook calendar is free.

This diagnoses new slots, not invitee permission to change an existing booking. Change
deadlines are separate action errors. Busy intervals omit event titles, attendees, locations
and calendar/booking IDs. See [Troubleshoot availability](/docs/availability-troubleshooting) for
reason-by-reason actions, DST behavior, privacy and provider limitations.

中文：`troubleshoot_availability` 输入事件 ID、本地日期，可选时区和时长；
`structuredContent` 与 REST 一致，原因按优先级排列，可预约时原因为空。
仅所有者/团队管理员使用 `full` 密钥或有权限的 MCP OAuth 可调用；低权限密钥返回
`insufficient_scope`，其他越权与不存在均返回 `event_type_not_found`。
Google/内部 CalDAV 快照过期或不完整返回 `calendar_sync_unavailable`，不能说成缺少配置。
CalDAV 同步及写回尚未开放连接入口；Microsoft 只有日历列表，没有忙碌同步或新鲜度检查。
此工具不刷新日历、不检查已有预约的改期截止时间，也不返回事件详情。

## Configure notice, booking window and buffers

The same event-type create/update JSON accepts `minimumNoticeMinutes` (0–525600 whole
minutes), `bufferBeforeMinutes` and `bufferAfterMinutes` (0–1440 whole minutes each).
`bookingWindowDays` uses **whole calendar days**, 1–3650, or `null` for no limit.
For example, `{"minimumNoticeMinutes": 120, "bufferBeforeMinutes": 15,
"bufferAfterMinutes": 30, "bookingWindowDays": 14}` means two hours' notice, a
15-minute buffer before, a 30-minute buffer after, and a 14-day booking window.
Omitted update fields keep their current values. The web editor's minute/hour/day
selector is a display convenience; API input and output units do not change.
Notice and buffers use elapsed minutes; a 1440-minute notice is exactly 24 hours.
Booking windows retain calendar-day semantics in the host's schedule time zone across
daylight saving time. See [event-type timing settings](/docs#notice-booking-window-and-buffers)
for ranges, conversions and limitations.

## Configure an after-booking redirect

`get_event_type` returns `successRedirect`; `create_event_type` and `update_event_type`
accept the same object or `null` as REST, requiring `full` API key scope. Omit the field on
update to preserve it. See [after-booking redirects](/docs/after-booking#mcp) for parameters,
privacy and embed permissions, stable error fields and policy-change behavior.

## Discover your configuration

Call `whoami` to check the key's organization and `get_profile` for your booking-page handle,
time zone and language. No profile yet returns `profile_not_found`; create one in the web
app or through REST.

| Tool | Input and result |
|---|---|
| `list_event_types` | Optional `limit` and `after`; compact summaries of team types and your personal types in the key's organization. Includes inactive configurations, excludes deleted types. |
| `get_event_type` | An `id` from the list; full configuration, including questions, location, rules and notification settings. |
| `set_event_type_notifications` | `{id, notifications}`; replace reminders and follow-ups, returning the full event type. Requires `full` API key scope, or an authorized MCP OAuth grant, and personal-owner/team-owner-or-admin permissions. |
| `list_schedules` | Optional `limit` and `after`; summaries of your schedules. Schedules belong to your user across organizations. |
| `get_schedule` | An `id` from the list; weekly working hours in the schedule's IANA time zone. Date overrides are separate. |
| `list_calendar_connections` | No arguments; your connected account emails, calendar names and IDs, safe connection status, conflict settings and write destination. |
| `list_conference_connections` | No arguments; your Zoom connection IDs, account email and display name, identity/meetings mode and safe status. |

Catalog lists return `{ data, nextAfter }`, sorted by ID, with 20 summaries by default and at
most 100 (`limit: 1`–`100`). Pass `after: nextAfter` with the same key and organization until
`nextAfter` is null. Cursors exclude the previous row, even if that row was deleted. Pages
are recalculated, so configuration changes may affect later pages. The list omits large
detail fields; use the corresponding detail tool when needed. Event-type writes also use
`create_event_type` and `update_event_type`; schedule edits and date overrides remain
available through REST and the web app. Always check public availability
with `find_available_slots` before booking an event found in the catalog.

See [Reminders and follow-ups](/docs/reminders-and-follow-ups) for timing, recipients,
host notes and known limitations. `set_event_type_notifications` replaces both arrays as
one value; it never sends mail immediately or changes existing booking snapshots.
`get_event_type` returns the saved
canonical value. For example, `{ "id": "<event-type-id>", "notifications": {
"reminders": [], "followUps": [] } }` disables scheduled messages for new bookings.
See [notification validation](/docs/api-conventions#event-type-notification-settings)
for limits and the `invalid_request` / `invalid_notifications` split, and
[host-note policy](/docs/notifications#host-notes-and-hosted-email-abuse-controls)
before adding optional follow-up text. `bookings` scope cannot change these settings.

Connection discovery accepts `read`/`full` API keys and enabled MCP OAuth grants and reads only
your own metadata, without credentials or provider calls. The user's own `full` API keys can change calendar
conflict selection, the writeback destination, refresh the calendar list and sync now through
REST, and select their own meeting-mode Zoom connection on event types they actually host.
The same organization and ownership checks apply as for browser sessions.
OAuth authorization, code exchange and disconnect require a live browser session;
explicit Zoom credential refresh remains session-only. Calendar settings mutations use REST
with a `full` API key; MCP OAuth grants do not authenticate REST requests.

## Manage booking webhooks

`list_webhooks` takes `{}` and returns `{ data: [...] }` with up to ten endpoints in the
credential's organization. The result contains endpoint metadata only. Use a `read` or
`full` API key. `create_webhook` requires a `full` API key and accepts the REST body
`{ url, events, isActive? }`. It returns `{ webhook, secret }` once. Store the signing secret
directly in the receiver's secret store and keep the tool result out of logs.

`update_webhook` (CLI `webhooks update`) takes `id` and at least one of `events` or
`isActive`, then returns the updated metadata. The URL is immutable. To pause after
a destination's allowlist entry is removed, pass only `id` and `isActive: false`.
`delete_webhook` (CLI `webhooks delete`) takes `{ id }` and returns `{ "deleted": true }`
after removing the endpoint and its retained deliveries. Both writes require a `full`
API key. IDs that are missing or belong to another organization return `webhook_not_found`.

`create_webhook` and `update_webhook` accept `booking.created`, `booking.rescheduled`,
`booking.cancelled`, `booking.reschedule_requested`, `booking.reschedule_request_expired`,
`booking.attendee_no_show_changed` and `workflow.executed` in `events`. Workflows are
hard-off. Adding `workflow.executed` returns a tool error with `workflows_disabled`
(REST 404). On create, it takes precedence over `webhooks_disabled` (REST 409).

`rotate_webhook_secret` takes `{ id }` and requires a `full` API key. Each successful
call replaces the signing secret and returns the new `{ secret }` once. Save it directly
to the receiver's secret store and keep the result out of logs. Coordinate one rotation
at a time so the receiver uses the most recent secret.

`list_webhook_deliveries` takes `{ id, after? }` and accepts a `read` or `full` API key.
It returns `{ data, nextAfter }` with up to fifty delivery metadata rows from the last
thirty days, newest first. Omit `after` for the first page, then pass `nextAfter` as
`after` until it is null. Payloads, headers and secrets are omitted. Rotation and
history both return `webhook_not_found` for missing or out-of-organization endpoints.
Treat `Webhook.events` and `WebhookDelivery.eventType` as open enums and ignore unknown
event types. Every delivery record has a required UUID `bookingId`.

An authorized `mcp:tools` OAuth grant can call these tools. They use REST's checks for the
verified personal owner or current team owner/admin in the acting organization.
Disallowed API key scopes get `insufficient_scope`, and callers without the required
role get `insufficient_role`. See [Booking webhooks](/docs/webhooks) for supported events,
URL policy and configuration.

中文：`list_webhooks` 接受 `read` 或 `full` 密钥，`create_webhook` 需要 `full` 密钥。
所有操作均检查凭证所属组织及当前角色。创建仅返回一次签名密钥，请保存到接收端的密钥存储。
`update_webhook` 和 `delete_webhook` 均需要 `full` 密钥。更新可修改订阅事件和启用状态，
目标 URL 固定。删除会清除保留的投递记录。不存在或属于其他组织的端点均返回 `webhook_not_found`。
`rotate_webhook_secret` 需要 `full` 密钥，每次成功轮换仅在本次响应中返回新签名密钥。
`list_webhook_deliveries` 接受 `read` 或 `full` 密钥，每页最多返回最近 30 天的 50 条元数据。
下一页将 `nextAfter` 作为 `after` 传入，直至其为 null。投递历史不包含正文、请求头或密钥。
工作流仍处于硬关闭状态。新增 `workflow.executed` 订阅会返回 `workflows_disabled`
工具错误（对应 REST 404），创建时优先于 `webhooks_disabled`（对应 REST 409）。

## Create and manage event types

Creation requires `slug`, `title` and `durationMinutes`. The web form's suggested booking
link, duration preset buttons and connected-service location default are conveniences;
REST, MCP and CLI do not apply those suggestions. Omitted location configuration stays
unset. Timing units remain whole minutes for notice/buffers and whole calendar days for
`bookingWindowDays`, regardless of the web editor's selected display unit.

Enable or disable with `isActive: true` or `false` through REST
`PATCH /api/v1/event-types/{id}`, MCP `update_event_type`, or CLI `update-event`.
MCP and CLI take `id` beside the changed fields; omitted fields keep their saved values.
These writes require a `full` API key and the existing ownership/organization permissions.
Disabling does not cancel existing bookings. Delete uses the web confirmation or REST
`DELETE /api/v1/event-types/{id}` (204 on success); REST has no confirmation step.
There is currently no event-type deletion MCP tool or CLI command. See
[creating and managing event types](/docs/event-types) for the editor, copying rules and limitations.

中文：三个接口均需明确传入创建字段，不套用网页的链接建议或已连接会议服务默认值。
用 `isActive` 启停不会取消已有预约；删除仅支持网页确认或 REST，目前没有 MCP／CLI 删除命令。

## Configure meeting lengths

Use `create_event_type` with `slug`, `title` and `durationMinutes`; optionally supply
`allowedDurationsMinutes`, the list of 1–12 distinct whole-minute lengths from
1 to 1440 inclusive, kept in ascending order. Supplied lengths are sorted before storage. The list must include `durationMinutes`, the default. Omitting the
list creates `[durationMinutes]`. For example:

```json
{"slug":"intro","title":"Introduction","durationMinutes":30,"allowedDurationsMinutes":[15,30,60]}
```

`update_event_type` takes a flat object with `id` beside the changed fields. To replace
both the list and default, use
`{ "id": "<event-type-uuid>", "durationMinutes": 45, "allowedDurationsMinutes": [15, 45, 60] }`.
Configuration writes require a `full` API key; `bookings` and `read` keys cannot call these
tools. MCP OAuth retains its organization and role checks. Validation and permissions
are shared with REST: invalid values return `invalid_event_type`, while malformed request
shapes return `invalid_request`. See [multiple meeting lengths](/docs/multiple-durations)
for update compatibility, editor steps, invitee selection and shared-rule limits.

## Book and manage time

| Tool | Input and result |
|---|---|
| `whoami` | No arguments; shows the key's user, organization, key ID and `apiKeyScope`. |
| `find_available_slots` | A booking page's `handle`, `slug`, `startDate`, `endDate`, `timeZone`; returns event details and slots. Dates span at most 62 days inclusive. |
| `create_booking` | `handle`, `slug`, a returned slot's `start`, `invitee`, and an optional `idempotencyKey`; returns the booking and manage token. |
| `reschedule_booking` | Exactly one of hosted `bookingId` or invitee `manageToken`, plus new `start`; returns a replacement booking, with a new token for invitee moves and null for host moves. |
| `cancel_booking` | Either a hosted `bookingId` or an invitee `manageToken`; cancels the booking. |
| `get_group_occurrence_attendees` | `occurrenceId`; returns authorized seat holders, answers, status and no-show state. |
| `cancel_group_occurrence` | `occurrenceId` and optional `reason`; cancels all active seats of a hosted future occurrence. |
| `list_bookings` | Lists bookings hosted by the key owner in its organization, with pagination. `order` defaults to `asc`; use `desc` for newest first and keep it unchanged between pages. `status: "cancelled"` gives the cancelled view; `q` searches invitee name, invitee email and event type title. |

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
| `duplicate_event_type` | Copies editable settings to a new unique booking link | — |
| `create_event_type` | Creates an event type, including the default and allowed meeting lengths | — |
| `update_event_type` | Changes an event type by `id`, including the default and allowed meeting lengths | destructive, idempotent |
| `list_schedules` | Compact, paginated summaries of your working-hours schedules | read-only |
| `get_schedule` | One of your schedules, including weekly hours in its time zone | read-only |
| `list_calendar_connections` | Your calendar connection status, calendar IDs, conflict settings and write destination; no credentials | read-only |
| `list_conference_connections` | Your Zoom connection IDs, modes and status; no credentials or browser authorization attempts | read-only |
| `list_webhooks` | Booking webhook metadata for the acting organization | read-only |
| `create_webhook` | Registers a booking webhook and returns the signing secret once | — |
| `update_webhook` | Changes webhook subscriptions or pauses/resumes delivery | destructive |
| `delete_webhook` | Deletes a webhook and its retained deliveries | destructive, idempotent |
| `rotate_webhook_secret` | Replaces the signing secret and returns it once | destructive |
| `list_webhook_deliveries` | Pages through safe webhook delivery metadata | read-only |
| `find_available_slots` | The event type (title, duration, questions, host's time zone when applicable) and its free slots between two dates | read-only |
| `troubleshoot_availability` | Every possible start time of one local day with bookable status and plain reason codes; owner/admin and `full` keys only, no calendar or booking details | read-only |
| `generate_open_time_snippet` | Earliest open alternatives with direct booking links and localized text/HTML for an email draft; owner/admin only, no reservation | read-only |
| `create_booking` | Books a slot for an invitee; returns the booking and its `manageToken` | open world |
| `reschedule_booking` | Moves a booking you host (`bookingId`, token is null) or one you made (`manageToken`, returns a new token) | destructive, open world |
| `cancel_booking` | Cancels a booking you host (`bookingId`) or one you made (`manageToken`) | destructive, idempotent, open world |
| `list_bookings` | Bookings you host in the key's organization, by start time, a page at a time; optional status filter and search | read-only |

Configuration discovery starts with `whoami` and `get_profile`. `list_event_types` includes
team event types and your personal types in the key's organization, including inactive
configurations; deleted types and another member's personal types are excluded. Discovery
is not proof of public availability: use `find_available_slots` before booking.
`list_schedules` includes only your schedules, which follow your user across organizations.
Use the corresponding `get_` tool for full details; `get_schedule` returns weekly hours,
not date overrides. Use `create_event_type` and `update_event_type` for event-type changes;
schedule edits and date overrides use the REST API or web app.

The two connection tools take `{}` and call the same services as
`GET /api/v1/calendar-connections` and `GET /api/v1/conference-connections`. They read only
the caller's own connections across organizations and make no provider requests. `read`/`full`
API keys and enabled MCP OAuth grants can use both tools. The user's own `full` API keys can change calendar
conflict selection, the writeback destination, refresh the calendar list and sync now through
REST. They can also select their own meeting-mode Zoom connection on event types they
actually host, subject to the same organization permissions as browser sessions.
OAuth authorization, code exchange and disconnect require a live browser session;
explicit Zoom credential refresh remains session-only. Calendar settings mutations use
REST. MCP OAuth grants do not authenticate REST requests.

`find_available_slots` and `create_booking` accept exactly one public namespace:
`handle` for `/{handle}/{slug}`, or `teamSlug` for `/team/{teamSlug}/{slug}`. Personal
handles are case-insensitive; team slugs use exact stored case. Old `handle` inputs remain
valid. A collective team type offers only intervals every required host offers; see
[collective scheduling](/docs/collective-scheduling) for its bounds and rescheduling rules.
An activated round-robin type offers the union and assigns one available host. Its booking
result includes safe `assignedHost` name/time zone; retries and rescheduling retain that
selection. See [round-robin scheduling](/docs/round-robin-scheduling).

`find_available_slots`, `create_booking` and `reschedule_booking` accept optional
`durationMinutes`. Select a whole-minute length from the event type's
`allowedDurationsMinutes` (also returned by `get_event_type`). Slots and new bookings use
the default when it is omitted. Keep the selection unchanged when continuing slot pages
and pass the same length when booking. Unsupported lengths fail with `invalid_duration`;
malformed selections fail with `invalid_request`. Rescheduling without a new selection
preserves the booking's actual elapsed length, including an option the host has removed.
An explicit new length must belong to the current allowed list. Booking and reschedule
results, notifications and calendar invitations use the selected end time.

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

`status: "cancelled"` lists only cancelled bookings, including bookings replaced by a
reschedule (their `rescheduledToId` is set). `q` narrows the list to bookings whose invitee
name or email, or whose current event type title, contains the text, ignoring case. See
[searching the booking list](/docs/rest#search-the-booking-list) for the exact rules.

Host booking fields include optional `rescheduledToId`: the immediate successor in the same
organization that the caller also hosts, or null when none is available. It is returned even
when the successor falls outside the current page or filters. Public/manage responses omit
it. The predecessor's `status` remains `cancelled`; use `rescheduledToId` to distinguish a
reschedule from a cancellation, and `rescheduledFromId` to trace back to its predecessor.

`list_workflows` and `get_workflow` read booking workflows, which are not available yet. They
stay out of `tools/list`, and a direct call answers `workflows_disabled`, until workflows are
enabled on the instance; discover availability with `workflowsEnabled` from
`GET /api/v1/instance`. Once enabled, `list_workflows` takes the explicit owner you act as
(`{kind: "personal", id: your user ID}` in your personal organization, or
`{kind: "team", id: team ID}` as a current team owner or admin), and both return the current
revision's definition with its enabled flag.

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
- **Change deadlines:** with `manageToken`, `reschedule_booking` and `cancel_booking` fail
  with `booking_reschedule_deadline_passed` or `booking_cancel_deadline_passed` from the
  booking's [deadline](/docs/change-deadlines) on; the invitee should contact the host.
  Calls with `bookingId` are not limited.
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
actual host's session or own `full` API key through REST, with the same organization checks.
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

CSV export through API keys is limited to the owner's personal organization (`read` or
`full`). Team-wide CSV exports retain the existing browser-session-only team-admin access
and field rules; a team key, even an owner's `full` key, receives
`team_management_access_denied`. See [CSV booking export](https://hourmere.com/docs/booking-export).

## Meeting location choices

Configure an ordered `locations` list through the event-type create/update operations,
and choose `locationOptionId` for slot availability and booking. An invitee-phone option additionally requires
`inviteePhone`, normalized to E.164 after removing common phone separators.
CLI `slots` and `book` accept `locationOptionId` in their JSON input files.
Rescheduling keeps the original choice. See [meeting location choices](https://hourmere.com/docs/location-choices)
for configuration examples, public discovery, compatibility and conference rules.

## Ask an invitee to choose another time

Hosts can send `POST /api/v1/bookings/{id}/request-reschedule` with
`{"idempotencyKey":"<random UUID>","note":"Could you choose another time?"}`.
The MCP equivalent is `request_reschedule` with `bookingId` and the same fields;
CLI users run `hourmere request-reschedule --input request.json`.
A `bookings` or `full` API key and existing host permission are required.
The optional plain-text note is limited to 2000 UTF-16 code units and appears only
in the email body. Retain the UUID and identical input for safe retries; use a new
UUID to replace the outstanding request.

The returned booking stays `confirmed`, with optional `pendingReschedule` containing
`id`, `expiresAt` and `note`. The original time stays booked and blocks availability
until the invitee uses their normal manage link to pick another time or cancel.
The request expires after 48 hours, when the original meeting starts, or at the booking's
[effective reschedule deadline](/docs/change-deadlines) (the earlier of its
reschedule and cancel instants), whichever comes first; after that deadline a
new request fails with `booking_reschedule_deadline_passed`. Expiry keeps that time and notifies the host. Imported and group-seat bookings
cannot receive a request. Picking uses the normal availability rules and reschedule
limit, calendar updates, conference handling and reminders.

When answering a request through REST or MCP, include `rescheduleRequestId` from
`pendingReschedule.id` with the managed pick or cancel input. This rejects stale
replaced requests and makes identical retries safe; a replayed pick returns the
same successor with `manageToken: null`. Without that field, existing ordinary
reschedule retry semantics remain unchanged. Except for that saved pick replay, an
answer to a request that expired, was replaced or was resolved by a move fails with
`reschedule_request_changed`, as does a pick after cancellation. Replaying a cancellation keeps its original reason even
if a different reason is supplied. With the request email's token, REST
`GET /api/v1/bookings/manage` reports what happened in `rescheduleRequest`; MCP and CLI
have no invitee read of a manage token.

## Configure booking limits

MCP `create_event_type` and `update_event_type` accept `maxBookingsPerDay`,
`maxBookingsPerWeek` and `maxBookingsPerMonth`; `get_event_type` returns all three
settings. Updates take a flat object with `id` alongside changed fields.
Configuration writes require a `full` API key and the usual ownership or team
owner/admin permissions; MCP OAuth retains its organization and role checks.

Each ceiling is a whole number from 1 to 1000, or `null` for no ceiling. Omitted
update fields preserve the saved setting. Configured allowances must satisfy
day ≤ week ≤ month, comparing each pair that is set, including day/month without a
weekly limit. See [booking limits](/docs/booking-limits) for examples, host schedule
time zones, Monday-based weeks, calendar months and counting rules. Lowering a
ceiling does not cancel existing bookings.

## Booking activity

`get_booking_activity` returns the same report as `GET /api/v1/analytics/bookings` for the
acting organization: daily and total `created`, `rescheduled`, `cancelled` and `noShows`
for inclusive `startDate`/`endDate` (at most 90 local dates) in an IANA `timeZone`. It
requires the personal owner or a current team owner/admin (`insufficient_role` otherwise)
and an API key with `read` or `full` scope. `noShows` counts each attendee currently marked
as a no-show on still-confirmed bookings, by the local date of the scheduled start; see
[booking activity](https://hourmere.com/docs/analytics) for the full definition.

## Configure reschedule and cancel deadlines

`create_event_type` and `update_event_type` accept `rescheduleCutoffMinutes` and
`cancelCutoffMinutes`; `get_event_type` returns them. Each is a whole number from 1 to
525600, or `null` for no deadline. From that many minutes before the start, invitee
calls with `manageToken` can no longer reschedule or cancel; host calls with
`bookingId` are not limited. Each booking keeps the values that applied when it was
booked. See [reschedule and cancel deadlines](/docs/change-deadlines) for examples.

Invitee rescheduling closes at the earlier of the reschedule and cancel deadline
instants, using the booking's snapshot; null contributes no limit from that side.
A refusal caused only by the cancel deadline still returns
`booking_reschedule_deadline_passed`. Reschedule requests expire at this effective
deadline, and new requests are refused once it is reached.
These are elapsed minutes, independent of the invitee's display time zone and daylight
saving changes: `1440` means exactly 24 hours. With `cancelCutoffMinutes: 1440` and
`rescheduleCutoffMinutes: 120`, both invitee actions close 24 hours before the start.
The exact deadline instant is closed; 1 millisecond before it remains eligible, subject
to the other booking rules. Host actions still require the caller to host the booking;
team-admin status alone grants no extra MCP/CLI or API-key access.

## Attendee attendance access

`get_booking_attendees` and `set_attendee_no_show` require the caller to host the booking
in the current organization, for API keys of every scope and MCP OAuth alike. Team
owner/admin status does not grant access to bookings hosted by other members through
MCP or the CLI; those bookings return `booking_not_found`, just as missing bookings do.
Non-host team administrators must use a browser session. See the
[no-show guide](https://hourmere.com/docs/no-shows) for marker behavior and key scopes.

## Booking waitlists

See [booking waitlists](/docs/booking-waitlist) for host settings, entry management,
invitee consent and verification, REST/MCP/CLI inputs, scopes, privacy and retention.
Nothing is reserved: every eligible invitee can be notified and the first successful
ordinary booking wins.


`update_workflow` / `workflows update` requires `full` scope and accepts `id`,
`expectedRevision` and changed definition fields. REST uses `PATCH /api/v1/workflows/{id}`
with the same body except `id`. Omitted fields are preserved; supplied arrays replace their
previous values. Content edits append a revision, while an `enabled`-only change preserves
it. A stale expectation returns `workflow_revision_conflict`. Disabling and re-enabling
leave existing booking enrollments and execution rows unchanged. Webhook actions are
rejected. These operations remain unavailable (`workflows_disabled`).

中文：`update_workflow` / `workflows update` 需要 `full` 权限，输入 `id`、
`expectedRevision` 和要修改的字段。REST 使用 `PATCH /api/v1/workflows/{id}`，正文不含
`id`。省略的字段保持不变，数组整体替换。内容修改会新增修订，仅切换 `enabled` 不改变
修订号；旧修订返回 `workflow_revision_conflict`。停用和重新启用不会修改已有预约的工作流
登记或执行记录。暂不支持 webhook 动作；功能仍关闭，返回 `workflows_disabled`。


`delete_workflow` / `workflows delete` requires `full` scope and accepts `id` and
`expectedRevision`. REST uses `DELETE /api/v1/workflows/{id}` with only
`expectedRevision` in its JSON body and returns `204`; MCP/CLI return `{ "deleted": true }`.
A stale revision conflicts. A repeated delete succeeds while the tombstone is retained,
but always rechecks current owner/admin permission. Missing or unauthorized IDs return the
same `workflow_not_found`. Deletion retires pending runs and preserves creation-key replay
protection, minimal history and mail charges. All three interfaces remain unavailable
(`workflows_disabled`) while workflows are hard-off, and MCP discovery omits the tool.

中文：`delete_workflow` / `workflows delete` 需要 `full` 权限，输入 `id` 和
`expectedRevision`。REST 使用 `DELETE /api/v1/workflows/{id}`，JSON 正文只含
`expectedRevision`，成功返回 `204`；MCP/CLI 返回 `{ "deleted": true }`。
版本过期会冲突；保留删除标记期间可以安全重试，但每次都会重新检查当前所有者或管理员权限。
不存在和无权限的 ID 均返回 `workflow_not_found`。删除会终止待执行任务，保留创建幂等键、
最小历史记录和邮件额度记录。目前功能仍硬关闭，三个接口均返回 `workflows_disabled`，
MCP 工具列表不显示此工具。

`preview_workflow` / `workflows preview` use the same body as `POST /api/v1/workflows/preview`.
Supply `owner`, `name`, `scope`, `trigger` and `actions`, with optional `enabled`,
`conditions` and synthetic `example` values. API keys need `full` scope and current
personal owner or team owner/admin authority. Preview returns the example match result,
rendered email samples and static estimates. While hard-off it returns `workflows_disabled`
and MCP discovery hides the tool.

中文：`preview_workflow`、`workflows preview` 和 `POST /api/v1/workflows/preview`
使用相同的 JSON 输入，包括所有者、候选定义和可选的合成示例。密钥需要 `full` 权限，
调用者须为当前个人所有者或团队所有者、管理员。结果包括匹配状态、邮件样本和静态额度
估计。功能仍硬关闭，返回 `workflows_disabled`，MCP 工具列表隐藏预览。

## Group events

Create/update event types with `bookingMode: "group"`, `groupCapacity` (2–100),
`allowGuests: false` and individual single-host scheduling. Configuration requires `full`
API-key scope. Omitted update fields preserve saved values; existing future booked work
prevents switching mode. Capacity edits affect new occurrences only. To switch back,
send `bookingMode: "individual"` **and** `groupCapacity: null` in the same update;
omitting capacity preserves it and fails validation. Group occurrences use one shared
location; invitee-chosen and invitee-phone locations are unavailable.

Authorized booking reads/lists represent each seat separately and include `groupSlotId`.
`GET /api/v1/group-occurrences/{id}/attendees`, MCP `get_group_occurrence_attendees` and
CLI `group-attendees` return the private occurrence roster, including answers, booking
status and no-show state. MCP/CLI take `occurrenceId`. Reads allow `full`, `read` and
`bookings` keys, with actual host authority in the current organization. Non-host team
owners/admins need a browser session; MCP OAuth has the same host-only boundary.

Attendee reads default to active (confirmed) seats. REST query parameters and MCP/CLI
JSON inputs accept `status: "active" | "cancelled" | "all"`, `limit` (1–100, default 25),
and `offset` (0–10000, default 0). Responses include `pagination: {limit, offset, hasMore}`;
advance offset by limit while hasMore is true, preserving filters. Ordering is booking
creation time then booking ID. Each page is a snapshot; bookings/cancellations between
requests can move rows, so restart at offset 0 to refresh. `activeSeats` always describes
the whole occurrence. Example CLI input:
`{"occurrenceId":"OCCURRENCE_UUID","status":"cancelled","limit":25,"offset":0}`.

`POST /api/v1/group-occurrences/{id}/cancel`, MCP `cancel_group_occurrence` and CLI
`cancel-group` cancel the whole future occurrence. MCP/CLI take `occurrenceId` and
optional `reason`; REST takes optional `reason` in JSON. Keys need `full` or `bookings`.
Ordinary booking cancellation still cancels only one seat. Public and invitee-management
reads never return the roster or sibling answers. See [group events](https://hourmere.com/docs/group-events)
for setup, privacy and limitations.

Public pages show remaining seats, never the roster. Each seat receives its own mail and
calendar invitation. Single-host group waitlists use ordinary verified, unreserved opening
notifications; a full occurrence does not offer a waitlist if other selected times are open.
Guests, multiple-seat purchases, collective/round-robin groups and group checkout are unsupported.

中文：名单默认仅含有效座位；`status` 可为 `active`、`cancelled` 或 `all`，
`limit` 为 1–100（默认 25），`offset` 为 0–10000（默认 0）。REST 用查询参数，
MCP/CLI 用 JSON，按返回的 `pagination.hasMore` 翻页。切回个人模式须同时传入
`bookingMode: "individual"` 与 `groupCapacity: null`。群组每场共用一个地点，
不允许受邀人选择地点。公开页面只显示剩余座位；单座取消释放座位，整场取消关闭该时间，
每人收到独立邮件。候补通知不保留座位、不自动预约。

Attendee pagination stops at offset 10000; `hasMore` indicates another permitted page,
not whether older retained history exists beyond that bound.

中文：名单翻页最多到偏移量 10000；`hasMore` 表示还有可请求的下一页，
不保证该范围之外没有保留的历史记录。

## Duplicate an event type

Call `duplicate_event_type` with `{ "id": "EVENT_TYPE_UUID" }` and a `full` API key.
It copies editable settings in the current organization and returns a new event with a
unique `-copy` / `-copy-N` slug. Existing owner/admin and creation checks apply.
Bookings, history, statistics and one-time links are not copied; round-robin activation
starts off. Each successful call creates a new copy, so inspect the catalog after an
uncertain response before retrying. See [event types](https://hourmere.com/docs/event-types)
for copied settings and limitations.
