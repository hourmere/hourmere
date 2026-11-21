# Meeting poll API guide

Use meeting polls to find a time that works for a group, then confirm a regular
booking from the poll. See the [host dashboard guide](https://hourmere.com/docs/meeting-polls)
and [voter guide](https://hourmere.com/docs/meeting-poll-voting) for the browser flows,
privacy and limits. For worker setup, retention and secret recovery, see the
[self-hosting guide](https://hourmere.com/docs/self-hosting#meeting-poll-credentials-and-recovery).

## Connect and choose a scope

- **REST:** use the [instance's OpenAPI document](api-conventions.md) at
  `/api/v1/openapi.json`. Host operations require authentication. For session writes,
  send the same-origin request with `X-Expected-Organization-Id` set to the space where
  the action began. Voter operations accept unauthenticated requests or an optional key.
- **MCP:** connect to `/mcp` following the [MCP setup guide](mcp.md), then use
  `tools/list` to discover the schemas for your connection. Voter tools also require
  an authenticated connection.
- **CLI:** configure `HOURMERE_URL` and `HOURMERE_API_KEY` as described in the
  [CLI guide](../tools/cli/README.md). It calls MCP. Pass poll JSON on stdin with
  `--input -` and read the result from stdout. Keep capabilities, keys and private
  contact details out of arguments, shell history and captured output.

API keys with `read`, `bookings` or `full` scope can read. Writes require `bookings`
or `full`. A host caller also needs current management authority in the acting
space. The event owner manages a personal poll, and a current team owner or admin
manages a team poll. A voter caller needs the relevant capability even when using
an authenticated connection. Recovery takes a poll ID and email address and delivers
only to the eligible mailbox.

## Operations

The last column is the command after `hourmere polls`. For MCP and CLI, provide the
REST path IDs and query fields in the JSON input. For operations that take an idempotency
key, move the REST `Idempotency-Key` header into the MCP and CLI input as `idempotencyKey`.

### Host

| REST | MCP tool | CLI |
|---|---|---|
| `POST /api/v1/meeting-polls` | `create_meeting_poll` | `create` |
| `GET /api/v1/meeting-polls` | `list_meeting_polls` | `list` |
| `GET /api/v1/meeting-polls/{id}` | `get_meeting_poll` | `get` |
| `GET /api/v1/meeting-polls/{id}/results` | `get_meeting_poll_results` | `results` |
| `POST /api/v1/meeting-polls/{id}/invitations` | `invite_meeting_poll_voters` | `invite` |
| `POST /api/v1/meeting-polls/{id}/invitations/{voterId}/resend` | `resend_meeting_poll_invitation` | `resend-invitation` |
| `DELETE /api/v1/meeting-polls/{id}/voters/{voterId}` | `remove_meeting_poll_voter` | `remove-voter` |
| `POST /api/v1/meeting-polls/{id}/remove-unverified` | `remove_unverified_meeting_poll_voters` | `remove-unverified` |
| `POST /api/v1/meeting-polls/{id}/rotate-link` | `rotate_meeting_poll_link` | `rotate-link` |
| `POST /api/v1/meeting-polls/{id}/close` | `close_meeting_poll` | `close` |
| `POST /api/v1/meeting-polls/{id}/cancel` | `cancel_meeting_poll` | `cancel` |
| `DELETE /api/v1/meeting-polls/{id}` | `delete_meeting_poll` | `delete` |
| `POST /api/v1/meeting-polls/{id}/finalize` | `finalize_meeting_poll` | `finalize` |

List accepts `limit` (1–100, default 50) and the preceding page's `nextAfter` as
`after`. Results contain private voter details and advisory availability. Keep the
roster private and treat `unknown` availability as unconfirmed.

Create, invite, resend, rotate and finalize take an idempotency key. Keep a fresh
random key for each distinct intent. Save the public link from the initial create
or rotate response. Invited polls have no public link. If a create response is lost,
an exact retry reports `poll_already_created` with the authorized poll ID (null after
deletion). Rotate with a new key and the current host revision to replace a lost
public link and invalidate the old one. Rotation leaves existing voter links usable.

Invite with up to 40 names and email addresses in `invitees`. The server either
reserves the entire batch or rejects it if it exceeds capacity. The response reports
outcomes for the submitted addresses. Exact replay reports current outcomes without
queuing more mail. Use `expectedHostRevision` from the poll when resending, removing,
rotating, closing, canceling or deleting. Bulk removal clears unverified public
enrollments and preserves host invitations. Deleting a poll preserves its booking.

Finalize uses `expectedResultsRevision` and `expectedBallotRevisions` for each
selected voter, keyed by voter ID. Include the designated booker in
`attendeeVoterIds`, and set `acknowledgeConditional` when any selected voter
chose `if_need_be` for the selected slot. When the event has location choices,
use `locationOptionId` to select one. The server checks consent, event
configuration and live availability before booking. On revision conflict, fetch
fresh results, review the selected ballot revisions and confirm again. Closing the
poll freezes voting while leaving finalization available.

A first finalization returns 201 in REST. After an uncertain response, replay the
same inputs with the same key. An exact replay returns 200 with the current booking
ID, time and status, following any reschedule to the latest booking in the chain.
The response omits booking-management credentials.

### Voter

| REST | MCP tool | CLI |
|---|---|---|
| `POST /api/v1/public/meeting-polls/read` | `read_meeting_poll` | `view` |
| `POST /api/v1/public/meeting-polls/enroll` | `enroll_meeting_poll_voter` | `join` |
| `POST /api/v1/public/meeting-polls/recover` | `recover_meeting_poll_voter` | `recover` |
| `POST /api/v1/public/meeting-polls/verify` | `verify_meeting_poll_voter` | `verify` |
| `POST /api/v1/public/meeting-polls/vote` | `submit_meeting_poll_vote` | `vote` |
| `POST /api/v1/public/meeting-polls/withdraw` | `withdraw_meeting_poll_vote` | `withdraw` |
| `POST /api/v1/public/meeting-polls/reminder-opt-out` | `opt_out_meeting_poll_reminder` | `reminder-opt-out` |

Copy only the fragment value from a voting link into `token` (or `publicToken` for
enrollment). Keep it in the request body. Read and verify are separate operations.
On successful verification, a replacement voting token, when issued, is disclosed
once in `votingToken` and also queued for email. Enrollment accepts `publicToken`, `name`,
`email`, `timeZone` and optional `locale`. A 202 means the request was accepted.
It neither establishes mailbox membership nor promises delivery. A full poll
returns `poll_full` uniformly across submitted mailboxes.

To vote, read the current ballot and submit all candidates as `votes` entries with
`slotId` and a `value` of `yes`, `if_need_be` or `no`. Send `consent: true` and
the current `expectedBallotRevision` from the read (0 before any ballot mutation). Include
required question answers in `responses`. To withdraw, send the voting token and
revision. If a save or withdrawal returns `poll_changed` or the response is lost,
fetch the current ballot and reconcile before trying again. Reminder opt-out uses
the separate token from the reminder email.

A valid retained voting credential can read its owner's ballot after closure.
Private polls omit totals. An aggregate poll can expose separate yes, if-need-be and
no counts to a verified voter who is still participating. Public responses omit the private roster. Capability reads keep the
original poll decision after subsequent booking changes. Use the booking view or
the booking update message for the current meeting.

## Examples

Replace the sample IDs and times with IDs and currently offered times from your own
space. Use your own credentials and a fresh random idempotency key. The samples use
placeholder credentials and reserved example addresses.

### Create a private invited poll through REST

Candidates use timestamps with UTC offsets or `Z`. The deadline must be between
one hour and 30 days after creation. Success returns 201 with the new `poll` and
a null `publicLink` for invited admission.

```http
POST /api/v1/meeting-polls
Authorization: Bearer API_KEY
Content-Type: application/json
Idempotency-Key: example-create-key

{
  "eventTypeId": "00000000-0000-7000-8000-000000000001",
  "candidateStarts": ["2027-01-12T10:00:00-05:00", "2027-01-12T11:00:00-05:00"],
  "deadlineAt": "2027-01-11T17:00:00-05:00",
  "displayTimeZone": "America/New_York",
  "admissionMode": "invited",
  "visibility": "private"
}
```

### Request recovery through public REST

Recovery always gives the same acceptance response for eligible and unknown
mailboxes once validation and request limits pass. It can re-deliver the existing
credential without rotating it. Retain the poll ID separately from the private link.

```http
POST /api/v1/public/meeting-polls/recover
Content-Type: application/json

{
  "pollId": "00000000-0000-7000-8000-000000000002",
  "email": "voter@example.test"
}
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted": true}
```

### Read host results through MCP

Send this JSON-RPC message over an authenticated MCP connection for the poll's space.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_meeting_poll_results",
    "arguments": { "id": "00000000-0000-7000-8000-000000000002" }
  }
}
```

### List polls through the CLI

Run this in a configured CLI session. The output contains `data` and `nextAfter`.

```sh
hourmere polls list --input - <<'JSON'
{"limit": 10}
JSON
```
