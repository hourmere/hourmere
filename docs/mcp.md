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

Routing operations return `routing_forms_disabled` until an operator enables routing.

<!-- api-key-scope-table:start -->

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
| `list_routing_forms` | — | `routing-forms list` | `full, read` |
| `get_routing_form` | — | `routing-forms get` | `full, read` |
| `create_routing_form` | — | `routing-forms create` | `full` |
| `update_routing_form` | — | `routing-forms update` | `full` |
| `archive_routing_form` | — | `routing-forms archive` | `full` |
| `publish_routing_form` | — | `routing-forms publish` | `full` |
| `preview_routing_form` | — | `routing-forms preview` | `full` |
| `get_public_routing_form` | — | `routing-forms public` | `full, read, bookings` |
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

<!-- api-key-scope-table:end -->

SSO is being built and is not available yet. The SSO operations in these tables return
`404 sso_disabled` until an operator can enable the protocol; OIDC and SAML currently
remain hard-off in code, so no setting enables them. MCP omits `list_sso_providers`
and `get_sso_policy` from `tools/list` while off; direct MCP calls and CLI
`sso providers list` / `sso policy` report `sso_disabled` for otherwise allowed scopes.

SSO 正在开发中，尚不可用。表中的 SSO 操作在运营者能够启用协议之前返回
`404 sso_disabled`；目前 OIDC 和 SAML 在代码中保持关闭，任何配置均无法启用。
关闭时 MCP 工具列表不包含上述工具；允许范围内的直接调用和 CLI 命令返回相同错误。

