# Automatic Zoom for one host

Hourmere can create one scheduled Zoom meeting for an explicitly opted-in personal event
or an individual team event with one actual host. Existing `{kind:"zoom"}` locations remain
passive labels. Automatic creation requires `{kind:"zoom",autoCreate:true}` and the host's
own `zoomConnectionId`. Collective and round-robin automatic Zoom are rejected; they need
a separate per-host authorization policy. Their passive labels and automatic Google Meet
behavior remain supported.

## Explicit permissions and setup

Zoom is separate from Hourmere sign-in and calendar accounts. `ZOOM_MEETINGS_ENABLED` is
`false` by default. Configure `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and a separate canonical
32-byte base64 `CONFERENCE_ENCRYPTION_KEY` in the private deployment environment. The key
must remain stable and be backed up with the database. Never reuse the authentication,
calendar or webhook key. These settings do not grant access on anyone's behalf.

`Connect Zoom` requests only `user:read:user`. A distinct **Authorize Zoom meetings** action
requests exactly this set:

- `user:read:user`
- `meeting:write:meeting`
- `meeting:read:meeting`
- `meeting:update:meeting`
- `meeting:delete:meeting`

Use a confidential user-authorized client with S256 PKCE and the fixed callback
`{PUBLIC_URL}/api/conference/zoom/callback`. The advanced query explicitly specifies the
requested scope set, empty `optional_scope`, and omits `include_granted_scopes`. A real
Marketplace client must be separately configured and verified to honor both choices.
Configuring meeting access as required in a way that also grants it to the identity action
is incompatible. Do not configure admin, recording, settings, list-meetings or unrelated
scopes. A synthetic test does not authorize changing a real client or granting access.

OAuth authorization, code exchange and disconnect require a live browser session.
Explicit Zoom credential refresh also remains session-only. The new and existing-account
meeting actions are POST `/api/v1/conference-connections/zoom/authorize-meetings` and
`/api/v1/conference-connections/{id}/authorize-meetings`; writes require JSON `{}` and the
same origin. The user's own API keys can list Zoom connection metadata and select their
own meeting-mode connection for automatic Zoom through the event-type REST API. Enabling
automatic creation, changing its selected account, changing its actual host, or reactivating
a disabled automatic event requires the actual host's identity and current organization
permissions. Another team administrator cannot select someone's private connection.
The server retains live-session checks for browser callers inside the write transaction.
Knowing a connection UUID does not confer permission. Metadata edits and disabling may
preserve an already authorized configuration without granting new access.

In **Conference accounts**, explicitly authorize meeting permissions; then choose that account
in the event editor. No first account is selected automatically. Booking and safe retry of an
already configured event remain available through the existing REST, API-key, MCP and CLI
permissions. Read-only MCP `list_conference_connections` accepts API keys and enabled MCP
OAuth grants; settings mutations use REST with an API key. MCP OAuth grants do not grant
REST access or start provider authorization.

Every exchange and refresh response must explicitly contain exactly the requested set;
missing, duplicate or extra scopes fail closed and accepted scopes are stored in canonical
order. This is Hourmere's conservative policy, not an OAuth or Zoom guarantee that every
response contains scopes. Reconnect uses the stored mode even when new meeting authorization
is disabled. A flag change does not widen an in-flight attempt. Identity-only reconsent for
an already connected meeting identity cannot replace its stronger mode. Since such reconsent
may rotate or invalidate the provider grant, local credentials are retired and `mode_conflict`
requires reconnecting with the saved meeting permissions. A deliberate identity downgrade
requires disconnecting locally first. Provider-side grant effects need real-client acceptance.

## App removal and event endpoint

Before a multi-user deployment lets real Zoom users connect, configure
`ZOOM_WEBHOOK_SECRET_TOKEN` with the **Secret Token** shown in that Zoom app's webhook/event
configuration. This is separate from the OAuth client secret. Restart the server after setting
it; Compose forwards it to the app and inherited worker. An empty value leaves
`POST /api/conference/zoom/events` disabled with 404. The endpoint is enabled independently
of the OAuth credentials and `ZOOM_MEETINGS_ENABLED`, so keep the token configured when
turning off new connections or meeting authorization.

1. Use a publicly reachable HTTPS `PUBLIC_URL` with a valid certificate and TLS 1.2 or later.
   In the Zoom app's **Features → Access**, enable **Event Subscriptions** and set its
   **Event notification endpoint URL** (Event Subscription URL) to
   `{PUBLIC_URL}/api/conference/zoom/events`.
2. Set the app's **Deauthorization Notification Endpoint URL** on its App Listing to the
   same URL. App removal uses this field; an ordinary event subscription alone does not
   replace it. No meeting, recording or unrelated event subscription is needed by Hourmere.
3. Ensure the Secret Token configured in Hourmere matches that app, then click **Validate**
   for the Event notification endpoint URL and save the app configuration. Hourmere answers
   signed `endpoint.url_validation` challenges with the plain token and its HMAC-SHA256 hex
   digest. Zoom also revalidates the endpoint periodically; keep it publicly reachable.

The endpoint authenticates `x-zm-signature` using HMAC-SHA256 over
`v0:{x-zm-request-timestamp}:{raw request body}` with the webhook Secret Token, compares the
signature in constant time, and requires the request timestamp to be within five minutes of
the server clock in either direction. Keep server time synchronized; `event_ts` does not
replace the signed header's freshness check. Requests are limited to 16 KiB and 120 per
minute per client address per server process (`TRUSTED_PROXIES` controls proxy addresses);
it never logs payloads, user identifiers or secrets and does not store the incoming event.
The payload's legacy `signature` field is not authentication.

A verified `app_deauthorized` event removes the matching stored Zoom user's local connection
credentials and identity metadata, clears pending connection attempts and marks affected
automatic event settings inactive for host attention. The stored Zoom user ID selects the
connection; the account ID never widens deletion to other users' connections in that account.
Repeated notifications and unknown users succeed without creating records.
Local **Disconnect Zoom** continues to retain its stable identity metadata; removing the app
in Zoom additionally removes that metadata when this configured endpoint receives the event.
Existing booking and conference records remain subject to their normal retention policy;
the endpoint does not delete provider meetings or call Zoom.

Zoom documents these deauthorization notifications for publicly published apps. Private apps
and apps in development do not trigger them, so a local or development installation cannot
establish production notification delivery. Tests use signed synthetic events only; verify
the public app's endpoint configuration before deployment.

## One meeting and safe reconciliation

A booking commits a durable root intent with its provider, actual organizer, Zoom connection
and external user identity. Calendar credential IDs are separate. The invitation organizer is
the immutable verified Hourmere identity, not an email reported by Zoom. Rescheduling retains
the root identity, meeting ID and invitation UID; it updates the same scheduled meeting.
Cancellation removes that same known meeting. A confirmed missing meeting is not replaced.
Changing or disabling the event type does not redirect an existing root to a different account.
Disabling the instance flag stops new automatic bookings and configuration; committed roots
continue reconciling. Disconnecting retires credentials and may require explicit reconnection
before a known meeting can be updated or removed; it does not revoke the whole Marketplace grant.

The single-create claim commits before POST. A claimed create with no validated known meeting
ID **never authorizes another POST** after timeout, a connection reset, a 5xx response, a lost database result or a
crash. There is no list-based adoption, agenda marker, arbitrary-ID adoption or force-create
endpoint. `ambiguous_create` asks the host to inspect and remove any orphan in their own Zoom
account before replacing the booking. Retry can reconcile a known ID; it cannot prove that
an unknown create did not happen. A late validated ID is retained after a move, cancellation,
expired lease or failed credential transaction so that the same meeting can be reconciled
or removed. Stale absence results cannot strand a newly discovered ID.

Definitive create rejections (HTTP 400, 401, 403 and 429) establish `knownNoCreate` and
clear the create claim. Authentication and permission failures require reconnection;
rate limits and other rejected requests use bounded provider backoff. A subsequent retry
may POST because the rejected operation did not create a meeting. This policy does not
apply to unknown transport outcomes or server failures.

Browser OAuth and explicit refresh perform bounded provider I/O without row locks, between
short owner/session/claim transactions. Completion rechecks the live session and claim;
OAuth also rejects changed connection row versions. A disconnect, logout or newer grant
cannot be overwritten by an in-flight response. Meeting workers retain owner key-share and
connection protection, compatible with public booking host share locks. No booking, host,
fairness or root-intent lock spans the network. Results apply after credential I/O
commits, under booking then intent/mirror locks with revision and lease checks. Expired
credentials are durably removed from the row before the rotating refresh request. Refresh
transport failures (5xx, rate limit, timeout or network failure) receive at most three
attempts with 100 ms then 200 ms backoff inside the operation deadline. Exhausted transient
failures restore the original encrypted credentials and keep the connection active so a
later worker/action can recover; they do not request reconnection. Other token rejections
(including `invalid_client`) and malformed successful responses also preserve the old grant;
an unknown rotation may later resolve to `invalid_grant`, which retires it. A successful
noncanonical scope grant or an identity mismatch fails closed as an authorization failure.
A crash or uncommittable rotation stays `refreshing`
without reusable credentials and still requires explicit recovery. Public slots and new
bookings accept an otherwise eligible meeting connection while it is refreshing;
configuration selection requires active status. The worker rechecks its pinned identity
before any meeting operation, including after refresh.

## Optional ordinary Google copy

Zoom needs no Google account or write calendar. At booking commit, Hourmere pins one ordinary
Google calendar copy for this organizer only if an eligible owned Google write destination
is configured. Unlike a Google Meet root, the Zoom organizer can receive this ordinary copy.
With no configured destination, private `calendarCopy` is `not_configured` and the participant
still receives normal ICS after the Zoom link is ready. Connecting or selecting a calendar
later does not attach one to an old root. A configured but unavailable destination has a
private failure status; it does not invalidate a ready Zoom meeting.

The shared durable copy worker imports an ordinary event with the ready participant link,
the root UID, no `conferenceData`, no `createRequest` and no attendees/provider invitations.
It uses its original pinned destination and existing unknown-import safeguards across
reschedule and cancellation. The legacy calendar writer cannot compete with that root.
A copy failure cannot create a second Zoom meeting, hide its ready link or hold its final mail.

## Status, notifications and retry

REST and MCP booking results expose optional `conference: {provider:"zoom",status,errorCode}`.
Only confirmed, ready booking responses contain a join URL. Cancelled bookings do not return
a participant link, including after remote cleanup becomes ready. Raw stored participant data
is retained for the original CANCEL ICS and cleanup. Pending or failed responses contain no join URL. The organizer's private booking view may
also include their `calendarCopy` status; public metadata never exposes connection pins.
Final meeting invitations and ICS wait for a current ready participant link. Failures use
bounded no-link/no-ICS notices. Cancellation and rescheduling follow the current lifecycle
and root revision, with recipient deduplication and durable release retries.

The existing POST `/api/v1/bookings/{id}/conference/retry`, MCP
`retry_conference({bookingId})`, and CLI `npm run --silent cli -- retry-meeting --input retry.json`
(with `{"bookingId":"<id>"}` in the private input file) reconcile
failed work for the current verified pinned organizer, within the selected organization.
API keys retain that existing booking authority. Other team administrators cannot retry on
behalf of the pinned organizer. `retry_calendar_copy` and `retry-calendar-copy` concern only
the caller's original configured ordinary copy. No retry changes accounts, creates a
replacement meeting or accepts force/adoption fields.

## Provider and participant data policy

The adapter uses fixed `https://api.zoom.us/v2`, disables redirects, bounds response size and
deadlines, and never retries POST. Create uses `/users/me/meetings`, scheduled type 2, UTC
timestamps, whole-minute duration 1–1440, `use_pmi:false` and `default_password:true`. It
truncates the booking title to 200 Unicode code points before sending the meeting topic. It
leaves account passcode/waiting-room policy intact. No delegated host, invitees, alternative
hosts, recurrence or paid tracking/list/settings privilege is used. Fixed users/me identity
and every returned/get `host_id` must match the pinned Zoom identity before a meeting ID is
accepted or PATCH/DELETE is issued.

