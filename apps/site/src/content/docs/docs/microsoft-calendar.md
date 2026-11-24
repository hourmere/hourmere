---
title: Microsoft Calendar connection
description: Register an Entra application and connect Outlook calendars independently of sign-in.
---

Connect an Outlook account and choose which calendars Hourmere checks for busy time when
offering bookings. You can also choose a calendar for private copies of your bookings.

## Microsoft Graph status

- The separate Entra calendar client requests delegated `Calendars.ReadWrite`, `openid`,
  `email` and `offline_access`. The authorization-code flow uses session-bound state and
  PKCE. Hourmere encrypts the access and refresh tokens at rest, refreshes access on the
  server and saves rotated refresh tokens. Existing read-only grants still support busy-time
  checks. Reconnect to grant booking write access. [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- `GET /oidc/userinfo` supplies the account subject and optional display email.
  `GET /v1.0/me/calendars` supplies calendar IDs, names, default-calendar flags and access
  metadata. Hourmere stores those account and calendar details with the local connection.
  [Graph calendar list](https://learn.microsoft.com/en-us/graph/api/user-list-calendars?view=graph-rest-1.0)
- Each selected conflict calendar has its own `calendarView/delta` cursor and date range.
  Hourmere resumes large syncs across background runs and publishes busy times only when
  the entire round completes. Hourmere starts rebuilding before the current date range
  expires and also rebuilds when Graph expires a cursor. During a rebuild, bookings still
  use the previous snapshot while it is fresh and covers the requested times. An initial
  sync, a failed sync, or a stale or insufficient snapshot leaves the affected times unavailable.
  A snapshot's 10-minute freshness window starts with its first read. If a round takes longer,
  Hourmere starts the next incremental read immediately when its remaining budget allows.
  Otherwise the once-per-minute dispatcher queues the calendar for another read.
  [Graph calendar view delta](https://learn.microsoft.com/en-us/graph/delta-query-events)
- Graph expands recurring events. Hourmere uses modified occurrences at their updated times
  and removes busy intervals for cancelled occurrences and deleted series. Timed and all-day
  events use the UTC intervals Graph returns. The cache retains opaque identifiers and busy
  intervals. Event titles, attendees, locations and descriptions are discarded and never
  included in availability responses.
- If Graph denies access to one selected calendar, its busy times become unavailable and
  the account’s other calendars continue syncing. If a complete list omits a selected
  calendar, Hourmere marks it unavailable and stops syncing it. Use **Refresh calendar list**
  to check for its return or clear its conflict-check selection to resume booking without it.
- When Graph throttles a request, Hourmere waits briefly within the read deadline or
  defers the next read by the `Retry-After` delay, up to 24 hours. [Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
- New bookings enqueue creation of a private, busy appointment on the selected booking
  calendar. The appointment includes the saved booking title, which may include the invitee's
  display name, and its time. A group appointment also includes the seat count at creation.
  Guest lists, email addresses, booking answers and provider invitations
  stay out of the calendar copy. Hourmere sends start and end in UTC, and Outlook displays the
  appointment in the viewer's time zone. [Graph event creation](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0)
- Each booking copy uses a stable Graph `transactionId`. If Graph may have accepted a create,
  such as when its response is lost, Hourmere looks up the original copy using its booking marker.
  If the booking is still active, an empty lookup after a short delay lets Hourmere retry creation
  using the same identifier and marker. If the booking was cancelled, Hourmere looks for the
  original copy to remove it. A successful create stores the Graph event ID.
  [Graph event lookup by extended property](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get?view=graph-rest-1.0)
- Rescheduling updates the existing event by its stored ID, sending the new start and end in UTC.
  Hourmere checks whether the Outlook times still match the last write and uses the current
  event version (ETag) for the update. Changes such as categorizing the event or dismissing a
  reminder can change its version while leaving its times intact. If a reschedule cannot safely
  update the original copy, the Calendars page shows a conflict for that calendar.
  [Graph event update](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0)
- Cancellation removes the copy from Outlook. If an event has moved, Hourmere looks for the
  booking marker and can remove a matching copy from another calendar the connected account owns.
  A copy that is already absent satisfies the cancellation. If Hourmere cannot verify where
  a copy went, or if the copy now has Outlook attendees, the Calendars page shows a conflict
  so the owner can check it in Outlook. [Graph event deletion](https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0)
- Temporary write failures use bounded retries and honor Graph's `Retry-After` on HTTP 429. The Calendars
  page shows problems such as revoked consent, missing write permission, calendar removal or an
  outcome Hourmere could not confirm. Reconnecting the original account can restart eligible
  writes. Self-hosted operators can also redispatch a booking or connection with
  `scripts/redispatch-calendar-writeback.ts`.
  [Graph error responses](https://learn.microsoft.com/en-us/graph/errors)
- Bookings with automatic Google Meet or Zoom keep their existing conference calendar flow.

## Prepare a test calendar

An existing Outlook.com or Microsoft 365 mailbox can be used. For a new personal test mailbox,
open [Outlook](https://outlook.com), choose **Create free account**, complete registration
yourself, then open Calendar. Registering a Microsoft account with another email address does
not by itself establish an Outlook mailbox.

Application registration also requires a Microsoft Entra directory and permission to register
applications. Use an existing company directory when available. Otherwise follow Microsoft's
[app registration prerequisites](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
Account registration, identity checks and any subscription or billing agreement belong to the
account owner.

## Register the application

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), select the intended
   directory, then **Entra ID → App registrations → New registration**.
2. Give it a recognizable name, such as **Hourmere Calendar local development**. Select
   **Any Entra ID Tenant + Personal Microsoft accounts** to support both organizational and
   personal Outlook users. Hourmere uses Microsoft's `common` authority.
3. Add a **Web** redirect URI matching `{PUBLIC_URL}/api/calendar/microsoft/callback` exactly.
   For `npm run dev`, the normal URI is
   `http://localhost:5173/api/calendar/microsoft/callback`. Use HTTPS outside loopback.
4. Record the **Application (client) ID**. In **API permissions**, configure Microsoft Graph
   **delegated** `Calendars.ReadWrite`, plus `openid`, `email` and `offline_access`. The
   connection does not need `User.Read` or application permissions. Remove unused default
   permissions rather than granting broader access. Tenant policies may require an
   administrator to approve delegated consent.
5. In **Certificates & secrets**, create a client secret and store its **Value** securely.
   The secret ID is not the secret value. Set an expiry reminder and rotate it before expiry.

The calendar callback is separate from `/api/auth/callback/microsoft`, which is used for
Hourmere sign-in. Calendar connection does not add a sign-in method or use an email claim as
proof of a Hourmere identity.

## Configure and connect

Set `MICROSOFT_CALENDAR_CLIENT_ID` and `MICROSOFT_CALENDAR_CLIENT_SECRET` in the instance's
private environment. Also configure `CALENDAR_ENCRYPTION_KEY` as described in the
[configuration reference](/docs/configuration). Reuse the existing encryption key when adding
Microsoft to an instance with Google connections; changing it makes existing tokens unreadable.
The default Compose file forwards these settings to the container.

Restart the instance with the updated environment, sign in to Hourmere, and open
**Calendars → Connect Microsoft Calendar**. Review Microsoft's consent page before granting
access. Choose **Check this calendar for conflicts** for each calendar whose busy time
should affect availability. Newly selected calendars need a successful sync before
Hourmere can offer times covered by them. The Calendars page shows account display
information and local calendar status.

## Write new bookings to Outlook

In **Calendars**, choose **Write new bookings here** on an eligible Microsoft calendar.
You can choose one default booking destination across providers. Choose a calendar your
connected Outlook account owns and can edit. Calendars shared with you can still be used
for conflict checks. If your account was connected with read-only access, choose
**Reconnect Microsoft Calendar** and authorize the original account before selecting its
calendar. Use **Refresh calendar list** to update ownership information on an existing
connection.

Hourmere saves the chosen destination when each booking is made. A change to your default
calendar applies to new bookings. When you reschedule in Hourmere, the existing Outlook copy
moves to the new time. When you cancel in Hourmere, its copy is removed. Each group occurrence
has one copy, which is removed when its last active seat is cancelled. Each occurrence of a
recurring booking uses a separate Outlook appointment.

Manage the booking in Hourmere to change its time or cancel it. Changes you make directly in
Outlook affect only the Outlook copy. If a copy needs attention after you edit, move or delete it
in Outlook, check the event and its calendar in Outlook. The booking still reflects the change
you made in Hourmere.

If Microsoft removes a calendar or denies write access, check the affected destination on the
**Calendars** page. Use **Refresh calendar list** to check whether the calendar has returned, or
select another calendar for future bookings. If permission was revoked, reconnect the original
account.

Your own `full` API key can select the destination through `PUT /api/v1/calendar-destination`.
`GET /api/v1/calendar-connections` and MCP `list_calendar_connections` report write consent and
calendar writeback status as private connection metadata. Provider authorization requires your
browser session.

## Manage the connection

Use **Refresh calendar list** to retrieve changes. **Disconnect** deletes the local connection,
credentials, calendars and outstanding connection attempts. Existing Outlook copies stay in your
calendar. You can remove the account-wide grant separately in the Microsoft account's application
permissions. Keep regular encrypted database backups and protect the encryption key separately.

If the account shows **Reconnect required**, choose **Reconnect Microsoft Calendar** and
authorize the original Microsoft account to restore the connection. If Microsoft denies
access to a particular calendar, review that calendar’s access in Outlook and retry its sync.
On return, check the account status and wait for a successful busy-time sync. Hourmere
treats times without a fresh, covering snapshot as unknown. See
[Troubleshoot availability](/docs/availability-troubleshooting#sync-freshness-and-provider-differences)
for the retry and recovery behavior.

Test organizational mailboxes separately from personal Outlook accounts before relying on
company-specific consent policies.

## Known limitations

Event types cannot select automatic Microsoft Teams meetings yet. The writeback worker can
exercise this path in tests for single-host bookings on a host-owned Outlook calendar.
The worker uses the calendar's allowed providers to decide whether to create a Teams meeting.
Personal Outlook calendars and other calendars without Teams support still receive a regular
booking copy, with `teams_unavailable` recorded internally. When Graph confirms an event but
omits the Teams join link, the worker saves the event ID and retries reading that event within
the usual attempt limit. A Teams join link stays on the private writeback record while Hourmere
updates the same event on reschedule. Cancellation
removes the event and clears the link. Join links are unavailable in booking confirmations.
[Microsoft Graph online meetings in Outlook](https://learn.microsoft.com/en-us/graph/outlook-calendar-online-meetings)
