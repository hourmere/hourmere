import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { createPublicTeamBooking } from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import {
  type DepartureHandoffApplyStore,
  type DepartureHandoffOffer,
  getDepartureHandoffTerms,
} from './departure-handoff-apply.ts'
import { createFixtures, createTestTeam, createTestUser, type TestUser } from './testing.ts'

export const HANDOFF_NOW = Temporal.Instant.from('2026-11-01T16:00:00Z')
export const HANDOFF_START = Temporal.Instant.from('2026-11-02T17:00:00Z')
export const HANDOFF_END = HANDOFF_START.add({ minutes: 30 })

type TestOrganization = ServiceContext['principal']['organization']
type ApplyInput = {
  teamId: string
  expectedOrganizationId: string
  bookingId: string
  offerId: string
  version: number
}

export async function handoffTestSession(db: Db, user: TestUser, organization: TestOrganization) {
  const { id: sessionId } = await db
    .insertInto('auth.session')
    .values({
      userId: user.id,
      token: randomUUID(),
      expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
      activeOrganizationId: organization.id,
      updatedAt: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { kind: 'session' as const, user, organization, sessionId }
}

type FixtureEvent = {
  eventTypeId: string
  departing: TestUser
  candidate: TestUser
}

export async function createHandoffTestFixture(
  db: Db,
  options: {
    sourceContext?: Partial<PublicContext>
    applyContext?: Partial<ServiceContext>
    configureSource?: (event: FixtureEvent) => Promise<void>
    configureTarget?: (event: FixtureEvent) => Promise<void>
  } = {},
) {
  const owner = await createTestUser(db, 'Team owner')
  const departing = await createTestUser(db, 'Departing host')
  const candidate = await createTestUser(db, 'Replacement host')
  const team = await createTestTeam(db, [
    { user: owner, role: 'owner' },
    { user: departing, role: 'member' },
    { user: candidate, role: 'member' },
  ])
  const fixtures = createFixtures(db)
  await fixtures.schedule(departing.id, { timeZone: 'America/Los_Angeles' })
  await fixtures.schedule(candidate.id, { timeZone: 'America/Los_Angeles' })
  const slug = 'handoff'
  const eventTypeId = await fixtures.eventType(team.id, null, {
    slug,
    hosts: [{ userId: departing.id }],
    allowGuests: true,
    questions: [{ id: 'notes', label: 'Notes', type: 'short_text' }],
  })
  const event = { eventTypeId, departing, candidate }
  await options.configureSource?.(event)
  const now = () => HANDOFF_NOW
  const organization = team.as(owner).organization
  const { booking, manageToken } = await createPublicTeamBooking(
    { ...options.sourceContext, db, now },
    {
      handle: organization.slug,
      slug,
      start: HANDOFF_START,
      invitee: { name: 'Private Booker', email: 'booker@example.test', timeZone: 'UTC' },
      guests: [{ name: 'Private Guest', email: 'guest@example.test' }],
      responses: { notes: 'Approved answer' },
    },
  )
  if (!manageToken) throw new Error('Missing source booking manage token')
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('event_type_hosts').where('event_type_id', '=', eventTypeId).execute()
    await trx
      .insertInto('event_type_hosts')
      .values({ event_type_id: eventTypeId, user_id: candidate.id })
      .execute()
  })
  await options.configureTarget?.(event)
  const ctx = {
    ...options.applyContext,
    db,
    now,
    notify: options.applyContext?.notify ?? (async () => {}),
    principal: await handoffTestSession(db, owner, organization),
  }
  const input = {
    teamId: team.id,
    expectedOrganizationId: team.id,
    bookingId: booking.id,
    offerId: randomUUID(),
    version: 1,
  } satisfies ApplyInput
  return { ...event, team, owner, ctx, input, booking, manageToken }
}