A meeting ID is positive canonical decimal, at most 15 digits and safely representable by
JavaScript. Larger identifiers fail closed. An unusable join URL/time/duration does not
discard an already validated ID or permit a second create. Participant links must be
canonical HTTPS `/j/{same numeric ID}` on this fixed commercial allowlist: `zoom.us`,
`au01web`, `ca01web`, `eu01web`, `eu02web`, `in01web`, `us02web`, `us04web`, `us05web`,
`us06web`, `us07web`, `sa01web`, `dg01web`, `sg01web`, `uk01web` (each web host followed by
`.zoom.us`). The only optional query is one `pwd` value of 1–128 unreserved ASCII characters.
Userinfo, explicit ports, fragments, unexpected/duplicate query, alternate encodings and
vanity/government/unlisted hosts fail closed. This narrow application policy uses documented
commercial hosts; it does not promise support for every tenant or link format.

Only the validated attendee URL and bounded identity needed for lifecycle are retained.
Host `start_url`, raw passcode/PIN, provider error bodies and arbitrary `api_url` are dropped.
The attendee URL, including its passcode capability, is protected participant data. It is
excluded from public catalogs, webhook payloads, logs, queue payloads, browser persistence
and development mail logging. It is delivered only in authorized booking/manage views,
participant mail/ICS and the optional pinned ordinary copy.

