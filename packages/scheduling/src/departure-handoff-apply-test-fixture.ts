import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { createPublicTeamBooking } from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { type DepartureHandoffOffer, getDepartureHandoffTerms } from './departure-handoff-apply.ts'
import { departureHandoffStore } from './departure-handoff-store.ts'
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
    candidate?: TestUser
    now?: () => Temporal.Instant
    start?: Temporal.Instant
    sourceContext?: Partial<PublicContext>
    applyContext?: Partial<ServiceContext>
    configureSource?: (event: FixtureEvent) => Promise<void>
    configureTarget?: (event: FixtureEvent) => Promise<void>
  } = {},
) {
  const owner = await createTestUser(db, 'Team owner')
  const departing = await createTestUser(db, 'Departing host')
  const candidate = options.candidate ?? (await createTestUser(db, 'Replacement host'))
  const team = await createTestTeam(db, [
    { user: owner, role: 'owner' },
    { user: departing, role: 'member' },
    { user: candidate, role: 'member' },
  ])
  const fixtures = createFixtures(db)
  await fixtures.schedule(departing.id, { timeZone: 'America/Los_Angeles' })
  if (!options.candidate) await fixtures.schedule(candidate.id, { timeZone: 'America/Los_Angeles' })
  const slug = 'handoff'
  const eventTypeId = await fixtures.eventType(team.id, null, {
    slug,
    hosts: [{ userId: departing.id }],
    allowGuests: true,
    questions: [{ id: 'notes', label: 'Notes', type: 'short_text' }],
  })
  const event = { eventTypeId, departing, candidate }
  await options.configureSource?.(event)
  const now = options.now ?? (() => HANDOFF_NOW)
  const organization = team.as(owner).organization
  const { booking, manageToken } = await createPublicTeamBooking(
    { ...options.sourceContext, db, now },
    {
      handle: organization.slug,
      slug,
      start: options.start ?? HANDOFF_START,
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

/** Seeds synthetic approved and pending recipients in the migrated tables. */
export function handoffTestRecords(db: Db) {
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
    const now = ctx.now()
    const saved = update({
      ...termsInput,
      version: input.version,
      state: 'live',
      issuedAt: now.subtract({ hours: 1 }).toString(),
      expiresAt: HANDOFF_START.toString(),
      termsDigest,
      approvals: recipientKeys.map((recipientKey) => ({
        recipientId: randomUUID(),
        recipientKey,
        version: input.version,
        approvedAt: now.subtract({ minutes: 30 }).toString(),
      })),
    })
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('departure_handoff_offers')
        .values({
          organization_id: input.teamId,
          source_booking_id: input.bookingId,
          id: input.offerId,
          version: saved.version,
          state: saved.state,
          issued_at: saved.issuedAt,
          expires_at: saved.expiresAt,
          departing_user_id: saved.departingUserId,
          proposer_user_id: ctx.principal.user.id,
          target_start_at: saved.start,
          duration_minutes: saved.durationMinutes,
          location_option_id: saved.locationOptionId ?? null,
          terms_digest: saved.termsDigest,
        })
        .execute()

      const approved = new Map(saved.approvals.map((approval) => [approval.recipientKey, approval]))
      await trx
        .insertInto('departure_handoff_recipients')
        .values(
          recipientKeys.map((recipientKey) => {
            const approval = approved.get(recipientKey)
            return {
              organization_id: input.teamId,
              source_booking_id: input.bookingId,
              offer_id: input.offerId,
              offer_version: input.version,
              id: approval?.recipientId ?? randomUUID(),
              recipient_key: recipientKey,
              decision: approval ? 'approved' : null,
              decided_at: approval?.approvedAt ?? null,
            }
          }),
        )
        .execute()
    })
    return { recipientKeys, offer: saved }
  }

  async function receipts(input: ApplyInput) {
    const rows = await db
      .selectFrom('departure_booking_handoffs')
      .select([
        'offer_version',
        'applying_user_id',
        'applied_at',
        'recipient_ids',
        'replacement_booking_id',
      ])
      .where('organization_id', '=', input.teamId)
      .where('source_booking_id', '=', input.bookingId)
      .execute()
    return rows.map((row) => ({
      version: row.offer_version,
      applyingUserId: row.applying_user_id,
      appliedAt: Temporal.Instant.fromEpochMilliseconds(row.applied_at.getTime()).toString(),
      recipientIds: row.recipient_ids,
      replacementBookingId: row.replacement_booking_id,
    }))
  }

  return { store: departureHandoffStore, offer, receipts }
}
