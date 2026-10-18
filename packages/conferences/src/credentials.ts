import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { ZoomMode } from './zoom.ts'

export function conferenceEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('CONFERENCE_ENCRYPTION_KEY must be 32 random bytes encoded as base64')
  return key
}

/** Separate purpose, provider, owner and record binding; never calendar/sign-in ciphertext. */
export function conferenceAad(
  purpose: 'oauth-state' | 'connection-tokens',
  owner: string,
  record: string,
  identity: string,
): string {
  return JSON.stringify(['hourmere-conference-v1', 'zoom', purpose, owner, record, identity])
}
export function encryptConferenceCredential(key: Buffer, aad: string, plaintext: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const value = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), value])
}
export function decryptConferenceCredential(key: Buffer, aad: string, value: Buffer): string {
  try {
    if (value.length < 30 || value[0] !== 1) throw new Error()
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13))
    cipher.setAAD(Buffer.from(aad))
    cipher.setAuthTag(value.subarray(13, 29))
    return Buffer.concat([cipher.update(value.subarray(29)), cipher.final()]).toString('utf8')
  } catch {
    throw new Error('Conference credentials could not be decrypted')
  }
}

/** Identity v1 credentials remain readable; stronger grants cannot be transplanted to it. */
export function conferenceTokenAad(
  owner: string,
  record: string,
  identity: string,
  mode: ZoomMode,
): string {
  return mode === 'identity'
    ? conferenceAad('connection-tokens', owner, record, identity)
    : JSON.stringify([
        'hourmere-conference-v2',
        'zoom',
        'connection-tokens',
        owner,
        record,
        identity,
        mode,
      ])
}
/** New attempts bind all authorization decisions, including a deliberately absent ID. */
export function conferenceStateAad(
  owner: string,
  record: string,
  session: string,
  mode: ZoomMode,
  connection: string | null,
): string {
  return JSON.stringify([
    'hourmere-conference-v2',
    'zoom',
    'oauth-state',
    owner,
    record,
    session,
    mode,
    connection,
  ])
}
