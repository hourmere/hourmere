import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Database, type Db, isImportedBooking } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { type Insertable, sql, type Updateable } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import { findOneTimeEventType, parseLocation } from './availability.ts'
import { automaticConference } from './conferences.ts'
import { getDepartureHandoffEligibility } from './departure-handoff-eligibility.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { meetingPollChainLinked } from './meeting-poll-outcomes.ts'
import { validateResponses } from './questions.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const start = '2032-01-05T09:00:00.000001Z'
const now = () => Temporal.Instant.from('2032-01-05T09:00:00Z')
const sourceError = { kind: 'conflict', code: 'handoff_source_ineligible' }
const candidateError = { kind: 'conflict', code: 'handoff_candidate_ineligible' }

describe.skipIf(!serverUrl)('departure handoff eligibility', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_source' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const [owner, departing, candidate] = await Promise.all([
      createTestUser(db, 'Team administrator'),
      createTestUser(db, 'Departing host'),
      createTestUser(db, 'Replacement host'),
    ])
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: departing, role: 'member' },
      { user: candidate, role: 'member' },
    ])
    const eventId = await createFixtures(db).eventType(team.id, null, {
      hosts: [{ userId: candidate.id }],
    })
    return { owner, departing, candidate, team, eventId, ctx: testContext(db, team.as(owner), now) }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>
  type BookingValues = Insertable<Database['bookings']>

  async function booking(f: Fixture, overrides: Partial<BookingValues> = {}, tx: Db = db) {
    const row = await tx
      .insertInto('bookings')
      .values({
        organization_id: f.team.id,
        event_type_id: f.eventId,
        title: 'Source booking',
        source: 'api',
        start_at: start,
        end_at: '2032-01-05T09:30:00.000001Z',
        required_host_user_ids: [f.departing.id],
        ...overrides,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await tx
      .insertInto('booking_attendees')
      .values({
        booking_id: row.id,
        name: 'Booker',
        email: 'invitee@example.test',
        time_zone: 'UTC',
        is_booker: true,
      })
      .execute()
    return row.id
  }

  function read(
    f: Fixture,
    bookingId: string,
    departingUserId = f.departing.id,
    service = getDepartureHandoffEligibility,
  ) {
    return service(f.ctx, f.team.id, { bookingId, departingUserId })
  }

  it('uses the saved sole host and exact source start after removal', async () => {
    const f = await fixture()
    const id = await booking(f, {
      location: JSON.stringify({
        kind: 'google_meet',
        autoCreate: true,
        url: 'https://meet.google.com/abc-defg-hij',
      }),
    })
    await db
      .insertInto('booking_hosts')
      .values({ booking_id: id, user_id: f.departing.id })
      .execute()
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.departing.id)
      .execute()

    const result = await read(f, id)
    expect(result.candidateUserId).toBe(f.candidate.id)
    expect(result.source.start.toString()).toBe(start)
    expect(result.source).not.toHaveProperty('location')
    await expect(read(f, id, f.candidate.id)).rejects.toMatchObject(sourceError)
  })

  it('uses the same not-found outcome for foreign and missing bookings', async () => {
    const f = await fixture()
    const foreign = await booking(await fixture())
    const expected = { kind: 'not_found', code: 'booking_not_found' }
    await expect(read(f, foreign)).rejects.toMatchObject(expected)
    await expect(read(f, randomUUID())).rejects.toMatchObject(expected)
  })

  it.each([
    ['a started appointment', { start_at: now().toString() }],
    ['a terminal appointment', { status: 'cancelled', cancelled_at: now().toString() }],
    ['an absent saved host snapshot', { required_host_user_ids: [] }],
    ['an imported appointment', { source: 'import', import_questions: '[]' }],
    [
      'an unmanaged conference URL',
      { location: '{"kind":"link","url":"https://example.test/private"}' },
    ],
    [
      'a pending payment hold',
      { status: 'pending_payment', payment_hold_expires_at: now().toString() },
    ],
    [
      'a paid appointment',
      { payment_hold_expires_at: now().toString(), payment_reference: 'test-payment' },
    ],
    ['a saved round-robin host under a repaired event', { hosts_use_default_schedule: true }],
  ] satisfies [string, Partial<BookingValues>][])('excludes %s', async (_, row) => {
    const f = await fixture()
    await expect(read(f, await booking(f, row))).rejects.toMatchObject(sourceError)
  })

  it('excludes saved collective assignments under a repaired individual event', async () => {
    const f = await fixture()
    const id = await booking(f, { required_host_user_ids: [f.departing.id, f.owner.id] })
    await expect(read(f, id)).rejects.toMatchObject(sourceError)
  })

  it('excludes a malformed local successor of an imported booking', async () => {
    const f = await fixture()
    const root = await booking(f, { source: 'import', import_questions: '[]' })
    const id = await booking(f, { rescheduled_from_id: root })
    await expect(read(f, id)).rejects.toMatchObject(sourceError)
  })

  it('requires the current leaf and rejects a paid chain after its ordinary move', async () => {
    const f = await fixture()
    const predecessor = await booking(f, {
      payment_hold_expires_at: now().toString(),
      payment_reference: 'test-paid-chain',
    })
    await db
      .updateTable('bookings')
      .set({ status: 'cancelled', cancelled_at: now().toString() })
      .where('id', '=', predecessor)
      .execute()
    // An older active row with a successor fails even if its status is inconsistent.
    const ordinaryPredecessor = await booking(f)
    const id = await booking(f, { rescheduled_from_id: predecessor })
    const ordinaryLeaf = await booking(f, { rescheduled_from_id: ordinaryPredecessor })
    const attempt = randomUUID()
    await db
      .insertInto('payment_checkout_attempts')
      .values({
        id: attempt,
        booking_id: predecessor,
        current_booking_id: id,
        account_id: 'test-account',
        mode: 'test',
        amount_minor: 2000,
        currency: 'usd',
        idempotency_key: attempt,
      })
      .execute()
    await expect(read(f, ordinaryPredecessor)).rejects.toMatchObject(sourceError)
    await expect(read(f, id)).rejects.toMatchObject(sourceError)
    await expect(read(f, ordinaryLeaf)).resolves.toMatchObject({ candidateUserId: f.candidate.id })
  })

  it('excludes saved routing snapshots with an assertion that detects removal of the guard', async () => {
    const f = await fixture()
    const id = await booking(f)
    await db
      .insertInto('booking_routing')
      .values({
        booking_id: id,
        organization_id: f.team.id,
        form_id: randomUUID(),
        version_id: randomUUID(),
        version_number: 1,
        matched_rule_id: 'fallback',
        resolved_rule_id: 'fallback',
        questions: '[]',
        answers: '{}',
      })
      .execute()
    const verify = async (service: typeof getDepartureHandoffEligibility) =>
      expect(read(f, id, f.departing.id, service)).rejects.toMatchObject(sourceError)
    await verify(getDepartureHandoffEligibility)

    const needle = 'source.has_routing_snapshot ||'
    const source = readFileSync(
      new URL('./departure-handoff-eligibility.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain(needle)
    const bindings = {
      sql,
      findOneTimeEventType,
      parseLocation,
      automaticConference,
      DomainError,
      isUuid,
      isImportedBooking,
      meetingPollChainLinked,
      validateResponses,
    }
    const body = source
      .replace(needle, '')
      .replace(/^import.*\n/gm, '')
      .replace(/\bexport /g, '')
    const copy = new Function(
      ...Object.keys(bindings),
      `${stripTypeScriptTypes(body)}; return getDepartureHandoffEligibility`,
    )(...Object.values(bindings)) as typeof getDepartureHandoffEligibility
    await expectKilled(guardCopy(copy), verify)
  })

  it('excludes a poll-linked booking after an ordinary reschedule', async () => {
    const f = await fixture()
    const root = await booking(f, { status: 'cancelled', cancelled_at: now().toString() })
    const leaf = await booking(f, { rescheduled_from_id: root })
    const pollId = randomUUID()
    const slotId = randomUUID()
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('meeting_polls')
        .values({
          id: pollId,
          organization_id: f.team.id,
          event_type_id: f.eventId,
          title: 'Poll',
          duration_minutes: 30,
          display_time_zone: 'UTC',
          settings_snapshot: '{}',
          settings_fingerprint: randomBytes(32),
          admission_mode: 'invited',
          deadline_at: '2032-01-04T10:00Z',
          created_at: '2032-01-04T08:00Z',
          status: 'scheduled',
          chosen_slot_id: slotId,
          scheduled_at: '2032-01-04T09:00Z',
          booking_id: root,
        })
        .execute()
      await trx
        .insertInto('meeting_poll_slots')
        .values([
          {
            id: slotId,
            organization_id: f.team.id,
            poll_id: pollId,
            start_at: start,
            end_at: '2032-01-05T09:30:00.000001Z',
            position: 0,
          },
          {
            organization_id: f.team.id,
            poll_id: pollId,
            start_at: '2032-01-07T09:00Z',
            end_at: '2032-01-07T09:30Z',
            position: 1,
          },
        ])
        .execute()
    })
    await expect(read(f, leaf)).rejects.toMatchObject(sourceError)
  })

  it('excludes group seats', async () => {
    const group = await groupFixture(owned.pool)
    const {
      bookings: [seat],
    } = await occupiedSlot(group)
    if (!seat) throw new Error('Fixture has no seat')
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal, () => Temporal.Instant.from('2031-12-01T00:00Z'))
    await expect(
      getDepartureHandoffEligibility(ctx, group.organization, {
        bookingId: seat,
        departingUserId: group.host,
      }),
    ).rejects.toMatchObject(sourceError)
  })

  it('excludes an occurrence of an otherwise eligible recurring event', async () => {
    const f = await fixture()
    const ids = await db.transaction().execute(async (trx) => {
      const { id: seriesId } = await trx
        .insertInto('booking_series')
        .values({
          organization_id: f.team.id,
          event_type_id: f.eventId,
          original_event_type_id: f.eventId,
          rule_pattern: 'weekly',
          first_local_start: '2032-01-06T09:00:00',
          time_zone: 'UTC',
          requested_count: 2,
          duration_minutes: 30,
          notification_snapshot: '{}',
          host_policy_snapshot: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const ids = []
      for (const [index, date] of ['2032-01-06', '2032-01-13'].entries()) {
        const id = randomUUID()
        const occurrenceStart = `${date}T09:00:00Z`
        const occurrenceEnd = `${date}T09:30:00Z`
        const { id: occurrenceId } = await trx
          .insertInto('booking_series_occurrences')
          .values({
            organization_id: f.team.id,
            series_id: seriesId,
            ordinal: index + 1,
            original_local_start: `${date}T09:00:00`,
            start_at: occurrenceStart,
            end_at: occurrenceEnd,
            root_booking_id: id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        ids.push(
          await booking(
            f,
            {
              id,
              start_at: occurrenceStart,
              end_at: occurrenceEnd,
              series_occurrence_id: occurrenceId,
            },
            trx,
          ),
        )
      }
      return ids
    })
    for (const id of ids) await expect(read(f, id)).rejects.toMatchObject(sourceError)
  })

  it('requires the configured replacement to be verified and eligible under SCIM', async () => {
    const f = await fixture()
    const id = await booking(f)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.candidate.id)
      .execute()
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: true })
      .where('id', '=', f.candidate.id)
      .execute()
    await createFixtures(db).suspendManagedChildMembership(f.team.id, f.candidate.id)
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
  })

  it('excludes an unchanged assignment and a candidate who has left the team', async () => {
    const f = await fixture()
    const id = await booking(f)
    await db
      .deleteFrom('auth.member')
      .where('organizationId', '=', f.team.id)
      .where('userId', '=', f.candidate.id)
      .execute()
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
    await db
      .updateTable('event_type_hosts')
      .set({ user_id: f.departing.id })
      .where('event_type_id', '=', f.eventId)
      .execute()
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
  })

  it('requires a repaired, active individual event and compatible attendee form', async () => {
    const f = await fixture()
    const id = await booking(f, { responses: '{"topic":"planning"}' })
    const questions = [{ id: 'topic', label: 'Topic', type: 'short_text' }]
    const update = (values: Updateable<Database['event_types']>) =>
      db.updateTable('event_types').set(values).where('id', '=', f.eventId).execute()
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
    await update({ questions: JSON.stringify(questions), is_active: false })
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
    await update({ is_active: true })
    await expect(read(f, id)).resolves.toMatchObject({ candidateUserId: f.candidate.id })
    await db
      .insertInto('booking_attendees')
      .values({
        booking_id: id,
        name: 'Guest',
        email: 'guest@example.test',
        time_zone: 'UTC',
      })
      .execute()
    await expect(read(f, id)).rejects.toMatchObject(candidateError)
  })
})
