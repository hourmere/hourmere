# Team ownership transfer

This is a post-launch design. Today the [team role policy](member-leave.md#safe-team-departure)
still blocks owner assignment and demotion through ordinary role changes. The proposed flow
adds a dedicated transfer that takes effect only after the recipient confirms.

## Decisions and permissions

Use the signed-in team's member settings. The initiating owner selects an existing member
and sees what each person's role will become. The recipient opens the same team's settings,
sees who initiated the offer, its expiration and both role changes, and explicitly confirms.
Opening the page, following a navigation link or switching teams leaves the offer unchanged.

| Action | Authorized actor | Effect |
| --- | --- | --- |
| Create | A current, email-verified owner of the active team | Offer ownership to a different, current, email-verified `admin` or `member` of that same team. |
| View | The verified initiating owner or verified named recipient, with their original effective membership | Show the pending offer and its UTC deadline. Other members see no offer details. |
| Confirm | The named recipient alone, through their current, email-verified membership in the active team | Before the deadline, set the recipient to `owner` and the initiating owner to `admin` atomically. |
| Revoke | The initiating owner alone, through their current, email-verified owner membership in the active team | Revoke the pending offer before its deadline, without changing any roles. |

“Verified” means the live account has `emailVerified = true`. The browser session must
also be live and satisfy the team's ordinary SSO requirements for the operation. The server checks the
initiator and recipient's current accounts, membership IDs, effective memberships and roles
at creation and again at confirmation. An invitation, matching email address, past verification
or an ineffective membership is insufficient. Recipients must have manually managed memberships.
Reject both direct SCIM directory links and SCIM-managed child memberships, including while
provisioning is disabled. Existing owners and personal spaces are ineligible. Recognize legacy
comma-separated roles by exact tokens. On success write the two canonical roles, preserve both
member IDs and leave all other owners and members in place.

The former owner retains ordinary team admin access and the same hosting assignments. Team data
continues to belong to the team. Personal spaces, personal calendars and provider authorizations
stay with their original users. That includes Google, Microsoft and CalDAV calendar connections
and Zoom authorization. Existing event and booking hosts, calendar destinations and conference
references stay in place. Team API keys and OAuth grants retain their recorded principal and
organization, with ordinary live role checks applying after the role change. The transfer neither
hands over those credentials nor grants access to another user's provider credentials.

If the initiator holds recovery-owner status, reuse the [SSO recovery removal contract](sso.md#recovery)
in the transfer transaction. An enforced team must retain another usable, independently accepted
recovery owner. Clear the initiator's recovery status even if enforcement is off, advance the
policy revision and journal `sso_recovery.removed`. Recovery status never follows the role or
transfers to the recipient.

## Data model and transaction

Store one offer with an opaque ID, organization ID, both user and membership IDs, creation and
expiration instants (`timestamptz`), and a lifecycle state. The ID locates the offer. Authentication
and the bound membership authorize it. Keep no email address, provider data or bearer secret on
the offer. Preserve the participant IDs across membership deletion while the offer record exists
so that removing and re-adding a user cannot restore the offer.

Allow one pending offer per team. An offer expires 24 hours after creation on the database clock.
Confirmation and revocation require `clock_timestamp() < expires_at` after lock waits. At the
deadline itself, the offer is expired. Store one terminal state and its timestamp on transition
to `confirmed`, `revoked`, `expired` or `invalidated`. Reads hide expired or structurally invalid
offers without writing. An authorized owner can view and revoke their pending offer while the
recipient's verification or effective access is temporarily unavailable. The offer view does
not disclose why the recipient cannot confirm. The recipient sees the offer only when both
participants meet the account and membership checks for confirmation. A later write can retire
an expired or structurally invalid pending row and allow a fresh request with a new ID. No expiry
worker is required for the deadline to take effect.

Serialize create, confirm and revoke on the same organization write lock that protects membership
changes and safe departure. An initial team-scoped lookup resolves the participant user IDs from the
target membership on create or from the actor's bound offer on confirm or revoke. That lookup grants
no authority. Lock both user rows in UUID order before the organization, then the memberships,
relevant session and offer in the existing team write lock order. Re-read the binding and recheck
authorization under those locks. When removing recovery status, take the SSO policy write lock before
the SSO proof check can share-lock it. Check the proof and the database clock after lock waits.
Commit both role changes, recovery cleanup, one-time consumption and the audit event in one
transaction. Use the reserved `organization.ownership_transferred` action with the accepting
session as actor, the team as target and empty details. If the audit insert or either role write
fails, the transfer rolls back with the original owner and offer intact. Use the
[existing audit journal](audit-log.md#stable-actions-and-detail-allow-lists).

## Failure modes

| Condition | Result |
| --- | --- |
| Another offer is still pending | Return `409 ownership_transfer_pending` without disclosing the first offer's participants or ID. |
| Acting account, membership, team or credential does not authorize the action | Return the ordinary uniform team access denial without revealing another person's offer or eligibility. |
| An authorized participant has stale team context | Return `409 organization_context_changed` and ask them to reload. |
| An authorized actor submits a revoked, expired, invalidated or already confirmed offer | Return `409 ownership_transfer_unavailable`. Refresh current team roles and offers. Confirmation never runs a second time. |
| A bound membership disappears or the initiator no longer owns the team | Invalidate the offer under the team lock when observed by a write. A newly joined membership cannot use it. |
| A recipient becomes an owner or their membership becomes SCIM-managed | Invalidate the offer under the team lock when observed by a write. |
| Verification, effective membership or required session proof is missing | Refuse the action. An unexpired offer with the same eligible membership IDs can be used once the required live facts hold again. |
| SSO recovery continuity would be lost | Return `409 sso_recovery_required`. Keep the offer and both roles intact. |
| Confirmation races revocation, departure or another confirmation | The organization lock orders them. Each action rechecks the resulting state. At most one terminal transition applies, and the team retains an owner. |

## REST, MCP and CLI surfaces

The following REST endpoints are planned for the dashboard. An untrusted caller must pass the
existing verified cookie-session and team-context checks. Require `X-Expected-Organization-Id`
on all four operations, and the exact instance `Origin` on writes. Refuse requests with any
`Authorization` header, even alongside a valid cookie. Scope lookups by team and by participant
before returning offer data or a terminal conflict.

| Method and path under `/api/v1/teams/{teamId}` | Contract |
| --- | --- |
| `GET /ownership-transfer` | Return the caller's visible pending offer with its ID, participant display names, deadline and allowed action, or no offer. |
| `POST /ownership-transfer` | Create using the target membership ID. Return the offer and expiration. |
| `POST /ownership-transfer/{transferId}/confirm` | Confirm the bound offer. Return the two resulting membership roles. |
| `POST /ownership-transfer/{transferId}/revoke` | Revoke the bound pending offer. Return its new state. |

Declare OpenAPI security `[{session: []}]` and a `browser-session-only` exemption for each
operation in the [interface parity registry](../scripts/interface-parity.json). MCP and CLI
have no transfer capabilities because both participants act directly through browser sessions.
Better Auth's ordinary role endpoint retains its owner-write protections.

## Test plan

- In real Postgres, confirm as the named member and as a named admin in separate cases. Verify
  the initiator becomes admin, other owners and member IDs stay in place, and audit failure
  rolls back roles and consumption. Check personal calendar and provider rows, host references,
  API keys and OAuth grants retain their original bindings.
- Exercise cross-team, personal-team, wrong-recipient, pending-invite, unverified, SCIM-managed
  and suspended cases, an existing owner target, credential-bearing requests, stale context,
  and an SSO team at risk of losing its recovery owner. Verify refusals disclose no offer details
  and change no roles. Verify leave and rejoin cannot revive an old offer.
- Control the database time at the expiry boundary, including a wait crossing the deadline.
  Race confirmation against revocation, departure and duplicate confirmation. Compare stored
  terminal state, audit count and effective roles after both transactions settle.
- In both `en` and `zh-CN`, verify the owner can open and revoke an offer, the intended recipient
  can explicitly confirm, and both see role changes, deadline and the personal-resource boundary.

## One-day implementation steps

| Step | Deliverable and acceptance |
| --- | --- |
| Storage | Add a reserved migration with constraint coverage. Verify upgrade preserves existing memberships and owners, and fresh install and repeated migration succeed. |
| Service | Implement locked lifecycle transitions and audit. Prove eligibility, one-time consumption, revocation, deadline and owner continuity on Postgres. |
| Dashboard and interfaces | Add the session-only REST routes and parity exemptions, regenerate API types, and ship the bilingual dashboard. Verify both participants' browser flow and credential exclusions before enabling. |
