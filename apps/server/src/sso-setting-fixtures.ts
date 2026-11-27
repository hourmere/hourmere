import { loadConfig } from './config.ts'
import { productionSsoCapabilities } from './server.ts'

/** Exercise the same capability selection as the server, without starting a listener. */
export function configuredSsoCapabilities(oidc: 'true' | 'false', saml: 'true' | 'false') {
  return productionSsoCapabilities(
    loadConfig({
      DATABASE_URL: 'postgres://sso-fixture@127.0.0.1:9/sso_fixture',
      BETTER_AUTH_SECRET: 'sso-setting-fixture-secret-for-tests-only',
      SCIM_PROVISIONING_ENABLED: 'false',
      SSO_OIDC_ENABLED: oidc,
      SSO_SAML_ENABLED: saml,
    }),
  )
}
