# Automatic Zoom: authorization and provider checkpoint

This branch is implementing automatic Zoom for one actual host in personal and single-host
team events. The current checkpoint contains explicit grant modes and the provider adapter;
it does not yet dispatch meetings, release invitations, or complete the automatic feature.
The existing passive Zoom label remains inert. Multi-host automatic Zoom needs a later
per-host authorization policy; it is not supported by guessing a team account.

## Explicit permissions

Zoom remains separate from Hourmere sign-in and calendar connections. `ZOOM_MEETINGS_ENABLED`
is false by default. `Connect Zoom` requests only `user:read:user`. A distinct signed-in
`Authorize Zoom meetings` action requests exactly this ordered set:

- `user:read:user`
- `meeting:write:meeting`
- `meeting:read:meeting`
- `meeting:update:meeting`
- `meeting:delete:meeting`

Only the owner live browser session can manage connections. No API key, MCP OAuth grant,
team membership or administrator role grants access to another user's private connection.
The new and existing-connection actions respectively use POST
`/api/v1/conference-connections/zoom/authorize-meetings` and
`/api/v1/conference-connections/{id}/authorize-meetings`, each with an empty JSON object.
The original identity action never widens permissions because a server flag was enabled.

Use a confidential user-authorized client with S256 PKCE and the fixed callback
`{PUBLIC_URL}/api/conference/zoom/callback`. The advanced query explicitly specifies the
requested scope set, empty `optional_scope`, and omits `include_granted_scopes`. A real
Marketplace app must be separately configured and verified to honor both choices; configuring
meeting access as required in a way that also grants it to the identity action is incompatible.
Do not configure admin, recording, settings, list-meetings or unrelated scopes. Do not change
a real client or grant real access based solely on this implementation or its synthetic tests.

The implementation requires every exchange/refresh response to explicitly contain exactly
the requested set, rejecting missing, duplicate or extra scopes and persisting canonical
order. This is Hourmere's conservative policy, not a universal guarantee about OAuth/Zoom
responses. `Reconnect Zoom` uses the stored mode even when new meeting authorization is
disabled. A new flag does not change an in-flight attempt's mode. Identity-only reconsent for
an already connected meeting identity cannot replace its stronger mode. Because such
reconsent may have rotated/revoked the provider grant, local credentials are retired and
`mode_conflict` requires reconnecting with the saved meeting permissions. A deliberate
identity downgrade requires disconnecting locally first. Provider-side grant effects still
need real-client acceptance and cannot be preserved by a local database transaction.

## Upgrade and token safety

Migration0025 leaves all previous identity records, ciphertext, fields and timestamps
unchanged. Identity v1 credentials continue to decrypt and refresh without reauthorization.
New meeting credentials bind provider, purpose, owner, connection, external identity and mode
under v2 authenticated data; they cannot be transplanted into an identity connection.

Previously unfinished v1 OAuth states do not authenticate the requested mode or expected
connection. The migration retains every old state field and timestamp; callbacks refuse
these attempts without redeeming a provider code, and the UI excludes them from its usable
pending count. Restart an unfinished connection attempt. New v2 attempts authenticate mode,
expected connection (including explicit absence), owner, state digest and originating session.
They remain short-lived and durably one-use. This temporary-attempt restart policy does not
force existing connected identities to reauthorize. Logout/deletion lock order and durable
refresh retirement from0022 are retained. Unknown rotation never retries an old refresh token.

## Provider policy at this checkpoint

The adapter calls fixed `https://api.zoom.us/v2`, disables redirects, bounds response sizes
and deadlines, and does not retry POST. Create uses `/users/me/meetings`, scheduled type2,
UTC timestamps, whole-minute duration1–1440, `use_pmi:false` and `default_password:true`.
It leaves account passcode/waiting-room policy intact instead of inventing a universally
compliant password. No delegated host, invitees, alternative hosts, recurrence or paid
tracking/list/settings privilege is used. The response/Get host must match the pinned Zoom
identity before its meeting ID is accepted or PATCH/DELETE is issued.

A meeting ID is a positive canonical decimal of at most15 digits, representable safely by
JavaScript. Unsupported larger identifiers fail closed. Once identity is validated, an
unusable join URL/time/duration does not discard the known ID: later lifecycle work can
reconcile or clean up that same identity, and cannot treat invalid details as permission for
another create. Durable single-create claims and late-result/cancellation application are
still to be connected to the booking worker after actual migrations0023/0024 are merged.

Participant links must be canonical HTTPS `/j/{same numeric ID}` on a fixed commercial
allowlist: `zoom.us`, `au01web`, `ca01web`, `eu01web`, `eu02web`, `in01web`, `us02web`,
`us04web`, `us05web`, `us06web`, `us07web`, `sa01web`, `dg01web`, `sg01web`, `uk01web`
(each web host followed by `.zoom.us`). The only optional query is one `pwd` value of1–128
unreserved ASCII characters. Userinfo, explicit ports, fragments, unknown/duplicate query,
alternate encodings, vanity/government/unlisted domains fail closed. This application policy
uses Zoom's documented commercial web hosts; it does not assert every tenant/link format
is accepted. Host `start_url`, raw passcode/PIN, provider error bodies and arbitrary `api_url`
are never retained. The validated attendee URL is protected participant data, including its
passcode capability; final integration must keep it out of logs, catalogs, webhooks, queue
payloads, browser persistence and development mail logs.

## Acceptance limits

All author tests use synthetic provider responses, owned temporary PostgreSQL databases and
existing Chrome. They do not prove real Marketplace confidential-PKCE/redirect/scope behavior,
regional join formats, account-specific duration/security policy, real calendar effects or
inbox delivery. No real Zoom client, credentials, account grant or meeting was used.
The whole feature also requires populated actual0024→0025 preservation/no-op, generated
API/DB parity, all gates, browser/privacy proof and non-author review after final integration.

Primary references checked17 October2026:
[OAuth](https://developers.zoom.us/docs/integrations/oauth/),
[PKCE](https://developers.zoom.us/blog/public-pkce/),
[advanced scope query](https://godevelopers.zoom.us/docs/integrations/oauth-scopes-overview/),
[granular scopes](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/),
[Meetings API](https://developers.zoom.us/docs/api/meetings/),
[documented commercial web hosts](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0078410).
