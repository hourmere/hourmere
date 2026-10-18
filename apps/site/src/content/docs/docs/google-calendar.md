---
title: Google Calendar
description: Configure separate OAuth credentials, busy-time checks and booking event projection.
---

## Configure the provider

Google sign-in and Google Calendar use separate OAuth clients. Signing in does not grant
calendar access. In your Google Cloud project enable Calendar API and configure branding,
an External audience and the intended test users. Keep the app in Testing for development;
public verification and publishing are separate launch steps.

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
retry. Google's External Testing mode can expire refresh tokens; see the
[Google web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).
You can turn off local conflict checking even when authorization has expired.

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
