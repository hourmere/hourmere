---
title: Command-line client
description: Use API-key booking tools from a terminal.
---

The standalone CLI supports Node.js 22 or later; repository development still uses Node.js 26.
It calls the existing stateless MCP tools at `/mcp` for API-key users, using Node's built-in
HTTP client with no additional dependencies. The `export` command obtains a bounded MCP
download pointer and streams the CSV from REST to a file or stdout; CSV rows are never
returned in the MCP tool result. This is for personal bookings; team exports require the
verified owner/admin browser session. Failed downloads report the API error code and remove
an output file created by this invocation. See [CSV booking export](/docs/booking-export).
This preserves the key's organization, permissions, idempotency scope and `mcp` audit source,
including host rescheduling, without introducing another booking API.

Run it from a source checkout:

```sh
export HOURMERE_URL=https://hourmere.example.com
# Supply HOURMERE_API_KEY from your secret manager or an existing private environment.
npm run --silent cli -- whoami
npm run --silent cli -- catalog
npm run --silent cli -- --help
```

Install the standalone **`@hourmere/cli`** package from npm once published; until then,
use the source commands above. Install with `npm install --global @hourmere/cli` and use
`hourmere whoami`, `hourmere --help` and `hourmere --version`. See the
[npm README](https://github.com/hourmere/hourmere/blob/main/tools/cli/README.md) and [release procedure](https://github.com/hourmere/hourmere/blob/main/docs/releasing.md) for the tarball
checks and owner approval requirements.

The CLI cannot create or revoke API keys. Sign in to the web app, open `/app/api-keys`,
choose the intended organization and a scope, then create and privately copy the key.
**Bookings** (`bookings`, the web default) is recommended for AI booking agents;
**Read** (`read`) suits analytics/reporting and cannot book, move, cancel or retry bookings.
**Full account access** (`full`) also permits event-type and notification configuration changes;
choose it only for trusted software. Legacy keys retain `full`. Scope cannot be edited:
use **Create replacement**, update the client and revoke the old key. `whoami` returns
`apiKeyScope`; [API keys](/docs/api-keys#operation-reference) lists each command's allowed
scopes in a table generated from the authorization code. MCP discovery is filtered by scope;
a disallowed command reports `insufficient_scope` on stderr and exits **1**.

The CLI reads only
`HOURMERE_URL` and `HOURMERE_API_KEY`; it does not load `.env`, browser sessions or stored
credentials. Do not put a key into shell history. `--url ORIGIN` overrides `HOURMERE_URL`.
Use an HTTPS origin with no credentials, path, query or fragment. HTTP is accepted only for
`localhost`, `127.0.0.1` or `[::1]` development instances. Redirects are refused before a key
can be forwarded. Requests time out after 30 seconds and are never automatically retried.

For `hourmere one-time-links create|list|revoke`, see
[one-time booking links](/docs/one-time-links). Creation prints its private URL once to
stdout and refuses `--output`; list/revoke use metadata IDs without the booking token.
Create/revoke require `bookings` or `full` API key scope, while listing allows `read` or `full`.

## Commands and JSON arguments

Arguments are the corresponding [MCP tool's](/docs/mcp#tools) JSON object. Supply them with
`--input FILE` or `--input -` for standard input. No input means `{}`. Secrets and attendee
data need not appear in process arguments or shell history. Input files must be regular
files (symlinks are refused); input is limited to slightly less than 2 MiB to leave room
for the MCP envelope. The server enforces the tool's full schema and domain rules.

| Command | Tool | Arguments |
|---|---|---|
| `audit-log list` | `list_audit_events` | optional `from`, `to`, `actorType`, `actorId`, `action`, `limit`, `cursor`; requires `full`; [audit log](/docs/audit-log) |
| `audit-log settings` | `get_audit_log_settings` | `{}`; requires `full` |
| `audit-log set-retention` | `set_audit_log_settings` | `retention` and, for `days`, `retentionDays`; requires `full` and owner |
| `branding get` | `get_branding` | `{}`; requires `read` or `full` |
| `branding set` | `set_branding` | optional `brandPrimaryColor` (`#RRGGBB`), `brandLogo` (uploaded hash); `null` clears; requires `full` |
| `branding upload` | REST `POST /api/v1/branding/logo` | `--file FILE --content-type image/png` (also `image/jpeg`, `image/webp`); requires `full` |
| `polls list` | `list_meeting_polls` | optional `limit`, `after`. See [poll input rules](#manage-meeting-polls). |
| `polls get` | `get_meeting_poll` | `id` |
| `polls results` | `get_meeting_poll_results` | `id` |
| `polls close` | `close_meeting_poll` | [See inputs](#manage-meeting-polls) |
| `polls cancel` | `cancel_meeting_poll` | [See inputs](#manage-meeting-polls) |
| `polls delete` | `delete_meeting_poll` | [See inputs](#manage-meeting-polls) |
| `polls finalize` | `finalize_meeting_poll` | `id`, `slotId`, `bookerVoterId`, `attendeeVoterIds`, `expectedResultsRevision`, `expectedBallotRevisions`, `acknowledgeConditional`, `idempotencyKey` and optional `locationOptionId` |
| `whoami` | `whoami` | `{}` |
| `profile` | `get_profile` | `{}` |
| `catalog` | `list_event_types` | optional `limit`, `after` |
| `event` | `get_event_type` | `id` from `catalog` |
| `create-event` | `create_event_type` | `slug`, `title`, `durationMinutes`; optional `allowedDurationsMinutes` and other event-type fields |
| `duplicate-event` | `duplicate_event_type` | `id` of the event type to copy |
| `update-event` | `update_event_type` | `id` beside the changed event-type fields, including optional `durationMinutes`, `allowedDurationsMinutes` |
| `set-event-notifications` | `set_event_type_notifications` | `id`, complete `notifications` (`reminders` and `followUps`); `full` scope required |
| `schedules` | `list_schedules` | optional `limit`, `after` |
| `schedule` | `get_schedule` | `id` from `schedules` |
| `slots` | `find_available_slots` | `handle` or `teamSlug`, `slug`, `timeZone`, `startDate`, `endDate`; optional `durationMinutes`, `maxSlots`, `after` |
| `troubleshoot-availability` | `troubleshoot_availability` | `eventTypeId`, `date`; optional `timeZone`, `durationMinutes` |
| `open-time-snippet` | `generate_open_time_snippet` | exactly one of `eventTypeId`, `slug`; `from`, `to`; optional `count`, `locale`, `displayTimeZone`, `durationMinutes` |
| `book` | `create_booking` | `handle` or `teamSlug`, `slug`, `start`, `invitee`, **`idempotencyKey`**; optional `durationMinutes`, `responses`, `guests` |
| `list` | `list_bookings` | optional `from`, `to`, `status` (`cancelled` for the cancelled view), `q` (search), `order`, `limit`, `cursor` |
| `reschedule` | `reschedule_booking` | `start` and exactly one of `bookingId`, `manageToken`; optional `durationMinutes` |
| `cancel` | `cancel_booking` | exactly one of `bookingId`, `manageToken`; optional `reason` |
| `group-attendees` | `get_group_occurrence_attendees` | `occurrenceId`; private hosted occurrence roster |
| `cancel-group` | `cancel_group_occurrence` | `occurrenceId`; optional `reason`; cancels all active seats |
| `booking-activity` | `get_booking_activity` | `startDate`, `endDate` (inclusive `YYYY-MM-DD`, at most 90 dates), `timeZone`; requires `read` or `full` and the personal owner or a team owner/admin |
| `one-time-links create` | `create_one_time_link` | `eventTypeId`, retained random `idempotencyKey`; optional `expiresAt`, `prefill`; requires `bookings` or `full` |
| `one-time-links list` | `list_one_time_links` | `eventTypeId`; optional `limit`, `after`; requires `read` or `full` |
| `one-time-links revoke` | `revoke_one_time_link` | `eventTypeId`, `id`; requires `bookings` or `full` |
| `webhooks list` | `list_webhooks` | Empty object `{}`. Requires `read` or `full`. |
| `webhooks create` | `create_webhook` | `url`, `events` and optional `isActive`. Requires `full` and either `--output FILE` or `--json`. |
| `webhooks update` | `update_webhook` | `id` and at least one of `events` and `isActive`. Requires `full`. |
| `webhooks delete` | `delete_webhook` | `id`. Requires `full` and `--yes`. |
| `webhooks rotate-secret` | `rotate_webhook_secret` | `id`. Requires `full` and either `--output FILE` or `--json`. |
| `webhooks deliveries` | `list_webhook_deliveries` | `id` and optional `after`. Requires `read` or `full`. |
| `workflows create` | `create_workflow` | `owner`, retained `idempotencyKey`, `name`, `scope`, `trigger`, `actions`; optional `enabled`, `conditions`; requires `full`; not available yet (`workflows_disabled`) |
| `workflows update` | `update_workflow` | `id`, `expectedRevision`, changed definition fields; requires `full`; not available yet (`workflows_disabled`) |
| `workflows delete` | `delete_workflow` | `id`, `expectedRevision`; requires `full`; not available yet (`workflows_disabled`) |
| `workflows list` | `list_workflows` | `owner` (`{"kind":"personal","id":USER_ID}` or `{"kind":"team","id":TEAM_ID}`); optional `limit`, `cursor`; requires `read` or `full`; not available yet (`workflows_disabled`) |
| `workflows get` | `get_workflow` | `id`; requires `read` or `full`; not available yet (`workflows_disabled`) |

`workflows list` and `workflows get` read booking workflows, which are not available yet:
until they are enabled on the instance both exit `1` with `workflows_disabled` on stderr
(a `bookings` key gets `insufficient_scope` first). Once enabled they read only the owner the
key acts as: your personal workflows from a personal key, or a team's from a team key held by a
current owner or admin.

`catalog` includes the key's visible team and personal configurations. Booking and slot
commands accept exactly one of `handle` (personal link) or `teamSlug` (team link). Team
slugs keep their stored case; collective types require every configured host. Activated
round-robin types offer the union and assign one available host; `book` returns its safe
`assignedHost` name/time zone. Replaying the same JSON/key retains the selection. See
[round-robin scheduling](/docs/round-robin-scheduling) for explicit activation and fairness. `reschedule` and `cancel` by ID require hosting that booking in the key's
organization. A management token instead acts as the invitee. These operations can send
the same notification emails and calendar updates as the booking page.

Choose a meeting length from the event type's `allowedDurationsMinutes`, returned by
`event` or `slots`. Pass it as JSON `durationMinutes` or use `--duration-minutes 60` on
`slots`, `book` and `reschedule`. The option accepts whole minutes from 1 to 1440; the
server also checks the event type's allowed list. If both JSON and the option supply a
length, they must agree. Keep the same selection when paging through slots and booking.
Omitting it uses the default for slots and new bookings. Rescheduling without a selection
keeps the booking's actual length, even if the host has since removed that option;
an explicit new length must be in the current list.

For example, `hourmere slots --input slots.json --duration-minutes 60` finds hour-long
slots, and `hourmere book --input booking-request.json --duration-minutes 60 --output booking-result.json`
books the chosen slot with that length.

For example, put this JSON into a local request file, then run
`npm run --silent cli -- slots --input slots.json`:

```json
{
  "handle": "ada",
  "slug": "intro",
  "timeZone": "Europe/Berlin",
  "startDate": "2026-11-02",
  "endDate": "2026-11-02",
  "maxSlots": 20
}
```

For a team link such as `/team/Cobaltmere/interview`, replace `"handle": "ada"`
with `"teamSlug": "Cobaltmere"` and use `"slug": "interview"` in both the slots
and booking JSON. Do not provide both namespace fields. The CLI forwards the same JSON
without a separate team command.

Read notifications with `event --input event.json`, where the file contains
`{"id":"<event-type-id>"}`. Replace them with
`npm run --silent cli -- set-event-notifications --input notifications.json`:

```json
{
  "id": "<event-type-id>",
  "notifications": {
    "reminders": [],
    "followUps": [
      {
        "id": "one-hour-later",
        "offsetMinutes": 60,
        "recipients": { "invitee": true, "guests": false, "host": false },
        "hostNote": "Thank you for your time."
      }
    ]
  }
}
```

The command returns the full event type and changes only future new bookings, without
immediate email. Both arrays are required; two empty arrays disable scheduled messages.
See [Reminders and follow-ups](/docs/reminders-and-follow-ups) for timing, recipients,
host notes and known limitations.
Use a `full` key with personal-owner or team-owner/admin permissions. The server applies
the same [validation rules](/docs/api-conventions#event-type-notification-settings)
as REST and MCP; failure retains the error code and exits 1. Follow-up notes also require
the operator's [host-note setting](/docs/notifications#host-notes-and-hosted-email-abuse-controls).

Keep all filters unchanged when continuing a page. Catalogs and slots return `nextAfter`;
pass it as `after` until null. Booking lists return `nextCursor`; pass it as `cursor` until
null. The CLI makes one bounded request per invocation, rather than silently fetching an
unlimited list. Availability can change between pages and before booking.

For a cancelled search, save `{ "status": "cancelled", "q": "ada@example", "order": "desc" }`
in a file and run `hourmere list --input query.json`. Search matches literal substrings
of the booker's name/email or current event-type title, ignoring case according to the
database locale, without accent folding. It excludes guests, notes and answers. The trimmed
query is limited to 100 UTF-16 code units; controls are rejected. With no status filter,
both confirmed and cancelled records are included. Results remain limited to bookings
you host in the key's organization; team-admin status does not broaden that scope.
See [search rules and limitations](/docs/rest#search-the-booking-list).

Host booking fields from `list` include optional `rescheduledToId`: the immediate successor
in the same organization that the caller also hosts, or null when none is available. It is
returned even when the successor falls outside the current page or filters. Public/manage
responses omit it. The predecessor's `status` remains `cancelled`; `rescheduledToId`
distinguishes a reschedule, while `rescheduledFromId` points back to the predecessor.

## Manage booking webhooks

```sh
hourmere webhooks list --json
hourmere webhooks create --input webhook.json --output webhook-result.json
printf '%s\n' '{"id":"WEBHOOK_UUID","isActive":false}' | hourmere webhooks update --input - --json
printf '%s\n' '{"id":"WEBHOOK_UUID"}' | hourmere webhooks delete --input - --yes --json
printf '%s\n' '{"id":"WEBHOOK_UUID"}' | hourmere webhooks rotate-secret --input - --output rotated-secret.json
printf '%s\n' '{"id":"WEBHOOK_UUID"}' | hourmere webhooks deliveries --input - --json
hourmere --help
```

The list command accepts a `read` or `full` API key and returns `{ data: [...] }` with
endpoint metadata only. Creation, update, deletion and rotation require a `full` key. Use a key
from the organization you want to manage, held by its verified personal owner or a
current team owner/admin. Denials retain REST codes such as `insufficient_scope` and
`insufficient_role`.

Save the destination and subscriptions in a JSON file such as `webhook.json`, or
pass the JSON on standard input with `--input -`.

The `events` values for `webhooks create` and `webhooks update` are `booking.created`,
`booking.rescheduled`, `booking.cancelled`, `booking.reschedule_requested`,
`booking.reschedule_request_expired`, `booking.attendee_no_show_changed` and
`workflow.executed`. Workflows are hard-off. Adding `workflow.executed` exits with
status `1` and `workflows_disabled` on stderr (REST 404). On create, this takes
precedence over `webhooks_disabled` (REST 409).

```json
{
  "url": "https://receiver.example.com/hourmere",
  "events": ["booking.created", "booking.cancelled"]
}
```

The server defaults `isActive` to `true`. Creation returns `{ webhook, secret }` once.
Rotation takes `{ id }` and returns `{ secret }` once. On either command, `--output FILE`
saves the response to a new file with permissions `0600`, refuses existing paths and
symlinks, and prints only
`{"outputWritten":true}`. Use this mode in environments that capture terminal output.
For a private pipe, explicit `--json` sends the complete response to stdout.
Both commands require one of these options. Keep the response out of shell history and
logs, and install the secret in the receiver's secret store. For a lost response,
use the list to check whether the endpoint was created, then rotate its secret if needed.
See [Booking webhooks](/docs/webhooks) for receiver rotation, event kinds, destination
policy and configuration.

Update returns the changed endpoint metadata. Pass the fields you want to change, using
`id` from the list. The endpoint URL is immutable. To pause after a destination's
allowlist entry is removed, pass just `id` and `isActive: false`. Delete requires
`--yes`, waits for any in-flight delivery attempt, and returns `{ "deleted": true }`
after removing the endpoint and its retained deliveries. Missing and out-of-organization
IDs return `webhook_not_found` for both commands.

Delivery history accepts `read` or `full` and returns `{ data, nextAfter }` with up to
fifty metadata rows from the last thirty days, newest first. Pass `nextAfter` as `after`
in the next JSON input until it is null. Payloads, headers and secrets are omitted.
History and rotation also return `webhook_not_found` for missing and foreign endpoints.
Treat `Webhook.events` and `WebhookDelivery.eventType` as open enums and ignore unknown
event types. Every delivery record has a required UUID `bookingId`.

中文：`webhooks list` 使用 `read` 或 `full` 密钥。`webhooks create` 使用 `full`
密钥，并要求 `--output` 或显式 `--json`。带日志采集的环境请使用 `--output`，它会把
一次性签名密钥写入新建的私有文件，标准输出仅确认文件已写入。
`webhooks update` 和 `webhooks delete` 均使用 `full` 密钥。更新可修改订阅事件和启用状态，
目标 URL 固定。删除必须加 `--yes`，成功时会清除保留的投递记录。
`webhooks rotate-secret` 使用 `full` 密钥，需指定 `--output` 或 `--json`，仅在本次响应中返回新密钥。
`webhooks deliveries` 使用 `read` 或 `full` 密钥，每页最多返回 50 条投递元数据。
将 `nextAfter` 作为 `after` 请求下一页，直至其为 null。
工作流仍处于硬关闭状态。新增 `workflow.executed` 订阅时，CLI 退出码为 `1`，
并在标准错误输出 `workflows_disabled`（对应 REST 404），创建时优先于 `webhooks_disabled`。

## Draft open-time email snippets

Save a request such as the following to `snippet-request.json`, using future instants:

```json
{
  "slug": "intro",
  "from": "2026-11-09T00:00:00-08:00",
  "to": "2026-11-16T00:00:00-08:00",
  "count": 3,
  "displayTimeZone": "America/Los_Angeles",
  "locale": "en"
}
```

```sh
hourmere open-time-snippet --json --input snippet-request.json
# From a source checkout:
npm run --silent cli -- open-time-snippet --json --input snippet-request.json
```

Use exactly one of `eventTypeId` or `slug`; `from`/`to` are offset-bearing instants spanning
at most 31 elapsed days. `count` defaults to 3 and accepts 1–10. Optional `durationMinutes`
is supplied in JSON; omitted language and display zone use the caller's profile defaults.
`--json` makes the normal JSON output explicit. The response includes `slots` with direct
links, `text` and `html` for your draft. Generation sends no mail and reserves no time.
`read`, `bookings` and `full` keys work with personal-owner or team-owner/admin permission,
when the operator enables `SLOT_SNIPPETS_ENABLED`. When off (the default), the CLI exits 1
with empty stdout, without `outcomeMayBeUnknown`, and writes this JSON to stderr:

```json
{
  "error": "slot_snippets_disabled"
}
```

A server that predates open-time snippets returns the same unknown-tool response and is
also reported as not enabled. Ask the operator to upgrade that server before enabling
`SLOT_SNIPPETS_ENABLED`. See [the agent guide](/docs/open-time-snippets) for
response fields, DST boundaries, no-times errors and the booking page's taken-time fallback.

## Explain why times cannot be booked

```sh
echo '{"eventTypeId":"…","date":"2026-11-16","timeZone":"Europe/Berlin"}' |
  hourmere troubleshoot-availability --input -
```

The output lists every possible start time of that local day with `status` and reason codes
(for example `outside_working_hours`, `calendar_busy`, `daily_limit`), identical to REST and MCP.
It needs a `full` key and personal-owner or team-owner/admin permission; otherwise it fails with
`event_type_not_found`. See [Troubleshoot availability](/docs/availability-troubleshooting) for the reason codes.

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

`create-event` and `update-event` require a `full` API key and keep the same organization,
role and ownership checks as REST. Their JSON fields are `durationMinutes` for the default
and `allowedDurationsMinutes` for the complete list, kept in ascending order. Supplied lengths are sorted before storage.
Offer 1–12 distinct lengths,
each 1–1440 whole minutes, and include the default. The `--duration-minutes` option is for
slot, booking and reschedule selection; use JSON for event-type configuration.

For example, save `{ "slug": "intro", "title": "Introduction", "durationMinutes": 30,
"allowedDurationsMinutes": [15, 30, 60] }` to a request file, then run
`hourmere create-event --input event-request.json`. Updates use a flat object such as
`{ "id": "<event-type-uuid>", "durationMinutes": 60, "allowedDurationsMinutes": [30, 60] }`
and `hourmere update-event --input event-update.json`. Omitting the list on creation
makes a single-length type. See [multiple meeting lengths](/docs/multiple-durations) for
update compatibility, rescheduling and shared-rule limits.

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

Use the existing `create-event` or `update-event --input FILE` JSON input; updates
include `id` beside the changed fields. There are no hour/day configuration flags.

## Configure an after-booking redirect

Use `event` to read `successRedirect` and `create-event` / `update-event` with a `full` key
to write it through JSON or the matching redirect flags.
`--success-redirect-url`, `--success-redirect-parameters`,
`--success-redirect-include-invitee-personal-data` and `--success-redirect-allow-embed-parent`
construct the replacement object; `--clear-success-redirect` clears it. See
[after-booking redirects](/docs/after-booking#cli) for flag syntax, privacy warnings,
field errors and the current limitations.

## Booking and private results

Choose a slot's UTC `start` unchanged. A booking input could contain:

```json
{
  "handle": "ada",
  "slug": "intro",
  "start": "2026-11-02T08:00:00Z",
  "invitee": {
    "name": "Test Invitee",
    "email": "invitee@example.test",
    "timeZone": "Europe/Berlin"
  },
  "idempotencyKey": "replace-with-a-new-random-UUID-for-this-booking"
}
```

Optional `invitee.locale` is the same BCP 47 notification preference as REST and MCP.
The [shared locale registry](/docs/interface-languages) matches supported languages;
unsupported languages and missing messages fall back to English. Dates use the recipient
language and time zone; retries, reschedules and cancellation retain the saved locale.

Generate and retain a random idempotency key before each booking, along with that booking's
input. The CLI requires it and never generates a disposable key that would be lost after a
network failure. After checking the request and recipient, create the booking and retain
its one-time management token in a new private file:

```sh
npm run --silent cli -- book --input booking-request.json --output booking-result.json
```

`--output` reserves a **new** file before contacting the server, with permissions `0600`,
and writes the full JSON result including its `manageToken`. It refuses an existing file,
directory or symlink, preventing accidental overwrites and token loss through a bad output
path. The file is flushed before the CLI reports `{"outputWritten":true}`. Keep request and
result files out of Git, backups shared with others and logs. Stdout otherwise carries the
JSON result with management tokens and API keys redacted, including copies in nested text;
the CLI never prints booking management capabilities. Other returned information, such as attendee
email addresses, remains private booking data: redirect it only to destinations you trust.

`one-time-links create` prints its new private booking URL once to stdout so you can
copy it. It refuses `--output` before contacting the server and never writes the URL
to config, history or other files. Keep terminal capture and shell redirection private.
The retained `idempotencyKey` prevents a retry from creating
another link, but no response cache can recover a lost URL. See
[one-time booking links](/docs/one-time-links) for UI, REST, MCP and CLI examples.

Use `reschedule --input move-request.json --output moved-result.json` to retain the new
booking's result. Host moves return `manageToken: null` and preserve the invitee's existing
links; invitee moves return a new token. Input is `{"bookingId":"...","start":"..."}` for a host move, or
the same object with `manageToken` instead of `bookingId` for an invitee move. Cancellation
uses `{"bookingId":"...","reason":"..."}` or a private `manageToken` input. There is no
interactive confirmation: running a mutation command is the instruction to perform it.

## Failures and recovery

Success exits **0**. Usage, local input/output, protocol and domain errors exit **1**.
Network failures or generic HTTP transport errors exit **3**. Errors are JSON on stderr
with a stable `error` code, an HTTP `status` when available, and `retryAfterSeconds` when
provided. Untrusted server messages, URLs and exception causes are not printed.

A failure after the call begins includes `outcomeMayBeUnknown: true`, except
`slot_snippets_disabled` from `open-time-snippet`, which is a definite failure. A reserved result
file can remain empty or incomplete after a failed call or write: do not treat it as a
successful booking, and retain the original request. Inspect the server before retrying.

- For a lost **book** response, repeat the exact request with the same key and
  `idempotencyKey`. A committed booking replays with `manageToken: null`; it cannot return
  the original secret again. Hosts can use `list` and booking IDs; invitees need their
  notification email's management link if the original response was lost. Use a new output
  filename for each attempt. A different request with the same key gets
  `idempotency_key_reused`.
- **Rescheduling is not idempotent.** Never retry automatically. Inspect `list` and
  `rescheduledToId` and `rescheduledFromId` first. The previous booking ID points to a cancelled booking. A
  booking-specific token stays there after an invitee move, but follows host moves;
  an email token always follows the chain and retrying it can move the meeting again.
- Cancellation cannot be undone. Repeating it returns `booking_cancelled`.

All local integration tests use synthetic identities, real HTTP and helper-owned temporary
PostgreSQL databases. They do not send mail, access a real calendar or configure hosted
ChatGPT/claude.ai connectors.

For an activated round-robin link `/team/Cobaltmere/intro`, use the same JSON shape:

```json
{
  "teamSlug": "Cobaltmere",
  "slug": "intro",
  "timeZone": "UTC",
  "startDate": "2026-11-02",
  "endDate": "2026-11-02"
}
```

Pass the returned start to `book` with a fresh random `idempotencyKey`; retry that same
input if the response is lost. Clients do not choose a pool host.

## Automatic Meet and original calendar copies

`list` returns only this key user's optional `calendarCopy` status. `retry-meeting` forwards
`retry_conference`; `retry-calendar-copy` forwards `retry_calendar_copy`. Both use
`{"bookingId":"<current-booking-uuid>"}` in `--input`, require current verified original-host
permissions, and never accept a replacement calendar, organizer or management token. Unknown
accepted imports are reconciled without a second blind POST. Unconfigured original copies
cannot be added by retry. Collective organizer selection is authenticated event-type configuration;
round-robin allocation uses the actual eligible winner and public `book` cannot select one.


Automatic single-host Zoom uses the existing `retry-meeting` command and MCP
`retry_conference` authority. Supply `{"bookingId":"<id>"}` through `--input`; an API key
may retry an already authorized booking for its current verified pinned organizer. Browser
consent is required to authorize Zoom permissions. Account selection uses REST with the
actual host's own `full` API key; the CLI has no account-selection tool. A claimed create
with no validated ID remains ambiguous: retry does not issue another POST or adopt a guessed
meeting. Inspect/remove any orphan in Zoom before replacing the booking. Personal and
individual single-host team events are supported; collective/round-robin automatic Zoom
requires a later per-host policy. See [Automatic Zoom for one host](/docs/automatic-zoom).

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

Use `hourmere create-event --input event-request.json` or
`hourmere update-event --input event-update.json` with a `full` API key. Put
`maxBookingsPerDay`, `maxBookingsPerWeek` and `maxBookingsPerMonth` in the JSON file;
updates include `id` alongside changed fields. `--input -` reads the same JSON from
stdin. Read the saved settings with `hourmere event --input event-query.json`, where
the query contains `id`.

Each ceiling is a whole number from 1 to 1000, or `null` for no ceiling. Omitted
update fields preserve the saved setting. Configured allowances must satisfy
day ≤ week ≤ month, comparing each pair that is set, including day/month without a
weekly limit. See [booking limits](/docs/booking-limits) for examples, host schedule
time zones, Monday-based weeks, calendar months and counting rules. Lowering a
ceiling does not cancel existing bookings.

## Configure reschedule and cancel deadlines

Put `rescheduleCutoffMinutes` and `cancelCutoffMinutes` in the same `create-event` or
`update-event` JSON file, for example
`{ "id": "EVENT_TYPE_ID", "rescheduleCutoffMinutes": 2880, "cancelCutoffMinutes": 1440 }`.
Each is a whole number from 1 to 525600, or `null` for no deadline. From that many
minutes before the start, the invitee can no longer reschedule or cancel through their
link; `reschedule` and `cancel` with `bookingId` are not limited. See
[reschedule and cancel deadlines](/docs/change-deadlines) for the full rules.

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

## Manage meeting polls

Use `hourmere polls list|get|results|close|cancel|delete|finalize --input -` with an API
key for the poll's organization. Personal event owners and current team owners or admins
can manage polls. Reads allow `full`, `read` or `bookings`. Writes require `full` or
`bookings`. These commands read JSON only from stdin. Keep the finalize idempotency key
out of shell history and process arguments.

`list` takes `{}` or a `limit` from 1 to 100 and an `after` cursor from `nextAfter`.
`get` and `results` take `id`. `close`, `cancel` and `delete` take `id` and
`expectedHostRevision`. `results` returns the current results and ballot revisions.
Availability is advisory, and finalization checks it again. Include the booker in
`attendeeVoterIds` and provide the ballot revision for every selected voter. Set
`acknowledgeConditional` to `true` when selecting a voter who answered `if_need_be`.
If the finalization response is lost, replay the exact input with the original key.
The response contains safe booking metadata and `replayed`. A different key for an already
scheduled poll returns `poll_already_scheduled` with the poll ID, booking ID, chosen slot ID,
status and host revision. `delete` returns
`{ "deleted": true }` and preserves any linked booking.

中文：管理端命令使用投票所在组织的密钥，权限限个人活动所有者及团队当前所有者或管理员。
读取允许 `full`、`read` 或 `bookings`，写入需要 `full` 或 `bookings`。所有参数通过
`--input -` 从标准输入读取。结果中的可用性仅供参考；最终确认会重新检查，并核对结果版本及每位
所选参与者的选票版本。选择有条件参与者时须明确确认。响应丢失后，用原幂等键和完全相同的输入重试。
换用新键时，`poll_already_scheduled` 会返回预约和候选时间的 ID 等安全信息。删除投票会保留关联预约。

## Record attendee no-shows

[Marking no-shows](/docs/no-shows) records private per-attendee attendance after the
scheduled start. Use REST `PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show`,
MCP `set_attendee_no_show`, or CLI `set-no-show` with `bookingId`, `attendeeId` and
`noShow`. API keys require `bookings` or `full` plus booked-host authority. API keys
of every scope and MCP OAuth can read or mark attendees only on bookings the caller
hosts in the current organization. Non-host team owners/admins need a browser session;
agent credentials receive `booking_not_found`, just as for a missing booking.
Invitee pages and messages are unchanged, including scheduled follow-ups.
Counts of marked attendees appear in [booking activity](/docs/analytics) (`noShows`), also
through MCP `get_booking_activity` and CLI `booking-activity`.

## Booking waitlists

See [booking waitlists](/docs/booking-waitlist) for host settings, entry management,
invitee consent and verification, REST/MCP/CLI inputs, scopes, privacy and retention.
Nothing is reserved: every eligible invitee can be notified and the first successful
ordinary booking wins.

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

Save `{ "id": "EVENT_TYPE_UUID" }` in `duplicate.json`, then run
`hourmere duplicate-event --input duplicate.json` with a `full` API key.
The response contains the new event and its unique booking slug. It copies editable
settings within the current space, with the same owner/admin permission as creation.
Bookings, history, statistics and one-time links are excluded; round-robin activation
starts off. Each successful call makes another copy. After a lost response, use `catalog`
to check before retrying. See [event types](https://hourmere.com/docs/event-types).
