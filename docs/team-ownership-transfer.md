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
| View | The verified initiating owner or verified named recipient, with their original effective membership | Show the pending offer, its participants and its UTC deadline. Other current, email-verified owners see only its ID, deadline and the revoke action. |
| Confirm | The named recipient alone, through their current, email-verified membership in the active team | Before the deadline, set the recipient to `owner` and the initiating owner to `admin` atomically. |
| Revoke | Any current, email-verified owner of the active team, including an owner other than the initiator | Revoke the pending offer before its deadline, without changing any roles. |

“Verified” means the live account has `emailVerified = true`. Every operation requires a live
browser session, effective membership and the team's ordinary SSO access checks. Allowing other
owners to revoke prevents one owner from blocking the team for the life of an offer. Members who
are neither owners nor the named recipient see no offer. An owner acting only as revoker receives
no participant identities.

The server checks the initiator and recipient's current accounts, membership IDs, effective
memberships and roles at creation and again at confirmation. An invitation, matching email address,
past verification or an ineffective membership is insufficient. Both memberships must be manually
managed. Refuse an initiator whose owner membership is directory-managed because writing `admin`
would conflict with directory authority. Reject both direct SCIM directory links and SCIM-managed
child memberships, including while provisioning is disabled. Existing owners and personal spaces
are ineligible targets. Recognize legacy comma-separated roles by exact tokens. On success write
the two canonical roles, preserve both member IDs and leave all other owners and members in place.

The former owner retains ordinary team admin access and the same hosting assignments. Team data
continues to belong to the team. Personal spaces, personal calendars and provider authorizations
stay with their original users. That includes Google, Microsoft and CalDAV calendar connections
and Zoom authorization. Existing event and booking hosts, calendar destinations and conference
references stay in place. Team API keys and OAuth grants retain their recorded principal and
organization, with ordinary live role checks applying after the role change. The transfer neither
hands over those credentials nor grants access to another user's provider credentials.

SSO delegation bindings stay tied to their existing credentials and identity links. Owner-only
capabilities move with the owner role, including SCIM provisioning token issue and rotation, SSO
recovery nomination and SSO enforcement changes. These operations check the live role on every
call, including from sessions already open when the transfer commits. Their existing proof and
policy requirements still apply. Team-owned webhook endpoints, Slack connections, routing forms,
workflows and SCIM provisioning tokens stay with the team and retain their creator attribution.
Payments and Stripe configuration are instance-level and unaffected.

