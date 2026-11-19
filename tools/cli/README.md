# Hourmere CLI

Command-line scheduling for [Hourmere](https://hourmere.com), an open-source scheduling
service for people and AI agents. Connect to your own Hourmere instance with an API key.
The CLI uses the instance's existing MCP tools over HTTPS and needs no runtime dependencies.

## Install

Requires **Node.js 22 or later**. Install from npm once published:

```sh
npm install --global @hourmere/cli
hourmere --help
hourmere --version
```

Until then, run from a source checkout with Node.js 26:

```sh
npm install
npm run --silent cli -- --help
npm run --silent cli -- --version
```

## Connect

Create an API key in your instance at **App → API keys** (`/app/api-keys`), selecting the
organization you want to use. The CLI cannot create or revoke keys. Choose **Bookings**
(`bookings`, the web default) for an AI booking agent, **Read** (`read`) for analytics and
reporting, or **Full account access** (`full`) only for software you trust with account
configuration changes. Read keys cannot create, move, cancel or repair bookings. Legacy
keys retain `full`. Scope cannot be edited: create a replacement in the web UI, update the
client and revoke the old key. `whoami` returns `apiKeyScope`; a disallowed command reports
`insufficient_scope` on stderr and exits **1**. The [API key guide](https://hourmere.com/docs/api-keys#operation-reference)
publishes command scopes generated from the authorization registry.

Set `HOURMERE_URL` to the instance origin, without `/mcp`.
Provide `HOURMERE_API_KEY` through your shell's secret environment or a secret manager.
The CLI never reads `.env` files or accepts keys as command-line flags.

```sh
export HOURMERE_URL=https://hourmere.example.com
# Set HOURMERE_API_KEY in your environment before continuing.
hourmere whoami
hourmere catalog
hourmere list
```

HTTPS is required except for loopback development origins such as `http://localhost:4187`.
Use `--url ORIGIN` to override the URL for one call.

## Find and book a time

Commands accept a JSON object through `--input FILE` or `--input -` for stdin. For example,
save this as `slots.json`, then run `hourmere slots --input slots.json`:

```json
{
  "handle": "ada",
  "slug": "intro",
  "timeZone": "Europe/Berlin",
  "startDate": "2026-11-02",
  "endDate": "2026-11-02"
}
```

For a team booking link, use `teamSlug` instead of `handle`. Supply the returned UTC `start`,
an `invitee` object (name, email, timeZone) and a new random `idempotencyKey` in a booking
request file. Retain that exact input and key before booking:

```sh
hourmere book --input booking-request.json --output booking-result.json
```

For a one-time booking link, set `oneTimeToken` to the secret path segment from
`/book/{token}` in the private booking input. Omit `handle`, `teamSlug` and `slug`.
The link is consumed together with the booking; the same input and idempotency key replay
the winning booking. Its prefilled invitee details are editable and do not prove identity.
Use the returned `manageToken` for later moves or cancellation; neither reopens the link.
The CLI accepts this capability only through JSON input and redacts it from output.

Use `event-waitlist` with `{ "id": "<event-type-id>" }` to read waitlist settings and
`set-event-waitlist` with the same id and `enabled: true` or `false` to change them.
`waitlist-entries` takes `id`, optional `limit` (1–100) and `after` for pagination;
`remove-waitlist-entry` takes `id` and `entryId`. Confirm removal before submitting.
Settings and removal require a full key. Reading settings or entries allows full/read
keys, and every host operation requires the personal owner or a team owner/admin.
Entry output may contain personal contact information; keep it private.

`join-waitlist` takes JSON `handle` or `teamSlug`, `slug`, `email`, optional `name` and
`locale`, `preferredWindow: {start, end, timeZone}`, and explicit `consent: true`.
Use UTC instants for the window and an IANA time zone. Join only after the invitee agrees
and no times are available in that range. `resend-waitlist-verification` takes the same
page reference and `email` after the invitee explicitly requests another email. Both
require a full/bookings key, return only `{ "accepted": true }` and never retry.
Check email to confirm; acceptance reveals neither an existing entry nor mail delivery.
Nothing is reserved, and the first successful ordinary booking wins. All public admission
limits apply. Optional `waitlistToken` in private booking JSON associates a successful
ordinary booking without priority; the CLI redacts it from all output.
MCP join and resend also share a 10-call-per-minute budget per user across all their keys.
Duplicate and suppressed acceptances, and requests rejected by the service, consume calls.
Neither tool promises idempotent retries; submit again only after an explicit invitee request.

For an event with several lengths, choose from `allowedDurationsMinutes` using JSON
`durationMinutes` or `--duration-minutes 60` on `slots`, `book` and `reschedule`. Keep the
same length when finding and booking a slot. The flag accepts 1–1440 whole minutes;
the instance validates its allowed list, and a flag must match any JSON selection.
Omission uses the default for slots and new bookings. Rescheduling without a selection
keeps the booking's actual length, even if that option was removed; a new explicit
selection must belong to the event type's current list.

`--output` reserves a new private file (`0600`) before the request, saves the returned
management token, and writes only `{"outputWritten":true}` to stdout. Existing files and
symlinks are refused. Keep request/result files private and out of Git. Without `--output`,
stdout contains JSON with API keys and management tokens redacted; other private booking
data can still be present.

Use `reschedule` or `cancel` with `bookingId` for a booking you host, or `manageToken` for
invitee authority. These commands act immediately and can send notifications. Calls are
never automatically retried. After a lost booking response, inspect the instance and reuse
the retained request and idempotency key. Ordinary rescheduling is not idempotent;
answers that include `rescheduleRequestId` have the replay contract described below.

### Search and review bookings

`hourmere list --input query.json` accepts `q`, `status`, `from`, `to`, `endAfter`,
`endTo`, `order`, `limit` and `cursor`. For example:

```json
{ "q": "ada@example", "status": "cancelled", "order": "desc", "limit": 25 }
```

Only bookings you host in the key's current organization are returned, even for a team
administrator. Omit `status` for confirmed and cancelled records; cancelled includes
rescheduled predecessors. Ordering is by start and ID (`asc` by default). Pass
`nextCursor` as `cursor` with all filters unchanged; each command fetches one page.
These are live pages, not a snapshot. `from`/`to` filter starts (inclusive/exclusive);
`endAfter`/`endTo` filter ends (exclusive/inclusive).

Search matches a literal substring of the booker's name/email or current event-type title,
not guests, notes or answers. It trims whitespace and accepts at most 100 UTF-16 code units;
control characters are rejected. Case follows the database locale; accents are not folded.
`%`, `_` and `\` are literal, not wildcards. Export does not accept `q`.

### Ask the invitee to choose another time

Save a private input file and run `hourmere request-reschedule --input request.json`:

```json
{ "bookingId": "<booking UUID>", "idempotencyKey": "<new UUID>", "note": "Could you choose another time?" }
```

A `bookings` or `full` key and actual host authority are required. The optional plain-text
note accepts at most 2000 UTF-16 code units. Keep the identical key and input for a retry;
a new key replaces the previous request. The confirmed booking keeps blocking its original
time. `pendingReschedule` returns the request `id`, `expiresAt` and `note`; expiry is the
earliest of 48 elapsed hours, the meeting start and the effective invitee change deadline.
Expiry keeps the original booking. Requests after the deadline are refused; imported and
group-seat bookings do not support them. Saving a request does not guarantee email delivery.

When using `reschedule` or `cancel` to answer with a `manageToken`, include that request's
`rescheduleRequestId`. Identical answer retries are safe; a replayed pick returns the same
successor with `manageToken: null`, so retain the existing emailed link. A different picked time, opposite action or
stale request returns `reschedule_request_changed`. Replaying a cancellation preserves
the original reason even if the retry supplies a different reason. The CLI never retries automatically
and has no invitee manage-token read; use the emailed page or REST to inspect request state.
See [reschedule requests](https://hourmere.com/docs/request-reschedule) for the full contract.

中文：`list` 只返回当前组织中由你主持的预约，支持部分姓名、邮箱或活动标题搜索；
不折叠重音，不搜索同行者或备注。分页时保留全部筛选条件。`request-reschedule` 保留原预约，
请求最迟在 48 小时、会议开始或有效改期截止时间三者中的最早时刻失效。重试发送时保留原键和正文；
受邀人回答时传入 `rescheduleRequestId` 才具有对应的安全重放语义，CLI 不会自动重试。

Imported bookings in `list` have `source: "import"` and
`managementPolicy: "local_only_read_only"`. They keep the host busy and remain managed in
the original scheduling system. Hourmere issues no manage link, calendar invitation or
provider update for them. `cancel`, `reschedule`, `retry-meeting` and
`retry-calendar-copy` refuse them with `imported_booking_read_only`.

`list` 中的导入预约带有 `source: "import"` 和 `managementPolicy: "local_only_read_only"`。
它们继续占用主持人的时间，仍由原预约系统管理。Hourmere 不为这些记录签发管理链接、发送日历邀请或
更新外部服务。取消、改期、重试会议和重试日历副本命令均返回 `imported_booking_read_only`。

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
`SLOT_SNIPPETS_ENABLED`. See [the agent guide](https://hourmere.com/docs/open-time-snippets) for
response fields, DST boundaries, no-times errors and the booking page's taken-time fallback.

## Explain why times cannot be booked

```sh
echo '{"eventTypeId":"…","date":"2026-11-16","timeZone":"Europe/Berlin"}' |
  hourmere troubleshoot-availability --input -
```

The output lists every possible start time of that local day with `status` and reason codes
(for example `outside_working_hours`, `calendar_busy`, `daily_limit`), identical to REST and MCP.
It needs a `full` key and personal-owner or team-owner/admin permission; otherwise it fails with
`event_type_not_found`. See [Troubleshoot availability](https://hourmere.com/docs/availability-troubleshooting) for the reason codes.

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

Use the existing `create-event` or `update-event --input FILE` JSON input; updates
include `id` beside the changed fields. There are no hour/day configuration flags.

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

Use `create-event` or `update-event` with a `full` API key to configure event types.
`durationMinutes` is the default; `allowedDurationsMinutes` is the complete list
of 1–12 distinct whole-minute lengths from 1 to 1440, kept in ascending order and including
that default. Supplied lengths are sorted before storage.
For example, save `{ "slug": "intro", "title": "Introduction", "durationMinutes": 30,
"allowedDurationsMinutes": [15, 30, 60] }` to a request file and run
`hourmere create-event --input event-request.json`. Updates use a flat object with `id`
beside the changed fields: `hourmere update-event --input event-update.json`.
Omitting the list on creation makes a single-length type. Use JSON fields for configuration;
`--duration-minutes` selects a length only on `slots`, `book` and `reschedule`.
See [multiple meeting lengths](https://hourmere.com/docs/multiple-durations) for editor
steps, update rules and rescheduling behavior.

## Configure booking limits

`create-event` and `update-event` accept `maxBookingsPerDay`, `maxBookingsPerWeek`
and `maxBookingsPerMonth` in JSON input, using a `full` API key. Each accepts a whole
number from 1 to 1000, or `null` to remove its ceiling. Omitted update fields stay
unchanged; `event` returns all three saved values. For example:

```json
{ "id": "EVENT_TYPE_ID", "maxBookingsPerWeek": 5, "maxBookingsPerMonth": 20 }
```

Save this as `event-update.json` and run `hourmere update-event --input event-update.json`.
Set ceilings must not descend from day to week to month; day must also not exceed month
when week is unset. Invalid values return the same error codes as REST and MCP; the CLI
suppresses arbitrary server error text. Counts include confirmed bookings of this event
type for each active assigned host, using the host schedule’s time zone and local start
date. ISO weeks start on Monday; months use calendar boundaries. Other event types do
not consume this allowance. Lowering a ceiling does not cancel existing bookings.

## Configure reschedule and cancel deadlines

`create-event` and `update-event` also accept `rescheduleCutoffMinutes` and
`cancelCutoffMinutes` in JSON input. Each is a whole number of minutes from 1 to 525600,
or `null` for no deadline; omitted update fields stay unchanged. For example:

```json
{ "id": "EVENT_TYPE_ID", "rescheduleCutoffMinutes": 2880, "cancelCutoffMinutes": 1440 }
```

From that many minutes before the start, the invitee can no longer reschedule or cancel
through their own link (`booking_reschedule_deadline_passed`,
`booking_cancel_deadline_passed`). `reschedule` and `cancel` with `bookingId` are host
actions and are not limited. Each booking keeps the deadlines that applied when it was
booked; changing the event type later does not affect existing bookings. See
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

## Configure an after-booking redirect

`event` reads `successRedirect`; `create-event` and `update-event` accept the same nested
object as REST/MCP through JSON, or the flags `--success-redirect-url`,
`--success-redirect-parameters` (comma-separated names, empty string for no parameters),
`--success-redirect-include-invitee-personal-data true|false`, and
`--success-redirect-allow-embed-parent true|false`. Include the URL and all values to keep
when replacing this object. `--clear-success-redirect` is a switch with no value and sends
`null`; do not combine it with redirect flags or non-null JSON settings. Conflicting flags
and JSON are refused before the request. Omission preserves the saved setting.

Writes require a `full` key and normal event-type permissions. Names and emails become
visible to the target website and its analytics when explicitly selected and opted in.
Validation remains on the server; errors preserve the code and safe `field` without
printing arbitrary messages. See [after-booking redirects](https://hourmere.com/docs/after-booking)
for editor/REST/MCP examples, HTTPS and local-host policy, sandbox behavior and limitations.

## Commands

`whoami`, `profile`, `catalog`, `event`, `create-event`, `duplicate-event`, `update-event`,
`set-event-notifications`, `schedules`, `schedule`, `slots`, `open-time-snippet`, `book`, `list`, `reschedule`,
`cancel`, `request-reschedule`, `booking-attendees`, `set-no-show`, `retry-meeting`,
`retry-calendar-copy`.

`one-time-links create`, `one-time-links list` and `one-time-links revoke` manage private
booking links for an `eventTypeId`. Create requires a `bookings` or `full` key and a retained random
`idempotencyKey`; optional `expiresAt` is a future absolute instant, and `prefill` accepts
optional `name` and `email`. It prints the new `/book/{token}` URL once to stdout and
refuses `--output`; it never writes config, history or result files. Protect terminal
capture and shell redirection. Same-key retries return `one_time_link_already_created`
without another token; there is no cached response to recover a lost URL. List requires
`read` or `full`, accepts optional `limit`/`after`, and returns metadata without URLs or
tokens. Revoke requires `bookings` or `full` plus `eventTypeId` and `id`; its result contains safe
metadata in `link`, or null for unknown/unrelated IDs. Use the id returned when the link
was created, or from the list with a read/full key. Used links remain used. Existing
ownership and team permissions still apply. See the
[one-time link guide](https://hourmere.com/docs/one-time-links) for limits and retention.

`webhooks list` returns `{ data: [...] }` with endpoint metadata for the key's organization
and requires `read` or `full`. `webhooks create` requires `full` and accepts JSON with
`url`, `events` and optional `isActive` (default `true`). Both commands require the
verified personal owner or a current team owner/admin and use REST's error codes.

```sh
hourmere webhooks list --json
hourmere webhooks create --input webhook.json --output webhook-result.json
hourmere --help
```

Creation returns `{ webhook, secret }` once. It requires `--output FILE` to save the full
response in a new `0600` file, or explicit `--json` to send the full response to stdout.
Use `--output` when stdout is logged. It prints only `{"outputWritten":true}` on success.
Copy the signing secret into the receiver's secret store and keep the response out of
shell history and logs. See [Booking webhooks](https://hourmere.com/docs/webhooks) for the
supported event kinds, destination policy and configuration.

`workflows list` (JSON `owner` as `{"kind":"personal","id":USER_ID}` or
`{"kind":"team","id":TEAM_ID}`, optional `limit` and `cursor`) and `workflows get` (JSON `id`)
read booking workflows with a `read` or `full` key. Booking workflows are not available yet:
until they are enabled on the instance both commands exit `1` with `workflows_disabled`.
`workflows create` requires a `full` key and is also unavailable. Its JSON input carries
`owner`, a retained `idempotencyKey`, `name`, `scope`, `trigger`, `actions`, and optional
`enabled` and `conditions`. Identical normalized retries return the stored definition;
changed input conflicts. IDs are server-generated; unknown fields and webhook actions
are rejected.

Discovery results use bounded pages: pass `nextAfter` as `after`, or a booking list's
`nextCursor` as `cursor`, keeping all filters unchanged. Errors are JSON on stderr.
Exit codes: `0` success, `1` usage/input/domain/protocol error, `3` transport failure.

Use `event` to read an event type's notification settings. To replace them, supply its `id`
and both notification arrays in a JSON file and use a `full` API key:

```json
{
  "id": "019a0000-0000-7000-8000-000000000001",
  "notifications": {
    "reminders": [
      {"id": "one-hour", "offsetMinutes": 60, "recipients": {"invitee": true, "guests": false, "host": true}}
    ],
    "followUps": [
      {"id": "thanks", "offsetMinutes": 60, "recipients": {"invitee": true, "guests": false, "host": false}, "hostNote": "Thank you for your time."}
    ]
  }
}
```

```sh
hourmere set-event-notifications --input notifications.json
```

Both arrays are replaced together; empty arrays turn these messages off. Settings apply to
future bookings and send no immediate mail. Personal event types require their owner;
team types require an owner or admin. `read` and `bookings` keys cannot change them.
Follow-up notes are plain text, limited to 2000 UTF-16 code units, and may be disabled by
the instance operator. They are sent from the instance's mail domain to selected recipients.
Invalid notification values return `invalid_notifications` and a fixed `message` naming
the array or zero-based rule index, field and constraint, matching REST and MCP. The
message never includes submitted values or host-note content. Other server messages
remain suppressed.

Host booking fields from `list` include optional `rescheduledToId`: the immediate successor
in the same organization that the caller also hosts, or null when none is available, even
outside the current page or filters. Public/manage responses omit it. The predecessor's
`status` remains `cancelled`; follow `rescheduledToId` forward and `rescheduledFromId` back
when inspecting a move after a lost response.

See the [complete CLI guide](https://hourmere.com/docs/cli)
for argument tables, private results, pagination and recovery, and the
[MCP guide](https://hourmere.com/docs/mcp) for tool semantics.
Report bugs on [GitHub](https://github.com/hourmere/hourmere/issues).

### Mark attendee no-shows

`set-no-show` uses JSON input with `bookingId`, `attendeeId` and `noShow` (`true`
to mark, `false` to unmark). Read attendee IDs from authenticated booking lists.
It requires `bookings` or `full` scope and booked-host authority in the current organization.
Only bookings whose scheduled start has passed can be changed; cancelled and imported
records refuse changes. Confirmed paid records are readable, but changes return
`paid_booking_management_unavailable`. Repeating the same state preserves its timestamp and actor.
No invitee email or manage-page indicator is added, and existing follow-ups remain scheduled.

`booking-attendees` takes `{ "bookingId": "…" }` and returns attendee IDs and
markers. It accepts `read`, `bookings` or `full` keys with the same booked-host
permission. Team owner/admin status does not grant CLI access to bookings hosted by
other members: these return `booking_not_found`, just as missing bookings do. Non-host
team administration requires a browser session. Reads are available before the start
and after cancellation.

### Booking activity

`booking-activity` takes `{ "startDate": "2026-10-01", "endDate": "2026-10-31",
"timeZone": "Europe/Berlin" }` (inclusive local dates, at most 90) and prints the same
report as `GET /api/v1/analytics/bookings`: daily and total `created`, `rescheduled`,
`cancelled` and `noShows`. It requires a `read` or `full` key held by the personal owner
or a team owner/admin; other callers get `insufficient_role`. See
[booking activity](https://hourmere.com/docs/analytics) for each count's definition.

## Organization branding

```sh
hourmere branding get
printf '%s' '{"brandPrimaryColor":"#123456"}' | hourmere branding set --input -
hourmere branding upload --file logo.png --content-type image/png
```

Reads require `read` or `full` API key scope; writes require `full`. The personal owner
or team owner/admin must own the key. `branding set` accepts an uploaded `brandLogo`
SHA-256 reference and/or `brandPrimaryColor` (`#RRGGBB`); omission preserves a field,
and `null` clears it. Black or white button text is chosen for readable contrast.

`branding upload` sends raw bytes over REST, immediately attaches the image and prints
the saved settings. PNG, JPEG and WebP are accepted, at most 512 KiB and 2048 pixels per
side; images are decoded and re-encoded as PNG. SVG and animation are rejected. The
server enforces all limits. These settings are stored only; public booking pages and
emails do not yet apply the theme.

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE).

### Export bookings

`hourmere export --input export.json --output bookings.csv` streams CSV into a new
0600 file. Omit `--output` to stream CSV to stdout (including pipes); output writes
apply backpressure. Existing files are refused. A failed download can leave a partial
file; remove that file before retrying. The command never retries automatically.

Example `export.json`:

```json
{"from":"2026-11-01T00:00:00Z","to":"2026-12-01T00:00:00Z","timeZone":"America/Los_Angeles","bom":true}
```

The range is at most 366 days. Optional `status`, `eventTypeId`, `hostUserId`,
`endAfter`, `endTo` and `order` match export/list filtering. `bom` defaults to false;
choose true for Excel. Requires a `read` or `full` key and personal ownership or
team owner/admin permissions. The MCP call returns a small pointer; the CLI streams
its same-instance authenticated REST download without buffering the CSV in memory.
Files contain attendee personal data; store and share them privately. See
[CSV exports](https://hourmere.com/docs/booking-export) for columns and limitations.


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

## Public meeting polls

Use `hourmere polls view|join|recover|verify|vote|withdraw|reminder-opt-out --input -`.
All poll JSON input must come from stdin; input files, capability flags and `--output`
are refused. Never paste capabilities into shell arguments or command history. `view`
needs a `read`, `bookings` or `full` API key; writes need `bookings` or `full`.
The CLI uses authenticated MCP. The public REST endpoints also permit no-login access.

`view` and `verify` use `{ "token": "…" }`; `join` uses `publicToken`, `name`, `email`,
`timeZone` and optional `locale`. `recover` needs only `pollId` and `email`, without a
valid token, and returns the same accepted response for unknown mailboxes. `vote` takes
the voting token, complete `votes` with `slotId`/`value`, `consent: true`, optional
`responses` and `expectedBallotRevision`; `withdraw` takes the token and revision.
`reminder-opt-out` uses the separate token from the email. `verify` prints a newly minted
`votingToken` once to stdout; keep it private (it is also emailed). Input tokens and error
diagnostics are redacted. Calls never retry automatically; read and reconcile after
`poll_changed`. These public operations are available without a feature flag; host
creation/lifecycle commands and the browser ballot page are not available yet.

中文：公开会议投票命令为 `hourmere polls view|join|recover|verify|vote|withdraw|reminder-opt-out --input -`。
所有 JSON 参数只能从标准输入读取，拒绝文件输入、令牌命令行参数和 `--output`。
不要把令牌放入 shell 参数或历史。读取需要 `read`、`bookings` 或 `full` 密钥，
写入需要 `bookings` 或 `full`。CLI 使用已认证的 MCP；公开 REST 也支持免登录。
找回只需投票 ID 与邮箱，无需有效令牌；验证首次返回的新投票令牌须保密，邮件也会发送。
只提交投票者明确同意的完整选择和当前选票版本，遇到 `poll_changed` 应重新读取核对，
不要自动重试。目前无功能开关，管理端命令和浏览器投票页面尚未提供。

## Duplicate an event type

Save `{ "id": "EVENT_TYPE_UUID" }` in `duplicate.json`, then run
`hourmere duplicate-event --input duplicate.json` with a `full` API key.
The response contains the new event and its unique booking slug. It copies editable
settings within the current space, with the same owner/admin permission as creation.
Bookings, history, statistics and one-time links are excluded; round-robin activation
starts off. Each successful call makes another copy. After a lost response, use `catalog`
to check before retrying. See [event types](https://hourmere.com/docs/event-types).
