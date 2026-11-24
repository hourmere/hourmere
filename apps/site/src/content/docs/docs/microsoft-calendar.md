---
title: Microsoft Calendar connection
description: Register an Entra application and connect Outlook calendars independently of sign-in.
---

Connect an Outlook account and choose which calendars Hourmere checks for busy time when
offering bookings. The connection uses read-only access to Microsoft Graph.

## Microsoft Graph status

- The separate Entra calendar client requests delegated `Calendars.ReadBasic`, `openid`,
  `email` and `offline_access`. The authorization-code flow uses session-bound state and
  PKCE. Hourmere encrypts the access and refresh tokens at rest, refreshes access on the
  server and saves rotated refresh tokens. [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
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
- Booking event writes and reconciliation during booking changes remain future work.

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
   **delegated** `Calendars.ReadBasic`, plus `openid`, `email` and `offline_access`. The
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

Use **Refresh calendar list** to retrieve changes. **Disconnect** deletes the local connection,
credentials, calendars and outstanding connection attempts. It does not revoke the Microsoft
account-wide grant; remove that separately in the Microsoft account's application permissions
if desired. Keep regular encrypted database backups and protect the encryption key separately.

If the account shows **Reconnect required**, choose **Reconnect Microsoft Calendar** and
authorize the original Microsoft account to restore the connection. If Microsoft denies
access to a particular calendar, review that calendar’s access in Outlook and retry its sync.
On return, check the account status and wait for a successful busy-time sync. Hourmere
treats times without a fresh, covering snapshot as unknown. See
[Troubleshoot availability](/docs/availability-troubleshooting#sync-freshness-and-provider-differences)
for the retry and recovery behavior.

Test organizational mailboxes separately from personal Outlook accounts before relying on
company-specific consent policies.
