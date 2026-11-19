import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { GOOGLE_CALENDAR_SYNC_SCOPES } from '@hourmere/calendars'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { cancelHostBooking, rescheduleHostBooking } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  submitMeetingPollBallot,
  withdrawMeetingPollVoter,
} from '../../scheduling/src/meeting-poll-ballots.ts'
import { finalizeMeetingPoll } from '../../scheduling/src/meeting-poll-finalize.ts'
import { createFinalizeFixture } from '../../scheduling/src/meeting-poll-finalize-fixture.ts'
import { removeMeetingPollVoter } from '../../scheduling/src/meeting-poll-results.ts'
import {
  inviteMeetingPollVoters,
  openMeetingPollCredential,
} from '../../scheduling/src/meeting-poll-voters.ts'
import { deleteMeetingPoll } from '../../scheduling/src/meeting-polls.ts'
import {
  bookingNotificationJob,
  bookingNotifier,
  dispatchConferenceNotifications,
  type NotificationKind,
} from './index.ts'
import {
  createMeetingPollEmailWorker,
  deliverMeetingPollEmail,
  type MeetingPollEmailDeps,
} from './meeting-polls.ts'
import { type RawMessage, rawMailCapture } from './testing/raw-mime.ts'
import { alignSmtpDateNowWithDatabase } from './testing-clock.ts'

const serverUrl = process.env.DATABASE_URL
const NOW = Temporal.Instant.from('2040-11-04T20:00:00Z')
const PUBLIC_URL = 'https://hourmere.example'
const JOIN = 'https://meet.google.com/abc-defg-hij'
const MANAGE = /#token=[\w-]{43}&action=reschedule/
const TITLE = 'Research review'

type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>

