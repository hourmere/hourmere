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
| `list_routing_forms` | — | `routing-forms list` | `full, read` |
| `get_routing_form` | — | `routing-forms get` | `full, read` |
| `create_routing_form` | — | `routing-forms create` | `full` |
| `update_routing_form` | — | `routing-forms update` | `full` |
| `archive_routing_form` | — | `routing-forms archive` | `full` |
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

## SMS reminders

`create_event_type` and `update_event_type` accept `smsRemindersEnabled`; event reads
report the saved setting and `smsRemindersAvailable` operator capability. Full API-key
scope and the usual owner/admin permissions are required for configuration.
`create_booking` accepts `inviteePhone` and explicit `smsConsent` for the invitee. CLI
`create-event`, `update-event` and `book` expose the same JSON inputs. See
[SMS reminders and opt-out](https://hourmere.com/docs/sms-provider) for consent, provider
configuration, signed STOP handling and limitations.
