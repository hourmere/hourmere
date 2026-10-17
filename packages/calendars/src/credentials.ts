import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** A dedicated, canonical base64 key; independent of the sign-in/session secret. */
export function calendarEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('CALENDAR_ENCRYPTION_KEY must be 32 random bytes encoded as base64')
  }
  return key
}

/** Version | 96-bit IV | 128-bit tag | ciphertext. AAD prevents moving it to another row. */
export function encryptCredential(key: Buffer, aad: string, value: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted])
}

export function decryptCredential(key: Buffer, aad: string, value: Buffer): string {
  try {
    if (value.length < 30 || value[0] !== 1) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(value.subarray(13, 29))
    return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8')
  } catch {
    // No plaintext, ciphertext or provider response may enter an error's cause chain.
    throw new Error('Calendar credentials could not be decrypted')
  }
}
