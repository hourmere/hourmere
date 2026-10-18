import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptWebhookSecret, encryptWebhookSecret, webhookSignature } from './crypto.ts'

describe('webhook signing secrets', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  it('authenticates encryption to both endpoint and organization, with random IVs', () => {
    const a = encryptWebhookSecret('synthetic-signing-secret', key, 'endpoint', 'org')
    const b = encryptWebhookSecret('synthetic-signing-secret', key, 'endpoint', 'org')
    expect(a.equals(b)).toBe(false)
    expect(a.includes(Buffer.from('synthetic-signing-secret'))).toBe(false)
    expect(decryptWebhookSecret(a, key, 'endpoint', 'org') === 'synthetic-signing-secret').toBe(
      true,
    )
    for (const [k, endpoint, org] of [
      [key, 'other', 'org'],
      [key, 'endpoint', 'other'],
      [Buffer.alloc(32, 8).toString('base64'), 'endpoint', 'org'],
    ])
      expect(() =>
        decryptWebhookSecret(a, k as string, endpoint as string, org as string),
      ).toThrow()
    const tampered = Buffer.from(a)
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1
    expect(() => decryptWebhookSecret(tampered, key, 'endpoint', 'org')).toThrow()
  })
  it('signs the literal timestamp, dot and exact UTF-8 payload bytes', () => {
    const body = '{"id":"event","unicode":"预约"}'
    const expected = createHmac('sha256', 'test-key').update(`1800000000.${body}`).digest('hex')
    expect(webhookSignature('test-key', '1800000000', body) === `v1=${expected}`).toBe(true)
    expect(webhookSignature('test-key', '1800000001', body) === `v1=${expected}`).toBe(false)
    expect(webhookSignature('test-key', '1800000000', `${body} `) === `v1=${expected}`).toBe(false)
  })
})
