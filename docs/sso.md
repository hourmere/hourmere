# Organization SSO: evaluation and implementation design

Status: design and storage only. The plugin evaluation was first run 2026-11-06 against the Better
Auth 1.7.12 family and re-run 2026-11-09, in the Upgrade step, against the installed
1.7.16 family that main pins since the November security upgrade. `@better-auth/sso`
1.7.16 is a development dependency of the auth workspace: no shipped source imports or
registers it, and the production image does not contain it. The first plan step that
imports it from shipped code moves it to `dependencies`. Migration 0074 adds the
configuration storage of the Configuration storage step (see
[Data model](data-model.md#sso-configuration-storage)) and migration 0075 the identity
storage of the Identity storage step (see
[Data model](data-model.md#sso-identity-storage)); no production code reads or writes
either, and no SSO provider, route or feature flag is enabled. SSO will be available to every
instance, including self-hosted ones; there is no license, subscription or hosted-service
requirement.

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

packages/auth/package.json pins better-auth, `@better-auth/sso` and every other family package at exactly 1.7.16, and the root lockfile records the whole tree. The evaluation reads the installed JS, chiefly `packages/auth/node_modules/@better-auth/sso/dist/index.mjs`; line numbers below refer to that file unless another file is named. Lockfile versions of the plugin's dependencies: samlify 2.15.1, jose 6.2.12, @xmldom/xmldom 0.9.12 (0.8.15 nested under xml-crypto and @authenio/xml-encryption), fast-xml-parser 5.12.0, xml-crypto 6.4.0 and tldts 7.4.18; all are MIT-licensed. The plugin is a `devDependencies` entry with the exact 1.7.16 pin, so `npm prune --omit=dev` in the image build leaves the plugin and its SAML and XML stack out of the image. `npm audit` and `npm audit --omit=dev` report no vulnerabilities, and the production tree keeps its 174 packages. The first plan step that imports the plugin from shipped code moves it to `dependencies` and re-runs the production audit.

Against 1.7.12, the 2026-11-06 baseline, the plugin's runtime JS differs only in bundler output: folded constants, added block braces and one local hoisted out of an object literal (the remote JWKS set is still created on every callback). The plugin's changelog has empty entries for 1.7.13 to 1.7.16, and core's `oauth2/verify-id-token.mjs` is byte-identical. Every row below was re-checked against the 1.7.16 source. The 1.7.12 baseline came from an owned spike install (`.sso-evaluation-spike`, deleted after inspection) that resolved jose 6.2.15; the lockfile now resolves 6.2.12, which has the same `iat` behaviour.

Official sources: [SSO docs](https://better-auth.com/docs/plugins/sso), [OIDC](https://better-auth.com/docs/plugins/sso/oidc), [SAML](https://better-auth.com/docs/plugins/sso/saml), [SAML validation](https://better-auth.com/docs/plugins/sso/saml-security), [provisioning](https://better-auth.com/docs/plugins/sso/provisioning), [changelog](https://github.com/better-auth/better-auth/blob/main/packages/sso/CHANGELOG.md), [versioned source](https://github.com/better-auth/better-auth/tree/v1.7.16/packages/sso/src), [core verifier](https://github.com/better-auth/better-auth/blob/v1.7.16/packages/core/src/oauth2/verify-id-token.ts). Live docs advertise 1.7.18 and are not a substitute for installed-version inspection. The source observations below come directly from installed JS, chiefly @better-auth/sso/dist/index.mjs.

### Recommendation

Do not expose stock plugin routes or ship SSO with the 1.7.16 plugin unchanged. Reuse established protocol parsing/crypto and Better Auth's account/session integration; Hourmere owns organization/provider policy, encrypted configuration, exact identity binding, domain lifecycle, enforcement and audit. The 1.7.12 evaluation left open whether the plugin's pre-session hook could carry Hourmere's checks; the Upgrade step answered it at 1.7.16 (see Pre-session hook and plugin paths below). The hook exists, but the plugin offers no seam for a JWKS cache or the guarded transport, leaves OIDC algorithm policy to an after-the-fact header check in Better Auth's account database hook, reaches an OIDC nonce only if Hourmere rewrites the plugin's authorization URL, and cannot stop the SAML ACS from minting a session on the cross-site POST. Hourmere therefore keeps Better Auth for local sessions and replaces the OIDC and SAML federation paths with narrow adapters over the same maintained libraries (jose; samlify with xml-crypto and @xmldom/xmldom), writing no new cryptography or XML signature code. Merely adding a /api/v1 facade over the plugin could not supply these seams. The first SAML release rejects encrypted assertions and missing assertion or response IDs outright. Each protocol stays hard-off in code until its complete path exists and its negative protocol and egress checks have passed (see Rollout gating). An upstream patch for a missing seam (for example [12081](https://github.com/better-auth/better-auth/issues/12081) or [10625](https://github.com/better-auth/better-auth/issues/10625)) brings a plugin path back only after a new evaluation at the patched version.

### Source evidence matrix

| Area | Installed 1.7.16 evidence (`index.mjs` lines) | Hourmere consequence |
|---|---|---|
| OIDC protocol/discovery | Code flow, discovery/manual endpoints; discovery issuer exact match (650–659); PKCE field defaults true but is client-configurable (1886); createAuthorizationURL uses state.codeVerifier only when config.pkce (3737, 4166). Runtime discovery when endpoints are missing (771). Callers may pass `scopes` and `additionalParams` (3720–3748); default scopes include offline_access. | Force S256 PKCE and fixed openid/email/profile scopes; no caller additionalParams overriding protocol controls; omit offline_access for sign-in. Explicit per-provider callbacks. |
| State/nonce | generateState and providerReference bind state to provider/version (3726–3727); callback revalidates provider references (3839) and locks the provider during linking (3986). No nonce occurrence in plugin JS; the authorization request and the verifyIdToken call omit it, and core drops a caller-supplied `nonce` as a reserved parameter (`@better-auth/core` `oauth2/create-authorization-url.mjs` 9–18). | Persist transaction nonce, require matching signed claim before session; block generic callback bypass. |
| ID token | validateOIDCIdToken (580–589) uses core verifyIdToken with JWKS, issuer/audience, azp check for multi-audience or supplied azp. Core requires iss/sub/aud/exp/iat, rejects empty clientId, sets 30-second clock tolerance. ID token optional unless resolveUser configured (3933); UserInfo sub must match token sub (3941). | Require ID token every login; retain iss/aud/azp/exp/sub checks; strict claims; `email_verified` is never mailbox proof. |
| iat/algorithm gaps | Core verifyIdToken accepts algorithms, maxTokenAge and a nonce, but the plugin supplies none (582–586). jose 6.2.12 jwt_claims_set checks numeric iat, but rejects future iat/over-age iat only when maxTokenAge is set. | Explicit algorithm allowlist from trusted provider policy; validate iat future and maximum age. Do not claim plugin validates freshness because it requires claim presence. |
| JWKS | createRemoteJWKSet constructed inside validateOIDCIdToken on each callback (581), guarded remote fetch; no application-level shared cache, no discovered signing-algorithm policy passed. | Cache per provider/issuer/JWKS URL with bounded freshness and controlled unknown-kid refresh, no stale success after key failure; concurrency/rotation tests. |
| SSRF | fetchOIDCEndpoint (544) and the native response helper (563) revalidate endpoints at fetch; redirects are manual, then rejected. Discovery uses the same helper. The DNS lookup result is not connection-pinned and lookup failures return (478–498); trustedOrigins bypasses private-host checks. No exposed custom fetch in options. | Reuse Hourmere outbound guard at actual connection for discovery/token/UserInfo/JWKS/metadata, deadlines and size limits; do not equate CORS/redirect origins to egress trust. |
| SAML validation | samlify SP parseLoginResponse; exactly one plaintext or encrypted assertion (1203–1222); an additional namespace/ID-aware assertion signature check when wantAssertionsSigned is true (1234–1256); audience and bearer recipient binding (1466–1475); response Destination checked only when present (1458–1464); provider references locked and rechecked (2856–3046). | Require signed assertion (response may also sign), strict XML fixture tests for wrapping/duplicate IDs/external entities, fixed ACS/issuer/audience, required Destination, use authenticated subtree only. |
| SAML timestamps | clockSkew defaults 300000 ms; requireTimestamps defaults false and a missing condition only warns (2709–2742). samlify 2.15.1 checks bearer SubjectConfirmationData NotBefore/NotOnOrAfter (`flow.js` 215–250). Nothing bounds IssueInstant. | Require valid bounded NotBefore AND NotOnOrAfter and SubjectConfirmationData expiry; the acceptance deadline and limits are pinned below, and the SAML verifier and SAML timing and replay steps own the signed fixtures. |
| SAML replay | validateInResponseTo atomically consumes the verification value and checks provider/reference (1501–1545); default validation on, IdP-initiated false. Assertion reserveVerificationValue uses the assertion ID, expires at NotOnOrAfter + skew, fallback TTL if absent (2966–2991). A missing extracted assertion ID only warns (2992) unless signed assertions are required, when the signature check refuses it first (1246–1247); the response ID is not checked. | Keep correlation on; require assertion and response IDs and strict expiry, database atomic uniqueness across replicas, reject missing ID and expired request. |
| RelayState/browser binding | Generated generic server state with provider reference (2653–2678); parse skips the state cookie check because cross-site POST drops Lax cookies (2690). Invalid supplied RelayState rejected but absent RelayState can use InResponseTo. The ACS sets the session cookie in its response to the cross-site POST (3122). | Require issued opaque RelayState and browser-bound pending login completion; do not treat request correlation alone as browser binding. A same-site completion hop with original browser nonce is a defensible design. |
| Encryption | createSP wires encPrivateKey and encrypted-assertion settings (1694–1729); binding content decrypted for validation (2822–2826). Registration config/private keys serialized as JSON text. | Supported in dependency, but Hourmere rejects encrypted assertions until a fixture-tested algorithm allowlist and signed-decrypted-node validation exist; envelope-encrypt client secrets/private keys at rest, decrypt only transiently. Never set trustEmailVerified globally. |
| SAML metadata/rotation | Imported XML or explicit entity/cert (1771–1799); generated SP metadata; cert arrays; custom SP metadata cannot weaken assertion-signing policy. Imported XML overrides manual cert, no automatic refresh. | Guard optional metadata download; pin entity ID and validated keys, explicit reviewed refresh/version change, overlap rotation tests incl no KeyInfo. |
| DNS | Plugin challenge checks every comma-separated domain with DNS TXT (2583–2648); one domainVerified boolean; already-verified returns 409; no periodic re-verification. Provider domain changes reset boolean. DefaultSSO can count verified without DNS. | Own exact-domain records and re-verification/suspension; no wildcard/subdomain expansion or code-config trust bypass. |
| Linking | Resolver receives verified OIDC token claims/provider SAML attributes and exact accountKey issuer/sub-or-NameID; native transactional support enforced (1600–1649); exact account binding only with resolveUser. Default domain trust can implicitly link verified local email and includes subdomains (86–115, 3977). | Exact org/provider/issuer/subject binding in Hourmere's own transaction, no implicit email claim-based takeover. Require current existing-account proof for first linking. |
| Provisioning | Default org assignment after authentication (283), member role by default (263–268); provisionUser/getRole hooks; the plugin's after hook assigns by verified domain after social callbacks too (4564); pending invitation suppresses autojoin. disableImplicitSignUp can be overridden by OIDC requestSignUp (4025). | No stock organization provisioning; transactional JIT/invitation policy in Hourmere's admission step, re-checked every login; never use disableImplicitSignUp alone as invitation-only protection. |

The inspected samlify 2.15.1 verifySignature uses absolute XPaths, rejects wrapping descendants, requires message KeyInfo cert to match pinned metadata, checks signed references and signed root/ID/namespace. This supports reuse but is not proof all malicious XML cases are safe; test actual locked versions. SAML secret storage and browser-binding limitations cannot be repaired by documentation alone.

### Pre-session hook and plugin paths

The Upgrade step had to establish whether a pre-session validation hook can carry
Hourmere's checks or a replacement adapter is needed. Both answers hold at 1.7.16: the
hook exists, and it is not enough.

**The hook.** `resolveUser` (`SSOOptions`, `dist/index-BvKzNnKP.d.mts` 337) is the
plugin's pre-session hook. On every OIDC and SAML sign-in it runs inside
`runWithTransaction`, after the provider row lock and the provider-reference recheck and
before `handleOAuthUserInfo` writes the user, account and session (OIDC 3985–4044, SAML
3040–3089; the session is created at `better-auth/dist/oauth2/link-account.mjs` 358). A
`{action: "reject"}` decision throws `FORBIDDEN` (OIDC 4001–4004, SAML 3055–3058) and rolls
the transaction back; a thrown error or an invalid decision becomes
`SSO_USER_RESOLUTION_FAILED` (1600–1612). With a
resolver the plugin also requires an ID token (3933) and exact account binding, defers
non-database writes, and refuses adapters without native transactions, secondary-storage
sessions without a database fallback and missing async context (1614–1649). The
resolver receives the verified ID-token claims (OIDC) or the IdP entity ID, NameID and
assertion attributes (SAML), the account key and the provider reference. Through
`getCurrentAuthEndpointContext()` (`@better-auth/core/context`) it can also read the raw
request, but nothing the plugin has verified beyond those inputs.

**What it cannot carry.** Each row is a design requirement that must hold before a session
exists. "Re-parse" means reading the raw `SAMLResponse` from the endpoint context again,
outside the subtree the plugin verified; Hourmere does not adopt that, because a second
parser over unauthenticated XML is the signature-wrapping risk the design rules out.

| Requirement | Plugin behaviour at 1.7.16 | Enforceable before the session? |
|---|---|---|
| OIDC nonce bound to the attempt | Never generated or sent; core drops `nonce` from `additionalParams` as reserved (`create-authorization-url.mjs` 9–18, 54–56); `validateOIDCIdToken` passes no nonce (580–589) | Not by the resolver alone: it sees the claim, but the nonce would first have to be added to the plugin's `/sign-in/sso` URL by an after hook. Not adopted: Hourmere would be rewriting the plugin's protocol output |
| OIDC algorithm allowlist (RS256) | No `algorithms` passed (582–586) | Not in the resolver: it gets the payload, not the header, and the token is not in the request. Better Auth's account database hooks (`databaseHooks.account.create.before` / `update.before`) do receive the raw ID token in the sign-in, before `createSession`, when the account is created or linked and on every later sign-in while `updateAccountOnSignIn` is not `false` (`link-account.mjs` 191–197, 242–259, 358). Such a hook could decode the protected header and throw for an algorithm outside the allowlist, so no session is created. It cannot narrow what the plugin's verifier already accepted, and it adds no nonce, JWKS cache or transport; it is a second parse of the token outside the verifier. Not adopted |
| OIDC `iat` age and future `iat`, `auth_time` | Not checked: no `maxTokenAge` | Yes: the claims are passed |
| Bounded JWKS cache | `createRemoteJWKSet` on every callback (581) | No plugin seam; a process-wide fetch dispatcher would change every outbound request |
| Pinned outbound transport | Global fetch after one unpinned DNS lookup (478–571); no fetch option ([10625](https://github.com/better-auth/better-auth/issues/10625)) | No plugin seam; same as the JWKS cache |
| No session on the SAML cross-site POST | The ACS mints the session and sets its cookie in that response (3059, 3122) | No: an allow mints the session in the POST response; after a reject the plugin does no account or session work, so the completion hop would be Hourmere code anyway |
| SAML assertion ID required | A missing assertion ID only warns (2992) | Yes, by configuration: with `wantAssertionsSigned: true` the signature check refuses an assertion without an ID (1246–1247) |
| SAML response ID required | Not checked | Only by re-parse |
| SAML `IssueInstant` + `maximumSamlAssertionLifetime` deadline | Conditions (2709–2742) and bearer SubjectConfirmationData (samlify) only | Only by re-parse: `IssueInstant` is not in the resolver input |
| SAML response Destination required | Checked only when present (1458–1464) | Only by re-parse |
| Encrypted SAML assertions refused with a clear result | Decrypted when a key is configured (2822–2826) | Partly, by configuration: without a decryption key the response fails as invalid (2884–2892, 2916–2931), and `saml.algorithms` with empty encryption allow-lists refuses it (1126–1148); neither gives a clear unsupported result |

The decision rests on the rows with no seam at all (JWKS cache, pinned transport, the
session minted in the SAML POST). The OIDC adapter replaces the whole
callback anyway, and the SAML adapter replaces the ACS, so the partial answers above are
not used.

**Retained and replaced paths.** Hourmere keeps Better Auth for local sessions and
accounts and does not register the `sso()` plugin; the Off tests fail if any shipped
source imports `@better-auth/sso`.

- Replaced by Hourmere-owned adapters at the documented auth-protocol paths: OIDC sign-in
  initiation and callback (plugin `/sign-in/sso`, `/sso/callback/:providerId`,
  `/sso/callback`), and the SAML ACS and SP metadata (plugin
  `/sso/saml2/sp/acs/:providerId`, `/sso/saml2/sp/metadata`). The OIDC verifier step
  builds the OIDC adapter on jose, which the plugin uses too: `jwtVerify` takes
  `algorithms`, `maxTokenAge`, `requiredClaims` and `clockTolerance`, and
  `createRemoteJWKSet` takes `cacheMaxAge`, `cooldownDuration`, `timeoutDuration` and a
  `[customFetch]` hook for Hourmere's pinned transport (`jose/dist/webapi/jwks/remote.js`
  39–80). Nonce and state live in Hourmere's pending attempts. The SAML verifier step builds
  the SAML adapter on samlify 2.15.1 with xml-crypto and @xmldom/xmldom. samlify's response
  flow (`samlify/build/src/flow.js` 703–825) verifies the signature, issuer, audience,
  recipient and a present Destination, that the signed and outer InResponseTo agree, and
  bearer SubjectConfirmationData; its optional replay cache (435–467) requires an assertion
  ID. The plugin's hardened single-assertion (1203–1222) and assertion-signature (1234–1256)
  checks are not exported, so that step reimplements them on samlify with the plugin source
  as the reference; exported pure helpers
  (`validateDiscoveryDocument`, `computeDiscoveryUrl`, `deriveSAMLServiceProviderPolicy`)
  may be reused. Neither adapter writes cryptography or XML signature code.
- Retained: Better Auth's session and account machinery (`internalAdapter.createSession`,
  as `handleOAuthUserInfo` uses it) and Hourmere's existing session database hooks.
- Not exposed and not replaced: provider management (`/sso/register`, `/sso/providers`,
  `/sso/get-provider`, `/sso/update-provider`, `/sso/delete-provider`), the plugin's domain
  verification (`/sso/request-domain-verification`, `/sso/verify-domain`) and single
  logout (`/sso/saml2/sp/slo/:providerId`, `/sso/saml2/logout/:providerId`). Hourmere's
  own operations, domain lifecycle and local revocation cover them.

### Changelog and security

Changelog 1.7.12 / [PR 11935](https://github.com/better-auth/better-auth/pull/11935) requires exp/iat and nonempty clientId. 1.7.8 / [11438](https://github.com/better-auth/better-auth/pull/11438) rejects discovery issuer mismatch; [11687](https://github.com/better-auth/better-auth/pull/11687) restores certificate rotation; 1.7.3 restores providerId/accountId keys and rejects ambiguous keys after the 1.7.0 issuer-schema change. The SSO changelog has no entries for 1.7.13 to 1.7.16.

Read the upstream GitHub advisory API again on 2026-11-09: 49 published advisories, the newest from 2026-11-03. None lists an affected range that contains the installed 1.7.16 of any Better Auth family package in the lockfile (better-auth, core, the adapters, telemetry, api-key, cimd, mcp, oauth-provider and sso). SSO-specific advisories and additional core advisories relevant to enrollment:

| Advisory | Risk | Patch | 1.7.16 status |
|---|---|---|---|
| [GHSA-mx9r-x6ww-qjw9](https://github.com/better-auth/better-auth/security/advisories/GHSA-mx9r-x6ww-qjw9) | personal-provider identity crossover | 1.7.3 | outside affected range |
| [GHSA-8c5h-wx78-2cfg](https://github.com/better-auth/better-auth/security/advisories/GHSA-8c5h-wx78-2cfg) | unproven domain claims / account takeover | 1.6.27 or 1.7.0-rc.5 | outside affected range |
| [GHSA-prpr-5gj3-qqhg](https://github.com/better-auth/better-auth/security/advisories/GHSA-prpr-5gj3-qqhg) | four domain/provider deletion/SAML/SLO takeover flaws | 1.6.21 or 1.7.0-beta.10 | outside affected range |
| [CVE-2026-53515 / GHSA-gv74-j8m3-fg5f](https://github.com/better-auth/better-auth/security/advisories/GHSA-gv74-j8m3-fg5f) | ordinary members register org provider | 1.6.11 or 1.7.0-beta.4 | outside affected range |
| [CVE-2026-53513 / GHSA-5rr4-8452-hf4v](https://github.com/better-auth/better-auth/security/advisories/GHSA-5rr4-8452-hf4v) | SSRF registration | 1.6.11 | outside affected range |
| [CVE-2026-53514 / GHSA-fmh4-wcc4-5jm3](https://github.com/better-auth/better-auth/security/advisories/GHSA-fmh4-wcc4-5jm3) | high: invitation acceptance by an unverified account | 1.7.16 | patched: affected range `>= 1.6.14, < 1.7.16` ends below it |
| [GHSA-hwq2-v29r-p69r](https://github.com/better-auth/better-auth/security/advisories/GHSA-hwq2-v29r-p69r) | email-change links act on a later owner of the old address | 1.7.16 | patched: affected range `>= 1.4.0, < 1.7.16` ends below it |

The upstream API reports no CVE ID for the first three rows or for GHSA-hwq2; do not invent them. No listed affected range contains 1.7.16, and 1.7.16 is the highest patch on the stable 1.7 line; 13 of the 49 advisories also list 1.8.0-beta.5, the patch for the 1.8 beta line. This is a dated inventory, not a security certification.

**Newer core issues matter despite SSO-specific patches:** November 3 advisories [GHSA-9hm7-xhfp-cx58](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58) (unverified OAuth email), [GHSA-fvxx-76fc-893x](https://github.com/better-auth/better-auth/security/advisories/GHSA-fvxx-76fc-893x) (revoked sessions cached/secondary storage) and [GHSA-c85h-5mrr-mgx4](https://github.com/better-auth/better-auth/security/advisories/GHSA-c85h-5mrr-mgx4) (padded owner invitation role) list stable patch 1.7.16, and their ranges include 1.7.12 but not the installed 1.7.16. This design evaluation does not establish Hourmere's exploitability; the family upgrade to 1.7.16 records that assessment in its release notes.

### Open upstream bugs / limitations (queried 2026-11-09, all still open)

- [12081](https://github.com/better-auth/better-auth/issues/12081): no OIDC nonce; confirmed installed source.
- [10625](https://github.com/better-auth/better-auth/issues/10625): no custom federation fetch seam; confirmed options/source limitation. Its historical redirect implementation details differ from inspected artifact.
- [10830](https://github.com/better-auth/better-auth/issues/10830): discovery DNS check omission remains open but **not reproduced in installed 1.7.16 source**, which calls shared guarded fetch; retain regression test, do not label current artifact vulnerable on this report alone.
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
provider's external-subject bindings. Deletion retires an ID permanently: deleting a
provider, domain claim or identity link keeps its row as retired, and every proof,
delegation, link and inventory check treats a retired provider, claim or link exactly as a
deleted one.

Domain claims are separate from users and providers. Normalize an exact DNS name
using IDNA ASCII and lowercase; reject public suffixes, IPs and wildcard claims.
Owning a parent domain does not claim its subdomains. Store one active claim per
exact domain per instance, with organization identity and verification generation.
Pending unverified challenges never reserve a domain or block another team. An
unexpired verified claim cannot be evicted. Expired claims remain suspended and
exclusive until explicit retirement: an instance operator verifies a fresh TXT
challenge for the requesting team and runs the domain-retirement maintenance command,
which records old/new team IDs and proof timestamps in one audited transaction,
notifies the old team's owners, and retires only the expired generation under the
domain lock. Operator maintenance commands run in the server container against the
instance database, like the migration command; they are not HTTP, MCP or product CLI
operations and are outside the interface-parity inventory. The requesting team must then
complete a new ordinary challenge; retirement does not transfer trust, identities or
membership. The command, its runbook and race tests ship in Domain lifecycle. This documented
support path also covers abandoned teams; no cooperation from the old team is needed.
The owning team never needs it for its own claim. A frozen or unknown-state claim that
has not expired recovers through a positive recheck or a verify of its current
generation, which keeps dependent proofs and leases; only an expired claim needs an
ordinary new challenge and verification by that team.
Automatic domain transfers remain deferred. Ambiguous multi-tenant domains require
invitation-only access.

Return a random DNS TXT challenge at `_hourmere-sso.<domain>`, bound to instance,
organization, domain and generation. Compare the exact value through the server's
trusted DNS resolver; never accept an administrator's uploaded lookup result.
Store a digest, not the raw challenge; a lost response requires rotation. Challenge
creation invalidates the previous generation. Verification is an explicit POST,
not a side effect of GET. Persist verification time, next-check time and expiry.
Recheck on a schedule and before enabling JIT or enforcement; only an unexpired
positive proof grants domain authority. DNS errors mean unknown, not verified or
missing configuration. A failed or unknown latest recheck freezes new links, JIT,
provider activation and enabling enforcement until a positive recheck, even before
expiry; expiry suspends new SSO proofs and team access under enforcement.
It never silently disables the organization's enforcement policy. Browser proofs and
delegations record the domain claim and claim generation they relied on and check on every
use that the claim is not retired, is still at that generation and is unexpired, so deleting
(which retires the claim) or expiring the domain ends them; a delegation also needs a rebind
after a lapse, as specified below. Recovery remains usable.

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
`unlinkSsoAccount` removes only the caller's exact link after independent local proof
(see Fresh proof). `removeSsoIdentityLink` lets an owner or admin with fresh
administration proof retire another person's link after verifying that person's
recovery request out of band. An admin may retire only member and admin links; an
owner's link can be retired only by another owner, and nobody retires their own link
this way. Both require the link's expected generation, revoke that person's browser
proofs and delegations for the link atomically, and audit/notify the affected person;
other members' proofs and delegations are untouched. Neither reassigns
a subject, creates a replacement binding or grants membership. The member next signs
in through an existing local method and performs `linkSsoAccount` with the new IdP
subject; enforcement allows only this narrow enrollment path until it succeeds.
Conflicts with another user's binding require its explicit retirement, never email
matching or a direct database edit. Unlinking or link retirement never changes
ownership or recovery ownership, which relies on mailbox proof, not on an SSO link.
Refuse unlink when the caller has no independently proven remaining sign-in method.

Hourmere never treats an IdP's email statement as mailbox proof. An OIDC
`email_verified` claim, whatever its value, and a SAML email attribute are recorded
only as IdP assertions; UserInfo is used only when its `sub` matches the validated
ID token, and domain ownership never implies verification. Every first
enrollment of an IdP subject, OIDC or SAML, proves the mailbox through Hourmere,
including when `email_verified` is `true`. A linked identity whose asserted email
differs from the address last proven for that link must prove the new mailbox before
its sign-in completes. That pending outcome is identical whether or not the new address
belongs to another Hourmere account: nothing looks the address up before the proof, and
a collision is reported only after it, to the mailbox holder, without recording the
address. Never coerce the claim to true to satisfy the current user-create hook.

The address last proven for a link is stored in plain text, normalized and at most 320
characters, in `sso_identity_links.proven_email` with its proof time, like the account
address in `auth.user`: one copy per link, in the team's own rows of the instance database
and so in that database's backups. It is organization-local personal data. The server's
SSO services read it to compare it with the address the IdP asserts; anyone with direct
access to the instance database or its backups can read it too. No REST, MCP or CLI
response returns it (`/me` and the provider inventory list opaque link IDs only), and no
audit detail includes it. The database driver's detail for a refused row repeats the row,
the address included, so the server's error log for failed requests omits the diagnostic
of any error about an SSO storage table and keeps only its SQLSTATE and the table and
constraint names; PostgreSQL's own server log can still record a refused row, as for any
table. Only that request error path uses the recogniser today, because nothing writes these
tables yet; the first step that writes them through Better Auth or a background job routes
that logger's errors through it as well. On a live link it is the address last proven: a later mailbox proof replaces it,
and nothing else changes it. A frozen link, whose provider is disabled or retired, keeps
it unchanged, because no sign-in through that provider can prove another address. A
retired link is immutable and keeps the address it had when it was retired. Leaving or
removal from the team deletes the person's proofs and delegation bindings but not the
link, which has no membership reference, so a former member's link, live or retired, keeps
the address as well. Only deleting the link row deletes the address: deleting the account
deletes that account's links in every team, and deleting the team deletes all of the
team's links with its providers. Retiring a link or its provider does not. The design
defines no retention sweep for links, so until a later step adds one, a retired or frozen
link and a former member's link keep the address until the account or the team is deleted.
The attempt that proves the address keeps its own plain-text copy in
`sso_attempts.mailbox`, fixed once chosen, until the attempt row is deleted; expiry and
consumption leave the row in place. An attempt made in a signed-in session is deleted with
that session, by logout or the account's deletion. A sign-in attempt has no account or
session reference, so neither the account's deletion nor logout removes it; today only the
team's deletion does. The Mailbox proof step, the first whose code writes an attempt's
mailbox and its token, must add the bounded cleanup that deletes expired and consumed
attempts with their mailbox tokens, sign-in attempts included.

An existing magic-link/Google/Microsoft account with the same email is **not**
automatically linked to a newly configured enterprise IdP, even on a verified domain.
The person first authenticates through an existing method, then explicitly starts a
session-bound link ceremony and proves the IdP subject. Require fresh independent
local proof (a Hourmere mailbox proof, see Fresh proof); an SSO session from that same
provider cannot approve its own first link. Freeze both identities and the session in
the pending attempt; compare again in the completion transaction. Reject email
mismatch, provider change, logout, stale session, conflicting links and concurrent
attempts with different users.
Do not enable the disabled general `/api/auth/link-social` route to implement this.

An unlinked IdP subject never creates a second user or an automatic link. Whether or
not its email matches an existing account, and whatever `email_verified` says, the
callback stores a frozen pending result and returns one generic outcome: “Complete
mailbox verification; if you already have an account, sign in using your existing
method to link it.” Status, response shape, timing (mail is queued, never sent inline)
and the emailed message are identical in every case. A team administrator who creates
an IdP subject for someone else's address therefore learns nothing about whether a
Hourmere account exists; only the holder of that mailbox sees the next step. After the
mailbox proof is consumed, an existing account must complete that independent
sign-in/link ceremony; only an eligible new account can proceed through the separate
admission transaction.

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
The tombstone store is the shared `scim_membership_blocks` table of the
[SCIM identity storage](scim.md), keyed by organization and normalized mailbox with the
authority and kind of the decision; SSO adds no separate tombstone store. A JIT check
keyed by IdP subject rather than mailbox needs an additional column there, owned by the
SSO step that needs it. When enforcement ships, the privacy page
(`apps/site/src/pages/privacy.astro`, retention section) must gain a sentence about
team-local admission records that outlive the account.
A new current invitation can explicitly reinstate access; SCIM suspension (planned)
requires SCIM/admin reactivation as well. SCIM is not implemented here. Later SCIM
must share these locks, tombstones and revocation services; it must not delete the
person's personal account or other memberships. Without SCIM or logout delivery,
disabling a person at the IdP takes effect on the next required authentication,
not instantly. Local removal takes effect on the next authorization check.

## Enforcement, recovery and delegated clients

`requireSso` is an organization access rule, not an instance-wide replacement for
magic links. Every team-scoped read/write checks current membership and a live
provider-bound proof (current trust generation, link generation, a current domain claim
and deadline), except the narrowly listed recovery operations below. A session
authenticated by Google for a personal space does not satisfy team SSO; switching active
space does not manufacture proof.
Initial enrollment has a separate narrow exception: the caller's own `/api/v1/me`
required-provider/attempt summary, auth initiation, mailbox proof, `linkSsoAccount`,
`unlinkSsoAccount`, `acceptSsoRecoveryEnrollment` and `revokeSsoDelegation` accept an
independently proven local session plus current membership or eligible invitation,
without an existing SSO proof; each still needs its own proof (mailbox where Fresh proof
says so). They only enroll, confirm or withdraw the caller's own authority and expose no
team data or administrator configuration.
This allows an unlinked member to obtain the proof enforcement requires; successful
linking still grants no team access until the SSO/admission checks pass.
Check both `/api/v1` and native Better Auth team routes and shared services; middleware
alone does not protect trusted calls, transactions or queued operations. A stored
`requireSso` policy is enforced whatever the rollout constants or settings say (see
Rollout gating); no deployment toggle bypasses it.

Enabling enforcement requires a verified domain, an enabled tested provider of a protocol
that is currently on, a successful owner SSO test against the exact current revision, and
at least one usable recovery owner: a current owner with accepted recovery status. A
pending nomination does not count. Only an owner can change enforcement/recovery
or retire the last usable provider while enforcement is active; admins can prepare
replacements. Policy, provider, recovery and membership changes serialize under the
organization lock, and already-running writes recheck authority in their committing
transaction. Two counters keep that serialization separate from proof validity:

- `policyRevision` is the optimistic-concurrency revision of the team's SSO policy and
  recovery state. `setSsoPolicy`, `configureSsoRecovery`, `acceptSsoRecoveryEnrollment`
  and `useSsoRecovery` take it as `expectedRevision`; no proof or delegation stores or
  checks it. Providers have their own `revision` and domains their own generation.
- `trustGeneration` is stored in every browser proof and delegation and checked on every
  use. It increments only when enforcement is turned off, a team provider's trust
  configuration (secret, certificates, endpoints, algorithms) changes, or a provider is
  disabled or deleted. Turning enforcement on does not increment it: proofs and bindings
  from an unchanged provider already meet what enforcement requires.

Membership changes (invitations, JIT admissions, other members' departures, role
changes), admission-mode changes, recovery-owner changes and successful domain renewals
never change `trustGeneration`, so they never invalidate another member's proof or
30-day delegation lease. A member's own removal, unlink or link retirement ends only that
member's proofs and delegations, through the membership check and the link generation.

### Recovery

A team may have any number of recovery owners: current owners who accepted a
nomination (see the recovery contract below). Enforcement requires at least one.
Acceptance adds a recovery owner and never replaces another. Recovery status is a stored
record tied to the owner's membership, not a check made only at use: leaving the team,
removal or demotion deletes the record in the same transaction as the membership or
role change, with an audit event. Re-joining or re-promotion does not restore it; a new
nomination and acceptance are required. While enforcement is active, the last recovery
owner cannot leave, be removed or be demoted until another has accepted
(`sso_recovery_required`). On a team without enforcement the only recovery owner may be
demoted; enabling enforcement is then refused with `sso_recovery_required` until a new
recovery owner accepts. There is no separate withdrawal operation in the first version.

After a fresh mailbox proof (see Fresh proof), an explicit recovery ceremony issues only recovery
authority: inspect configuration, repair/test a provider and turn off enforcement. It
does not grant bookings, member exports or MCP access without SSO. Record every recovery
start/use in the audit journal and notify the team's owners through the existing
notification jobs; logs never include the email capability. Recovery authority bypasses
only the SSO-proof requirement and satisfies fresh administration (never owner, session,
Origin or expected-team checks) for `listSsoProviders`, `getSsoPolicy`,
`updateSsoProvider`, `createSsoProvider`, `testSsoProvider`, `activateSsoProvider`
and `setSsoPolicy` with `requireSso: false`. `useSsoRecovery` itself accepts the
independent owner mailbox proof without SSO, and only a usable recovery owner can use it. It
cannot enable JIT, alter membership, bind delegations or change recovery owners. Each
repair write consumes its recovery authority; a subsequent repair/test/activation
requires another mailbox ceremony, so updating, testing and re-activating a broken
provider takes three ceremonies. A test callback can finish only its already-bound test
intent, and grants no wider access. Read-only inspection does not consume authority but
observes its expiry.

If every recovery owner's mailbox is lost, an instance operator runs the offline
recovery maintenance command against that instance (maintenance commands run as
described under domain retirement). It only turns the named team's enforcement off,
which increments `trustGeneration`, records a `system` audit event and notifies the
team's owners. It ships with its runbook in the Operator recovery step, before any
operator setting can enable a protocol. No global public bypass secret.

### Delegated clients

API keys and MCP OAuth grants are not exempt. Without enforcement they retain existing
scope rules. While enforcement is on, an unbound key or grant has no SSO proof and
cannot act in that team. A person can bind/rebind an owned key or OAuth grant to the
team after an SSO step-up (see Fresh proof). Binding is allowed before enforcement is
turned on, so automation can be prepared, and survives turning it on. The record stores
provider, subject binding, `trustGeneration`, the domain claim it relied on and an
absolute proof expiry of binding
time plus `ssoDelegationLifetime` (30 days), capped by credential expiry and any validated
IdP session deadline. This is a separate delegated authorization lease, not an
extension of the browser's 8-hour proof or session. It allows unattended CLI/MCP work
without an 8-hour browser rebind; the tradeoff is up to 30 days before IdP-only
revocation is detected without SCIM. Check current domain verification on every use:
successful scheduled renewal preserves the lease, but lapse invalidates it permanently
and requires rebind. A member's own removal, unlink or link retirement, a
`trustGeneration` change and domain lapse or deletion end delegations; logout and
browser-proof expiry do not, and turning the protocol's setting off suspends them.
MCP access/refresh tokens cannot extend it. Reauthorize through the browser after
expiry; a machine client gets stable `sso_required`, never an interactive redirect. Personal/other-team access remains
subject to its own policy. No service-account exemption ships in the first version.
A `full` key still cannot configure the IdP or approve its own SSO binding.

### Fresh proof

Every SSO write except `revokeSsoDelegation` requires proof that is fresh for that exact
request; the HTTP retry contract is under Proposed REST, MCP and CLI contracts. The
proof methods are `mailbox` (a Hourmere mailbox proof through the Mailbox proof pair)
and `sso` (an SSO step-up). The methods a write requires:

- **Fresh administration** (provider, domain, test, activation, policy, recovery
  nomination and identity-link removal writes):
  - On a team without active enforcement, including a team with no provider yet:
    `mailbox`. Before enforcement no SSO authority exists for the team, and the person's
    mailbox is the authority that already signs them in. This bootstrap rule lets Drafts
    and Domains run as soon as the Fresh proof step exists, before any SSO path.
  - On a team with active enforcement: `sso` through an enabled team provider where the
    caller has a link. If the IdP cannot prove a fresh authentication event, the
    attempt also requires `mailbox`; mailbox proof never replaces SSO there. An owner
    or admin without a link first links through the enrollment exception above.
    Recovery authority replaces this proof only for the recovery operations listed
    above.
- **Independent local proof** (`linkSsoAccount`, `unlinkSsoAccount`,
  `acceptSsoRecoveryEnrollment`, `useSsoRecovery`): always `mailbox`, so first linking,
  unlinking and recovery never depend on a working or already-linked IdP.
- **Delegation binding** (`bindSsoDelegation`): always `sso` through the provider whose
  link the binding records, with the same mailbox fallback; mailbox alone never creates
  a delegated SSO lease.

An SSO step-up measures a verified authentication event, not session creation or
ID-token `iat`. OIDC step-up sends `prompt=login` and `max_age=0` and requires a signed
numeric `auth_time` no earlier than attempt creation minus `oidcClockSkew`, no later
than now plus `oidcClockSkew`, and at most `freshAdministrationProof` before the
callback. SAML step-up sends `ForceAuthn="true"` and requires a signed AuthnStatement `AuthnInstant`
within the same bounds, using `clockSkew`. A missing or out-of-window value is the case
where the IdP cannot prove freshness. The result must come from the attempt's own user
and that user's existing link at that provider; it is recorded on the pending attempt
and creates no session, browser proof or link. It expires at the earlier of attempt
expiry and the authentication instant plus `freshAdministrationProof`. Silent IdP SSO,
rolling sessions and refresh tokens never renew freshness.

### Browser proof

Browser proof is separate from the ordinary Better Auth session: rolling session refresh
cannot extend it. Its deadline is the earliest of the absolute SSO lifetime, session
expiry, domain proof expiry and any validated earlier IdP session deadline. ID token
expiry governs only callback acceptance; no refresh token is requested or kept (see
OIDC). Logout ends that
session's proof. A member's own removal, unlink or link retirement ends that member's
proofs. A `trustGeneration` change ends every proof of the team. Domain expiry or
deletion ends the proofs that recorded that claim, through the per-use claim check. Turning a protocol's setting off suspends that protocol's proofs (see
Rollout gating). Nothing else ends a proof; in particular other members' membership
changes do not. A server-side generation check avoids
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
beyond skew and tokens older than the transaction acceptance window. When present,
`auth_time` must be a signed number not later than now plus skew; only step-up relies
on it (see Fresh proof). Neither decoding
a JWT nor successful UserInfo retrieval substitutes for this validation.
OIDC uses `oidcClockSkew` (30 seconds), matching the evaluated core verifier's
hard-coded tolerance. Apply the same 30 seconds to Hourmere-owned `iat`/`nbf` checks
and any replacement adapter; do not add two tolerances. `clockSkew` (60 seconds)
is SAML-only and does not widen core OIDC verification.

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
bounds; require finite Conditions NotBefore and NotOnOrAfter, bearer
SubjectConfirmationData NotOnOrAfter and assertion IssueInstant. Validate NotBefore
and reject future IssueInstant beyond `clockSkew`. Define the acceptance deadline:

`acceptanceDeadline = min(SubjectConfirmationData.NotOnOrAfter, Conditions.NotOnOrAfter, IssueInstant + maximumSamlAssertionLifetime)`

Accept only while `now < acceptanceDeadline + clockSkew`; recheck at browser
completion as well as ACS validation. Do not reject an assertion solely because its
Conditions or bearer validity window exceeds `maximumSamlAssertionLifetime`. The
600-second limit caps how long Hourmere accepts an assertion after IssueInstant,
not the validity interval an IdP may issue. Microsoft documents [Entra SAML
Conditions of 70 minutes and a bearer-expiry example of five minutes](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol#conditions),
and [AD FS defaults TokenLifetime to 60 minutes](https://learn.microsoft.com/en-us/powershell/module/adfs/set-adfsrelyingpartytrust#-tokenlifetime).
These assertions remain interoperable when presented before the acceptance deadline.
Require assertion and response IDs. Match both response and subject InResponseTo to the outstanding request and provider.

Persist request ID, browser-binding digest and an opaque RelayState handle before
redirect. RelayState carries no arbitrary callback URL or identity; POST callback
correlation must work without relying on a Lax cookie arriving on a cross-site POST.
After signature/correlation validation, persist a short-lived pending result and
redirect to a same-origin completion page. Only the original browser-binding cookie
can complete it; no session/proof is minted on the cross-site POST. A missing cookie
or RelayState fails closed, including when InResponseTo is otherwise valid.
Consume request and assertion/response IDs atomically in a shared database replay
cache before creating a proof/session. Keep replay tombstones until at least
`max(acceptanceDeadline + clockSkew, requestExpiresAt)`. Never shorten retention
below the accepted deadline or outstanding request window. Parallel callbacks must
yield one success. Encrypted assertions are deferred: reject them explicitly until decryption
and signed-decrypted-node validation are implemented and tested together. Encryption
never replaces signatures.

### Fetching, credentials and audit

The outbound URL policy and pinned-socket transport that webhooks use now live in the
shared `packages/outbound` module, and the SSO transport profile
(`packages/outbound/src/sso.ts`) is built on it; URL string validation followed by
ordinary `fetch` is insufficient. Discovery, token, UserInfo, JWKS and metadata requests,
including refreshes, use only this profile. By default it requires HTTPS to a public DNS
name on the default port, and every DNS answer must be public: it rejects IP literals,
special-use names and other ports that the operator allowlist below does not list,
userinfo, fragments, private and reserved addresses, IPv4-mapped answers and mixed DNS
answers. It resolves the host again on every request and pins the validated address to the
socket, while TLS still verifies the original hostname through SNI and the certificate. It
rejects every redirect without contacting its location, so a provider that moves a
document is reconfigured, not followed. It bounds response size, decompression, connection
and body time and concurrency with the transport limits below. Bodies may be identity or
gzip only; Brotli is refused because its decoder may reserve a window of up to 16 MiB
before a decoded byte can be counted. The bytes on the wire and the decoded bytes each
count against the size limit. One absolute deadline ends the whole exchange, so a body
that trickles slowly cannot hold a request open. A request beyond the concurrency limits
fails at once instead of waiting. There is no connection reuse, proxy from the environment
or cookie. Its errors carry only a failure code, never a URL, header, token, request or
response body, resolver text or TLS text, and the profile logs nothing; a caller that
receives a provider's error body must not log it either. Disable XML external-resource
retrieval. Metadata import is untrusted configuration, not proof of domain ownership.
Parse only expected IdP entities, bind entity IDs and endpoints, and review certificate
changes; no automatic trust replacement from a refreshed metadata URL.

Self-hosted IdPs on a private network, or public ones served on a port other than 443,
require a separate operator-owned exact host/port allowlist, `SSO_PRIVATE_TARGETS`, never a
team-editable bypass or reuse of the webhook allowlist setting. The configuration loader
parses it at startup, empty by default, and nothing else reads it until a later step calls
the profile, so today it routes nothing. Each of at most 32 entries is one exact
`host:port`, `IPv4:port` or `[IPv6]:port`, without networks, wildcards or port ranges; an
IP entry must be RFC1918, loopback or IPv6 unique-local space, never metadata or
link-local. A request URL's exact host and port must match an entry, so a different port,
or another name that resolves to the same address, does not. The operator trusts that
exact target, so every DNS answer may be eligible private or loopback space. A listed name
with public syntax, a dotted DNS name without a special-use suffix, may instead have every
answer public: that is how a public IdP on a non-default port, such as
`https://idp.example.com:8443`, is reached. A listed name without public syntax, a single
label such as `keycloak` or a name under `.local`, `.internal`, `.localhost`, `.home.arpa`,
`.test`, `.example`, `.invalid` or `.onion`, accepts only private or loopback answers. A
missing internal service whose name a search domain, wildcard DNS or NXDOMAIN rewriting
expands to a public address is therefore refused before any connection opens. Answers that
mix the two, or that include metadata, link-local, IPv4-mapped or other reserved space, are
refused. Hosts that are not listed keep the default rules above: public answers only, on
the default port only, and no private routing. HTTPS stays required, and a listed target is fetched like any other:
the validated address is pinned to the socket and TLS verifies the original hostname.
Loopback HTTP is allowed only for an explicitly configured local trial: the profile's
separate trial input, which no production caller passes and no setting enables yet, admits
plain HTTP only to a listed `localhost` or loopback literal whose every answer is loopback.
Cloud leaves the operator allowlist empty. The same DNS/socket policy applies on every
request, not just provider registration.

Encrypt client secrets and future SP private keys with purpose-bound AES-256-GCM,
using the existing credential-encryption pattern with organization/provider/revision
as authenticated context and an operator-managed key. Plugin JSON configuration must
not retain plaintext secrets. Reads return only `hasClientSecret`/key identifiers;
writes accept replacement secrets, omission preserves them, and null cannot silently
clear a required secret. Do not log tokens, assertions, XML, discovery bodies, DNS
challenge values or provider error descriptions. Audit encrypted-key rotation and
support operator key backup/restore without printing material. The sealed configuration
binds its provider revision, and the database changes a revision only together with its
ciphertext, so rotating the operator key re-seals every provider that is not retired at a
new revision, even when its trust configuration is unchanged. That ends the tests and
pending attempts bound to the old revision, so enabling enforcement again needs a fresh
owner test of the new revision; `trustGeneration` stays, so browser proofs and delegations
(which record no provider revision) and enforcement already on are unaffected. A retired
provider is frozen with its last envelope, so retire a provider with a re-sealed revision
when its secret must not outlive the old key. An envelope version that names its key would
still need the new revision.

SSO audit uses the `audit_events` [journal](audit-log.md) added in
[PR #246](https://github.com/hourmere/hourmere/pull/246): an append-only table written by one
INSERT in the same transaction as the change it records, with a closed actor/credential
set and per-action detail allow-lists enforced by the application and the database.
The Audit actions step starts only after that journal is on main and builds no
substitute; `organization_operations` does not cover these events. It adds SSO action
names and allow-listed details (authentication method, provider ID and configuration
revision, safe outcome/reason code, correlation ID; never secrets, tokens, assertions,
raw subjects or mailbox capabilities) for: provider
create/edit/test/enable/disable/delete and secret/certificate rotation;
domain challenge/verification/renewal/expiry/release; link/unlink/conflict; SSO
success/failure and rejected replay; JIT admission/refusal; enforcement and delegated
binding changes; proof revocation; recovery enrollment/use; operator maintenance
commands; member/SCIM suspension and reinstatement. Each later step records the events
of the writes it builds inside that write's transaction. Security failures, which have
no business transaction, are redacted and written in a short transaction of their own,
with a bounded count per provider and source so failed attempts cannot flood the
journal. The journal is local to the instance database, so emergency recovery never
waits for a third-party audit sink.

## Pinned operational limits

These are initial design commitments, not current runtime settings. The doc-fact test
pins this table; implementation must import its eventual constants into that test.
The SSO transport limits are runtime constants already and have their own table below.
Other resource limits must be selected with fixtures before their release.

| Limit | Value | Unit |
|---|---:|---|
| `clockSkew` | 60 | seconds |
| `oidcClockSkew` | 30 | seconds |
| `authenticationAttemptLifetime` | 600 | seconds |
| `maximumSamlAssertionLifetime` | 600 | seconds |
| `ssoProofLifetime` | 28800 | seconds |
| `ssoDelegationLifetime` | 2592000 | seconds |
| `freshAdministrationProof` | 300 | seconds |
| `ssoRecoveryNominationLifetime` | 259200 | seconds |
| `domainChallengeLifetime` | 86400 | seconds |
| `domainRecheckInterval` | 86400 | seconds |
| `domainVerificationLifetime` | 604800 | seconds |
| `jwksCacheMaximum` | 3600 | seconds |

All expiry uses UTC instants and database wall time after lock waits; there is no
local-calendar/DST arithmetic. Exact expiry is rejected. The replay retention formula
above is a lower bound, never a fixed cache TTL shorter than Hourmere's acceptance
deadline plus SAML skew or the request window. The IdP's longer validity window
does not extend Hourmere's acceptance deadline.

### Transport limits

The Transport step chose these limits for the SSO transport profile. They are the runtime
constants `SSO_TRANSPORT_LIMITS` in `packages/outbound/src/sso.ts`, which the doc-fact test
imports to pin this table. If fixtures call for different values before either protocol's
setting step, the constants and this table change together.

| Limit | Value | Unit |
|---|---:|---|
| `ssoConnectTimeout` | 5000 | milliseconds |
| `ssoResponseTimeout` | 10000 | milliseconds |
| `ssoMaximumResponseBytes` | 1048576 | bytes |
| `ssoMaximumHeaderBytes` | 16384 | bytes |
| `ssoMaximumUrlBytes` | 2048 | bytes |
| `ssoMaximumDnsAnswers` | 32 | answers |
| `ssoMaximumConcurrentRequests` | 16 | requests |
| `ssoMaximumConcurrentRequestsPerOrigin` | 4 | requests |
| `ssoMaximumPrivateTargets` | 32 | entries |

`ssoConnectTimeout` covers the DNS lookup, the TCP connection and the TLS handshake.
`ssoResponseTimeout` is one absolute deadline for the whole exchange, including the
response headers and the entire decoded body. `ssoMaximumResponseBytes` bounds the bytes on
the wire and, separately, the decoded bytes. The concurrency limits count in-flight requests
per server process, in total and per origin (scheme, host and port).

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
require exact same-origin requests and enforce the fresh-proof retry contract below,
not just document it.

Require `X-Expected-Organization-Id` for session writes, current verified team role,
revision checks and transaction-time authority checks using the existing organization
context/locking pattern. Owner-only enforcement/recovery changes and self-only link/
delegation exceptions are explicit, not routed through an admin helper indiscriminately.

All table paths have prefix `/api/v1/team/sso`. `P` means `{providerId}` and `D` means
`{domainId}` (UUIDs), expanded literally in OpenAPI. Reads expose open objects and
open status strings, UTC RFC3339 timestamps and camelCase fields. List uses the
repository cursor conventions; unknown fields/statuses must be tolerated. All writes
use strict input schemas and safe `{error, message?, field?}` failures; only
`sso_reauthentication_required` adds fields, as the existing member-removal 409 adds `handling`.
Use shared HTTP 400/401/403/404/409/429 conventions. No raw IdP error is returned.
The stable domain codes are exactly:

| Code | HTTP | Meaning |
|---|---|---|
| `team_management_access_denied` | 403 | Existing uniform refusal: no current browser session with the standing the operation needs (owner/admin for configuration, owner for owner-only writes, a usable recovery owner for `useSsoRecovery`, current membership or an eligible invitation for the caller's own link and unlink, current membership for the caller's own delegation writes), an Authorization header, or an inaccessible team |
| `organization_context_changed` | 409 | Existing: `X-Expected-Organization-Id` is missing or is not the session's current team |
| `sso_disabled` | 404 | The protocol is off (see Rollout gating). With every protocol off, or when the input names an off protocol, it comes before any lookup, write or rate-limit count, identically for known and unknown IDs; for an existing object of an off protocol while another protocol is on, it comes after the ordinary team-scoped lookup and authorization |
| `sso_required` | 403 | An enforced team needs a live SSO proof or delegation the caller lacks; machine clients get it without redirects |
| `sso_reauthentication_required` | 403 | The write needs fresh proof; the body adds `attemptId`, `proofMethods` and `expiresAt` |
| `sso_configuration_changed` | 409 | An expected provider revision, `policyRevision`, domain generation, link generation or `trustGeneration` no longer matches |
| `sso_domain_unverified` | 409 | A new link, JIT admission, provider activation or enforcement needs a domain whose verification is unexpired and whose latest recheck was positive (a failed or unknown recheck freezes them) |
| `sso_test_required` | 409 | Activation or enforcement needs a passed test for the exact current provider revision (an owner's, for enforcement) |
| `sso_recovery_required` | 409 | Enforcement needs at least one usable recovery owner (a current owner with accepted status), or the last recovery owner of an enforced team tries to leave, be removed or lose the owner role |
| `sso_not_found` | 404 | Unknown, other-team or retired provider, domain, link, nomination or delegation ID, all with one identical response; a nomination addressed to another owner and another person's delegation answer the same way. Only an authorized repeat delete of the team's own retired provider succeeds idempotently |

The existing leave, member-removal and role-change operations gain
`sso_recovery_required` as an additive error code for the last recovery owner.

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
| POST `/recovery` | `configureSsoRecovery` | Session: nominating a recovery owner requires interactive owner proof; the nominee accepts separately. |
| POST `/recovery/{enrollmentId}/accept` | `acceptSsoRecoveryEnrollment` | Session: the nominated owner must independently prove their own mailbox and consent. |
| POST `/recovery/use` | `useSsoRecovery` | Session: recovery grants narrow authority to the freshly mailbox-authenticated enrolled owner. |
| POST `/providers/P/link` | `linkSsoAccount` | Session: explicit self-linking requires independent local proof and a browser-bound IdP ceremony. |
| DELETE `/providers/P/link` | `unlinkSsoAccount` | Session: removing the caller’s identity binding requires independent local proof. |
| DELETE `/providers/P/links/{linkId}` | `removeSsoIdentityLink` | Session: retiring a conflicting member identity requires fresh administrator proof. |
| POST `/delegations` | `bindSsoDelegation` | Session: binding an owned API key or OAuth grant requires fresh interactive SSO proof. |
| DELETE `/delegations/{bindingId}` | `revokeSsoDelegation` | Session: withdrawing the caller's delegated SSO proof requires the owning browser session. |

Provider and policy reads ship on all three surfaces, despite reads being outside
the parity guard. Require owner/admin plus `read`/`full` API key or authorized MCP
OAuth `mcp:tools`, subject to SSO enforcement. Ordinary members get their own required
provider/proof summary through an additive session-only `/api/v1/me` projection,
not administrator inventories. No first-release machine write changes SSO trust.

Every write except `revokeSsoDelegation` accepts an optional opaque `proofAttemptId` in
its strict input for the fresh-proof retry below. DELETE operations carry their strict
JSON body, which OpenAPI 3.1 permits. Create accepts `{protocol, displayName, domainIds,
oidc?, saml?, proofAttemptId?}`; OIDC has issuer,
clientId and write-only clientSecret; SAML has explicit entityId, SSO URL, trusted
signing certificates and an optional metadata import URL/document. Server-generated
callback URLs cannot be supplied by the caller. Return `{provider}` with id, protocol,
revision, enabled, safe display fields and validation/test status; never echo secrets,
raw metadata or identities. New providers are disabled. Update takes `{expectedRevision,
displayName?, domainIds?, oidc?, saml?, proofAttemptId?}` and delete takes
`{expectedRevision, proofAttemptId?}`; trust edits invalidate tests, pending attempts
and live proofs.
A changed identity tuple requires a replacement provider. Repeating the delete of the
team's own retired provider succeeds idempotently for an authorized caller; every other
operation on a retired ID returns `sso_not_found`. Activation takes `{expectedRevision, enabled,
proofAttemptId?}`.

Domain challenge takes `{domain, proofAttemptId?}` and returns `{domain: {id, name,
status}, txtName, txtValue, expiresAt}` once; repeated creation rotates rather than
recovering the value. Verify/delete take `{expectedGeneration, proofAttemptId?}`.
Domains are organization-owned and providers
reference their IDs; the provider inventory includes safe domain status/generation.
Test takes `{expectedRevision, proofAttemptId?}` and link takes `{proofAttemptId?}`.
Test/link returns a bounded authorization URL and its own ceremony attempt ID;
completion is via protocol
callback and status is observed in provider inventory or the caller's `/me` projection.
Tests do not provision members, link accounts or elevate a session automatically.

Policy takes `{expectedRevision, requireSso, admission, proofAttemptId?}` with
`admission` restricted to `invitation_only` or `jit`. Recovery enrollment takes
`{expectedRevision, ownerUserId, proofAttemptId?}`
and creates a pending nomination, never an active recovery owner. Return an opaque
enrollment ID and notify the nominated current owner with an inert app link. Only that
owner can call `acceptSsoRecoveryEnrollment` with `{expectedRevision, proofAttemptId?}`
and their own fresh independent mailbox proof bound to that enrollment. Acceptance
rechecks owner role, nominating owner authority and `policyRevision`, atomically
consumes the nomination, adds the nominee as a recovery owner, and audits/notifies both
owners. A nomination expires after `ssoRecoveryNominationLifetime` (72 hours), long
enough for a nominee in another time zone or away over a weekend; the nomination
itself grants nothing, and acceptance still needs a mailbox proof no older than
`freshAdministrationProof`. A new nomination of the same owner replaces their pending
one; expiry adds nobody and leaves existing recovery owners intact. Self-nomination
follows the same acceptance ceremony. `useSsoRecovery` takes `{expectedRevision,
proofAttemptId?}` and fresh mailbox proof. Recovery authority expires with the
fresh-administration window and is single-use: each repair write consumes it, and
a retry requires a new ceremony. These proofs
are distinct from IdP authentication. Delegation binding takes `{credentialKind,
credentialId, expectedTrustGeneration, proofAttemptId?}`, verifies ownership and current team binding,
and returns redacted metadata/expiry; revoke accepts only an owned binding and needs no
fresh proof, because it only withdraws authority. Existing
key/OAuth inventory responses gain additive binding summaries for the owner's UI.
A key/grant cannot be rebound to a different organization by this operation.
Unlink/remove take `{expectedLinkGeneration, proofAttemptId?}` and use the exact
provider/link scope;
self unlink never accepts another user ID. The caller's `/me` includes own opaque link
IDs; owner/admin provider inventory includes team-scoped opaque link IDs for explicit
recovery selection without exposing raw subjects or mailbox capabilities.

**Fresh-proof retry.** For every write that needs fresh proof (see Fresh proof), after
session, role, Origin, expected-team and strict input validation and before any
mutation, a request without a satisfied `proofAttemptId` returns
`403 sso_reauthentication_required` with `{error, message?, attemptId, proofMethods,
expiresAt}`. `proofMethods` is an open string list; the first-release values are
`mailbox` and `sso`. The pending attempt freezes user, session, team, operationId, the
canonical input digest (excluding `proofAttemptId`), the initial required methods and an
expiry of `authenticationAttemptLifetime`; only a step-up that cannot prove freshness may
later add `mailbox`. The attempt grants no authority and changes no configuration.
The caller satisfies `mailbox` through the Mailbox proof pair and `sso` through sign-in
initiation with `intent: "step_up"` and that `attemptId`, then repeats the exact
operation and input with `proofAttemptId`. The committing transaction rechecks authority
and revisions, consumes the attempt once and executes only the frozen operation. If the
attempt is valid but a method is still unsatisfied (for example a step-up that could
not prove freshness added `mailbox`), the response is 403 again with the same
`attemptId` and the remaining methods. Any other unusable `proofAttemptId` (unknown,
expired, consumed, bound to another user, session, team or operation, or a different
input digest) is treated as absent: a new attempt is returned and the old one is not
consumed. Recovery use and nominee acceptance need only `mailbox`: no SSO proof and no
prior recovery authority. Proof completion never executes an operation. MCP and CLI never receive this response, because
no machine write changes SSO trust.

Mailbox proof is an authentication protocol surface, outside `/api/v1` and the product
interface-parity inventory, like sign-in/callback below; it has no MCP/CLI equivalent:
`POST /api/auth/sso/mailbox-proof/send` and
`POST /api/auth/sso/mailbox-proof/consume`, owned by Mailbox proof. Send takes an opaque
pending attempt ID and returns the same generic acknowledgement whether delivery is
eligible or not; delivery is queued, never sent inline. The server selects the frozen
mailbox; callers cannot substitute it.
Consume takes that attempt ID and the emailed one-use token, requires the original
browser binding and exact Origin, and stores proof on the attempt rather than issuing
a standalone login/session. Store only token digests; rate-limit send/consume by attempt,
address digest and source, cap guesses, and never disclose an account lookup outcome.
Proof expires at the earlier of attempt expiry and token issuance plus
`freshAdministrationProof`; resend rotates the token. Initial enrollment can use the
pre-session browser cookie; authenticated link, step-up, recovery enrollment and recovery
use additionally bind the existing session/user and intended operation/revision. These
protocol endpoints are the explicit auth exception, not session-only product writes.
GET email links only show an inert confirmation page; consumption requires POST.
Every first enrollment of an IdP subject (OIDC or SAML), every changed linked email,
every `mailbox` fresh proof and every step-up fallback uses this pair.

Protocol endpoints are outside `/api/v1`, as existing Better Auth sign-in already is:
`POST /api/auth/sign-in/sso`, OIDC `GET /api/auth/sso/callback/{providerId}` and
`POST /api/auth/sso/oidc/complete`,
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

Sign-in initiation takes the strict input `{providerId, intent, attemptId?, returnTo?}`.
`intent: "sign_in"` starts a new browser-bound authentication attempt and takes no
`attemptId`. `intent: "step_up"` requires the existing session, the `attemptId` of that
session's pending fresh-proof attempt listing `sso`, and an enabled provider of the
attempt's team where the caller has a link. It requests a fresh authentication (OIDC
`prompt=login` and `max_age=0`; SAML `ForceAuthn="true"`), and its callback records the
result on that attempt as specified under Fresh proof, without a session, proof or link.
Provider tests and self-link ceremonies get their authorization URL from
`testSsoProvider` and `linkSsoAccount`, which create their own bound attempts.
`returnTo` is an optional relative `/app` path checked by the safe-redirect rule below.

When OIDC callback needs mailbox proof, it stores a short-lived frozen validated result
bound to the original browser/attempt, without creating a session or retaining tokens.
After mailbox consumption, same-origin `POST /api/auth/sso/oidc/complete` with `attemptId`
atomically consumes that pending result and its proof, rechecks provider/domain/policy
and admission, and finishes only the original sign-in/link intent. It cannot re-exchange
a code, accept caller-supplied claims or bypass existing-account independent linking.
Ownership (all auth-protocol exceptions, no MCP/CLI surface): OIDC sign-in owns
initiation and callback for linked identities; OIDC completion owns
`POST /api/auth/sso/oidc/complete` for linked identities, with its wrong-browser,
expiry, double-completion and concurrent-removal tests; OIDC self-link and OIDC
admission extend completion to their intents with the same tests; OIDC step-up adds
`intent: "step_up"`. The SAML steps mirror this ownership for SAML providers.
SAML POST callbacks use protocol correlation/signatures rather than same-origin CSRF
requirements intended for admin JSON. Return only safe redirects under `/app`, the
fixed sign-in error page, or the exact internal SAML completion route
`/api/auth/sso/saml2/complete`. RelayState and request data cannot override callbacks/scopes.

## Self-hosting and local acceptance

Operators configure canonical HTTPS `PUBLIC_URL`, working SMTP for independent email
proof/recovery, credential encryption keys, trusted proxy settings and optional private
IdP destinations. Which protocols an operator can turn on follows Rollout gating below:
until a protocol's setting step, no configuration can enable it; from then on
`SSO_OIDC_ENABLED` or `SSO_SAML_ENABLED` does, on every instance. A setting turned off
never bypasses a team's enforcement policy. No configuration described here is
available in the current release.

Known compatibility limitations:
- Keycloak SAML response-only signing is insufficient: enable **Sign assertions**
  in the client signing settings. **Sign documents** may remain enabled. The local
  fixture must verify the pinned version's defaults (documents on, assertions off)
  and demonstrate rejection before enabling assertion signing; see [Keycloak's
  signing settings](https://www.keycloak.org/docs/latest/server_admin/index.html#_client_saml).
- Microsoft Entra ID OIDC does not emit the standard `email_verified` claim. This
  changes nothing, because Hourmere proves the mailbox of every first enrollment for
  every IdP. Domain verification (`xms_edov`) does not substitute for mailbox
  ownership. Entra emits `auth_time` only as a configured optional claim; without it,
  every Entra step-up also needs mailbox proof. See
  [Microsoft's optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).
- An IdP on a private network, or a public one on a port other than 443, is reached
  only through its exact `SSO_PRIVATE_TARGETS` entry, and still requires HTTPS: the
  setting permits that routing, not plaintext transport. `http://keycloak:8080` on a
  compose network is refused; only the separately acknowledged loopback trial exception
  permits HTTP. Only an entry with a public DNS name may resolve publicly; a listed
  single-label or special-use name such as `keycloak:8443` or `idp.internal:8443` must
  resolve to private or loopback addresses.

Register the exact OIDC callback above in the IdP (no wildcard), and for SAML register
the exact ACS and the stable entity ID published by the SP metadata endpoint. Derive
all URLs from configured PUBLIC_URL, never request Host. Keep SAML entity ID stable
across certificate rotation. Rotate provider secrets through the browser after testing
a new revision. Back up encrypted configuration and the operator encryption key
separately; key loss prevents login and requires recovery/reconfiguration. Rotating that
key re-seals every provider that is not retired at a new revision (see Fetching,
credentials and audit).

The six Keycloak fixture, linking and acceptance steps use an owned local Keycloak
container/realm, synthetic users, their own disposable database/volumes and free ports
other than shared development ports. Pin the Keycloak image/version in the Keycloak OIDC
fixture step, record its digest and import a non-secret realm fixture. Configure distinct OIDC and SAML clients, exact callbacks, verified and
unverified email personas, multiple subjects with the same email, and a disabled user.
A narrowly scoped private-target exception permits that fixture's exact host/port;
DNS TXT is faked deterministically in tests. Never query a real enterprise IdP or SMTP.
Browser processes require an escalated shell or CI. Stop only owned PIDs/containers
and delete only named fixture resources created by the step; retain no tokens/assertions.

Acceptance must exercise OIDC and SAML happy paths, personal magic-link/Google/Microsoft
coexistence using the repo's fakes, explicit link consent, JIT/invitation distinction,
closed signup, same-email takeover attempts, domain expiry, policy activation, break-glass,
key/OAuth expiry, IdP outage, JWKS/certificate rotation and replay across two processes.
Negative cryptographic fixtures supplement Keycloak: a successful demo cannot prove
signature wrapping or replay safety. SAML encrypted assertions must produce a clear
unsupported result. Public booking/manage-link behavior remains unchanged by team SSO;
authenticated reschedule/cancel and team reads require the same SSO policy. Exercise
UTC expiry across DST boundaries without changing scheduling's time-zone semantics.

## Rollout gating

Releases are tagged from any commit on main: the release workflow only checks that the
tagged commit is an ancestor of `origin/main` (`scripts/release.ts`). No operator
setting may therefore enable an SSO path before that path is complete. Each protocol
has exactly two mechanisms, defined here once and used by every row of the
implementation sequence:

| Mechanism | Definition |
|---|---|
| Hard-off | Server composition passes `ssoOidcEnabled: false` or `ssoSamlEnabled: false` from a code constant. No environment variable, configuration file or database row can change it; `SSO_OIDC_ENABLED` and `SSO_SAML_ENABLED` are not read before their setting steps. Integration, jsdom and Keycloak tests enable a protocol only by injecting `true` into the app, service or in-process fixture server under test, as existing `slotSnippetsEnabled` tests do; the production entry point passes no such argument. |
| Setting | The protocol's setting step replaces its constant with one operator setting: `SSO_OIDC_ENABLED` in the OIDC setting step, `SSO_SAML_ENABLED` in the SAML setting step. An empty value means unset, as the configuration parser's existing `optional()` treats every empty variable; unset follows the current default, `false` means off, `true` means on, and any other value fails startup. Until the final Acceptance and defaults step the default is off; that step makes it on, and an explicit `false` still opts out. `.env.example` lists each setting with an empty value (`SSO_OIDC_ENABLED=`, `SSO_SAML_ENABLED=`), never `=false`, and `docker-compose.yml` passes `${SSO_OIDC_ENABLED:-}` and `${SSO_SAML_ENABLED:-}`, never a `:-false` fallback. `scripts/setup.sh` copies `.env.example` lines verbatim into a new `.env`, so an install created during the setting window follows the default flip without editing `.env`. |

Each plan row states, per protocol, `hard-off`, `setting introduced (default false)` or
`setting (default false)`; only the last row changes both defaults to true. A protocol's
setting step comes after that protocol has, end to end: sign-in with the member sign-in
UI, linking and unlinking, admission, step-up, team, native and delegated enforcement,
recovery enrollment and use (break-glass) with its UI, the operator recovery command,
its negative/cryptographic corpus (OIDC verifier and OIDC step-up, or SAML verifier,
SAML timing and replay and SAML step-up, plus Transport's egress negatives) and its
Keycloak acceptance.
`setSsoPolicy` with `requireSso: true` is therefore never reachable through an operator
setting before `useSsoRecovery` and the operator recovery command exist.

**Published catalogues.** From Draft reads on, each row that adds SSO REST operations,
MCP tools or CLI commands registers them in `packages/auth/src/api-key-operations.ts`,
as the registry's parity tests require. OpenAPI, MCP `tools/list`, CLI help and the
generated scope tables in `docs/api-keys.md`, `docs/mcp.md` and their documentation-site copies
therefore list them in every release, while hard-off. Draft reads adds a static note
beside those tables, outside the generated `api-key-scope-table` markers, stating that
SSO operations return `404 sso_disabled` until an operator enables the protocol, and
rewords the Known limitations bullet from "in design" to "being built and not available
yet". Every later row keeps both until the OIDC setting step.
Public user guides for a protocol land in its setting step, which also rewrites the note
and the bullet for the new setting; Release docs completes the cross-protocol operator
guides, and Acceptance and defaults updates them for the on-by-default state.

The Hard-off guard catalogue regression checks reject SSO names in the Hono route
inventory of the app built from `productionAppOptions` (`apps/server/src/server.ts`),
the options `startServer` itself passes to `createApp`, under a configuration that
turns on every optional group (SCIM, MCP OAuth with its discovery documents and
guarded authorize route, the built web app's static files, the Zoom event webhook and
slot snippets; the waitlist confirmation pages are always mounted), including plain
handlers absent from OpenAPI, and in the worker role's health app; in OpenAPI paths
and operation IDs; in the MCP tools that the same assembly advertises to a full-scope
API key, with only the caller resolver replaced; and in CLI commands and targets.
From the Upgrade step on they also check the endpoint paths of every Better Auth plugin,
which the route inventory sees only as the single `/api/auth/*` mount: `createAuth` is
built from `productionAuthOptions` (`apps/server/src/server.ts`), the options `startServer`
itself passes, with every input `startServer` supplies, against a database pool that
never connects. Every endpoint path is checked twice: in `auth.api`, which Better Auth
builds before any plugin's `init` runs, and, once startup has settled, in the plugin objects
of `createAuth`'s options, whose endpoints its router reads again on every request. It is built under the same
all-groups-on configuration (including MCP OAuth and both social providers) and again
under each of the eight combinations of the groups that change what `createAuth`
registers (MCP OAuth, Google sign-in and Microsoft sign-in, from none of them, a default
instance, to all three), with every other setting at its default; each combination's
endpoint paths must be among the all-on ones. The suite also confirms that every endpoint
path of the installed SSO plugin would be caught. A relying party that reuses the social
sign-in endpoints adds no endpoint name (Better Auth's `genericOAuth` does this), so the
suite also requires the sign-in providers to be exactly the configured ones (Google and
Microsoft when both are set) and no `genericOAuth` plugin to be registered in any of these
configurations. A plugin's `onRequest` or `onResponse` hook runs outside route matching
and can answer a path without registering an endpoint, which no inventory sees. Better
Auth runs these hooks from the plugin list in its context, which a plugin's `init` can add
to, so the suite also pins, by id, the plugins Better Auth actually runs after plugin init:
in every one of these configurations they must be exactly the declared ones, and the ones
with either hook must be exactly the MCP OAuth provider plugin when MCP OAuth is on (it
answers its own discovery documents that way) and none otherwise. As a
backstop for a surface no inventory sees, every string literal that begins with `/` in
the `src` directory of each apps, packages and tools workspace is checked too, leaving out
only an explicit list of test-support and generated files, and no such source may import
`@better-auth/sso`. These checks are by name. A path assembled from pieces escapes the
literal scan, although the route and endpoint inventories still see it once it is
registered for a configuration they build, by the end of plugin init; an endpoint gated
on the value of a setting the combinations do not vary (the signup mode, the `PUBLIC_URL`
scheme) or on an input `startServer` does not pass, an endpoint or plugin added after
startup has settled (from a timer, for example), what the MCP OAuth provider plugin's own
request hook answers, a run-together name outside the word list, and shipped code outside
a `src` directory (the web service worker, the site worker, Astro page routes) are not seen.
Names match `saml`, `oidc` and `openid` anywhere, `sso` as a word (after splitting
camelCase, separators, digits, the plural or version suffix — `ssos`, `SSOv2`,
`listSSOs` — and a short list of words run together with it: `ssoconfig`,
`ssoprovider`, `ssologin`, `ssologout`, `ssocallback`, `ssosettings`, `ssoflow`,
`ssodomain`, `teamsso`, `orgsso`, `getsso`) and `single sign on` in any spelling. There
are two exemptions, each for one exact path. The existing MCP OAuth discovery route
`/.well-known/openid-configuration/api/auth` is exempt in the route inventory and the
source literals, and the same document's Better Auth endpoint
`/.well-known/openid-configuration` among Better Auth endpoint paths: there Hourmere is
the OAuth authorization server for MCP clients, not an SSO relying party. The suite
checks that nothing else is exempt. The web source check covers JSX `<Route>` attributes in
`apps/web/src/App.tsx`, including nested `<Routes>`, and strings, template parts and
identifiers in `apps/web/src/paths.ts`. It does not inspect imported route
components, other files or route-object definitions; extend that inventory if routing
moves to those sources. The startup check also runs the production entry point
`apps/server/src/index.ts` in a child process with `SSO_OIDC_ENABLED=true` and
`SSO_SAML_ENABLED=true` and requires both `/instance` flags to be `false`. The
designed REST operation-ID table currently has exactly 19 entries, checked by the
regression suite. Unrelated catalogue additions remain allowed.

**Hard-off behaviour.** Every SSO path of that protocol is unreachable; while both
protocols are hard-off, so are the protocol-neutral SSO operations (policy, domains,
recovery, mailbox proof, links and delegations). Each REST operation, MCP tool, CLI
command and auth-protocol endpoint returns `404 sso_disabled`, at the point the code
table defines: while both protocols are off, before any lookup, write or rate-limit
count, identically for known and unknown IDs. The registered operations still appear in
the published catalogues with the note above. `GET /api/v1/instance` reports
`ssoOidcEnabled`/`ssoSamlEnabled` as `false`, `/me` adds no SSO fields, the web shows no
SSO navigation or sign-in option, and the domain recheck worker is not scheduled. Two
things work in every state: a stored `requireSso` policy is enforced from Team
enforcement onward (no product path can store one while hard-off), and the operator
maintenance commands, which only remove trust, run.

**Setting-off behaviour** (after the setting step: unset or empty before the default
flip, or `false`). Operations that add trust through that protocol return
`404 sso_disabled`: sign-in initiation, callbacks, ACS, metadata and completion; provider
create, update, test and `activateSsoProvider` with `enabled: true`; linking, step-up and
delegation binding. `setSsoPolicy` with `requireSso: true` is refused with
`sso_disabled` unless the team has an enabled, tested provider of a protocol that is on.
While no protocol is on, domain challenge and verification, `setSsoPolicy` with
`admission: "jit"`, and recovery nomination and acceptance are refused too. That
protocol's pending attempts cannot complete. Its browser proofs and delegations are
suspended, not revoked: they do not satisfy enforcement while off and are accepted again
if the setting returns before their own deadline, which nothing extends. Stored policy is
unchanged, so an enforced team's members lose team access while personal spaces are
unaffected. Trust-reducing and recovery operations stay available, each with its normal
proof: reads, `useSsoRecovery`, `setSsoPolicy` with `requireSso: false`,
`activateSsoProvider` with `enabled: false`, `deleteSsoProvider`, `deleteSsoDomain`,
`unlinkSsoAccount`, `removeSsoIdentityLink`, `revokeSsoDelegation` and the operator
commands. Mailbox proof stays available for the attempts of these operations. SSO
step-up through that protocol is unavailable, so on an enforced team the owner first
uses recovery to read the configuration and turn enforcement off; the team's remaining
writes then use mailbox fresh administration. `GET /api/v1/instance` reports the
protocol as `false`; `/me` keeps the caller's own link and proof summary; the web hides
that protocol's sign-in, link, step-up and binding controls and its trust-adding setup
controls, but keeps, for teams with stored SSO configuration, the read, recovery,
unlink, link-retirement and delegation-revocation views and the trust-reducing setup
controls (provider deactivation and deletion, domain deletion, turning enforcement off).
After a setting step the domain recheck worker keeps running even while the setting is
off, so verification state stays current.

## Implementation sequence

Every row is approximately one working day; if a release gate needs an upstream fix,
stop that protocol's rollout rather than compressing its security work. Dependencies
refer only to earlier rows, and each acceptance check tests only what its row or an
earlier row builds. Where a check needs stored state that a later row's operation
writes (an enforced or JIT policy before `setSsoPolicy`, a SAML provider before its
configuration fields), the test seeds that row directly. External prerequisites are
named in the row that waits for them: the patched Better Auth family (1.7.16, already
on main) in Upgrade and the audit journal of PR #246 in Audit actions. Each endpoint name below refers to the exact
inventory above; “none” means no new REST, MCP or CLI operation. All migrations are
future work with predecessor-data/fresh/no-op tests and newly allocated numbers. Each
implementation PR includes its OpenAPI/parity/client changes, scope-registry entries and
regenerated scope tables, behavioral negatives/source mutations, translations and
repository docs for the surfaces it adds; public user guides follow Published
catalogues above.
Flag states use only the Rollout gating vocabulary. Every acceptance cell ends with its
Off check, run with `SSO_OIDC_ENABLED=true` and `SSO_SAML_ENABLED=true` in the
environment for each protocol that is still hard-off: everything the row adds stays
unreachable as specified under Rollout gating. From a protocol's setting step on, its
off state is Setting-off behaviour instead: trust-adding operations stay refused exactly
as their earlier off checks require, while the operations, UI views and worker that
behaviour keeps available stay available.

| Step | Builds; endpoint / MCP / CLI ownership | Dependencies | Flag state | Acceptance checks |
|---|---|---|---|---|
| Hard-off guard | Code constants `ssoOidcEnabled = false` and `ssoSamlEnabled = false` in server composition (no environment variable), the shared `404 sso_disabled` guard, test injection and additive `ssoOidcEnabled`/`ssoSamlEnabled` in `GET /api/v1/instance`; none | Accepted design | OIDC hard-off; SAML hard-off | Injected `true` reaches a guarded test route only in tests; mutations flipping either constant fail real assertions; OpenAPI/types for the additive fields. Off: `/instance` reports both `false`; OpenAPI paths, MCP tools, CLI commands and web routes otherwise unchanged |
| Upgrade | Add `@better-auth/sso` at the pinned family version (1.7.16 or later on main) and rerun this source evaluation against it; none | Hard-off guard | OIDC hard-off; SAML hard-off | Regression suite; family at or above every listed advisory patch; pre-session validation hook or replacement adapter feasibility established. Off: no SSO plugin route registered |
| Configuration storage | Providers with encrypted configuration and `revision`, team policy with `policyRevision` and `trustGeneration`, domain claims with generations, recovery owners and nominations; none | Upgrade | OIDC hard-off; SAML hard-off | Realistic predecessor preservation, fresh/no-op migration, one active claim per domain under concurrent inserts, AAD tamper (ciphertext moved between organization/provider/revision fails), bounded pools. Off: tables only; no route, worker or read uses them |
| Identity storage | Identity links with link generations, pending attempts (sign-in, test, link, fresh proof) with frozen operation/input digests, mailbox token digests, replay cache, browser proofs and delegation bindings; admission tombstones reuse the shared `scim_membership_blocks` table from the [SCIM identity storage](scim.md) (organization, normalized mailbox, authority, kind) and a subject-keyed JIT check adds its column there in the SSO step that needs it; none | Configuration storage | OIDC hard-off; SAML hard-off | Predecessor preservation, fresh/no-op migration, `(organization, provider, issuer, subject)` uniqueness race, replay-key uniqueness across two connections, proofs and bindings store `trustGeneration`, link generation and the domain claim they relied on, tombstones in the shared table survive member and account deletion, bounded pools. Off: tables only |
| Transport | Extract pinned outbound transport and operator `SSO_PRIVATE_TARGETS` policy; none | Identity storage | OIDC hard-off; SAML hard-off | DNS rebinding/mixed answers, socket pinning, timeout/size/redirect negatives, secret redaction; webhook delivery unchanged. Off: no SSO caller; the allowlist routes nothing |
| Audit actions | Prerequisite: the `audit_events` journal of PR #246 is on main; this step does not start, and builds no substitute, before it is. SSO action names and detail allow-lists in the application and database check, plus the redacted security-failure writer; none | Transport | OIDC hard-off; SAML hard-off | Each SSO action accepts only its allow-listed details and extra keys fail in the application and database; event and change commit or roll back together; failure events bounded per provider/source; no secret, token, assertion, raw subject or mailbox capability recorded. Off: no SSO action emitted; existing audit actions unchanged |
| Mailbox proof | `POST /api/auth/sso/mailbox-proof/send` and `/consume`; auth-protocol exception, no MCP/CLI; reusable attempt-bound proof for every intent; bounded cleanup of expired and consumed attempts with their mailbox tokens | Audit actions | OIDC hard-off; SAML hard-off | Test-seeded attempts of each intent; missing-session enrollment, exact Origin/browser binding, identical queued send response and message whether or not delivery is eligible, token digest/rotation/expiry, consume race, wrong user/mailbox/intent; expired and consumed attempts and their tokens deleted by the bounded cleanup, sign-in attempts included; fake mail only. Off: both endpoints `404 sso_disabled` |
| Fresh proof | Shared fresh-proof gate: pending attempt, `403 sso_reauthentication_required` with `attemptId`/`proofMethods`/`expiresAt`, strict `proofAttemptId` retry, `mailbox` for teams without enforcement, and enforced-team mode requiring `sso` (unsatisfiable until a step-up row); none | Mailbox proof | OIDC hard-off; SAML hard-off | On a test-only operation: 403 before any mutation and attempt only; retry succeeds once; changed input/user/session/team/operation gets a new attempt and leaves the old one unconsumed; consumption race; `freshAdministrationProof` and attempt-expiry boundaries; Authorization header refused; on a seeded enforced team mailbox-only proof is refused. Off: no new route |
| Draft reads | `listSsoProviders`, `getSsoPolicy`; `list_sso_providers` / `sso providers list`, `get_sso_policy` / `sso policy`; scope-registry entries, regenerated scope tables and the static unavailable note beside them (outside the generated markers) in `docs/api-keys.md`, `docs/mcp.md` and their site copies | Fresh proof | OIDC hard-off; SAML hard-off | Owner/admin plus `read`/`full` key or `mcp:tools` OAuth; ordinary members and `bookings` keys refused; tenant-scoped cursor pagination beyond 101 providers; open objects/statuses and no secret, raw metadata or identity in any surface; MCP/CLI output matches REST. Off: both reads, both MCP tools and both CLI commands `sso_disabled` before lookup; the generated tables list them with the note, the scope-docs consistency test passes, and the Known limitations bullet says SSO is being built and not available yet |
| Drafts | `createSsoProvider`, `updateSsoProvider`, `deleteSsoProvider` with OIDC fields; no MCP/CLI writes | Draft reads | OIDC hard-off; SAML hard-off | Exact session exemptions, bearer+cookie refusal, role/context/revision races, ciphertext-only storage and secret preservation on omission; a team's first provider created with mailbox fresh administration; `proofAttemptId` in the strict schemas; idempotent repeat delete of a retired provider; a trust edit (secret, certificates, endpoints, algorithms) and a deletion each increment `trustGeneration`, while a display-name edit does not; audit events. Off: all three operations `sso_disabled` before lookup; `protocol: "saml"` `sso_disabled` while SAML is hard-off |
| Domains | `createSsoDomainChallenge`, `verifySsoDomain`, `deleteSsoDomain`; no MCP/CLI writes | Drafts | OIDC hard-off; SAML hard-off | Pending challenges never reserve; an active claim cannot be evicted; challenge rotation, exact subdomains, DNS outage is unknown, no personal-account capture; mailbox fresh administration; audit events. Off: three operations `sso_disabled` |
| Domain lifecycle | Scheduled recheck worker (renewal, freeze on failure, suspension at expiry) and the domain-retirement maintenance command with its runbook; no product operations | Domains | OIDC hard-off; SAML hard-off | Renewal success/failure/unknown, exact expiry boundary, retirement/verify races under the domain lock, old-team owner notification and `system` audit event, retirement transfers no trust/identity/membership. Off: worker not scheduled; the command only removes trust and runs in every state |
| OIDC verifier | PKCE/state/nonce, strict ID token verification including signed `auth_time`, bounded JWKS cache; none | Domain lifecycle | OIDC hard-off; SAML hard-off | OIDC negative corpus: invalid/missing claims and algorithm, `none`/HMAC confusion, issuer mix-up, replay/concurrency, future `iat`/`auth_time`, unknown/duplicate key IDs, ignored `jku`/`x5u`, rotation/outage; 30-second tolerance distinct from SAML `clockSkew`. Off: no caller |
| OIDC sign-in | `POST /api/auth/sign-in/sso` (`intent: "sign_in"`) and `GET /api/auth/sso/callback/{providerId}` for already-linked identities, with browser proof issuance; auth-protocol exception | OIDC verifier | OIDC hard-off; SAML hard-off | Atomic state/code use; identity/config revision checks before session; proof deadline is the earliest of lifetime/session/domain/IdP deadline and rolling refresh never extends it; unlinked subjects stop at the identical generic outcome, with or without `email_verified` or an existing account, and get no account, link, session or stored result until OIDC admission; safe redirects; disabled drafts refused; audit. Off: both endpoints `sso_disabled` |
| OIDC completion | `POST /api/auth/sso/oidc/complete` and frozen pending-result storage for linked identities whose asserted email changed (mailbox proof first); auth-protocol exception | OIDC sign-in | OIDC hard-off; SAML hard-off | No tokens retained; wrong browser, expiry, double completion, concurrent member removal and provider deletion; no code re-exchange or caller-supplied claims; proof bound to the attempt; the changed-email outcome is identical whether or not the new address belongs to another account, and a collision is reported only after mailbox proof without recording the address. Off: `sso_disabled` |
| OIDC provider test | `testSsoProvider`; no MCP/CLI write; bound test intent through existing start/callback | OIDC completion | OIDC hard-off; SAML hard-off | Disabled draft only for initiating admin/exact revision/browser; mailbox fresh administration; no account creation/link/admission; test receipt invalidated on change; owner receipts recorded. Off: `sso_disabled` |
| OIDC self-link | `linkSsoAccount`, additive session-only `/api/v1/me` own-attempt/link/proof summary; no MCP/CLI write | OIDC provider test | OIDC hard-off; SAML hard-off | Independent mailbox proof through the fresh-proof retry; frozen local identity and explicit consent; first link proves the mailbox even with `email_verified: true`; wrong session/email/conflicting subject rejected; a new link refused with `sso_domain_unverified` while the provider's domain recheck has failed; link-intent completion wrong browser/expiry/double/concurrent removal; no team access before admission. Off: `sso_disabled`; `/me` adds no SSO fields |
| OIDC admission | Pending results for unlinked subjects; extend the callback/completion resolver and existing explicit invitation acceptance; no new operations | OIDC self-link | OIDC hard-off; SAML hard-off | Generic outcome identical in status, shape, timing class and email for every combination of existing account and `email_verified`; after proof an existing account gets only the link path; admission-intent completion refuses a wrong browser, an expired result and a second completion; no duplicate user/automatic linking; signup/first-user transaction, invitation role/expiry/inviter, JIT capacity under a seeded JIT policy and JIT frozen while the domain recheck has failed, removal races/tombstones. Off: extended endpoints still `sso_disabled` |
| Identity recovery | `unlinkSsoAccount`, `removeSsoIdentityLink`; no MCP/CLI writes; extend own/provider summaries with scoped opaque link IDs | OIDC admission | OIDC hard-off; SAML hard-off | Self-only with independent mailbox proof; admin mailbox fresh administration and team boundary; admins retire only member/admin links and an owner's link needs another owner; exact generation race; that person's browser proofs revoked and other members' untouched; conflict retirement then explicit re-link; refusal without a remaining independent sign-in method; audit/notify. Off: `sso_disabled` |
| OIDC step-up | `intent: "step_up"` on sign-in initiation with `prompt=login`/`max_age=0`, signed `auth_time` check, binding to the pending attempt and mailbox fallback; enables the fresh-proof gate's enforced-team mode for OIDC; no new operations | Identity recovery | OIDC hard-off; SAML hard-off | On a seeded enforced team, provider, domain, test and link-removal writes accept OIDC step-up and refuse mailbox-only proof; missing `auth_time` (Entra default) adds `mailbox`; stale/future `auth_time`, silent SSO, other user/subject/provider/team, expired/consumed attempt and changed retry input refused; no session, proof or link created. Off: `step_up` `sso_disabled` |
| Team enforcement | Proof check service (membership, `trustGeneration`, link generation, domain claim, deadline) on every team-scoped `/api/v1` read and the enrollment exceptions, including the existing `/me` own summary; no new write operations | OIDC step-up | OIDC hard-off; SAML hard-off | Seeded `requireSso` policy: personal isolation; proof expiry, `trustGeneration`, link-generation and domain-claim checks (a retired claim counts as deleted), so deleting the domain ends dependent proofs; other members' proofs survive invitations, JIT admissions, departures and role changes; the enrollment exceptions built so far (`/me`, auth initiation, mailbox proof, link and unlink) expose no team data. Off: without a stored policy team reads behave as today; a seeded policy is enforced even with the constant false |
| Team write enforcement | The same proof check on every team-scoped `/api/v1` write, rechecked in the committing transaction; no new write operations | Team enforcement | OIDC hard-off; SAML hard-off | Seeded `requireSso` policy: every team write family refuses without a live proof; proof ended between request and commit refused; conflict retirement then explicit re-link under enforcement. Off: without a stored policy team writes behave as today; a seeded policy is enforced even with the constant false |
| Native enforcement | Native Better Auth team routes, trusted calls, shared services, transactions and queued work; no new operations | Team write enforcement | OIDC hard-off; SAML hard-off | Native/trusted-call bypass negatives, transaction-time removal checks, queued work rechecked before acting, booking lifecycle unchanged. Off: as Team enforcement |
| Delegation binding | `bindSsoDelegation`, `revokeSsoDelegation`; additive owned key/grant summaries; no MCP/CLI writes | Native enforcement | OIDC hard-off; SAML hard-off | Own same-team credential only; SSO step-up required and mailbox-only refused; 30-day ceiling independent of browser expiry and capped by credential expiry; domain renewal keeps and lapse ends the lease; unlink or link removal revokes that member's delegations only; revoke and binding races; on a seeded enforced team revocation works without a live proof and exposes no team data. Off: `sso_disabled` |
| Delegation enforcement | API key checks on `/api/v1` (which also serve the CLI), OAuth consent/token/refresh and MCP authorization checks using the binding service; no new operations | Delegation binding | OIDC hard-off; SAML hard-off | Seeded enforcement: unbound keys denied; OAuth resume; refresh never extends delegation; 30-day expiry, removal, domain deletion and provider trust-change races; other members' changes leave leases intact; stable `sso_required` without redirects. Off: without a stored policy key/OAuth behavior unchanged |
| Recovery enrollment | `configureSsoRecovery`, `acceptSsoRecoveryEnrollment`; no MCP/CLI writes; recovery-record deletion and the last-recovery-owner guard on leave, removal and role change | Delegation enforcement | OIDC hard-off; SAML hard-off | Nominee accepts with own mailbox proof; acceptance adds and never replaces; wrong owner/session/revision; 72-hour expiry boundary and consumption races; expiry adds nobody and a new nomination replaces the pending one; a recovery owner's unlink or link removal leaves recovery ownership intact; leaving, removal or demotion of a non-last recovery owner deletes the record in the same transaction with an audit event, and re-joining or re-promotion does not restore it; on a team without enforcement the only recovery owner may be demoted; on a seeded enforced team nominee acceptance works without a live proof and exposes no team data; on a seeded enforced team the last recovery owner cannot leave, be removed or be demoted (`sso_recovery_required`); audit/notify both owners. Off: `sso_disabled` |
| Provider activation | `activateSsoProvider`; no MCP/CLI writes; owner checks without recovery bypass yet | Recovery enrollment | OIDC hard-off; SAML hard-off | Activation needs a passed test of the exact revision and a verified domain; refused with `sso_domain_unverified` after a failed recheck or expiry; last-provider guard while a seeded enforcement policy is active; disabling increments `trustGeneration`; mailbox fresh administration on a team without enforcement; audit events. Off: `sso_disabled` |
| Enforcement policy | `setSsoPolicy`; no MCP/CLI writes; owner checks without recovery bypass yet | Provider activation | OIDC hard-off; SAML hard-off | Enforcement needs a verified domain, an enabled tested provider of a protocol that is on (only a seeded SAML provider while SAML is hard-off is refused with `sso_disabled`), an owner test of the exact revision and a usable recovery owner; a pending nomination, a demoted former recovery owner and a demoted-then-re-promoted owner without a new acceptance each leave enforcement refused with `sso_recovery_required`; refused with `sso_domain_unverified` after a failed recheck or expiry; `trustGeneration` increments on enforcement off, never on enforcement on, admission or membership changes, so a binding made before enforcement keeps working; once enforced, every fresh-administration write requires OIDC step-up; audit events. Off: `sso_disabled` |
| Recovery use | `useSsoRecovery`; recovery-authority checks on `listSsoProviders`, `getSsoPolicy` and `setSsoPolicy` with `requireSso: false`; no MCP/CLI writes | Enforcement policy | OIDC hard-off; SAML hard-off | Fresh mailbox proof by a usable recovery owner; single-use race; reads do not consume authority and observe expiry; `setSsoPolicy {requireSso: false}` consumes it; cannot enable JIT, alter membership, bind delegations, change recovery owners or read team data; expired, non-owner, demoted and non-recovery-owner refusal. Off: `sso_disabled` |
| Recovery repair | Recovery-authority checks on `createSsoProvider`, `updateSsoProvider`, `testSsoProvider` and `activateSsoProvider`; no MCP/CLI writes | Recovery use | OIDC hard-off; SAML hard-off | Update, test and re-activation of a broken provider take three ceremonies; `createSsoProvider` consumes one; a test callback finishes only its bound intent; each write still checks owner, session, Origin and expected team; a second write on one ceremony refused. Off: `sso_disabled` |
| Operator recovery | Offline recovery maintenance command that turns one team's enforcement off, and its runbook; no product operations | Recovery repair | OIDC hard-off; SAML hard-off | Runs only in the server container against the instance database; unknown team refused; changes only `requireSso`, increments `trustGeneration`, writes a `system` audit event and notifies owners; idempotent; race with concurrent `setSsoPolicy`. Off: only removes trust, so it runs in every state |
| Provider setup UI | Provider and domain forms using prior endpoints; no new operations | Operator recovery | OIDC hard-off; SAML hard-off | en/zh-CN admin strings; jsdom revisions and conflicts, secret replacement without echo, domain challenge display once, neutral loading/error/403. Off: no navigation entry; settings routes show not-found; no SSO request |
| Activation UI | Provider test and activation controls and the fresh-proof prompt (mailbox and step-up) using prior endpoints; no new operations | Provider setup UI | OIDC hard-off; SAML hard-off | en/zh-CN admin strings; jsdom test intent, activation prerequisites, `sso_reauthentication_required` retry for both methods, neutral loading/error/403. Off: no activation control reachable; no SSO request |
| Member UI | Sign-in, explicit self-link/unlink and mailbox confirmation using Mailbox proof, OIDC self-link and Identity recovery endpoints; no new operations | Activation UI | OIDC hard-off; SAML hard-off | en/zh-CN sign-in; shipped public locales where applicable; jsdom consent, email proof send/consume, stale intent, generic same-email outcome, personal-account coexistence. Off: sign-in page shows no SSO option |
| Recovery UI | Recovery nomination, acceptance and use flows and the broken-provider repair sequence using prior endpoints; no new operations | Member UI | OIDC hard-off; SAML hard-off | Second-owner consent within 72 hours, owner-only narrow recovery, one ceremony per repair write, en/zh-CN, jsdom denied/unknown state. Off: no recovery entry |
| Enforcement UI | Enforcement/admission policy form, identity-link retirement and delegation bind/revoke forms using prior endpoints; no new operations | Recovery UI | OIDC hard-off; SAML hard-off | Prerequisite messages, admins cannot retire an owner's link, unlink/relink path, delegation expiry, step-up prompts; en/zh-CN, jsdom denied/unknown state. Off: no enforcement entry |
| Keycloak OIDC fixture | Owned, pinned local Keycloak realm with OIDC client and synthetic personas; OIDC sign-in browser acceptance through the in-process fixture server with injected `ssoOidcEnabled: true`; no product operations | Enforcement UI | OIDC hard-off; SAML hard-off | Image digest recorded; synthetic end-to-end sign-in and personal-account coexistence; tampered state/nonce and replayed code refused; cleanup of owned containers only; browser escalation/CI. Off: the same fixture without injection shows no SSO option |
| Keycloak OIDC linking | OIDC self-link and admission browser acceptance on the same fixture; no product operations | Keycloak OIDC fixture | OIDC hard-off; SAML hard-off | Explicit link with mailbox proof, same-email takeover attempts, invitation and JIT admission, closed signup, the generic outcome for an unlinked subject; cleanup; browser escalation/CI. Off: without injection no link or admission entry |
| Keycloak OIDC acceptance | OIDC enforcement, step-up, delegation and recovery browser acceptance on the same fixture; no product operations | Keycloak OIDC linking | OIDC hard-off; SAML hard-off | Enforcement with `prompt=login`/`max_age=0` step-up, delegated CLI/MCP lease, break-glass repair and operator recovery; key rotation and IdP outage; cleanup; browser escalation/CI. Off: without injection, a seeded enforced team is still enforced and shows no SSO sign-in option |
| OIDC setting | Replace `ssoOidcEnabled` with `SSO_OIDC_ENABLED` (empty or unset = default, still off); empty `SSO_OIDC_ENABLED=` in `.env.example` and `${SSO_OIDC_ENABLED:-}` in `docker-compose.yml`; README, `/instance` effective state, public OIDC user guides, and the scope-table note and Known limitations bullet rewritten for the setting; no new operations | Keycloak OIDC acceptance | OIDC setting introduced (default false); SAML hard-off | `true` runs the full OIDC flow with environment-derived config; an invalid value fails startup and an empty one equals unset; a `.env` created by `scripts/setup.sh` and the compose environment leave the variable empty, so that install is off now; each setting-off effect has a test (trust-adding operations refused, proofs and delegations suspended and accepted again before their deadline, stored enforcement kept, recovery and trust-reducing operations available); `SSO_SAML_ENABLED=true` still changes nothing. Off: unset, empty or `false` matches Setting-off behaviour: trust-adding operations stay refused exactly as their earlier off checks require, while mailbox proof, recovery and trust-reducing operations, their UI views and the recheck worker stay available |
| SAML verifier | XML structure and signature validation with recipient/destination/audience binding; none | OIDC setting | OIDC setting (default false); SAML hard-off | SAML negative corpus: duplicate IDs, wrapping, XXE/DTD, external references, unsigned assertions, response-only signature, SHA-1 and unconfigured algorithms, audience/recipient/destination mismatch, encrypted input rejected; the verified node is the consumed node. Off: no caller |
| SAML timing and replay | Time-bound validation, acceptance deadline and durable request/assertion replay cache; none | SAML verifier | OIDC setting (default false); SAML hard-off | Missing or infinite timestamps refused; Entra 70-minute Conditions/5-minute bearer and AD FS 60-minute Conditions accepted before the minimum bearer/Conditions/IssueInstant+600 deadline; exact boundary; expired or mismatched request refused; parallel replay across two connections yields one success; retention at least `max(acceptanceDeadline + clockSkew, requestExpiresAt)`. Off: no caller |
| SAML start | `intent: "sign_in"` for SAML providers on `POST /api/auth/sign-in/sso`: HTTP-Redirect AuthnRequest persisting request ID, browser-binding digest, opaque RelayState handle and expiry before redirect; no new operations | SAML timing and replay | OIDC setting (default false); SAML hard-off | Persisted before redirect; RelayState carries no URL or identity; binding cookie set; request expiry; no IdP-initiated path. Off: SAML providers `sso_disabled` while OIDC works |
| SAML ACS and completion | `POST /api/auth/sso/saml2/sp/acs/{providerId}`, GET/POST `/api/auth/sso/saml2/complete` and browser proof issuance for already-linked fixture identities; auth-protocol exception | SAML start | OIDC setting (default false); SAML hard-off | Cross-site POST pending result cannot mint a session; original browser required; forged/missing RelayState, request/assertion replay, wrong browser and expired completion with deadline recheck refused; no unsolicited login/SLO. Off: `sso_disabled` |
| SAML configuration and test | `GET /api/auth/sso/saml2/sp/metadata/{providerId}` (auth-protocol read); SAML fields on `createSsoProvider`/`updateSsoProvider` and SAML `testSsoProvider`; no new v1 operation | SAML ACS and completion | OIDC setting (default false); SAML hard-off | Stable entity ID/exact ACS, guarded metadata parsing, signed-assertion setting, certificate rotation including absent KeyInfo, revision-bound admin tests without enrollment, fresh administration; recovery authority repairs a SAML provider through update, test and re-activation in three ceremonies. Off: `protocol: "saml"` and metadata `sso_disabled` |
| SAML self-link | SAML `linkSsoAccount` and own summary, with mailbox proof on every initial SAML enrollment; no new operations | SAML configuration and test | OIDC setting (default false); SAML hard-off | Persistent NameID or pinned immutable attribute only, transient NameID refused; independent mailbox proof and explicit consent; changed asserted email needs mailbox proof, with the same identical outcome whether or not the new address belongs to another account; link-intent completion wrong browser/expiry/double/concurrent removal. Off: `sso_disabled` |
| SAML admission | SAML completion resolver for unlinked subjects and invitation acceptance; no new operations | SAML self-link | OIDC setting (default false); SAML hard-off | Identical generic outcome with and without an existing account; admission-intent completion refuses a wrong browser, an expired result and a second completion; invitation/JIT/closed-signup parity with OIDC; no duplicate user/automatic linking; removal races/tombstones. Off: extended endpoints still `sso_disabled` |
| SAML identity recovery | SAML links in `unlinkSsoAccount`/`removeSsoIdentityLink` and SAML conflict handling; no new operations | SAML admission | OIDC setting (default false); SAML hard-off | Owner-link rule, exact generation race, that person's SAML browser proofs revoked and others untouched, conflict retirement then re-link without enforcement. Off: `sso_disabled` for SAML links |
| SAML step-up | `intent: "step_up"` for SAML with `ForceAuthn="true"`, signed `AuthnInstant` check, binding to the pending attempt and mailbox fallback; enables enforced-team mode and delegation binding through SAML; no new operations | SAML identity recovery | OIDC setting (default false); SAML hard-off | On a seeded SAML-enforced team every fresh-administration write and delegation binding accepts SAML step-up and refuses mailbox-only proof; missing or old `AuthnInstant` (an IdP ignoring ForceAuthn) adds `mailbox`; replayed assertion and other user/subject/provider refused; unlink or link removal revokes that member's SAML-bound delegations; retiring a SAML link and re-linking under seeded SAML enforcement; no session, proof or link created. Off: `sso_disabled` |
| SAML UI | Provider form metadata/certificate controls and SAML sign-in, link and step-up entries; no new operations | SAML step-up | OIDC setting (default false); SAML hard-off | jsdom redaction, rotation/revision conflicts, unknown readiness, en/zh-CN and public locales. Off: SAML controls hidden |
| Keycloak SAML fixture | SAML client in the pinned local realm; SAML sign-in browser acceptance through the in-process fixture server with injected `ssoSamlEnabled: true`; no product operations | SAML UI | OIDC setting (default false); SAML hard-off | Pinned-version signing defaults (documents on, assertions off) rejected, then accepted with Sign assertions ON; ACS/RelayState and completion; tampered and replayed responses refused across two processes. Off: without injection no SAML option |
| Keycloak SAML linking | SAML self-link and admission browser acceptance on the same fixture; no product operations | Keycloak SAML fixture | OIDC setting (default false); SAML hard-off | Explicit link with mailbox proof, invitation and JIT admission, closed signup, the generic outcome for an unlinked subject; cleanup. Off: without injection no SAML link or admission entry |
| Keycloak SAML acceptance | SAML enforcement, step-up, delegation and recovery browser acceptance on the same fixture; no product operations | Keycloak SAML linking | OIDC setting (default false); SAML hard-off | Enforcement with ForceAuthn step-up, delegated lease through SAML step-up, break-glass repair of a SAML provider, signing-certificate rotation; logout/deprovision limitation demonstrated; cleanup. Off: without injection, a seeded SAML-enforced team is still enforced and shows no SAML option |
| SAML setting | Replace `ssoSamlEnabled` with `SSO_SAML_ENABLED` (empty or unset = default, still off); empty `SSO_SAML_ENABLED=` in `.env.example` and `${SSO_SAML_ENABLED:-}` in `docker-compose.yml`; README, `/instance` effective state, public SAML user guides, and the scope-table note and Known limitations bullet rewritten; no new operations | Keycloak SAML acceptance | OIDC setting (default false); SAML setting introduced (default false) | `true` runs the full SAML flow with environment-derived config; an invalid value fails startup and an empty one equals unset; a setup.sh `.env` and the compose environment leave it empty; each SAML setting-off effect has a test; with SAML off and OIDC on, a team whose only enabled provider is SAML cannot enable enforcement (`sso_disabled`); OIDC behavior unchanged. Off: unset, empty or `false` matches Setting-off behaviour for SAML: trust-adding SAML operations stay refused exactly as their earlier off checks require, while mailbox proof, recovery and trust-reducing operations for SAML teams, their UI views and the recheck worker stay available |
| Release docs | Complete the cross-protocol operator/REST/MCP/CLI guides: both settings and their off effects, the backup/recovery drill including both operator commands, and limitations; no product operations | SAML setting | OIDC setting (default false); SAML setting (default false) | Self-host parity; operator can recover without the IdP; examples match registered tools/commands; the protocol guides from the setting steps and the scope-table note agree; no unimplemented settings advertised. Off: docs describe both settings as off by default |
| Acceptance and defaults | Independent end-to-end acceptance; unset or empty `SSO_OIDC_ENABLED` and `SSO_SAML_ENABLED` now mean `true`; `.env.example` keeps the empty values and `docker-compose.yml` its `:-` pass-through; README, guides, the scope-table note, the Known limitations bullet and every documented default updated | Release docs | Both settings; this step changes both defaults to true | Default configuration end to end; an install whose `.env` was created by `scripts/setup.sh` or copied from `.env.example` during the setting window turns SSO on after upgrading without editing `.env`, through both direct and compose environments; upgrading an instance without SSO configuration only adds SSO navigation and sign-in options; full gates and final required CI green. Off: explicit `false` reruns every Setting-off behaviour check for both protocols |

## Out of scope and remaining decisions

No product implementation or migration lands with this design. The Upgrade step adds one
development dependency, `@better-auth/sso` at the pinned family version, which no shipped
source imports or registers.
SCIM, IdP group role mapping, service accounts, IdP-initiated SAML, SAML SLO, encrypted
assertions, automatic domain transfers, wildcard domain claims, a separate
recovery-owner withdrawal operation and global forced SSO
are deferred. IdP deactivation is not immediate local revocation without SCIM; absolute
proof expiry bounds that delay. Private IdP reachability remains operator-controlled.
A successful provider test does not prove all accounts have valid immutable identifiers.

The Upgrade step found that the upgraded plugin's pre-session hook cannot carry the
OIDC JWKS and transport requirements or the SAML completion hop, and that OIDC algorithm
policy is reachable only as an after-the-fact header check (see
Pre-session hook and plugin paths). Better Auth is retained for local sessions, and the
OIDC and SAML federation paths are replaced by maintained-library adapters; the OIDC
verifier and SAML verifier steps record their negative tests before either protocol
leaves hard-off. The audit journal of PR #246 is an
external prerequisite of the Audit actions step. Confirm the conservative
no-automatic-linking policy, invitation-only default, expiring delegated proof policy,
mailbox fresh administration for teams without enforcement and the 72-hour recovery
nomination with the project lead;
these are proposed safe defaults, not existing customer behavior.
