# Organization SSO: evaluation and implementation design

The plugin evaluation was first run on 2026-11-06 against the Better Auth 1.7.12 family,
repeated on 2026-11-09 in the Upgrade step against 1.7.16, and repeated on 2026-11-24
against the installed 1.7.25 family. `@better-auth/sso`
1.7.25 is a development dependency of the auth workspace. No shipped source imports or
registers it, and the production image excludes it. The first plan step that
imports it from shipped code moves it to `dependencies`. Migration 0074 adds the
configuration storage of the Configuration storage step (see
[Data model](data-model.md#sso-configuration-storage)) and migration 0075 the identity
storage of the Identity storage step (see
[Data model](data-model.md#sso-identity-storage)). The first users of this storage were
mailbox proof and delivery, attempt cleanup, the operation-bound retry gate, and redacted
provider and policy reads.
OIDC is opt-in through `SSO_OIDC_ENABLED` and SAML is hard-off in production.
SSO will be available to every instance, including self-hosted ones. There is no license,
subscription or hosted-service requirement.

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

`packages/auth/package.json` pins the Better Auth family entries it declares at exactly 1.7.25. The root lockfile also resolves the transitive Better Auth adapters and telemetry to 1.7.25. This evaluation reads the installed `node_modules/@better-auth/sso/dist/index.mjs`. Line numbers below refer to that file unless another file is named. Its locked library versions include samlify 2.15.1, jose 6.2.17, @xmldom/xmldom 0.9.12 (with 0.8.15 nested under xml-crypto and @authenio/xml-encryption), fast-xml-parser 5.12.0, xml-crypto 6.4.0 and tldts 7.4.18. The server declares tldts 7.5.4 separately. The image's `npm prune --omit=dev --omit=optional` removes the SSO plugin. The server declares jose, xml-crypto and @xmldom/xmldom directly for its verifiers, and samlify for SAML request generation. `npm audit` and `npm audit --omit=dev` returned zero advisories on 2026-11-24.

The 2026-11-09 evaluation found no runtime changes in the plugin since 1.7.12. The 1.7.16 to 1.7.25 installed-source comparison found changes to SAML timestamp tolerance, assertion replay IDs, recipient selection, single logout and cross-package error handling. Core's `oauth2/verify-id-token.mjs` differs only in source comments. The locked jose 6.2.17 still checks future `iat` and age only with `maxTokenAge` set.

Official references include the integration guides and versioned source. [SSO docs](https://better-auth.com/docs/plugins/sso), [OIDC](https://better-auth.com/docs/plugins/sso/oidc), [SAML](https://better-auth.com/docs/plugins/sso/saml), [SAML validation](https://better-auth.com/docs/plugins/sso/saml-security), [provisioning](https://better-auth.com/docs/plugins/sso/provisioning), [changelog](https://github.com/better-auth/better-auth/blob/v1.7.25/packages/sso/CHANGELOG.md), [SSO source](https://github.com/better-auth/better-auth/tree/v1.7.25/packages/sso/src), [core verifier](https://github.com/better-auth/better-auth/blob/v1.7.25/packages/core/src/oauth2/verify-id-token.ts).

### Recommendation

Keep Better Auth for local sessions and accounts. Hourmere owns the OIDC and SAML federation paths, organization and provider policy, encrypted configuration, exact identity binding, domain lifecycle, enforcement and audit. The 1.7.25 review confirms the adapter decision made at 1.7.16. The plugin's pre-session hook has no seam for a JWKS cache, pinned outbound transport or browser-bound SAML session completion. The stock OIDC flow also omits a nonce and a verifier algorithm allowlist. Hourmere's adapters use jose, xml-crypto and @xmldom/xmldom for verification and samlify for SAML request generation. The first SAML release rejects encrypted assertions and requires both assertion and response IDs. The conditions for enabling each protocol are in [Rollout gating](#rollout-gating). Reevaluate a stock plugin path at the exact patched version if upstream supplies a missing seam. [Nonce issue](https://github.com/better-auth/better-auth/issues/12081), [custom transport issue](https://github.com/better-auth/better-auth/issues/10625).

### Source evidence matrix

| Area | Installed 1.7.25 evidence (`index.mjs` lines) | Hourmere consequence |
|---|---|---|
| OIDC protocol/discovery | Code flow with discovery or manual endpoints. Discovery enforces exact issuer equality (637–645) and runs at sign-in when endpoints are missing (758–774). PKCE defaults true and can be disabled in the provider configuration (1862). Both initiation paths apply it only with `config.pkce` (3697, 4126). The request accepts `scopes` and `additionalParams`. Default scopes include `offline_access` (3689–3707). | Force S256 PKCE and fixed `openid email profile` scopes on explicit per-provider callbacks. |
| State/nonce | `generateState` binds state to the provider reference (3686–3687). The callback checks that reference (3798–3799) and locks and rechecks the provider before linking (3945–3951). Neither authorization URL construction nor token verification sets a nonce. Core filters `nonce` from `additionalParams` (`oauth2/create-authorization-url.mjs` 10–19, 68–70). | Persist a transaction nonce and require the matching signed claim before session issuance. Block generic callback bypass. |
| ID token | `validateOIDCIdToken` supplies JWKS, issuer and audience to core `verifyIdToken`, then checks `azp` for multiple audiences or any supplied `azp` (560–575). Core requires `iss`, `sub`, `aud`, `exp` and `iat`, rejects an empty audience, and applies 30 seconds of tolerance. The plugin requires an ID token for `resolveUser` and checks UserInfo `sub` against the ID token when present (3893–3901). | Require an ID token each time, verify issuer, audience, authorized party, expiry and subject, and obtain mailbox proof independently of `email_verified`. |
| `iat` and algorithms | Core `verifyIdToken` accepts algorithms, `maxTokenAge` and a nonce. The plugin supplies none (567–575). jose 6.2.17 checks numeric `iat` and applies future and maximum-age checks when `maxTokenAge` is set. | Configure an algorithm allowlist from trusted provider policy and enforce `iat` freshness. |
| JWKS | `validateOIDCIdToken` constructs `createRemoteJWKSet` per callback (567–573). Fetch uses the plugin's endpoint guard. The plugin has no shared cache or provider signing-algorithm policy. | Cache per provider, issuer and JWKS URL with bounded freshness and controlled unknown-`kid` refresh. Test rotation and concurrency and reject when fresh keys cannot verify the token. |
| SSRF | The endpoint fetch helpers used by discovery, token, UserInfo and JWKS validate URLs and refuse redirects (531–557, 585–590, 3854, 3895). The DNS guard performs an unpinned lookup, continues after DNS lookup failures, and skips the check for `trustedOrigins` (465–494). The plugin lacks custom fetch injection. | Use Hourmere's outbound guard at connection time for discovery, token, UserInfo, JWKS and metadata, with deadlines and size limits. Configure egress trust separately. |
| SAML validation | The plugin requires one plaintext or encrypted assertion and calls samlify's `parseLoginResponse` (1185–1205, 2843–2853). It applies a separate namespace- and ID-aware signature check with `wantAssertionsSigned` (1216–1237, 2865–2872), checks audience and bearer recipient, and checks response Destination if present (1437–1454). It locks and rechecks the provider before linking (3001–3007). | Require a signed assertion and use its authenticated subtree. Require Destination, pin ACS, issuer and audience, and test duplicate IDs, wrapping and external entities. |
| SAML timestamps | `clockSkew` defaults to 300000 ms and is now passed to samlify as well (1670–1705, 2681–2713). The default plugin timestamp policy warns when both conditions are missing. Even `requireTimestamps` accepts either bound alone. samlify 2.15.1 checks bearer SubjectConfirmationData bounds when present (`flow.js` 215–250). `IssueInstant` is unbounded. | Require bounded assertion `NotBefore`, `NotOnOrAfter` and bearer expiry. Apply the acceptance deadline below. |
| SAML replay | `validateInResponseTo` atomically consumes the verification value and checks provider and reference, with validation on and IdP-initiated login off by default (1479–1522). DOM extraction now yields a decoded assertion ID (2793–2809). The plugin reserves it until `NotOnOrAfter` plus skew or a fallback TTL (2927–2953). A missing ID warns unless signed assertions are required, which rejects it first (1228–1229). Response ID is not required. | Require both IDs, match the outstanding request before expiry, and enforce atomic replay protection across replicas. |
| RelayState/browser binding | Generic state carries the provider reference (2626–2644). Cross-site ACS POST skips the Lax state cookie check (2652–2664). The plugin rejects invalid supplied RelayState and can use `InResponseTo` when it is absent (2894–2919). The ACS sets the session cookie in its POST response (3083–3086). | Require issued opaque RelayState and complete sign-in on a same-site hop bound to the initiating browser. |
| Encryption | `createSP` wires decryption settings (1670–1705) and decrypts assertion content for binding validation (2788–2792). Registration serializes protocol configuration and private keys as JSON text (3399–3435, 3471–3500). | Refuse encrypted assertions. Envelope-encrypt stored client secrets and private keys and decrypt only transiently. |
| SAML metadata/rotation | `createIdP` uses imported XML in preference to manual fields and accepts certificate arrays for manual configuration (1748–1772, 1844). SP metadata is generated, and custom SP metadata must preserve required assertion signing (1713–1742, 3133–3153). The binding check accepts the current route, canonical ACS and configured POST metadata locations (2780–2786). There is no automatic refresh. | Pin entity ID and verified keys. Use guarded metadata retrieval, explicit rotation and overlap tests including absent KeyInfo. |
| DNS | The plugin checks DNS TXT for every configured domain and stores one `domainVerified` flag (2500–2512, 2575–2623). Verification of an already verified provider returns 409. Changing the domain clears the flag (2380). There is no periodic check and configured default SSO can count as verified (1654). | Maintain exact-domain records, renewal and suspension. |
| Linking | `resolveUser` receives the verified OIDC claims or the SAML provider attributes and an account key with issuer and subject (3008–3015, 3933–3960). The resolver requires native transactions (1591–1602) and enables exact account binding (3047, 4001). Without it, domain trust includes subdomains and can implicitly link via verified local email (90–104, 2991, 3937). | Bind organization, provider, issuer and subject in Hourmere's transaction. Require existing-account proof for initial linking. |
| Provisioning | The plugin assigns organization membership after authentication (3064–3081, 4015–4034), using `getRole` or the default member role. A live invitation suppresses automatic assignment (230–267). The after hook also provisions by verified domain on social callbacks (4577–4591). OIDC `requestSignUp` can override `disableImplicitSignUp` (3985). | Apply Hourmere's transactional admission policy and recheck invitation or JIT eligibility each login. |

The inspected samlify 2.15.1 verifySignature uses absolute XPaths, rejects wrapping descendants, requires message KeyInfo cert to match pinned metadata, checks signed references and signed root/ID/namespace. This supports reuse but is not proof all malicious XML cases are safe; test actual locked versions. SAML secret storage and browser-binding limitations cannot be repaired by documentation alone.

### Pre-session hook and plugin paths

**The hook.** `resolveUser` (`SSOOptions`, `dist/index-CndkJEsk.d.mts` 334) runs
inside `runWithTransaction` on OIDC and SAML sign-in. The plugin locks and rechecks
the provider before calling it, then calls `handleOAuthUserInfo` for the user, account
and session writes (OIDC 3945–4006, SAML 3001–3052, and
`better-auth/dist/oauth2/link-account.mjs` 364 for session creation). A
`{action: "reject"}` throws `FORBIDDEN` and rolls back that transaction (OIDC 3961–3964,
SAML 3016–3019). A thrown error or invalid decision from the hook yields
`SSO_USER_RESOLUTION_FAILED` (1571–1589). Configuring the hook requires an ID token
for OIDC (3893), uses exact account binding, and defers non-database writes. It also
requires native transactions, async context support and database-backed session storage
if secondary storage is configured (1591–1626). The hook sees verified ID-token claims
or the SAML IdP entity ID, NameID and assertion attributes, along with the account key
and provider reference. `getCurrentAuthEndpointContext()` (`@better-auth/core/context`)
provides the raw endpoint request. Verified protocol data available to the hook is
limited to its input.

**What it cannot carry.** Each row is a design requirement that must hold before a session
exists. "Re-parse" means reading the raw `SAMLResponse` from the endpoint context again,
outside the subtree the plugin verified; Hourmere does not adopt that, because a second
parser over unauthenticated XML is the signature-wrapping risk the design rules out.

| Requirement | Plugin behaviour at 1.7.25 | Enforceable before the session? |
|---|---|---|
| OIDC nonce bound to the attempt | Authorization and verification omit a nonce (3689–3707, 567–575). Core treats it as a reserved parameter and drops it from `additionalParams`. | The hook sees the claim. Sending a nonce would require rewriting the plugin's authorization URL. |
| OIDC algorithm allowlist (RS256) | The plugin supplies no `algorithms` to `verifyIdToken` (569–573). | The hook receives only the payload. The account create/update `before` database hooks can see the raw ID token before session creation on account creation, linking and later sign-ins with `updateAccountOnSignIn` enabled (`link-account.mjs` 190–197, 241–259, 295–304, 364). That allows a separate rejection after verification and gives no control over verifier algorithms. |
| OIDC `iat` age and future `iat`, `auth_time` | The plugin omits `maxTokenAge` and does not check `auth_time`. | The resolver can check the verified claims. |
| Bounded JWKS cache | Each callback constructs `createRemoteJWKSet` (568). | The plugin lacks an injectable cache. |
| Pinned outbound transport | The plugin uses global fetch after an unpinned DNS lookup (465–557). | The plugin lacks an injectable transport. |
| No session on the SAML cross-site POST | The ACS creates the session and sets the cookie in the POST response (3020–3052, 3083–3086). | Allowing sign-in runs the stock session path. Rejecting it leaves Hourmere to implement the entire completion hop. |
| SAML assertion ID required | The plugin warns about a missing assertion ID (2953). | With `wantAssertionsSigned: true`, the signature check requires an assertion ID (1228–1229). |
| SAML response ID required | The resolver receives no response ID. | Only by re-parsing the response. |
| SAML `IssueInstant` + `maximumSamlAssertionLifetime` deadline | Timestamp validation checks Conditions (2681–2713) and bearer SubjectConfirmationData through samlify. | `IssueInstant` would require re-parsing the response. |
| SAML response Destination required | The plugin validates Destination when present (1437–1443). | Requiring its presence would require re-parsing the response. |
| Encrypted SAML assertions refused with a clear result | The plugin decrypts with a configured key for binding validation (2788–2792). | Omitting the decryption key fails parsing as an invalid SAML response (2843–2853). Empty `saml.algorithms` encryption allowlists can reject declared algorithms (1109–1132). The plugin has no dedicated unsupported-encryption result. |

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
  `algorithms`, `maxTokenAge`, `requiredClaims` and `clockTolerance`. Hourmere fetches
  JWKS through its pinned transport, caches the imported public keys and uses JOSE for
  signature and JWT claim verification. State consumption uses Hourmere's pending
  attempts. The SAML verifier step planned
  the SAML adapter on samlify 2.15.1 with xml-crypto and @xmldom/xmldom. samlify's response
  flow (`samlify/build/src/flow.js` 703–825) verifies the signature, issuer, audience,
  recipient and a present Destination, that the signed and outer InResponseTo agree, and
  bearer SubjectConfirmationData; its optional replay cache (435–467) requires an assertion
  ID. The plugin's single-assertion (1185–1205) and assertion-signature (1216–1237)
  checks are not exported, so that step reimplements them on samlify with the plugin source
  as the reference; exported pure helpers
  (`validateDiscoveryDocument`, `computeDiscoveryUrl`, `deriveSAMLServiceProviderPolicy`)
  may be reused. Neither adapter writes cryptography or XML signature code.
  As built, the SAML verifier (`apps/server/src/sso-saml-verifier.ts`) calls xml-crypto and
  @xmldom/xmldom, the two libraries under samlify, directly and does not import samlify.
  samlify's `verifySignature` returns after the first signature it selects, uses only the
  first configured certificate when the message has no KeyInfo, hands back a re-serialized
  node rather than the digested bytes, and its `allowedSignatureAlgorithms` option only
  pre-checks the signature and digest methods: it does not cover canonicalization or
  transforms and does not prune the algorithm tables of its `SignedXml` instance. The
  server uses samlify to generate SAML requests and handles assertions in the verifier.
  The verifier reads every returned value from the canonical bytes
  that xml-crypto's `getSignedReferences()` reports as digested, after re-hashing them
  against the signed DigestValue in constant time.
  Contract for the steps that call the verifier: `assertion.*` is always authenticated, but
  when the Response element is unsigned (`response.signed` is false) its ID, IssueInstant,
  Destination and Status come from the unsigned wrapper. The timing module uses the signed
  assertion timestamps and caches the response ID only when the response is also signed.
  The verifier checks that the response and bearer InResponseTo agree. The timing module
  matches both against the outstanding request of the verifying provider. It requires the
  assertion bounds listed below and checks bearer NotBefore when present. NameID and
  attribute values are returned exactly as signed, untrimmed, and
  are not normalised before identity matching.
- Retained: Better Auth's session and account machinery (`internalAdapter.createSession`,
  as `handleOAuthUserInfo` uses it) and Hourmere's existing session database hooks.
- Not exposed and not replaced: provider management (`/sso/register`, `/sso/providers`,
  `/sso/get-provider`, `/sso/update-provider`, `/sso/delete-provider`), the plugin's domain
  verification (`/sso/request-domain-verification`, `/sso/verify-domain`) and single
  logout (`/sso/saml2/sp/slo/:providerId`, `/sso/saml2/logout/:providerId`). Hourmere's
  own operations, domain lifecycle and local revocation cover them.

### Changelog and security

The earlier OIDC changes require `exp`, `iat` and a nonempty client ID and reject an exact discovery issuer mismatch. The 1.7.3 compatibility fix uses `(providerId, accountId)` again and rejects ambiguous account keys. The certificate rotation fix permits changing SAML signing certificates for linked providers. [Token validation](https://github.com/better-auth/better-auth/pull/11935), [issuer validation](https://github.com/better-auth/better-auth/pull/11438), [account keys](https://github.com/better-auth/better-auth/pull/11153), [rotation](https://github.com/better-auth/better-auth/pull/11687).

The 1.7.20 SSO patch applies the default clock skew to samlify. The 1.7.21 patches decode the assertion ID before reserving it for replay protection and keep SAML logout records current during session refresh. The 1.7.24 patch recognises API errors across `better-call` copies. These changes leave the pre-session findings above in place. Hourmere uses local session revocation and does not enable the SSO plugin's single logout. [Versioned SSO changelog](https://github.com/better-auth/better-auth/blob/v1.7.25/packages/sso/CHANGELOG.md).

The 1.7.25 OAuth provider release defaults `oauthProviderResourceClient(auth)` to in-process signing keys. Hourmere does not call that helper. Its separate OIDC adapter owns federation discovery and JWKS fetches. [Better Auth 1.7.25 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.25).

On 2026-11-24 the upstream GitHub repository advisory API reported 49 published advisories, with the newest from 2026-11-03. Of these, 43 name packages present in the root lockfile. Comparing the ranges to the locked Better Auth family yields zero matches for 1.7.25. [Better Auth security advisories](https://github.com/better-auth/better-auth/security/advisories).

| Advisory | Risk | Patch | 1.7.25 status |
|---|---|---|---|
| [GHSA-mx9r-x6ww-qjw9](https://github.com/better-auth/better-auth/security/advisories/GHSA-mx9r-x6ww-qjw9) | personal-provider identity crossover | 1.7.3 | outside affected range |
| [GHSA-8c5h-wx78-2cfg](https://github.com/better-auth/better-auth/security/advisories/GHSA-8c5h-wx78-2cfg) | unproven domain claims / account takeover | 1.4.8, 1.6.27 or 1.7.0-rc.5 | outside affected range |
| [GHSA-prpr-5gj3-qqhg](https://github.com/better-auth/better-auth/security/advisories/GHSA-prpr-5gj3-qqhg) | four domain/provider deletion/SAML/SLO takeover flaws | 1.6.21 or 1.7.0-beta.10 | outside affected range |
| [CVE-2026-53515 / GHSA-gv74-j8m3-fg5f](https://github.com/better-auth/better-auth/security/advisories/GHSA-gv74-j8m3-fg5f) | ordinary members register org provider | 1.6.11 or 1.7.0-beta.4 | outside affected range |
| [CVE-2026-53513 / GHSA-5rr4-8452-hf4v](https://github.com/better-auth/better-auth/security/advisories/GHSA-5rr4-8452-hf4v) | SSRF registration | 1.6.11 | outside affected range |
| [CVE-2026-53514 / GHSA-fmh4-wcc4-5jm3](https://github.com/better-auth/better-auth/security/advisories/GHSA-fmh4-wcc4-5jm3) | invitation acceptance by an unverified account | 1.7.16 on the stable 1.7 line | outside affected range |
| [GHSA-hwq2-v29r-p69r](https://github.com/better-auth/better-auth/security/advisories/GHSA-hwq2-v29r-p69r) | email-change links act on a later owner of the old address | 1.7.16 on the stable 1.7 line | outside affected range |
| [GHSA-9hm7-xhfp-cx58](https://github.com/better-auth/better-auth/security/advisories/GHSA-9hm7-xhfp-cx58) | unverified OAuth email treated as verified | 1.7.16 on the stable 1.7 line | outside affected range |
| [GHSA-fvxx-76fc-893x](https://github.com/better-auth/better-auth/security/advisories/GHSA-fvxx-76fc-893x) | revoked sessions remain cached or in secondary storage | 1.7.16 on the stable 1.7 line | outside affected range |
| [GHSA-c85h-5mrr-mgx4](https://github.com/better-auth/better-auth/security/advisories/GHSA-c85h-5mrr-mgx4) | padded owner invitation role | 1.7.16 on the stable 1.7 line | outside affected range |

### Upstream bugs and limitations (queried 2026-11-24)

- [12081](https://github.com/better-auth/better-auth/issues/12081): no OIDC nonce; confirmed installed source.
- [10625](https://github.com/better-auth/better-auth/issues/10625): no custom federation fetch seam; confirmed options/source limitation. Its historical redirect implementation details differ from inspected artifact.
- The discovery DNS check report is still open. The installed 1.7.25 discovery path calls the same guarded fetch helper as token and UserInfo requests. [10830](https://github.com/better-auth/better-auth/issues/10830).
- [10831](https://github.com/better-auth/better-auth/issues/10831): trustedOrigins/SSRF coupling; current bypass and unpinned addresses confirmed.
- [4291](https://github.com/better-auth/better-auth/issues/4291): encrypt config at rest; JSON serialization confirmed.
- [11570](https://github.com/better-auth/better-auth/issues/11570): expose verified authentication statements/fresh SAML auth; enforcement freshness must not be inferred from session.createdAt alone.
- [11569](https://github.com/better-auth/better-auth/issues/11569): transaction hooks for enrollment/org assignment; integration must own transactional membership.
- [10784](https://github.com/better-auth/better-auth/issues/10784): per-domain verification.
- [9707](https://github.com/better-auth/better-auth/issues/9707): group-to-role mapping, defer.
- The SSO-to-OAuth continuation issue was closed after the 1.7.25 release. In the installed package, the OAuth provider's query-preservation hook still matches `/sign-in/social` only. Keep testing Hourmere's own MCP OAuth continuation. [11349](https://github.com/better-auth/better-auth/issues/11349), [12727](https://github.com/better-auth/better-auth/pull/12727).
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
table. The request error path uses the recogniser, and so do the mailbox proof delivery and
attempt cleanup jobs, which write these tables in the background: their errors carry only a
fixed label and the recogniser's names, never the driver's message. A later step that writes
them through Better Auth or another background job routes that logger's errors through it as
well. On a live link it is the address last proven: a later mailbox proof replaces it,
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
token, added the bounded cleanup: a job every minute deletes at most 1000 attempts that are
consumed or expired by the database clock, sign-in attempts included, and their mailbox
tokens with them. It only deletes, so it runs in every flag state.

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
A new current invitation can explicitly reinstate access after local removal.
[SCIM provisioning](scim.md) shares the locks, tombstones and revocation services.
A separate SCIM suspension requires SCIM reactivation. Without SCIM provisioning or
logout delivery, disabling a person at the IdP takes effect on the next required
authentication. Local removal takes effect on the next authorization check.

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

With an internal SSO protocol enabled, the same `/api/v1/me` exception lets a verified
browser session discover the enforced teams where the caller is a current owner with
accepted recovery enrollment. The optional `ssoRecoveryTeams` array contains only
`id`, `displayName` and `policyRevision` for each of those teams. It works from any
active space, including personal space. Pending nominations, former owners and teams
without enforcement are excluded. The field is omitted for callers with no eligible
teams, for API keys and OAuth clients, and while both protocols are hard-off. The
summary alone grants no team access. A recovery grant requires separate mailbox proof.

内部启用单点登录协议时，已验证的浏览器会话可通过同一个 `/api/v1/me` 例外查看自己当前
担任所有者、已接受恢复提名且已强制使用单点登录的团队。在个人空间或其他空间中均可查看。
可选的 `ssoRecoveryTeams` 数组对每个团队仅返回 `id`、`displayName` 和 `policyRevision`。
待接受提名、已失去所有者身份的用户及未强制使用单点登录的团队均不符合条件。没有符合条件
的团队、使用 API 密钥或 OAuth 客户端，或两种协议均在代码中关闭时，响应省略此字段。
该摘要不授予团队访问权。取得恢复授权仍须单独验证邮箱。

Check both `/api/v1` and native Better Auth team routes and shared services; middleware
alone does not protect trusted calls, transactions or queued operations. A stored
`requireSso` policy is enforced whatever the rollout constants or settings say (see
Rollout gating); no deployment toggle bypasses it.

Team writes through `/api/v1` and MCP check the bound team's policy at admission and
recheck live proof inside the committing transaction when a policy exists. Revocation
or expiry before the commit check rolls back the write and its transactional side
effects. If the team has no stored policy, the committing transaction is unchanged.

中文：`/api/v1` 和 MCP 的团队写入会先检查目标团队的策略。团队已保存策略时，提交事务会重新检查
SSO 凭证。凭证在提交检查前过期或被撤销，写入及事务内的副作用一并回滚。没有团队策略时，写入事务照常执行。

Native Better Auth team operations use the same proof check for browser requests and
trusted `auth.api` calls. Scoped requests without proof receive `403 SSO_REQUIRED`
with message `sso_required` once the team target is authorized. Lists omit enforced
teams and invitations the caller cannot read. Clearing active organization remains
available. Team mutations recheck proof on their committing connection.

Team invitation mail, host-initiated poll invitation mail and Slack sample deliveries
recheck their initiating browser session before delivery. Queued requests without that
session cannot act for an enforced team. Booking reminders, mail, webhooks, workflow
dispatch, calendar reconciliation and public waitlist work use their existing lifecycle
authority.

中文：Better Auth 的团队操作和受信服务调用会检查同一份 SSO 凭证。已经确认团队访问范围的请求
缺少凭证时，返回 `403 SSO_REQUIRED`。团队列表和邀请列表会省略无权读取的项目。用户仍可清除
当前团队。团队写入提交前会在同一事务中复查凭证。团队邀请邮件、主持人发起的投票邀请邮件和
Slack 测试投递会在发送前复查发起者的会话。预约提醒、邮件、Webhook、工作流、日历同步及公开
候补名单继续按各自的生命周期规则处理。

Enabling enforcement requires a verified domain, an enabled tested provider of a protocol
that is currently on and supports step-up, a successful owner SSO test against the exact
current revision, and at least one usable recovery owner: a current owner with accepted
recovery status. Until SAML step-up ships, only OIDC qualifies. A pending nomination does
not count. An owner can enable enforcement before any owner or admin has linked an SSO
identity. The independent linking flow remains available, and an accepted recovery owner
can turn enforcement off if nobody can finish linking. Only an owner can change
enforcement or recovery. Owners and admins can prepare replacements, and an enforced team
must retain a usable provider. Policy, provider, recovery and membership changes serialize under the
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

中文：启用强制 SSO 需要已验证域名、支持重新认证的已启用提供者、所有者通过当前版本的测试，
以及至少一名已接受提名的现任恢复所有者。SAML 重新认证上线前，只有 OIDC 提供者符合条件。
团队可在所有者或管理员关联身份前启用强制 SSO。独立关联流程仍可使用，恢复所有者也可关闭强制要求。

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

If every recovery owner's mailbox is lost, an instance operator can turn off the
affected team's enforcement using the [operator recovery runbook](#operator-recovery-runbook).
This invalidates the team's current SSO proofs and delegations, records a `system`
audit event and queues notices to the team's owners.

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

When an enforced team is selected during MCP OAuth authorization, approval requires a
live browser proof for that team. The first approval saves the connection so its owner
can bind it, and returns `sso_required` until the binding is ready. Retry the same
browser approval while its authorization is still valid to return to the connecting app.
Team SSO sign-in can also return to the original signed OAuth authorization page.
Moving an API key to a different space ends its previous binding in the same transaction.
Rebinding records revocation of the previous lease and creation of the new one in the
audit log.

选择强制 SSO 的团队进行 MCP OAuth 授权时，审批需要该团队的有效浏览器证明。首次审批会
保存连接，供所有者绑定；绑定前返回 `sso_required`。绑定后，在授权仍有效时重试同一次审批
即可返回连接应用。通过团队 SSO 登录后也可返回原先已签名的 OAuth 授权页面。API 密钥切换
空间时会在同一事务中撤销原绑定。重新绑定时，审计日志会记录旧租约撤销及新租约创建。

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
callback. The lower bound uses the OIDC authorization attempt created at step-up initiation.
SAML step-up sends `ForceAuthn="true"` and requires a signed AuthnStatement `AuthnInstant`
within the same bounds, using `clockSkew`. An OIDC token with a missing `auth_time` proves
only the linked identity and adds `mailbox`. A signed OIDC `auth_time` outside the allowed
window is refused. The result must come from the attempt's own user
and that user's existing link at that provider; it is recorded on the pending attempt
and creates no session, browser proof or link. It expires at the earlier of attempt
expiry and the authentication instant plus `freshAdministrationProof`. For the missing-claim
fallback, receipt time caps the identity result until the mailbox is also proven. Silent IdP SSO,
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
validate its signature, exact `iss`, `aud` (including `azp` for multiple audiences
and explicit trust for each additional audience),
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

The internal verifier is in place while both protocols stay hard-off. It accepts only
signed RS256 ID tokens with a matching attempt nonce. It returns the exact issuer and
subject and, when present, the signed `auth_time` used by step-up.
Sign-in attempts use a fresh S256 challenge and an authenticated state envelope. The
attempt row binds that state to the initiating browser, provider revision and team, and
only one callback can take the verifier and nonce. The OIDC sign-in adapter uses these
helpers behind the protocol switch.

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

The internal timing and replay module returns the unskewed acceptance deadline for the
later completion step. The replay write checks database wall time again after the insert
can wait on a competing transaction. It stores only ID digests, and its bounded cleanup
removes expired rows.

The shared sign-in POST starts SAML `sign_in` for an enabled provider in in-process
tests. It creates an HTTP-Redirect AuthnRequest with an issuer and ACS URL derived from
`PUBLIC_URL` and the provider ID. It commits the attempt before returning the URL and
the existing HttpOnly, SameSite=Lax, Path=/ binding cookie (Secure and `__Host-` on HTTPS).
The attempt stores the request ID through its row ID, plus the SHA-256 digests of the
binding and the opaque RelayState. Its deadline is 600 seconds from the database clock,
with no skew on request expiry. An encrypted cookie tied to the request keeps the
validated `returnTo` under `/app` until completion. SAML stays hard-off. Selecting an
enabled SAML provider returns `404 sso_disabled` while OIDC follows its operator setting,
default false.

进程内测试可发起 SAML 登录。服务器先保存请求标识、RelayState 和浏览器绑定的摘要及过期时间，
再返回身份提供方的跳转 URL 并设置绑定 Cookie。请求有效期为 600 秒。SAML 在生产环境保持关闭，
选择 SAML 提供方会返回 `404 sso_disabled`。OIDC 登录仍由原有设置控制，默认关闭。

In-process SAML fixtures can complete sign-in for an already-linked persistent NameID
scoped to the configured IdP and SP, with its previously proven email. The ACS verifies
the signed assertion and commits request consumption, replay digests and the pending
attempt together. The pending attempt lasts
up to 300 seconds and cannot outlive the initiating request. The ACS redirects
to a confirmation form and sets an encrypted, HttpOnly pending-result cookie. The GET is
inert. The form POST requires the exact instance origin and the original browser binding.
Before issuing a session and browser proof, it rechecks the assertion deadline, provider
revision, live link, team membership and domain claim. The pending result is used once and
its cookies are cleared on success. A missing, expired or wrong-browser result returns
`400 sso_saml_completion_invalid`. Production ACS and completion return `404 sso_disabled`.

进程内测试可用已关联的持久 NameID 和已验证邮箱完成 SAML 登录。ACS 校验签名后保存待确认结果，
并将浏览器转到确认页面。在发起登录的浏览器中选择**继续登录**，服务器会重新校验断言有效期和账号
的团队访问资格，然后创建会话及浏览器凭据。待确认结果只能使用一次。生产环境中 ACS 和确认端点
均返回 `404 sso_disabled`。

In-process tests also support self-linking through the existing `linkSsoAccount` operation.
A team member first verifies their Hourmere mailbox. After the IdP returns a signed
assertion for that mailbox, the member selects **Link account** in the original browser
and session. The link uses the IdP- and SP-scoped persistent NameID by default. Set
`saml.subjectAttribute` when creating a provider to use one exact, immutable attribute
instead. It must have one nonempty value and cannot be an email address. The choice is
fixed for that provider. The member's own Settings summary shows their SAML providers,
pending links and opaque link IDs while SAML is enabled in-process.

When a linked subject asserts a different email address, Hourmere asks the browser to
verify that mailbox through the existing email proof flow. The prompt and message are
identical whether or not another account holds the address. After verification, Hourmere
can disclose a collision to that mailbox holder and leaves the existing link unchanged.
The production SAML switch stays off and the link operation returns `404 sso_disabled`
for SAML.

进程内测试可通过现有的 `linkSsoAccount` 操作关联 SAML 账号。团队成员先验证自己的 Hourmere
邮箱，身份提供方再返回使用同一邮箱的签名断言，成员随后在原浏览器及会话中选择**关联账号**。
系统默认使用限定于身份提供方和服务提供方的持久 NameID。创建提供方时可用
`saml.subjectAttribute` 固定一个不可变的属性名，该属性必须有唯一且非空的值，且该值不能是
邮箱地址。设置页面仅显示当前成员自己的 SAML 提供方、待处理的关联和不透明的关联标识符。

如果已关联的身份改用另一邮箱，Hourmere 会通过现有邮件流程要求验证。无论该邮箱是否已被
其他账号使用，验证提示和邮件内容都相同。验证后才会向邮箱持有人告知冲突，原有关联保持不变。
生产环境仍关闭 SAML，SAML 关联请求返回 `404 sso_disabled`。

SAML identity recovery uses `unlinkSsoAccount` with independent mailbox proof and
`removeSsoIdentityLink` with fresh administration proof. Both apply the same team and
owner rules, exact link generation, and link-scoped revocation as OIDC. While SAML is
enabled in-process, the browser-session provider inventory supplies the opaque SAML
link IDs and generations for retirement. A conflicting subject stays bound until its
link is explicitly retired. The member can then sign in locally and explicitly link
the subject on a team without enforcement. While SAML is hard-off, both operations
return `404 sso_disabled` for SAML links before creating a proof attempt. OIDC recovery
remains available while `SSO_OIDC_ENABLED` is off.

SAML 身份恢复沿用 `unlinkSsoAccount` 和 `removeSsoIdentityLink`。前者要求独立邮箱证明，后者要求
新的管理权限证明。团队及所有者权限、精确关联代数和按关联撤销凭据的规则与 OIDC 相同。进程内
启用 SAML 时，浏览器会话的提供方列表会显示解除关联所需的不透明关联标识符和代数。身份发生冲突时，
须显式解除旧关联。未启用强制单点登录的团队成员随后可用原有方式登录，再显式关联 SAML 身份。
SAML 保持关闭时，这两个操作对 SAML 关联均在创建证明尝试前返回 `404 sso_disabled`。关闭
`SSO_OIDC_ENABLED` 时仍可恢复 OIDC 关联。

For an unlinked subject, the SAML ACS redirects to `/app/mailbox-proof` with the
opaque attempt ID and `saml=1` in the fragment. The redirect and queued verification
email are identical for existing accounts and unclaimed addresses.
After verifying the mailbox, submit the attempt from the original browser to the
existing SAML completion endpoint. Each successful resolution consumes the result once.
An existing account receives `link_required` and must sign in independently to link.
An eligible new account can join through JIT or explicitly accept a current invitation
using `X-Hourmere-Sso-Attempt` on the existing invitation endpoint. Both protocols apply
the same signup, inviter, domain, capacity and removal checks. While SAML is hard-off,
SAML completion and SAML invitation acceptance return `404 sso_disabled`, including
when OIDC is enabled.

未关联的 SAML 身份统一跳转到 `/app/mailbox-proof`，网址片段中包含不透明的尝试标识和
`saml=1`。无论邮箱是否已有 Hourmere 账号，跳转和排队发送的验证邮件均相同。验证邮箱后，
须在原浏览器向现有 SAML 确认端点提交尝试标识。每个结果只能成功使用一次。已有账号会收到
`link_required`，须用原有方式登录后显式关联。符合条件的新用户可通过 JIT 入组，也可在现有
邀请接受端点用 `X-Hourmere-Sso-Attempt` 显式接受有效邀请。两种协议采用相同的注册、邀请人、
域名、团队名额和移除检查。生产环境仍关闭 SAML，即使启用了 OIDC，SAML 确认和 SAML 邀请接受
仍返回 `404 sso_disabled`。

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
parses it at startup, empty by default, and server composition passes it to guarded OIDC
sign-in. It routes nothing while OIDC stays hard-off. Each of at most 32 entries is one exact
`host:port`, `IPv4:port` or `[IPv6]:port`, without networks, wildcards or port ranges; an
IP entry must be RFC1918, loopback or IPv6 unique-local space, never metadata or
link-local. A request URL's exact host and port must match an entry, so a different port,
or another name that resolves to the same address, does not. The operator trusts that
exact target, so every DNS answer may be eligible private or loopback space. A listed name
with public syntax, a dotted DNS name without a special-use suffix, may instead have every
answer public: that is how a public IdP on a non-default port, such as
`https://idp.example.com:8443`, is reached. A listed name without public syntax, a single
label such as `keycloak` or a name under `.local`, `.internal`, `.localhost`, `.home.arpa`,
`.test`, `.example`, `.invalid` or `.onion`, accepts only private or loopback answers. If a
search domain, wildcard DNS or NXDOMAIN rewriting expands such a name to a public address,
the request is therefore refused before any connection opens. Answers that mix the two, or
that include metadata, link-local, IPv4-mapped or other reserved space, are refused. Hosts
that are not listed keep the default rules above: public answers only, on the default port
only, and no private routing. HTTPS stays required, and a listed target is fetched like any
other: the validated address is pinned to the socket and TLS verifies the original
hostname.
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

The Audit actions step built this vocabulary. The [SSO actions](audit-log.md#sso-actions)
are defined in `packages/db/src/sso-audit.ts` and checked by migration 0085. Later steps call
`writeSsoAuditEvent` inside the transaction of the change they record, so a rollback removes
the event with the change, and `writeSsoSecurityFailure` for a security failure. The
provider and correlation IDs must be stored provider and attempt IDs (UUIDv7); the checks
enforce that shape, which refuses a secret, a token, an assertion, a mailbox capability or an
IdP subject of any other shape. The source of a security failure is its action: a failed
sign-in, a rejected replay, a JIT refusal or a link conflict. Audit limits below pins the
bound.

## Pinned operational limits

These are initial design commitments. The doc-fact test binds implemented limits to
their runtime constants and pins the remaining values until their implementations land.
The SSO transport and audit limits are runtime constants already and have their own
tables below. Other resource limits must be selected with fixtures before their release.

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

### Audit limits

The Audit actions step chose the bound on security-failure events. The values are the runtime
constants `SSO_AUDIT_LIMITS` in `packages/db/src/sso-audit.ts`, which the doc-fact test
imports to pin this table.

| Limit | Value | Unit |
|---|---:|---|
| `ssoSecurityFailureEvents` | 20 | events |
| `ssoSecurityFailureWindow` | 3600 | seconds |

`writeSsoSecurityFailure` records a failure only while fewer than `ssoSecurityFailureEvents`
failures of the same provider and source were recorded in the last `ssoSecurityFailureWindow`
seconds, by the database clock; it drops the rest and reports that it did. With four sources, one
provider records at most 80 failures an hour, however many attempts fail. A transaction-level
advisory lock per provider and source serializes the count and the insert, so a burst of
parallel failures cannot exceed the bound, and a failure already past the bound is dropped from
an unlocked count without waiting for that lock. Callers write a failure after the request's
own transaction has settled, with the team, provider and protocol of the provider they loaded.
A provider's successes and changes are never dropped: only security failures are bounded. The
cost is that junk failures can fill a window and hide later failures of the same source until
the window slides.

## Proposed REST, MCP and CLI contracts

Status sentences in this section were written as each step landed. Since the OIDC
setting step, "OIDC hard-off" in them means `SSO_OIDC_ENABLED` off, which is still the
default: operations that add trust answer `404 sso_disabled` as described, while reads,
recovery and trust-reducing operations follow
[Setting-off behaviour](#rollout-gating) and stay available. SAML is still hard-off.

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
| `sso_last_provider` | 409 | Disabling or retiring the last usable provider is refused while the team enforces SSO |
| `sso_recovery_required` | 409 | Enforcement needs at least one usable recovery owner (a current owner with accepted status), the last recovery owner tries to leave, be removed or lose the owner role, or the account affected by a link retirement lacks a verified login mailbox |
| `sso_mailbox_proof_invalid` | 400 | Mailbox proof consume refused: unknown, expired, consumed or another attempt's token, another browser, session or person, or a provider no longer at the attempt's revision, all with one identical response |
| `sso_oidc_completion_invalid` | 400 | The OIDC completion result or its own mailbox proof is missing, expired, consumed, bound to a different browser or no longer current |
| `sso_saml_completion_invalid` | 400 | The SAML completion result or any required mailbox proof is missing, expired, consumed, bound to a different browser or no longer current |
| `sso_invitation_required` | 409 | The proven SSO subject needs explicit acceptance of a current team invitation |
| `sso_email_collision` | 409 | The independently proven new mailbox belongs to another account. Only the browser completing its own attempt can receive this response after proof |
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
| POST `/providers/P/activation` | `activateSsoProvider` | Session: changing which providers can authenticate a team requires fresh interactive owner proof. |
| PUT `/policy` | `setSsoPolicy` | Session: enforcement/admission changes require interactive proof and owner authority for enforcement. |
| POST `/recovery` | `configureSsoRecovery` | Session: nominating a recovery owner requires interactive owner proof; the nominee accepts separately. |
| POST `/recovery/{enrollmentId}/accept` | `acceptSsoRecoveryEnrollment` | Session: the nominated owner must independently prove their own mailbox and consent. |
| POST `/recovery/use` | `useSsoRecovery` | Session: recovery grants narrow authority to the freshly mailbox-authenticated enrolled owner. |
| POST `/providers/P/link` | `linkSsoAccount` | Session: explicit self-linking requires independent local proof and a browser-bound IdP ceremony. |
| DELETE `/providers/P/link` | `unlinkSsoAccount` | Session: removing the caller’s identity binding requires independent local proof. |
| DELETE `/providers/P/links/{linkId}` | `removeSsoIdentityLink` | Session: retiring a conflicting member identity requires fresh administrator proof. |
| POST `/delegations` | `bindSsoDelegation` | Session: binding an owned API key or OAuth grant requires fresh interactive SSO proof. |
| DELETE `/delegations/{bindingId}` | `revokeSsoDelegation` | Session: withdrawing the caller's delegated SSO proof requires the owning browser session. |

Provider and policy reads ship on all three surfaces and have explicit required-read
entries in the parity guard. Require owner/admin plus `read`/`full` API key or authorized MCP
OAuth `mcp:tools`, subject to SSO enforcement. Ordinary members get their own required
provider/proof summary through an additive session-only `/api/v1/me` projection,
not administrator inventories. No first-release machine write changes SSO trust.

With the internal OIDC capability enabled, `GET /api/v1/me` adds an optional `sso`
object for a current member's active team session. It contains `requireSso`, enabled
providers' IDs, display names and revisions, the caller's live links as opaque IDs
with their provider IDs and generations, and valid proofs for this session with their provider IDs
and expiry times. The `attempts` array shows pending self-link attempts that belong
to the session and its original browser. Each reports its ID, provider ID (null
during fresh proof), phase, mailbox proof status and expiry. A browser session that
lacks proof for an enforced team keeps its active organization ID for enrollment and
receives empty organization name and slug strings. Unbound team API keys receive
`403 sso_required` on private REST reads including `/me`. Private MCP reads including
`whoami` return a tool error with `sso_required` for unbound API keys and OAuth grants.
The `sso` object is separate from the optional recovery team list described above.
While both protocols are hard-off, `/me` omits both fields and an enforced team's
browser proofs cannot satisfy the policy. While the OIDC setting is off, `/me` keeps
`sso` only for a team with stored SSO state (an enforced or JIT policy, a provider or a
domain claim): it lists the caller's own links, no provider and no pending attempt, and
suspended proofs are not live.

内部开启 OIDC 时，`GET /api/v1/me` 为当前团队成员的活动团队会话增加可选的 `sso`
对象。它包含是否强制 SSO、已启用提供商的标识、显示名称与版本、本人有效关联的
不透明标识、代数及对应提供商，以及当前会话有效证明的提供商与到期时间。`attempts`
仅列出原发起浏览器与会话中待处理的自助关联尝试，并提供尝试标识、提供商标识
（新鲜证明阶段为 null）、阶段、邮箱证明状态与到期时间。若当前团队强制 SSO，
未持有效证明的浏览器会话仍可获得登记所需的组织 ID，组织名称和标识符为空字符串。
缺少绑定的团队 API 密钥读取私有 REST 数据（包括 `/me`）时会收到
`403 sso_required`。缺少绑定的 API 密钥和 OAuth 授权调用私有 MCP 读取工具
（包括 `whoami`）时会收到 `sso_required` 工具错误。`sso` 对象与上文的可选恢复团队列表
分别返回。两种协议均在代码中关闭时，`/me` 省略这两个字段，浏览器证明无法满足已存储的
强制策略。

The built draft reads use the current team context and freshly check verified owner/admin
membership. `listSsoProviders` accepts `limit` (1–100, default 50) and `cursor`; it returns
`{data, nextCursor}` in provider-ID order, omits retired providers, and binds the cursor
to the team. Each provider exposes `id`, `protocol`, `revision`, `enabled`, `displayName`,
`issuer`, nullable `clientId`, `createdAt`, `validationStatus`, `testStatus` and `domains`.
Domain summaries expose only `id`, `name`, `generation` and `status`; failed and unknown
checks remain distinct. Validation status is currently `unknown`. Test status reflects
the latest `passed` or `failed` receipt at the current revision, or `unknown` if no
applicable receipt is retained. These reads use the audit journal without opening the
sealed provider configuration. The active team's owner/admin browser sessions also receive
`links: [{id, generation}]` for OIDC providers and for SAML providers while the SAML
capability is enabled, limited to current members and live links.
`getSsoPolicy` returns `requireSso`, `admission`, `policyRevision` and `trustGeneration`;
a team without a stored policy gets `false`, `invitation_only`, `1` and `1` respectively.
No read creates a policy, changes trust or emits an audit event.

当前草稿读取仅允许当前团队中已验证的所有者或管理员使用；API 密钥须具有 `read` 或
`full` 范围，MCP OAuth 须具有 `mcp:tools` 权限。提供者列表按团队分页，不返回已退役
提供者、密封配置、密钥或原始元数据。当前团队的所有者或管理员通过浏览器会话可查看现有成员的
有效关联不透明标识和代数，适用于 OIDC 提供者和进程内启用 SAML 时的 SAML 提供者。验证状态
目前为 `unknown`，测试状态仅显示当前版本的最新收据。没有适用收据时，测试状态为 `unknown`。

Provider draft writes are registered as browser-session-only POST/PATCH/DELETE operations,
with no MCP tool or CLI write command. Creating and updating require the provider's protocol
to be enabled. Verified team owners/admins must send the exact Origin and
`X-Expected-Organization-Id`, then
complete the operation-bound fresh-proof retry. New providers are disabled; edits require
`expectedRevision`. Omitted secrets are preserved and returned summaries never include
sealed configuration or secrets. Changing trust configuration or retiring a provider
increments the team trust generation; changing its display name alone does not.
Changing the OIDC issuer/client ID or SAML IdP entity ID requires a replacement provider.
Deletion retires the record and an authorized repeat deletion is idempotent.
`SSO_ENCRYPTION_KEY` is an optional independent 32-byte base64 key for sealing drafts.
Keep it stable and back it up privately; configuring it never enables a protocol.

提供者草稿的创建、修改和删除仅允许浏览器会话使用，没有 MCP/CLI 写命令。
创建或修改要求对应协议已启用。SAML 在生产环境保持关闭，请求返回 `404 sso_disabled`。
已验证的团队所有者或管理员必须提供同源请求、预期团队和操作绑定的新鲜证明。
修改须携带预期版本；省略密钥会保留旧值，响应不回显密钥或密封配置。
信任配置变更和退役会递增团队信任代次，仅修改显示名称不会；重复退役具有幂等性。
可选的 `SSO_ENCRYPTION_KEY` 是独立的 32 字节 base64 密钥，应保持稳定并私下备份；
配置此密钥不会启用任何协议。

Every write except `revokeSsoDelegation` accepts an optional opaque `proofAttemptId` in
its strict input for the fresh-proof retry below. DELETE operations carry their strict
JSON body, which OpenAPI 3.1 permits. Create accepts `{protocol, displayName, domainIds,
oidc?, saml?, proofAttemptId?}`; OIDC has issuer,
clientId and write-only clientSecret. The SAML `saml` object accepts `entityId`, `ssoUrl`
for the IdP's HTTP-Redirect endpoint and `signingCertificates` for its pinned RSA signing
certificates. It can import those fields from either `metadataDocument` or `metadataUrl`.
The server fetches metadata URLs through the SSO transport after fresh proof, validates
the XML through the verifier's bounded parser, and seals the resulting configuration.
An import requires a single SAML 2.0 IdP entity and one HTTP-Redirect endpoint. Explicit
values must agree with any values present in the document. For a document without signing
keys, supply `signingCertificates` in the same request. Reimporting metadata is an
explicit update. To rotate a signing key, update the
certificate list with the old and new certificates, test the new revision, then remove
the old certificate after the IdP switches. A pin-set change records a certificate rotation
audit event. `wantAssertionsSigned` defaults to `true`
and only accepts `true`. The SP metadata endpoint publishes `WantAssertionsSigned="true"`,
the stable SP entity ID and the exact HTTP-POST ACS URL for the provider, including a
disabled draft. It derives both URLs from `PUBLIC_URL` and returns only the SP metadata.
SAML stays hard-off in production. Server-generated callback URLs cannot be supplied by
the caller. Return `{provider}` with id, protocol,
revision, enabled, safe display fields and validation/test status; never echo secrets,
raw metadata or identities. New providers are disabled. Update takes `{expectedRevision,
displayName?, domainIds?, oidc?, saml?, proofAttemptId?}` and delete takes
`{expectedRevision, proofAttemptId?}`; trust edits invalidate tests, pending attempts
and live proofs.
A changed identity tuple requires a replacement provider. Repeating the delete of the
team's own retired provider succeeds idempotently for an authorized caller; every other
operation on a retired ID returns `sso_not_found`.

SAML 的 `saml` 对象支持 `entityId`、用于 HTTP-Redirect 的 `ssoUrl` 和固定信任的 RSA 签名
证书列表 `signingCertificates`，也可通过 `metadataDocument` 或 `metadataUrl` 导入这些字段。
服务器在完成新鲜证明后使用受限的 SSO 传输下载元数据，经验证器使用的受限 XML 解析器处理，
并密封保存解析后的配置。每份文档须含一个 SAML 2.0 IdP 实体和一个 HTTP-Redirect 端点。
显式填写的值须与文档一致；如果文档未包含签名密钥，须在同次请求提供 `signingCertificates`。
重新导入须显式提交修改。轮换时先同时保留旧证书和新证书，并测试新版本；
身份提供方切换签名密钥后再移除旧证书。证书集合变更会记录轮换审计事件。
`wantAssertionsSigned` 默认为 `true`，且只接受 `true`。
SP 元数据端点也支持禁用的草稿，公布固定的 SP 实体 ID、精确的 HTTP-POST ACS 地址和
`WantAssertionsSigned="true"`。两个地址均由 `PUBLIC_URL` 派生。更改身份提供方实体 ID 须创建替代提供者。

Provider activation takes `{expectedRevision, enabled, proofAttemptId?}` and returns the
same safe `{provider}` summary. A verified current team owner must use a browser session
with the exact Origin, expected organization header and fresh administration proof.
A team without enforcement uses mailbox proof. An enforcing team requires SSO step-up,
with mailbox proof as well if the IdP cannot prove a fresh sign-in. An enrolled recovery
owner can spend one browser recovery grant to satisfy fresh administration. Enabling requires a
passed test for the exact current revision and at least one associated, unexpired verified
domain with a positive latest recheck. Disabling the last usable provider while enforcing
SSO returns `409 sso_last_provider`. Another enabled, non-retired provider can satisfy the
guard if its protocol is on, it supports step-up, and it has an unexpired verified domain.
Until SAML step-up ships, only OIDC providers count. A failed recheck freezes
new activation while the existing provider can still serve that domain until verification expires.
Changing activation state keeps the provider revision and records an audit event.
Disabling also increments `trustGeneration`. An authorized request to enable an already
enabled provider still checks the current prerequisites.
When the provider protocol is off, enabling returns `404 sso_disabled` and disabling stays available.

提供者启停仅限当前团队中邮箱已验证的所有者使用浏览器会话发起，须提供同源请求、预期团队、
预期提供者版本和操作绑定的新鲜证明。未强制 SSO 的团队使用邮箱证明；已强制的团队需要 SSO
重新认证，身份提供方无法证明本次认证足够新时，还须提供邮箱证明。已登记的恢复所有者也可以
使用一次浏览器恢复授权完成新鲜管理验证。启用前，当前版本必须通过测试，
且至少一个关联域名的验证仍有效、最近一次复查通过。已强制 SSO 的团队停用最后一个可用提供者时，
会收到 `409 sso_last_provider`。启停变更保留提供者版本并写入审计日志，停用还会递增信任代次。
协议关闭时，启用提供者返回 `404 sso_disabled`，停用仍可用。SAML 在生产环境保持关闭。

Domain challenge takes `{domain, proofAttemptId?}` and returns `{domain: {id, name,
status}, txtName, txtValue, expiresAt}` once; repeated creation rotates rather than
recovering the value. Verify/delete take `{expectedGeneration, proofAttemptId?}`.
Domains are organization-owned and providers
reference their IDs; the provider inventory includes safe domain status/generation.
The three domain writes are browser-session-only. While no protocol is on, creating a
challenge and verifying return `404 sso_disabled` and deleting a claim stays available; they have no MCP tools or CLI commands. With the internal
test capability enabled, each requires a verified current team owner/admin, the exact
Origin, expected organization header and operation-bound fresh administration proof. A new
challenge lasts 24 hours and rotates the generation; the TXT value is returned only once.
Names are normalized to lowercase IDNA ASCII and one trailing DNS root dot is removed.
Wildcards, IPs, special-use names, public suffixes (including private suffixes) and known
public mailbox namespaces are refused; the mailbox restriction also covers subdomains.
The normalized name must fit the 253-byte TXT owner limit including `_hourmere-sso.`.
The mailbox list covers
Gmail/Googlemail, Outlook/Hotmail/Live/MSN, Yahoo/Ymail/Rocketmail, AOL, iCloud/Me/Mac,
Proton/Protonmail/PM, Fastmail, Hey, Mail.com, GMX, QQ, 163/126 and Yandex.
Parent and child domains remain separate exact claims.
Verification returns the safe domain summary and verification/recheck deadlines. A DNS
outage returns `unknown`, never a successful ownership proof. Pending claims do not reserve
names, and another team's verified or suspended claim remains exclusive until retirement.
Deleting a claim retires its ID. These operations never create accounts or memberships,
move personal spaces or enable a provider. Scheduled rechecks and operator retirement
follow the [domain lifecycle runbook](#domain-lifecycle-operations) below.

域名挑战、验证与退役只允许浏览器会话调用，没有 MCP 工具或 CLI 命令。
OIDC 和 SAML 仍在代码中关闭，三个接口均返回 `404 sso_disabled`。内部测试开启后，
当前团队中已验证的所有者或管理员须提供同源请求、预期团队和操作绑定的新鲜管理证明。
域名转换为小写 IDNA ASCII，并移除一个末尾根点；拒绝通配符、IP、特殊用途名称、
公共后缀（含私有后缀）以及已知公共邮箱域名及其子域名。父域名与子域名须分别证明。
挑战有效期为 24 小时；重新创建会轮换代次，TXT 值只返回一次。DNS 故障显示 `unknown`，
不能视为所有权已验证。未验证挑战不占用域名；其他团队已验证或过期暂停的声明不会被抢占。
退役保留声明 ID，域名验证不会创建账号、加入团队、移动个人空间或启用提供者。
定期复查与运营者退役命令仍属于后续的域名生命周期工作。

The OIDC test takes `{expectedRevision, proofAttemptId?}` and applies to a disabled draft
under ordinary fresh administration. On an enforced team a recovery owner can spend a
grant to test the current revision of an enabled provider as well.
A verified current team owner or administrator
submits the exact Origin and `X-Expected-Organization-Id`, completes fresh administration
proof, and repeats the same revision and input with `proofAttemptId`. For a team without
enforcement, the proof comes from the administrator's Hourmere mailbox. The successful
retry returns `{url, attemptId}`. Open the URL in the initiating browser and keep the
original Hourmere session. The shared OIDC callback uses the same PKCE, state and ID-token
verification as sign-in, then returns to `/app/settings`. Follow provider inventory to
read the result. The callback requires the same verified administrator, session, browser
and provider revision even if the provider authenticated a different person. A recovery
test also binds the provider's activation state, the recovery enrollment and its deadline.
The callback completes only that test intent. It records
`sso_provider.tested` with the attempt ID and the safe result. The receipt preserves
whether the tester held the owner role at completion. A revision change ends in-flight
tests and invalidates earlier receipts for that provider. While `SSO_OIDC_ENABLED` is
off the REST operation returns `404 sso_disabled`.

使用常规新鲜管理验证时，OIDC 测试仅适用于禁用的草稿。已强制 SSO 的团队中，恢复所有者可
使用一次恢复授权测试已启用提供者的当前版本。当前团队中已验证的所有者或管理员须提供同源请求和预期
团队，完成新鲜管理证明后，以相同版本及输入携带 `proofAttemptId` 重试。未启用强制
SSO 的团队使用管理员自己的 Hourmere 邮箱完成证明。重试成功后，在原浏览器和原会话
中打开返回的 `url`。回调验证 OIDC 响应，返回设置页，并记录当前版本的测试结果；所有者
的测试记录会保留其当时的角色。恢复测试还绑定启停状态、恢复登记和授权期限，回调只可完成
该次测试。测试状态可在提供者列表查看。任何版本变更都会使之前的
测试收据失效。测试不会创建账号、身份关联、团队成员或登录会话。两种协议仍在代码中保持
关闭，接口返回 `404 sso_disabled`。

SAML uses the same test operation, expected revision and fresh administration flow.
An enforcing team uses OIDC step-up until SAML step-up ships. A recovery owner can
update, test and re-activate the provider using three separate recovery grants.
Follow the authorization URL in the initiating browser, then select **Continue**
on the SAML completion page. The ACS verifies the response and stages its result.
Completion checks the initiating browser, session and administrator, the provider
revision and, for recovery tests, the enrollment, activation state and grant deadline.
It returns to settings and writes the revision-bound receipt for the inventory.
The test can authenticate an IdP identity without enrolling it. SAML stays hard-off
and testing a SAML provider returns `404 sso_disabled` in production.

SAML 使用同一测试接口、预期版本和新鲜管理证明流程。在 SAML 重新认证交付前，已强制 SSO
的团队使用 OIDC 重新认证。恢复所有者可以分别使用三次恢复授权来修改、测试和重新启用提供者。
请在发起测试的浏览器中打开授权 URL，并在 SAML 确认页面选择**继续**。ACS 校验响应并暂存结果。
确认时会核对原浏览器、会话、管理员和提供者版本。恢复测试还核对恢复登记、启停状态和授权期限。
确认后返回设置并写入当前版本的测试回执，结果可在提供者列表中查看。测试不会注册 IdP 身份。
生产环境中 SAML 保持关闭，测试 SAML 提供者返回 `404 sso_disabled`。

The OIDC self-link operation takes `{proofAttemptId?}` and applies to an enabled provider
in the caller's active team. A current member uses their existing browser session and
submits the exact Origin and `X-Expected-Organization-Id`. The first POST requests
independent Hourmere mailbox proof, including on a team with SSO enforcement. After
completing that proof, the member repeats the request with its `proofAttemptId`.
The retry returns `{url, attemptId}` for use in the same browser and session.

The callback requires the signed IdP email to match the local mailbox proven for this
ceremony. The IdP's `email_verified` claim has no bearing on the Hourmere proof.
The callback redirects to `/app/settings#sso-link=<attemptId>` with a new, opaque completion
attempt ID. The browser submits that ID via an explicit same-origin POST to
`/api/auth/sso/oidc/complete`. Completion consumes the pending result once and checks the
same browser, session, account mailbox, membership and provider revision. A conflicting
link or expired result returns `400 sso_oidc_completion_invalid`. The provider's matching
domain must have a live verification with a positive latest recheck. Link initiation and
completion return `409 sso_domain_unverified` if that verification has failed. Successful
completion records the link and returns to `/app/settings`. It creates no membership,
session or SSO browser proof. Invitation-based admission is handled in the admission step.
While `SSO_OIDC_ENABLED` is off the link operation returns `404 sso_disabled`.

OIDC 自助绑定适用于当前团队中已启用的提供商。成员使用现有浏览器会话提交同源请求和预期
团队，完成 Hourmere 邮箱证明后，携带 `proofAttemptId` 重试。启用强制 SSO 的团队也需要
独立邮箱证明。成员须在原浏览器和会话中打开授权地址。回调校验 IdP 声明的邮箱与已证明的
本地邮箱一致，无论 IdP 的 `email_verified` 为何值。回调会将新的不透明完成标识放入设置页
地址片段，成员须明确提交同源 POST 才能完成绑定。完成时重新核对会话、成员资格、邮箱、
提供商版本和域名验证状态。成功后仅记录绑定，不创建成员资格、会话或 SSO 浏览器证明。
`SSO_OIDC_ENABLED` 关闭时，绑定接口返回 `404 sso_disabled`。

Policy takes `{expectedRevision, requireSso, admission, proofAttemptId?}` with
`admission` restricted to `invitation_only` or `jit`. `PUT /api/v1/team/sso/policy`
returns the resulting policy on success. Owners can change enforcement, and owners and
administrators can change admission. Enabling requires an enabled provider of an available
protocol with an owner test of its current revision, a positively rechecked and unexpired
linked domain, and a current owner who accepted recovery enrollment. The write records
`sso_enforcement.enabled`, `sso_enforcement.disabled` or `sso_enforcement.updated` with
the resulting revision when policy values change. Deactivation and retirement share the
same last-usable-provider guard. While `SSO_OIDC_ENABLED` is off, enabling, creating and
editing return `404 sso_disabled`; deactivation and retirement stay available.

策略写入成功后返回更新后的策略。只有所有者可以更改强制 SSO，所有者和管理员可以更改
准入模式。开启强制 SSO 需要已启用且协议可用的提供商、该版本通过所有者测试的记录、最近
一次复查通过且尚未过期的关联域名，以及已接受恢复登记的当前所有者。策略变更与版本审计
同时提交。强制 SSO 期间，最后一个可用的提供商无法停用或退役。两种协议仍在代码中保持
关闭，接口返回 `404 sso_disabled`。

Recovery enrollment takes
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
are distinct from IdP authentication.

As implemented, nomination returns `201` with `{enrollmentId, expiresAt, policyRevision}`
and queues an email to the nominee's verified Hourmere mailbox. The link carries the
team context, enrollment ID and resulting revision in its fragment. Opening it cannot
accept the nomination. The acceptance POST needs the expected-team header and the
nominee's own browser session and mailbox proof. It returns `204` without any team data
and queues confirmation to the nominator and nominee. Both writes advance `policyRevision`.
If another policy or recovery change intervenes, a stale revision returns
`sso_configuration_changed`. An expired, superseded or other owner's nomination returns
`sso_not_found`. Both operations return `404 sso_disabled` while both protocols are off.

提名成功后返回入组标识、到期时间和策略版本，并向受邀所有者已验证的 Hourmere 邮箱发送通知。
打开链接不会接受提名。受邀者须在自己的浏览器会话中验证邮箱，并提交接受请求。成功后返回
204，不返回团队数据，并通知提名人与受邀者。两个操作均更新策略版本。OIDC 和 SAML 都关闭时，
两个接口均返回 `404 sso_disabled`。

An accepted recovery owner starts browser recovery with `POST /api/v1/team/sso/recovery/use`.
Send the current `policyRevision` as `expectedRevision` and the recovery team's ID as
`X-Expected-Organization-Id` from the instance origin. The team must require SSO and
can differ from the active space. If the revision changes, the request returns
`409 sso_configuration_changed`.
Reload the current summary before starting again.
Complete the mailbox challenge and retry with `proofAttemptId`. A successful `204` grants
authority to that browser and session for the remainder of the mailbox proof window. It
records `sso_recovery.used` and queues a notice for the team's owners. The same proof can
start recovery once. Send the same team header on recovery reads and writes when
working from another space. Provider and policy reads leave the grant available and
return only SSO configuration when recovery supplies access. On an enforced team, an
owner can spend one grant to create, update, test or activate a provider, or to turn off enforcement with
`PUT /api/v1/team/sso/policy` and `requireSso: false`. Each successful write spends the
grant in its transaction. Updating, testing and re-activating a provider takes three
mailbox ceremonies. The grant ends at the mailbox proof deadline or when the browser loses its session or
current recovery ownership. Recovery use stays available while `SSO_OIDC_ENABLED` is off.

已接受提名的恢复所有者可在浏览器会话中启动恢复。请求须以 `X-Expected-Organization-Id`
指定恢复目标团队，并以 `expectedRevision` 传入当前策略版本。目标团队必须启用强制单点登录，可以与当前空间不同。
策略版本已变化时返回 `409 sso_configuration_changed`，请刷新摘要后重试。验证自己的
邮箱后使用同一个证明重试。成功返回 `204`，记录审计事件并通知团队所有者。在其他空间
恢复时，后续读写请求须带上同一个团队请求头。
恢复授权随邮箱证明一起到期，可反复查看 SSO 配置。在强制 SSO 的团队，可使用一次授权来
创建、更新、测试或启停提供者，或关闭强制单点登录。每项成功写入均在同一事务中消耗授权，
因此更新、测试和重新启用同一个提供者需要三次邮箱验证。
授权不能用于启用即时入组或访问其他团队数据。OIDC 和 SAML 均关闭时，接口返回
`404 sso_disabled`。

In the web app, a team owner nominates a current owner from **Settings → Team members**.
The nominee opens the email link in the nominated team, selects **Accept nomination** and
verifies their Hourmere mailbox within 72 hours. Opening the link alone does not accept it.

For an enforced team, **Settings → Single sign-on → SSO recovery** starts a mailbox
verification. The resulting grant lets the owner inspect the providers and make one change.
Save the repair, verify again to test the saved revision, and complete the provider test in
a new tab. Return to the recovery tab and verify again to enable the tested revision. The
owner can also spend a grant to stop requiring SSO while keeping the team's admission mode.
An enrolled owner can use the same Settings entry after an ordinary sign-in that lands
in personal space. Choose a team if more than one is eligible and select **Start recovery**
to begin mailbox verification. The session stays in its current space throughout recovery.
These controls stay available to a team with stored SSO state while `SSO_OIDC_ENABLED` is off.

OIDC sign-in uses session storage in the sign-in tab to restore the return URL
fragment. If storage is unavailable, sign-in can still finish and returns to the
accepted path and query. The fragment is lost.

在网页应用中，团队所有者可在**设置 → 团队成员**中提名当前所有者。受邀者在对应团队空间
打开邮件中的链接，选择**接受提名**，并在 72 小时内验证自己的 Hourmere 邮箱。仅打开
链接不会接受提名。

在强制单点登录的团队中，可从**设置 → 单点登录 → 单点登录恢复**开始验证邮箱。验证后，
所有者可查看身份提供方并进行一次更改。保存修复后，请重新验证邮箱，测试已保存的版本，
并在新标签页完成测试。回到恢复页面，再次验证邮箱后启用通过测试的版本。所有者也可使用
一次授权关闭强制单点登录，保留团队原有的入组方式。两种协议目前都在代码中关闭，生产环境
不会显示这些操作。已接受提名的恢复所有者在普通登录进入个人空间后，仍可打开同一设置入口。
若有多个符合条件的团队，请选择目标团队，然后点击**开始恢复**以验证邮箱。恢复期间会话留在原空间。

OIDC 登录使用登录标签页的会话存储来恢复回跳网址的片段。浏览器无法使用会话存储时，
仍可完成登录并返回已接受的路径和查询参数，但网址片段会丢失。

`bindSsoDelegation` takes `{credentialKind, credentialId, expectedTrustGeneration,
proofAttemptId?}`, verifies that the current team member owns the credential and
that it belongs to the current team, and returns `201` with `{id, expiresAt}`.
`revokeSsoDelegation` accepts an owned binding ID and returns `204` without a
response body. A current team browser session can withdraw its own delegation
without a live SSO browser proof or a fresh proof challenge. On an enforced team,
if OIDC is off while another protocol is on, revocation returns `403 sso_required`.
Both writes require the exact origin and `X-Expected-Organization-Id` for the current team.

The owner's API-key list (`GET /api/auth/api-key/list`) and OAuth connection list
(`GET /api/v1/mcp-oauth/connections`) can include `ssoDelegation: {id, expiresAt}`
on a credential with a live binding. Eligible team OAuth connection summaries also
include `credentialId`, the grant ID to use for binding. While both protocols are
hard-off, the lists omit these fields and both delegation writes return `404 sso_disabled`.

Both link-retirement operations take `{expectedLinkGeneration, proofAttemptId?}`.
Self-unlink also takes `linkId` from `/me`; administrator removal takes `linkId` from
the provider inventory and passes it in the path. The recovery endpoints use the
caller's active team membership. The ID and generation bind the request to the
original row even if a replacement link starts at the same generation. Verify the
affected member's request out of band before administrator removal. The operations
return 204 on success,
`sso_configuration_changed` for a stale live generation and `sso_not_found` for an
already retired link. A verified current login mailbox supplies the independent
email sign-in method, including when new sign-ups are closed. Retirement, link-specific
proof and delegation revocation, the `sso_link.unlinked` audit event and the affected
person's email notification job commit in one transaction. The notification goes to
the affected account's current verified login mailbox.

两种解除操作都要求关联代数。本人解除时从 `/me` 获取 `linkId` 并在请求体中提交，
管理员解除时在路径中提交 `linkId`，并应先通过其他渠道核实成员的恢复请求。成功返回
204。此操作撤销该关联的浏览器证明和委托，写入审计，并向受影响账户的已验证登录邮箱
发送通知。该邮箱继续支持登录，即使实例已关闭新用户注册。

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

The shared gate lives in `apps/server/src/sso-fresh-proof.ts`. Each browser-only write supplies
its strict input schema, transaction-time authorization/revision check and mutation callback.
The gate checks the
switch, exact Origin and absence of Authorization, freezes the canonical validated input
(excluding only the top-level `proofAttemptId`), and binds the attempt to the browser cookie,
user, session, team and operation. A missing binding cookie is issued as HttpOnly with
SameSite=Strict, Path=/, and Secure plus the `__Host-` prefix on HTTPS. The response adapter
must append that cookie and return the challenge as HTTP 403, after its attempt commits.
Successful proof consumption and the protected mutation share one transaction; a failed
mutation rolls back consumption. The database clock is read after the row locks, and an
expired recorded mailbox proof requires a new attempt. Teams without enforcement need
`mailbox`. A stored enforcement policy requires OIDC step-up for fresh administration.
Satisfying that proof requires an available OIDC protocol and an enabled provider where the
caller has a live link. The gate rechecks the recorded result's deadline, provider, link and
trust generation before consuming the attempt.
Independent local proof still requires `mailbox`.

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

As built in the Mailbox proof step (`apps/server/src/sso-mailbox-proof.ts`), both endpoints
are mounted ahead of Better Auth's `/api/auth/*` in every flag state and check, in this order:
the protocol switch (`404 sso_disabled` while both protocols are off, before anything else),
an `Origin` exactly equal to `PUBLIC_URL`'s origin with no `Authorization` header (otherwise
`403 forbidden`; a Referer never stands in), the strict JSON input (`400 invalid_request`) and
the per-source limit (`429 rate_limited`). The browser binding is a cookie
(`hourmere.sso_binding`, `__Host-` prefixed on https) whose SHA-256 the attempt stores; the
session-bound intents (test, link, fresh proof) also need the attempt's own unexpired session
and person, while a sign-in attempt needs only the browser. Send takes `{attemptId}` and
always answers `202 {"status":"queued"}`: it queues one job and never reads the attempt.
Only the worker decides: for an attempt that is unexpired, unconsumed, still awaiting its
mailbox proof, presented by its own browser (and session) and whose provider is still at the
frozen revision (and enabled, for a sign-in or link), it issues a 32-byte token, stores its
SHA-256 in place of the previous one and emails the frozen mailbox a link to the inert
`/app/mailbox-proof` page with the attempt ID and token in the URL fragment; the raw token is
in no job payload, table or log. The message has one template that names no account, team or
provider, and nothing looks up whether the address has an account. The token expires at the
earlier of the attempt's expiry and issuance plus `freshAdministrationProof`. Consume takes
`{attemptId, token}` and answers `200 {"status":"proven"}` once, recording the proof on that
attempt (`mailbox_proven_at`, with the token's expiry as the proof's); any other outcome,
whether unknown, expired at or after the exact instant, consumed or replayed, another
attempt's token, another browser, session or person, or a provider no longer as frozen, is
`400 sso_mailbox_proof_invalid`. Limits: 10 sends and 30 consumes per client address (IPv6
/64) per minute in each process; one queued job per attempt and browser, and a new token only
when the current one is at least 60 seconds old (database clock); per address, the existing
mail ledger with a recipient digest of its own purpose and the sign-in caps
(`SIGN_IN_MAIL_MAX_PER_HOUR`, `SIGN_IN_MAIL_MAX_PER_DAY`), counted in the shared instance
`MAIL_MAX_PER_HOUR` like sign-in mail; and the fifth wrong token from the attempt's own browser
deletes its token, counted in each process, so only a resend issues another (the 256-bit token
makes the count a backstop, not the protection). As for sign-in mail, the email is sent inside
the transaction that stores the token and counts it, so an email whose commit then fails holds
a dead link and the retry sends another. No SSO audit action describes a mailbox
proof, so the step records none; the operation the proof is for records its own event.

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

The OIDC adapter implements `sign_in` for an enabled OIDC provider. The POST requires
an exact `Origin` from `PUBLIC_URL` and refuses Authorization headers. It creates a
browser-bound attempt before returning `200 {"url": "…", "redirect": true}`.
Initiation preserves any existing binding value and issues the cookie with
SameSite=Lax for the provider's top-level GET callback.
The callback atomically consumes the state before exchanging the authorization code.
The S256 verifier binds that exchange to this attempt, and the IdP enforces single use
of its code. The state also pins the resolved endpoints through the callback. The
authorization endpoint must have no query parameters, so Hourmere controls all
authorization parameters. After ID token verification, the callback rechecks the provider revision,
the active domain claim, the linked issuer and subject, the proven IdP mailbox,
the linked account's verified status and team membership. The session, browser proof and success audit event
commit together. The proof expires at the first applicable deadline in
[Browser proof](#browser-proof), including a signed
`session_expires_at` claim when present, even if Better Auth later refreshes the session.

While `SSO_OIDC_ENABLED` is off, sign-in, callback and completion return
`404 sso_disabled` before checking their inputs or accessing the database.

已关联身份的 OIDC 登录沿用现有会话流程。发起登录时需校验 `Origin` 并将尝试绑定到浏览器；
回调仅使用一次授权码和状态，并在创建会话前重新检查提供商版本、域名声明、身份关联、
已证明的邮箱和当前团队成员资格。浏览器证明取适用期限中的最早时间，会话续期不延长证明。
OIDC 在生产代码中保持关闭，登录发起、回调和完成端点均返回 `404 sso_disabled`。

OIDC step-up uses the same initiation and callback. Its state binds the authorization
response to the pending write attempt, existing session and browser, provider revision,
linked identity and team trust generation. The callback checks those bindings both before
code exchange and when recording the result. A successful callback returns to `returnTo`
and the client retries the write with the same `proofAttemptId`. If the provider omitted
`auth_time`, that retry returns the same attempt with `mailbox` still required. Provider
discovery, code exchange and signing-key fetches run outside database transactions.

OIDC 二次验证沿用登录发起和回调端点，并要求身份提供方重新认证。回调在兑换授权码前及记录
结果时，都检查原写入尝试、浏览器、会话、提供方版本、身份关联和团队信任代数。完成后返回
`returnTo`，客户端用原 `proofAttemptId` 重试写入。如果令牌缺少 `auth_time`，重试会要求在
同一个尝试中补做邮箱证明。签名中的认证时间超出允许范围时，二次验证会被拒绝。只有 OIDC
已启用且团队已强制 SSO 并有活动的 OIDC 提供方时，管理写入才要求此验证。

When the OIDC callback sees a changed email for a linked identity, it stores a short-lived,
frozen result for the original browser and hands off to `/app/mailbox-proof` with the opaque
pending attempt ID in the URL fragment. The callback puts the validated result in an encrypted
HttpOnly cookie and binds it to the pending attempt with a stored digest. It issues no session
and retains no OIDC tokens. The result and mailbox proof request are the same whether the new
address belongs to another account or is unclaimed.

After recording proof with the mailbox endpoints, the original browser can submit
`POST /api/auth/sso/oidc/complete` with `{ "attemptId": "…" }`. Completion requires the
exact `PUBLIC_URL` origin and rejects Authorization headers. It consumes the pending
result and its proof once, rechecking the provider, domain, policy and current membership
in the same transaction. A missing, expired or already consumed result, or an attempt
without its own live mailbox proof, returns `400 sso_oidc_completion_invalid`. The
service uses only the callback's frozen result and does
not exchange the authorization code again. It reports `409 sso_email_collision` only after
proof and deletes the pending attempt with its mailbox data. The collision leaves the link's
proven address unchanged and exposes no address in the response or audit journal. Successful
completion replaces the link's proven mailbox, creates the session and browser proof and
redirects to the original `/app` destination. The account's email used for independent local
sign-in is unchanged.

已关联身份的邮箱发生变化时，OIDC 回调会为原浏览器保存短期的待处理结果，并将不透明的尝试
标识放在 `/app/mailbox-proof` 的网址片段中。回调将已验证结果放入加密的 HttpOnly Cookie，
并用数据库中的摘要将它与待处理尝试绑定。回调不会签发会话或保留 OIDC 令牌。新邮箱是否已属于
其他账号，均返回相同的待验证结果。邮箱验证成功后，原浏览器以同源 POST 请求提交 `attemptId`
来完成登录。服务器在同一事务中重新检查提供商、域名、策略和团队成员资格，待处理结果及其邮箱
证明只能使用一次。只有验证邮箱后才会报告 `409 sso_email_collision` 并删除包含邮箱数据的待处理
尝试。冲突不会更改关联身份的已验证邮箱，响应和审计记录均不会包含该地址。成功后会更新身份关联中
的已验证邮箱，签发会话和浏览器证明，并跳转至原来的 `/app` 目标。账号用于独立登录的邮箱保持不变。

An unlinked subject with a valid asserted mailbox receives a `302` to
`/app/mailbox-proof#attempt=<attemptId>`. Complete mailbox verification. If you already
have an account, sign in using your existing method to link it. The callback freezes the
validated subject, provider revision and mailbox for the original browser. The redirect
and the queued mailbox proof message are identical across local account existence and
OIDC `email_verified` values. The first account lookup takes place after mailbox proof.

The original browser submits its proved `attemptId` to the existing completion endpoint.
An existing account receives `200 {"status":"link_required"}` and continues through
independent sign-in and `linkSsoAccount`. For an eligible new account, a team configured
for JIT admits a member subject to instance signup, live domain verification, team capacity
and removal blocks. The new account, personal organization, membership, first identity link,
session and audit events commit together. The completion redirects to the original safe
`/app` destination. Each successful resolution spends the result once.

An invitation-only team returns `409 sso_invitation_required`. To accept explicitly,
the original browser sends the existing `{ "invitationId": "…" }` body and the pending
attempt ID in `X-Hourmere-Sso-Attempt` to `POST /api/auth/organization/accept-invitation`.
The SSO branch requires its matching admission cookie, exact same origin and current
mailbox proof. It accepts a current `member` invitation matching the proven address and
provider's team, with the same original-inviter membership and capacity checks as native
acceptance. An eligible current invitation can satisfy the existing signup exception.
A current invitation issued after a local removal can clear its mailbox block; a SCIM-issued
invitation never clears a blocker, as in native acceptance. Accepting a SCIM-issued invitation
completes its SCIM claim exactly as native acceptance does. A SCIM suspension requires its own
reactivation. While OIDC is on, every removal or departure records its tombstone, even before
the team configures a provider or JIT. The SSO invitation branch returns `404 sso_disabled`
while `SSO_OIDC_ENABLED` is off. Ordinary invitation acceptance uses the native session flow.

未关联身份提交有效邮箱时，回调统一跳转至邮箱证明页面。请完成邮箱验证。已有账号的用户须先用
原有方式登录，再显式关联身份。跳转和排队发送的证明邮件均不受本地账号是否存在或 IdP 的
`email_verified` 值影响。服务器在邮箱证明之后才查找账号。符合实例注册策略的新用户可在启用
JIT 的团队中以成员身份加入，前提是域名核验有效、团队仍有名额且邮箱未被移除记录阻拦。账号、
个人空间、团队成员、身份关联、会话和审计同事务提交。完成结果只可在原浏览器使用一次。

仅邀请团队要求在原浏览器显式接受有效邀请。向现有邀请接受端点提交 `invitationId`，并在
`X-Hourmere-Sso-Attempt` 中传递已证明的尝试标识。被移除后发出的有效邀请可清除本地邮箱
阻止记录；SCIM 发出的邀请与原生接受一样，从不清除阻止记录。接受 SCIM 发出的邀请时，与原生接受一样
完成其 SCIM 认领。SCIM 暂停须单独恢复。OIDC 开启后，每次移除或离开都会记录移除记录，即使团队尚未配置
身份提供方或 JIT。`SSO_OIDC_ENABLED` 关闭时，带待处理 SSO 结果的邀请接受请求返回
`404 sso_disabled`。普通邀请继续使用现有登录会话流程。

### Member sign-in and account settings

When OIDC is available, open the sign-in link supplied by the team
(`/sign-in?sso=<providerId>`) and select **Sign in with single sign-on**. The link
identifies the team's provider. The sign-in page offers no email or domain lookup
for SSO. Continue using your existing sign-in method for your personal space. If
you are already signed in, sign out before using the team's SSO link.

If prompted to verify your email, request a verification message. In the same
browser, open the email link in another tab and explicitly verify it, then return
to the tab where you started. You can also copy and paste the email link into
the original tab. If the browser cannot confirm across tabs, paste the link into
the original tab. Select **Continue** to finish verification. If sign-in cannot
finish after verification, the page offers the same next steps regardless of the
account lookup result. Use your usual sign-in method or ask your team for help.

To link an existing account, sign in with your usual method, switch to the
team's space and open **Settings**. Choose the provider under **Your team sign-in**,
verify your Hourmere mailbox, and continue to the identity provider.
When you return, confirm the link to finish. To unlink, use the same section in
that team and independently verify your Hourmere mailbox again. An expired or
cancelled request must be started again. OIDC is off unless the operator sets
`SSO_OIDC_ENABLED=true`; while it is off the sign-in and link controls are hidden, and a
member who already has a link can still unlink it.

#### 成员登录和账号设置

OIDC 可用时，打开团队提供的登录链接（`/sign-in?sso=<providerId>`），选择
**使用单点登录**。链接指定团队的身份提供方。登录页不会通过邮箱地址或域名查找单点登录
提供方。个人空间仍可使用原有方式登录。如果你已经登录，请先退出，再使用团队的单点登录链接。

如需验证邮箱，请先发送验证邮件。在同一浏览器的新标签页中打开邮件链接，确认验证后返回
发起请求的标签页。也可以把邮件链接粘贴到原标签页验证。如果浏览器无法跨标签页确认，请将链接
粘贴到原标签页。选择**继续**完成验证。如果验证后仍无法完成登录，无论该邮箱是否已有账号，
页面都会提示相同的后续操作。请使用原有方式登录，或联系团队寻求帮助。

如需关联已有账号，请用原有方式登录，切换到团队空间后打开**设置**。在**你的团队登录方式**
下选择身份提供方，验证 Hourmere 邮箱后继续前往该提供方。返回时，确认关联以完成操作。
解除关联也在同一团队的设置中进行，并需再次独立验证 Hourmere 邮箱。请求过期或取消后，
请重新发起。除非运营者设置 `SSO_OIDC_ENABLED=true`，否则 OIDC 保持关闭：登录和关联选项会隐藏，
已有关联的成员仍可解除关联。

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

## Provider and domain setup in team settings

With `SSO_OIDC_ENABLED=true`, a current team owner or admin can open
**Settings → Single sign-on** to create, edit or retire an OIDC provider and manage
its associated domains. Issuer and client ID are fixed after creation. To change the
client secret, select **Replace client secret** and enter a new value. Saving other
fields keeps the stored secret. If another administrator changes the revision, reload
the settings and review the current configuration before submitting changes again.

In **SSO domains**, generate a challenge for the exact domain, copy its TXT name and
value, and publish them in DNS before choosing **Verify domain**. The TXT record is
shown once and disappears on dismissal, navigation or reload. Generating a new
challenge rotates the value and resets verification. The domain list shows domains
linked to providers plus those added during the current visit. Associate a new domain
with a provider to find it on a later visit.

生产环境仍关闭 OIDC 和 SAML。注入 OIDC 测试能力后，当前团队的所有者或管理员可在
**设置 → 单点登录**中创建、编辑或停用提供方，并管理关联域名。创建后，签发者网址和客户端
ID 固定。如需更换密钥，请选择**替换客户端密钥**并输入新值。保存其他更改时会保留现有密钥。
如果配置版本已变更，请重新加载设置并核对当前配置，再提交更改。

在**单点登录域名**中为确切域名生成挑战，复制 TXT 记录名称和值并将其添加到 DNS，然后选择
**验证域名**。TXT 记录仅显示一次，关闭记录、离开页面或重新加载后即消失。重新生成挑战会
更换记录值并重置验证状态。列表包含已关联到提供方的域名，以及本次访问期间新增的域名。
将新域名关联到提供方后，下次访问时仍可找到它。

### Test a provider and require SSO

In **Identity providers**, choose **Test provider** on an OIDC draft. After verifying
your identity, continue to the identity provider in the same browser. When the test
returns you to Settings, reopen **Identity providers** to see the result for the
current revision. A team owner can enable the provider after that revision passes
and an associated domain is verified. Editing the provider creates a new revision.

In **SSO enforcement**, a team owner can require SSO or stop requiring it. To require
SSO, a current owner must have accepted recovery enrollment. An enabled OIDC provider
needs a verified domain and a passing test for its current revision by a team owner.
Have the owner test the draft before enabling it.
Hourmere checks these conditions when you submit. If the team requires SSO, Hourmere
also checks that a usable OIDC provider remains before disabling the current provider.

When Hourmere asks for email verification, send the verification email and paste the
link from your Hourmere inbox into the prompt in the original tab. Verify the link
and choose **Continue** to submit your change. If Hourmere asks you to verify with
SSO, open the identity provider in the new tab, then return to the original tab and
choose **Continue**. Some identity providers also require the email step. Finish
verification while your original settings tab is open and your team context stays
the same.

在**身份提供方**中，选择 OIDC 草稿上的**测试提供方**。验证身份后，在同一浏览器中前往
身份提供方。测试完成后，浏览器会返回设置页。重新打开**身份提供方**即可查看当前版本的
测试结果。当前版本通过测试，且至少有一个关联域名已验证后，团队所有者可以启用该提供方。
编辑提供方会产生新版本。

在**强制单点登录**中，团队所有者可以启用或停止强制单点登录。启用前，须有一位当前团队
所有者接受恢复登记，且至少有一个已启用的 OIDC 提供方关联了已验证的域名，
其当前版本也已通过团队所有者的测试。请先由所有者测试草稿，再启用该提供方。
Hourmere 会在提交时核验这些条件。
团队强制使用单点登录期间，停用提供方前，Hourmere 会确认仍有其他可用的 OIDC 提供方。

如果 Hourmere 要求验证邮箱，请发送验证邮件，将 Hourmere 邮箱收到的链接粘贴到原标签页中的
提示框，再验证链接并选择**继续**来提交更改。如果需要通过单点登录验证身份，请在新标签页
打开身份提供方，完成验证后返回原标签页并选择**继续**。部分提供方还需要通过邮箱验证。
请在验证完成前保留原设置标签页，并留在同一个团队。

### Set admission, retire links and manage delegations

In **SSO enforcement**, owners and administrators can choose **Invitation only**
or **Just-in-time admission**. Enabling just-in-time admission needs a verified
team domain. Complete the identity verification the form requests before saving.

Under a provider, **Identity links** lets an owner or administrator retire a member's
link. Verify the request separately and match the link ID the member sees under
**Settings → Your team sign-in**. Only another owner can retire an owner's link.
Members use **Your team sign-in** to unlink their own account. To link again after
retirement, sign in with the usual account method and choose the provider there.

Use **API keys** or **Connected apps** in the credential's team space to manage
SSO delegation. Binding needs the current trust generation from the team policy
read and a fresh SSO verification. The existing policy read is available to owners
and administrators. A session that cannot read it can still revoke its own existing
delegation. The form displays the delegation expiration in local time.
While `SSO_OIDC_ENABLED` is off, the controls that add trust are hidden; a team with
stored SSO configuration keeps the read, recovery and trust-reducing controls.

在**强制单点登录**中，团队所有者和管理员可以选择**仅限受邀者**或**即时入组**。
启用即时入组前须验证团队域名。保存更改前，请按界面提示完成身份验证。

在身份提供方下的**身份关联**中，所有者和管理员可以解除成员的关联。请先通过其他渠道核实请求，
再核对成员在**设置 → 你的团队登录方式**中看到的关联 ID。只有其他所有者可以解除所有者的关联。
成员可以在**你的团队登录方式**中解除自己的关联。如需重新关联，请用原来的方式登录，再回到此处选择提供方。

在凭据所属的团队空间中，打开 **API 密钥**或**已连接的应用**，管理单点登录委托。绑定需要从团队策略
读取当前信任代数，并重新验证单点登录。现有策略接口仅向所有者和管理员开放。无法读取策略的会话仍可
撤销本人已有的委托。页面以本地时间显示到期时间。`SSO_OIDC_ENABLED` 关闭时，增加信任的操作不会显示；
已保存单点登录配置的团队仍可使用读取、恢复和降低信任的操作。

## Self-hosting and local acceptance

Operators configure canonical HTTPS `PUBLIC_URL`, working SMTP for independent email
proof/recovery, credential encryption keys, trusted proxy settings and optional private
IdP destinations. Which protocols an operator can turn on follows Rollout gating below:
until a protocol's setting step, no configuration can enable it; from then on
`SSO_OIDC_ENABLED` or `SSO_SAML_ENABLED` does, on every instance. A setting turned off
never bypasses a team's enforcement policy. In the current release OIDC has its setting,
`SSO_OIDC_ENABLED`, whose default is still off (unset and empty mean off, `true` turns it
on, any other value fails startup); SAML is hard-off and `SSO_SAML_ENABLED` is not read.
The public operator and user guide is `apps/site/src/content/docs/docs/sso.md`.

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
setting before `useSsoRecovery` and the [operator recovery command](#operator-recovery-runbook) exist.

**Published catalogues.** From Draft reads on, each row that adds SSO REST operations,
MCP tools or CLI commands registers them in `packages/auth/src/api-key-operations.ts`,
as the registry's parity tests require. OpenAPI, CLI help and the
generated scope tables in `docs/api-keys.md`, `docs/mcp.md` and their documentation-site copies
therefore list them in every release, while hard-off. MCP `tools/list` omits disabled
SSO tools; direct tool calls still return `sso_disabled` before lookup. From the OIDC
setting step on, the two read tools are not disabled by a setting turned off: they are
listed and answer for a team's owners and administrators. Draft reads adds a static note
beside those tables, outside the generated `api-key-scope-table` markers, stating that
SSO operations return `404 sso_disabled` until an operator enables the protocol, and
rewords the Known limitations bullet from "in design" to "being built and not available
yet". Every later row keeps both until the OIDC setting step.
Public user guides for a protocol land in its setting step, which also rewrites the note
and the bullet for the new setting; Release docs completes the cross-protocol operator
guides, and Acceptance and defaults updates them for the on-by-default state.

**After the OIDC setting step.** The running server derives its capabilities in one place
(`productionSsoCapabilities` in `apps/server/src/server.ts`): OIDC from `SSO_OIDC_ENABLED`,
SAML from the remaining code constant, plus a marker that an operator setting exists. With
that marker, `requireSsoRetained` (`apps/server/src/sso.ts`) keeps reads, recovery,
trust-reducing operations and their mailbox proof available while every protocol is off,
and `requireSsoEnabled` keeps refusing everything that adds trust. Without the marker,
which only in-process tests assemble, both protocols are hard-off as before. The catalogue
regression suite therefore runs its production checks with `SSO_OIDC_ENABLED` unset, empty
and `false` and with `SSO_SAML_ENABLED=true`: the OIDC sign-in, callback and completion
endpoints and every trust-adding write still answer `404 sso_disabled` before caller, input
or database access; the Mailbox proof pair, the two reads and the recovery and
trust-reducing writes answer through their own authorization instead. The startup check
runs `apps/server/src/index.ts` with `SSO_OIDC_ENABLED` empty and `true` (and
`SSO_SAML_ENABLED=true` both times) and requires `/instance` to report OIDC accordingly
and SAML `false`.

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
are narrow exemptions, each for exact paths or operation mappings. Draft reads exempts
only GET `/api/v1/team/sso/providers` (`listSsoProviders`) and GET
`/api/v1/team/sso/policy` (`getSsoPolicy`) in OpenAPI, route and literal inventories,
and their exact CLI command/tool mappings. Production requests prove that both reads
return `404 sso_disabled` before caller or database lookup, including malformed query
parameters. MCP lists neither tool while off and direct calls return `sso_disabled`. The
guarded auth-protocol endpoints that a
built step mounts while hard-off, because each must answer `404 sso_disabled` itself
(the Mailbox proof pair `/api/auth/sso/mailbox-proof/send` and `/consume`, the OIDC sign-in
pair `/api/auth/sign-in/sso` and `/api/auth/sso/callback/{providerId}`, OIDC completion
at `/api/auth/sso/oidc/complete`, and the SAML ACS and completion paths, `/api/auth/sso/saml2/sp/acs/{providerId}`
and `/api/auth/sso/saml2/complete`), are exempt
in the route inventory and the source literals only, and only because the suite requests
each of them in the app built from `productionAppOptions` with `SSO_OIDC_ENABLED=true` and
`SSO_SAML_ENABLED=true` in the environment and requires `404 {"error":"sso_disabled"}` for
every tested method, header set and input ID, with a queue, caller resolver and database that
would fail any effect; the worker role's routes get no exemption. The existing MCP OAuth discovery route
`/.well-known/openid-configuration/api/auth` is exempt in the route inventory and the
source literals, and the same document's Better Auth endpoint
`/.well-known/openid-configuration` among Better Auth endpoint paths: there Hourmere is
the OAuth authorization server for MCP clients, not an SSO relying party. The suite
checks that nothing else is exempt in these server surfaces. The web source check covers JSX `<Route>` attributes in
`apps/web/src/App.tsx`, including nested `<Routes>`, and strings, template parts and
identifiers in `apps/web/src/paths.ts`. Its only SSO declarations are the guarded setup
routes and their two paths, `/app/settings/sso` and `/app/settings/sso/domains`. Browser
component tests check that hard-off hides the Settings entry, renders not-found on both
routes and sends no SSO requests. The source check does not inspect imported route
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
OpenAPI, CLI help and the scope tables with the note above; disabled MCP tools are not listed. `GET /api/v1/instance` reports
`ssoOidcEnabled`/`ssoSamlEnabled` as `false`, `/me` adds no SSO fields, the web shows no
SSO navigation or sign-in option, and the domain recheck worker is not scheduled. The
mailbox proof delivery job drops every job, and the attempt cleanup, which only deletes,
stays scheduled. Two other things work in every state: a stored `requireSso` policy is enforced from Team
enforcement onward (no product path can store one while hard-off), and the operator
maintenance commands, which only remove trust, run.

**Setting-off behaviour** (after the setting step: unset or empty before the default
flip, or `false`). Operations that add trust through that protocol return
`404 sso_disabled`: sign-in initiation, callbacks, ACS, metadata and completion; provider
create, update, test and `activateSsoProvider` with `enabled: true`; linking, step-up and
delegation binding. `setSsoPolicy` with `requireSso: true` is refused with
`sso_disabled` unless the team has an enabled, tested provider of a protocol that is on
and supports step-up.
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
step-up through that protocol is unavailable. On an enforced team without available step-up,
administrative trust-reducing writes that need it return `403 sso_required`. An enrolled owner
can use recovery to read the configuration and turn enforcement off. The team's remaining
writes then use mailbox fresh administration. `GET /api/v1/instance` reports the
protocol as `false`; `/me` keeps the caller's own link and proof summary; the web hides
that protocol's sign-in, link, step-up and binding controls and its trust-adding setup
controls, but keeps, for teams with stored SSO configuration, the read, recovery,
unlink, link-retirement and delegation-revocation views and the trust-reducing setup
controls (provider deactivation and deletion, domain deletion, turning enforcement off).
After a setting step the domain recheck worker keeps running even while the setting is
off, so verification state stays current.

## Domain lifecycle operations

Since the OIDC setting step the recheck worker is scheduled and runs in every state of
`SSO_OIDC_ENABLED`, so verification state stays current while the setting is off; SAML
remains hard-off. Tests exercise renewal with synthetic DNS. Operator retirement is available in every state:
it only removes an expired claim's authority. It is a server-container maintenance
command, not a REST endpoint, MCP tool or product CLI command; interface inventories and
scope counts do not change.

A verified generation is checked daily. A positive result before its expiry renews the
seven-day verification lifetime without changing its generation. Missing TXT proof is
`failed`; resolver failures are `unknown`. Both freeze new trust immediately, preserve
the existing expiry and retry after the daily interval. The remaining verification
lifetime is the recovery window, not a new grace period starting with each failure.
A positive result within that window clears the freeze. At the exact expiry boundary
the claim becomes suspended and remains exclusive; neither a late DNS answer nor job
replay revives it. Enforcement is never silently turned off. Automatic retirement and
transfer are not supported. The original team must issue a new ordinary challenge after
a lapse. Proof and delegation enforcement is implemented by its later rollout steps.

### Retire an expired claim for another team

Run maintenance only inside the server container against that instance's database and
configured `PUBLIC_URL`. Use the immutable old claim ID, its expected generation and the
requesting team's ID; never pass database credentials or TXT values on the command line.
The operator must establish which team is requesting the domain outside this command.
An unexpired claim, a changed generation, a personal organization or the same team cannot
be retired through this procedure.

1. Issue a fresh maintenance challenge:
   `docker compose exec app node apps/server/src/sso-domain-retirement-cli.ts challenge OLD_CLAIM_ID EXPECTED_GENERATION REQUESTING_TEAM_ID`.
   Give the requesting team's DNS administrator the returned TXT name/value privately.
   The value is shown once; only its bound digest is stored. Do not put the output in
   support logs. A lost or expired challenge requires a new challenge.
2. After the administrator publishes the TXT record, run
   `docker compose exec app node apps/server/src/sso-domain-retirement-cli.ts retire CHALLENGE_ID`.
   The command uses the trusted resolver, checks the current expired generation under
   the exact-domain lock, and atomically records retirement, both team IDs, proof times,
   a system audit event and notices for the old team's owners. A concurrent renewal or
   new generation prevents retirement. Replaying a completed challenge does not retire
   another generation or duplicate its notices.
3. If notice delivery fails, retry only delivery with
   `docker compose exec app node apps/server/src/sso-domain-retirement-cli.ts notify CHALLENGE_ID`.
   Configure SMTP for delivery. The command does not return recipient addresses.
4. The requesting team must complete a new ordinary domain challenge and verification
   when the protocol becomes available. Retirement transfers no provider, identity,
   proof, delegation, membership or enforcement policy. Remove the maintenance TXT
   record after the command completes.

### 域名复查与退役

OIDC 与 SAML 仍在代码中关闭，生产环境不调度或执行域名复查。运维退役命令仅移除
过期声明的信任，因此在关闭状态下仍可使用；它不属于 REST、MCP 或产品 CLI。
验证成功后每日复查，成功则续期七天；TXT 不匹配为 `failed`，DNS 故障为 `unknown`。
两者立即冻结新增信任，保留原到期时间并每日重试，不会从每次失败起另加宽限期。
到期前恢复可解除冻结；到期即暂停但仍独占域名，不会自动退役或关闭强制 SSO 策略。

运维人员在服务器容器内按上述 `challenge`、`retire`、`notify` 命令操作：先确认请求
团队身份，将一次性 TXT 挑战私下交给其 DNS 管理员，再由服务器解析并验证。命令锁定
域名并核对旧声明代次和到期时间，在同一事务内保留两团队及证明时间、写入系统审计并
为旧团队所有者保存通知。发送失败时只重试 `notify`；命令不显示收件人地址。
退役不转移账号、身份、成员关系或策略。请求团队仍须在协议可用后完成普通域名验证。

## Operator recovery runbook

Use this procedure when every recovery owner's mailbox is unavailable. Confirm the
affected instance and the team's immutable organization UUID before running the
command. Use the deployed server container's database configuration. The command is
available while both protocols are hard-off and in every subsequent protocol state.
For email delivery, configure `SMTP_URL` and `MAIL_FROM` and start the background
worker before running recovery.

1. From the deployment's Compose project, run the command with the confirmed team UUID.

   ```sh
   docker compose exec app node apps/server/src/sso-operator-recovery-cli.ts TEAM_UUID
   ```

2. `SSO enforcement disabled. Owner notifications queued.` means the change, audit
   event (`sso_maintenance.enforcement_disabled`, actor `system`) and owner notices
   committed together. The command sets `requireSso` to `false` and advances
   `policyRevision` and `trustGeneration`. The new trust generation invalidates the
   team's existing SSO proofs and delegations. Admission, providers, domains,
   memberships and recovery enrollment remain as configured. Concurrent policy
   writes use the same organization lock, and a stale revision is refused.
3. `SSO enforcement is already off. No changes made.` is a successful no-op, including
   for teams without a stored SSO policy. A repeat creates no audit event or notice.
   `Unknown team` returns exit code 1 for an unknown UUID or a personal organization.
   If the command fails, verify the instance, UUID and background job configuration
   before retrying the same invocation.
4. The normal background worker sends and retries the notices to verified mailboxes
   of current team owners. Each notice uses the recipient's saved language, with
   English as the fallback. Check worker logs for delivery failures, including SMTP
   unavailable or retries exhausted. If delivery exhausts its retries, inform the
   affected owners through your incident response process.

### 运维恢复

所有恢复所有者的邮箱均无法使用时，由实例运维人员确认实例及受影响团队的 UUID，在部署
目录中执行上述 `docker compose exec` 命令。命令使用服务器容器的数据库配置，在 OIDC 和
SAML 均关闭时也可执行。

首次关闭强制 SSO 时，团队策略版本与信任代次各递增一次，现有 SSO 证明和委托随即失效。
同一事务会写入系统审计并将所有者通知加入队列。重复执行会提示强制 SSO 已关闭，不会再
写审计或发通知。未知团队 UUID 或个人组织返回退出码 1。配置 SMTP 并保持后台工作进程运行，
以便将通知按各所有者的语言偏好发送到其已验证邮箱，缺省为英语。

## Implementation sequence

Every row is approximately one working day; if a release gate needs an upstream fix,
stop that protocol's rollout rather than compressing its security work. Dependencies
refer only to earlier rows, and each acceptance check tests only what its row or an
earlier row builds. Where a check needs stored state that a later row's operation
writes (an enforced or JIT policy before `setSsoPolicy`, a SAML provider before its
configuration fields), the test seeds that row directly. External prerequisites are
named in the row that waits for them: the patched Better Auth family (1.7.25)
in Upgrade and the audit journal of PR #246 in Audit actions. Each endpoint name below refers to the exact
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
| Upgrade | Add `@better-auth/sso` at the pinned family version and rerun this source evaluation against it; none | Hard-off guard | OIDC hard-off; SAML hard-off | Regression suite; family at or above every listed advisory patch; pre-session validation hook or replacement adapter feasibility established. Off: no SSO plugin route registered |
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
| Enforcement policy | `setSsoPolicy`; no MCP/CLI writes; owner checks without recovery bypass yet | Provider activation | OIDC hard-off; SAML hard-off | Enforcement needs a verified domain, an enabled tested OIDC provider (a seeded SAML-only provider is refused with `sso_disabled` even if SAML is enabled), an owner test of the exact revision and a usable recovery owner; a pending nomination, a demoted former recovery owner and a demoted-then-re-promoted owner without a new acceptance each leave enforcement refused with `sso_recovery_required`; refused with `sso_domain_unverified` after a failed recheck or expiry; `trustGeneration` increments on enforcement off, never on enforcement on, admission or membership changes, so a binding made before enforcement keeps working; once enforced, every fresh-administration write requires OIDC step-up; audit events. Off: `sso_disabled` |
| Recovery use | `useSsoRecovery`; recovery-authority checks on `listSsoProviders`, `getSsoPolicy` and `setSsoPolicy` with `requireSso: false`; no MCP/CLI writes | Enforcement policy | OIDC hard-off; SAML hard-off | Fresh mailbox proof by a usable recovery owner; single-use race; reads do not consume authority and observe expiry; `setSsoPolicy {requireSso: false}` consumes it; cannot enable JIT, alter membership, bind delegations, change recovery owners or read team data; expired, non-owner, demoted and non-recovery-owner refusal. Off: `sso_disabled` |
| Recovery repair | Recovery-authority checks on `createSsoProvider`, `updateSsoProvider`, `testSsoProvider` and `activateSsoProvider`; no MCP/CLI writes | Recovery use | OIDC hard-off; SAML hard-off | Update, test and re-activation of a broken provider take three ceremonies; `createSsoProvider` consumes one; a test callback finishes only its bound intent; each write still checks owner, session, Origin and expected team; a second write on one ceremony refused. Off: `sso_disabled` |
| Operator recovery | Offline recovery maintenance command that turns one team's enforcement off, and its [runbook](#operator-recovery-runbook); no product operations | Recovery repair | OIDC hard-off; SAML hard-off | Runs only in the server container against the instance database; unknown team refused; changes only `requireSso`, increments `trustGeneration` and `policyRevision`, writes a `system` audit event and notifies owners; idempotent; race with concurrent `setSsoPolicy`. Off: only removes trust, so it runs in every state |
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
IdP group role mapping, service accounts, IdP-initiated SAML, SAML SLO, encrypted
assertions, automatic domain transfers, wildcard domain claims, a separate
recovery-owner withdrawal operation and global forced SSO are deferred.
[SCIM provisioning](scim.md) is a separate feature. Without it, absolute proof expiry
bounds the local revocation delay after IdP deactivation. Private IdP reachability
remains operator-controlled. A successful provider test does not prove all accounts
have valid immutable identifiers.

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
