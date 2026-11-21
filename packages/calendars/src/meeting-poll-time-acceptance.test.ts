import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, testContext, weekdays } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { submitMeetingPollBallot } from '../../scheduling/src/meeting-poll-ballots.ts'
import { finalizeMeetingPoll } from '../../scheduling/src/meeting-poll-finalize.ts'
import { getMeetingPollResults } from '../../scheduling/src/meeting-poll-results.ts'
import {
  inviteMeetingPollVoters,
  openMeetingPollCredential,
} from '../../scheduling/src/meeting-poll-voters.ts'
import {
  type CreateMeetingPollInput,
  createMeetingPoll,
  type MeetingPoll,
} from '../../scheduling/src/meeting-polls.ts'
import { encryptCredential } from './credentials.ts'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from './google.ts'
import { tokenAad } from './index.ts'
import { syncGoogleCalendar } from './sync.ts'
import { calendarTestSession, fakeGoogle, TEST_CALENDAR_KEY } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2040-10-28T12:00:00Z')
const LOS_ANGELES = 'America/Los_Angeles'
const SHANGHAI = 'Asia/Shanghai'
const LONDON = 'Europe/London'
const hours = [{ start: '00:00', end: '24:00' }]

describe.skipIf(!databaseUrl)('meeting poll time acceptance (Postgres and fake Google)', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'poll_time' })
    const catalog = createDb(owned.pool)
    await sql`CREATE SCHEMA poll_acceptance_clock`.execute(catalog)
    // Pin the app-facing database clock so these DST fixtures do not age out.
    await sql`CREATE FUNCTION poll_acceptance_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$ SELECT '2040-10-28T12:00:00Z'::timestamptz $$`.execute(catalog)
    const url = new URL(owned.url)
    url.searchParams.set('options', '-c search_path=poll_acceptance_clock,pg_catalog,public')
    db = createDb(createPool(url.toString()))
  })

  afterAll(async () => {
    try {
      await db?.destroy()
    } finally {
      await owned?.drop()
    }
  })

  async function setup(candidateStarts: string[], hostZone = LOS_ANGELES) {
    const owner = await calendarTestSession(db)
    const fixtures = createFixtures(db)
    await db
      .insertInto('profiles')
      .values({
        user_id: owner.user.id,
        handle: `poll-time-${owner.user.id.slice(-12)}`,
        time_zone: LOS_ANGELES,
      })
      .execute()
    await fixtures.schedule(owner.user.id, {
      timeZone: hostZone,
      weeklyHours: { ...weekdays(...hours), saturday: hours, sunday: hours },
    })
    const eventTypeId = await fixtures.eventType(owner.organization.id, owner.user.id, {
      durationMinutes: 30,
      slotStepMinutes: 30,
    })
    const ctx = {
      ...testContext(db, owner, () => NOW),
      meetingPollSecret: 'synthetic-poll-time-acceptance-only',
    }
    const input: CreateMeetingPollInput = {
      eventTypeId,
      candidateStarts,
      deadlineAt: '2040-11-01T12:00:00Z',
      admissionMode: 'invited',
      displayTimeZone: LOS_ANGELES,
      idempotencyKey: randomUUID(),
    }
    return { owner, ctx, input }
  }

  async function vote(
    { owner, ctx }: Awaited<ReturnType<typeof setup>>,
    poll: MeetingPoll,
    timeZone: string,
  ) {
    const invited = await inviteMeetingPollVoters(ctx, {
      id: poll.id,
      idempotencyKey: randomUUID(),
      invitees: [{ name: 'Acceptance voter', email: 'voter@example.test', timeZone }],
    })
    const voterId = invited.entries[0]?.voterId
    assert.ok(voterId)
    const delivery = await db
      .selectFrom('meeting_poll_deliveries')
      .select(['generation', 'capability_ciphertext'])
      .where('voter_id', '=', voterId)
      .where('kind', '=', 'invitation')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      ctx.meetingPollSecret,
      {
        organizationId: owner.organization.id,
        pollId: poll.id,
        voterId,
        generation: delivery.generation,
      },
      delivery.capability_ciphertext,
    )
    assert.ok(credential)
    await submitMeetingPollBallot(ctx, {
      token: credential.token,
      votes: poll.candidates.map(({ id }) => ({ slotId: id, value: 'yes' })),
      consent: true,
      expectedBallotRevision: 0,
    })
    const results = await getMeetingPollResults(ctx, poll.id)
    const [first] = poll.candidates
    assert.ok(first)
    return {
      id: poll.id,
      slotId: first.id,
      bookerVoterId: voterId,
      attendeeVoterIds: [voterId],
      expectedBallotRevisions: { [voterId]: 1 },
      expectedResultsRevision: results.resultsRevision,
      acknowledgeConditional: false,
      idempotencyKey: randomUUID(),
    }
  }

  it('keeps both fall-back candidates distinct and books elapsed time across the offset change', async () => {
    const repeated = ['2040-11-04T01:30:00-08:00', '2040-11-04T01:30:00-07:00']
    const f = await setup(repeated, LONDON)
    const { poll } = await createMeetingPoll(f.ctx, f.input)
    expect(poll.candidates.map(({ startAt, endAt }) => [startAt, endAt])).toEqual([
      ['2040-11-04T08:30:00Z', '2040-11-04T09:00:00Z'],
      ['2040-11-04T09:30:00Z', '2040-11-04T10:00:00Z'],
    ])
    expect(
      poll.candidates.map(({ startAt }) =>
        Temporal.Instant.from(startAt)
          .toZonedDateTimeISO(LOS_ANGELES)
          .toString({ timeZoneName: 'never' }),
      ),
    ).toEqual(['2040-11-04T01:30:00-07:00', '2040-11-04T01:30:00-08:00'])
    expect(new Set(poll.candidates.map(({ id }) => id)).size).toBe(2)
    const local = await setup(repeated)
    // The ordinary availability engine offers the earlier occurrence on a host's repeated grid.
    await expect(createMeetingPoll(local.ctx, local.input)).rejects.toMatchObject({
      code: 'slot_unavailable',
      unavailableStarts: ['2040-11-04T09:30:00Z'],
    })
    const { poll: localPoll } = await createMeetingPoll(local.ctx, {
      ...local.input,
      candidateStarts: ['2040-11-04T01:30:00-07:00', '2040-11-04T02:30:00-08:00'],
    })
    const request = await vote(local, localPoll, SHANGHAI)
    const { booking } = await finalizeMeetingPoll(local.ctx, request)
    expect(booking).toMatchObject({
      start: '2040-11-04T08:30:00.000Z',
      end: '2040-11-04T09:00:00.000Z',
    })
    const saved = await db
      .selectFrom('bookings as b')
      .innerJoin('booking_attendees as a', 'a.booking_id', 'b.id')
      .select(['b.start_at', 'b.end_at', 'a.time_zone'])
      .where('b.id', '=', booking.id)
      .where('a.is_booker', '=', true)
      .executeTakeFirstOrThrow()
    expect(saved.time_zone).toBe(SHANGHAI)
    expect(saved.end_at.getTime() - saved.start_at.getTime()).toBe(30 * 60_000)
  })

  it('applies PostgreSQL microsecond rounding before availability, deduplication and create replay', async () => {
    const f = await setup(['2040-11-04T08:29:59.9999996Z', '2040-11-04T09:30:00.0000004Z'], LONDON)
    const deadlineAt = '2040-11-01T20:00:00.1234566+08:00'
    const { poll } = await createMeetingPoll(f.ctx, { ...f.input, deadlineAt })
    expect(poll.deadlineAt).toBe('2040-11-01T12:00:00.123457Z')
    expect(poll.candidates.map(({ startAt }) => startAt)).toEqual([
      '2040-11-04T08:30:00Z',
      '2040-11-04T09:30:00Z',
    ])
    const rounded = poll.candidates.map(({ startAt }) => startAt)
    await expect(
      createMeetingPoll(f.ctx, {
        ...f.input,
        deadlineAt: poll.deadlineAt,
        candidateStarts: rounded.toReversed(),
      }),
    ).rejects.toMatchObject({ code: 'poll_already_created', pollId: poll.id })
    await expect(
      createMeetingPoll(f.ctx, {
        ...f.input,
        deadlineAt: '2040-11-01T12:00:00.123456Z',
        candidateStarts: rounded,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await expect(
      createMeetingPoll(f.ctx, {
        ...f.input,
        idempotencyKey: randomUUID(),
        candidateStarts: ['2040-11-04T08:30:00Z', f.input.candidateStarts[0] as string],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_poll',
      message: expect.stringContaining('same instant twice'),
    })
  })

  it('rechecks a synced all-day event in the host zone across the 25-hour fall-back day', async () => {
    const first = '2040-11-04T07:00:00Z' // LA midnight, PDT.
    const last = '2040-11-05T07:30:00Z' // LA 23:30, PST.
    const exclusiveEnd = '2040-11-05T08:00:00Z'
    const before = '2040-11-04T06:30:00Z' // Still November 3 in LA.
    const f = await setup([first, exclusiveEnd])
    const { poll } = await createMeetingPoll(f.ctx, f.input)
    const request = await vote(f, poll, LONDON)

    const account = 'synthetic-acceptance-calendar'
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: f.owner.user.id,
        provider: 'google',
        external_account_id: account,
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        credentials: encryptCredential(
          Buffer.from(TEST_CALENDAR_KEY, 'base64'),
          tokenAad(f.owner.user.id, account),
          JSON.stringify({
            accessToken: 'synthetic-calendar-access',
            refreshToken: 'synthetic-calendar-refresh',
            expiresAt: NOW.epochMilliseconds + 86_400_000,
          }),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'fake-shanghai-calendar',
        name: 'Acceptance calendar',
        time_zone: SHANGHAI,
        check_conflicts: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const provider = fakeGoogle(() => NOW.epochMilliseconds)
    provider.controls.eventPages = [
      {
        items: [{ id: 'busy-day', start: { date: '2040-11-04' }, end: { date: '2040-11-05' } }],
        nextSyncToken: 'test-page',
      },
    ]
    await syncGoogleCalendar(
      {
        db,
        now: () => NOW.epochMilliseconds,
        google: { client: provider.client, encryptionKey: TEST_CALENDAR_KEY },
      },
      calendar.id,
    )

    await expect(
      createMeetingPoll(f.ctx, {
        ...f.input,
        candidateStarts: [before, first, last, exclusiveEnd],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable', unavailableStarts: [first, last] })
    await expect(finalizeMeetingPoll(f.ctx, request)).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
    const alternate = poll.candidates[1]
    assert.ok(alternate)
    const { booking } = await finalizeMeetingPoll(f.ctx, { ...request, slotId: alternate.id })
    expect(Temporal.Instant.from(booking.start).toString()).toBe(exclusiveEnd)
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', f.input.eventTypeId)
        .execute(),
    ).toEqual([{ id: booking.id }])
  })
})