The booking workflow tools are published and hard-off. `tools/list` omits them, and a
direct call with otherwise allowed credentials returns `isError: true` with
`workflows_disabled`. A `bookings` key gets `insufficient_scope`. The CLI reports the
same codes. See the [workflow operating guide](workflows.md#operating-guide).
`create_workflow` requires full scope and accepts `owner`, a retained `idempotencyKey`,
and the definition fields (`name`, `scope`, `trigger`, `actions`, optional `enabled` and
`conditions`). Identical normalized retries return the stored definition; changed input
conflicts. The server assigns IDs and rejects unknown fields. A webhook action references
an active endpoint in the acting organization subscribed to `workflow.executed`.

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

## Manage booking webhooks

`list_webhooks` takes `{}` and returns `{ data: [...] }` with up to ten endpoint records
in the acting organization, with metadata only. Use a `read` or `full` API key.
`create_webhook` requires a `full` API key and accepts `url`, `events` and optional
`isActive` (default `true`). It returns `{ webhook, secret }` once. Save `secret` directly
to the receiver's secret store and keep the tool result out of logs.

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

An authorized `mcp:tools` OAuth grant can use these tools. They take the organization from
the credential and require a verified personal owner or current team owner/admin.
Disallowed API key scopes return `insufficient_scope`, and callers without the required
role get `insufficient_role`, matching REST. See [Booking webhooks](https://hourmere.com/docs/webhooks)
for supported events, URL policy and configuration.

中文：`list_webhooks` 接受 `read` 或 `full` 密钥，`create_webhook` 需要 `full` 密钥。
所有操作均检查凭证所属组织及当前角色。创建仅返回一次签名密钥，请保存到接收端的密钥存储。
`update_webhook` 和 `delete_webhook` 均需要 `full` 密钥。更新可修改订阅事件和启用状态，
目标 URL 固定。删除会清除保留的投递记录。不存在或属于其他组织的端点均返回 `webhook_not_found`。
`rotate_webhook_secret` 需要 `full` 密钥，每次成功轮换仅在本次响应中返回新签名密钥。
`list_webhook_deliveries` 接受 `read` 或 `full` 密钥，每页最多返回最近 30 天的 50 条元数据。
下一页将 `nextAfter` 作为 `after` 传入，直至其为 null。投递历史不包含正文、请求头或密钥。
工作流仍处于硬关闭状态。新增 `workflow.executed` 订阅会返回 `workflows_disabled`
工具错误（对应 REST 404），创建时优先于 `webhooks_disabled`（对应 REST 409）。

## Manage hosted bookings

`list_bookings` (CLI `list`) reads only bookings hosted by the caller in the acting
organization, including for a team administrator. `q` searches literal substrings of the
booker's name/email or current event-type title; it excludes guests, answers and notes.
Case follows the database locale; accents are not folded. Queries are trimmed, bounded to
100 UTF-16 code units, and reject controls. `%`, `_` and `\` match themselves.
Use `status: "cancelled"` for cancelled records, including rescheduled predecessors;
omission includes confirmed and cancelled records. Start time and ID determine order
(`asc` by default); use `order: "desc"` to reverse both. Follow `nextCursor` as `cursor`
with unchanged filters. Pages are live, not a snapshot, and export does not accept `q`.

`request_reschedule` takes `bookingId`, a UUID `idempotencyKey` and optional plain-text
`note` (up to 2000 UTF-16 code units). The host needs `bookings` or `full` scope. The same
key and normalized body replay without another request; a new key replaces it. The original
booking stays confirmed and blocks its time until moved or cancelled. Expiry is the earliest
of 48 elapsed hours, the meeting start and its effective invitee reschedule deadline. A new
request at or after that deadline is refused. Imported records and group seats are unsupported.

Answer with `reschedule_booking` or `cancel_booking`, using `manageToken` and
`rescheduleRequestId`. An identical answer replays safely; a repeated pick returns its saved
successor with `manageToken: null`. Preserve the existing emailed link. A different picked time, the
opposite action, or a replaced or expired request returns `reschedule_request_changed`.
Cancellation replay preserves the original reason even if a retry changes it. MCP and CLI have no
invitee management-token read; REST `GET /api/v1/bookings/manage` and the emailed page
explain the request state. Ordinary moves without a request ID should not be retried
automatically. Host moves and cancellations use `bookingId`, require actual host authority,
and bypass invitee deadlines, but still enforce other booking rules.
See [reschedule requests](https://hourmere.com/docs/request-reschedule) and
[booking management](https://hourmere.com/docs#review-bookings).

中文：列表只返回当前组织中你主持的预约；姓名、邮箱和当前活动标题支持部分文字搜索，
但不折叠重音。分页时保留筛选条件。改期请求保留原时段，截止后不会自动取消预约。
重试请求保留原幂等键和正文；受邀人回答需携带 `rescheduleRequestId` 才有对应的安全重放语义。

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
`Tool generate_open_time_snippet not found`. See [the agent guide](https://hourmere.com/docs/open-time-snippets) for the full JSON example,
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
and calendar/booking IDs. See [Troubleshoot availability](https://hourmere.com/docs/availability-troubleshooting) for
reason-by-reason actions, DST behavior, privacy and provider limitations.

中文：`troubleshoot_availability` 输入事件 ID、本地日期，可选时区和时长；
`structuredContent` 与 REST 一致，原因按优先级排列，可预约时原因为空。
仅所有者/团队管理员使用 `full` 密钥或有权限的 MCP OAuth 可调用；低权限密钥返回
`insufficient_scope`，其他越权与不存在均返回 `event_type_not_found`。
Google/内部 CalDAV 快照过期或不完整返回 `calendar_sync_unavailable`，不能说成缺少配置。
CalDAV 同步及写回尚未开放连接入口；Microsoft 只有日历列表，没有忙碌同步或新鲜度检查。
此工具不刷新日历、不检查已有预约的改期截止时间，也不返回事件详情。

## Configure an after-booking redirect

`get_event_type` returns `successRedirect`; `create_event_type` and `update_event_type`
accept the same object or `null` as REST, with `full` API key scope. Omission on update
preserves the setting. See [after-booking redirects](https://hourmere.com/docs/after-booking)
for configuration examples, validation fields, privacy warnings and embed permissions.

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
daylight saving time. See [event-type timing settings](https://hourmere.com/docs#notice-booking-window-and-buffers)
for ranges, conversions and limitations.

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
[creating and managing event types](https://hourmere.com/docs/event-types) for the editor, copying rules and limitations.

中文：三个接口均需明确传入创建字段，不套用网页的链接建议或已连接会议服务默认值。
用 `isActive` 启停不会取消已有预约；删除仅支持网页确认或 REST，目前没有 MCP／CLI 删除命令。

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

## Store organization branding

`get_branding` reads the current organization's saved logo reference, primary color and
WCAG contrast results (`full` or `read` keys). `set_branding` accepts `brandPrimaryColor`
as `#RRGGBB` and `brandLogo` as an existing uploaded SHA-256 reference (`full` keys).
Omitted fields stay unchanged; `null` clears a field. Personal owners and team
owners/admins can use these tools; members cannot. Readable black or white button text
is selected automatically. The background contrast is reported against white.

Upload a PNG, JPEG or WebP through REST `POST /api/v1/branding/logo` or
`hourmere branding upload --file logo.png --content-type image/png`; MCP accepts the
returned reference, not binary image data or remote URLs. Uploads are limited to
512 KiB and 2048 pixels on each side, decoded and re-encoded as PNG at most 512 pixels
on the longest side and 64 KiB, and attached to
the current organization. SVG and animated images are rejected. Saved branding applies to
that space’s public pages, embeds and booking email HTML; see [branding](https://hourmere.com/docs/branding)
for personal/team ownership, accessible colour adjustments and email client limitations.

## Meeting location choices

Configure an ordered `locations` list through the event-type create/update operations,
and choose `locationOptionId` for slot availability and booking. An invitee-phone option additionally requires
`inviteePhone`, normalized to E.164 after removing common phone separators.
CLI `slots` and `book` accept `locationOptionId` in their JSON input files.
Rescheduling keeps the original choice. See [meeting location choices](https://hourmere.com/docs/location-choices)
for configuration examples, public discovery, compatibility and conference rules.

## Configure booking limits

`create_event_type` and `update_event_type` accept nullable `maxBookingsPerDay`,
`maxBookingsPerWeek` and `maxBookingsPerMonth`; `get_event_type` returns the settings.
Each ceiling is a whole number from 1 to 1000. Updates preserve omitted fields, and
explicit null clears a ceiling. Day ≤ week, week ≤ month and day ≤ month apply
whenever each pair is configured. The same REST permissions and validation apply.
See [booking limits](https://hourmere.com/docs/booking-limits) for examples, host
time zones, Monday-based weeks, calendar months and cancellation/reschedule behavior.

## Configure reschedule and cancel deadlines

`create_event_type` and `update_event_type` accept nullable `rescheduleCutoffMinutes` and
`cancelCutoffMinutes` (whole minutes from 1 to 525600); `get_event_type` returns them.
Omitted update fields are preserved and explicit null removes a deadline. Each booking
keeps the values that applied when it was booked. `reschedule_booking` and
`cancel_booking` called with `manageToken` fail with `booking_reschedule_deadline_passed`
or `booking_cancel_deadline_passed` at or after the booking's deadline; calls with
`bookingId` are not limited. `request_reschedule` fails with
`booking_reschedule_deadline_passed` once the invitee can no longer reschedule, and an open
request expires at that deadline. See
[reschedule and cancel deadlines](https://hourmere.com/docs/change-deadlines).

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

## Export bookings without filling agent context

`export_bookings` validates the same bounded range and permissions as REST, then
returns `downloadPath`, `authentication: "api_key_or_session"` and
`containsPersonalData: true`. It never returns CSV rows, signed URLs or credentials.
The relative pointer is not a capability: downloading requires an authorized session
or `read`/`full` API key on the same instance, with organization membership checked
again. An OAuth MCP grant can obtain the pointer but cannot authenticate the REST
request; use a suitable API key or the signed-in bookings page to download.

Required inputs are RFC 3339 `from` (inclusive) and `to` (exclusive), at most 366 days
apart. Optional inputs are `timeZone` (UTC by default), `bom` (false by default),
`status`, `eventTypeId`, `hostUserId`, `endAfter`, `endTo` and `order`. Personal owners
export their own bookings. Team exports require a browser session and are unavailable
to MCP API keys or OAuth grants (`team_management_access_denied`). The pointer pins the
organization to prevent a browser workspace switch from downloading another workspace.
Use `hourmere export --input export.json --output bookings.csv` for a streamed private
file. Keeping rows out of MCP responses prevents large personal-data dumps in model
context. See [CSV exports](https://hourmere.com/docs/booking-export).

## Read one booking

`get_booking` takes `{ "bookingId": "<booking UUID>" }` and returns the same detail as
`GET /api/v1/bookings/{id}` for a current booking host in the credential's organization.
Use an MCP OAuth grant or a `read`, `bookings` or `full` API key. Missing and unavailable
bookings both return `booking_not_found`.

When a booking has stored routing provenance, `routing` includes the original form and
version IDs, version number, matched and resolved rule IDs, and the saved question and
answer snapshots. Answers use question IDs, and select answers use option IDs with
their labels in the saved questions. The snapshot is still available while routing forms
are disabled. Bookings without provenance and `list_bookings` omit `routing`.

中文：`get_booking` 按 `bookingId` 读取当前组织内由你主持的预约。只有已保存路由快照的预约才返回
`routing`，其中包含原表单版本、匹配及实际采用的规则 ID，以及问题和答案快照。停用路由表单后仍可读取
已有快照，`list_bookings` 不返回该字段。

## Booking activity

`get_booking_activity` returns the same report as `GET /api/v1/analytics/bookings` for the
acting organization: daily and total `created`, `rescheduled`, `cancelled` and `noShows`
for inclusive `startDate`/`endDate` (at most 90 local dates) in an IANA `timeZone`. It
requires the personal owner or a current team owner/admin (`insufficient_role` otherwise)
and an API key with `read` or `full` scope. `noShows` counts each attendee currently marked
as a no-show on still-confirmed bookings, by the local date of the scheduled start; see
[booking activity](https://hourmere.com/docs/analytics) for the full definition.

## Attendee attendance access

`get_booking_attendees` and `set_attendee_no_show` require the caller to host the booking
in the current organization, for API keys of every scope and MCP OAuth alike. Team
owner/admin status does not grant access to bookings hosted by other members through
MCP or the CLI; those bookings return `booking_not_found`, just as missing bookings do.
Non-host team administrators must use a browser session. See the
[no-show guide](https://hourmere.com/docs/no-shows) for marker behavior and key scopes.


`update_workflow` / `workflows update` requires `full` scope and accepts `id`,
`expectedRevision` and changed definition fields. REST uses `PATCH /api/v1/workflows/{id}`
with the same body except `id`. Omitted fields are preserved; supplied arrays replace their
previous values. Content edits append a revision, while an `enabled`-only change preserves
it. A stale expectation returns `workflow_revision_conflict`. Disabling and re-enabling
leave existing booking enrollments and execution rows unchanged. A webhook action must
reference an active endpoint in the acting organization subscribed to `workflow.executed`.
These operations return `workflows_disabled` while hard-off.

中文：`update_workflow` / `workflows update` 需要 `full` 权限，输入 `id`、
`expectedRevision` 和要修改的字段。REST 使用 `PATCH /api/v1/workflows/{id}`，正文不含
`id`。省略的字段保持不变，数组整体替换。内容修改会新增修订，仅切换 `enabled` 不改变
修订号；旧修订返回 `workflow_revision_conflict`。停用和重新启用不会修改已有预约的工作流
登记或执行记录。Webhook 动作须引用当前组织中已订阅 `workflow.executed` 的启用端点。
功能仍硬关闭，返回 `workflows_disabled`。

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

`list_workflow_runs` and `workflows runs --json` take `id` and optional `limit` and `cursor`.
Use `nextCursor` for the next page of the same workflow. Pages list finished runs with fixed
outcome codes and aggregate counts for the personal owner or current team owner/admin.
History omits booking IDs and private booking details. API keys need `read` or `full`.
While workflows are off, direct calls return `workflows_disabled` and discovery hides the tool.

中文：`list_workflow_runs` 和 `workflows runs --json` 接收 `id`，可选 `limit` 和 `cursor`。
个人所有者或当前团队所有者、管理员可用 `read` 或 `full` 密钥查看安全状态与汇总计数。
历史不含预约 ID 或预约隐私信息。功能仍硬关闭，调用会返回 `workflows_disabled`，
MCP 工具列表隐藏此工具。

## SMS reminders

`create_event_type` and `update_event_type` accept `smsRemindersEnabled`; event reads
report the saved setting and `smsRemindersAvailable` operator capability. Full API-key
scope and the usual owner/admin permissions are required for configuration.
`create_booking` accepts `inviteePhone` and explicit `smsConsent` for the invitee. CLI
`create-event`, `update-event` and `book` expose the same JSON inputs. See
[SMS reminders and opt-out](https://hourmere.com/docs/sms-provider) for consent, provider
configuration, signed STOP handling and limitations.

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

## Create and manage meeting polls

See the [meeting poll API guide](meeting-polls-api.md) for the full operation map and
example calls, and the [host dashboard guide](https://hourmere.com/docs/meeting-polls)
for event eligibility and finalization.

In `tools/list`, a `read` key sees the host list, metadata and results tools plus
`read_meeting_poll` for voters. A `bookings` or `full` key also sees poll writes. Host
results include private voter details and the revisions for `finalize_meeting_poll`.
Availability in results is advisory. Finalize rechecks it and returns booking metadata
without a booking management link or token.

Call `create_meeting_poll` with the event type ID, offered candidate starts, deadline,
display time zone, admission mode and an `idempotencyKey`. A `bookings` or `full` key
requires personal event ownership or current team owner/admin access in its organization.
The response gives a `publicLink` once for public-link polls. Invited polls return null.
An exact create replay returns `poll_already_created` and the authorized `pollId`.

Use `invite_meeting_poll_voters` with `id`, `invitees` and an `idempotencyKey`. Exact
replays return current outcomes for the supplied mailboxes and queue no new mail.
`resend_meeting_poll_invitation` and `remove_meeting_poll_voter` also take `voterId`
and `expectedHostRevision`. Resend requires an idempotency key. Bulk
`remove_unverified_meeting_poll_voters` preserves host invitations and takes the host
revision. `rotate_meeting_poll_link` takes the host revision and a new key, immediately
invalidates the old public link and discloses the replacement once.

Use `list_meeting_polls` to paginate within the acting organization, `get_meeting_poll`
for metadata and `get_meeting_poll_results` for the roster and ballot revisions.
`close_meeting_poll`, `cancel_meeting_poll` and `delete_meeting_poll` take `id` and
`expectedHostRevision`. Closing stops voting and keeps the poll available for
finalization. Deleting preserves its booking. Use the results and selected ballot
revisions to finalize, and save the original input and idempotency key for an exact
replay if the response is lost.

中文：个人活动所有者或当前团队所有者和管理员可使用 `bookings` 或 `full` 密钥
创建投票、邀请、重发、移除投票者及轮换链接。请保留创建、邀请、重发和轮换使用的
幂等键。邀请重试只返回本次提交的邮箱的当前状态。公开链接只在创建或轮换首次成功时
返回，轮换后旧链接立即失效。受邀投票没有公开链接。
`read` 密钥在 `tools/list` 中可见管理端的列表、详情和结果工具，以及投票者的读取工具。
`bookings` 或 `full` 密钥还可看到写入工具。主持人结果包含投票者的私人信息及最终确认所需的版本。
候选时间的可用性仅供参考，最终确认会重新检查并返回预约元数据，不含预约管理链接或令牌。

## Public meeting polls

Public poll capability tools are available without a feature flag. `read_meeting_poll`
accepts `token` and a `read`, `bookings` or `full` key. The following writes require
`bookings` or `full`: `enroll_meeting_poll_voter`, `recover_meeting_poll_voter`,
`verify_meeting_poll_voter`, `submit_meeting_poll_vote`, `withdraw_meeting_poll_vote` and
`opt_out_meeting_poll_reminder`. MCP still authenticates its connection; REST public poll
operations also work without login or a key. Public tools act on existing polls and cannot
create one. A host key cannot replace a voter's own capability or consent.

Read accepts a public-link, verification or voting token. With a voting token it can
include the voter's own profile and ballot. Only a verified, non-withdrawn voter in an
`aggregate` poll sees separate yes/if-need-be/no counts. Public operations omit other
voters' details. Enrollment uses `publicToken`, `name`, `email`, `timeZone` and optional `locale`.
It answers uniformly with `accepted: true`, except that a full poll answers `poll_full`
for every mailbox. Recovery needs only `pollId` and `email`. After validation and rate-limit
checks, it answers accepted without revealing delivery. It sends the unchanged credential
only to an eligible existing voter under cooldowns and caps.
Verification explicitly consumes a verification token when replacing it. The replacement
`votingToken` is returned once and queued for email. Reads never verify or vote.

Voting takes `token`, all candidate `votes` (`slotId`, `value`: `yes`, `if_need_be`, `no`),
`consent: true`, optional question `responses` and the current `expectedBallotRevision`.
Withdraw takes the token and revision. On `poll_changed`, read and reconcile before a new
submission; never automatically retry a lost response. Reminder opt-out takes the separate
mail opt-out token and cannot access ballots. Admission requests share 10 per minute per
trusted IP across REST/MCP/processes; reads use 120 and vote/withdraw/opt-out share 30.
The [browser voting page](https://hourmere.com/docs/meeting-poll-voting) and host lifecycle tools
are available without a flag.

中文：公开投票工具已提供，无功能开关。读取需要 `read`、`bookings` 或 `full` 密钥，
写入需要 `bookings` 或 `full`；MCP 连接仍需认证，公开 REST 不要求登录或密钥。
公开工具仅用于现有投票，不能创建投票。密钥不能替代投票者的专用令牌或本人同意。
读取接受公开链接、验证或投票令牌。使用投票令牌时可读取自己的资料和选票。
仅 `aggregate` 投票中已验证且未撤回的投票者能查看汇总数量。公开工具不提供其他投票者的资料。
报名对已知和未知邮箱统一应答，满员时
对全部邮箱返回 `poll_full`。找回仅需 `pollId` 和邮箱，通过校验和限流后统一返回接受；符合条件时重发
原令牌，不轮换或延长有效期。验证需明确提交，首次返回的新 `votingToken` 须保密。
投票需完整选项、`consent: true` 和 `expectedBallotRevision`；过期版本返回
`poll_changed`，应重新读取并核对，不要自动重试。退订使用专用邮件令牌。
浏览器投票页面和主持人管理工具已提供，无功能开关。

## Duplicate an event type

Call `duplicate_event_type` with `{ "id": "EVENT_TYPE_UUID" }` and a `full` API key.
It copies editable settings in the current organization and returns a new event with a
unique `-copy` / `-copy-N` slug. Existing owner/admin and creation checks apply.
Bookings, history, statistics and one-time links are not copied; round-robin activation
starts off. Each successful call creates a new copy, so inspect the catalog after an
uncertain response before retrying. See [event types](https://hourmere.com/docs/event-types)
for copied settings and limitations.
