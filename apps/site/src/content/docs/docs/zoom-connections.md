---
title: Zoom account connections
description: Optional independent Zoom identity OAuth, without meeting creation.
---

Hourmere can connect a personal Zoom identity under **Conference accounts**, separately from
sign-in, Google/Microsoft calendar connections, and the passive Zoom location label on event
types. This foundation does **not** create meetings, read meetings, join meetings, send
invitations, or enable automatic conferencing. API keys and MCP OAuth cannot manage these
connections. A live browser session and same-origin writes are required.

## Configure an optional confidential client

Connections are disabled by default. A deployment administrator must separately register and
approve a suitable user-authorized Zoom Marketplace OAuth client. Creating or modifying a
real client, accepting terms and granting real-account access require their own authorization;
the automated tests use synthetic provider responses only.

1. Configure **only** the granular `user:read:user` scope. Do not add meeting, admin or optional
   scopes for this phase. Zoom's basic authorization query can include the required and
   optional scopes configured in Marketplace.
2. Enable the client's S256 PKCE capability, while using its **confidential** client ID and
   secret. Hourmere sends HTTP Basic client authentication and the verifier in the token body,
   as in Zoom's confidential PKCE example. It does not use a public-client ID or expose a
   client secret to the browser.
3. Register exactly `{PUBLIC_URL}/api/conference/zoom/callback`. No dynamic redirect URL or
   application return URL is accepted. Production requires HTTPS. Hourmere permits HTTP
   loopback for synthetic/local testing; whether a particular Marketplace client accepts that
   redirect and confidential PKCE combination must be verified separately with the real
   client. A passing mock test does not establish Zoom client acceptance.
4. Set `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and `CONFERENCE_ENCRYPTION_KEY` together in the
   deployment's private environment. The encryption key must be a separate canonical base64
   encoding of exactly 32 random bytes, independent of the authentication, calendar and
   webhook keys. Keep it stable and back it up securely with the database. Key loss or
   replacement requires reconnection. `.env.example` contains empty placeholders only.
5. Sign in, open **Conference accounts**, and explicitly choose **Connect Zoom**. Do not use a
   provider email address as evidence of a verified Hourmere sign-in identity.

Hourmere uses the official fixed authorize/token/users-me hosts. The advanced authorization
query includes `scope=user:read:user`, empty `optional_scope`, and omits
`include_granted_scopes`. Requests cannot select a broader scope. This implementation also
conservatively requires **every** code exchange and refresh response to explicitly report
exactly `user:read:user`. An absent, duplicated, unknown or broader scope fails closed. This is
Hourmere's conservative policy, not a claim that OAuth or Zoom universally guarantees a scope
field on every response. Check actual client response compatibility before enabling a real
integration; do not work around the policy by requesting broader access.

Provider `api_url`, personal meeting URLs, PMI, start URLs and arbitrary error bodies are
ignored. Tokens, authorization codes, state and the PKCE verifier are never returned by the
metadata API or logged. Only the official authorization URL carries a new opaque state and
challenge to the browser.

## Refresh, reconnect and disconnect

- **Refresh Zoom account** explicitly rotates credentials and updates identity metadata. Old
  credentials are durably retired before the provider request. If the result is unknown,
  malformed, over-scoped, or cannot be committed, Hourmere requires reconnection and never
  automatically retries the old refresh token. A confirmed rotation followed only by a
  transient identity lookup error retains the **new** token and reports the metadata error.
- **Reconnect Zoom** replaces existing local access and requires the same Zoom identity. Its
  stable connection ID remains unchanged. A Zoom identity already owned by another Hourmere
  account cannot be silently transferred, even when email addresses match.
- **Disconnect Zoom** removes local credentials and all that user's pending connection
  attempts. It retains the identity record for future references and does **not** revoke the
  entire Marketplace app grant. Remove the app separately in Zoom to revoke that grant.
- At most five identities can be connected per Hourmere user at once, including accounts
  requiring reconnection or with an incomplete refresh. Disconnecting releases capacity. The
  default metadata list excludes disconnected records; a later explicit grant for the same
  Zoom identity reuses its stable ID. Reconnecting a disconnected record also checks capacity. Pending authorization attempts are
  limited to five per user, expire after ten minutes, and are single-use and session-bound.
- Deleting the Hourmere user removes credentials, pending attempts, Zoom ID, display name and
  email from the retained record. A new Hourmere user, including one with the same email,
  cannot inherit the old connection ID. A future explicit authorization creates a new ID.

User operations and deletion use the same owner-first row-lock order. Durable claims prevent
callback replay and rotating-token reuse after failed commits. Provider calls have a bounded
deadline and response size. The retained connection foundation intentionally does not yet
implement Zoom Marketplace production deauthorization/compliance webhooks or automated meeting
lifecycle; those must be designed and verified before publishing a meeting integration.

## Reference API

All writes require an empty JSON object and a live owner browser session:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/conference-connections` | Own safe metadata and availability; never tokens |
| POST | `/api/v1/conference-connections/zoom/authorize` | New minimum-scope authorization attempt |
| POST | `/api/v1/conference-connections/{id}/reconnect` | Replace access for the same identity |
| POST | `/api/v1/conference-connections/{id}/refresh` | Explicit credential rotation and metadata refresh |
| DELETE | `/api/v1/conference-connections/{id}` | Local disconnect; retain stable record |

Callback redirects use a fixed allowlist of outcomes under `/app/conferences`. Responses use
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

Protocol references, checked 17 October 2026:
[Zoom OAuth](https://developers.zoom.us/docs/integrations/oauth/),
[Zoom PKCE](https://developers.zoom.us/blog/public-pkce/),
[advanced scope query](https://godevelopers.zoom.us/docs/integrations/oauth-scopes-overview/),
[granular scopes](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/).