/** A transaction-bound stand-in for the future offer, consent and receipt tables. */
export async function createHandoffTestStorage(db: Db) {
  await sql`CREATE TABLE test_handoff_offers (
    organization_id uuid NOT NULL,
    source_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    offer jsonb NOT NULL,
    PRIMARY KEY (organization_id, source_id, offer_id),
    FOREIGN KEY (source_id, organization_id) REFERENCES bookings (id, organization_id)
  )`.execute(db)
  await sql`CREATE TABLE test_handoff_receipts (
    organization_id uuid NOT NULL,
    source_id uuid NOT NULL PRIMARY KEY,
    offer_id uuid NOT NULL,
    replacement_id uuid NOT NULL UNIQUE,
    evidence jsonb NOT NULL,
    CHECK (replacement_id <> source_id),
    FOREIGN KEY (organization_id, source_id, offer_id) REFERENCES test_handoff_offers,
    FOREIGN KEY (replacement_id, organization_id) REFERENCES bookings (id, organization_id)
  )`.execute(db)

  const store: DepartureHandoffApplyStore = {
    async lockOffer(trx, key) {
      const {
        rows: [row],
      } = await sql<{
        offer: DepartureHandoffOffer
        replacement_id: string | null
      }>`SELECT offer, replacement_id FROM test_handoff_offers AS offers
        LEFT JOIN test_handoff_receipts USING (organization_id, source_id, offer_id)
        WHERE organization_id = ${key.organizationId} AND source_id = ${key.sourceBookingId}
          AND offer_id = ${key.offerId}
        FOR UPDATE OF offers`.execute(trx)
      return (
        row && {
          ...row.offer,
          ...(row.replacement_id && { committed: { replacementBookingId: row.replacement_id } }),
        }
      )
    },
    async commitHandoff(trx, key, evidence) {
      await sql`INSERT INTO test_handoff_receipts
        (organization_id, source_id, offer_id, replacement_id, evidence)
        VALUES (${key.organizationId}, ${key.sourceBookingId}, ${key.offerId},
          ${evidence.replacementBookingId}, ${JSON.stringify(evidence)}::jsonb)`.execute(trx)
    },
  }

  async function offer(
    ctx: ServiceContext,
    input: ApplyInput,
    options: {
      departingUserId: string
      start?: string
      durationMinutes?: number
      locationOptionId?: string
    },
    update: (offer: DepartureHandoffOffer) => DepartureHandoffOffer = (value) => value,
  ) {
    const termsInput = {
      bookingId: input.bookingId,
      departingUserId: options.departingUserId,
      start: options.start ?? HANDOFF_START.toString(),
      durationMinutes: options.durationMinutes ?? 30,
      ...(options.locationOptionId && { locationOptionId: options.locationOptionId }),
    }
    const { termsDigest, recipientKeys } = await getDepartureHandoffTerms(
      ctx,
      input.teamId,
      termsInput,
    )
    const saved = update({
      ...termsInput,
      version: input.version,
      state: 'live',
      issuedAt: HANDOFF_NOW.subtract({ hours: 1 }).toString(),
      expiresAt: HANDOFF_START.toString(),
      termsDigest,
      approvals: recipientKeys.map((recipientKey) => ({
        recipientId: randomUUID(),
        recipientKey,
        version: input.version,
        approvedAt: HANDOFF_NOW.subtract({ minutes: 30 }).toString(),
      })),
    })
    await sql`INSERT INTO test_handoff_offers (organization_id, source_id, offer_id, offer)
      VALUES (${input.teamId}, ${input.bookingId}, ${input.offerId}, ${JSON.stringify(saved)}::jsonb)
    `.execute(db)
    return { recipientKeys, offer: saved }
  }

  async function receipts(input: ApplyInput) {
    const { rows } = await sql<{
      evidence: Parameters<DepartureHandoffApplyStore['commitHandoff']>[2]
    }>`
      SELECT evidence FROM test_handoff_receipts WHERE source_id = ${input.bookingId}`.execute(db)
    return rows.map((row) => row.evidence)
  }

  return { store, offer, receipts }
}
