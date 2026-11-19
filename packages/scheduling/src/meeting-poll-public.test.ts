import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { submitMeetingPollBallot, withdrawMeetingPollVoter } from './meeting-poll-ballots.ts'
import { readMeetingPoll } from './meeting-poll-public.ts'
import {
  enrollMeetingPollVoter,
  inviteMeetingPollVoters,
  meetingPollCapabilityDigest,
  openMeetingPollCredential,
  verifyMeetingPollVoter,
} from './meeting-poll-voters.ts'
import { closeMeetingPoll, createMeetingPoll, rotateMeetingPollLink } from './meeting-polls.ts'
import { createFixtures, createTestTeam, createTestUser, testContext, weekdays } from './testing.ts'

const SECRET = 'poll-public-tests-stable-installation-secret'
const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('public poll capability projection', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_public' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const publicContext = () => ({ db, meetingPollSecret: SECRET, trustedIp: '192.0.2.9' })

  async function fixture(
    visibility: 'private' | 'aggregate' = 'private',
    admissionMode: 'public_link' | 'invited' = 'public_link',
  ) {
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db, 'Private host')
    const team = await createTestTeam(db, [{ user: owner, role: 'admin' }])
    await fixtures.schedule(owner.id, {
      timeZone: 'UTC',
      weeklyHours: {
        ...weekdays({ start: '00:00', end: '24:00' }),
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      },
    })
    const eventTypeId = await fixtures.eventType(team.id, null, {
      hosts: [{ userId: owner.id }],
      questions: [{ id: 'answer', type: 'short_text', label: 'Private answer', required: false }],
    })
    const ctx = {
      ...testContext(db, { ...team.as(owner), kind: 'session' as const, sessionId: randomUUID() }),
      meetingPollSecret: SECRET,
    }
    const deadline = Temporal.Now.instant()
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    const created = await createMeetingPoll(ctx, {
      eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 25 }).toString(),
        deadline.add({ hours: 26 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'UTC',
      admissionMode,
      visibility,
      idempotencyKey: randomUUID(),
    })
    return { ...created, ctx, owner, eventTypeId, organizationId: team.id }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function mailed(p: Fixture, email: string) {
    const row = await db
      .selectFrom('meeting_poll_capabilities as c')
      .innerJoin('meeting_poll_voters as v', 'v.id', 'c.voter_id')
      .select(['c.capability_ciphertext', 'c.generation', 'v.id'])
      .where('c.poll_id', '=', p.poll.id)
      .where('v.email', '=', email)
      .where('c.capability_ciphertext', 'is not', null)
      .orderBy('c.generation', 'desc')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      SECRET,
      {
        organizationId: p.organizationId,
        pollId: p.poll.id,
        voterId: row.id,
        generation: row.generation,
      },
      row.capability_ciphertext as Buffer,
    )
    if (!credential) throw new Error('Missing fixture credential')
    return { token: credential.token, voterId: row.id }
  }
  async function invite(p: Fixture, email: string) {
    await inviteMeetingPollVoters(p.ctx, {
      id: p.poll.id,
      invitees: [{ name: email.split('@')[0] as string, email }],
      idempotencyKey: randomUUID(),
    })
    return mailed(p, email)
  }
  const read = (token: string) => readMeetingPoll(publicContext(), { token })
  async function vote(p: Fixture, token: string, value: 'yes' | 'no' | 'if_need_be' = 'yes') {
    return submitMeetingPollBallot(publicContext(), {
      token,
      expectedBallotRevision: 0,
      consent: true,
      votes: p.poll.candidates.map((slot) => ({ slotId: slot.id, value })),
      responses: { answer: 'private answer text' },
    })
  }

  it('reads without a login and never verifies or exposes a roster, settings IDs or private answers', async () => {
    const p = await fixture()
    const invited = await invite(p, 'private-person@example.com')
    await vote(p, invited.token)
    const result = await read(p.publicToken as string)
    expect(result).toMatchObject({
      id: p.poll.id,
      visibility: 'private',
      ownBallot: null,
      counts: null,
      readOnly: false,
      candidates: p.poll.candidates,
    })
    expect(Object.keys(result).sort()).toEqual(
      [
        'admissionMode',
        'allowGuests',
        'candidates',
        'chosenSlotId',
        'counts',
        'deadlineAt',
        'displayTimeZone',
        'durationMinutes',
        'id',
        'locations',
        'ownBallot',
        'questions',
        'readOnly',
        'status',
        'title',
        'visibility',
      ].sort(),
    )
    expect(JSON.stringify(result)).not.toContain('private-person')
    expect(JSON.stringify(result)).not.toContain('private answer text')
    expect(JSON.stringify(result)).not.toContain(p.owner.id)
    const own = await read(invited.token)
    expect(own.ownBallot).toMatchObject({
      voter: { voterId: invited.voterId },
      ballotRevision: 1,
      responses: { answer: 'private answer text' },
    })
    expect(own.counts).toBeNull()
  })

  async function assertUnverifiedHasNoCounts(reader: typeof readMeetingPoll) {
    const p = await fixture('aggregate')
    const a = await invite(p, 'first@example.com')
    const b = await invite(p, 'second@example.com')
    await vote(p, a.token)
    const result = await reader(publicContext(), { token: b.token })
    expect(result.counts).toBeNull()
    expect(result.ownBallot?.voter.status).toBe('invited')
    return { p, a, b }
  }
  it('shares only counts with verified voters after aggregate opt-in', async () => {
    const { p, a, b } = await assertUnverifiedHasNoCounts(readMeetingPoll)
    expect((await read(p.publicToken as string)).counts).toBeNull()
    await verifyMeetingPollVoter(publicContext(), { token: b.token })
    expect((await read(b.token)).counts).toEqual(
      p.poll.candidates.map((slot) => ({ slotId: slot.id, yes: 1, ifNeedBe: 0, no: 0 })),
    )
    await vote(p, b.token, 'if_need_be')
    expect((await read(a.token)).counts?.[0]).toMatchObject({ yes: 1, ifNeedBe: 1, no: 0 })
    await withdrawMeetingPollVoter(publicContext(), { token: a.token, expectedBallotRevision: 1 })
    expect((await read(b.token)).counts?.[0]).toMatchObject({ yes: 0, ifNeedBe: 1, no: 0 })
  })

  async function assertWithdrawnHasNoCounts(reader: typeof readMeetingPoll) {
    const p = await fixture('aggregate')
    const a = await invite(p, 'stays@example.com')
    const b = await invite(p, 'leaves@example.com')
    for (const voter of [a, b]) await verifyMeetingPollVoter(publicContext(), voter)
    await vote(p, a.token)
    await vote(p, b.token, 'no')
    expect((await reader(publicContext(), { token: b.token })).counts?.[0]).toMatchObject({
      yes: 1,
      no: 1,
    })
    await withdrawMeetingPollVoter(publicContext(), { token: b.token, expectedBallotRevision: 1 })
    const withdrawn = await reader(publicContext(), { token: b.token })
    expect(withdrawn.ownBallot?.voter.status).toBe('withdrawn')
    expect(withdrawn.counts).toBeNull()
    return { p, a, b, withdrawn }
  }
  it('withholds aggregate counts from a withdrawn voter in the same shape as other non-voters', async () => {
    const { p, a, withdrawn } = await assertWithdrawnHasNoCounts(readMeetingPoll)
    expect(Object.keys(withdrawn).sort()).toEqual(
      Object.keys(await read(p.publicToken as string)).sort(),
    )
    expect((await read(a.token)).counts?.[0]).toMatchObject({ yes: 1, ifNeedBe: 0, no: 0 })
  })

  it('withholds counts from a verified voter when the poll is not aggregate', async () => {
    const p = await fixture('private')
    const a = await invite(p, 'private-voter@example.com')
    await verifyMeetingPollVoter(publicContext(), a)
    await vote(p, a.token)
    const result = await read(a.token)
    expect(result.ownBallot?.voter.status).toBe('verified')
    expect(result.counts).toBeNull()
  })

  it('accepts pending verification only before consumption and expiry, and rejects opt-out and arbitrary tokens', async () => {
    const p = await fixture('aggregate')
    await enrollMeetingPollVoter(publicContext(), {
      publicToken: p.publicToken as string,
      name: 'Pending',
      email: 'pending@example.com',
      timeZone: 'UTC',
    })
    const pending = await mailed(p, 'pending@example.com')
    expect(await read(pending.token)).toMatchObject({ counts: null, ownBallot: null })
    const before = await db
      .selectFrom('meeting_poll_voters')
      .select('verified_at')
      .where('id', '=', pending.voterId)
      .executeTakeFirstOrThrow()
    expect(before.verified_at).toBeNull()
    const verified = await verifyMeetingPollVoter(publicContext(), { token: pending.token })
    await expect(read(pending.token)).rejects.toMatchObject({ code: 'poll_not_found' })
    expect((await read(verified.votingToken as string)).ownBallot?.voter.status).toBe('verified')
    const optOut = randomBytes(32).toString('base64url')
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: p.organizationId,
        poll_id: p.poll.id,
        voter_id: pending.voterId,
        purpose: 'reminder_opt_out',
        generation: 3,
        token_digest: meetingPollCapabilityDigest('reminder_opt_out', optOut),
        expires_at: p.poll.deadlineAt,
      })
      .execute()
    for (const token of [optOut, randomBytes(32).toString('base64url'), p.poll.id]) {
      await expect(read(token)).rejects.toMatchObject({ code: 'poll_not_found' })
    }
    await enrollMeetingPollVoter(publicContext(), {
      publicToken: p.publicToken as string,
      name: 'Expired',
      email: 'expired@example.com',
      timeZone: 'UTC',
    })
    const expired = await mailed(p, 'expired@example.com')
    await sql`UPDATE meeting_poll_capabilities SET created_at = clock_timestamp() - interval '1 minute', expires_at = clock_timestamp() - interval '1 second' WHERE voter_id = ${expired.voterId}`.execute(
      db,
    )
    await expect(read(expired.token)).rejects.toMatchObject({ code: 'poll_not_found' })
  })

  it('retains own ballot reads after expiry and closure but rejects revoked, rotated and removed credentials', async () => {
    const p = await fixture()
    const a = await invite(p, 'closed@example.com')
    await vote(p, a.token)
    await closeMeetingPoll(p.ctx, {
      id: p.poll.id,
      expectedHostRevision: (
        await db
          .selectFrom('meeting_polls')
          .select('host_revision')
          .where('id', '=', p.poll.id)
          .executeTakeFirstOrThrow()
      ).host_revision,
    })
    expect(await read(a.token)).toMatchObject({
      status: 'closed',
      readOnly: true,
      ownBallot: { ballotRevision: 1 },
    })
    await sql`UPDATE meeting_poll_capabilities SET revoked_at = clock_timestamp(), capability_ciphertext = NULL WHERE voter_id = ${a.voterId}`.execute(
      db,
    )
    await expect(read(a.token)).rejects.toMatchObject({ code: 'poll_not_found' })
    const q = await fixture()
    await rotateMeetingPollLink(q.ctx, {
      id: q.poll.id,
      expectedHostRevision: q.poll.hostRevision,
      idempotencyKey: randomUUID(),
    })
    await expect(read(q.publicToken as string)).rejects.toMatchObject({ code: 'poll_not_found' })
    const b = await invite(q, 'removed@example.com')
    await db.deleteFrom('meeting_poll_voters').where('id', '=', b.voterId).execute()
    await expect(read(b.token)).rejects.toMatchObject({ code: 'poll_not_found' })
  })

  it('derives deadline closure without a worker and omits booking identifiers and conference URLs', async () => {
    const p = await fixture()
    const a = await invite(p, 'deadline@example.com')
    await vote(p, a.token)
    await sql`UPDATE meeting_polls SET created_at = clock_timestamp() - interval '3 hours', deadline_at = clock_timestamp() - interval '1 hour' WHERE id = ${p.poll.id}`.execute(
      db,
    )
    await sql`UPDATE meeting_poll_capabilities SET created_at = clock_timestamp() - interval '2 hours', expires_at = (SELECT deadline_at FROM meeting_polls WHERE id = ${p.poll.id}) WHERE voter_id = ${a.voterId}`.execute(
      db,
    )
    expect(await read(a.token)).toMatchObject({
      status: 'closed',
      readOnly: true,
      ownBallot: { ballotRevision: 1 },
    })
    const result = await read(p.publicToken as string)
    expect(result).not.toHaveProperty('bookingId')
    expect(result).not.toHaveProperty('settingsSnapshot')
  })

  it('refuses reads with a mismatched installation key, including unknown credentials', async () => {
    const p = await fixture('private', 'invited')
    const a = await invite(p, 'key@example.com')
    for (const token of [a.token, randomBytes(32).toString('base64url')]) {
      await expect(
        readMeetingPoll({ ...publicContext(), meetingPollSecret: 'different-secret' }, { token }),
      ).rejects.toMatchObject({ code: 'meeting_poll_key_mismatch' })
    }
  })

  async function mutatedReader(marker: string, replacement: string) {
    const location = new URL('./meeting-poll-public.ts', import.meta.url)
    const original = readFileSync(location, 'utf8')
    expect(original.split(marker)).toHaveLength(2)
    const source = stripTypeScriptTypes(original.replace(marker, replacement)).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
    )
    const mutated = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )
    return mutated.readMeetingPoll as typeof readMeetingPoll
  }
  it('detects a source-copy mutation that exposes aggregates before verification', async () => {
    const reader = await mutatedReader('voter?.verified &&', '')
    await expect(assertUnverifiedHasNoCounts(reader)).rejects.toThrow(/null/)
  })
  it('detects a source-copy mutation that exposes aggregates after withdrawal', async () => {
    const reader = await mutatedReader('&&\n        voter.active', '')
    await expect(assertWithdrawnHasNoCounts(reader)).rejects.toThrow(/null/)
  })
})