If the initiator holds recovery-owner status, reuse the [SSO recovery removal contract](sso.md#recovery)
in the transfer transaction. An enforced team must retain another usable, independently accepted
recovery owner. Clear the initiator's recovery status even if enforcement is off, advance the
policy revision and journal `sso_recovery.removed`. Recovery status never follows the role or
transfers to the recipient. In the confirming transaction, void pending SSO recovery nominations
where the initiator is either the nominator or the nominee in this team, even when the initiator
has no accepted recovery status. Remove those pending rows using the recovery store's existing
deletion model so regaining ownership cannot make them usable again.

## Fresh proof

Create and confirm use the shared `runWithFreshProof` gate in administration mode. Require fresh
mailbox proof for teams without SSO enforcement and SSO step-up for enforced teams. Ordinary
session access, mailbox-only proof on an enforced team and an SSO recovery grant do not meet this
requirement. Bind the proof to the browser, session, actor, team, operation and canonical input
digest. The digest includes the target membership ID for create and the transfer ID from the path
for confirm. After completing the challenge, retry the same operation and input with `proofAttemptId`.
Consume the proof once in the transaction that commits the requested change.

The existing proof gate and mailbox ceremony need a narrow allowance for these transfer operations
when SSO protocols are off. This lets non-enforced teams use mailbox proof while preserving the
protocol hard-off switches. An enforced team still requires available SSO step-up. Revoke uses the
live verified owner session and ordinary team SSO checks without fresh proof. It only cancels an
offer and leaves all roles intact, so an eligible owner can stop a pending transfer promptly.

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
offers without writing. Any authorized owner can view and revoke a pending offer while the
recipient's verification or effective access is temporarily unavailable. The offer view does
not disclose why the recipient cannot confirm. The recipient sees the offer only when both
participants meet the account and membership checks for confirmation. A later write can retire
an expired or structurally invalid pending row and allow a fresh request with a new ID. No expiry
worker is required for the deadline to take effect.

Serialize create, confirm and revoke on the same organization write lock that protects membership
changes and safe departure. Share the existing session organization-context lock on REST writes.
An initial team-scoped lookup resolves the participant user IDs from the target membership on create
or from the team-scoped offer on confirm or revoke. That lookup grants no authority. Share-lock
the participant and acting user rows in UUID order before locking the organization, the memberships,
the relevant session and the offer. Re-read the binding and recheck authorization under those locks.
Acquire the session lock before the offer lock even when the fresh-proof authorization callback
runs before the gate's own session check.
On confirmation, take the SSO policy write lock before the SSO proof check can share-lock it if
recovery cleanup needs to write the policy. Check the proof and the database clock after lock waits.

## Audit, notifications and rate limits

Use the [existing audit journal](audit-log.md#stable-actions-and-detail-allow-lists). In the
confirming transaction, write `organization.ownership_transferred` with the accepting session as
actor, the team as target and empty details. Also write `membership.role_changed` for both
memberships, each targeted by its membership ID with `oldRole` and `newRole`. Reusing the existing
role-change action records exactly who was demoted and promoted while keeping the transfer action's
detail allow-list empty. Correlate the three events with the same journal request ID.

Journal each stored lifecycle transition in its transaction. Use
`organization.ownership_transfer_offered` for creation and `organization.ownership_transfer_revoked`
for revocation, with the actual acting session as actor, the team as target and empty details.
When an authorized write retires an offer, record `organization.ownership_transfer_expired` or
`organization.ownership_transfer_invalidated` with the team as target, a system actor and empty
details. Record each terminal transition once, even if the authorized write returns an unavailable
result after retirement commits. Keep the fresh-proof authorization callback read-only and record
retirement in a locked write path. The lifecycle entries disclose no offer ID or recipient. Reads
do not write lifecycle events.

Queue a notification to the target on creation and to all current owners after promotion and to
the former owner on confirmation, once per recipient. Queue [mail outbox jobs](notifications.md)
in the same transaction as the roles, recovery cleanup, proof consumption, offer state and audit
events for that operation. If an audit, outbox or role write fails, roll back the whole operation.
Use the existing admin-language mail pattern and resolve each recipient's current verified Hourmere
mailbox at delivery. Mail links go to team settings and carry no offer IDs or confirmation credentials.

Rate-limit create and revoke per team using separate durable budgets shared by all owners and
server instances. Check and debit each successful transition under the organization lock so owner
rotation, concurrent requests and create/revoke cycles cannot bypass the creation budget. Use
aligned windows and allow at least one more revocation than creation per window, so an offer
carried into a new window can still be revoked even after the full create budget is used. On
exhaustion return `429 rate_limited` with `Retry-After` and leave roles, offer and notifications
intact. Proof challenge delivery uses its existing mailbox limits.

## Failure modes

| Condition | Result |
| --- | --- |
| Another offer is still pending | Return `409 ownership_transfer_pending` without disclosing the first offer's participants or ID. |
| Acting account, membership, team or credential does not authorize the action | Return the ordinary uniform team access denial without revealing another person's offer or eligibility. |
| An authorized actor has stale team context | Return `409 organization_context_changed` and ask them to reload. |
| An authorized actor submits a revoked, expired, invalidated or already confirmed offer | Return `409 ownership_transfer_unavailable`. Refresh current team roles and offers. Confirmation never runs a second time. |
| A bound membership disappears or the initiator no longer owns the team | Invalidate the offer under the team lock when observed by a write. A newly joined membership cannot use it. |
| The initiator's owner membership is SCIM-managed | Refuse creation with `409 scim_managed_resource` so the owner can see why. If either bound membership becomes SCIM-managed after creation, invalidate the offer under the team lock and return `409 ownership_transfer_unavailable` on confirmation. |
| A recipient becomes an owner | Invalidate the offer under the team lock when observed by an authorized write. |
| Verification, effective membership or ordinary session access is missing | Refuse the action. An unexpired offer with the same eligible membership IDs can be used once the required live facts hold again. |
| An otherwise authorized create or confirm needs fresh proof | Return `403 sso_reauthentication_required` with `attemptId`, `proofMethods` and `expiresAt`. Complete the challenge and retry the same input with `proofAttemptId`. |
| SSO recovery continuity would be lost | Return `409 sso_recovery_required`. Keep the offer and both roles intact. |
| The team's create or revoke budget is exhausted | Return `429 rate_limited` with `Retry-After`. |
| Confirmation races revocation, departure or another confirmation | The organization lock orders them. Each action rechecks the resulting state. At most one terminal transition applies, and the team retains an owner. |

## REST, MCP and CLI surfaces

The following REST endpoints are planned for the dashboard. An untrusted caller must pass the
existing verified cookie-session and team-context checks. Require `X-Expected-Organization-Id`
on all four operations, and the exact instance `Origin` on writes. Refuse requests with any
`Authorization` header, even alongside a valid cookie. Scope lookups by team and check the actor's
participant or owner authority for the requested action before returning offer data or a terminal conflict.

| Method and path under `/api/v1/teams/{teamId}` | Contract |
| --- | --- |
| `GET /ownership-transfer` | Return the caller's visible pending offer with its ID, deadline and allowed action, or no offer. Include participant display names only for the initiator and named recipient. |
| `POST /ownership-transfer` | Create using the target membership ID and `proofAttemptId` on retry. Return the offer and expiration. |
| `POST /ownership-transfer/{transferId}/confirm` | Confirm the bound offer using `proofAttemptId` on retry. Return the two resulting membership roles. |
| `POST /ownership-transfer/{transferId}/revoke` | As a current owner, revoke the pending offer. Return its new state. |

Declare OpenAPI security `[{session: []}]` and a `browser-session-only` exemption for each
operation in the [interface parity registry](../scripts/interface-parity.json). MCP and CLI
have no transfer capabilities because both participants act directly through browser sessions.
Better Auth's ordinary role endpoint retains its owner-write protections.

## Test plan

- In real Postgres, confirm as the named member and as a named admin in separate cases. Verify
  the initiator becomes admin and other owners and member IDs stay in place. Check personal
  calendar and provider rows, host references, API keys, OAuth grants, SSO delegation bindings
  and team-owned integrations retain their original bindings and attribution.
- Verify the old owner immediately loses owner-only operations, including from already-open
  sessions. Exercise SCIM token issue and rotation, recovery nomination and SSO enforcement
  with the old and new owners under the existing operation-specific gates.
- Exercise cross-team, personal-team, wrong-recipient, pending-invite, unverified, SCIM-managed
  and suspended cases, an existing owner target, credential-bearing requests, stale context,
  and an SSO team at risk of losing its recovery owner. Verify refusals disclose no offer details
  and change no roles. Cover both direct and child SCIM links for the initiator and recipient at
  creation and confirmation. Verify leave and rejoin cannot revive an old offer.
- For create and confirm, exercise expired proof, a mismatched input digest, cross-operation replay
  and mailbox-only proof on an enforced team. Verify the challenge leaves the offer and roles
  intact. Complete mailbox proof with both SSO protocols off on a non-enforced team and SSO
  step-up on an enforced team. Verify neither proof can be consumed twice.
- Verify a different current owner can discover and revoke the offer without seeing participant
  identities, including when the recipient temporarily loses effective access. Refuse former owners
  and non-owners. Verify per-team limits across multiple actors and concurrent cycles. Start a new
  window with a carried-over offer, then exhaust the create budget and revoke the last offer.
- Verify confirmation voids pending nominations issued to and by the initiator, including without
  accepted recovery status. Verify other owners' unrelated nominations and accepted recovery status
  remain intact and regaining ownership cannot revive a voided nomination.
- Assert both role-change audit rows, actor attribution for create and third-party revoke, and one
  audit event per persisted expiry or invalidation. Check notification recipients, language and
  absence of offer IDs in mail. Inject audit and outbox failures and verify rollback of state,
  roles, recovery cleanup, proof consumption and queued mail. Verify repeated requests queue no
  duplicate notifications.
- Control the database time at the expiry boundary, including a wait crossing the deadline.
  Race confirmation against revocation, departure and duplicate confirmation. Compare stored
  terminal state, audit count and effective roles after both transactions settle.
- In both `en` and `zh-CN`, verify the owner can open and revoke an offer, the intended recipient
  can explicitly confirm, and both see role changes, deadline and the personal-resource boundary.

## One-day implementation steps

| Step | Deliverable and acceptance |
| --- | --- |
| Storage | Add a reserved migration with constraint coverage. Verify upgrade preserves existing memberships and owners, and fresh install and repeated migration succeed. |
| Service | Implement locked lifecycle transitions, fresh proof, rate limits, recovery cleanup and audit. Prove authorization, one-time consumption, deadline and owner continuity on Postgres. |
| Notifications | Add en and zh-CN admin mail and wire transactional outbox jobs into create and confirm. Verify recipients, rollback and deduplication on Postgres before exposing the service. |
| REST and interface parity | Add the four session-only REST routes, OpenAPI and parity exemptions. Regenerate API types. Run route-level Postgres tests for proof, origin, context and credential boundaries. |
| Bilingual UI and two-party browser acceptance | Ship the en and zh-CN dashboard with jsdom coverage. Run the owner and recipient browser flow, including stale context, confirmation racing revocation and credential exclusions, before enabling. |
