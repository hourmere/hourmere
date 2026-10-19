# Command-line client

The repository includes a Node.js 26 CLI for API-key users. It calls the existing stateless
MCP tools at `/mcp`, using Node's built-in HTTP client with no additional dependencies.
This preserves the key's organization, permissions, idempotency scope and `mcp` audit source,
including host rescheduling, without introducing another booking API.

Run it from the repository (there is no published npm package or global installation):

```sh
export HOURMERE_URL=https://hourmere.example.com
# Supply HOURMERE_API_KEY from your secret manager or an existing private environment.
npm run --silent cli -- whoami
npm run --silent cli -- catalog
npm run --silent cli -- --help
```

The standalone **`@hourmere/cli`** package is prepared for an owner-approved first release.
After publication, install it with `npm install --global @hourmere/cli` and use
`hourmere whoami`, `hourmere --help` and `hourmere --version`. See the
[npm README](../tools/cli/README.md) and [release procedure](releasing.md) for the tarball
checks and owner approval requirements.

Create an API key on `/app/api-keys` in the intended organization. The CLI reads only
`HOURMERE_URL` and `HOURMERE_API_KEY`; it does not load `.env`, browser sessions or stored
credentials. Do not put a key into shell history. `--url ORIGIN` overrides `HOURMERE_URL`.
Use an HTTPS origin with no credentials, path, query or fragment. HTTP is accepted only for
`localhost`, `127.0.0.1` or `[::1]` development instances. Redirects are refused before a key
can be forwarded. Requests time out after 30 seconds and are never automatically retried.

## Commands and JSON arguments

Arguments are the corresponding [MCP tool's](mcp.md#tools) JSON object. Supply them with
`--input FILE` or `--input -` for standard input. No input means `{}`. Secrets and attendee
data need not appear in process arguments or shell history. Input files must be regular
files (symlinks are refused); input is limited to slightly less than 2 MiB to leave room
for the MCP envelope. The server enforces the tool's full schema and domain rules.

| Command | Tool | Arguments |
|---|---|---|
| `whoami` | `whoami` | `{}` |
| `profile` | `get_profile` | `{}` |
| `catalog` | `list_event_types` | optional `limit`, `after` |
| `event` | `get_event_type` | `id` from `catalog` |
| `schedules` | `list_schedules` | optional `limit`, `after` |
| `schedule` | `get_schedule` | `id` from `schedules` |
| `slots` | `find_available_slots` | `handle` or `teamSlug`, `slug`, `timeZone`, `startDate`, `endDate`; optional `maxSlots`, `after` |
| `book` | `create_booking` | `handle` or `teamSlug`, `slug`, `start`, `invitee`, **`idempotencyKey`**; optional `responses`, `guests` |
| `list` | `list_bookings` | optional `from`, `to`, `status`, `order`, `limit`, `cursor` |
| `reschedule` | `reschedule_booking` | `start` and exactly one of `bookingId`, `manageToken` |
| `cancel` | `cancel_booking` | exactly one of `bookingId`, `manageToken`; optional `reason` |

`catalog` includes the key's visible team and personal configurations. Booking and slot
commands accept exactly one of `handle` (personal link) or `teamSlug` (team link). Team
slugs keep their stored case; collective types require every configured host. Activated
round-robin types offer the union and assign one available host; `book` returns its safe
`assignedHost` name/time zone. Replaying the same JSON/key retains the selection. See
[round-robin scheduling](round-robin-scheduling.md) for explicit activation and fairness. `reschedule` and `cancel` by ID require hosting that booking in the key's
organization. A management token instead acts as the invitee. These operations can send
the same notification emails and calendar updates as the booking page.

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

Keep all filters unchanged when continuing a page. Catalogs and slots return `nextAfter`;
pass it as `after` until null. Booking lists return `nextCursor`; pass it as `cursor` until
null. The CLI makes one bounded request per invocation, rather than silently fetching an
unlimited list. Availability can change between pages and before booking.

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
the CLI never prints management capabilities. Other returned information, such as attendee
email addresses, remains private booking data: redirect it only to destinations you trust.

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

A failure after the call begins includes `outcomeMayBeUnknown: true`. A reserved result
file can remain empty or incomplete after a failed call or write: do not treat it as a
successful booking, and retain the original request. Inspect the server before retrying.

- For a lost **book** response, repeat the exact request with the same key and
  `idempotencyKey`. A committed booking replays with `manageToken: null`; it cannot return
  the original secret again. Hosts can use `list` and booking IDs; invitees need their
  notification email's management link if the original response was lost. Use a new output
  filename for each attempt. A different request with the same key gets
  `idempotency_key_reused`.
- **Rescheduling is not idempotent.** Never retry automatically. Inspect `list` and
  `rescheduledFromId` first. The previous booking ID points to a cancelled booking. A
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
actual host's own API key; the CLI has no account-selection tool. A claimed create
with no validated ID remains ambiguous: retry does not issue another POST or adopt a guessed
meeting. Inspect/remove any orphan in Zoom before replacing the booking. Personal and
individual single-host team events are supported; collective/round-robin automatic Zoom
requires a later per-host policy. See [automatic-zoom.md](automatic-zoom.md).
