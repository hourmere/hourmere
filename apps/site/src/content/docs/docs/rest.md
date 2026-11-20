---
title: REST quickstart
description: Use an Hourmere API key to find a slot, book it and manage the booking.
---

## Prepare a host and key

Run your own [instance](/docs/self-hosting), sign in, and open **Event types** in your personal
space. The setup guide orders your profile (including display name), default availability,
first event type and booking link. Calendar connection is optional. After completing your
profile, you can confirm Monday–Friday 09:00–17:00 in its time zone directly in the guide;
adjust existing schedules in **Availability**. The guide hides when these basics are ready,
and the event list keeps the links to open and copy. For the examples below the booking
page is `/ada/intro`. Replace it with your own handle/slug.

For API setup, `POST /api/v1/schedules/default` with `{}` confirms those starter hours after
the stored profile and display name are set. It returns 201 for creation or 200 with the
unchanged existing default on retries, including concurrent submissions. It never overwrites
an existing schedule; schedules without a default require an explicit default choice
(`409 setup_default_schedule_required`). A missing profile or display name returns
`409 setup_profile_required`. An existing default still needs valid weekly hours before the
guide counts availability as complete.

API-key setup/configuration writes require `full` scope. The booking examples below work
with the recommended `bookings` scope after setup is complete.

Pass the current account interface language as `{ "language": "en" }` or
`{ "language": "zh-CN" }` to name a newly created schedule in that language. Omitting it
uses English. The profile still supplies the time zone; later language changes never
rename an existing schedule.

Open **API keys** at `/app/api-keys`, choose the intended organization and scope, create a key
and copy it once into your secret store. **Bookings** (`bookings`, the default) is recommended
for AI booking agents; **Read** (`read`) suits analytics/reporting and cannot mutate bookings.
**Full account access** (`full`) also permits account configuration changes; grant it only to
trusted software. Scope is immutable: create a replacement and revoke the old key to change
it. Legacy keys and API creations omitting `metadata.scope` retain `full`. See
[API keys](/docs/api-keys) for creation details and the generated operation table.
It acts as its creator in that organization. Keep API keys and
booking manage tokens out of URLs, shared transcripts and source control. Set these shell
variables privately (placeholders below are not working credentials):

```sh
export HOURMERE_URL='http://localhost:3000'
export HOURMERE_API_KEY='<your API key>'
```

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/me" \
  -H "Authorization: Bearer $HOURMERE_API_KEY"
