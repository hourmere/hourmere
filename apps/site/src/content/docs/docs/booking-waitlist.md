---
title: Booking waitlists
description: Let invitees hear when a fully booked event has an opening, without reserving a time.
---

Booking waitlists are available to self-hosted installations in full. They are separate
from the Hourmere Cloud signup waitlist on this website.

## Enable and manage a waitlist

Waitlists require SMTP (`SMTP_URL` and `MAIL_FROM`) for verification and notification
emails. Without SMTP, no waitlist email is sent and invitees cannot confirm; the public
page hides the waitlist option and join/resend return HTTP 409 `waitlist_smtp_not_configured`.

1. Open **Event types** in the intended personal or team space and edit the event type.
2. Under **Booking waitlist**, select **Let invitees join a waitlist when no times are
   available**, then save.
3. Choose **View waitlist entries** to see retained email addresses, optional names,
   requested periods, states and notification times. **Remove** clears that entry's
   contact details and stops future waitlist messages, without sending a removal email.

Only one-on-one event types with a single host are eligible. Round-robin and collective
event types are unsupported. Personal owners manage their own waitlists; team owners and
admins manage team waitlists. Ordinary team membership or being a host does not grant
access to the contact list.

Clear the checkbox and save to disable the waitlist. Disabling clears contact details,
revokes pending work and removes waiting eligibility without sending email. Re-enabling
does not restore removed entries. Already delivered messages cannot be recalled.

## What invitees see

The ordinary public booking page offers the form only after a successful availability
query finds no times in the displayed future period. Loading, errors and inaccessible
events do not count as an empty calendar. The invitee supplies an email address, optional
name and consent to share those details and their requested period with the personal
owner or authorized team owners/admins. The window uses fixed UTC instants and an IANA
time zone for display, and can extend at most 62 days into the future.

An accepted request says to check email; it does not reveal existing registrations or
promise delivery. The invitee must follow the confirmation email and explicitly confirm,
even if already signed in. Opening the email link alone does not confirm. Verification
links last up to 30 minutes; an explicit resend request is available, subject to cooldowns and
abuse limits. Pending enrollment lasts at most 24 hours; confirmed enrollment ends at the
earlier of 30 days after joining or the requested period's end. Resending never extends it.

## When a time opens

When a cancellation, reschedule or another availability change opens a matching time,
every eligible verified invitee is considered for notification. **Everyone eligible is
notified, nothing is reserved, and the first successful ordinary booking wins.** There is
no queue rank or exclusive invitation period. The sender rechecks availability and
eligibility before sending; expired entries, unavailable times and shared email limits
can prevent delivery. A notification is not a promise that a time will remain available.

Each message suggests up to three matching times at the event's default meeting length.
Following a suggestion opens the ordinary booking flow; all booking rules still apply.
A retained notification timestamp records SMTP acceptance, not inbox delivery. The invitee
can use the leave link to clear their contact details and stop future messages.

## Privacy and retention

Leaving, host removal and disabling immediately clear contact details and revoke pending
work. Hashed abuse-prevention records remain for 2 days. Separate hashed exact-slot
records remain until the slot ends plus 2 days, up to 64 days from admission, to avoid
repeat notifications after leaving and rejoining. These purpose-separated hashes are
pseudonymous records, not readable email addresses; removal does not reset these limits.
These are elapsed days, including across daylight-saving changes. An hourly bounded
cleanup removes records after their deadlines; a backlog can delay physical deletion.
Booked or expired contact details are cleared by cleanup, and minimal terminal entry
metadata is retained for 7 days. Rotating the accounting secret (`BETTER_AUTH_SECRET`)
clears all waitlist entries and resets the hash-based accounting boundary; it is not a
normal unsubscribe action.

