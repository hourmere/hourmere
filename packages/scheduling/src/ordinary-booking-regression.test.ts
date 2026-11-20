import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CreateBookingInput,
  createPublicBooking,
  createPublicTeamBooking,
} from './bookings.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T12:00:00Z')
const slug = 'consultation'
const invitee = { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' }

describe.skipIf(!serverUrl)('ordinary booking compatibility', () => {
  let owned: TestDatabase
  let db: Db
  let observed: Db
  const statements: string[] = []

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'ordinary_booking' })
    db = createDb(owned.pool)
    observed = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(team: boolean) {
    const f = createFixtures(db)
    const host = await f.host({ timeZone: 'UTC' })
    await f.schedule(host.userId, { timeZone: 'UTC' })
    const handle = team ? `team-${randomUUID()}` : host.handle
    const organizationId = team ? await f.organization(handle) : host.organizationId
    if (team) await f.member(host.userId, organizationId, 'owner')
    const eventTypeId = await f.eventType(organizationId, team ? null : host.userId, {
      slug,
      hosts: [{ userId: host.userId }],
      allowGuests: true,
      questions: [
        { id: 'topic', label: 'Topic', type: 'long_text' },
        { id: 'agree', label: 'I agree', type: 'checkbox' },
      ],
    })
    return { handle, eventTypeId }
  }

  // Measured before routing integration, with no notifier or external providers.
  const bookings = [
    {
      kind: 'personal',
      create: createPublicBooking,
      team: false,
      unkeyed: 27,
      keyed: 30,
      replay: 8,
    },
    {
      kind: 'team',
      create: createPublicTeamBooking,
      team: true,
      unkeyed: 32,
      keyed: 35,
      replay: 11,
    },
  ]

  it.each(bookings)(
    'preserves the $kind booking and replay SQL counts and lock order',
    async ({ create, team, unkeyed, keyed, replay: replayQueries }) => {
      const { handle } = await setup(team)
      const ctx = { db: observed, now }
      const input: CreateBookingInput = {
        handle,
        slug,
        start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
        invitee,
      }
      const locks = (sql: string[]) =>
        sql.filter(
          (statement) =>
            statement.includes('pg_advisory_xact_lock') || / for (share|update)/.test(statement),
        )
      const expectedLocks = [
        ...(!team ? [expect.stringContaining('from "auth"."user"')] : []),
        expect.stringContaining('from "auth"."organization"'),
        expect.stringContaining('pg_advisory_xact_lock'),
        expect.stringContaining('for share of "et"'),
        ...(team
          ? [
              expect.stringContaining('from "auth"."user"'),
              expect.stringContaining('from "auth"."member"'),
            ]
          : []),
      ]

      statements.length = 0
      const ordinary = await create(ctx, input)
      expect(ordinary.replayed).toBe(false)
      expect(statements).toHaveLength(unkeyed)
      expect(locks(statements)).toEqual(expectedLocks)

      const retryable = {
        ...input,
        start: input.start.add({ hours: 1 }),
        idempotencyKey: randomUUID(),
      }
      statements.length = 0
      const created = await create(ctx, retryable)
      expect(created.replayed).toBe(false)
      expect(statements).toHaveLength(keyed)
      expect(locks(statements)).toEqual(expectedLocks)

      statements.length = 0
      const replay = await create(ctx, retryable)
      expect(replay).toMatchObject({
        booking: { id: created.booking.id },
        manageToken: null,
        replayed: true,
      })
      expect(statements).toHaveLength(replayQueries)
      expect(locks(statements)).toEqual([])
    },
  )

  it('stores the same SHA-256 fingerprint bytes as an ordinary booking on main', async () => {
    const { handle, eventTypeId } = await setup(false)
    await db
      .updateTable('event_types')
      .set({
        locations: JSON.stringify([
          { id: 'call', kind: 'phone', askInvitee: true, isDefault: true },
        ]),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const input: CreateBookingInput = {
      handle,
      slug,
      start: Temporal.Instant.from('2026-11-02T09:00:00Z'),
      invitee: { ...invitee, name: ' Invitee ', locale: 'en-US' },
      guests: [{ name: 'Guest', email: 'guest@example.test' }],
      responses: { topic: ' Discuss scope ', agree: false },
      durationMinutes: 30,
      locationOptionId: 'call',
      inviteePhone: '+14155550123',
      smsConsent: false,
      idempotencyKey: randomUUID(),
    }
    const result = await createPublicBooking({ db, now }, input)
    const { idempotency_fingerprint: stored } = await db
      .selectFrom('bookings')
      .select('idempotency_fingerprint')
      .where('id', '=', result.booking.id)
      .executeTakeFirstOrThrow()

    // The pre-routing canonical JSON, with sorted keys. Use raw submitted values, including
    // whitespace, and produce the digest independently from the service's serializer.
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          durationMinutes: 30,
          eventTypeId,
          guests: [{ email: 'guest@example.test', name: 'Guest' }],
          invitee: {
            email: 'invitee@example.test',
            locale: 'en-US',
            name: ' Invitee ',
            timeZone: 'UTC',
          },
          inviteePhone: '+14155550123',
          locationOptionId: 'call',
          responses: { agree: false, topic: ' Discuss scope ' },
          smsConsent: false,
          start: '2026-11-02T09:00:00Z',
        }),
      )
      .digest()
    expect(stored).toEqual(expected)
  })
})