## Migration and acceptance limits

Migration 0025 preserves old fields, timestamps, ciphertext and journal entries. Old conference
roots default to Google semantics without invented Zoom pins. Existing identity v1 credentials
continue to decrypt and refresh. New meeting credentials bind purpose, owner, connection,
external identity and mode using v2 authenticated data.

Unfinished v1 OAuth states do not authenticate mode/expected connection. Their fields remain
unchanged, but callbacks refuse them without exchanging a code and usable pending counts
exclude them. Restart only those short-lived attempts; existing connected accounts need no
forced reauthorization. New one-use v2 attempts authenticate mode, explicit expected
connection/absence, owner, state digest and originating session. Published 0022–0024 are
immutable; new checks belong in 0025.

Tests use only synthetic providers/mail, owned temporary PostgreSQL and existing Chrome.
They do not prove real Marketplace confidential PKCE/redirect/scope delivery, provider-side
wrong-mode reconsent effects, regional join formats, account-specific duration/security
policy, real calendar effects or inbox delivery. No real Zoom client, grant or meeting was
used. Populated actual 0024→0025 preservation/no-op, generated API/DB parity, all gates,
Chrome/privacy and non-author review remain required before this branch can be merged.
Production Marketplace app review and actual deauthorization notification delivery still
require operator acceptance of the configured public app and endpoint.

Primary references checked 19 October 2026:
[OAuth](https://developers.zoom.us/docs/integrations/oauth/),
[PKCE](https://developers.zoom.us/blog/public-pkce/),
[advanced scope query](https://godevelopers.zoom.us/docs/integrations/oauth-scopes-overview/),
[granular scopes](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/),
[Meetings API](https://developers.zoom.us/docs/api/meetings/),
[documented commercial web hosts](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0078410),
[webhook signatures and endpoint validation](https://developers.zoom.us/docs/api/webhooks/),
[app deauthorization](https://developers.zoom.us/docs/integrations/end-user-auth/).
