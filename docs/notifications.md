# Notifications and background jobs

Booking emails (confirmed, rescheduled, cancelled, reminder) are sent by a background job,
never from the request that changed the booking: a slow or broken mail server must not slow
down or fail a booking, and a failed send must be retried.

What exists today: the job infrastructure (`@hourmere/jobs`), the worker process role, the
email templates and calendar invitations (`@hourmere/mail`), the notification job and the
queueing helper (`@hourmere/notifications`), and the `booking_notifications` table. The
booking services (`packages/scheduling/src/bookings.ts`) do not queue anything yet; the last
section lists the changes that wire them in.

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
database answers and its workers are running, and answers 404 to everything else. Do not
publish a worker's port.

On SIGTERM a process stops accepting requests, then stops taking jobs and waits up to 20
seconds for running ones (any still running then are failed and retried later by another
worker), then closes its pools. Give it time to do so: `stop_grace_period: 30s` in
`docker-compose.yml`, `docker stop -t 30`, or the orchestrator's equivalent; Docker's
default of 10 seconds cuts long jobs short (they are retried, so nothing is lost).

## Events and their jobs

All notifications go through one job, `booking-notification`, with payload
`{ bookingId, kind }` (queue policy `exclusive`, singleton key `<bookingId>:<kind>`).

| Event (service) | Jobs queued in its transaction |
|---|---|
| Booking created (`createPublicBooking`, not on an idempotent replay) | `confirmed` now; `reminder` 24 hours before the start, if that is still ahead |
| Booking rescheduled (`rescheduleManagedBooking`) | for the **new** booking: `rescheduled` now; `reminder` as above |
| Booking cancelled (`cancelManagedBooking`, `cancelHostBooking`) | `cancelled` now |

`enqueueBookingNotifications(jobs, trx, event, now)` does exactly this. Every email goes to
each attendee (the invitee and their guests) and each host. Times are shown in the
recipient's zone with its IANA name: the attendee's zone from `booking_attendees`, a
host's from their profile, else their default schedule, else UTC. Host emails add the
invitee's contact details, guests and answers; only the invitee's email has manage links.
Confirmed and rescheduled emails carry an invitation (`METHOD:REQUEST`), cancellations a
cancellation (`METHOD:CANCEL`); reminders carry none.

### Checked when sent, not when queued

The job reads the booking when it runs and sends only what is still true:

| Kind | Sent only if |
|---|---|
| `confirmed` | the booking is confirmed and has not started |
| `rescheduled` | the booking is confirmed, replaced an earlier one, and has not started |
| `reminder` | the booking is confirmed and has not started |
| `cancelled` | the booking is cancelled and no booking replaced it |

So nothing has to be un-queued. A reschedule cancels the old booking and creates a new one,
so the old booking's reminder finds it cancelled and sends nothing, and the new booking has
its own reminder; a cancelled booking's reminder does the same. A reschedule also does not
send a cancellation for the old booking (it has a successor): the reschedule email covers
it. This is more robust than deleting jobs by key, which would have to happen in the same
transaction and would miss any path that changes a booking without knowing about jobs.

### Sent at most once

`booking_notifications` has one row per email: primary key (booking, kind, recipient), the
recipient being `host:<user id>` or `attendee:<attendee id>` (so someone who books their own
event type gets both emails). For each recipient the job, in one transaction, inserts the
row (`ON CONFLICT DO NOTHING`); if it already exists the email was sent and is skipped;
otherwise it sends the email and commits.

- A failed send rolls the row back and fails the attempt; the retry sends to the
  recipients still missing, not to everyone again.
- Two attempts at the same time (a job that ran past its expiry and was retried while still
  running): the second insert waits for the first transaction, then skips.
- The only duplicate left: the mail server accepted the email and the commit then failed.
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
removed and names quoted. The UID is `<first booking of the reschedule chain>@<PUBLIC_URL
host>`, so a reschedule updates the same calendar entry; `SEQUENCE` is the number of
reschedules in the chain, plus one for a cancellation. Times are UTC. The organizer is the
host; attendees are the invitee, guests and any other hosts, all `PARTSTAT=ACCEPTED`,
`RSVP=FALSE`. It is attached as `invite.ics` (`cancel.ics`) with content type
`text/calendar; method=REQUEST; charset=UTF-8` (or `CANCEL`), not as an alternative body
part: clients that turn such a part into a meeting item would hide the email's own text and
links.

## Wiring it into the booking services (follow-up)

The booking services already load everything the decision needs inside their
transactions; the job loads the rest when it runs (event type title, question labels, host
names, emails and zones, the reschedule chain), which it must do anyway to check the
booking's current state. So the services pass only ids:

1. `PublicContext` and `ServiceContext` get an optional
   `notify?: (trx: Db, event: BookingEvent) => Promise<void>`; scheduling stays free of
   pg-boss and mail, and tests can pass a fake.
2. `createPublicBooking`: after `insertBooking`, inside the transaction, and not on the
   replay paths: `notify(trx, { type: 'created', bookingId: id, start: input.start })`.
3. `rescheduleManagedBooking`: after `insertBooking`:
   `notify(trx, { type: 'rescheduled', bookingId: id, start })`.
4. `cancelLocked` (shared by `cancelManagedBooking` and `cancelHostBooking`): after the
   update: `notify(trx, { type: 'cancelled', bookingId: row.id })`.
5. `server.ts` builds `notify = (trx, event) => enqueueBookingNotifications(jobs, trx, event,
   now())` and passes it to `publicRoutes` and `bookingRoutes`, which put it in the
   contexts they build. The `jobs` instance is already started in every role.
6. Token lookups (`getManagedBooking`, `cancelManagedBooking`, `rescheduleManagedBooking`
   match `bookings.manage_token_hash`) also accept a hash found in
   `booking_notifications.manage_token_hash` (unique, indexed), keeping the `FOR UPDATE`
   lock on the booking row.
7. Tests: a booking, reschedule and cancel each queue the expected jobs in their
   transaction (and none on a replay or a failed booking); an email's token opens, cancels
   and reschedules the booking; the API's token keeps working after emails went out.