Managers never receive verification, removal or booking-attribution tokens in entry
responses. Treat emailed links as private capabilities. Do not forward them or include
them in analytics, support tickets or logs. Waitlist links are never written to the log;
the development mailer does not send waitlist messages. Operators should
review [proxy logging](/docs/self-hosting#proxy-behavior-and-an-existing-proxy) and apply
their own privacy policy and access controls. The website's Cloud signup retention policy
does not govern booking waitlists on a self-hosted instance.

## REST

Use IDs from `GET /api/v1/event-types`. Protected settings and entry reads require a
`read` or `full` key; settings changes and removal require `full`, plus the manager
permissions above. Session clients retain the usual organization-context safeguards.

| Method and path | Result |
|---|---|
| `GET /api/v1/event-types/{id}/waitlist` | Returns `{ "enabled": false }` or true. |
| `PUT /api/v1/event-types/{id}/waitlist` | Accepts `{ "enabled": true }` or false. |
| `GET /api/v1/event-types/{id}/waitlist/entries` | Returns `data` and `nextAfter`; pass `after` and optional `limit` (1–100). |
| `DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}` | Returns `{ "removed": true }`; repeating removal of a retained entry succeeds. |
| `POST /api/v1/public/{handle}/{slug}/waitlist` | Requests confirmation; returns HTTP 202 `{ "accepted": true }`. |
| `POST /api/v1/public/{handle}/{slug}/waitlist/resend` | Explicit resend with `{ "email": "alex@example.com" }`; same neutral acceptance. |

For team pages, replace `/api/v1/public/{handle}` with
`/api/v1/public/teams/{handle}`, where `handle` is the team slug. Public join/resend need
no key; a supplied key must be valid with `bookings` or `full` scope. A join body is:

```json
{
  "email": "alex@example.com",
  "name": "Alex",
  "preferredWindow": {
    "start": "2027-01-04T09:00:00Z",
    "end": "2027-01-08T17:00:00Z",
    "timeZone": "Europe/London"
  },
  "locale": "en",
  "consent": true
}
```

Replace these example dates with a future empty period within the allowed range. Ask for
consent before submitting; do not automatically retry join or resend. Refresh availability
on HTTP 409 `availability_changed` or `waitlist_unavailable`. A missing waitlist secret
also returns `waitlist_unavailable`; the operator must repair configuration. Unsupported
event shapes return `waitlist_unsupported`. Missing SMTP returns HTTP 409
`waitlist_smtp_not_configured`. A full waitlist returns HTTP 409 `waitlist_full`, with no
enrollment or confirmation email; try again later. Rate limits return `rate_limited` with
`Retry-After`. See the instance's `/api/v1/openapi.json` for the complete current schema.
Event creation/update also accepts `waitlist: { "enabled": true }`; omission on update
preserves the setting. Confirmation and leaving use the emailed browser flow; admin
entry reads cannot recover those links.

## MCP and CLI

MCP uses the same manager permissions, admission rules and error codes as REST. Authorized
OAuth `mcp:tools` grants retain these tools within the caller's permissions. API key scopes
are shown below; session cookies do not authenticate MCP.

| MCP tool | CLI command | Input | Key scopes |
|---|---|---|---|
| `get_event_type_waitlist` | `event-waitlist` | `id` | `read, full` |
| `set_event_type_waitlist` | `set-event-waitlist` | `id, enabled` | `full` |
| `list_waitlist_entries` | `waitlist-entries` | `id`, optional `after`, `limit` | `read, full` |
| `remove_waitlist_entry` | `remove-waitlist-entry` | `id, entryId` | `full` |
| `join_waitlist` | `join-waitlist` | Join body above plus `slug` and exactly one of `handle` or `teamSlug` | `bookings, full` |
| `resend_waitlist_verification` | `resend-waitlist-verification` | `email`, `slug`, exactly one of `handle` or `teamSlug` | `bookings, full` |

For example, call `set_event_type_waitlist` with:

```json
{ "id": "00000000-0000-4000-8000-000000000001", "enabled": true }
```

The [CLI setup](/docs/cli) uses the same MCP input through `--input -`:

```sh
npm run --silent cli -- set-event-waitlist --input - <<'JSON'
{ "id": "00000000-0000-4000-8000-000000000001", "enabled": true }
JSON
```

Replace the sample ID with your event's ID. Ask the host before removing an entry and ask
the invitee for explicit consent before joining. Join/resend share a per-user budget
across API keys as well as durable mailbox, event and trusted connection-IP limits.

## Known limitations

- SMTP (`SMTP_URL` and `MAIL_FROM`) is required; there is no log-mailer fallback.
- Each event type allows at most 100 active entries (pending, active or notified). The
  101st person sees a clear “This waitlist is full (100 entries). Please check available
  times later.” error, rather than “check your email”; no entry or verification email
  is created.
- No priority, reservation, guaranteed notification or guaranteed booking; email delivery
  depends on the worker, SMTP and shared recipient budgets.
- Only one-on-one single-host types, at the default meeting length. No round-robin,
  collective or one-time-link waitlist enrollment. Approved embedded booking pages can
  offer waitlists under the same consent and availability rules.
- No manual host enrollment, bulk contact export or automatic registration of signed-in
  users. Every invitee verifies email and consents separately.
- A leave link stops future work but cannot retract an email already accepted by SMTP.
  Hash retention survives removal and rejoining; physical cleanup is asynchronous.
- The requested window is fixed in UTC. Changing a display time zone does not move it,
  and daylight-saving transitions do not extend enrollment or retention deadlines.