```

Use `/api/v1/openapi.json` on your instance as the full request/response reference. Strict
request schemas reject unknown fields. Errors use `{ "error": "stable_code", "message": "…" }`.

## Read workflow run history

The [workflow operating guide](https://github.com/hourmere/hourmere/blob/main/docs/workflows.md#rest-mcp-and-cli-operations)
lists the published workflow operations and includes a synthetic preview request.

`GET /api/v1/workflows/{id}/runs` returns `{data, nextCursor}` to the personal owner or
current team owner/admin in their acting organization. API keys need `read` or `full`.
Missing and inaccessible workflows share `404 workflow_not_found`. Set `limit` to 1–100
(default 50) and reuse the returned `nextCursor` as `cursor` for the same workflow. Finished
runs appear newest first with fixed outcomes, timestamps and aggregate recipient counts.
History omits booking IDs, names, email addresses, answers and URLs. Workflows are currently
unavailable, so callers with allowed credentials receive `404 workflows_disabled`.

中文：个人所有者和当前团队所有者、管理员可在当前组织读取工作流执行历史，需要
`read` 或 `full` 密钥。历史记录按完成时间从新到旧排列，默认 50 条，最多 100 条。
用返回的 `nextCursor` 继续读取同一工作流。结果不含预约 ID、姓名、邮箱、回答或链接。
功能仍硬关闭，允许调用的身份收到 `404 workflows_disabled`。

## Manage meeting polls

Read managed polls at `GET /api/v1/meeting-polls`, `/{id}` and `/{id}/results` under the
same collection path. List pages default to 50 polls, up to 100. Pass the returned
`nextAfter` as `after` for the next page. The personal event owner or current team
owner/admin can read with a `read`, `bookings` or `full` key in the acting organization.
The results contain private voter data and advisory candidate availability. Treat
`unknown` as a neutral status and keep the roster private.

A `bookings` or `full` key can create, close, cancel, finalize or delete a managed poll,
manage its roster and rotate its public link. Session writes require the opening
organization in `X-Expected-Organization-Id` and a same-origin request.

Create with `POST /api/v1/meeting-polls` and an `Idempotency-Key` header. Submit
`eventTypeId`, `candidateStarts`, `deadlineAt`, `displayTimeZone` and `admissionMode`.
The 201 response includes `poll` and `publicLink` (null in invited mode). Store the link
securely on receipt. Exact replay returns 409 `poll_already_created` with `pollId`.
To replace a lost or shared link, POST to `/{id}/rotate-link` with the current
`expectedHostRevision` and a new idempotency key. The old link stops working immediately.
Invited polls return 409 `poll_link_unavailable`.

POST `/{id}/invitations` with an idempotency key and up to 40 `invitees` (name, email,
optional locale and time zone). A 202 response reports each supplied address's outcome.
Exact retries report current outcomes without more mail. POST
`/{id}/invitations/{voterId}/resend` with a revision and idempotency key to reissue a
retained invitation. DELETE `/{id}/voters/{voterId}` removes one voter and POST
`/{id}/remove-unverified` removes unverified public enrollments while preserving host
invitations. Both require `expectedHostRevision`. Creation, invitation and resend share
one host admission limit. A 429 may include `Retry-After`.

Send `expectedHostRevision` in the JSON body for close, cancel and delete. Finalize uses
`expectedResultsRevision`, each selected voter's `expectedBallotRevisions`, and an
explicit `acknowledgeConditional` for a selected `if_need_be` vote. Send and retain a
random `Idempotency-Key` header. A successful first call returns 201 and an exact retry
returns 200 with the current booking metadata. The response omits booking management
credentials. A different key on an already scheduled poll returns 409 with the
current poll's safe metadata. Deleting a poll returns 204 and preserves any linked booking.

中文：个人活动所有者和当前团队所有者或管理员可在当前组织中读取投票、名单和结果。
读取接受 `read`、`bookings` 或 `full` 密钥。关闭、取消、删除和确认预约需要
`bookings` 或 `full`。关闭、取消和删除使用主持人版本，确认预约使用结果版本和入选者
的选票版本，并需明确接受入选者的条件票。请保留随机 `Idempotency-Key` 以原样重试。
候选时段的可用性仅供参考，确认预约时会再次检查。预约信息不含管理凭证，删除投票会
保留关联预约。创建、邀请、重发及轮换链接需要保留随机 `Idempotency-Key`。
公开链接仅在创建或轮换首次成功时返回，轮换后旧链接立即失效。受邀模式没有公开链接。
邀请响应仅报告本次提交的邮箱，重试不重复发信。移除未验证报名者会保留主持人发出的邀请。

## Instance capabilities

`GET /api/v1/instance` includes additive `ssoOidcEnabled` and `ssoSamlEnabled`
booleans. Both are currently `false`: organization SSO is unavailable, including on
self-hosted instances, and no environment setting enables it yet. Older servers may
omit these fields; clients should treat absence as unknown, keep SSO entry points hidden and
tolerate unknown response fields. No SSO operations are exposed in this release.

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

Create an event type with `POST /api/v1/event-types` or edit it with
`PATCH /api/v1/event-types/{id}`. Set `durationMinutes` to the default and
`allowedDurationsMinutes` to the complete list of allowed lengths, kept in ascending order, for example
`{ "durationMinutes": 30, "allowedDurationsMinutes": [15, 30, 60] }`.
The list must contain 1–12 distinct whole-minute values from 1 to 1440 inclusive and include
the default. Supplied lengths are sorted before storage. Creation also requires `slug` and `title`; omitting the list creates
`[durationMinutes]`. These configuration writes require a `full` API key.

On a multi-length type, send both fields to change the default to a length outside the
saved list. Omitting the list on update preserves it, except that a duration-only edit
of a single-length type also replaces its sole allowed length. Invalid values return
`400 invalid_event_type`; malformed request shapes return `400 invalid_request`.
The [multiple meeting lengths guide](/docs/multiple-durations) covers the editor,
invitee choices, rescheduling and shared-rule limits.

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

Event-type create/PATCH accepts `successRedirect`, and protected reads return the saved
configuration. Writes require `full` key scope. Omit the field to preserve it; send `null`
to clear it. See [after-booking redirects](/docs/after-booking#rest) for the complete object,
field errors, privacy warning and policy-change behavior.

## Configure reminders and follow-ups

See [Reminders and follow-ups](/docs/reminders-and-follow-ups) for editor steps, timing,
recipients and known limitations.

Use a `full` API key and an event-type ID from `GET /api/v1/event-types`. Protected event
reads include `notifications`. To replace only that setting:

```sh
curl --fail-with-body -X PUT "$HOURMERE_URL/api/v1/event-types/<event-type-id>/notifications" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"notifications":{"reminders":[{"id":"one-day","offsetMinutes":1440,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[{"id":"thanks","offsetMinutes":60,"recipients":{"invitee":true,"guests":false,"host":false},"hostNote":"Thank you for your time."}]}}'
```

The response is the full event type. Creation and PATCH also accept optional
`notifications`; omission keeps creation defaults or the saved value respectively. A
replacement must include both arrays. Personal types require their owner and team types
an owner or admin; `bookings` and `read` keys cannot write these settings. Saves affect
only new bookings and send no immediate mail. Read the
[complete validation contract](/docs/api-conventions#event-type-notification-settings)
and [host-note operating policy](/docs/notifications#host-notes-and-hosted-email-abuse-controls)
before enabling follow-ups or host-written text.

## Create one-time links

Use `POST /api/v1/event-types/{eventTypeId}/one-time-links` with optional `expiresAt`
and `prefill`, then save the creation response's URL privately. It is shown once.
List safe metadata with GET on the same path; revoke with DELETE on its `/{id}` path.
Create and revoke require `bookings` or `full`, while list/get allow `read` and `full`.
An exact `Idempotency-Key` retry never creates a second link and returns
`409 one_time_link_already_created` because the URL cannot be recovered.
See [one-time booking links](/docs/one-time-links) for examples, permissions and limits.

## Generate an email snippet

`POST /api/v1/open-time-snippets` accepts exactly one of `eventTypeId` or `slug`,
required `from`/`to` instants (at most 31 elapsed days), and optional `count` (1–10, default 3),
`locale`, `displayTimeZone` and `durationMinutes`. It returns chosen `slots` with direct
links plus `text` and `html`. Personal owners and team owners/admins can use `read`,
`bookings` or `full` keys when `SLOT_SNIPPETS_ENABLED` is enabled. It reserves nothing.
When off (the default), a valid authenticated request returns HTTP 404 with
`{"error":"slot_snippets_disabled"}`.
See [the agent guide](/docs/open-time-snippets) for a complete curl example, response
fields, date boundaries and taken-time fallback.

## Explain why times cannot be booked

`GET /api/v1/event-types/{id}/availability-troubleshooting?date=YYYY-MM-DD` lists every
possible start time of one local day with `status` and ordered reason codes such as
`outside_working_hours`, `calendar_busy`, `buffer_after` or `daily_limit`. Optional
`timeZone` (default: your profile time zone) and `durationMinutes`. Personal owners and team
owners/admins only, with a `full` key; everyone else gets `404 event_type_not_found`. Reasons
never include calendar event titles or booking details. See
[Troubleshoot availability](/docs/availability-troubleshooting) for the response and limitations.

## Find a time

Choose a future UTC range within the event type's booking window, at most 62 days.
The public slots endpoint returns UTC instants:

```sh
curl --fail-with-body --get "$HOURMERE_URL/api/v1/public/ada/intro/slots" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode 'start=2026-11-02T00:00:00Z' \
  --data-urlencode 'end=2026-11-04T00:00:00Z'
```

Adjust these example dates so they remain in the future. Take the desired returned slot's
`start` unchanged. For local date/time-zone queries, the MCP `find_available_slots` tool
performs that conversion. A selected Google calendar with missing, failed or stale sync yields
`calendar_sync_unavailable`; fix or deliberately disable that calendar instead of assuming
unknown busy data is free.

An event type with several lengths includes `allowedDurationsMinutes` in its public event
details. Add `durationMinutes=<allowed length>` to the slots query and the same numeric
`durationMinutes` to the booking JSON to select that length. Omission uses the event type's
default `durationMinutes`; a length outside the allowed list returns `400 invalid_duration`.
The personal and `/api/v1/public/teams/{handle}/{slug}` endpoints share this contract.

## Create and manage one booking

For reporting, [export bookings as CSV](/docs/booking-export) using
`GET /api/v1/bookings/export.csv`. A `read` or `full` key and a bounded date range are
required for personal exports. Team exports require a verified browser session and current
owner/admin membership, and use the limited team-admin field set. Team API keys and OAuth
credentials cannot export team data.

Bookings send email to the host/invitee when workers are enabled. Additional guests require
the host to enable `allowGuests` on the event type (off by default, at most ten). Otherwise
nonempty `guests` return `400 guests_not_allowed`. Existing guests keep receiving updates
and cancellations after the host disables new guests. Use
an address you control for a test. Use a new idempotency key per intended booking and keep
the same body/key for retries:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/public/ada/intro/bookings" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <new random UUID>' \
  -d '{"start":"<chosen slot start>","invitee":{"name":"Test Invitee","email":"<your test address>","timeZone":"America/Los_Angeles"}}'
```

Set optional `invitee.locale` to a BCP 47 tag such as `zh-CN` for notification language.
Supported tags use the [shared locale registry](/docs/interface-languages); unsupported
languages and missing translations fall back to English. MCP and CLI accept the same field.
The saved language survives retries, reschedules and cancellation, independently of `timeZone`.

Save the returned `manageToken` privately. Only its hash is stored; it is returned once. A
same-key retry returns HTTP 200 (rather than 201) with the original booking and
`manageToken: null`. Reusing the key with different arguments fails with `idempotency_key_reused`; use a new key for a genuinely new booking.

The public booking and invitee management endpoints do not require an API key; when one is
supplied, it must be valid and allow the operation, in addition to the independent manage
token where required. Invalid keys get 401 and disallowed scopes get `403 insufficient_scope`,
without falling back to anonymous access or a session cookie. A credential-free public
request retains its existing capabilities. The examples include a key for consistency with
the authenticated calls above. A public create request's
idempotency key uses the shared anonymous namespace for that organization, so make it random.
For invitee management send the manage token in a header. Choose a new
available slot for rescheduling; it returns a replacement booking and a new manage token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/reschedule" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"start":"<new slot start>"}'
```

Use the new token for subsequent operations. Cancelling with the current token:

```sh
curl --fail-with-body "$HOURMERE_URL/api/v1/bookings/manage/cancel" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  -H "X-Manage-Token: $HOURMERE_MANAGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Test cleanup"}'
```

An API response token stays with the cancelled booking after an invitee move and follows
host moves. The token in a booking email always follows the reschedule chain. Treat both as credentials. The public management page carries email tokens
in a fragment (`/booking#token=…`); API calls use headers, never query parameters. Set `HOURMERE_MANAGE_TOKEN` privately to the
current returned token before running either management example.

