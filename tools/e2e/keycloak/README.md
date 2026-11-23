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
Keycloak uses an in-memory database inside its container and a random loopback
HTTPS port. On Linux the container shares the host network and binds only to loopback,
because adding and removing a bridge interface interrupts Chrome navigations in flight. The fixture generates a TLS certificate, an OIDC client secret and a password
at startup. It imports [the synthetic realm](realm.json) with one exact callback and
personas for linked sign-in, self-link, same-email sign-in and new account admission.
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
exercise the existing operator command while the fixture IdP is down. The rotation
case starts an ephemeral Keycloak admin service account and adds a higher-priority
RS256 key in the disposable realm. It verifies a new signing key and a fresh JWKS
fetch after the verifier cooldown. The outage case stops only its owned IdP and
checks existing proof, new sign-in refusal and the ordinary mailbox boundary.

PostgreSQL, the container and the browser context are disposable. Teardown
removes the exact container created by this run and its private temporary files. Each
container carries a unique `com.hourmere.e2e.keycloak-owner` label. The fixture uses the
exact name and label to recover ownership if Docker fails after creating a container.
No Docker volume or shared Compose service is involved.
