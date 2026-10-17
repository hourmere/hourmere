# Google Calendar connections

Google Calendar connections are separate from Google sign-in. Signing in never requests
calendar permissions, and connecting a calendar never creates or links a sign-in account.
Connections belong to a user across their organizations; only that user's browser session
can start, refresh or disconnect them. API keys can read their owner's connection metadata.

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
no attendee list, manage links, conference creation or invitation emails are sent by this
integration. Booking email/ICS continues through the existing notification worker.

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
| `POST /api/v1/calendar-connections/{id}/refresh` with `{}` | Browser session; refresh own calendar list, obtaining a fresh access token when needed |
| `PATCH /api/v1/calendars/{id}` with `{checkConflicts}` | Select up to 20 owned/accessible readable calendars for conflict checks; queues an initial sync transactionally |
| `POST /api/v1/calendars/{id}/sync` with `{}` | Synchronize a selected calendar now |
| `PUT /api/v1/calendar-destination` with `{calendarId}` | Set/clear the profile's owned default destination for new bookings |
| `DELETE /api/v1/calendar-connections/{id}` | Browser session; remove own local connection, credentials and calendars |

Writes require the app's origin and reject API keys. Missing/foreign connections return
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
refresh token when Google omits a replacement. Owner-level row locks serialize reconnect,
refresh and disconnect. A rotated refresh token is saved even if the subsequent calendar
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
bookings. Push notifications, shared-calendar writes and conference creation are follow-ups.
