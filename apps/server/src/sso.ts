import { DomainError } from '@hourmere/scheduling'

export const USE_SSO_RECOVERY = 'useSsoRecovery'
export const SCIM_MAPPING_CONSENT = 'approveScimTeamMapping'
export const CREATE_OWNERSHIP_TRANSFER = 'createOwnershipTransfer'
export const CONFIRM_OWNERSHIP_TRANSFER = 'confirmOwnershipTransfer'

export function isOwnershipTransferProofOperation(operation: string | null) {
  return operation === CREATE_OWNERSHIP_TRANSFER || operation === CONFIRM_OWNERSHIP_TRANSFER
}

export interface SsoCapabilities {
  readonly ssoOidcEnabled: boolean
  readonly ssoSamlEnabled: boolean
  /** The effective provisioning capability, or absent if this service was built without it. */
  readonly scimResourcesEnabled?: boolean | undefined
  /**
   * True when protocols follow operator settings, as the running server always passes it.
   * A protocol that is off is then in Setting-off behaviour (docs/sso.md): reads, recovery,
   * trust-reducing operations and their mailbox proof stay available for stored state.
   * Absent, both protocols are hard-off, which only in-process tests assemble.
   */
  readonly ssoOperatorSetting?: boolean | undefined
}

export function ssoProtocolEnabled(capabilities: SsoCapabilities, protocol?: string): boolean {
  return protocol === 'oidc'
    ? capabilities.ssoOidcEnabled
    : protocol === 'saml'
      ? capabilities.ssoSamlEnabled
      : protocol === undefined && (capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)
}

export function enabledSsoProtocols(capabilities: SsoCapabilities): ('oidc' | 'saml')[] {
  return (['oidc', 'saml'] as const).filter((protocol) =>
    ssoProtocolEnabled(capabilities, protocol),
  )
}

/**
 * Shared off guard for SSO operations that add trust. Call before lookup, writes or rate-limit
 * counting when both protocols are off or the input names a protocol. For a stored
 * object's protocol while another is enabled, authorize its team-scoped lookup first.
 * Omitting the protocol checks a protocol-neutral SSO operation; other values fail closed.
 */
export function requireSsoEnabled(capabilities: SsoCapabilities, protocol?: 'oidc' | 'saml'): void {
  if (!ssoProtocolEnabled(capabilities, protocol))
    throw new DomainError('not_found', 'sso_disabled')
}

/** True unless every protocol is hard-off: stored SSO state can be read, recovered and reduced. */
export function ssoRetained(capabilities: SsoCapabilities): boolean {
  return (
    capabilities.ssoOidcEnabled ||
    capabilities.ssoSamlEnabled ||
    capabilities.ssoOperatorSetting === true
  )
}

/** Stored SAML identity links are available for recovery while its operator setting is off. */
export function samlLinkRecoveryAvailable(capabilities: SsoCapabilities): boolean {
  return capabilities.ssoSamlEnabled || capabilities.ssoOperatorSetting === true
}

/**
 * Guard for reads, recovery and trust-reducing operations, which a setting turned off keeps
 * available. Call it where requireSsoEnabled would be called; operations that add trust use
 * requireSsoEnabled instead and stay refused while their protocol is off.
 */
export function requireSsoRetained(capabilities: SsoCapabilities): void {
  if (!ssoRetained(capabilities)) throw new DomainError('not_found', 'sso_disabled')
}
