---
title: Google Calendar
description: Configure separate OAuth credentials, busy-time checks and booking event projection.
---

## Configure the provider

Google sign-in and Google Calendar use separate OAuth clients. Signing in does not grant
calendar access. In your Google Cloud project enable Calendar API and configure branding,
an External audience and the intended test users. Keep the app in Testing for development;
review the publishing requirements below before ongoing use. To enable the separate
**Sign in with Google** button, follow the
[sign-in setup](/docs/configuration#sign-in-with-google).

Create a Web application OAuth client for calendar connections. Register exactly
`{PUBLIC_URL}/api/calendar/google/callback`, for example
`https://meet.example.com/api/calendar/google/callback`. Local `npm run dev` uses
`http://localhost:5173/api/calendar/google/callback`. JavaScript origins are unnecessary for
this server-side flow. Use HTTPS except on loopback development hosts.

Set `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` and a separate
`CALENDAR_ENCRYPTION_KEY` of 32 random bytes encoded in base64 (`openssl rand -base64 32`).
Keep the key stable and backed up; losing it makes saved tokens unreadable. The sign-in
settings `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` do not configure calendar access.

The browser connection requests `openid`, `email`, `calendar.calendarlist.readonly`,
`calendar.events.readonly` and `calendar.events.owned` (the calendar scopes use the prefix
`https://www.googleapis.com/auth/`). Configure these in your Google OAuth consent settings.
Google's event-read permission covers all accessible calendars and the write permission
covers owned calendars; Hourmere limits actual use to the calendars you explicitly select.

## Publishing status and verification

An External app in **Testing** receives refresh tokens that expire after **7 days** for
non-basic scopes. Calendar access is outside the basic `openid`, `email` and `profile`
exception, so connections drop weekly. See Google's official
[refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).
For ongoing use, set Audience publishing status to **In production** and reconnect any
account whose Testing grant expired.

Publishing alone does not verify the app. An External unverified app requesting sensitive
or restricted scopes shows an **unverified app warning screen** and has a **100-user cap**,
separate from Testing's 100-test-user limit. Google's
[OAuth app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
explains those states.

You, the self-hoster, are responsible for your Google project's branding, domains, privacy
policy and any required
[sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
Hourmere's hosted verification does not cover your OAuth client. Review Google's personal
and internal-use exceptions if applicable.

## Select calendars

Sign in, create your profile and open **Calendars**. Choose **Connect Google Calendar** and
review the permissions in Google's consent page. Connecting alone does not select any
conflict calendar or destination. Existing list-only connections need an explicit upgrade.

Select **Check conflicts** on each calendar whose busy times should block bookings. Choose
**Write new bookings** on one owned calendar to project new bookings there. Shared readable
calendars can block time; a shared calendar owned by someone else cannot be a destination.
Changing the destination does not move existing projected meetings. Use **Sync now** for an
immediate read; workers poll selected active calendars every minute. A web-only process
without a worker does not perform scheduled synchronization.

The user's own API keys can list calendar connections/status, refresh the calendar list,
choose conflict calendars and the writeback destination, and sync now through the public
REST API with the same ownership checks. Read-only MCP `list_calendar_connections` also
accepts enabled MCP OAuth grants. OAuth authorization, code exchange and disconnect require
a live browser session. Cookie-authenticated writes require the app's own origin.

External event titles/descriptions are not fetched or stored; synchronization retains IDs
and busy intervals. Cancelled, transparent and self-declined events do not block time.
Google expands recurring instances and exceptions; all-day events use exclusive local
midnights with daylight-saving rules. A timezone change rebuilds the busy snapshot.

Missing, failed, stale (over ten minutes) or uncovered snapshots return
`calendar_sync_unavailable`, rather than making unknown time bookable. The window extends
from three days before the current UTC day through 403 days after it, renewed daily.
Incremental tokens and 410 resets refresh that bounded snapshot. Network/polling delay can
still race a newly created Google event; there is no shared atomic Google/Hourmere transaction.

## Booking projection and disconnect

Booking creation, rescheduling and cancellation enqueue updates. A meeting keeps the ICS
UID `<first booking id>@hourmere` and uses the same Google event across retries and
reschedules. The integration creates a private host copy without attendees, conference
creation or Google invitation emails. Existing Hourmere booking notification emails run
separately. Google edits do not change Hourmere bookings.

Expired/revoked access requires reconnecting. Temporary errors preserve credentials for
retry. If this repeats weekly, check the [publishing status](#publishing-status-and-verification).
You can turn off local conflict checking even when authorization has expired.

Each host's ordinary calendar copy is processed independently, so one revoked connection
does not block the other hosts. Reconnecting queues missing copies for that host's future
bookings and preserves saved destinations. A bounded recovery pass handles 100 bookings
per page. After writeback retries are exhausted, operators can explicitly queue a new finite
pass from the repository checkout:

```sh
node --env-file=.env scripts/redispatch-calendar-writeback.ts --connection-id <connection UUID>
```

Workers must be running. Only active Google accounts, owned destinations and future
confirmed bookings are eligible; successful copies are skipped. Old bookings without a
saved destination use that host's current owned destination on the recovered connection.
For one exhausted update or cancellation, use the same command with
`--booking-id <chain root UUID>` instead; this queues one ordinary bounded writeback job.
A wrong instance client secret preserves user connections for retry after the operator
fixes configuration; a revoked user grant still requires that user's consent.

**Disconnect** deletes local credentials, calendar metadata, busy data and write bindings.
It leaves existing Google event copies and the Google-wide grant in place. To revoke that
grant, remove Hourmere yourself in [Google Account connections](https://myaccount.google.com/connections).
After disconnecting, Hourmere no longer updates those event copies.


Automatic Meet is a separate explicit opt-in. Collective meetings select an eligible organizer;
round robin uses its actual winner. Only the organizer needs a Meet-capable Google destination.
Up to N−1 configured collective destinations receive ordinary private copies of the same ready
link, without creating more conferences or provider attendee invitations. Other hosts retain
normal email/ICS invitations. Existing roots never switch calendars or gain new copies when
settings change. The host booking page shows only the caller's copy state and safe retry.

Automatic Meet reports `conference_pending_timeout` when Google still has not finished
after the bounded polling budget. **Retry meeting** checks the same event and request again;
it can recover a link that became ready later, but does not force a new conference. A
permanently pending request needs the repository's
[operator repair](https://github.com/hourmere/hourmere/blob/main/docs/google-calendar.md#automatic-meet-projection).
After upgrade, legacy pending requests receive one same-UUID conference PATCH automatically;
already failed requests need the pinned host to retry. Google HTTP 400 on a known-event
PATCH, including moves and cancellation, is terminal `invalid_response`; correct the
request/integration before retrying. The known event remains pinned.
