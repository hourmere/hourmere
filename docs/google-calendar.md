# Google Calendar connections

Google Calendar connections are separate from Google sign-in. Signing in never requests
calendar permissions, and connecting a calendar never creates or links a sign-in account.
Connections belong to a user across their organizations. The user's own API keys can list
connection metadata, refresh the calendar list, choose conflict calendars and the writeback
destination, and sync now. OAuth authorization, code exchange and disconnect require a live
browser session. Read-only MCP listing accepts API keys and enabled MCP OAuth grants.

People explicitly select calendars for conflict checks and an owned calendar for new
booking events. Connecting alone enables neither: new calendars have `check_conflicts=false`
and the profile has no destination. List-only connections remain supported and must be
reauthorized before using synchronization. Shared calendars can block time when events are
readable; booking events can only be written to calendars the connected account owns.

## Configure an instance

1. In Google Cloud, enable Google Calendar API and configure Google Auth Platform branding
   and an External audience. During development, keep the app in Testing and add the intended
   Google accounts as test users. Public use and sensitive-scope verification are separate
   launch steps.
2. Create a **Web application** OAuth client dedicated to calendar connections. Register
   exactly `{PUBLIC_URL}/api/calendar/google/callback` as its redirect URI. For `npm run dev`,
   this is `http://localhost:5173/api/calendar/google/callback`; Vite proxies `/api` to the
   server. No JavaScript origin is needed for this server-side authorization-code flow.
   Production requires HTTPS; HTTP is allowed only for loopback development hosts.
3. Set `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` and
   `CALENDAR_ENCRYPTION_KEY`. Generate the latter with `openssl rand -base64 32`. Keep the key
   stable, private and backed up with the deployment secrets: changing it makes existing
   credentials unreadable. Never put these values in version control. Docker Compose passes
   all three variables to the app/worker.
4. In the app, open **Calendars**, choose **Connect Google Calendar**, and approve the account
   email, calendar-list and synchronization access. Returning to the app shows the calendar
   list. Select **Check conflicts** on the calendars to synchronize and **Write new bookings**
   on an owned destination. Create a profile first. **Sync now** fetches busy times immediately;
   workers also poll selected calendars every minute. **Refresh calendar list** updates metadata.

These settings do not enable Google sign-in. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
`/api/auth/callback/google` continue to configure only sign-in. Separate clients also avoid
combining sign-in and calendar grants for the same OAuth client.

Upgrade note: `CALENDAR_ENCRYPTION_KEY` must now differ from `WEBHOOK_ENCRYPTION_KEY` and
`BETTER_AUTH_SECRET`; startup refuses a reused key. Keep the calendar key stable and backed
up: rotating it makes stored calendar tokens undecryptable, and affected accounts must be
connected again.

The default API request (`access=list`) requests `openid`, `email`, and
`https://www.googleapis.com/auth/calendar.calendarlist.readonly`. The web app requests
`access=sync`, adding `https://www.googleapis.com/auth/calendar.events.readonly` and
`https://www.googleapis.com/auth/calendar.events.owned`. The latter limits event writes to
owned calendars, including shared calendars you own, rather than every writable calendar. Google may return the
canonical `https://www.googleapis.com/auth/userinfo.email` spelling for `email`. Partial
consent is refused against the scopes saved in that particular authorization attempt.
Busy synchronization fetches event IDs, times, transparency and the current account's
attendance status. Titles, descriptions, locations and contact addresses are not requested
or stored for external events. Our own booking events contain their booking title and times;
no attendee list, manage links or invitation emails are sent by this integration. Ordinary
writeback creates no conference; automatic Meet requires the separate explicit opt-in below.
Booking email/ICS continues through the existing notification worker.

Google's External Testing mode has short-lived refresh-token rules; see the official
[web server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).
A revoked/expired grant changes the connection to `needs_reauth`; reconnect through the
same separate consent flow. Temporary provider failures preserve the connection for retry.

