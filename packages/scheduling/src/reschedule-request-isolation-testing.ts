import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { expect } from 'vitest'
import type * as Bookings from './bookings.ts'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { createFixtures, createTestTeam, createTestUser } from './testing.ts'

type Services = Pick<
  typeof Bookings,
  'requestReschedule' | 'cancelManagedBooking' | 'rescheduleManagedBooking'
>
type Fixture = {
  ctx: ServiceContext
  pub: PublicContext
  created: Awaited<ReturnType<typeof Bookings.createPublicBooking>>
  events: BookingEvent[]
}
async function domainError(fn: () => Promise<unknown>): Promise<DomainError> {
  const result = await fn().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(result).toBeInstanceOf(DomainError)
  return result as DomainError
}
const changed = {
  kind: 'conflict',
  code: 'reschedule_request_changed',
  message: 'This reschedule request has already been resolved or replaced',
}

/** The same assertions exercise real services and intentionally weakened source copies. */
export async function assertOrganizationIsolation(
  db: Db,
  services: Services,
  kind: 'session' | 'api_key',
) {
  const host = await createTestUser(db)
  const members = [{ user: host, role: 'owner' }]
  const first = await createTestTeam(db, members)
  const second = await createTestTeam(db, members)
  const bookingId = await createFixtures(db).booking(
    second.id,
    [host.id],
    '2026-11-02T09:00Z',
    '2026-11-02T09:30Z',
  )
  const events: BookingEvent[] = []
  const base = first.as(host)
  const ctx: ServiceContext = {
    db,
    now: () => Temporal.Instant.from('2026-11-01T12:00Z'),
    principal:
      kind === 'session'
        ? { ...base, kind, sessionId: randomUUID() }
        : { ...base, kind, apiKeyId: randomUUID(), apiKeyScope: 'bookings' },
    notify: async (_trx, event) => {
      events.push(event)
    },
  }
  const missing = await domainError(() =>
    services.requestReschedule(ctx, randomUUID(), { idempotencyKey: randomUUID() }),
  )
  const foreign = await domainError(() =>
    services.requestReschedule(ctx, bookingId, { idempotencyKey: randomUUID() }),
  )
  expect({ kind: foreign.kind, code: foreign.code, message: foreign.message }).toEqual({
    kind: missing.kind,
    code: 'booking_not_found',
    message: missing.message,
  })
  expect(events).toEqual([])
  expect(
    await db
      .selectFrom('booking_reschedule_requests')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .execute(),
  ).toEqual([])
  expect(
    await db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: 'confirmed' })
}

export async function assertManageRequestIsolation(
  db: Db,
  services: Services,
  setup: () => Promise<Fixture>,
  state: 'pending' | 'picked' | 'cancelled',
  action: 'pick' | 'cancel',
) {
  const x = await setup()
  const y = await setup()
  await services.requestReschedule(x.ctx, x.created.booking.id, { idempotencyKey: randomUUID() })
  const request = await services.requestReschedule(y.ctx, y.created.booking.id, {
    idempotencyKey: randomUUID(),
  })
  const requestId = request.pendingReschedule?.id
  if (!requestId || !x.created.manageToken || !y.created.manageToken)
    throw new Error('Missing fixture')
  const start = Temporal.Instant.from('2026-11-02T10:00Z')
  if (state === 'picked')
    await services.rescheduleManagedBooking(y.pub, y.created.manageToken, {
      start,
      rescheduleRequestId: requestId,
    })
  if (state === 'cancelled')
    await services.cancelManagedBooking(y.pub, y.created.manageToken, {
      rescheduleRequestId: requestId,
    })
  const snapshot = async () => ({
    bookings: await db
      .selectFrom('bookings')
      .selectAll()
      .where('organization_id', 'in', [
        x.ctx.principal.organization.id,
        y.ctx.principal.organization.id,
      ])
      .orderBy('id')
      .execute(),
    requests: await db
      .selectFrom('booking_reschedule_requests')
      .selectAll()
      .where('booking_id', 'in', [x.created.booking.id, y.created.booking.id])
      .orderBy('id')
      .execute(),
    events: [...x.events, ...y.events],
  })
  const before = await snapshot()
  const token = x.created.manageToken
  const invoke = (rescheduleRequestId: string) =>
    action === 'pick'
      ? services.rescheduleManagedBooking(x.pub, token, { start, rescheduleRequestId })
      : services.cancelManagedBooking(x.pub, token, { rescheduleRequestId })
  // Both unknown and foreign IDs give the same generic error, including on receipt replay.
  for (const id of [randomUUID(), requestId]) {
    const error = await domainError(() => invoke(id))
    expect({ kind: error.kind, code: error.code, message: error.message }).toEqual(changed)
    expect(error.detail).toBe(changed.message)
  }
  expect(await snapshot()).toEqual(before)
}
