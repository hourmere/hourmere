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

`--output` reserves a new private file (`0600`) before the request, saves the returned
management token, and writes only `{"outputWritten":true}` to stdout. Existing files and
symlinks are refused. Keep request/result files private and out of Git. Without `--output`,
stdout contains JSON with API keys and management tokens redacted; other private booking
data can still be present.

Use `reschedule` or `cancel` with `bookingId` for a booking you host, or `manageToken` for
invitee authority. These commands act immediately and can send notifications. Calls are
never automatically retried. After a lost booking response, inspect the instance and reuse
the retained request and idempotency key; **rescheduling is not idempotent**.

## Commands

`whoami`, `profile`, `catalog`, `event`, `schedules`, `schedule`, `slots`, `book`, `list`,
`reschedule`, `cancel`, `retry-meeting`, `retry-calendar-copy`.

Discovery results use bounded pages: pass `nextAfter` as `after`, or a booking list's
`nextCursor` as `cursor`, keeping all filters unchanged. Errors are JSON on stderr.
Exit codes: `0` success, `1` usage/input/domain/protocol error, `3` transport failure.

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