`GET /api/v1/bookings/manage/slots?start=…&end=…` uses the booking's original length,
including after the host changes the event default or removes that length. An optional
`durationMinutes` query parameter selects a current allowed length instead; send the same
number in the reschedule JSON. Omitting it from reschedule preserves the original length.
The response's `start` and `end` always describe the actual booked interval.

List the key owner's hosted bookings with `GET /api/v1/bookings`. A key does not grant access
to arbitrary hosts' private bookings. Results default to ascending start time and ID; request
`order=desc` for newest first. Pass `nextCursor` as `cursor` and keep the time filters and
order unchanged for every page. Rate limits return `429` and `Retry-After`; slot races
return `slot_taken` or `slot_unavailable`. Recheck availability before retrying with a new key.

Read one hosted booking with `GET /api/v1/bookings/{id}`. With stored routing provenance,
the response includes `routing` with `formId`, `versionId`, `versionNumber`, `matchedRuleId`,
`resolvedRuleId`, `questions` and `answers`. `questions` keeps the original labels and
select options. `answers` is keyed by routing question ID, with option IDs for select
answers. The booking's final answers are in `responses`.

Current hosts in the booking's organization can use a session or a `read`, `bookings` or
`full` API key. A verified browser session in the current team also lets owners and admins
who do not host the routed booking read its `id` and `routing` fields. The stored snapshot
is available while routing forms are disabled. Ordinary booking details, booking lists
and the team administration endpoints omit `routing`.

