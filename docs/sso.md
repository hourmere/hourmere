# Organization SSO: evaluation and implementation design

Status: design only, evaluated 2026-11-06 against Hourmere's Better Auth 1.7.12
family. No SSO provider, route, feature flag, migration or dependency is enabled by
this change. SSO will be available to every instance, including self-hosted ones;
there is no license, subscription or hosted-service requirement.

## Decision and release conditions

Wrap Better Auth's SSO integration behind Hourmere-owned trust, linking, admission
and authorization services. Do not expose the plugin's provider-management API
unchanged or let its domain-based linking/provisioning become Hourmere policy.
Use maintained protocol/cryptography libraries, not new JWT or XML signature code.
The source evaluation below determines which plugin paths can be retained. A gap
in a pre-session validation hook is a release blocker: contribute a fix or use a
narrow maintained protocol adapter at that boundary before shipping that protocol.
A post-login hook cannot repair a session that should never have been issued.

## Evaluated plugin evidence

### Method and exact versions

Repository packages/auth/package.json pins better-auth and family packages at 1.7.12. Installed @better-auth/sso@1.7.12, better-auth@1.7.12, @better-auth/core@1.7.12 plus same-version adapters/telemetry into worktree `.sso-evaluation-spike/node_modules`, with ignore-scripts, no audit, no lockfile; no root dependency edits. The owned spike and its cache were deleted after inspection. Explicit family pins were necessary because unrestricted peer resolution selected core 1.7.18 and conflicted with sso's exact @better-fetch/fetch 1.3.2 peer. Resolved transitive versions: samlify 2.15.1, jose 6.2.15, @xmldom/xmldom 0.9.12, fast-xml-parser 5.12.0, xml-crypto 6.4.0. These are the evaluated artifact, not a claim about a historical 1.7.12 lockfile. Future implementation must pin/audit the complete lockfile.

