# Hourmere CLI

Command-line scheduling for [Hourmere](https://hourmere.com), an open-source scheduling
service for people and AI agents. Connect to your own Hourmere instance with an API key.
The CLI uses the instance's existing MCP tools over HTTPS and needs no runtime dependencies.

## Install

Requires **Node.js 26 or later**. Once the owner publishes the first release:

```sh
npm install --global @hourmere/cli
hourmere --help
hourmere --version
```

This package is being prepared for its first release. The repository's `0.0.0` version is a
placeholder; the owner stamps the approved release version before packing and publishing.

## Connect

Create an API key in your instance at **App → API keys** (`/app/api-keys`), selecting the
organization you want to use. Set `HOURMERE_URL` to the instance origin, without `/mcp`.
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

See the [complete CLI guide](https://github.com/hourmere/hourmere/blob/main/docs/cli.md)
for argument tables, private results, pagination and recovery, and the
[MCP guide](https://github.com/hourmere/hourmere/blob/main/docs/mcp.md) for tool semantics.
Report bugs on [GitHub](https://github.com/hourmere/hourmere/issues).

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE).
