import { createHmac, randomBytes } from 'node:crypto'
import type { RoutingAnswers } from './routing-form-config.ts'
import { derivePurposeKey, openSecret, sealSecret } from './sealed-secret.ts'

type ReceiptPurpose = 'submission' | 'continuation'

interface ReceiptBinding {
  organizationId: string
  formId: string
  versionId: string
  receiptId: string
}

const NAMESPACE = 'hourmere/routing-forms'

export function createRoutingToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The lookup digest of a bearer capability, scoped to routing and its specific purpose. */
export function routingTokenDigest(secret: string, purpose: ReceiptPurpose, token: string): string {
  return createHmac('sha256', derivePurposeKey(secret, NAMESPACE, `token/${purpose}/v1`))
    .update(token)
    .digest('hex')
}

/** The routing limiter retains only this digest of the trusted transport's normalized client key. */
export function routingRequestKey(
  secret: string,
  bucket: 'routingSubmission' | 'routingContinuation',
  clientKey: string,
): string {
  return createHmac('sha256', derivePurposeKey(secret, NAMESPACE, 'request/v1'))
    .update(`${bucket}\0${clientKey}`)
    .digest('hex')
}

function receiptAad(binding: ReceiptBinding): Buffer {
  return Buffer.from(
    JSON.stringify([
      NAMESPACE,
      binding.organizationId,
      binding.formId,
      binding.versionId,
      binding.receiptId,
    ]),
  )
}

function answersKey(secret: string, purpose: ReceiptPurpose): Buffer {
  return derivePurposeKey(secret, NAMESPACE, `answers/${purpose}/v1`)
}

export function sealRoutingAnswers(
  secret: string,
  purpose: ReceiptPurpose,
  binding: ReceiptBinding,
  answers: RoutingAnswers,
): Buffer {
  return sealSecret(answersKey(secret, purpose), receiptAad(binding), JSON.stringify(answers))
}

/** Only decrypts answers authenticated to the supplied receipt and purpose. */
export function openRoutingAnswers(
  secret: string,
  purpose: ReceiptPurpose,
  binding: ReceiptBinding,
  ciphertext: Buffer | null,
): RoutingAnswers | undefined {
  if (ciphertext === null) return undefined
  try {
    // The authenticated JSON was serialized by sealRoutingAnswers from validated answers.
    return JSON.parse(openSecret(answersKey(secret, purpose), receiptAad(binding), ciphertext))
  } catch {
    return undefined
  }
}
