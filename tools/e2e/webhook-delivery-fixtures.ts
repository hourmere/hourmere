import type { Db } from '../../packages/db/src/index.ts'
import type { AuditFixtureState } from './audit-data.ts'

export const historyEndpointId = '72900000-0000-4000-8000-000000000001'
export const emptyEndpointId = '72900000-0000-4000-8000-000000000002'
export const historyPrivateMarker = 'synthetic-history-private-marker'
export const fixtureDeliveryId = (number: number) =>
  `72900001-0000-4000-8000-${String(number).padStart(12, '0')}`

/** Seed representative worker outcomes without scheduling jobs or calling a receiver. */
export async function seedWebhookDeliveryHistory(
  db: Db,
  fixture: AuditFixtureState,
  space?: 'team',
) {
  const organizationId = space === 'team' ? fixture.teamOrganizationId : fixture.organizationId
  const bookingId = space === 'team' ? fixture.teamBookingId : fixture.bookingId
  const url = `https://${'longwebhookreceiver'.repeat(3)}.hourmere.invalid/${historyPrivateMarker}`
  const now = Date.now()
  const lastAttemptAt = new Date(now - 60_000)
  const deliveredAt = new Date(now - 30_000)
  const createdAt = new Date(now - 120_000)
  const pending = {
    status: 'pending',
    attempts: 2,
    http_status: 503,
    last_error: 'http_error',
    last_attempt_at: lastAttemptAt,
    delivered_at: null,
  }
  const skipped = {
    ...pending,
    status: 'skipped',
    attempts: 0,
    http_status: null,
    last_error: 'disabled',
    last_attempt_at: null,
  }
  const outcomes = [
    pending,
    {
      ...pending,
      status: 'delivered',
      attempts: 1,
      http_status: 204,
      last_error: null,
      delivered_at: deliveredAt,
    },
    {
      ...pending,
      status: 'failed',
      attempts: 13,
      http_status: null,
      last_error: 'transport_error',
    },
  ]

  await db
    .insertInto('webhooks')
    .values(
      [historyEndpointId, emptyEndpointId].map((id) => ({
        id,
        url,
        organization_id: organizationId,
        events: ['booking.reschedule_requested'],
        is_active: id === historyEndpointId,
        secret_ciphertext: Buffer.from(historyPrivateMarker),
      })),
    )
    .execute()
  await db
    .insertInto('webhook_deliveries')
    .values(
      Array.from({ length: 52 }, (_, index) => ({
        ...(outcomes[index] ?? skipped),
        id: fixtureDeliveryId(52 - index),
        webhook_id: historyEndpointId,
        organization_id: organizationId,
        booking_id: bookingId,
        event_id: fixtureDeliveryId(100 + index),
        request_id: fixtureDeliveryId(200 + index),
        event_type: 'booking.reschedule_requested',
        payload: JSON.stringify({ synthetic: historyPrivateMarker }),
        // The last stored delivery falls outside the 30-day query, leaving exactly two pages.
        created_at: index === 51 ? new Date(now - 31 * 86_400_000) : createdAt,
      })),
    )
    .execute()

  return { organizationId, createdAt, lastAttemptAt, deliveredAt }
}
