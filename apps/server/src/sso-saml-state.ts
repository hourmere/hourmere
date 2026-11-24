import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import { z } from 'zod'

export const SAML_ACS_PATH = '/api/auth/sso/saml2/sp/acs/:providerId'
export const SAML_COMPLETE_PATH = '/api/auth/sso/saml2/complete'
export const SAML_METADATA_PATH = '/api/auth/sso/saml2/sp/metadata/:providerId'
export const samlStartOperation = 'samlSignIn'
export const samlCompleteOperation = 'samlCompleteSignIn'
export const samlTestOperation = 'samlTestProvider'
export const samlCompleteTestOperation = 'samlCompleteProviderTest'
export const samlId = z.uuidv7()

export const samlTestBinding = z.strictObject({
  recovery: z.strictObject({ acceptedAt: z.string(), testProviderEnabled: z.boolean() }).optional(),
})

export const samlProviderConfig = z.strictObject({
  ssoEndpoint: z.string(),
  signingCertificates: z.array(z.string()).min(1).max(4).optional(),
})

export function samlServiceProviderUrls(publicUrl: string, providerId: string) {
  return {
    spEntityId: new URL(SAML_METADATA_PATH.replace(':providerId', providerId), publicUrl).href,
    acsUrl: new URL(SAML_ACS_PATH.replace(':providerId', providerId), publicUrl).href,
  }
}

/** Extract only the lookup key. The whole issued RelayState must match its stored digest. */
export function samlRelayAttemptId(relayState: string) {
  const match = /^([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/.exec(relayState)
  if (!match?.[1]) return undefined
  const hex = Buffer.from(match[1], 'base64url').toString('hex')
  const id = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
  if (samlId.safeParse(id).success) return id
}

type StateKind = 'return' | 'result' | 'test'

export function samlStateCookie(publicUrl: string, kind: StateKind, id: string) {
  const secure = new URL(publicUrl).protocol === 'https:'
  const name = `${secure ? '__Secure-' : ''}hourmere.saml_${kind}.${id}`
  const options = { httpOnly: true, secure, path: SAML_COMPLETE_PATH, sameSite: 'Strict' } as const
  return { name, options }
}

const stateAad = (kind: StateKind, id: string) => `hourmere-saml-${kind}-v1:${id}`

export function sealSamlState(key: Buffer, kind: StateKind, id: string, state: string) {
  return encryptCredential(key, stateAad(kind, id), state).toString('base64url')
}

export function openSamlState(key: Buffer, kind: StateKind, id: string, state: string) {
  if (!/^[A-Za-z0-9_-]{1,3800}$/.test(state)) return undefined
  try {
    return decryptCredential(key, stateAad(kind, id), Buffer.from(state, 'base64url'))
  } catch {
    return undefined
  }
}
