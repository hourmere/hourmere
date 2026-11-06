import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOneTimeBooking, createPublicBooking, createPublicTeamBooking } from './bookings.ts'
import { DomainError } from './errors.ts'
import { resolveLocationChoice } from './location-options.ts'
import { createOneTimeBookingLink } from './one-time-links.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00Z')
const input = {
  start: Temporal.Instant.from('2026-11-02T09:00Z'),
  invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
}
const expectedError = { kind: 'invalid', code: 'invalid_invitee_phone' }

describe.skipIf(!serverUrl)('legacy booking paths with invitee phone configuration', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'legacy_phone' })
    db = createDb(owned.pool)
  })
  afterAll(async () => owned?.drop())

  it.each(['personal', 'team', 'one-time'] as const)(
    'blocks %s booking before creating a numberless phone location',
    async (path) => {
      const f = createFixtures(db)
      const host = await f.host()
      await f.schedule(host.userId)
      const event = await f.eventType(host.organizationId, path === 'team' ? null : host.userId, {
        slug: 'phone',
        hosts: [{ userId: host.userId }],
      })
      if (path === 'team')
        await db
          .deleteFrom('personal_organizations')
          .where('organization_id', '=', host.organizationId)
          .execute()
      await db
        .updateTable('event_types')
        .set({
          locations: JSON.stringify([
            { id: 'office', kind: 'in_person', address: 'Example Street' },
            { id: 'invitee', kind: 'phone', askInvitee: true, isDefault: true },
          ]),
        })
        .where('id', '=', event)
        .execute()
      const ctx = { db, now }
      let attempt: Promise<unknown>
      let bookWithPhone: () => Promise<{ booking: { location: unknown } }>
      if (path === 'one-time') {
        const principal = {
          kind: 'session' as const,
          sessionId: 'synthetic-session',
          user: { id: host.userId, name: 'Host', email: 'host@example.test' },
          organization: {
            id: host.organizationId,
            name: 'Personal',
            slug: 'personal',
            personal: true,
          },
        }
        const link = await createOneTimeBookingLink({ ...ctx, principal }, { eventTypeId: event })
        attempt = createOneTimeBooking(ctx, { ...input, token: link.token })
        bookWithPhone = () =>
          createOneTimeBooking(ctx, { ...input, token: link.token, inviteePhone: '+14155550123' })
      } else if (path === 'team') {
        const org = await db
          .selectFrom('auth.organization')
          .select('slug')
          .where('id', '=', host.organizationId)
          .executeTakeFirstOrThrow()
        attempt = createPublicTeamBooking(ctx, { ...input, handle: org.slug, slug: 'phone' })
        bookWithPhone = () =>
          createPublicTeamBooking(ctx, {
            ...input,
            handle: org.slug,
            slug: 'phone',
            inviteePhone: '+14155550123',
          })
      } else {
        attempt = createPublicBooking(ctx, { ...input, handle: host.handle, slug: 'phone' })
        bookWithPhone = () =>
          createPublicBooking(ctx, {
            ...input,
            handle: host.handle,
            slug: 'phone',
            inviteePhone: '+14155550123',
          })
      }
      await expect(attempt).rejects.toMatchObject(expectedError)
      expect(
        await db.selectFrom('bookings').select('id').where('event_type_id', '=', event).execute(),
      ).toEqual([])
      expect(
        await db
          .selectFrom('one_time_booking_links')
          .select('state')
          .where('event_type_id', '=', event)
          .execute(),
      ).toEqual(path === 'one-time' ? [{ state: 'active' }] : [])
      expect((await bookWithPhone()).booking.location).toEqual({
        kind: 'phone',
        number: '+14155550123',
      })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
    },
  )
})

// Run the actual copied booking function with a changed locked read. This verifies
// the call site as well as the guard without making any external provider calls.
function copiedBooking(change?: readonly [string, string]) {
  const source = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
  const guardStart = source.indexOf('async function resolveBookingLocation(')
  const bodyStart = source.indexOf('async function publicBooking(')
  expect(guardStart).toBeGreaterThan(-1)
  expect(bodyStart).toBeGreaterThan(-1)
  let copy =
    source.slice(guardStart, source.indexOf('/**\n * Serializes', guardStart)) +
    source.slice(bodyStart, source.indexOf('// --- Invitee links', bodyStart))
  if (change) {
    expect(copy).toContain(change[0])
    copy = copy.replace(...change)
  }
  const noop = async () => {}
  const bindings = {
    DomainError,
    resolveLocationChoice,
    automaticMeet: () => false,
    automaticZoom: () => false,
    eventTypeNotFound: () => new DomainError('not_found', 'event_type_not_found'),
    bookingIdempotency: () => undefined,
    validateResponses: () => ({}),
    validateInvitee: (value: unknown) => value,
    validateGuests: () => [],
    lockOrganization: noop,
    lockHosts: noop,
    createNotificationSnapshot: () => ({}),
    selectDurationMinutes: () => 30,
    requireOfferedSlot: noop,
    bookingSuccessRedirect: () => undefined,
    toIso: (value: Temporal.Instant) => value.toString(),
    insertBooking: async () => ({ id: 'synthetic-booking', manageToken: null }),
    prepareBookingConference: noop,
    loadBooking: async () => ({}),
    pgError: () => ({}),
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(copy)}; return publicBooking`,
  )(...Object.values(bindings)) as (...args: unknown[]) => Promise<unknown>
}

async function verifyLockedPhoneGuard(book: ReturnType<typeof copiedBooking>) {
  const initial = {
    id: 'event',
    organizationId: 'org',
    schedulingType: 'individual',
    hostUserIds: ['host'],
    location: { kind: 'phone', number: '+14155550123' },
    locations: [{ id: 'phone', kind: 'phone', number: '+14155550123' }],
    conferenceOrganizerUserId: null,
    questions: [],
    title: 'Call',
    hosts: [{ name: 'Host' }],
    allowGuests: false,
  }
  const trx = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirstOrThrow: async () => ({ notifications: null }) }),
      }),
    }),
  }
  const ctx = {
    db: { transaction: () => ({ execute: (fn: (trx: unknown) => unknown) => fn(trx) }) },
    now,
  }
  await expect(
    book(ctx, input, { source: 'api' }, async (_db: unknown, options?: { lock?: boolean }) =>
      options?.lock
        ? { ...initial, locations: [{ id: 'phone', kind: 'phone', askInvitee: true }] }
        : initial,
    ),
  ).rejects.toMatchObject(expectedError)
  await expect(book(ctx, input, { source: 'api' }, async () => initial)).resolves.toMatchObject({
    replayed: false,
  })
}

describe('invitee phone booking source-copy controls', () => {
  it.each([
    [
      'locked configuration check',
      'resolveBookingLocation(ctx, trx, current, selectedHostIds, input)',
      'resolveBookingLocation(ctx, trx, et, selectedHostIds, input)',
    ],
    [
      'choice resolution before persistence',
      'const choice = await resolveBookingLocation(ctx, trx, current, selectedHostIds, input)',
      'const choice = { location: null, locationOption: null }',
    ],
  ])('detects removal of %s', async (_name, before, after) => {
    await verifyLockedPhoneGuard(copiedBooking())
    await expect(
      verifyLockedPhoneGuard(copiedBooking([before as string, after as string])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyLockedPhoneGuard(copiedBooking())
  })
})
