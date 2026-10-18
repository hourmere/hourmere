import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

/** A separate, stable environment key; never derived from calendar or sign-in secrets. */
function key(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== value)
    throw new Error('Webhook encryption key must be 32 random bytes encoded as base64')
  return decoded
}

export function encryptWebhookSecret(
  secret: string,
  encryptionKey: string,
  id: string,
  org: string,
) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(encryptionKey), iv)
  cipher.setAAD(Buffer.from(`hourmere:webhook:v1:${org}:${id}`))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted])
}

export function decryptWebhookSecret(data: Buffer, encryptionKey: string, id: string, org: string) {
  if (data[0] !== 1 || data.length < 30) throw new Error('Webhook secret is unavailable')
  const cipher = createDecipheriv('aes-256-gcm', key(encryptionKey), data.subarray(1, 13))
  cipher.setAAD(Buffer.from(`hourmere:webhook:v1:${org}:${id}`))
  cipher.setAuthTag(data.subarray(13, 29))
  return Buffer.concat([cipher.update(data.subarray(29)), cipher.final()]).toString('utf8')
}

export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}
