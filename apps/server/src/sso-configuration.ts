import { decryptCredential, encryptCredential } from '@hourmere/calendars'

/** The provider revision a sealed SSO configuration belongs to. */
export interface SsoProviderRevision {
  organizationId: string
  providerId: string
  revision: number
}

/**
 * Purpose-bound authenticated data for one provider revision's configuration. Ciphertext
 * moved to another organization, provider, revision or purpose fails to open, so every new
 * provider revision is sealed again (the database requires it).
 */
export function ssoProviderConfigurationAad({
  organizationId,
  providerId,
  revision,
}: SsoProviderRevision): string {
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('SSO provider revision must be a positive integer')
  return JSON.stringify([
    'hourmere-sso-v1',
    'provider-configuration',
    organizationId.toLowerCase(),
    providerId.toLowerCase(),
    revision,
  ])
}

/**
 * Seals a provider's protocol configuration, secrets included, in the credential envelope
 * used for calendar credentials (AES-256-GCM: version 1, 96-bit IV, 128-bit tag,
 * ciphertext) under an operator-managed 32-byte key.
 */
export function sealSsoProviderConfiguration(
  key: Buffer,
  revision: SsoProviderRevision,
  configuration: string,
): Buffer {
  return encryptCredential(key, ssoProviderConfigurationAad(revision), configuration)
}

export function openSsoProviderConfiguration(
  key: Buffer,
  revision: SsoProviderRevision,
  sealed: Buffer,
): string {
  try {
    return decryptCredential(key, ssoProviderConfigurationAad(revision), sealed)
  } catch {
    // No plaintext, ciphertext or key detail may enter an error's cause chain.
    throw new Error('SSO provider configuration could not be decrypted')
  }
}
