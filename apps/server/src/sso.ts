import { DomainError } from '@hourmere/scheduling'

export interface SsoCapabilities {
  readonly ssoOidcEnabled: boolean
  readonly ssoSamlEnabled: boolean
}

/**
 * Shared hard-off guard for future SSO routes. Call before lookup, writes or rate-limit
 * counting when both protocols are off or the input names a protocol. For a stored
 * object's protocol while another is enabled, authorize its team-scoped lookup first.
 * Omitting the protocol checks a protocol-neutral SSO operation.
 */
export function requireSsoEnabled(capabilities: SsoCapabilities, protocol?: 'oidc' | 'saml'): void {
  const enabled =
    protocol === 'oidc'
      ? capabilities.ssoOidcEnabled
      : protocol === 'saml'
        ? capabilities.ssoSamlEnabled
        : capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled
  if (!enabled) throw new DomainError('not_found', 'sso_disabled')
}