## Protocol and API

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/calendar-connections` | Own connection/calendar metadata and whether Google is configured; no credentials |
| `POST /api/v1/calendar-connections/google/authorize` with `{access?}` | Same-origin browser session; returns a Google authorization URL |
| `GET /api/calendar/google/callback` | Google OAuth protocol callback; immediately redirects to `/app/calendars` with a fixed result code |
| `POST /api/v1/calendar-connections/{id}/refresh` with `{}` | Session or own API key; refresh own calendar list, obtaining a fresh access token when needed |
| `PATCH /api/v1/calendars/{id}` with `{checkConflicts}` | Select up to 20 owned/accessible readable calendars for conflict checks; queues an initial sync transactionally |
| `POST /api/v1/calendars/{id}/sync` with `{}` | Synchronize a selected calendar now |
| `PUT /api/v1/calendar-destination` with `{calendarId}` | Set/clear the profile's owned default destination for new bookings |
| `DELETE /api/v1/calendar-connections/{id}` | Browser session; remove own local connection, credentials and calendars |

Non-credential settings accept the user's own API keys with the same ownership checks.
Cookie-authenticated writes require the app's origin. OAuth authorization, code exchange
and disconnect remain session-only. Missing/foreign connections return
404 `calendar_connection_not_found`. Disabled Google configuration returns 409
`google_calendar_disabled`; failed refreshes return 409 `google_calendar_needs_reauth`,
`google_calendar_permissions_missing` or `google_calendar_provider_unavailable`.

Authorization attempts expire after ten minutes and are limited to five outstanding per
user. A SHA-256 state digest is bound to the existing user and session; the PKCE verifier is
encrypted. Claiming an attempt is atomic, before exchanging a code, and failure does not
make it reusable. A callback from another session cannot consume it. Disconnect removes
pending attempts, so a callback already waiting on Google cannot resurrect the connection.
Starting/refreshing authorization and callbacks are rate limited to 30 requests per minute
per client IP in each server process (with the shared proxy/IP handling).

Credentials use versioned AES-256-GCM ciphertext with random IVs. Authenticated context
binds each token to its owner/provider/account and each verifier to its owner/session/state.
Only the stable Google account ID from the authenticated UserInfo endpoint identifies the
external account; the returned email must be verified. The client secret, tokens, PKCE
verifier and raw provider errors never appear in API responses, redirects or logs. Callbacks
send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; the request logger strips
their query strings. Provider calls use fixed official endpoints, a shared 15-second deadline,
bounded response bodies/pages, and refuse HTTP redirects.

Reconnection preserves the connection ID, its calendars' existing settings and a previous
refresh token when Google omits a replacement. Reconnection/disconnect briefly lock the owner; calendar-list refresh holds only an owner
key-share lock plus its connection row lock across provider work, so public bookings remain
compatible. Connection row locks serialize token rotation, refresh and writes. A rotated refresh token is saved even if the subsequent calendar
list request fails. A complete calendar-list fetch replaces local metadata atomically;
removed calendars and their dependent local data are deleted.

**Disconnect** deletes local credentials/data and stops this connection's access. It does
not revoke the Google-wide grant, since Google revocation can invalidate other connections
using the same client/account. Users can also remove Hourmere in their
[Google Account connections](https://myaccount.google.com/connections). Deleting the user
or the session cascades its outstanding authorization attempts.

Implementation references:
[Google web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[CalendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list),
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## Busy-time and recurring-event synchronization

The `calendar-sync-dispatch` recurring pg-boss job runs each minute on workers. It scans all
selected active Google calendars in pages and enqueues deduplicated `calendar-sync` jobs.
No web-process timer or additional service is required. A calendar's first sync fetches a
complete expanded window (three days before today to 403 days after it); subsequent polls
use its sync token, without the time bounds Google forbids with that token. The window is
renewed daily. A 410 discards the cursor and fetches a new complete snapshot. Pages are
bounded (100 pages / 20,000 events); an incomplete or malformed result never replaces the
live data. Cursor and busy intervals commit atomically. Retries preserve rotated credentials.

Google expands recurring events and their exceptions (`singleEvents=true`). Cancelled,
transparent and self-declined events remove their busy intervals. All-day ends are exclusive
local midnights in the calendar's time zone, including DST changes. Sub-millisecond intervals
are widened before database storage. Only event IDs and busy intervals are mirrored.

Availability over REST, public pages and MCP refuses selected Google calendars when their
snapshot is missing, failed, older than ten minutes, revoked, or does not cover the requested
range including scheduling buffers. The error is 409 `calendar_sync_unavailable`: unknown
calendar state never silently becomes free time. Far-future requests beyond the synchronized
window are unavailable. Disable a conflict calendar deliberately to stop using its busy time.
Network/polling latency still permits an external event created after the last successful poll
to race a booking; Google does not offer a transaction shared with our booking database.

## Booking writeback

Booking changes enqueue `booking-calendar` inside the booking transaction, alongside email
notifications. Payloads contain only the reschedule-chain root ID. The destination is saved
in `booking_calendar_targets` in the same transaction, so changing the profile while a job
waits or retries does not move an existing meeting. Event-type destination overrides are
honored when they belong to the same host and are owned Google calendars. Missing destinations
create no Google event. This selection affects new bookings; existing Google bindings stay.

The worker always reads the latest state of the chain. Its `stately` queue permits one
follow-up while a write is in flight, so a concurrent cancellation/reschedule is not dropped.
It imports a private host copy with the existing ICS UID `<root booking id>@hourmere`, first
looking up that UID to recover a previous successful import whose response/DB mapping was
lost. Updates use the same provider event and an ETag; cancellation marks it cancelled.
Duplicate matching UIDs are refused rather than arbitrarily editing one. Google API writes
are retried after provider failures; this is eventual projection, not an atomic Google/SQL
transaction. Provider-side effects may precede the local commit, so UID lookup is part of
every retry. Existing ICS copies with this UID can be reused. Bookings retain the same UID
and sequence as the notification integration. The worker does not modify unrelated events.

Own event mirrors update immediately after successful writes. During rescheduling, mappings
from ancestors are also excluded, so an earlier writeback cannot block moving the same
meeting back into its former slot while a newer write is queued. Connection-owner locks
serialize refresh, busy sync, writeback and disconnect. Disconnect deletes local metadata,
credentials, mappings and targets; it leaves existing Google event copies in the user's
calendar and stops future updates. Google-side edits/cancellations do not change Hourmere
bookings. Push notifications and shared-calendar writes are follow-ups.

### Automatic Meet projection

An explicitly opted-in automatic Meet booking imports the same private host copy with UID
`<root booking id>@hourmere`, without attendees or `conferenceData.createRequest`. Conference
creation on `events.import` was observed to remain pending indefinitely on a real Google
account. After import, the conference worker uses the returned event ID and ETag to send
`PATCH events/<known id>?sendUpdates=none&conferenceDataVersion=1`, with `If-Match` and a body
containing only `conferenceData.createRequest`: the intent's persisted `request_id` and
`conferenceSolutionKey.type=hangoutsMeet`. See Google's [events.patch reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).

The worker records the acknowledged PATCH request ID in `conference_patch_request_id` and
polls that event with bounded backoff until a successful Meet video entry point is ready or
creation fails. A lost response can replay the PATCH with the same request ID; a lost import
mapping recovers by strict root UID rather than importing again. Migration 0036 leaves the
new marker null on existing intents: an old import-created pending request receives the
PATCH with its original UUID first and a fresh bounded polling budget after acknowledgment.
Already failed intents require the pinned organizer's existing explicit conference retry;
the migration does not requeue terminal work. An existing valid Meet link is preserved. Rescheduling
updates the same event without replacing its conference; cancellation patches
`status=cancelled`. Every PATCH suppresses provider updates; no DELETE is used.

HTTP 412 on the conditional conference PATCH causes a re-GET and retry with the current ETag
and the same UUID, following Google's [precondition-failure guidance](https://developers.google.com/workspace/calendar/api/guides/errors#412_precondition_failed).
HTTP 400 on a known-event PATCH (conference, reschedule or cancellation) is deliberately
terminal `invalid_response`: Google's [400 guidance](https://developers.google.com/workspace/calendar/api/guides/errors#400_bad_request)
requires correcting the invalid request. The known event survives; no new import is allowed.

Google [documents duplicate request IDs as ignored](https://developers.google.com/workspace/calendar/api/v3/reference/events#conferenceData.createRequest).
Whether a same-ID PATCH unsticks an old import-created request still needs live acceptance.
The worker never automatically rotates an indefinitely pending request: after bounded
polling it reports `conference_pending_timeout`, distinct from `provider_unavailable`
transport failures and a provider-reported `conference_failed`. Host retry grants one new
bounded read/poll budget for the same event and UUID; it does not repeat an acknowledged
PATCH. If Google keeps ignoring the duplicate UUID, host retry can time out again.

For a request that remains stuck, an operator must perform an explicit maintenance repair:

1. Stop reconciliation for that intent and ensure every previous operation and lease has
   ended. Inspect the exact pinned Google event; verify the current booking is confirmed,
   its poll budget exhausted, the root UID matches and Google still reports a pending
   create request without a valid Meet link. Preserve any already-ready conference instead.
2. In one short transaction, lock the current booking then intent and recheck the booking,
   revision and request identity. Persist a fresh `request_id`, clear
   `conference_patch_request_id`, `error_code` and lease fields, reset `attempts` to zero,
   set `state=pending` and make `next_attempt_at` due. Retain the known event and every
   provider/account/calendar pin.
3. Resume reconciliation. Recovery re-reads that same event and preserves any ready
   conference before it sends the new request.

This repair remains an operator decision because an old asynchronous request may still
complete. There is no host/CLI UUID-rotation path; normal retries retain the UUID except
after a known provider `conference_failed`. Neither repair nor retry permits another import
or a replacement calendar. See
[automatic Meet](automatic-google-meet.md) for identity, notification and recovery policy.

A host whose destination needs reauthorization or lacks sync permissions does not block
other hosts' copies. Its original destination is retained even for bookings made while
reauthorization is needed. Each destination has its own ten-second deadline inside a shared two-minute writeback
deadline, so a stalled provider call for one host also leaves time for other hosts.
Temporary failures are collected after every destination has been attempted and use the normal job backoff (12 retries, up to one hour between attempts).
Google event API 403 responses with `rateLimitExceeded`, `userRateLimitExceeded` or
`quotaExceeded` use this retry path. Other 403 responses record `permissions_missing` in the
owner's `lastError` metadata, and the Calendars page prompts the host to reconnect even while
the connection is active. A temporary provider error clears after the next successful
synchronization or writeback. A permissions error stays until the host reconnects, even when
other syncs, writebacks or calendar-list refreshes on that connection succeed; reconnecting
clears it and writes the missed events through the recovery pass described below.
Availability continues to fail closed immediately for selected calendars with sync failures.

Reauthorizing an existing Google connection queues a finite `booking-calendar-recover`
pass for that account's host. Each page examines at most 100 future, confirmed latest
bookings and queues the next page. It queues only missing copies on that connection,
preserves previously saved destinations, and skips automatic-conference bookings. For
bookings from an older outage with no saved destination, it captures the host's current
owned destination on that connection. Successful existing copies are left alone. Recovery
pages have five retries with backoff; there is no recurring retry-budget reset.

After fixing a provider/configuration problem, an operator can explicitly re-dispatch jobs
whose 12 writeback retries (or five recovery-page retries) have been exhausted:

```sh
node --env-file=.env scripts/redispatch-calendar-writeback.ts --connection-id <connection UUID>
```

Run this from the repository checkout with the deployment's environment and workers running.
The Docker runtime includes this recovery script. With Docker Compose, use the container's
configured environment instead:

```sh
docker compose exec app node scripts/redispatch-calendar-writeback.ts --connection-id <connection UUID>
```

The command queues one finite recovery pass through the same bounded pages, for one active
Google connection; it prints no credentials. It reports `already queued` when queue
deduplication keeps an existing job. Use the connection ID from that user's calendar
connection metadata. Each missing copy receives the ordinary bounded writeback retry budget.
Account recovery excludes past/cancelled meetings, removed hosts, non-owned destinations,
inactive accounts and successful copies. To retry one exhausted projection, including a
cancellation or an update whose mapping already exists, use
`node --env-file=.env scripts/redispatch-calendar-writeback.ts --booking-id <chain root UUID>`.
This queues exactly one ordinary booking-calendar job with the same 12-retry limit. Re-running the command is an explicit operator action,
not a background loop that grants retries indefinitely.

Token-endpoint failures read at most 4 KiB and recognize only a fixed OAuth `error` enum.
On HTTP 400/401, `invalid_grant` means the user must reauthorize; Microsoft's
`interaction_required` and `consent_required` also prompt reconnection. `invalid_client` and `unauthorized_client`
indicate instance client configuration errors: the connection remains active, jobs retain
their retry/backoff behavior, and an operator-visible fixed error code identifies the
configuration problem. Other request/provider failures also preserve retry eligibility.
No token error body or provider description is logged or returned to the user.
