import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import {
  openMeetingPollCredential,
  queueDueMeetingPollReminders,
} from '@hourmere/scheduling/meeting-poll-delivery'
import { createFixtures, createTestUser, testContext, weekdays } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  optOutOfMeetingPollReminders,
  submitMeetingPollBallot,
  withdrawMeetingPollVoter,
} from '../../scheduling/src/meeting-poll-ballots.ts'
import { MEETING_POLL_LIMITS } from '../../scheduling/src/meeting-poll-policy.ts'
import { removeMeetingPollVoter } from '../../scheduling/src/meeting-poll-results.ts'
import {
  admissionCounts,
  enrollMeetingPollVoter,
  inviteMeetingPollVoters,
  verifyMeetingPollVoter,
} from '../../scheduling/src/meeting-poll-voters.ts'
import { createMeetingPoll } from '../../scheduling/src/meeting-polls.ts'
import {
  createMeetingPollEmailWorker,
  deliverMeetingPollEmail,
  type MeetingPollEmailDeps,
} from './meeting-polls.ts'

const serverUrl = process.env.DATABASE_URL
const secret = 'meeting-poll-reminders-test-fixture-123456789'
const email = () => `${randomUUID()}@example.test`

describe.skipIf(!serverUrl)('meeting poll deadline reminder mail', () => {
  let owned: TestDatabase
  let db: Db
  let fixturePolls: string[]

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_reminders' })
    db = createDb(owned.pool)
    fixturePolls = []
  })
  afterEach(async () => {
    if (!fixturePolls?.length) return
    await db.deleteFrom('meeting_polls').where('id', 'in', fixturePolls).execute()
    fixturePolls.length = 0
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(deadlineHours = 14 * 24) {
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `poll-${randomUUID().slice(0, 8)}`, time_zone: 'UTC' })
      .execute()
    const ctx = {
      ...testContext(db, {
        kind: 'session',
        sessionId: randomUUID(),
        user: owner.principal.user,
        organization: owner.principal.organization,
      }),
      meetingPollSecret: secret,
    }
    const allDay = [{ start: '00:00', end: '24:00' }]
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: { ...weekdays(...allDay), saturday: allDay, sunday: allDay },
    })
    const eventTypeId = await fixtures.eventType(ctx.principal.organization.id, owner.id, {
      bookingWindowDays: 30,
    })
    const { at } = await db
      .selectNoFrom(sql<Date>`clock_timestamp()`.as('at'))
      .executeTakeFirstOrThrow()
    let now = Temporal.Instant.fromEpochMilliseconds(at.getTime()).add({ seconds: 10 })
    const deadline = now.round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({
      hours: deadlineHours,
    })
    const { poll, publicToken } = await createMeetingPoll(ctx, {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 1 }).toString(),
        deadline.add({ hours: 2 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      idempotencyKey: randomUUID(),
    })
    fixturePolls.push(poll.id)
    const pub = { db, meetingPollSecret: secret, trustedIp: '192.0.2.10' }
    const messages: MailMessage[] = []
    const deps: MeetingPollEmailDeps = {
      db,
      meetingPollSecret: secret,
      secret,
      publicUrl: 'https://poll.example.test',
      smtpConfigured: true,
      now: () => now,
      mailMaxPerHour: 0,
      mailer: { send: async (message) => void messages.push(message) },
    }
    const queue = () => queueDueMeetingPollReminders(db, secret, { now: deps.now })
    const run = createMeetingPollEmailWorker(deps)
    const reminders = () =>
      db
        .selectFrom('meeting_poll_deliveries')
        .selectAll()
        .where('poll_id', '=', poll.id)
        .where('kind', '=', 'reminder')
        .execute()
    const invite = (...addresses: string[]) =>
      inviteMeetingPollVoters(ctx, {
        id: poll.id,
        invitees: addresses.map((address) => ({ email: address, name: 'Invitee' })),
        idempotencyKey: randomUUID(),
      })
    const credential = async (address: string) => {
      const voter = await db
        .selectFrom('meeting_poll_voters')
        .selectAll()
        .where('poll_id', '=', poll.id)
        .where('email', '=', address)
        .executeTakeFirstOrThrow()
      const cap = await db
        .selectFrom('meeting_poll_capabilities')
        .selectAll()
        .where('voter_id', '=', voter.id)
        .where('capability_ciphertext', 'is not', null)
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .executeTakeFirstOrThrow()
      const opened = openMeetingPollCredential(
        secret,
        {
          organizationId: voter.organization_id,
          pollId: poll.id,
          voterId: voter.id,
          generation: cap.generation,
        },
        cap.capability_ciphertext,
      )
      if (!opened) throw new Error('Missing test credential')
      return { voter, token: opened.token }
    }
    const remove = async (voterId: string) => {
      const { host_revision } = await db
        .selectFrom('meeting_polls')
        .select('host_revision')
        .where('id', '=', poll.id)
        .executeTakeFirstOrThrow()
      await removeMeetingPollVoter(ctx, {
        id: poll.id,
        voterId,
        expectedHostRevision: host_revision,
      })
    }
    return {
      poll,
      pub,
      deps,
      messages,
      deadline,
      due: deadline.subtract({ seconds: MEETING_POLL_LIMITS.reminderLeadSeconds }),
      setNow: (at: Temporal.Instant) => {
        now = at
      },
      invite,
      remove,
      credential,
      reminders,
      queue,
      run,
      enroll: (address: string) =>
        enrollMeetingPollVoter(pub, {
          publicToken: publicToken as string,
          name: 'Public voter',
          email: address,
          timeZone: 'UTC',
        }),
    }
  }

  it('schedules exactly at the lead time and delivers a valid invitee credential after one hour at full capacity', async () => {
    const s = await setup()
    const optedOut = email()
    const unverified = email()
    const verified = email()
    const pending = email()
    const others = Array.from({ length: 36 }, email)
    await s.enroll(pending)
    await s.enroll(verified)
    const verification = await s.credential(verified)
    await verifyMeetingPollVoter(s.pub, { token: verification.token })
    await s.invite(unverified, optedOut, ...others)
    const invitee = await s.credential(unverified)
    expect(invitee.voter.verified_at).toBeNull()
    await expect(s.enroll(email())).rejects.toMatchObject({ code: 'poll_full' })
    await s.run()
    const preferenceToken = s.messages
      .find((message) => message.to === optedOut)
      ?.text.match(/\/poll\/reminder-opt-out#([A-Za-z0-9_-]{43})/)?.[1]
    if (!preferenceToken) throw new Error('Missing test preference credential')
    await optOutOfMeetingPollReminders(s.pub, { token: preferenceToken })
    s.messages.length = 0

    s.setNow(s.due.subtract({ milliseconds: 1 }))
    await s.run()
    expect(await s.reminders()).toHaveLength(0)
    expect(s.messages).toHaveLength(0)

    expect(s.due.epochMilliseconds - (invitee.voter.invited_at?.getTime() ?? 0)).toBeGreaterThan(
      60 * 60 * 1000,
    )
    // Keep the pending public reservation live at the simulated reminder instant.
    await db
      .updateTable('meeting_poll_voters')
      .set({
        created_at: s.due.subtract({ minutes: 30 }).toString(),
        pending_expires_at: s.due.add({ minutes: 30 }).toString(),
      })
      .where('poll_id', '=', s.poll.id)
      .where('email', '=', pending)
      .execute()
    expect((await admissionCounts(db, s.poll.id, s.due.toString())).active).toBe(40)
    s.setNow(s.due)
    await s.run()
    expect(s.messages.map((message) => message.to).sort()).toEqual(
      [unverified, verified, ...others].sort(),
    )
    expect(
      s.messages
        .find((message) => message.to === unverified)
        ?.text.includes(`/poll/voter#${invitee.token}`),
    ).toBe(true)
    const rows = await s.reminders()
    expect(rows).toHaveLength(38)
    expect(
      rows.every(
        (row) =>
          row.due_at.getTime() === s.due.epochMilliseconds &&
          row.state === 'sent' &&
          row.capability_ciphertext === null,
      ),
    ).toBe(true)
    await s.run()
    expect(s.messages).toHaveLength(38)
  })

  it('rechecks ballots, withdrawals, removals and opt-outs after queueing', async () => {
    const s = await setup()
    const addresses = Array.from({ length: 4 }, email)
    await s.invite(...addresses)
    await s.run()
    const [voted, withdrawn, removed, optedOut] = await Promise.all(addresses.map(s.credential))
    if (!voted || !withdrawn || !removed || !optedOut) throw new Error('Missing test recipients')
    const preferenceToken = s.messages
      .find((message) => message.to === optedOut.voter.email)
      ?.text.match(/\/poll\/reminder-opt-out#([A-Za-z0-9_-]{43})/)?.[1]
    if (!preferenceToken) throw new Error('Missing test preference credential')
    s.messages.length = 0
    s.setNow(s.due)
    await s.queue()
    const queued = await s.reminders()
    expect(queued).toHaveLength(4)
    await submitMeetingPollBallot(s.pub, {
      token: voted.token,
      consent: true,
      votes: s.poll.candidates.map(({ id }) => ({ slotId: id, value: 'yes' as const })),
      expectedBallotRevision: 0,
    })
    await withdrawMeetingPollVoter(s.pub, { token: withdrawn.token, expectedBallotRevision: 0 })
    await s.remove(removed.voter.id)
    await optOutOfMeetingPollReminders(s.pub, { token: preferenceToken })
    for (const row of queued) await deliverMeetingPollEmail(s.deps, row)
    expect(s.messages).toHaveLength(0)
    expect((await s.reminders()).map((row) => row.state)).toEqual(['skipped', 'skipped', 'skipped'])
  })

  it('skips polls created with a short lead and never catches up at or after the deadline', async () => {
    const short = await setup(22)
    await short.invite(email())
    short.setNow(short.deadline.subtract({ milliseconds: 1 }))
    await short.queue()
    expect(await short.reminders()).toHaveLength(0)

    const late = await setup()
    await late.invite(email())
    late.setNow(late.deadline)
    await late.queue()
    expect(await late.reminders()).toHaveLength(0)

    const delayed = await setup()
    await delayed.invite(email())
    delayed.setNow(delayed.due)
    await delayed.queue()
    const [row] = await delayed.reminders()
    if (!row) throw new Error('Missing queued reminder')
    delayed.setNow(delayed.deadline)
    await deliverMeetingPollEmail(delayed.deps, row)
    expect(delayed.messages).toHaveLength(0)
    expect((await delayed.reminders())[0]).toMatchObject({
      state: 'skipped',
      capability_ciphertext: null,
    })
  })

  it.each(['sent', 'suppressed'] as const)(
    'keeps a durable %s mailbox receipt through removal and re-invitation',
    async (state) => {
      const s = await setup()
      const address = email()
      await s.invite(address)
      const { voter } = await s.credential(address)
      s.setNow(s.due)
      await s.queue()
      const [row] = await s.reminders()
      if (!row) throw new Error('Missing queued reminder')
      if (state === 'suppressed') s.deps.mailRecipientMaxPerHour = 0
      await deliverMeetingPollEmail(s.deps, row)
      expect((await s.reminders())[0]).toMatchObject({ state, capability_ciphertext: null })
      const counter = () =>
        db
          .selectFrom('meeting_poll_mailbox_counters')
          .select('reminder_consumed_at')
          .where('poll_id', '=', s.poll.id)
          .where('email_key', '=', voter.email_key)
          .executeTakeFirstOrThrow()
      const receipt = await counter()
      expect(receipt.reminder_consumed_at?.getTime()).toBe(s.due.epochMilliseconds)
      s.deps.mailRecipientMaxPerHour = 5
      await s.remove(voter.id)
      await s.invite(address)
      s.setNow(s.due.add({ hours: 2 }))
      await s.queue()
      expect(await s.reminders()).toHaveLength(0)
      expect(await counter()).toEqual(receipt)
      expect(s.messages).toHaveLength(state === 'sent' ? 1 : 0)
    },
  )

  it('refuses a mismatched key before queueing any reminder', async () => {
    const s = await setup()
    await s.invite(email())
    s.setNow(s.due)
    await expect(
      queueDueMeetingPollReminders(db, 'different-test-key-for-reminder-fixtures', {
        now: s.deps.now,
      }),
    ).rejects.toMatchObject({ code: 'meeting_poll_key_mismatch' })
    expect(await s.reminders()).toHaveLength(0)
    await s.queue()
    expect(await s.reminders()).toHaveLength(1)
  })
})