中文：`GET /api/v1/bookings/{id}` 在已保存路由快照的预约详情中返回 `routing`。当前组织的主持人
可以读取完整详情。未主持预约的团队所有者和管理员可通过当前团队的浏览器会话读取 `id` 和 `routing`。
路由表单停用后仍可读取已保存的快照。普通预约、预约列表和团队管理接口省略该字段。

Team owners/admins can use `GET /api/v1/team/bookings` with a verified browser session in
the current team. It includes bookings hosted by other members and returns only the team
administration fields: ID, status, times, cancellation time, event ID/title, saved host
IDs/names and attendee contact/time-zone/booker fields. API keys, personal organizations
and ordinary members receive `403 team_management_access_denied`. The endpoint uses the
same time/status filters and opaque cursor pagination as the host list; keep filters and
order unchanged between pages. Collective bookings appear once. No answers, private
management links, calendar copies or conference links are returned.

To move a booking you host, read `GET /api/v1/bookings/{id}/slots?start=…&end=…`, then
send `POST /api/v1/bookings/{id}/reschedule` with JSON `{ "start": "<chosen slot start>" }`.
Both require a session or API key in the booking's organization. Slots ignore the current
booking, so the new time may overlap it. A host move returns the successor booking with
`manageToken: null` and preserves existing invitee links. The web booking detail page uses
these same public APIs. Do not retry a move automatically; inspect your booking list if
the answer is lost.

