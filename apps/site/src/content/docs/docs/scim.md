---
title: SCIM provisioning tokens
description: Prepare organization-scoped provisioning credentials and understand the current SCIM limitations.
---

**SCIM user and group provisioning is not available yet.** This release provides the
credential administration and internal identity storage only. Enabling it does not enable Users, Groups or discovery
resources, and an identity provider's connection test cannot succeed yet.

The same foundation is available to every installation, including self-hosted instances,
without a subscription or license requirement. SCIM will manage organization membership
lifecycle; it is separate from SSO sign-in.

## Enable token administration

`SCIM_PROVISIONING_ENABLED` defaults to `false`. An operator may set it to `true` and
recreate the application to enable token creation and rotation. Listing and revocation
remain available while the switch is off. See
[configuration](/docs/configuration) for environment and Compose behavior.

Sign in as an owner or administrator of a team organization and open **Settings** (`/app/settings`), then **SCIM provisioning tokens**.
Personal spaces and ordinary members cannot administer provisioning tokens. The page
states that provisioning itself is unavailable; do not connect a production IdP yet.

Only owners can create or rotate tokens; owners and administrators can list and revoke
them, including while the switch is off.

Create a token with a recognizable name and copy its complete value into a private
secret store immediately. The complete value is shown only after creation or rotation.
Closing that view, navigating away or switching organizations clears it. The list
contains paginated safe metadata, not a way to recover the secret. The management API
also records the creating and most recent rotating user IDs and timestamps. If you lose the value, rotate
or replace it. Never include it in a URL, support ticket, screenshot or command history.

A provisioning token is bound to one organization and to the SCIM protocol. It cannot
call REST `/api/v1`, MCP or the CLI, and an ordinary API key cannot authenticate SCIM.
Token management itself requires your signed-in browser session, just like
[API-key administration](/docs/api-keys); it has no MCP tool or CLI command.

An organization can have at most 10 active tokens. This leaves room for staged IdP
transitions and recovery while bounding live credentials. Revoke unused tokens before
creating more.

Credentials in one organization share a stable provisioning connection. Rotating a
credential preserves this identity. Internal storage for future User profiles, claims
and suspension records is present, but it does not create accounts, grant membership
or change access in this release.

## Rotate and revoke

Rotation in Settings shows a new secret once and accepts the prior secret for one hour.
The browser-session REST operation also accepts an overlap of 0–86,400 seconds; zero
switches immediately. The current credential has no lifetime expiry. When provisioning
becomes available, use the overlap to update the IdP and verify the replacement. A second
rotation is refused while the previous overlap is active.

Revocation immediately disables the credential, including any overlapping old secret.
It cannot be undone. Last-used records credential authentication, not successful
synchronization; it is not evidence that Users or Groups are working in this release.
Turning off the feature flag disables creation, rotation and SCIM authentication but does
not revoke tokens. Owners and administrators can still inspect and revoke them before
re-enabling the flag; unrevoked tokens otherwise become usable again when enabled.

Keep the instance behind HTTPS and prevent your proxy, monitoring and request logs from
recording Authorization headers. An optional IP restriction can be applied at your
reverse proxy; there is no application-managed SCIM IP allow-list yet. Backups contain
hashes, not recoverable secrets. After restoring a backup, review and revoke or rotate
restored tokens before allowing provisioning traffic, because old valid credentials
may have been restored too.

## Known limitations

- `/scim/v2` has no Users, Groups, ServiceProviderConfig, ResourceTypes or Schemas
  handlers yet. A token is preparation, not a working provisioning integration.
- There is no automatic account creation, membership deactivation or group synchronization.
- No Okta, Microsoft Entra, Google Workspace connector or Keycloak plugin has passed
  interoperability acceptance. Do not interpret the design's request fixtures as certification.
- Groups-to-teams requires a future hierarchy and permission model: today's team is
  already an organization. Tokens cannot create or control unrelated teams.
- Full SCIM audit integration, resource rate limits and protocol conformance testing
  remain planned work. The token foundation does not provide a complete provisioning audit log.

The [repository design](https://github.com/hourmere/hourmere/blob/main/docs/scim.md)
records the intended protocol subset, safe account-claim flow, organization-only
revocation, provider quirks and implementation sequence. Those sections are future
requirements, not currently available product behavior.