Official sources: [SSO docs](https://better-auth.com/docs/plugins/sso), [OIDC](https://better-auth.com/docs/plugins/sso/oidc), [SAML](https://better-auth.com/docs/plugins/sso/saml), [SAML validation](https://better-auth.com/docs/plugins/sso/saml-security), [provisioning](https://better-auth.com/docs/plugins/sso/provisioning), [changelog](https://github.com/better-auth/better-auth/blob/main/packages/sso/CHANGELOG.md), [versioned source](https://github.com/better-auth/better-auth/tree/v1.7.12/packages/sso/src), [core verifier](https://github.com/better-auth/better-auth/blob/v1.7.12/packages/core/src/oauth2/verify-id-token.ts). Live docs advertise 1.7.18 and are not a substitute for installed-version inspection. The source observations below come directly from installed JS, chiefly @better-auth/sso/dist/index.mjs.

### Recommendation

Wrap, conditionally; do not expose stock plugin routes or ship SSO with 1.7.12 unchanged. Reuse established protocol parsing/crypto, account/session integration and transaction-aware resolveUser; Hourmere owns organization/provider policy, encrypted configuration, exact identity binding, domain lifecycle, enforcement and audit. OIDC requires a reviewed protocol adapter/maintained upstream patch for nonce, algorithm policy, iat-age validation, guarded fetch and JWKS cache; merely adding a /api/v1 facade cannot supply these missing seams. Require proof in a separate implementation foundation step; if safe hooks/patch cannot be maintained, select a maintained OIDC RP library behind the same interface rather than write cryptography. SAML may wrap plugin validation with hardened settings and signed-assertion fixtures, but encrypted-assertion and missing-ID paths require explicit acceptance. Leave feature disabled until all negative protocol and egress checks pass. First coordinate a separate Better Auth family security upgrade (at least fixes in 1.7.16, then re-evaluate selected final version); this docs PR must not change dependencies.

### Source evidence matrix

| Area | Installed 1.7.12 evidence | Hourmere consequence |
|---|---|---|
| OIDC protocol/discovery | Code flow, discovery/manual endpoints; discovery issuer exact match; PKCE field defaults true but is client-configurable; createAuthorizationURL uses state.codeVerifier only when config.pkce. Runtime discovery possible when endpoints missing. index.mjs 580, 600, 1888, 3720–3750. | Force S256 PKCE and fixed openid/email/profile scopes; no caller additionalParams overriding protocol controls; omit offline_access for sign-in. Explicit per-provider callbacks. |
| State/nonce | generateState and providerReference bind state to provider/version; callback revalidates provider references and locks provider during linking. No nonce occurrence in plugin JS; authorization request and verifyIdToken call omit nonce. | Persist transaction nonce, require matching signed claim before session; block generic callback bypass. |
| ID token | validateOIDCIdToken uses core verifyIdToken with JWKS, issuer/audience, azp check for multi-audience or supplied azp. Core requires iss/sub/aud/exp/iat, rejects empty clientId, sets 30-second clock tolerance. ID token optional unless resolveUser configured; UserInfo sub must match token sub. | Require ID token every login; retain iss/aud/azp/exp/sub checks; strict claims and email_verified policy. |
| iat/algorithm gaps | Core passes optional algorithms/maxTokenAge but plugin supplies neither. jose 6.2.15 jwt_claims_set checks numeric iat, but rejects future iat/over-age iat only when maxTokenAge is set. | Explicit algorithm allowlist from trusted provider policy; validate iat future and maximum age. Do not claim plugin validates freshness because it requires claim presence. |
| JWKS | createRemoteJWKSet constructed inside validateOIDCIdToken each callback, guarded remote fetch; no application-level shared cache, no discovered signing-algorithm policy passed. | Cache per provider/issuer/JWKS URL with bounded freshness and controlled unknown-kid refresh, no stale success after key failure; concurrency/rotation tests. |
| SSRF | fetchOIDCEndpoint and native response helper revalidate endpoints at fetch, redirects manual then rejected. Discovery uses same helper. DNS lookup result not connection-pinned; failures return; trustedOrigins bypasses private-host checks. No exposed custom fetch in options. | Reuse Hourmere outbound guard at actual connection for discovery/token/UserInfo/JWKS/metadata, deadlines and size limits; do not equate CORS/redirect origins to egress trust. |
| SAML validation | samlify SP parseLoginResponse, exactly one plaintext/encrypted assertion count, additional namespace/ID-aware assertion signature check when wantAssertionsSigned true; audience/recipient/destination binding; provider references locked/rechecked. index.mjs 1190–1255, 2848–2966. | Require signed assertion (response may also sign), strict XML fixture tests for wrapping/duplicate IDs/external entities, fixed ACS/issuer/audience, use authenticated subtree only. |
| SAML timestamps | clockSkew defaults 300000 ms. requireTimestamps default false; permissive missing condition path warns. | Require valid bounded NotBefore AND NotOnOrAfter and SubjectConfirmationData expiry; future implementation owns tested numeric policy. |
| SAML replay | validateInResponseTo atomically consumes verification value and checks provider/reference; default validation on/IdP-initiated false. Assertion reserveVerificationValue uses assertionId identifier, expires NotOnOrAfter + skew, fallback TTL if absent. Missing extracted assertion ID only warns. | Keep correlation on; require assertion ID and strict expiry, database atomic uniqueness across replicas, reject missing ID and expired request. |
| RelayState/browser binding | generated generic server state with provider reference; parse skips state cookie check because cross-site POST drops Lax cookies. Invalid supplied RelayState rejected but absent RelayState can use InResponseTo. | Require issued opaque RelayState and browser-bound pending login completion; do not treat request correlation alone as browser binding. A same-site completion hop with original browser nonce is a defensible design. |
| Encryption | createSP wires encPrivateKey and encrypted-assertion settings; binding content decrypted for validation. Registration config/private keys serialized as JSON text. | Supported in dependency but encrypted assertions require fixture-tested algorithm allowlist; envelope-encrypt client secrets/private keys at rest, decrypt only transiently. Never set trustEmailVerified globally. |
| SAML metadata/rotation | imported XML or explicit entity/cert; generated SP metadata; cert arrays; custom SP metadata cannot weaken assertion-signing policy. Imported XML overrides manual cert, no automatic refresh. | Guard optional metadata download; pin entity ID and validated keys, explicit reviewed refresh/version change, overlap rotation tests incl no KeyInfo. |
| DNS | plugin challenge checks every comma-separated domain with DNS TXT; one domainVerified boolean; already-verified returns 409; no periodic re-verification. Provider domain changes reset boolean. DefaultSSO can count verified without DNS. | Own exact-domain records and re-verification/suspension; no wildcard/subdomain expansion or code-config trust bypass. |
| Linking | resolver receives verified OIDC token claims/provider SAML attributes and exact accountKey issuer/sub-or-NameID; native transactional support enforced; exact account binding only with resolveUser. Default domain trust can implicitly link verified local email and includes subdomains. | resolveUser mandatory, exact org/provider/issuer/subject binding, no implicit email claim-based takeover. Require current existing-account proof for first linking. |
| Provisioning | default org assignment after authentication, member role by default; provisionUser/getRole hooks; social sign-in may assign by verified domain; pending invitation suppresses autojoin. disableImplicitSignUp can be overridden by OIDC requestSignUp. | Disable stock organization provisioning and implement transactional JIT/invitation policy in resolver; re-check every login; never use disableImplicitSignUp alone as invitation-only protection. |

The inspected samlify 2.15.1 verifySignature uses absolute XPaths, rejects wrapping descendants, requires message KeyInfo cert to match pinned metadata, checks signed references and signed root/ID/namespace. This supports reuse but is not proof all malicious XML cases are safe; test actual locked versions. SAML secret storage and browser-binding limitations cannot be repaired by documentation alone.

### Changelog and security

Changelog 1.7.12 / [PR 11935](https://github.com/better-auth/better-auth/pull/11935) requires exp/iat and nonempty clientId. 1.7.8 / [11438](https://github.com/better-auth/better-auth/pull/11438) rejects discovery issuer mismatch; [11687](https://github.com/better-auth/better-auth/pull/11687) restores certificate rotation; 1.7.3 restores providerId/accountId keys and rejects ambiguous keys after the 1.7.0 issuer-schema change.

Read upstream GitHub advisory API on 2026-11-06. SSO-specific published advisories observed:

| Advisory | Risk | Patch | 1.7.12 status |
|---|---|---|---|
| [GHSA-mx9r-x6ww-qjw9](https://github.com/better-auth/better-auth/security/advisories/GHSA-mx9r-x6ww-qjw9) | personal-provider identity crossover | 1.7.3 | outside affected range |
| [GHSA-8c5h-wx78-2cfg](https://github.com/better-auth/better-auth/security/advisories/GHSA-8c5h-wx78-2cfg) | unproven domain claims / account takeover | 1.6.27 or 1.7.0-rc.5 | outside affected range |
| [GHSA-prpr-5gj3-qqhg](https://github.com/better-auth/better-auth/security/advisories/GHSA-prpr-5gj3-qqhg) | four domain/provider deletion/SAML/SLO takeover flaws | 1.6.21 or 1.7.0-beta.10 | outside affected range |
| [CVE-2026-53515 / GHSA-gv74-j8m3-fg5f](https://github.com/better-auth/better-auth/security/advisories/GHSA-gv74-j8m3-fg5f) | ordinary members register org provider | 1.6.11 or 1.7.0-beta.4 | outside affected range |
| [CVE-2026-53513 / GHSA-5rr4-8452-hf4v](https://github.com/better-auth/better-auth/security/advisories/GHSA-5rr4-8452-hf4v) | SSRF registration | 1.6.11 | outside affected range |

No CVE IDs reported by upstream API for the first three; do not invent them. This is a dated inventory, not a security certification.

**Newer core issues matter despite SSO-specific patches:** November 3 advisories [GHSA-9hm7-xhfp-cx58](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58) (unverified OAuth email), [GHSA-fvxx-76fc-893x](https://github.com/better-auth/better-auth/security/advisories/GHSA-fvxx-76fc-893x) (revoked sessions cached/secondary storage) and [GHSA-c85h-5mrr-mgx4](https://github.com/better-auth/better-auth/security/advisories/GHSA-c85h-5mrr-mgx4) (padded owner invitation role) list stable patch 1.7.16, and their ranges include 1.7.12. Actual Hourmere exploitability is not established by this design evaluation; coordinate family upgrade separately before shipping SSO.

### Open upstream bugs / limitations (queried 2026-11-06)

- [12081](https://github.com/better-auth/better-auth/issues/12081): no OIDC nonce; confirmed installed source.
- [10625](https://github.com/better-auth/better-auth/issues/10625): no custom federation fetch seam; confirmed options/source limitation. Its historical redirect implementation details differ from inspected artifact.
- [10830](https://github.com/better-auth/better-auth/issues/10830): discovery DNS check omission remains open but **not reproduced in installed 1.7.12 source**, which calls shared guarded fetch; retain regression test, do not label current artifact vulnerable on this report alone.
- [10831](https://github.com/better-auth/better-auth/issues/10831): trustedOrigins/SSRF coupling; current bypass and unpinned addresses confirmed.
- [4291](https://github.com/better-auth/better-auth/issues/4291): encrypt config at rest; JSON serialization confirmed.
- [11570](https://github.com/better-auth/better-auth/issues/11570): expose verified authentication statements/fresh SAML auth; enforcement freshness must not be inferred from session.createdAt alone.
- [11569](https://github.com/better-auth/better-auth/issues/11569): transaction hooks for enrollment/org assignment; integration must own transactional membership.
- [10784](https://github.com/better-auth/better-auth/issues/10784): per-domain verification.
- [9707](https://github.com/better-auth/better-auth/issues/9707): group-to-role mapping, defer.
- [11349](https://github.com/better-auth/better-auth/issues/11349): SSO sign-in does not automatically resume OAuth authorization; test MCP OAuth continuation.
- [12167](https://github.com/better-auth/better-auth/issues/12167): providers listing excludes caller after 101 rows; own tenant-scoped pagination.
- [12080](https://github.com/better-auth/better-auth/issues/12080): public clients unsupported; choose confidential OIDC clients.
- [11575](https://github.com/better-auth/better-auth/issues/11575), [11578](https://github.com/better-auth/better-auth/issues/11578): SP metadata/outgoing SLO signature gaps; defer SLO and promise local revocation only.


## Organization ownership and verified domains

Only current verified team owners/admins configure providers; personal organizations
cannot have providers. A provider belongs to exactly one immutable organization,
with an opaque, never-reused ID. Multiple providers may coexist for migration;
selection is explicit by team and provider, not a global email-domain redirect.
Changing issuer, client identity or SAML entity ID creates a replacement provider
and requires a fresh test and explicit relinking. It cannot inherit another
provider's external-subject bindings. Deletion retires an ID permanently.

Domain claims are separate from users and providers. Normalize an exact DNS name
using IDNA ASCII and lowercase; reject public suffixes, IPs and wildcard claims.
Owning a parent domain does not claim its subdomains. Store one active claim per
exact domain per instance, with organization identity and verification generation.
A claim cannot evict another organization. Transfers require old-claim retirement
and a fresh challenge; ambiguous multi-tenant domains require invitation-only access.

Return a random DNS TXT challenge at `_hourmere-sso.<domain>`, bound to instance,
organization, domain and generation. Compare the exact value through the server's
trusted DNS resolver; never accept an administrator's uploaded lookup result.
Store a digest, not the raw challenge; a lost response requires rotation. Challenge
creation invalidates the previous generation. Verification is an explicit POST,
not a side effect of GET. Persist verification time, next-check time and expiry.
Recheck on a schedule and before enabling JIT or enforcement; only an unexpired
positive proof grants domain authority. DNS errors mean unknown, not verified or
missing configuration. Renewal failure freezes new links, JIT and provider
activation; expiry suspends new SSO proofs and team access under enforcement.
It never silently disables the organization's enforcement policy. Existing proof
validity is bounded by the domain verification expiry too. Recovery remains usable.

A matching domain never moves a personal organization, changes ownership, joins a
team, locks a personal account or gives an administrator its data. Existing people
can keep magic link, Google and Microsoft for personal/other-team access. Public
sign-in accepts an explicit team/provider link; do not expose account existence,
membership or private domain directories through email discovery.

## Identity, linking and admission

Identity is `(organization, provider ID, validated issuer/entity ID, immutable sub)`;
SAML requires a stable persistent NameID or an explicitly pinned immutable attribute.
Transient NameIDs and email-as-subject are unsupported. Email changes do not change
identity. A conflicting subject/user binding fails closed and needs explicit recovery.

For OIDC, require the actual boolean `email_verified: true` in validated claims;
missing, false, strings and UserInfo-only unbound email are not verification.
If UserInfo is needed, its `sub` must match the validated ID token. Do not infer
verification from domain ownership. SAML has no standard `email_verified` claim:
its signed email attribute is an IdP assertion, not mailbox proof. Require separate
Hourmere email proof on initial enrollment and whenever the email changes. For
OIDC without verified email, offer the same separate proof flow; never coerce the
claim to true to satisfy the current user-create hook.

An existing magic-link/Google/Microsoft account with the same email is **not**
automatically linked to a newly configured enterprise IdP, even on a verified domain.
The person first authenticates through an existing method, then explicitly starts a
session-bound link ceremony and proves the IdP subject. Require fresh independent
mailbox/existing-method proof; an SSO session from that same provider cannot approve
its own first link. Freeze both identities and the session in the pending attempt;
compare again in the completion transaction. Reject email mismatch, provider change,
logout, stale session, conflicting links and concurrent attempts with different users.
Do not enable the disabled general `/api/auth/link-social` route to implement this.

New users need mailbox proof and instance signup eligibility as well as team admission.
Retain `maySignUp`, database signup triggers, first-user serialization and the
personal-organization guarantee. JIT never becomes an exception to `SIGNUP=closed`.
An eligible current invitation can provide the existing signup exception; its original
inviter must still qualify at commit. A closed instance operator must deliberately
configure allowed domains or invitations before JIT can create users.

Default team admission is invitation-only: a verified login does not accept an
invitation silently. Use the existing explicit acceptance lifecycle and invitation
role rules. Optional JIT admits a proven identity on the team's currently verified
domain as `member`, with team capacity and removal checks under the organization
lock. Never map arbitrary IdP claims to owner/admin. Group-to-role mapping, if added
later, needs an explicit allowlist and cannot grant owner. Existing roles are retained.

Leaving/removal creates a team-local admission tombstone, revokes that membership's
SSO proofs and delegated authority, and prevents JIT from immediately restoring it.
A new current invitation can explicitly reinstate access; SCIM suspension (planned)
requires SCIM/admin reactivation as well. SCIM is not implemented here. Later SCIM
must share these locks, tombstones and revocation services; it must not delete the
person's personal account or other memberships. Without SCIM or logout delivery,
disabling a person at the IdP takes effect on the next required authentication,
not instantly. Local removal takes effect on the next authorization check.

## Enforcement, recovery and delegated clients

`requireSso` is an organization access rule, not an instance-wide replacement for
magic links. Every team-scoped read/write checks current membership, policy revision
and a live provider-bound proof, except the narrowly listed recovery operations below. A session authenticated by Google for a personal
space does not satisfy team SSO; switching active space does not manufacture proof.
Initial enrollment has a separate narrow exception: the caller's own `/api/v1/me`
required-provider/attempt summary, auth initiation and `linkSsoAccount` accept an
independently proven local session plus current membership or eligible invitation,
without an existing SSO proof. They expose no team data or administrator configuration.
This allows an unlinked member to obtain the proof enforcement requires; successful
linking still grants no team access until the SSO/admission checks pass.
Check both `/api/v1` and native Better Auth team routes and shared services; middleware
alone does not protect trusted calls, transactions or queued operations.

Enabling enforcement requires a verified domain, enabled tested provider, a successful
owner SSO test against the exact current revision, and an enrolled recovery owner.
Only an owner can change enforcement/recovery or retire the last usable provider
while enforcement is active; admins can prepare replacements. Concurrent policy,
provider and membership changes serialize and increment the policy generation.
Already-running writes recheck authority in their committing transaction.

Designate a current owner for break-glass access. After fresh magic-link mailbox proof,
an explicit recovery ceremony issues only recovery authority: inspect configuration,
repair/test a provider and turn off enforcement. It does not grant bookings, member
exports or MCP access without SSO. Record and notify every recovery start/use through
the audit/outbox system; logs never include the email capability. Enrollment is tested
before enforcement. The last recovery owner cannot leave until another is enrolled.
Recovery authority bypasses only the SSO-proof requirement (never owner, session,
Origin or expected-team checks) for `listSsoProviders`, `getSsoPolicy`,
`updateSsoProvider`, `createSsoProvider`, `testSsoProvider`, `activateSsoProvider`
and `setSsoPolicy` with `requireSso: false`. `useSsoRecovery` itself accepts the
independent owner mailbox proof without SSO. It cannot enable JIT, alter membership,
bind delegations or change the recovery owner. Each repair write consumes its recovery
authority; a subsequent repair/test/activation requires another mailbox ceremony.
A test callback can finish only its already-bound test intent, and grants no wider
access. Read-only inspection does not consume authority but observes its expiry.
If that mailbox is lost, an instance operator uses an audited offline recovery procedure
against that instance; document it before release. No global public bypass secret.

API keys and MCP OAuth grants are not exempt. Before enforcement they retain existing
scope rules. On enforcement/policy change, existing credentials have no SSO proof and
cannot act in that team. A person can bind/rebind an owned key or OAuth grant to the
team in a fresh SSO browser session; the record stores provider, subject binding,
policy generation and an absolute proof expiry. MCP access/refresh tokens cannot
extend it. Reauthorize through the browser after expiry; a machine client gets stable
`sso_required`, never an interactive redirect. Personal/other-team access remains
subject to its own policy. No service-account exemption ships in the first version.
A `full` key still cannot configure the IdP or approve its own SSO binding.

Fresh administration measures a verified authentication event, not session creation
or ID-token `iat`. OIDC step-up sends `max_age=0` and validates signed `auth_time`
against the fresh-administration window and transaction start (with skew); SAML sends
`ForceAuthn=true` and requires a signed AuthnStatement `AuthnInstant` within that
window. An IdP that cannot prove freshness requires an independent fresh Hourmere
mailbox confirmation bound to the same transaction in addition to valid SSO. Silent
IdP SSO, rolling sessions and refresh tokens cannot renew administration freshness.
First linking/recovery always uses independent local proof as specified above.

Proof is separate from the ordinary Better Auth session: rolling session refresh
cannot extend it. Its deadline is the earliest of the absolute SSO lifetime, session
expiry, domain proof expiry and any validated earlier IdP session deadline. ID token
expiry governs callback acceptance, not continuing refresh-token use. Logout,
provider disable/delete, subject unlink, domain expiry, local member removal and
policy changes invalidate affected proofs. A server-side generation check avoids
waiting for cached cookies or OAuth token expiry. Recheck queued authenticated work
before acting; durable booking notification/calendar reconciliation continues under
its existing booking lifecycle and is not arbitrarily deleted on member logout.

## Protocol security requirements

### OIDC

Authorization code flow only, PKCE S256 required with a new verifier per attempt,
and unpredictable state and nonce bound to the initiating browser, provider,
organization, configuration revision and allowed return path. Consume state atomically
before exchanging a code; retries never exchange it twice. Require an ID token and
validate its signature, exact `iss`, `aud` (including `azp` for multiple audiences),
`exp`, `iat`, optional `nbf`, nonce and nonempty stable `sub`. Reject future `iat`
beyond skew and tokens older than the transaction acceptance window. Neither decoding
a JWT nor successful UserInfo retrieval substitutes for this validation.

Initially allow RS256 only; reject `none`, HMAC confusion and unconfigured algorithms.
Pin issuer and discovery location; discovered `issuer` must exactly match. Cache JWKS
by issuer and URI with bounded TTL; on unknown `kid`, perform a bounded guarded refresh
then retry validation once, rate-limited per provider. Retain known keys only within
cache validity; never fetch a token-supplied `jku`/`x5u`. Rotation tests must cover key
replacement and outage, unknown/duplicate key IDs and an algorithm/key-type mismatch.
Request only `openid email profile`, no offline access. Discard ID/access/refresh
tokens after validation; never repurpose calendar or MCP OAuth credentials.

### SAML

SP-initiated HTTP-Redirect request and HTTP-POST response only. Disable IdP-initiated
login and single logout at first release. Require a signed assertion; a response-only
signature is not accepted initially. If a response also carries a signature, validate
it too. Use configured IdP signing certificates, with explicit overlapping rotation;
never trust a certificate carried only in the incoming XML. Require SHA-256 digest
and RSA-SHA256 signature initially; reject SHA-1 and unconfigured algorithms.

The verified assertion node must be the exact node consumed for attributes and
SubjectConfirmation. Reject duplicate XML IDs, multiple assertions, signature wrapping,
external entities/DTDs, external signature references, ambiguous attributes and
unexpected namespaces. Require issuer, exact audience/entity ID, recipient/ACS and
response Destination. Validate Conditions and bearer SubjectConfirmationData time
bounds; require finite NotOnOrAfter and validate NotBefore with bounded skew.
Require assertion and response IDs. Match both response and subject InResponseTo to the outstanding request and provider.

Persist request ID, browser-binding digest and an opaque RelayState handle before
redirect. RelayState carries no arbitrary callback URL or identity; POST callback
correlation must work without relying on a Lax cookie arriving on a cross-site POST.
After signature/correlation validation, persist a short-lived pending result and
redirect to a same-origin completion page. Only the original browser-binding cookie
can complete it; no session/proof is minted on the cross-site POST. A missing cookie
or RelayState fails closed, including when InResponseTo is otherwise valid.
Consume request and assertion/response IDs atomically in a shared database replay
cache before creating a proof/session. Keep replay tombstones through the latest
accepted assertion expiry plus skew, at least the request window; reject assertions
whose lifetime exceeds the configured maximum. Parallel callbacks must yield one
success. Encrypted assertions are deferred: reject them explicitly until decryption
and signed-decrypted-node validation are implemented and tested together. Encryption
never replaces signatures.

### Fetching, credentials and audit

Reuse/extract the outbound URL policy and pinned-socket transport from
`packages/webhooks/src/transport.ts`; URL string validation followed by ordinary
`fetch` is insufficient. Apply it to discovery, token, UserInfo, JWKS and metadata
requests, including refreshes. Require HTTPS public destinations by default, reject
userinfo/fragments, private/reserved addresses and mixed DNS answers, and pin the
validated address while preserving TLS hostname verification. Reject redirects or
validate each hop through the same transport. Bound response size, decompression,
connection/body time and concurrency; disable XML external-resource retrieval.
Metadata import is untrusted configuration, not proof of domain ownership. Parse
only expected IdP entities, bind entity IDs and endpoints, and review certificate
changes; no automatic trust replacement from a refreshed metadata URL.

Self-hosted private IdPs require a separate operator-owned exact host/port allowlist
(`SSO_PRIVATE_TARGETS`, proposed), never a team-editable bypass or reuse of the webhook
allowlist setting. Loopback HTTP is allowed only for an explicitly configured local
trial. Cloud leaves the private allowlist empty. The same DNS/socket policy applies
on every request, not just provider registration.

Encrypt client secrets and future SP private keys with purpose-bound AES-256-GCM,
using the existing credential-encryption pattern with organization/provider/revision
as authenticated context and an operator-managed key. Plugin JSON configuration must
not retain plaintext secrets. Reads return only `hasClientSecret`/key identifiers;
writes accept replacement secrets, omission preserves them, and null cannot silently
clear a required secret. Do not log tokens, assertions, XML, discovery bodies, DNS
challenge values or provider error descriptions. Audit encrypted-key rotation and
support operator key backup/restore without printing material.

The forthcoming audit service must record actor and authentication method, team,
provider/configuration generation, safe outcome/reason and correlation ID for:
provider create/edit/test/enable/disable/delete and secret/certificate rotation;
domain challenge/verification/renewal/expiry/release; link/unlink/conflict; SSO
success/failure and rejected replay; JIT admission/refusal; enforcement and delegated
binding changes; proof revocation; recovery enrollment/use; member/SCIM suspension
and reinstatement. Use durable transactional intent with redacted security-failure
events. Do not block emergency recovery on a third-party audit sink; retain a local
record for later delivery. Audit integration is a release dependency, not a claim that
`organization_operations` already covers all these events.

## Pinned operational limits

These are initial design commitments, not current runtime settings. The doc-fact test
pins this table; implementation must import its eventual constants into that test.
Other transport/resource limits must be selected with fixtures before their release.

| Limit | Value | Unit |
|---|---:|---|
| `clockSkew` | 60 | seconds |
| `authenticationAttemptLifetime` | 600 | seconds |
| `maximumSamlAssertionLifetime` | 600 | seconds |
| `ssoProofLifetime` | 28800 | seconds |
| `freshAdministrationProof` | 300 | seconds |
| `domainChallengeLifetime` | 86400 | seconds |
| `domainRecheckInterval` | 86400 | seconds |
| `domainVerificationLifetime` | 604800 | seconds |
| `jwksCacheMaximum` | 3600 | seconds |

All expiry uses UTC instants and database wall time after lock waits; there is no
local-calendar/DST arithmetic. Exact expiry is rejected. The replay retention formula
above is a lower bound, never a fixed cache TTL shorter than assertion validity.

## Proposed REST, MCP and CLI contracts

All paths and names in this section are future contracts. Configuration uses only the
web's generated `/api/v1` client. Register every write with `app.openapi()` and a unique
operationId; regenerate `apps/web/src/api/schema.d.ts` in the implementation PR.
Do not add entries to the frozen interface-parity known-gap list.

All trust-changing configuration writes are browser-session-only. Installing an IdP,
changing domain authority or disabling enforcement changes who can authenticate;
a delegated account key must not gain that authority. Testing and linking require the
specific initiating browser and independent proof of the local identity. Each write
has explicit OpenAPI security **exactly `[{ "session": [] }]`**, with a mapping keyed
by its operationId of `{ "exemption": "browser-session-only", "reason": "..." }`.
Use the concrete reason in the table, a nonempty single line. The shared
`authenticated` security (session OR API key) does not qualify. Runtime must classify
these as `session_only`, reject any Authorization header even with a valid cookie,
require exact same-origin requests and enforce actual fresh proof, not just document it.

Require `X-Expected-Organization-Id` for session writes, current verified team role,
revision checks and transaction-time authority checks using the existing organization
context/locking pattern. Owner-only enforcement/recovery changes and self-only link/
delegation exceptions are explicit, not routed through an admin helper indiscriminately.

All table paths have prefix `/api/v1/team/sso`. `P` means `{providerId}` and `D` means
`{domainId}` (UUIDs), expanded literally in OpenAPI. Reads expose open objects and
open status strings, UTC RFC3339 timestamps and camelCase fields. List uses the
repository cursor conventions; unknown fields/statuses must be tolerated. All writes
use strict input schemas and safe `{error, message?, field?}` failures. Use
`team_management_access_denied`, `organization_context_changed`, `sso_required`,
`sso_configuration_changed`, `sso_domain_unverified`, `sso_test_required`,
`sso_recovery_required` and `sso_provider_not_found` as stable domain codes;
use shared HTTP 400/401/403/404/409/429 conventions. No raw IdP error is returned.

| Method/path | operationId | MCP / CLI or session exemption reason |
|---|---|---|
| GET `/providers` | `listSsoProviders` | `list_sso_providers` / `sso providers list` |
| GET `/policy` | `getSsoPolicy` | `get_sso_policy` / `sso policy` |
| POST `/providers` | `createSsoProvider` | Session: installing an authentication authority requires interactive administrator proof. |
| PATCH `/providers/P` | `updateSsoProvider` | Session: changing credentials/trust requires interactive administrator proof. |
| DELETE `/providers/P` | `deleteSsoProvider` | Session: retiring authentication authority requires interactive administrator proof. |
| POST `/domains` | `createSsoDomainChallenge` | Session: claiming domain authority requires interactive administrator proof. |
| POST `/domains/D/verify` | `verifySsoDomain` | Session: activating domain authority requires interactive administrator proof. |
| DELETE `/domains/D` | `deleteSsoDomain` | Session: releasing domain authority requires interactive administrator proof. |
| POST `/providers/P/test` | `testSsoProvider` | Session: the test binds the current administrator and browser to a configuration revision. |
| POST `/providers/P/activation` | `activateSsoProvider` | Session: enabling/disabling authentication authority requires interactive administrator proof. |
| PUT `/policy` | `setSsoPolicy` | Session: enforcement/admission changes require interactive proof and owner authority for enforcement. |
| POST `/recovery` | `configureSsoRecovery` | Session: enrollment binds a current owner after independent mailbox proof. |
| POST `/recovery/use` | `useSsoRecovery` | Session: recovery grants narrow authority to the freshly mailbox-authenticated enrolled owner. |
| POST `/providers/P/link` | `linkSsoAccount` | Session: explicit self-linking requires independent local proof and a browser-bound IdP ceremony. |
| POST `/delegations` | `bindSsoDelegation` | Session: binding an owned API key or OAuth grant requires fresh interactive SSO proof. |
| DELETE `/delegations/{bindingId}` | `revokeSsoDelegation` | Session: withdrawing the caller's delegated SSO proof requires the owning browser session. |

Provider and policy reads ship on all three surfaces, despite reads being outside
the parity guard. Require owner/admin plus `read`/`full` API key or authorized MCP
OAuth `mcp:tools`, subject to SSO enforcement. Ordinary members get their own required
provider/proof summary through an additive session-only `/api/v1/me` projection,
not administrator inventories. No first-release machine write changes SSO trust.

Create accepts `{protocol, displayName, domainIds, oidc? , saml?}`; OIDC has issuer,
clientId and write-only clientSecret; SAML has explicit entityId, SSO URL, trusted
signing certificates and an optional metadata import URL/document. Server-generated
callback URLs cannot be supplied by the caller. Return `{provider}` with id, protocol,
revision, enabled, safe display fields and validation/test status; never echo secrets,
raw metadata or identities. New providers are disabled. Update/delete require
`expectedRevision`; trust edits invalidate tests, pending attempts and live proofs.
A changed identity tuple requires a replacement provider. Retired deletion is idempotent
for an authorized known tombstone. Activation takes `{expectedRevision, enabled}`.

Domain challenge takes `{domain}` and returns `{domain: {id, name, status}, txtName,
txtValue, expiresAt}` once; repeated creation rotates rather than recovering the value.
Verify/delete require expected generation. Domains are organization-owned and providers
reference their IDs; the provider inventory includes safe domain status/generation.
Test/link returns a bounded authorization URL and attempt ID; completion is via protocol
callback and status is observed in provider inventory or the caller's `/me` projection.
Tests do not provision members, link accounts or elevate a session automatically.

Policy takes `{expectedRevision, requireSso, admission}` with `admission` restricted to
`invitation_only` or `jit`. Recovery enrollment takes `{expectedRevision, ownerUserId}`
and requires that owner's independent proof; use takes `{expectedRevision}` and fresh
mailbox proof. Recovery authority expires with the fresh-administration window and
is single-use for a policy repair mutation; retry requires a new ceremony. These proofs
are distinct from IdP authentication. Delegation binding takes `{credentialKind,
credentialId, expectedPolicyRevision}`, verifies ownership and current team binding,
and returns redacted metadata/expiry; revoke accepts only an owned binding. Existing
key/OAuth inventory responses gain additive binding summaries for the owner's UI.
A key/grant cannot be rebound to a different organization by this operation.

Protocol endpoints are outside `/api/v1`, as existing Better Auth sign-in already is:
`POST /api/auth/sign-in/sso`, OIDC `GET /api/auth/sso/callback/{providerId}`,
SAML `POST /api/auth/sso/saml2/sp/acs/{providerId}` and
`GET /api/auth/sso/saml2/sp/metadata/{providerId}`, plus an inert
`GET /api/auth/sso/saml2/complete` confirmation page and same-origin
`POST /api/auth/sso/saml2/complete` consuming the pending result with the original
browser cookie. The completion handle is opaque and single-use, not a session or
identity token; it cannot complete in a different browser. Confirm the exact retained adapter
paths before implementation; these are the externally documented Hourmere paths.
Keep native plugin registration/update/deletion/domain verification blocked. Sign-in
initiation uses the dedicated auth protocol adapter, same as Google/Microsoft; it
requires exact Origin even without a cookie. This is the existing auth exception,
not a product configuration call bypassing the generated client. GET links open an
inert sign-in page; GET never consumes recovery or creates an authentication attempt.
SAML POST callbacks use protocol correlation/signatures rather than same-origin CSRF
requirements intended for admin JSON. Return only safe redirects under `/app`, the
fixed sign-in error page, or the exact internal SAML completion route
`/api/auth/sso/saml2/complete`. RelayState and request data cannot override callbacks/scopes.

## Self-hosting and local acceptance

Operators configure canonical HTTPS `PUBLIC_URL`, working SMTP for independent email
proof/recovery, credential encryption keys, trusted proxy settings and optional private
IdP destinations. Proposed `SSO_OIDC_ENABLED` and `SSO_SAML_ENABLED` default false until
acceptance; they are rollout switches available to all instances. Turning a protocol
flag off suspends its proofs and new sign-ins but does not remove team enforcement.
Operators must repair it or use recovery; a deployment toggle must not bypass policy.
No configuration described here is available in the current release.

Register the exact OIDC callback above in the IdP (no wildcard), and for SAML register
the exact ACS and the stable entity ID published by the SP metadata endpoint. Derive
all URLs from configured PUBLIC_URL, never request Host. Keep SAML entity ID stable
across certificate rotation. Rotate provider secrets through the browser after testing
a new revision. Back up encrypted configuration and the operator encryption key
separately; key loss prevents login and requires recovery/reconfiguration.

The acceptance task uses an owned local Keycloak container/realm and synthetic users,
its own disposable database/volumes and free ports other than shared development ports.
Pin the Keycloak image/version at that task, record its digest and import a non-secret
realm fixture. Configure distinct OIDC and SAML clients, exact callbacks, verified and
unverified email personas, multiple subjects with the same email, and a disabled user.
A narrowly scoped private-target exception permits that fixture's exact host/port;
DNS TXT is faked deterministically in tests. Never query a real enterprise IdP or SMTP.
Browser processes require an escalated shell or CI. Stop only owned PIDs/containers
and delete only named fixture resources created by the task; retain no tokens/assertions.

Acceptance must exercise OIDC and SAML happy paths, personal magic-link/Google/Microsoft
coexistence using the repo's fakes, explicit link consent, JIT/invitation distinction,
closed signup, same-email takeover attempts, domain expiry, policy activation, break-glass,
key/OAuth expiry, IdP outage, JWKS/certificate rotation and replay across two processes.
Negative cryptographic fixtures supplement Keycloak: a successful demo cannot prove
signature wrapping or replay safety. SAML encrypted assertions must produce a clear
unsupported result. Public booking/manage-link behavior remains unchanged by team SSO;
authenticated reschedule/cancel and team reads require the same SSO policy. Exercise
UTC expiry across DST boundaries without changing scheduling's time-zone semantics.

## Implementation sequence

Every row is approximately one working day; if a release gate needs an upstream fix,
stop that protocol's rollout rather than compressing its security work. Dependencies
refer only to earlier rows. Each endpoint name below refers to the exact inventory
above; “none” means no new REST, MCP or CLI operation. All migrations are future work
with predecessor-data/fresh/no-op tests and newly allocated numbers. Each implementation
PR includes its OpenAPI/parity/client changes, behavioral negatives/source mutations,
translations and user docs for the surfaces it adds.

| Step | Builds; endpoint / MCP / CLI ownership | Dependencies | Flag state | Acceptance checks |
|---|---|---|---|---|
| Upgrade | Coordinated Better Auth family security upgrade and rerun source evaluation; none | Accepted design | Both off | Regression suite; patched advisory versions; pre-session extension feasibility established |
| Data | Provider/domain revisions, identity links, attempts, replay/proof/delegation rows and removal tombstones; none | Upgrade | Both off | Realistic predecessor preservation, fresh/no-op migration, identity/domain uniqueness races, AAD tamper, bounded pools |
| Transport | Extract pinned outbound transport and operator private-target policy; none | Data | Both off | DNS rebinding/mixed answers, socket pinning, timeout/size/redirect negatives, secret redaction |
| Drafts | `listSsoProviders`, `getSsoPolicy`, `createSsoProvider`, `updateSsoProvider`, `deleteSsoProvider`; `list_sso_providers` / `sso providers list`, `get_sso_policy` / `sso policy` | Transport | Both off | Exact session exemptions, bearer+cookie refusal, scope/role/context/revision races, ciphertext-only storage |
| Domains | `createSsoDomainChallenge`, `verifySsoDomain`, `deleteSsoDomain`; no MCP/CLI writes; renewal worker | Drafts | Both off | Cross-team claims, challenge rotation, exact subdomains, outages/expiry, no personal-account capture |
| OIDC verifier | PKCE/state/nonce, strict ID token verification and bounded JWKS cache; none | Domains | Both off | Invalid/missing claims and algorithm, issuer mix-up, replay/concurrency, future iat, rotation/outage |
| OIDC integration | `POST /api/auth/sign-in/sso`, `GET /api/auth/sso/callback/{providerId}`, `testSsoProvider`, `linkSsoAccount`, additive `/api/v1/me` own-attempt/proof summary; no MCP/CLI writes | OIDC verifier | OIDC test-only opt-in; SAML off | Disabled drafts usable only by bound administrator test; strict link intent; signup/invitation/JIT transaction and removal races |
| Browser enforcement | Session proof and native/v1/shared-service checks and enforcement of the existing `/me` own-proof summary; no new write operations | OIDC integration | OIDC test-only opt-in; SAML off | Policy revision/expiry, personal isolation, native/trusted-call bypass negatives, transaction-time removal checks |
| Delegation | `bindSsoDelegation`, `revokeSsoDelegation`; additive owned key/grant summaries; OAuth consent/token/refresh/MCP enforcement, no machine writes | Browser enforcement | OIDC test-only opt-in; SAML off | Old keys denied, rebind own credentials only, offline grants cannot extend proof, expiry/refresh/removal races |
| Recovery | `configureSsoRecovery`, `useSsoRecovery`; owner continuity and mailbox ceremony, no MCP/CLI writes | Delegation | OIDC test-only opt-in; SAML off | Single-use recovery race, expired/non-owner rejection, no regular-data bypass, last recovery owner protected |
| Activation | `setSsoPolicy`, `activateSsoProvider`; durable audit events/outbox adapter, no MCP/CLI writes | Recovery | OIDC operator opt-in; SAML off | Audit persistence; tested exact revision/domain/recovery prerequisites; last-provider guard; require audit service before release |
| Setup UI | Provider/domain/test/activation forms using prior endpoints; no new operations | Activation | OIDC opt-in; SAML off | en/zh-CN admin strings; jsdom revisions, neutral loading/error/403; existing weekly-hours hint intact |
| Member UI | Sign-in selection and explicit self-linking using prior endpoints; no new operations | Setup UI | OIDC opt-in; SAML off | en/zh-CN sign-in; shipped public locales where applicable; jsdom consent, email proof, stale intent, personal-account coexistence |
| Recovery UI | Recovery/enforcement/delegation forms using prior endpoints; no new operations | Member UI | OIDC opt-in; SAML off | Owner-only narrow recovery, reauthentication, delegation expiry, en/zh-CN and jsdom denied/unknown state |
| SAML verifier | XML/signature/time/recipient/destination and durable request/replay validation; none | Recovery UI | OIDC opt-in; SAML off | Duplicate IDs/wrapping/XXE/unsigned assertions; expired/audience/request mismatch, parallel replay; encrypted input rejected |
| SAML integration | `POST /api/auth/sso/saml2/sp/acs/{providerId}`, `GET /api/auth/sso/saml2/sp/metadata/{providerId}`, GET/POST `/api/auth/sso/saml2/complete`; extend existing config/test/link/start operations; no new v1 write | SAML verifier | Both opt-in | Cross-site POST browser correlation, forged RelayState, certificate rotation, no unsolicited login/SLO, identity/admission parity |
| SAML UI | Extend provider form with metadata/certificate controls; no new operations | SAML integration | Both opt-in | jsdom redaction, rotation/revision conflicts, unknown readiness, locales; endpoint implementations already present |
| Keycloak OIDC | Owned local fixture and OIDC browser/delegation/recovery acceptance; no product operations | SAML UI | Both opt-in | Synthetic end-to-end sign-in/coexistence, key rotation/outage and cleanup; browser escalation/CI |
| Keycloak SAML | Local SAML browser acceptance plus cryptographic negative corpus; no product operations | Keycloak OIDC | Both opt-in | ACS/RelayState, replay across processes, signing rotation; logout/deprovision limitation demonstrated |
| Release docs | Publish operator/REST/MCP/CLI guides, backup/recovery drill and limitations; no product operations | Keycloak SAML | Both remain opt-in until acceptance approves defaults | Final required CI green; self-host parity; operator can recover without IdP; no unimplemented settings advertised |

## Out of scope and remaining decisions

No product implementation, migration or dependency change lands with this design.
SCIM, IdP group role mapping, service accounts, IdP-initiated SAML, SAML SLO, encrypted
assertions, automatic domain transfers, wildcard domain claims and global forced SSO
are deferred. IdP deactivation is not immediate local revocation without SCIM; absolute
proof expiry bounds that delay. Private IdP reachability remains operator-controlled.
A successful provider test does not prove all accounts have valid immutable identifiers.

Acceptance must confirm the wrapper's pre-session interception and guarded transport
are feasible on the upgraded plugin. If not, retain Better Auth for local sessions and
replace the affected federation path with a maintained protocol adapter; record that
choice and its negative tests before activating it. Audit service availability is an
external release dependency. Confirm the conservative no-automatic-linking policy,
invitation-only default and expiring delegated proof policy with the project lead;
these are proposed safe defaults, not existing customer behavior.
