import { DomainError } from '@hourmere/scheduling'

export const USE_SSO_RECOVERY = 'useSsoRecovery'
export const SCIM_MAPPING_CONSENT = 'approveScimTeamMapping'

export interface SsoCapabilities {
  readonly ssoOidcEnabled: boolean
  readonly ssoSamlEnabled: boolean
  /** The in-process SCIM resource capability; see TeamSsoCapabilities. Defaults off. */
  readonly scimResourcesEnabled?: boolean | undefined
}

/**
 * Shared hard-off guard for future SSO routes. Call before lookup, writes or rate-limit
 * counting when both protocols are off or the input names a protocol. For a stored
 * object's protocol while another is enabled, authorize its team-scoped lookup first.
 * Omitting the protocol checks a protocol-neutral SSO operation; other values fail closed.
 */
export function requireSsoEnabled(capabilities: SsoCapabilities, protocol?: 'oidc' | 'saml'): void {
  const enabled =
    protocol === 'oidc'
      ? capabilities.ssoOidcEnabled
      : protocol === 'saml'
        ? capabilities.ssoSamlEnabled
        : protocol === undefined && (capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)
  if (!enabled) throw new DomainError('not_found', 'sso_disabled')
}
