# Notifications and background jobs

Booking emails (confirmed, rescheduled, cancelled, reminder) are sent by a background job,
never from the request that changed the booking: a slow or broken mail server must not slow
down or fail a booking, and a failed send must be retried.

The pieces: the job infrastructure (`@hourmere/jobs`), the worker process role, the email
templates and calendar invitations (`@hourmere/mail`), the notification job and the queueing
helper (`@hourmere/notifications`), the `booking_notifications` table, and the booking
services (`packages/scheduling/src/bookings.ts`), which queue the jobs in the transaction of
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
only applies `packages/db/migrations` and records them in `public.schema_migrations`; it
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
`docker-compose.yml`, `docker stop -t 35`, or the orchestrator's equivalent; Docker's
default of 10 seconds cuts long jobs short (they are retried, so nothing is lost).

## Events and their jobs

All notifications go through one job, `booking-notification`, with payload
`{ bookingId, kind }` (queue policy `exclusive`, singleton key `<bookingId>:<kind>`).

| Event (service) | Jobs queued in its transaction |
|---|---|
| Booking created (`createPublicBooking`, not on an idempotent replay) | `confirmed` now; `reminder` 24 hours before the start, unless that is less than an hour away |
| Booking rescheduled (`rescheduleManagedBooking`) | for the **new** booking: `rescheduled` now; `reminder` as above. Nothing for the old one (see below) |
| Booking cancelled (`cancelManagedBooking`, `cancelHostBooking`) | `cancelled` now |

The same services serve the booking page, the REST API and the MCP tools, so a booking an
agent makes, moves or cancels sends exactly the emails a person's would.

`enqueueBookingNotifications(jobs, trx, event, now)` does exactly this, and refuses to run
outside a transaction. The reminder offset is an absolute 24 hours, so across a daylight
saving change it arrives an hour earlier or later on the recipient's clock; a booking made
less than 25 hours ahead gets no reminder, as it would come right after the confirmation.

Every email goes to each host first (they most need to know), then the invitee, then the
guests, so a guest address that is slow to answer cannot hold up the others. Hosts are the
booking's `booking_hosts` whose address is verified: accounts start verified, and one that
is not (it should not exist; see data-model.md) is neither emailed nor named in the
invitation, so a booking without a verified host sends nothing (the job logs one WARN line
naming the booking and the kind, since the invitee hears nothing either). Guests are
addresses an anonymous booker typed (up to 10 per booking); limiting abuse of that is a
product follow-up. Times are shown in the recipient's zone with its IANA name: the attendee's zone from `booking_attendees`, a
host's from their profile, else their default schedule, else UTC. Host emails add the
invitee's contact details, guests and answers; only the invitee's email has manage links.
Confirmed and rescheduled emails carry an invitation (`METHOD:REQUEST`), cancellations a
cancellation (`METHOD:CANCEL`); reminders carry none.

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
row (`ON CONFLICT DO NOTHING`); if it already exists the email was sent and is skipped;
otherwise it sends the email and commits.

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
transaction (so a failed send leaves no token behind). The booking's own hash is never
changed. Every token, the API's and each email's, opens the booking for as long as it
exists. No raw secret is stored anywhere, encrypted or not, and the queue holds only
`{ bookingId, kind }`; nothing depends on `BETTER_AUTH_SECRET`; retries are harmless (at
worst an unused hash); reminders carry working links. The cost is a second place to look
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

- **The API's token stays with its booking.** After a reschedule it shows the old, cancelled
  booking, and cancelling or rescheduling with it gets 409 `booking_cancelled`. That is the
  documented contract agents rely on: a reschedule retried after a lost response cannot move
  the meeting twice. The reschedule's response carries the new booking's token.
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
  of chasing the meeting. The API's token is locked as before and then finds its booking
  cancelled.

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
same calendar entry; `SEQUENCE` is the number of
reschedules in the chain, plus one for a cancellation. Times are UTC. The organizer is the
host; attendees are the invitee, guests and any other hosts, all `PARTSTAT=ACCEPTED`,
`RSVP=FALSE`. It is attached as `invite.ics` (`cancel.ics`) with content type
`text/calendar; method=REQUEST; charset=UTF-8` (or `CANCEL`), not as an alternative body
part: clients that turn such a part into a meeting item would hide the email's own text and
links.

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
- `createPublicBooking` calls it after `insertBooking`, inside the transaction, so never on
  the replay paths (a replay found before or after the host lock returns before it, and
  a concurrent duplicate's unique violation rolls back its jobs with it):
  `{ type: 'created', bookingId, start }`.
- `rescheduleManagedBooking`, after `insertBooking`: `{ type: 'rescheduled', bookingId:
  <new booking>, start }`. The old booking gets no job of its own: its queued confirmation
  and reminder find it cancelled when they run, and a `cancelled` job would find it
  replaced and send nothing either.
- `cancelLocked` (shared by `cancelManagedBooking` and `cancelHostBooking`), after the
  update: `{ type: 'cancelled', bookingId }`.
- `server.ts` builds `notify = bookingNotifier(jobs)` (`@hourmere/notifications`, which
  calls `enqueueBookingNotifications`) for the `all` and `web` roles and passes it to
  `publicRoutes`, `bookingRoutes` and the MCP `bookingTools`, which put it in the contexts
  they build. A worker serves no bookings and needs none.

If `notify` throws (the queue insert fails), the booking change fails with it: a booking
never commits without its emails, and a job never exists for a booking that did not commit.
Tests cover both directions, replays, REST and MCP, and the token rules above:
`packages/scheduling/src/bookings.test.ts` (the services, with a fake notifier),
`apps/server/src/booking-notifications.test.ts` (REST and MCP with real jobs, the job
handler run in-process and a capturing mailer) and `apps/server/src/server.test.ts` (the
composition root, with the log mailer and a running worker).

Hosts can edit their display name in Settings. Notifications read the current name when
sent; an empty legacy name falls back to the profile handle, then the verified email
address. The same label is used in email subjects and calendar organizer names.

## Sign-in links

Login delivery uses separate `sign-in-email` jobs. Every request takes the same enqueue
path; a worker decides account/registration eligibility. Job JSON carries only an outbox
ID, and the expiring outbox encrypts the recipient and scanner-safe fragment URL. See
[data-model.md](data-model.md#sign-in-email-outbox) for storage and cleanup. Web-only
processes need a worker for sign-in mail, just as they do for booking notifications.

## Guest email controls

Guests are additional recipients supplied by an invitee. New bookings can add them only
when the host enables **Allow invitees to add guests** on that event type; the default is
off, including for event types created before migration 0015. REST and MCP expose the
`allowGuests` flag on event-type detail and authenticated discovery. Nonempty guests on
a disabled event type return `400 guests_not_allowed` before any booking, attendee or
notification is stored. Enabled types retain the ten-guest cap and existing rate limits.

Turning the setting off affects new bookings. Existing guests still receive reminders and
calendar updates/cancellations so their invitations do not become stale; retries of a
successfully committed booking preserve the original result. This opt-in limits anonymous
guest email amplification; it does not verify the main invitee's email address or eliminate
all email abuse.
