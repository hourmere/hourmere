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
the retained request and idempotency key; **rescheduling is not idempotent**.

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
when the operator enables `SLOT_SNIPPETS_ENABLED`. See [the agent guide](https://hourmere.com/docs/open-time-snippets) for
response fields, DST boundaries, no-times errors and the booking page's taken-time fallback.

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

`whoami`, `profile`, `catalog`, `event`, `create-event`, `update-event`,
`set-event-notifications`, `schedules`, `schedule`, `slots`, `open-time-snippet`, `book`, `list`, `reschedule`,
`cancel`, `retry-meeting`, `retry-calendar-copy`.

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

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE).

### Mark attendee no-shows

`set-no-show` uses JSON input with `bookingId`, `attendeeId` and `noShow` (`true`
to mark, `false` to unmark). Read attendee IDs from authenticated booking lists.
It requires `bookings` or `full` scope and booked-host or team owner/admin authority.
Only bookings whose scheduled start has passed can be changed; cancelled and imported
records refuse changes. Repeating the same state preserves its timestamp and actor.
No invitee email or manage-page indicator is added, and existing follow-ups remain scheduled.

`booking-attendees` takes `{ "bookingId": "…" }` and returns attendee IDs and
markers. It accepts `read`, `bookings` or `full` keys with the same host/team-admin
permission. Team admins can obtain a booking ID from the team dashboard; ordinary
`list` visibility is unchanged. Reads are available before the start and after cancellation.
