import { BULK_BOOKING_PREVIEW_CODES } from '@hourmere/scheduling'

export const BULK_BOOKING_OUTCOMES = [
  'pending',
  'cancelled',
  ...BULK_BOOKING_PREVIEW_CODES.filter((code) => code !== 'eligible'),
  'authorization_lost',
  'processing_failed',
] as const

export type BulkBookingOutcome = (typeof BULK_BOOKING_OUTCOMES)[number]

export function bulkOutcomeCounts(codes: readonly BulkBookingOutcome[]) {
  const counts = Object.fromEntries(BULK_BOOKING_OUTCOMES.map((code) => [code, 0])) as Record<
    BulkBookingOutcome,
    number
  >
  for (const code of codes) counts[code]++
  return counts
}