Host slot queries and reschedule JSON accept the same optional `durationMinutes`, with
the same original-length default and current-allowed-list validation as invitee moves.

Team owners/admins can also read `GET /api/v1/team/invitations` using a verified browser
session in the current team. It returns paginated invitation lifecycle and safe current
delivery state, attempts, fixed error classification and current resend eligibility.
Expiry uses the database clock. API keys and OAuth are denied, including alongside a
session cookie. See the [field, pagination and error contract](/docs/api-conventions#team-invitation-delivery-summaries).

Host cancellation uses `POST /api/v1/bookings/{id}/cancel` with an optional `reason`
(at most 1000 characters). The caller must host the booking in the acting organization;
team-admin status alone is insufficient for API keys and MCP. Host cancellation and moves
bypass invitee change deadlines, but refuse started or imported read-only bookings.
Cancellation retains the record and sends ordinary cancellation notifications.

## Search the booking list

`status=cancelled` lists only cancelled bookings, a page at a time like every other view.
It includes bookings replaced by a reschedule; their `rescheduledToId` points to the new
booking when the caller can access that successor. `status=confirmed` lists confirmed
bookings; omitting `status` includes both confirmed and cancelled records.

`q` searches the list you already have access to. A booking matches when the invitee's name
or email, or the title of its event type, contains the text, ignoring case:

```sh
curl --fail-with-body -G "$HOURMERE_URL/api/v1/bookings" \
  -H "Authorization: Bearer $HOURMERE_API_KEY" \
  --data-urlencode "status=cancelled" --data-urlencode "q=ada@example.com"
```

- The text is trimmed and may have at most 100 UTF-16 code units; longer text or control
  characters return `400 invalid_request`. Blank text means no search.
- `%`, `_` and `\` match themselves; there are no wildcards.
- Search only narrows the list you already see. It never adds bookings outside it: on the
  host list, bookings you do not host or from another organization; on the team list
  (`GET /api/v1/team/bookings`, which accepts the same `status` and `q`), bookings from
  another team.
- Keep `q`, `status`, the time filters and `order` unchanged while following `nextCursor`.
  Ordering stays by start time and ID in the same direction, including equal start times.
  Pages are live, not a fixed snapshot: rows added or changed behind the cursor require
  a fresh list to see. A booking cancelled behind the cursor leaves a `status=confirmed`
  list and shows in `status=cancelled` from its first page.

Known limitations: search matches the invitee who booked, not guests; the current title
of an event type that still exists, not stored booking titles, answers or notes; and whole
substrings, without typo tolerance or accent folding. Letter case is ignored according to
the database's locale. CSV export does not take `q`, so the web app offers the export only
when no search is applied.

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

Event-type creation and updates accept `maxBookingsPerDay`, `maxBookingsPerWeek` and
`maxBookingsPerMonth`: whole numbers from 1 to 1000, or `null` for no ceiling.
Omitted update fields preserve the saved setting. Configured allowances must satisfy
day ≤ week ≤ month, comparing each pair that is set, including day/month without a
weekly limit. Event-type reads return all three settings. API keys need `full` scope
for configuration writes. See [booking limits](/docs/booking-limits) for REST, MCP and
CLI examples, host schedule time zones, Monday-based weeks, calendar months and
counting rules. Lowering a ceiling does not cancel existing bookings.

## Configure reschedule and cancel deadlines

Event-type creation and updates accept `rescheduleCutoffMinutes` and
`cancelCutoffMinutes`: whole numbers from 1 to 525600, or `null` for no deadline.
From that many minutes before the start, the invitee can no longer reschedule or
cancel with `X-Manage-Token` (409 `booking_reschedule_deadline_passed` or
`booking_cancel_deadline_passed`); hosts are not limited. Each booking keeps the
values that applied when it was booked, and `GET /api/v1/bookings/manage` returns them
as ISO instants: `changeDeadlines.rescheduleBy` is the effective reschedule deadline,
and `changeDeadlines.cancelBy` is the cancel deadline. `rescheduleBy` is null only when
both settings are null. See
[reschedule and cancel deadlines](/docs/change-deadlines) for examples and limitations.

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

## Record attendee no-shows

[Marking no-shows](/docs/no-shows) records private per-attendee attendance after the
scheduled start. Use REST `PATCH /api/v1/bookings/{id}/attendees/{attendeeId}/no-show`,
MCP `set_attendee_no_show`, or CLI `set-no-show` with `bookingId`, `attendeeId` and
`noShow`. API keys require `bookings` or `full` plus booked-host authority. API keys
of every scope and MCP OAuth can read or mark attendees only on bookings the caller
hosts in the current organization. Non-host team owners/admins need a browser session;
agent credentials receive `booking_not_found`, just as for a missing booking.
Invitee pages and messages are unchanged, including scheduled follow-ups.

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

Send `POST /api/v1/event-types/{id}/duplicate` with an empty JSON object and a `full`
API key. The HTTP 201 response is the newly created event, with its own unique booking
slug. The same owner/admin and configuration checks as creation apply. The copy stays
in the current organization. See [event types](/docs/event-types) for copied settings,
excluded history and links, and retry behavior. Existing create defaults are unchanged.
