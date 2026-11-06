import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IDataObject } from 'n8n-workflow'

export const EVENTS = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.reschedule_requested',
  'booking.reschedule_request_expired',
] as const
export const TIMESTAMP_TOLERANCE_SECONDS = 300
export const RECEIPT_RETENTION_MS = 2 * TIMESTAMP_TOLERANCE_SECONDS * 1000
export const MAX_RECEIPTS = 10_000

/** Authenticate bytes before parsing; never trust the unsigned delivery/event ID headers. */
export function verifiedEvent(
  raw: Buffer,
  timestamp: unknown,
  signature: unknown,
  secret: unknown,
  now = Date.now(),
): IDataObject | undefined {
  if (
    typeof secret !== 'string' ||
    !secret ||
    typeof timestamp !== 'string' ||
    !/^\d{1,12}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    Math.abs(now / 1000 - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS
  )
    return undefined
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) return undefined
  try {
    const event: unknown = JSON.parse(raw.toString('utf8'))
    if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined
    const value = event as IDataObject
    if (
      typeof value.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id) ||
      typeof value.type !== 'string' ||
      !(EVENTS as readonly string[]).includes(value.type) ||
      !value.data ||
      typeof value.data !== 'object' ||
      Array.isArray(value.data)
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}

export const MAX_PROCESS_RECEIPTS = 100_000
export const MAX_RECEIPT_SCOPES = 1_000

function receiptScope(data: IDataObject) {
  return createHash('sha256')
    .update(JSON.stringify([data.webhookId, data.webhookSecret]))
    .digest('hex')
}

/** n8n creates distinct Workflow/static-data snapshots per delivery. Coordinate claims across
 * those snapshots synchronously in this process, then merge receipts back for persistence.
 * This is not a cross-worker transaction; consumers must also deduplicate durable effects.
 */
export function createReceiptCoordinator() {
  const scopes = new Map<string, Map<string, number>>()
  function claim(data: IDataObject, id: string, now = Date.now()): 'new' | 'duplicate' | 'full' {
    if (typeof data.webhookId !== 'string' || typeof data.webhookSecret !== 'string') return 'full'
    const scope = receiptScope(data)
    let total = 0
    for (const [key, receipts] of scopes) {
      for (const [eventId, receivedAt] of receipts) {
        if (receivedAt < now - RECEIPT_RETENTION_MS) receipts.delete(eventId)
      }
      if (!receipts.size) scopes.delete(key)
      total += receipts.size
    }
    let receipts = scopes.get(scope)
    if (!receipts) {
      if (scopes.size >= MAX_RECEIPT_SCOPES) return 'full'
      receipts = new Map()
      scopes.set(scope, receipts)
    }
    // Merge older snapshots without letting them overwrite newer receipt times or erase claims.
    const snapshot = (data.receipts ?? {}) as Record<string, number>
    for (const [eventId, receivedAt] of Object.entries(snapshot)) {
      if (!Number.isFinite(receivedAt) || receivedAt < now - RECEIPT_RETENTION_MS) continue
      const prior = receipts.get(eventId)
      if (prior !== undefined) {
        receipts.set(eventId, Math.max(prior, Math.min(receivedAt, now)))
      } else {
        if (receipts.size >= MAX_RECEIPTS || total >= MAX_PROCESS_RECEIPTS) return 'full'
        receipts.set(eventId, Math.min(receivedAt, now))
        total++
      }
    }
    data.receipts = Object.fromEntries(receipts)
    if (receipts.has(id)) return 'duplicate'
    // Only a flood inside the signature window may exhaust capacity; older claims were pruned.
    if (receipts.size >= MAX_RECEIPTS || total >= MAX_PROCESS_RECEIPTS) return 'full'
    receipts.set(id, now)
    data.receipts = Object.fromEntries(receipts)
    return 'new'
  }
  return Object.assign(claim, {
    clear(data: IDataObject) {
      scopes.delete(receiptScope(data))
      delete data.receipts
    },
  })
}

export const claimEvent = createReceiptCoordinator()
