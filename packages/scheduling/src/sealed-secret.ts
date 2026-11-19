import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export function derivePurposeKey(secret: string, namespace: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, namespace, purpose, 32))
}

/** Version byte, 96-bit IV, 128-bit authentication tag, then ciphertext. */
export function sealSecret(key: Buffer, aad: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted])
}

export function openSecret(key: Buffer, aad: Buffer, ciphertext: Buffer): string {
  if (ciphertext.length < 30 || ciphertext[0] !== 1) throw new Error('Invalid sealed secret')
  const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(1, 13))
  decipher.setAAD(aad)
  decipher.setAuthTag(ciphertext.subarray(13, 29))
  return Buffer.concat([decipher.update(ciphertext.subarray(29)), decipher.final()]).toString(
    'utf8',
  )
}