describe.skipIf(!serverUrl)('finalized meeting poll email outcomes', () => {
  let owned: TestDatabase
  let db: Db
  let capture: Awaited<ReturnType<typeof rawMailCapture>>
  const deps = () => ({
    db,
    mailer: capture.mailer,
    secret: 'synthetic-poll-outcome-mail-budget-secret',
    publicUrl: PUBLIC_URL,
    now: () => NOW,
  })
  const pollDeps = (fixture: Fixture): MeetingPollEmailDeps => ({
    ...deps(),
    smtpConfigured: true,
    meetingPollSecret: fixture.ctx.meetingPollSecret,
  })
  const createQueue = () =>
    createJobs({
      connectionString: owned.url,
      definitions: [bookingNotificationJob(deps())],
      work: false,
      maxConnections: 2,
      migrate: true,
    })
  let jobs: ReturnType<typeof createQueue>
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_outcomes' })
    // Freeze the scheduling connection's clock as in the ballot tests. pg-boss
    // keeps real PostgreSQL time, so the fixture's reminders stay well in its future.
    const catalog = createDb(owned.pool)
    await sql`CREATE SCHEMA poll_test_clock`.execute(catalog)
    await sql`CREATE FUNCTION poll_test_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$
        SELECT '2040-11-04T20:00:00Z'::timestamptz
      $$`.execute(catalog)
    const url = new URL(owned.url)
    url.searchParams.set('options', '-c search_path=poll_test_clock,pg_catalog,public')
    db = createDb(createPool(url.toString()))
    capture = await rawMailCapture('calendar@example.test')
    jobs = createQueue()
    await jobs.start()
  }, 120_000)
  beforeEach(async () => {
    await db.deleteFrom('meeting_polls').execute()
    await db.deleteFrom('bookings').execute()
    await db.deleteFrom('notification_email_sends').execute()
    capture.sent.length = 0
    await alignSmtpDateNowWithDatabase(createDb(owned.pool))
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      try {
        await capture?.close()
      } finally {
        try {
          await db?.destroy()
        } finally {
          await owned?.drop()
        }
      }
    }
  })

  async function setup(automaticMeet = false) {
    const fixture = await createFinalizeFixture(db, {
      event: {
        title: TITLE,
        location: automaticMeet
          ? { kind: 'google_meet', autoCreate: true }
          : { kind: 'link', url: JOIN },
      },
    })
    let destinationId: string | null = null
    if (automaticMeet) {
      const connection = await db
        .insertInto('calendar_connections')
        .values({
          user_id: fixture.owner.id,
          provider: 'google',
          external_account_id: 'synthetic-poll-calendar-account',
          credentials: Buffer.from('synthetic-poll-calendar-cache'),
          scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      destinationId = (
        await db
          .insertInto('calendars')
          .values({
            connection_id: connection.id,
            external_id: 'work',
            name: 'Work',
            access_role: 'owner',
            supports_google_meet: true,
            check_conflicts: false,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    }
    await db
      .insertInto('profiles')
      .values({
        user_id: fixture.owner.id,
        handle: `poll-${fixture.owner.id.slice(-12)}`,
        time_zone: 'UTC',
        destination_calendar_id: destinationId,
      })
      .execute()
    const ctx = { ...fixture.ctx, automaticMeet, notify: bookingNotifier(jobs) }
    return { ...fixture, ctx }
  }

  async function invite(fixture: Fixture, email: string, locale = 'en', timeZone = 'UTC') {
    const result = await inviteMeetingPollVoters(fixture.ctx, {
      id: fixture.poll.id,
      idempotencyKey: randomUUID(),
      invitees: [{ email, name: email.split('@')[0] as string, locale, timeZone }],
    })
    const voterId = result.entries[0]?.voterId
    assert.ok(voterId)
    return { id: voterId, email, hostRevision: result.poll.hostRevision }
  }

  async function withdraw(fixture: Fixture, email: string) {
    const { id: voterId } = await invite(fixture, email)
    const delivery = await db
      .selectFrom('meeting_poll_deliveries')
      .select(['generation', 'capability_ciphertext'])
      .where('voter_id', '=', voterId)
      .where('kind', '=', 'invitation')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      fixture.ctx.meetingPollSecret,
      {
        organizationId: fixture.organizationId,
        pollId: fixture.poll.id,
        voterId,
        generation: delivery.generation,
      },
      delivery.capability_ciphertext,
    )
    assert.ok(credential)
    await submitMeetingPollBallot(fixture.ctx, {
      token: credential.token,
      votes: fixture.poll.candidates.map(({ id }) => ({ slotId: id, value: 'yes' })),
      expectedBallotRevision: 0,
      consent: true,
    })
    await withdrawMeetingPollVoter(fixture.ctx, {
      token: credential.token,
      expectedBallotRevision: 1,
    })
  }

  // Drive the production handlers with the persisted payload. This controls delivery order
  // and exercises a replay without letting pg-boss polling or its singleton hide duplicate sends.
  async function runBookingJob(bookingId: string, kind: NotificationKind, attempt = 1) {
    const definition = bookingNotificationJob(deps())
    const { rows } = await sql<{ id: string; data: unknown }>`
      SELECT id, data FROM pgboss.job
      WHERE name = ${definition.name} AND data->>'bookingId' = ${bookingId} AND data->>'kind' = ${kind}
    `.execute(db)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    assert.ok(row)
    await definition.handler(definition.payload.parse(row.data), {
      id: row.id,
      attempt,
      signal: new AbortController().signal,
    })
  }

  function messageTo(email: string): RawMessage {
    const messages = capture.sent.filter(({ to }) => to === email)
    expect(messages).toHaveLength(1)
    const message = messages[0]
    assert.ok(message)
    expect(message.envelope).toEqual([email])
    return message
  }

  function expectPrivate(message: RawMessage, bookingId: string, otherAddresses: string[]) {
    expect(message.ics === undefined, 'outcome has no calendar part').toBe(true)
    const restricted = /text\/calendar|begin:vcalendar|\.ics\b|#token=|\/poll\/voter|<a\s[^>]*href=/
    expect(restricted.test(message.text), 'outcome has no invitation or action link').toBe(false)
    for (const excluded of [JOIN, PUBLIC_URL, bookingId, ...otherAddresses]) {
      expect(message.decoded.includes(excluded), 'outcome omits booking and attendee data').toBe(
        false,
      )
    }
  }

  it('delivers ordinary mail and localized outcomes to exactly the eligible recipients', async () => {
    const f = await setup()
    const booker = await f.addVoter()
    const guest = await f.addVoter()
    const unselected = await f.addVoter({ value: 'no' })
    const invited = await invite(f, 'invited@example.test', 'fr', 'Pacific/Kiritimati')
    await f.addVoter({ state: 'pending' })
    await withdraw(f, 'withdrawn@example.test')
    const removed = await invite(f, 'removed@example.test')
    await removeMeetingPollVoter(f.ctx, {
      id: f.poll.id,
      voterId: removed.id,
      expectedHostRevision: removed.hostRevision,
    })

    const input = await f.input([booker, guest])
    const result = await finalizeMeetingPoll(f.ctx, input)
    expect(result).toMatchObject({ booking: { source: 'web' }, replayed: false })
    expect(/manageToken|manageUrl/i.test(JSON.stringify(result))).toBe(false)
    const bookingId = result.booking.id
    expect(
      await db
        .selectFrom('bookings')
        .select('source')
        .where('id', '=', bookingId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ source: 'web' })

    await runBookingJob(bookingId, 'confirmed')
    const run = createMeetingPollEmailWorker(pollDeps(f))
    await run()
    const replay = await finalizeMeetingPoll(f.ctx, input)
    expect(replay).toEqual({ ...result, replayed: true })
    expect(/manageToken|manageUrl/i.test(JSON.stringify(replay))).toBe(false)
    await runBookingJob(bookingId, 'confirmed', 2)
    await run()

    const selectedAddresses = [booker.email, guest.email, f.owner.email]
    expect(capture.sent.map(({ to }) => to).sort()).toEqual(
      [...selectedAddresses, unselected.email, invited.email].sort(),
    )
    for (const email of selectedAddresses) {
      const message = messageTo(email)
      expect(message.ics).toContain('METHOD:REQUEST')
      expect(message.ics).toContain(`UID:${bookingId}@hourmere`)
      expect(message.decoded).toContain(JOIN)
      expect(MANAGE.test(message.decoded)).toBe(email === booker.email)
    }
    const notice = messageTo(invited.email)
    expect(notice.decoded).toContain('Créneau choisi pour Research review')
    expect(notice.decoded).toContain('<html lang="fr">')
    expect(notice.decoded).toContain('12 novembre 2040')
    expect(notice.decoded).toContain('10:00')
    expect(notice.decoded).toContain('Pacific/Kiritimati, GMT+14:00')
    expectPrivate(notice, bookingId, [...selectedAddresses, unselected.email])
    const other = messageTo(unselected.email)
    expect(other.decoded).toContain('You were not selected to attend.')
    expectPrivate(other, bookingId, [...selectedAddresses, invited.email])
  })

  it('sends one outcome when a second worker tries the same delivery during SMTP and after receipt', async () => {
    const f = await setup()
    const booker = await f.addVoter()
    const unselected = await f.addVoter()
    await finalizeMeetingPoll(f.ctx, await f.input([booker]))
    const request = await db
      .selectFrom('meeting_poll_deliveries')
      .select('id')
      .where('voter_id', '=', unselected.id)
      .where('kind', '=', 'selected')
      .executeTakeFirstOrThrow()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = createMeetingPollEmailWorker({
      ...pollDeps(f),
      mailer: {
        ...capture.mailer,
        async send(message, options) {
          started.resolve()
          await release.promise
          await capture.mailer.send(message, options)
        },
      },
    })()
    try {
      await Promise.race([
        started.promise,
        first.then(() => {
          throw new Error('Expected the first worker to claim the outcome')
        }),
      ])
      await deliverMeetingPollEmail(pollDeps(f), request)
      expect(capture.sent).toEqual([])
    } finally {
      release.resolve()
      await first
    }
    await deliverMeetingPollEmail(pollDeps(f), request)
    expect(capture.sent.map(({ to }) => to)).toEqual([unselected.email])
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select(['state', 'attempts', 'lease_id'])
        .where('id', '=', request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'sent', attempts: 1, lease_id: null })
  })

  it('drops queued poll mail when the poll is deleted before delivery', async () => {
    const f = await setup()
    const booker = await f.addVoter()
    const other = await f.addVoter()
    const result = await finalizeMeetingPoll(f.ctx, await f.input([booker]))
    const request = await db
      .selectFrom('meeting_poll_deliveries')
      .select('id')
      .where('voter_id', '=', other.id)
      .where('kind', '=', 'selected')
      .executeTakeFirstOrThrow()
    await deleteMeetingPoll(f.ctx, {
      id: f.poll.id,
      expectedHostRevision: result.poll.hostRevision,
    })
    await deliverMeetingPollEmail(pollDeps(f), request)
    await createMeetingPollEmailWorker(pollDeps(f))()
    expect(capture.sent).toEqual([])
    await runBookingJob(result.booking.id, 'confirmed')
    expect(capture.sent.map(({ to }) => to).sort()).toEqual([booker.email, f.owner.email].sort())
  })

  it('keeps automatic booking invitations gated while the conference is unready', async () => {
    const f = await setup(true)
    const booker = await f.addVoter()
    const guest = await f.addVoter()
    const other = await f.addVoter()
    const { booking } = await finalizeMeetingPoll(f.ctx, await f.input([booker, guest]))
    const conference = await db
      .selectFrom('booking_conferences')
      .select(['state', 'revision'])
      .where('booking_id', '=', booking.id)
      .executeTakeFirstOrThrow()
    expect(conference.state).toBe('pending')
    const run = createMeetingPollEmailWorker(pollDeps(f))
    await run()
    await runBookingJob(booking.id, 'confirmed')
    await dispatchConferenceNotifications(deps())
    const ordinary = [booker.email, guest.email, f.owner.email]
    expect(capture.sent.map(({ to }) => to)).toEqual([other.email])
    expectPrivate(messageTo(other.email), booking.id, ordinary)

    // Record the state created by the conference worker after provider success.
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('bookings')
        .set({ location: { kind: 'google_meet', autoCreate: true, url: JOIN } })
        .where('id', '=', booking.id)
        .execute()
      await trx
        .updateTable('booking_conferences')
        .set({ state: 'ready', applied_revision: conference.revision })
        .where('booking_id', '=', booking.id)
        .execute()
      await trx
        .insertInto('booking_conference_notifications')
        .values({ booking_id: booking.id, kind: 'confirmed', due_at: NOW.toString() })
        .execute()
    })
    await dispatchConferenceNotifications(deps())
    await runBookingJob(booking.id, 'confirmed', 2)
    await run()
    expect(capture.sent.map(({ to }) => to).sort()).toEqual([...ordinary, other.email].sort())
    for (const email of [booker.email, guest.email]) expect(messageTo(email).ics).toContain(JOIN)
    // The automatic destination already has the organizer's calendar event.
    const host = messageTo(f.owner.email)
    expect(host.ics).toBeUndefined()
    expect(host.decoded).toContain(JOIN)
  })

  it('follows reschedule and cancellation without giving non-attendees calendar or manage authority', async () => {
    const f = await setup()
    const booker = await f.addVoter()
    const guest = await f.addVoter()
    const other = await f.addVoter()
    const input = await f.input([booker, guest])
    const { booking: original } = await finalizeMeetingPoll(f.ctx, input)
    const run = createMeetingPollEmailWorker(pollDeps(f))
    await runBookingJob(original.id, 'confirmed')
    await run()
    expect(messageTo(other.email).decoded).toContain('November 11, 2040')
    capture.sent.length = 0

    const moved = await rescheduleHostBooking(f.ctx, original.id, {
      start: Temporal.Instant.from(f.alternative.startAt),
    })
    expect(moved.booking.rescheduledFromId).toBe(original.id)
    const ordinary = [booker.email, guest.email, f.owner.email]
    const assertLifecycle = (method: 'REQUEST' | 'CANCEL', sequence: number, text: string) => {
      expect(capture.sent.map(({ to }) => to).sort()).toEqual([...ordinary, other.email].sort())
      const notice = messageTo(other.email)
      expect(notice.decoded).toContain(text)
      expect(notice.decoded).toContain('November 12, 2040')
      expect(notice.decoded).not.toContain('November 11, 2040')
      expectPrivate(notice, moved.booking.id, ordinary)
      expect(notice.decoded).not.toContain(original.id)
      for (const email of ordinary) {
        const { ics } = messageTo(email)
        expect(ics).toContain(`METHOD:${method}`)
        expect(ics).toContain(`UID:${original.id}@hourmere`)
        expect(ics).toContain(`SEQUENCE:${sequence}`)
        expect(ics).toContain('DTSTART:20401112T200000Z')
      }
    }
    await runBookingJob(moved.booking.id, 'rescheduled')
    await run()
    await run()
    assertLifecycle('REQUEST', 1, 'Meeting rescheduled: Research review')
    capture.sent.length = 0

    await cancelHostBooking(f.ctx, moved.booking.id)
    await runBookingJob(moved.booking.id, 'cancelled')
    await run()
    const replay = await finalizeMeetingPoll(f.ctx, input)
    expect(replay).toMatchObject({
      replayed: true,
      booking: { id: moved.booking.id, status: 'cancelled', source: 'web' },
    })
    expect(/manageToken|manageUrl/i.test(JSON.stringify(replay))).toBe(false)
    await run()
    assertLifecycle('CANCEL', 2, 'Meeting cancelled: Research review')
  })

  it('sends only the latest outcome when a move and cancellation overtake the selected notice', async () => {
    const f = await setup()
    const booker = await f.addVoter()
    const other = await f.addVoter()
    const { id: apiKeyId } = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: f.owner.id,
        key: createHash('sha256').update(randomUUID()).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope: 'full', organizationId: f.organizationId }),
        enabled: true,
        rateLimitEnabled: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const ctx = {
      ...f.ctx,
      principal: {
        kind: 'api_key' as const,
        apiKeyId,
        apiKeyScope: 'full' as const,
        user: f.ctx.principal.user,
        organization: f.ctx.principal.organization,
      },
    }
    const input = await f.input([booker])
    const result = await finalizeMeetingPoll(ctx, input, { source: 'mcp' })
    expect(result).toMatchObject({ booking: { source: 'mcp' } })
    expect(/manageToken|manageUrl/i.test(JSON.stringify(result))).toBe(false)
    expect(
      await db
        .selectFrom('bookings')
        .select(['source', 'api_key_id'])
        .where('id', '=', result.booking.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ source: 'mcp', api_key_id: apiKeyId })
    const moved = await rescheduleHostBooking(f.ctx, result.booking.id, {
      start: Temporal.Instant.from(f.alternative.startAt),
    })
    await cancelHostBooking(f.ctx, moved.booking.id)

    const run = createMeetingPollEmailWorker(pollDeps(f))
    await run()
    await run()
    const message = messageTo(other.email)
    expect(capture.sent).toHaveLength(1)
    expect(message.decoded).toContain('Meeting cancelled: Research review')
    expect(message.decoded).toContain('November 12, 2040')
    expect(message.decoded).not.toContain('November 11, 2040')
    expectPrivate(message, moved.booking.id, [booker.email, f.owner.email])
    expect(message.decoded).not.toContain(result.booking.id)
  })
})
