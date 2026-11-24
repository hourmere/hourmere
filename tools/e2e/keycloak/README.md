# Keycloak OIDC browser fixture

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
