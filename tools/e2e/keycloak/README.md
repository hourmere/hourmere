# Keycloak test fixture

The fixture runs the official Keycloak 26.8.2 container pinned to the multi-platform
image digest `sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3`
from `quay.io/keycloak/keycloak`. The pin supports Linux AMD64 and ARM64.

Install the repository dependencies, Docker, OpenSSL and Google Chrome. Build the web
app first. Run Playwright in an escalated shell locally. The required CI browser shards
discover the Keycloak specs for desktop and mobile. The fixture pulls the pinned image when it is absent from Docker's
cache.

```sh
npm run build --workspace @hourmere/web
HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
  npm run test --workspace @hourmere/e2e -- keycloak-oidc --project=desktop
```

The PostgreSQL bootstrap connection creates and drops a disposable Hourmere database.
Each Playwright worker starts one Keycloak container on demand, with an in-memory
database, a TLS certificate and a loopback HTTPS port. On Linux the container shares
the host network and binds only to loopback because changes to bridge interfaces can
interrupt Chrome navigations. macOS publishes the HTTPS port on loopback.

For each test, the fixture uses a temporary admin service account to create a fresh
[synthetic realm](realm.json) with its own issuer, signing keys, user subjects, client
secret, password and exact callback. It deletes the realm at teardown and checks that
discovery returns 404. The worker removes its container when it exits.
Team personas use the reserved `company.example.com` domain to satisfy
the team SSO validator's public DNS syntax. The fixture seeds the verified domain in
PostgreSQL without a DNS query. Personal sign-in uses `example.test`, an in-memory mail
sink and fake Google and Microsoft responses.

The fixture starts Hourmere in process with OIDC enabled for the positive case. The
off case uses the same seeded realm and default capability, which is also the production
default. The browser spec checks that a changed state stops before the token exchange,
a changed nonce is refused after Keycloak issues a signed token, and a used code is
refused with both consumed and fresh state.

The linking and admission cases use Hourmere's own mailbox verification with an in-memory
mail sink. They cover explicit self-link, the generic mailbox verification flow for
unlinked subjects, and refusal to sign an existing account in based on the IdP email.
An eligible invitation allows admission with closed signup. The browser submits explicit
acceptance through the existing invitation endpoint after mailbox verification. JIT
admission requires instance signup eligibility and is refused with closed signup. With
OIDC off, the sign-in and member-link controls are hidden and the link and admission
requests are refused.

The enforcement cases compare a mailbox session and a Keycloak session for the same
owner. Binding a CLI and MCP lease requires a second Keycloak login with
`prompt=login` and `max_age=0`. An unbound or revoked key cannot read the team's
catalog. Without OIDC injection, the seeded enforcement policy still blocks ordinary
team access and the sign-in page has no SSO option.

The recovery cases spend a fresh mailbox ceremony on each provider repair write and
exercise the existing operator command while the fixture IdP is down. Both outage
cases opt into a dedicated container that they can stop. The signing-key rotation
case also uses a dedicated container and adds a higher-priority RS256 key to its
realm. It verifies a new signing key and a fresh JWKS fetch after the verifier cooldown.
The outage case checks existing proof, new sign-in refusal and the ordinary mailbox boundary.

The browser context and Hourmere database are disposable for every test. Container
teardown removes the exact container it owns and its private temporary files. Each
container carries a unique `com.hourmere.e2e.keycloak-owner` label. The fixture uses the
exact name and label to recover ownership if Docker fails after creating a container.
Admin credentials stay in private fixture state and Docker logging is disabled.

## Outbound SCIM capture

The browserless SCIM spec uses the same Keycloak image, one container per worker and a
disposable realm per test. Install Node dependencies, Docker and OpenSSL, and start a
PostgreSQL instance whose bootstrap account can create and drop test databases. Run from
the repository root in an escalated shell under the repository's Playwright rules.

```sh
HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
  npm run test --workspace @hourmere/e2e -- --config=playwright.scim.config.ts
```

The opt-in spec runs outside the required browser shards. It downloads the versioned
JAR from its official release and verifies its SHA-256 before starting the container.
Linux uses the existing host network and Keycloak ports below the ephemeral range.
Docker Desktop on macOS reaches the loopback-only Hourmere listener through
`host.docker.internal`. Keycloak waits for discovery before the test creates its realm.
The plugin only allows requests to the local SCIM host. A per-realm file vault supplies
the random provisioning bearer. Teardown deletes the target and realm, then releases the
listener, database, worker container and its private files.

Each JSON line in the Playwright output shows a SCIM request and response. The capture
keeps the method, resource path, selected query fields, selected SCIM JSON fields and
status. It aliases generated IDs and includes only allowlisted fixture text. Headers,
origins, timestamps, raw errors and credentials are omitted. The observed provisioning
sequence and upstream capability are recorded in [docs/scim.md](../../../docs/scim.md#local-keycloak-harness).
