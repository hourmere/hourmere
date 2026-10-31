---
title: Microsoft Calendar connection
description: Register an Entra application and connect Outlook calendars independently of sign-in.
---

Microsoft calendar connections currently list calendars, refresh encrypted credentials and
disconnect accounts. They do not synchronize busy times or write booking events. Google
Calendar synchronization remains available separately.

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
access. Hourmere requests basic calendar access to retrieve the calendar list, and offline
access to refresh credentials. The provider permission can read more basic event metadata
than this list-only implementation uses. Only account display information and local calendar
metadata are returned to the browser; access and refresh tokens remain encrypted on the server.

Use **Refresh calendar list** to retrieve changes. **Disconnect** deletes the local connection,
credentials, calendars and outstanding connection attempts. It does not revoke the Microsoft
account-wide grant; remove that separately in the Microsoft account's application permissions
if desired. Keep regular encrypted database backups and protect the encryption key separately.

An expired or revoked account offers **Reconnect Microsoft Calendar**, leading to the
Microsoft permission disclosure and authorization action. Choose the original Microsoft
account yourself; connecting a different account does not restore the original connection.
On return, check the account statuses shown by Hourmere. A temporary provider failure
offers **Refresh calendar list** instead. Recovery does not enable busy-time synchronization
or booking writes for Microsoft connections.

See Microsoft's [calendar-list permissions](https://learn.microsoft.com/en-us/graph/api/user-list-calendars?view=graph-rest-1.0)
and [authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
for the provider's current behavior. Test organizational mailboxes separately from personal
Outlook accounts before relying on company-specific consent policies.
