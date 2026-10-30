---
title: Notifications and background jobs
description: Understand booking and sign-in email delivery, calendar invitations and background workers.
---

Booking emails (confirmed, rescheduled, cancelled, reminder) are sent by a background job,
never from the request that changed the booking: a slow or broken mail server must not slow
down or fail a booking, and a failed send must be retried.

The pieces: the job infrastructure (`@hourmere/jobs`), the worker process role, the email
templates and calendar invitations (`@hourmere/mail`), the notification job and the queueing
helper (`@hourmere/notifications`), the `booking_notifications` table, and the booking
services ([`packages/scheduling/src/bookings.ts`](https://github.com/hourmere/hourmere/blob/main/packages/scheduling/src/bookings.ts)), which queue the jobs in the transaction of
every booking change, whether it came over REST or MCP (last section).

## Jobs

Jobs live in Postgres, through [pg-boss](https://github.com/timgit/pg-boss) (pinned; it
needs Node 22.12+ and Postgres 13+, and runs on our Postgres 18). Self-hosting stays "app +
Postgres": no Redis, no second service to back up.

A job is declared with `defineJob`: a queue name, a zod schema for its payload, a retry
policy (limit, delay, backoff, cap), how long one attempt may run, a queue policy and a
handler. `jobs.enqueue(name, payload, options)` validates the payload (a `JobPayloadError`
names the fields, never their values) and takes:

- `startAfter`: not before this instant (reminders);
- `singletonKey`: with the `exclusive` policy, at most one queued or running job per key,
  so a second enqueue returns null;
- `transaction`: a Kysely transaction to insert the job through.

Handlers may run more than once (retries, a worker that dies mid-job), so they must be
idempotent. Payloads are stored as JSON until the job is deleted (7 days after it finishes),
so they are plain JSON and never contain secrets. A failed attempt is logged on one escaped
line with the job name, id and attempt number, never the payload.

### Enqueueing in the booking's transaction

pg-boss can run its insert through a caller-supplied connection, and ships an adapter for
Kysely transactions (`fromKysely`), which `enqueue` uses when given `transaction`. The job
then commits or rolls back with the booking, and workers cannot see it before the commit.
Tested both ways (rollback leaves no job; before the commit the job is invisible to other
connections), so no outbox table is needed. If we ever had to give this up (for example a
pooler in transaction mode), the fallback is an outbox: a `notification_outbox` row written
in the booking's transaction and a worker loop that moves rows into pg-boss.

### pg-boss's schema

pg-boss keeps its tables in its own `pgboss` schema and installs and upgrades them itself,
under its own advisory lock, so several instances may start at once. Our migration runner
only applies [`packages/db/migrations`](https://github.com/hourmere/hourmere/tree/main/packages/db/migrations) and records them in `public.schema_migrations`; it
never touches `pgboss`, `npm run db:types` excludes it, and no table of ours references it.
With `AUTO_MIGRATE=true` (the default) every role installs or upgrades the schema on start.
With `AUTO_MIGRATE=false`, `npm run db:migrate` runs our migrations and then pg-boss's own
`migrate` command, and the app refuses to start against an outdated `pgboss` schema.

## Process roles

One image; `HOURMERE_ROLE` decides what a process runs:

| Role | HTTP | Jobs |
|---|---|---|
| `all` (default) | API and web app | queues and runs them, plus pg-boss maintenance |
| `web` | API and web app | only queues them |
| `worker` | only `GET /api/health` | runs them, plus pg-boss maintenance |

`all` is the simplest self-hosting setup: one container. Larger deployments run `web` and
`worker` containers from the same image. Every role listens on `PORT`, so the image's one
`HEALTHCHECK` (`GET /api/health`) works for all of them; a worker is healthy when the
database answers, its workers are running and pg-boss's own pool answers, and it answers
404 to everything else. Do not publish a worker's port.

Database connections per process: the app pool (up to 10), Better Auth's pool (up to 10;
not in a worker) and pg-boss's pool (up to 5). A running notification job holds at most
two app-pool connections: one for reading the booking, one for the send transaction. With
two notification jobs at a time, a worker or `all` process keeps most of its app pool for
requests. Size Postgres's `max_connections` for 25 per `all` or `web` process and 15 per
worker, plus headroom.

On SIGTERM a process stops accepting requests, then stops taking jobs and waits up to 20
seconds for running ones. Any still running then are failed and retried later by another
worker: the job's abort signal reaches the mailer, which stops waiting for the mail server,
so the open transaction rolls back (the email stays owed) and its connection is returned.
Then the pools close. (The SMTP exchange itself is not cut off and may still finish before
the process exits, in which case the retry sends that email a second time.) The job logs
one line saying it was stopped, not an error. Give it time to do so: `stop_grace_period: 35s` in
[`docker-compose.yml`](https://github.com/hourmere/hourmere/blob/main/docker-compose.yml), `docker stop -t 35`, or the orchestrator's equivalent; Docker's
default of 10 seconds cuts long jobs short (they are retried, so nothing is lost).

## Events and their jobs

All notifications go through one job, `booking-notification`, with payload
`{ bookingId, kind }` (queue policy `exclusive`, singleton key `<bookingId>:<kind>`).

| Event (service) | Jobs queued in its transaction |
|---|---|
| Booking created (`createPublicBooking`, not on an idempotent replay) | `confirmed` now; `reminder` 24 hours before the start, unless that is less than an hour away |
| Booking rescheduled (`rescheduleManagedBooking`, `rescheduleHostBooking`) | for the **new** booking: `rescheduled` now; `reminder` as above. Nothing for the old one (see below) |
| Booking cancelled (`cancelManagedBooking`, `cancelHostBooking`, `cancelTeamAdminBooking`) | `cancelled` now |

The same services serve the booking page, the REST API and the MCP tools, so a booking an
agent makes, moves or cancels sends exactly the emails a person's would.

`enqueueBookingNotifications(jobs, trx, event, now)` does exactly this, and refuses to run
outside a transaction. The reminder offset is an absolute 24 hours, so across a daylight
saving change it arrives an hour earlier or later on the recipient's clock; a booking made
less than 25 hours ahead gets no reminder, as it would come right after the confirmation.

Every email goes to each host first (they most need to know), then the invitee, then the
guests, so a guest address that is slow to answer cannot hold up the others. Hosts are the
booking's `booking_hosts` whose address is verified: accounts start verified, and one that
is not (it should not exist; see [data model](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md)) is neither emailed nor named in the
invitation, so a booking without a verified host sends nothing (the job logs one WARN line
naming the booking and the kind, since the invitee hears nothing either). Guests are
addresses an anonymous booker typed (up to 10 per booking); invitee/guest emails share
per-recipient and instance-wide [abuse limits](#email-abuse-controls). Times are shown in the recipient's zone with its IANA display name
(spaces instead of underscores) and the GMT offset for the meeting date: the attendee's
zone from `booking_attendees`, a host's from their profile, else their default schedule,
else UTC. Host emails also show the invitee's local time when the saved invitee zone
differs from the host email's zone. Host emails add the invitee's contact details, guests
and answers; only the invitee's email has manage links.
Invitee/guest confirmations and reschedules carry an invitation (`METHOD:REQUEST`),
cancellations a cancellation (`METHOD:CANCEL`); reminders carry none. New host notifications
carry the same calendar item only when there is no pinned provider calendar copy (details
below). Legacy host notifications retain their invitations and cancellations.

### Email language

Booking emails use the shared [locale registry](/docs/interface-languages#development),
currently English, Simplified Chinese, German and French, throughout the subject, plain text, HTML and
user-facing calendar SUMMARY/DESCRIPTION. Each missing translated message falls back to
English independently; the selected locale still controls date/time formatting. The HTML `lang` matches the email language.
The invitee's language comes from `booking_attendees.locale`, captured from the booking
page's interface language at the first valid submission; changing the interface while
retrying that submission keeps the original request and its language. REST/MCP callers can
provide the same invitee locale. Guests follow the invitee's booking language. Each host
uses their current profile locale independently. Supported English, Simplified Chinese, German and French
BCP 47 tags map to registered language codes (`en`, `zh-CN`, `de` and `fr` today); missing, invalid or
unsupported languages fall back to English. Reschedules retain the booking's saved language.
Team invitation emails use an explicit language choice, then an instance default, then English.

French regional preferences including `fr-CA`, `fr-BE` and `fr-CH` map to `fr`.
German and French translations are AI-assisted (machine-translated), have not yet been reviewed by a
native speaker, and corrections are welcome.

Dates and times use that email language and the recipient time zone described above;
language selection never changes the meeting instant or calendar UID/SEQUENCE. Titles,
names, question labels, free-text answers, cancellation reasons and location values remain
the original user content. Generated answer labels such as Yes/No are localized for the host.

### Checked when sent, not when queued

The job reads the booking when it runs and sends only what is still true:

| Kind | Sent only if |
|---|---|
| `confirmed` | the booking is confirmed and has not started |
| `rescheduled` | the booking is confirmed, has not started, and replaced an earlier booking that is cancelled |
| `reminder` | the booking is confirmed and has not started |
| `cancelled` | the booking is cancelled and no booking replaced it |

The status and start are read again inside each recipient's send transaction (without a
lock, which would hold up a cancel), so a booking cancelled while the first emails go out
gets no further confirmations; the cancellation email follows. The job also stops between
recipients once the worker is shutting down.

So nothing has to be un-queued. A reschedule cancels the old booking and creates a new one,
so the old booking's reminder finds it cancelled and sends nothing, and the new booking has
its own reminder; a cancelled booking's reminder does the same. A reschedule also does not
send a cancellation for the old booking (it has a successor): the reschedule email covers
it. This is more robust than deleting jobs by key, which would have to happen in the same
transaction and would miss any path that changes a booking without knowing about jobs.

### Sent once, with a narrow duplicate window

`booking_notifications` has one row per email: primary key (booking, kind, recipient), the
recipient being `host:<user id>` or `attendee:<attendee id>` (so someone who books their own
event type gets both emails). For each recipient the job, in one transaction, inserts the
row (`ON CONFLICT DO NOTHING`); if it already exists the email has a terminal sent,
rejected or suppressed outcome and is skipped; otherwise it checks the abuse limits,
sends the email if permitted, and commits.

- A failed send rolls the row back, and the retry sends to the recipients still missing.
- Two attempts at the same time (a job that ran past its expiry and was retried while still
  running): the second insert waits for the first transaction, then skips.
- The duplicate window: the mail server accepted the email and the commit then failed (lost
  connection, crash, shutdown mid-send). The retry sends it again. If it is an invitee
  email, the first copy's manage link does not work, since its hash was rolled back; the
  second copy's does.
- A connection the database drops while the transaction waits for the mail server (restart,
  failover, `idle_in_transaction_session_timeout`) only fails that attempt: every pool
  listens for errors on its checked-out clients (`guardPoolErrors`), so the process lives.

Refusals by the mail server (`MailRejectedError`, which carries the reply codes but never the
reply text, which repeats the address):

- **About this address**: at `RCPT TO` with a mailbox or domain status (x.1.x, x.2.x), or
  without an enhanced code a 450, 550, 551, 552 or 553. The others are still attempted.
  - **Permanent** (5.1.x no such mailbox or domain, 5.2.1 mailbox disabled, or bare 550,
    551, 553): kept with `outcome = 'rejected'` (no token hash), logged on one line
    (booking id, kind, role and id, the codes, no address) and never retried.
  - **Temporary** (4xx, or a full mailbox 5.2.2 / 552): the job fails at the end, naming
    those recipients by role and id, so the retry sends only to them.
  - If every recipient would be refused for good, the job fails and retries instead: that
    says more about the mail server than about the addresses.
- **Anything else** (relaying or policy 5.7.x, sending limits 5.4.x / 5.5.x, a refusal at
  `DATA`, the server unreachable, sign-in refused, shutdown) would hit every remaining
  recipient alike, so it ends the attempt at once and the job is retried.
- Since the reschedule creates a new booking, booking id + kind already identifies an event;
  no sequence number is needed in the key.
- The row's foreign key to the booking is `DEFERRABLE INITIALLY DEFERRED`: an immediate check
  would hold a key-share lock on the booking for as long as the mail server takes, and block
  an invitee's cancel (which locks the booking `FOR UPDATE`) behind it. A test covers this.

The job also has a singleton key, so enqueueing the same event twice while one is pending
creates no second job; the table is what makes sending idempotent.

Retries: 12, from one minute doubling to an hour, about seven hours in all. After that the
job fails and stays visible in `pgboss.job` for a week.

## The manage-token problem

The invitee's reschedule/cancel secret exists in raw form only inside
`createPublicBooking` and `rescheduleManagedBooking` (`newManageToken` in `insertBooking`),
which return it once, in the HTTP response; only its SHA-256 is stored
(`bookings.manage_token_hash`). The email, however, is sent later, by a job, possibly from
another process. Options:

1. **Put the token in the job payload, encrypted** with a key derived from
   `BETTER_AUTH_SECRET` (HKDF, AES-256-GCM). Links stay the same as the API's. But the
   ciphertext sits in `pgboss.job` until the job is deleted, for a reminder weeks, and
   rotating the secret breaks every queued email (no links, or a failed job).
2. **Send the invitee's confirmation synchronously after the commit** and queue only
   retries. The request waits for the mail server, an email is lost if the process dies
   between commit and send, and a retry job needs the token anyway, so option 1 comes back.
   Reminders would still have no token.
3. **A fresh token per email, by rotating `bookings.manage_token_hash`** when the job sends.
   Nothing raw is stored, but each email invalidates the previous link: the token the API
   returned (agents keep it to manage the booking later) stops working when the
   confirmation goes out, and the confirmation's link stops working when the reminder goes
   out. That breaks the API's contract.

**Decision: option 3 without the rotation.** Each invitee email mints its own token when it
is sent and stores its SHA-256 in that email's `booking_notifications` row, in the same
transaction (so a failed send leaves no token behind). Email delivery never rotates the
booking's own hash. Host moves transfer that hash to the successor without revealing a
token. Every token, the API's and each email's, opens the booking for as long as it
exists. No raw secret is stored anywhere, encrypted or not, and the queue holds only
`{ bookingId, kind }`; management-token validity does not depend on `BETTER_AUTH_SECRET`
(the separate abuse counters do); retries are harmless (at worst an unused hash);
reminders carry working links. The cost is a second place to look
up a token (below), and several valid secrets per booking, each 256 random bits.

### Which booking a token opens

`getManagedBooking`, `cancelManagedBooking` and `rescheduleManagedBooking` (REST
`/api/v1/bookings/manage…` with `X-Manage-Token`, and the MCP tools that take a
`manageToken`) look a token up by its SHA-256 in one statement that probes both
`bookings.manage_token_hash` and `booking_notifications.manage_token_hash` (each unique, so
each probe is one index lookup) whatever the token is. So every unknown token costs the same
(two probes that find nothing), whichever table it might have been looked for in, and all
unknown, malformed or missing tokens get the same 404 `booking_not_found`. Only rows of
emails that went out match (`outcome = 'sent'`); an email the mail server refused for good
keeps no hash (a check constraint), so the secret it would have carried never opens
anything. Showing and acting resolve the booking through the same function, so they
always agree on which booking a token means.

- **After an invitee move, the API's token stays with its booking.** It shows the old, cancelled
  booking, and cancelling or rescheduling with it gets 409 `booking_cancelled`. That is the
  documented contract agents rely on: a reschedule retried after a lost response cannot move
  the meeting twice. The reschedule's response carries the new booking's token.
- **A host move preserves the invitee's API token.** `rescheduleHostBooking` returns
  `manageToken: null`, clears the old booking's hash and sets it on the successor in the
  same transaction. The host receives no invitee capability, and existing invitee links
  continue to work before the reschedule email arrives. Repeated host moves carry the
  same hash; an invitee move still has the retry behavior above.
- **An email's token stands for the meeting.** After the booking it was sent about is
  rescheduled, it follows the chain (`rescheduled_from_id`) to the booking that replaced it,
  the latest one, and shows, cancels or reschedules that one. The chain needs no hop limit:
  the link is set once, at insert, to a booking that already exists, so it cannot loop, and
  a reschedule locks and cancels what it replaces, so it cannot branch (a `CYCLE` clause
  still keeps hand-edited data from looping the query). Why follow it at all: the
  email is what the invitee keeps; the reschedule email with a fresh link may come hours
  later (retries), or not at all (refused address), and the reschedule may have been made by
  an agent that kept the new token for itself. The person who holds an email about the old
  booking is the invitee of the new one (a reschedule copies invitee and guests unchanged),
  so the link keeps the authority it had. The cost: a reschedule through an email's link is
  not retry-safe (a second submission moves the meeting again, to the same time if repeated
  as is), so the web app must not resubmit it on its own.
- **After a cancellation** every token still shows the booking, read-only (status
  `cancelled`); cancelling again or rescheduling gets 409 `booking_cancelled`.
- **Locking.** Cancel and reschedule lock the booking they act on (`FOR UPDATE`). For an
  email's token, a reschedule that committed while the request waited for that lock has
  moved the meeting on, so the chain is followed again from the locked row until the locked
  row is the latest (none can replace it while the lock is held), and only that locked row
  is checked and changed. Each further round means yet another reschedule committed while
  the request waited; after ten the request gets 409 `booking_changed` (try again) instead
  of chasing the meeting. An API token whose hash moved while waiting on a host move is
  resolved again under the same bound; after an invitee move it finds its booking cancelled.

Links put the secret in the URL fragment,
`https://<app>/booking#token=<token>&action=reschedule` (or `action=cancel`), which browsers
send neither to the server nor in `Referer`, so it stays out of logs; the web app reads it
and calls the API with `X-Manage-Token`. `action` is a hint for which form to open.
Calendar invitations never contain the secret: calendars are shared and synced. Without
`SMTP_URL` the log mailer prints emails, manage links included, as it prints sign-in links:
the same rule applies (only where whoever reads the log may act as anyone).

## Calendar invitations

`buildIcs` writes RFC 5545 with CRLF line endings, lines folded at 75 octets (never inside
a UTF-8 sequence), TEXT values escaped (`\\`, `\;`, `\,`, `\n`), control characters
removed and names quoted. The UID is `<first booking of the reschedule chain>@hourmere`
(fixed, so a change of PUBLIC_URL does not orphan calendar entries made before; calendar
write-sync must use the same iCalUID for the events it creates), so a reschedule updates the
same calendar entry; `SEQUENCE` is the number of reschedules in the chain, plus one for
cancellation. Times are UTC, including across daylight-saving changes. REQUEST adds/moves
an event; CANCEL retains the identity and sets `STATUS:CANCELLED`.

### Identity and recipients

Migration0038 marks every existing booking as protocol v1; new booking roots default to v2.
The **root's** version and organizer snapshot govern the entire reschedule chain, even when
a successor has the new default. Stop all old web/all/worker processes before migration,
including processes on other hosts, then restart every role with the new code. Migration
0038 does not support rolling deployment; mixed-version workers cannot pin the same policy.

| Recipient | New root (v2, SMTP configured) | Legacy root (v1) |
|---|---|---|
| Invitee and guests | REQUEST/CANCEL; invitee/guests are `NEEDS-ACTION;RSVP=FALSE` | REQUEST/CANCEL with original `ACCEPTED;RSVP=FALSE` policy |
| Host without a pinned provider copy | Same REQUEST/CANCEL; primary host is `CHAIR;PARTSTAT=ACCEPTED`, other hosts accepted required participants | Original host notification REQUEST/CANCEL |
| Host with a pinned provider copy | Ordinary email; provider writeback updates/removes its calendar item | Keep REQUEST/CANCEL to update an existing emailed copy |
| Reminder or conference failure | Ordinary email, no calendar part | Ordinary email, no calendar part |

New invitations use the single mailbox from `MAIL_FROM` as ORGANIZER, with the verified
primary host's name as CN. Hosts also appear as attendees; duplicate addresses are collapsed,
including when the booker is a host or the sending mailbox is the host's own address.
Invitee/guest summaries name the host; host summaries name the invitee. Every recipient gets
a neutral DESCRIPTION naming the host and Hourmere. REQUEST descriptions also explain that
accepting or declining the calendar invitation does not cancel the booking, in the recipient's
language. Invitees are directed to the confirmation email's cancellation link, hosts to open
the booking in Hourmere, and guests to contact the person who booked or the host. That
explanation contains no URL or secret.
No booking answers, private management links or tokens enter calendar data.

Avoid a Gmail or Google Workspace address, or any other address registered as a Google
account, for `MAIL_FROM`: Gmail may treat that address as a Google organizer (unconfirmed).
Use a separate mailbox that can receive mail, because calendar RSVP replies go to ORGANIZER;
a no-reply address that rejects incoming mail bounces those replies.

The worker atomically pins the organizer email/name on the root before SMTP. Retries,
reschedules and cancellations reuse it after host/profile or `MAIL_FROM` changes. Keep the
sending mailbox stable: if it changes, the old ORGANIZER remains and `SENT-BY` names the
current sender, but some clients (including Outlook) ignore that delegation parameter.
For legacy roots, migration captures the stored conference organizer when available, else
the first surviving verified host/member and its display-name fallback. Historical identity
changes/deletions that happened before this snapshot cannot be reconstructed. The old
organizer is retained rather than silently transferring an existing UID to a new mailbox.
Without SMTP, the log mailer retains the legacy host-based preview and does not invent an
instance mailbox; it sends no real calendar invitation.

A pinned provider copy means a `booking_calendar_targets` destination, an automatic Meet
organizer destination, or a conference mirror with an actual calendar destination. A
`not_configured`/destination-less mirror still gets its email invitation. Pending or failed
configured copies continue through provider reconciliation/retry; their emails do not add a
second item. We do not use PUBLISH: it is a static publication with no ATTENDEE and cannot
replace the REQUEST/CANCEL scheduling lifecycle.

### Email headers, MIME and replies

From always remains the authenticated, operator-configured `MAIL_FROM`; Hourmere does not
impersonate a host's mailbox. No redundant Sender header is added. Ordinary email Reply-To
is the verified primary host for invitee/guest mail, and the booker for host mail. This does
not route calendar status replies: iTIP clients send those to ORGANIZER, even with SENT-BY.
An invalid Reply-To is omitted without blocking notification delivery.

`NEEDS-ACTION` leaves adding/accepting the invitation to the recipient's calendar. The
booking itself is already confirmed in Hourmere. `RSVP=FALSE` deliberately does not solicit
REPLY messages, but it does **not** stop Gmail from offering Yes/No/Maybe or sending calendar
replies to the pinned ORGANIZER (`MAIL_FROM` for new roots). Legacy roots may still send
replies directly to their original host organizer. Hourmere has no inbound calendar-response
processor or automatic two-way calendar sync: a calendar decline neither cancels a booking
nor automatically notifies its host. Ordinary email Reply-To does not change that routing.
Use Cancel booking on the private management page or the original email's cancellation link.
The public confirmation and management pages explain this distinction.

Every email carrying a REQUEST explains the limitation in the recipient's language and
role. The invitee's hint sits next to Cancel / Reschedule near the top of the body; hosts
are directed to cancel in Hourmere, and guests are directed to contact the booker or host.
Guests never receive the invitee's management link or token. Suppressed invitations
(including hosts with provider copies and invitees using the same address), cancellations,
reminders and conference-failure notices have no calendar-response hint. Reminders carry no
ICS; their invitee management links still work.

SMTP uses Nodemailer's `icalEvent`: a `text/calendar; method=REQUEST` (or CANCEL) alternative
with UTF-8 plus an identical downloadable `application/ics` attachment (`invite.ics` or
`cancel.ics`). Text and HTML remain in the message, including the invitee's management links.
Some clients display only the meeting card and hide those bodies; the neutral DESCRIPTION
provides context, while management still requires opening the original email body. This
MIME shape follows [Nodemailer's calendar guidance](https://nodemailer.com/message/calendar-events)
and [Cal.com's Outlook compatibility fix](https://github.com/calcom/cal.com/commit/7adab1f65fab6c53b036beae2cd2a7479780ba55).

This policy follows [RFC5545](https://www.rfc-editor.org/rfc/rfc5545.html),
[RFC5546](https://www.rfc-editor.org/rfc/rfc5546.html#section-3.2.2) and
[RFC6047](https://www.rfc-editor.org/rfc/rfc6047.html#section-2.4).
It improves identity alignment and calendar MIME recognition; it does not guarantee Inbox
placement, response buttons or automatic addition. Gmail's known-sender/invitation settings
still apply.
Real Gmail external-invitee and Outlook.com checks, including update/cancel, are required.

### Operator runbook for calendar replies

Keep `MAIL_FROM` able to receive mail and assign someone to monitor it. Archive calendar
replies, identify the booking and contact its actual host manually, including for declines.
No automatic host notification or handling deadline is provided. Do not treat an incoming
calendar reply as authorization to cancel: cancellation remains an explicit Hourmere action.

An instance with **one fixed host** may use its mail provider's filter to forward calendar
replies to that host:

1. Verify the fixed host's forwarding destination with the mail provider.
2. Inspect representative calendar replies and select conditions supported by that provider.
   Subject prefixes and language vary; a subject filter alone cannot reliably identify every
   calendar reply or only declines. If the mailbox also receives support or other private
   mail, forward only reliably classified replies; otherwise sort them manually.
3. Forward a copy and retain the original in the monitored mailbox. Whole-mailbox forwarding
   is appropriate only for a dedicated invitation mailbox or when its sole host is also
   authorized to receive all other mail there.
4. Test accept, tentative and decline replies, plus a reply after rescheduling. Verify that
   the host receives each original reply, the mailbox retains its copy, and the Hourmere
   booking stays confirmed until someone explicitly cancels it. Check the rule and delivery
   failures regularly.

For example, in [Zoho Mail's filter-based forwarding settings](https://www.zoho.com/mail/help/email-forwarding.html),
open **Settings → Filters → New Filter**, set the tested conditions and select **Forward to**
with the verified host address. Save the filter and keep the original message. For dedicated
whole-mailbox forwarding, open **Settings → Mail Accounts → Forwards** and leave
**Delete original email copy after forwarding** unchecked; this setting belongs to the
whole-mailbox forwarding page.
Monitor forwarding health; Zoho can disable forwarding after repeated delivery failures.

This is a fixed single-host workaround. Shared multi-host instances need the booking's UID
mapped to its actual host(s); ordinary mailbox rules have no access to that mapping. Names,
subjects and sender addresses cannot route replies reliably, and forwarding every reply to
all hosts exposes other bookings. Forwarding also does not update calendar attendance or
make the host the organizer. Multi-host operators should use monitored manual handling.

## How the booking services queue them

The booking services load everything their decision needs inside their transactions; the
job loads the rest when it runs (event type title, question labels, host names, emails and
zones, the reschedule chain), which it must do anyway to check the booking's current state.
So the services pass only ids:

- `PublicContext` and `ServiceContext` carry an optional `notify` (`BookingNotifier` in
  `@hourmere/scheduling`): `(trx, event, now) => Promise<void>`, called with the
  transaction that makes the change and the instant the service used for its checks (read
  after it waited for its locks), which also decides whether a reminder is queued.
  Scheduling stays free of pg-boss and mail; tests pass a fake.
  The session-only `cancelTeamAdminBooking` service requires this dependency explicitly;
  it refuses a missing notifier before changing the booking.
- `createPublicBooking` calls it after `insertBooking`, inside the transaction, so never on
  the replay paths (a replay found before or after the host lock returns before it, and
  a concurrent duplicate's unique violation rolls back its jobs with it):
  `{ type: 'created', bookingId, start }`.
- `rescheduleManagedBooking` and `rescheduleHostBooking`, after `insertBooking`: `{ type: 'rescheduled', bookingId:
  <new booking>, start }`. The old booking gets no job of its own: its queued confirmation
  and reminder find it cancelled when they run, and a `cancelled` job would find it
  replaced and send nothing either.
- `cancelLocked` (shared by `cancelManagedBooking` and `cancelHostBooking`), after the
  update: `{ type: 'cancelled', bookingId }`.
- [`server.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/server.ts) builds `notify = bookingNotifier(jobs)` (`@hourmere/notifications`, which
  calls `enqueueBookingNotifications`) for the `all` and `web` roles and passes it to
  `publicRoutes`, `bookingRoutes`, `teamBookingRoutes` and the MCP `bookingTools`, which put it in the contexts
  they build. A worker serves no bookings and needs none.

If `notify` throws (the queue insert fails), the booking change fails with it: a booking
never commits without its emails, and a job never exists for a booking that did not commit.
Tests cover both directions, replays, REST and MCP, and the token rules above:
[`packages/scheduling/src/bookings.test.ts`](https://github.com/hourmere/hourmere/blob/main/packages/scheduling/src/bookings.test.ts) (the services, with a fake notifier),
[`apps/server/src/booking-notifications.test.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/booking-notifications.test.ts) (REST and MCP with real jobs, the job
handler run in-process and a capturing mailer) and [`apps/server/src/server.test.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/server.test.ts) (the
composition root, with the log mailer and a running worker).

Hosts can edit their display name in Settings. Notifications read the current name when
sent; an empty legacy name falls back to the profile handle, then the verified email
address. Email subjects use that current label; calendar organizer CN stays pinned once first sent.

## Sign-in links

Login delivery uses separate `sign-in-email` jobs. Every request takes the same enqueue
path; a worker decides account/registration eligibility. Job JSON carries only an outbox
ID, and the expiring outbox encrypts the recipient and scanner-safe fragment URL. See
[data-model.md](https://github.com/hourmere/hourmere/blob/main/docs/data-model.md#sign-in-email-outbox) for storage and cleanup. Web-only
processes need a worker for sign-in mail, just as they do for booking notifications.
Sign-in emails use the requester's interface-language cookie (`hourmere-language`), then
the request's `Accept-Language`, then English. That choice is stored inside the encrypted
outbox payload so a worker and its retries use the same language; older queued payloads
without a language remain English. Workers ignore unknown additive outbox fields and
fall back to English for unsupported languages while still validating the recipient and
sign-in URL. Restart web and worker processes together when upgrading: older workers
strictly reject the new `language` field and discard the email. Direct delivery uses the
same selection. Subjects, plain text, HTML and HTML `lang` are localized together.

## Guest email controls

Guests are additional recipients supplied by an invitee. New bookings can add them only
when the host enables **Allow invitees to add guests** on that event type; the default is
off, including for event types created before migration 0015. REST and MCP expose the
`allowGuests` flag on event-type detail and authenticated discovery. Nonempty guests on
a disabled event type return `400 guests_not_allowed` before any booking, attendee or
notification is stored. Enabled types retain the ten-guest cap and existing rate limits.

Turning the setting off affects new bookings. Existing guests remain eligible for reminders
and calendar updates/cancellations, subject to the email limits below; retries of a
successfully committed booking preserve the original result.

## Email abuse controls

Team invitation creation and explicit resends are limited at admission:
`INVITATION_INVITER_MAX_PER_HOUR` (default 20) and `INVITATION_INVITER_MAX_PER_DAY`
(default 100), shared across an inviter's teams; `INVITATION_TEAM_MAX_PER_HOUR` (default
50) and `INVITATION_TEAM_MAX_PER_DAY` (default 200), shared across a team's inviters.
Invitations use `MAIL_RECIPIENT_MAX_PER_HOUR` and
`MAIL_RECIPIENT_MAX_PER_DAY` with an independent invitation HMAC domain. They share the
global mail-budget lock, but admission does not debit `MAIL_MAX_PER_HOUR` or consume
guest booking mail capacity. Ordinary request retries and exact
resend replays do not spend another slot; explicit resends never reset rolling counts.
Deleting invitations or teams cannot reset those counts. Request counts expire from the
two-day accounting ledger and do not indicate SMTP delivery. Admission stores only a
purpose-separated recipient HMAC, the inviter/team identifiers and the request time.

Explicit resends require the invitation ID, expected generation and UUID request ID;
they wait 60 seconds from the later of the generation start and latest delivery update,
including worker attempts, stop at 32 generations and extend expiry by the original validity
length. The future invitation sender must update `updated_at` on every delivery attempt
for this post-delivery cooldown to hold. Each delivery generation retains its existing
maximum of four SMTP attempts.
Expired or business-terminal invitations need a new invitation. Invitation admission
never invokes the sign-in worker's account/sign-up eligibility decision and does not
grant an inviter any new registration authority. Errors use fixed codes and diagnostics
omit recipients and underlying database/provider text.

Invitation admission commits the invitation and queued delivery intent together, then
waits for durable pg-boss enqueueing before returning success. It never waits for SMTP.
If enqueueing fails or cannot confirm the exclusive job, the request returns HTTP 503
`INVITATION_DELIVERY_UNAVAILABLE`; the invitation and queued intent remain saved. Retry
the same request, including the same resend request ID and expected generation, to
recover without creating another generation or spending another admission slot.

The `invitation-email-v1` queue carries only `{ invitationId, generation }`, with an
exclusive `invitation-email:v1:<invitationId>:<generation>` key and zero pg-boss retries.
The delivery record owns the eventual attempt budget. A worker-startup and every-minute
repairer checks at most 100 due queued records per pass, advances its invitation-ID
cursor even after an individual failure, and repairs missing live jobs transactionally.
It checks the pinned pg-boss job identity, payload, state and expiry before enqueueing.
Terminal delivery records are never automatically requeued.

The invitation worker currently only rechecks lifecycle and generation: canceled,
accepted, rejected, unknown-status or expired invitations become `skipped`; stale jobs
leave the newer generation untouched. Current pending records remain queued for the
future sender. No invitation mail is sent yet. A future sender must check and debit
shared non-reserved mail capacity at send time, integrate attempts, leases and backoff,
and recheck authorization before SMTP. Admission accounting is separate from that debit.

Invitees may reschedule a booking at most `BOOKING_MAX_INVITEE_RESCHEDULES` times (default
5) across its entire reschedule chain. New response tokens and older email links use the
same count; host/admin moves neither consume nor reset it. `0` disables invitee
rescheduling. At the cap, invitee slot lookup and rescheduling return HTTP 409
`booking_reschedule_limit`, with an English/Chinese manage-page message asking them to
contact the host. Cancelling remains possible, and authenticated hosts may still move it.
Existing chains count their earlier invitee moves too.

Before every booking notification send (confirmed, rescheduled, cancelled, reminder and
conference-failure notices), the worker enforces two rolling windows for invitees and
guests: `MAIL_RECIPIENT_MAX_PER_HOUR` (default 5) and `MAIL_RECIPIENT_MAX_PER_DAY` (default
20, over 24 hours). These counters are shared across bookings and organizations. Host mail
does not consume the booking recipient budget. Changing IPs, cancelling and rebooking, or
deleting a booking does not reset the mail counters.

After checking account/registration policy, the sign-in worker applies
`SIGN_IN_MAIL_MAX_PER_HOUR` (default 5) and `SIGN_IN_MAIL_MAX_PER_DAY` (default 20, over
24 hours). Sign-in recipient hashes use a separate domain from booking hashes, so sign-in
and booking recipient counts do not mix, even for the same mailbox. If limited, the worker
deletes the outbox row, emits a WARN with the recipient hash and reason only, and sends
nothing. Retrying that job never resends it. Every sign-in request retains the same HTTP
response whether an address is ineligible, under a mail limit or allowed to receive mail;
the HTTP request does not check these budgets or wait for SMTP.

Recipient normalization is trim + lowercase only. Plus-addressing, Gmail dots and IDN
variants are not merged; the instance cap is the backstop for those variants. Ledger and
suppression-log recipient hashes use HMAC-SHA-256 with a key derived from
`BETTER_AUTH_SECRET` under a fixed mail-accounting label, and separate booking/sign-in
domains. Without the secret, hashes cannot be matched against a dictionary of addresses.
Use the same secret on every web and worker process. Rotating it resets the recipient
counters because earlier hashes no longer match, while instance counts remain intact.

`MAIL_MAX_PER_HOUR` (default 100, `0` means unlimited) counts **all booking notification
and sign-in emails**, including hosts, across every worker sharing this instance's
database. Invitee and guest messages are suppressed once that many were sent in the
preceding hour. Hosts are sent first within each booking job. Host and sign-in mail may
continue until 120% of that cap (rounded down), then are suppressed too; both share that
reserve, and sign-in recipient limits still apply. For example, with the default cap,
invitee/guest mail stops at 100 sends and host/sign-in mail stops at 120. Set the cap below
your SMTP provider's hourly allowance, accounting for this reserve and any other mail
using the same provider. For a cap below 5, rounding may leave no extra allowance.

Cap checks and SMTP delivery use the existing send transactions, serialized across workers
with one database advisory lock. Notification and sign-in sends are serialized per instance,
so slow SMTP holds up other notification and sign-in sends until it finishes or fails.
Successful sends add only a recipient hash for invitee/guest and sign-in mail (NULL for
host mail) and a timestamp to `notification_email_sends`; no plain address is stored in
this ledger. Failed sends roll back their count and remain retryable under the existing
policy. The SMTP acceptance/failed-commit duplicate window described above still applies.

A limited booking message commits `booking_notifications.outcome = 'suppressed'`, a stable
`suppression_reason`, and no manage-token hash. It does not fail the booking or the job,
and retries never send it later, even when the rolling window clears or an operator raises
the cap. A structured WARN log includes booking/kind, reason and recipient hash, never the
plain email address. Operators can count outcomes and reasons in `booking_notifications`;
these receipts remain subject to existing booking deletion. Sign-in suppression deletes
its outbox row rather than creating a booking receipt.

The hourly `notification-email-cleanup` job purges ledger rows older than two days,
independently of booking deletion. Migration 0040's unchanged backfill seeds the ledger
from all retained sent receipts for the last two days. Rows without recipient identity get
a NULL hash and still count toward the instance cap. Its legacy unkeyed SHA-256 hashes (and
any rows from earlier code) count toward the instance cap but do not match new HMAC
recipient windows. The recipient-count gap
lasts at most 24 hours, and those old hashes are purged after two days. Deleted identities
cannot be recovered. Mixed old/new processes are schema-compatible, but old workers send
without being counted or enforcing these budgets: build first, stop all old web/all/worker
processes, then start the new code. See the
[0040 upgrade notes](/docs/self-hosting#upgrading-from-a-pre-10-checkout).

These controls have no CAPTCHA, do not verify invitee/guest addresses, and apply per
instance/database. Per-IP request limits remain in process memory; separate instances do
not share a mail budget. The controls reduce volume and may suppress legitimate updates;
invitees who reach a limit should contact the host.

An attacker who can trigger mail to eligible addresses can exhaust the instance hourly cap,
including its host/sign-in reserve. Until the rolling hour clears (up to an hour after the
last counted send, longer if triggering continues), every host's sign-in email is dropped,
so hosts must request a new link later, and all booking notification mail is suppressed and
never sent later. Existing sessions are unaffected. Operators can raise `MAIL_MAX_PER_HOUR`
while keeping the cap, reserve and other mail within their provider's limit; raising it does
not resend messages that were already suppressed.

## Outbound booking webhooks

The composition root also invokes the optional webhook notifier in the same booking
transaction. Its ID-only jobs and immutable minimal snapshots are independent of email
delivery and management capabilities. Global configuration defaults off; see
[Booking webhooks](/docs/webhooks) for signatures, retry limits, permissions and network policy.

For explicitly automatic Google Meet bookings, confirmed/rescheduled invitations and reminders wait for current-revision readiness through a durable outbox. Old generic jobs gate again before each send. Terminal failures generate a separately labelled `conference_failed` notice to host/booker without REQUEST ICS; cancellation messages remain independent. Sensitive meeting messages are omitted from the development log mailer. See [Automatic Google Meet](/docs/automatic-google-meet).

### Conference outbox delivery budget

Migration0024 gives each conference outbox row one initial attempt and at most twelve
retries. Its persisted delay starts at one minute, doubles and caps at one hour. A new cron
job never resets that budget. Temporary recipient refusal, all-recipient permanent refusal,
transport errors and interrupted attempts consume the same row budget; a broken booking
does not prevent another booking from being attempted. Already committed recipient receipts
remain deduplicated. Missing original booker or a temporarily unverified organizer does not
fabricate a delivered invitation; a restored eligible identity can release the pending
notice when it is next due. REQUEST/reminder notices still stop when the meeting starts.
A terminal conference failure may have a finite logistical retry after start.

Each attempt commits a random ten-minute lease and increments its counter before SMTP,
without holding a booking/outbox row lock during network I/O. Sends receive a four-minute
attempt deadline and the worker's shutdown signal. Lease ownership is checked again before
each new recipient, and completion uses the lease ID and attempt number. A stale worker
cannot consume the replacement worker's claim. A crashed final attempt becomes exhausted
after its lease expires; no fourteenth attempt is authorized. Each dispatch handles at most
100 obsolete notices, 100 expired final claims and 100 distinct outbox delivery attempts; the same row is not
immediately retried again within that dispatch. SMTP acceptance followed by a failed
receipt commit still has the previously documented duplicate window; leases do not make
external SMTP delivery exactly once.

Migration0026 adds `skipped_at`, a distinct terminal outcome with `delivered=false`:
the booking was cancelled, replaced or already started, a failure notice was overtaken by
conference recovery, or its invitation/failure gate
closed while an attempt was delivering. Already committed recipient receipts remain visible;
skipped never claims that every intended recipient was emailed. A lifecycle sweep skips
unclaimed obsolete rows without consuming an attempt and never takes a live lease. A notice
waiting for its ready/failed conference state remains unclaimed while that gate is closed;
it may become eligible later. A notice skipped during delivery remains terminal.

`exhausted_at` is an inspectable terminal failure, with `delivered=false` and a bounded
`last_error` classification. Diagnostics contain booking ID/kind, never SMTP response text,
recipient addresses, answers, meeting URLs or tokens:

```sql
SELECT booking_id,kind,attempts,due_at,last_error,exhausted_at,skipped_at,
       CASE WHEN delivered THEN 'delivered'
            WHEN skipped_at IS NOT NULL THEN 'skipped'
            WHEN exhausted_at IS NOT NULL THEN 'exhausted'
            ELSE 'pending' END AS outcome
  FROM booking_conference_notifications
 WHERE NOT delivered
 ORDER BY due_at;
```

Repair mail configuration or identity first. An operator may deliberately grant one
identified exhausted row a new budget during maintenance after workers have stopped and
the previous lease has ended; do not automatically reset every failed row. Existing
recipient receipts and current booking/revision/verification guards must remain intact.
Skipped rows need no delivery repair; current cancellations and reschedules have their own
notifications. This is not a force-send endpoint or a promise of real inbox acceptance.

Old rows retain their exact `due_at` and `delivered` values on upgrade, and `skipped_at`
starts null without rewriting historical delivery outcomes. Because earlier
attempt history was not recorded, their new counter starts at zero: one finite post-upgrade
budget, without inventing historical sends or erasing existing recipient receipts.
