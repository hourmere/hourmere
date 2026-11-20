import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'

export const BIND_SSO_DELEGATION = 'bindSsoDelegation'
export const SSO_DELEGATIONS_PATH = '/api/v1/team/sso/delegations'

export function delegationProofCookie(publicUrl: string, attemptId: string) {
  const secure = new URL(publicUrl).protocol === 'https:'
  return {
    name: `${secure ? '__Secure-' : ''}hourmere.sso_delegation.${attemptId.toLowerCase()}`,
    options: { httpOnly: true, secure, sameSite: 'Strict', path: SSO_DELEGATIONS_PATH } as const,
  }
}

const proof = z.strictObject({
  linkGeneration: z.int().positive(),
  sessionDeadline: z.iso.datetime().optional(),
})

function aad(provider: SsoProviderRevision, attemptId: string, binding: string) {
  return JSON.stringify([
    BIND_SSO_DELEGATION,
    ssoProviderConfigurationAad(provider),
    attemptId,
    binding,
  ])
}

/** Carry only the verified deadline and link generation, scoped to the original step-up. */
export function sealDelegationProof(
  key: Buffer,
  provider: SsoProviderRevision,
  attemptId: string,
  binding: string,
  result: z.infer<typeof proof>,
) {
  return encryptCredential(key, aad(provider, attemptId, binding), JSON.stringify(result)).toString(
    'base64url',
  )
}

export function openDelegationProof(
  key: Buffer | undefined,
  provider: SsoProviderRevision,
  attemptId: string,
  binding: string,
  envelope: string | undefined,
) {
  if (!key || !envelope || !/^[A-Za-z0-9_-]{1,1024}$/.test(envelope)) return undefined
  try {
    const result = decryptCredential(
      key,
      aad(provider, attemptId, binding),
      Buffer.from(envelope, 'base64url'),
    )
    return proof.parse(JSON.parse(result))
  } catch {
    return undefined
  }
}
