import { sql } from 'kysely'
import { DomainError } from './errors.ts'
import {
  RoutingValidationError,
  validateRoutingAnswers,
  validateRoutingFormConfig,
} from './routing-form-config.ts'

export const isRoutingReceiptToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token)

export function routingReceiptCheckedAt(receiptNow?: () => Temporal.Instant) {
  return receiptNow
    ? sql<Date>`${new Date(receiptNow().epochMilliseconds)}::timestamptz`
    : sql<Date>`statement_timestamp()`
}

export function validateRoutingReceiptSnapshot(
  questions: unknown,
  resolvedTarget: unknown,
  decrypted: unknown,
) {
  // Validate only the pinned target and answers. Current publication cannot reroute this receipt.
  const unavailable = () => new DomainError('conflict', 'routing_unavailable')
  try {
    const { questions: sources, fallback: target } = validateRoutingFormConfig({
      questions,
      rules: [],
      fallback: resolvedTarget,
    })
    if (target.kind !== 'event') throw unavailable()
    return { sources, target, answers: validateRoutingAnswers(sources, decrypted) }
  } catch (error) {
    if (error instanceof RoutingValidationError) throw unavailable()
    throw error
  }
}
