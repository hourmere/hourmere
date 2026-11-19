import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createRoutingToken,
  openRoutingAnswers,
  routingRequestKey,
  routingTokenDigest,
  sealRoutingAnswers,
} from './routing-receipt-crypto.ts'
import { openSecret } from './sealed-secret.ts'

const secret = 'synthetic routing receipt test secret'
const rotated = 'rotated synthetic routing receipt test secret'
const binding = {
  organizationId: randomUUID(),
  formId: randomUUID(),
  versionId: randomUUID(),
  receiptId: randomUUID(),
}
const answers = { [randomUUID()]: 'Synthetic answer' }

const expectedKey = (purpose: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'hourmere/routing-forms', purpose, 32))

describe('routing receipt cryptography', () => {
  it('generates a fresh capability and stores a purpose-bound lookup digest', () => {
    const token = createRoutingToken()
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(createRoutingToken()).not.toBe(token)

    const digest = routingTokenDigest(secret, 'continuation', token)
    expect(digest).toBe(
      createHmac('sha256', expectedKey('token/continuation/v1')).update(token).digest('hex'),
    )
    expect(routingTokenDigest(secret, 'submission', token)).not.toBe(digest)
    expect(routingTokenDigest(rotated, 'continuation', token)).not.toBe(digest)
  })

  it('derives the receipt key from the installation secret and uses a fresh IV', () => {
    const ciphertext = sealRoutingAnswers(secret, 'continuation', binding, answers)
    const aad = Buffer.from(
      JSON.stringify([
        'hourmere/routing-forms',
        binding.organizationId,
        binding.formId,
        binding.versionId,
        binding.receiptId,
      ]),
    )
    expect(openSecret(expectedKey('answers/continuation/v1'), aad, ciphertext)).toBe(
      JSON.stringify(answers),
    )
    expect(openRoutingAnswers(secret, 'continuation', binding, ciphertext)).toEqual(answers)
    expect(sealRoutingAnswers(secret, 'continuation', binding, answers)).not.toEqual(ciphertext)
  })

  it('refuses to open a receipt using the opposite purpose in either direction', () => {
    const submission = sealRoutingAnswers(secret, 'submission', binding, answers)
    const continuation = sealRoutingAnswers(secret, 'continuation', binding, answers)
    expect(openRoutingAnswers(secret, 'submission', binding, submission)).toEqual(answers)
    expect(openRoutingAnswers(secret, 'continuation', binding, continuation)).toEqual(answers)
    expect(openRoutingAnswers(secret, 'submission', binding, continuation)).toBeUndefined()
    expect(openRoutingAnswers(secret, 'continuation', binding, submission)).toBeUndefined()
  })

  it('neutrally refuses substituted bindings, tampering and secret rotation', () => {
    const ciphertext = sealRoutingAnswers(secret, 'continuation', binding, answers)
    for (const field of Object.keys(binding)) {
      expect(
        openRoutingAnswers(
          secret,
          'continuation',
          { ...binding, [field]: randomUUID() },
          ciphertext,
        ),
      ).toBeUndefined()
    }
    const tampered = Buffer.from(ciphertext)
    tampered.writeUInt8(tampered.readUInt8(13) ^ 1, 13)
    expect(openRoutingAnswers(secret, 'continuation', binding, tampered)).toBeUndefined()
    expect(openRoutingAnswers(rotated, 'continuation', binding, ciphertext)).toBeUndefined()
    expect(openRoutingAnswers(secret, 'continuation', binding, null)).toBeUndefined()
  })

  it('keys request accounting by a dedicated digest of the bucket and trusted client key', () => {
    const clientKey = '192.0.2.100'
    const digest = routingRequestKey(secret, 'routingSubmission', clientKey)
    expect(digest).toBe(
      createHmac('sha256', expectedKey('request/v1'))
        .update(`routingSubmission\0${clientKey}`)
        .digest('hex'),
    )
    expect(routingRequestKey(secret, 'routingContinuation', clientKey)).not.toBe(digest)
    expect(routingRequestKey(secret, 'routingSubmission', '192.0.2.101')).not.toBe(digest)
    expect(routingRequestKey(rotated, 'routingSubmission', clientKey)).not.toBe(digest)
  })
})
