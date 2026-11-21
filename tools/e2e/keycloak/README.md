# Keycloak OIDC browser fixture

The fixture runs the official Keycloak 26.8.2 container pinned to the multi-platform
image digest `sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3`
from `quay.io/keycloak/keycloak`. The pin supports Linux AMD64 and ARM64.

Install the repository dependencies, Docker, OpenSSL and Google Chrome. Build the web
app first. Run Playwright in an escalated shell locally. CI runs this spec in the
required browser suite.

```sh
npm run build --workspace @hourmere/web
HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere \
  npm run test --workspace @hourmere/e2e -- keycloak-oidc.spec.ts --project=desktop
```

The PostgreSQL bootstrap connection creates and drops a disposable Hourmere database.
Keycloak uses its own ephemeral database inside its container and a random loopback
HTTPS port. The fixture generates a TLS certificate, an OIDC client secret and a password
at startup. It imports [the synthetic realm](realm.json) with one exact callback, a
verified persona, another subject with the same mailbox, an unverified persona and a
disabled persona. The browser acceptance tests use the verified persona with a seeded
identity link. Team personas use the reserved `company.example.com` domain to satisfy
the team SSO validator's public DNS syntax. The fixture seeds the verified domain in
PostgreSQL without a DNS query. Personal sign-in uses `example.test`, an in-memory mail
sink and fake Google and Microsoft responses.

The fixture starts Hourmere in process with OIDC enabled for the positive case. The
off case uses the same seeded realm and default capability, which is also the production
default. The browser spec checks that a changed state stops before the token exchange,
a changed nonce is refused after Keycloak issues a signed token, and a used code is
refused with both consumed and fresh state.

PostgreSQL, the container and the browser context are disposable. Teardown
removes the exact container created by this run and its private temporary files. Each
container carries a unique `com.hourmere.e2e.keycloak-owner` label and uses its writable
layer for the realm database. The fixture uses the exact name and label to recover
ownership if Docker fails after creating a container. No Docker volume or shared Compose
service is involved.
