// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-copy mutations target literal template strings
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Ballots from './meeting-poll-ballots.ts'
import * as Voters from './meeting-poll-voters.ts'
import * as Polls from './meeting-polls.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const SECRET = 'meeting-poll-voter-test-secret-0123456789'
const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

/** The voter and ballot services under test: the real modules or mutated source copies. */
interface Modules {
  V: typeof Voters
  B: typeof Ballots
}
type Replacement = readonly [string, string]
interface Mutation {
  voters?: readonly Replacement[]
  ballots?: readonly Replacement[]
}

/** A data-URL copy of one module, with each replacement applied exactly once. */
function copy(file: string, replacements: readonly Replacement[], local: Record<string, string>) {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.split(from).length - 1, `mutation must match ${file} once: ${from}`).toBe(1)
    source = source.replace(from, to)
  }
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${local[specifier] ?? (specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href)}'`,
  )
  return `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`
}

/**
 * Imports isolated copies of the voter and ballot services; the ballot copy imports the
 * voter copy, so a mutation in a shared lock or helper reaches both. The production files
 * are never overwritten.
 */
async function sourceCopy(mutation: Mutation = {}): Promise<Modules> {
  const voters = copy('./meeting-poll-voters.ts', mutation.voters ?? [], {})
  const ballots = copy('./meeting-poll-ballots.ts', mutation.ballots ?? [], {
    './meeting-poll-voters.ts': voters,
  })
  return { V: await import(voters), B: await import(ballots) }
}

/** Source copies load their own error classes, so compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) expect.unreachable('expected the operation to fail')
  const known = error as Error & { kind?: string; code?: string; retryAfterSeconds?: number }
  return {
    name: error.name,
    kind: known.kind,
    code: known.code,
    message: error.message,
    retryAfterSeconds: known.retryAfterSeconds,
  }
}

/** Expected success, reported as an assertion so that a throwing mutant is not a crash. */
async function succeeds<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const { name, code, message } = error as { name?: string; code?: string; message?: string }
    return expect.unreachable(`expected success, got ${name} ${code} ${message}`)
  }
}

function session(principal: Principal): Principal {
  return {
    kind: 'session',
    sessionId: randomUUID(),
    user: principal.user,
    organization: principal.organization,
  }
}

const iso = (value: string | null) =>
  value === null ? null : Temporal.Instant.from(value).toString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!serverUrl)('meeting poll ballots, withdrawal and reminder opt-out', () => {
  let owned: TestDatabase
  let db: Db
  /** Same database; its sessions resolve clock_timestamp() to a settable test clock. */
  let frozen: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_ballots' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
    await sql`CREATE SCHEMA poll_test_clock`.execute(db)
    await sql`CREATE TABLE poll_test_clock.frozen (at timestamptz)`.execute(db)
    await sql`INSERT INTO poll_test_clock.frozen VALUES (NULL)`.execute(db)
    await sql`CREATE FUNCTION poll_test_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$
        SELECT coalesce((SELECT at FROM poll_test_clock.frozen), pg_catalog.clock_timestamp())
      $$`.execute(db)
    // Listing pg_catalog after the test schema lets its clock_timestamp() win, for these
    // sessions only. Database triggers pin their own search_path and keep the real clock.
    const url = new URL(owned.url)
    url.searchParams.set('options', '-c search_path=poll_test_clock,pg_catalog,public')
    frozen = createDb(createPool(url.toString()))
  })
  afterAll(async () => {
    await frozen?.destroy()
    await owned?.drop()
  })

  // --- Fixtures ---------------------------------------------------------------------------

  async function databaseNow(on: Db = db) {
    const { rows } = await sql<{
      now: string
    }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${sql.lit(FORMAT)}) AS now`.execute(on)
    return Temporal.Instant.from(rows[0]?.now as string)
  }

  const ALWAYS = {
    timeZone: 'UTC',
    weeklyHours: {
      ...weekdays({ start: '00:00', end: '24:00' }),
      saturday: [{ start: '00:00', end: '24:00' }],
      sunday: [{ start: '00:00', end: '24:00' }],
    },
  }

  type PollSpace = Awaited<ReturnType<typeof open>>

  /** A team whose admin manages an event hosted by an ordinary member who is always free. */
  async function space(questions?: unknown[]) {
    const admin = await createTestUser(db, 'Team Admin')
    const member = await createTestUser(db, 'Configured Host')
    for (const user of [admin, member]) await fixtures.schedule(user.id, ALWAYS)
    const t = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(t.id, null, {
      hosts: [{ userId: member.id }],
      ...(questions && { questions }),
    })
    const as = (user: TestUser): Voters.MeetingPollHostContext => ({
      ...testContext(db, session(t.as(user))),
      meetingPollSecret: SECRET,
    })
    return { organizationId: t.id, eventTypeId, ctx: as(admin) }
  }

  /** An open poll with two candidates, about a day before its deadline. */
  async function open(
    admissionMode: 'public_link' | 'invited' = 'public_link',
    questions?: unknown[],
  ) {
    const s = await space(questions)
    const deadline = (await databaseNow())
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    const created = await Polls.createMeetingPoll(s.ctx, {
      eventTypeId: s.eventTypeId,
      candidateStarts: [
        deadline.add({ hours: 25 }).toString(),
        deadline.add({ hours: 26 }).toString(),
      ],
      deadlineAt: deadline.toString(),
      displayTimeZone: 'Europe/Berlin',
      admissionMode,
      idempotencyKey: randomUUID(),
    })
    const slots = await db
      .selectFrom('meeting_poll_slots')
      .select('id')
      .where('poll_id', '=', created.poll.id)
      .orderBy('position')
      .execute()
    return {
      ...s,
      pollId: created.poll.id,
      link: created.publicToken as string,
      slotIds: slots.map((slot) => slot.id),
    }
  }

  const pub = (ip = '192.0.2.10', on: Db = db): Voters.MeetingPollPublicContext => ({
    db: on,
    meetingPollSecret: SECRET,
    trustedIp: ip,
  })

  function enroll(M: Modules, p: PollSpace, email: string, ip = '192.0.2.10') {
    return M.V.enrollMeetingPollVoter(pub(ip), {
      publicToken: p.link,
      name: 'Public Voter',
      email,
      timeZone: 'Europe/Berlin',
    })
  }

  function invite(M: Modules, p: PollSpace, emails: string[]) {
    return M.V.inviteMeetingPollVoters(p.ctx, {
      id: p.pollId,
      invitees: emails.map((email) => ({ name: 'Invited Voter', email })),
      idempotencyKey: randomUUID(),
    })
  }

  function recover(M: Modules, p: PollSpace, email: string) {
    return M.V.recoverMeetingPollVoter(pub(), { pollId: p.pollId, email })
  }

  async function resend(M: Modules, p: PollSpace, email: string) {
    const row = await voter(p, email)
    return M.V.resendMeetingPollInvitation(p.ctx, {
      id: p.pollId,
      voterId: row.id,
      expectedHostRevision: (await revisions(p)).host_revision,
      idempotencyKey: randomUUID(),
    })
  }

  /** An invitee and the voting credential its invitation carries. */
  async function invitee(M: Modules, p: PollSpace, email: string) {
    await succeeds(() => invite(M, p, [email]))
    return (await mailed(p, email)).token
  }

  /** A verified public voter: its consumed verification credential and its voting one. */
  async function publicVoter(M: Modules, p: PollSpace, email: string, ip = '192.0.2.10') {
    await succeeds(() => enroll(M, p, email, ip))
    const { token } = await mailed(p, email)
    const verified = await succeeds(() => M.V.verifyMeetingPollVoter(pub(), { token }))
    return { verification: token, voting: verified.votingToken as string }
  }

  type Value = Ballots.MeetingPollVoteValue

  /** One answer per candidate, in candidate order. */
  function votes(p: PollSpace, values: Value[]) {
    return p.slotIds.map((slotId, index) => ({ slotId, value: values[index] as Value }))
  }

  function ballot(
    M: Modules,
    p: PollSpace,
    token: string,
    values: Value[],
    expectedBallotRevision: number,
    extra: Partial<Ballots.SubmitMeetingPollBallotInput> = {},
    on: Db = db,
  ) {
    return M.B.submitMeetingPollBallot(pub(undefined, on), {
      token,
      votes: votes(p, values),
      consent: true,
      expectedBallotRevision,
      ...extra,
    })
  }

  function withdraw(M: Modules, token: string, expectedBallotRevision: number, on: Db = db) {
    return M.B.withdrawMeetingPollVoter(pub(undefined, on), { token, expectedBallotRevision })
  }

  function optOut(M: Modules, token: string, on: Db = db) {
    return M.B.optOutOfMeetingPollReminders(pub(undefined, on), { token })
  }

  /** A stored credential row, as a later mail step mints one. */
  async function capability(
    p: PollSpace,
    voterId: string,
    purpose: Voters.MeetingPollCapabilityPurpose,
    digest: Buffer,
    generation = 1,
  ) {
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: voterId,
        purpose,
        token_digest: digest,
        generation,
        expires_at: (await revisions(p)).deadline,
      })
      .execute()
  }

  /** The purpose-limited opt-out credential that later mail steps put in invitations. */
  async function optOutCredential(p: PollSpace, voterId: string) {
    const token = randomBytes(32).toString('base64url')
    await capability(
      p,
      voterId,
      'reminder_opt_out',
      Voters.meetingPollCapabilityDigest('reminder_opt_out', token),
    )
    return token
  }

  /** A queued deadline reminder, as the later reminder job writes it. */
  async function queueReminder(p: PollSpace, voterId: string) {
    await db
      .insertInto('meeting_poll_deliveries')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: voterId,
        kind: 'reminder',
        capability_ciphertext: randomBytes(64),
      })
      .execute()
  }

  const timestamp = (column: string) =>
    sql<string | null>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', ${sql.lit(FORMAT)})`

  async function voter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_voters')
      .selectAll()
      .select([
        timestamp('verified_at').as('verified'),
        timestamp('withdrawn_at').as('withdrawn'),
        timestamp('ballot_submitted_at').as('submitted'),
        timestamp('join_consent_at').as('consent'),
        timestamp('updated_at').as('updated'),
      ])
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
  }

  async function votesOf(voterId: string) {
    const rows = await db
      .selectFrom('meeting_poll_votes as vote')
      .innerJoin('meeting_poll_slots as slot', 'slot.id', 'vote.slot_id')
      .select(['vote.slot_id', 'vote.value'])
      .where('vote.voter_id', '=', voterId)
      .orderBy('slot.position')
      .execute()
    return rows.map((row) => ({ slotId: row.slot_id, value: row.value }))
  }

  async function credentials(voterId: string) {
    return db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .where('voter_id', '=', voterId)
      .orderBy('generation')
      .orderBy('id')
      .execute()
  }

  async function deliveries(p: PollSpace, voterId: string) {
    return db
      .selectFrom('meeting_poll_deliveries')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('voter_id', '=', voterId)
      .orderBy('id')
      .execute()
  }

  async function counter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_mailbox_counters')
      .selectAll()
      .select(timestamp('reminder_opted_out_at').as('optedOut'))
      .where('poll_id', '=', p.pollId)
      .where('email_key', '=', Voters.meetingPollMailboxKey(SECRET, p.pollId, email))
      .executeTakeFirstOrThrow()
  }

  async function revisions(p: PollSpace) {
    return db
      .selectFrom('meeting_polls')
      .select(['host_revision', 'results_revision', sql<string>`deadline_at::text`.as('deadline')])
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
  }

  async function deadlineOf(p: PollSpace) {
    const row = await db
      .selectFrom('meeting_polls')
      .select(timestamp('deadline_at').as('deadline'))
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
    return Temporal.Instant.from(row.deadline as string)
  }

  /** Places in use now: active verified voters, active invitations and live reservations. */
  async function places(p: PollSpace) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM meeting_poll_voters
      WHERE poll_id = ${p.pollId} AND withdrawn_at IS NULL AND (verified_at IS NOT NULL
        OR invited_at IS NOT NULL OR pending_expires_at > clock_timestamp())`.execute(db)
    return Number(rows[0]?.n)
  }

  /** A checksum of every row that belongs to the poll, so that any write is noticed. */
  async function snapshot(p: PollSpace) {
    const { rows } = await sql<{ checksum: string }>`SELECT md5(concat_ws('|',
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_polls t WHERE t.id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_voters t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_votes t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_capabilities t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_deliveries t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_mailbox_counters t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_operations t WHERE t.poll_id = ${p.pollId})
    )) AS checksum`.execute(db)
    return rows[0]?.checksum
  }

  /** A checksum of one mailbox's voter, votes, credentials, mail and counter rows. */
  async function mailbox(p: PollSpace, email: string) {
    const key = Voters.meetingPollMailboxKey(SECRET, p.pollId, email)
    const { rows } = await sql<{ checksum: string }>`WITH v AS (
        SELECT * FROM meeting_poll_voters WHERE poll_id = ${p.pollId} AND email_key = ${key})
      SELECT md5(concat_ws('|',
        (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM v t),
        (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_votes t WHERE t.voter_id IN (SELECT id FROM v)),
        (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_capabilities t WHERE t.voter_id IN (SELECT id FROM v)),
        (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_deliveries t WHERE t.voter_id IN (SELECT id FROM v)),
        (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_mailbox_counters t WHERE t.poll_id = ${p.pollId} AND t.email_key = ${key})
      )) AS checksum`.execute(db)
    return rows[0]?.checksum
  }

  /** The credential carried by a mailbox's newest queued mail. */
  async function mailed(p: PollSpace, email: string) {
    const row = await voter(p, email)
    const [delivery] = (await deliveries(p, row.id))
      .filter((entry) => entry.capability_ciphertext !== null)
      .reverse()
    if (!delivery) return expect.unreachable(`no mail queued for ${email}`)
    const credential = Voters.openMeetingPollCredential(
      SECRET,
      {
        organizationId: p.organizationId,
        pollId: p.pollId,
        voterId: row.id,
        generation: delivery.generation,
      },
      delivery.capability_ciphertext,
    )
    if (!credential) return expect.unreachable(`mail for ${email} does not open`)
    return { ...credential, voter: row }
  }

  /** What a later removal step leaves: no voter row, only the mailbox tombstone. */
  async function remove(p: PollSpace, email: string) {
    await db
      .deleteFrom('meeting_poll_voters')
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .execute()
    await sql`UPDATE meeting_poll_mailbox_counters SET removed_at = clock_timestamp()
      WHERE poll_id = ${p.pollId}
        AND email_key = ${Voters.meetingPollMailboxKey(SECRET, p.pollId, email)}`.execute(db)
  }

  async function pastDeadline(p: PollSpace) {
    await sql`WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
      UPDATE meeting_polls SET created_at = decision.t - interval '2 hours',
        deadline_at = decision.t - interval '1 hour'
      FROM decision WHERE id = ${p.pollId}`.execute(db)
  }

  /** Move the deadline to `seconds` from now; voting credentials keep expiring with it. */
  async function deadlineIn(p: PollSpace, seconds: number) {
    await sql`WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
      UPDATE meeting_polls SET created_at = decision.t - interval '2 hours',
        deadline_at = decision.t + make_interval(secs => ${seconds})
      FROM decision WHERE id = ${p.pollId}`.execute(db)
    await sql`UPDATE meeting_poll_capabilities AS c SET expires_at = poll.deadline_at
      FROM meeting_polls AS poll
      WHERE poll.id = c.poll_id AND c.poll_id = ${p.pollId} AND c.purpose = 'voting'`.execute(db)
    return deadlineOf(p)
  }

  /** Set the test clock of the `frozen` sessions to `microseconds` before the deadline. */
  async function freeze(p: PollSpace, microseconds: number) {
    await sql`UPDATE poll_test_clock.frozen SET at = (SELECT deadline_at FROM meeting_polls
      WHERE id = ${p.pollId}) - ${microseconds}::int * interval '1 microsecond'`.execute(db)
  }

  async function thaw() {
    await sql`UPDATE poll_test_clock.frozen SET at = NULL`.execute(db)
  }

  // --- Concurrency helpers ----------------------------------------------------------------

  async function lockWaiters() {
    const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(
      db,
    )
    return Number(rows[0]?.count)
  }

  async function waiters(count: number) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((await lockWaiters()) >= count) return
      await sleep(25)
    }
    throw new Error(`expected ${count} lock waiters`)
  }

  /** Hold `hold` in its own transaction until the returned release is awaited. */
  async function holding(hold: (trx: Db) => Promise<unknown>) {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = db.transaction().execute(async (trx) => {
      try {
        await hold(trx)
      } catch (error) {
        locked.reject(error)
        throw error
      }
      locked.resolve()
      await release.promise
    })
    done.catch(() => undefined)
    await locked.promise
    return async () => {
      release.resolve()
      await done
    }
  }

  const holdPoll = (p: PollSpace) =>
    holding((trx) =>
      trx.selectFrom('meeting_polls').select('id').where('id', '=', p.pollId).forUpdate().execute(),
    )

  /** Hold the poll row, queue `first` then `second` on it, then release them in that order. */
  async function queued<A, B>(p: PollSpace, first: () => Promise<A>, second: () => Promise<B>) {
    const release = await holdPoll(p)
    let a: Promise<A> | undefined
    let b: Promise<B> | undefined
    try {
      a = first()
      a.catch(() => undefined)
      await waiters(1)
      b = second()
      b.catch(() => undefined)
      await waiters(2)
    } finally {
      await release()
    }
    return Promise.allSettled([a as Promise<A>, b as Promise<B>])
  }

  /** Whether `work` queues behind a lock or settles first. */
  async function queues(work: Promise<unknown>): Promise<'queued' | 'settled'> {
    let settled = false
    work.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    for (let attempt = 0; attempt < 400; attempt++) {
      if (settled) return 'settled'
      if ((await lockWaiters()) >= 1) return 'queued'
      await sleep(25)
    }
    throw new Error('expected a lock waiter or a settled operation')
  }

  const outcome = (result: PromiseSettledResult<unknown>) =>
    result.status === 'rejected'
      ? { code: (result.reason as { code?: string }).code }
      : ('fulfilled' as const)

  // --- Checks shared by the real modules and their mutated source copies ------------------

  /**
   * Each accepted ballot, replacement, withdrawal and reactivation advances the voter's ballot
   * revision and the poll's results revision by one; a stale form changes nothing. No voter
   * write, opt-out or repeat moves the host revision.
   */
  async function verifyRevisions(M: Modules) {
    const p = await open()
    const invited = await invitee(M, p, 'invitee@example.com')
    const voting = await publicVoter(M, p, 'public@example.com')
    const start = await revisions(p)
    const host = start.host_revision
    let results = start.results_revision
    const settled = async () =>
      expect(await revisions(p)).toMatchObject({ host_revision: host, results_revision: results })

    // An invitee's first ballot also confirms the mailbox, and may edit the profile.
    const first = await succeeds(() =>
      ballot(M, p, invited, ['yes', 'if_need_be'], 0, {
        name: ' Renamed ',
        timeZone: 'Asia/Tokyo',
        locale: 'de',
      }),
    )
    results += 1
    await settled()
    expect(first).toMatchObject({
      ballotRevision: 1,
      voter: {
        pollId: p.pollId,
        status: 'verified',
        name: 'Renamed',
        email: 'invitee@example.com',
        timeZone: 'Asia/Tokyo',
        locale: 'de',
      },
      votes: votes(p, ['yes', 'if_need_be']),
      responses: {},
    })
    const row = await voter(p, 'invitee@example.com')
    expect(row).toMatchObject({ ballot_revision: 1, withdrawn_at: null })
    expect(iso(row.verified)).toBe(first.submittedAt)
    expect(await votesOf(row.id)).toEqual(votes(p, ['yes', 'if_need_be']))

    // A replacement swaps the whole ballot under the next revision.
    const second = await succeeds(() => ballot(M, p, invited, ['no', 'yes'], 1))
    results += 1
    await settled()
    expect(second).toMatchObject({
      ballotRevision: 2,
      voter: { name: 'Renamed' },
      votes: votes(p, ['no', 'yes']),
    })
    expect(await votesOf(row.id)).toEqual(votes(p, ['no', 'yes']))
    expect(iso((await voter(p, 'invitee@example.com')).verified)).toBe(first.submittedAt)

    // Stale forms never overwrite a newer decision.
    const current = await snapshot(p)
    expect(await failure(() => ballot(M, p, invited, ['yes', 'yes'], 1))).toMatchObject({
      kind: 'conflict',
      code: 'poll_changed',
    })
    expect(await failure(() => withdraw(M, invited, 1))).toMatchObject({ code: 'poll_changed' })
    expect(await snapshot(p)).toBe(current)

    // A verified public voter: ballot, withdrawal, a repeat, then reactivation.
    expect(
      await succeeds(() => ballot(M, p, voting.voting, ['if_need_be', 'no'], 0)),
    ).toMatchObject({ ballotRevision: 1 })
    results += 1
    await settled()
    const withdrawn = await succeeds(() => withdraw(M, voting.voting, 1))
    results += 1
    await settled()
    expect(withdrawn).toMatchObject({
      ballotRevision: 2,
      voter: { status: 'withdrawn' },
      submittedAt: null,
      consentedAt: null,
      votes: [],
      responses: {},
    })
    const quiet = await snapshot(p)
    expect(await succeeds(() => withdraw(M, voting.voting, 2))).toEqual(withdrawn)
    expect(await snapshot(p)).toBe(quiet)
    expect(await failure(() => withdraw(M, voting.voting, 1))).toMatchObject({
      code: 'poll_changed',
    })
    const back = await succeeds(() => ballot(M, p, voting.voting, ['yes', 'no'], 2))
    results += 1
    await settled()
    expect(back).toMatchObject({ ballotRevision: 3, voter: { status: 'verified' } })

    // Opt-out and a repeated verification move neither revision.
    const optOutToken = await optOutCredential(p, row.id)
    await succeeds(() => optOut(M, optOutToken))
    await settled()
    await succeeds(() => M.V.verifyMeetingPollVoter(pub(), { token: invited }))
    await settled()
  }

  /**
   * A ballot answers every candidate of its poll exactly once, with valid values, answers to
   * the snapshotted questions and valid profile fields, or nothing is written.
   */
  async function verifyCompleteBallot(M: Modules) {
    const questions = [
      { id: 'topic', label: 'Topic', type: 'short_text', required: true },
      { id: 'size', label: 'Team size', type: 'select', options: ['small', 'large'] },
    ]
    const p = await open('invited', questions)
    const other = await open('invited')
    const token = await invitee(M, p, 'complete@example.com')
    const [a, b] = p.slotIds as [string, string]
    const elsewhere = other.slotIds[0] as string
    const submit = (input: Partial<Ballots.SubmitMeetingPollBallotInput>) =>
      M.B.submitMeetingPollBallot(pub(), {
        token,
        votes: votes(p, ['yes', 'no']),
        consent: true,
        responses: { topic: 'Plan' },
        expectedBallotRevision: 0,
        ...input,
      })
    const before = await snapshot(p)
    const incomplete: unknown[] = [
      [{ slotId: a, value: 'yes' }],
      [
        { slotId: a, value: 'yes' },
        { slotId: a, value: 'no' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: elsewhere, value: 'no' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: randomUUID(), value: 'no' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: b, value: 'no' },
        { slotId: elsewhere, value: 'no' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: b, value: 'maybe' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: b, value: 'no', note: 'later' },
      ],
      [
        { slotId: a, value: 'yes' },
        { slotId: 'not-a-candidate', value: 'no' },
      ],
      [{ slotId: a, value: 'yes' }, null],
      [],
      'yes',
      null,
      undefined,
    ]
    for (const entry of incomplete)
      expect(await failure(() => submit({ votes: entry as never }))).toMatchObject({
        kind: 'invalid',
        code: 'invalid_ballot',
      })
    for (const expectedBallotRevision of [-1, 0.5, '0', null, undefined])
      expect(
        await failure(() => submit({ expectedBallotRevision: expectedBallotRevision as never })),
      ).toMatchObject({ code: 'invalid_ballot' })
    for (const responses of [
      {},
      { topic: '  ' },
      { topic: 'Plan', size: 'huge' },
      { topic: 'Plan', unknown: 'x' },
      'Plan',
    ])
      expect(await failure(() => submit({ responses: responses as never }))).toMatchObject({
        kind: 'invalid',
        code: 'invalid_responses',
      })
    expect(await failure(() => submit({ name: ' ' }))).toMatchObject({ code: 'invalid_voter' })
    expect(await failure(() => submit({ locale: 'xx' }))).toMatchObject({ code: 'invalid_voter' })
    expect(await failure(() => submit({ timeZone: 'Mars/Base' }))).toMatchObject({
      code: 'invalid_time_zone',
    })
    expect(await snapshot(p)).toBe(before)

    // The complete ballot, candidate IDs in any order or case, with normalized answers.
    const done = await succeeds(() =>
      submit({
        votes: [
          { slotId: b.toUpperCase(), value: 'no' },
          { slotId: a, value: 'if_need_be' },
        ],
        responses: { topic: '  Plan  ', size: 'small' },
      }),
    )
    expect(done).toMatchObject({
      ballotRevision: 1,
      votes: votes(p, ['if_need_be', 'no']),
      responses: { topic: 'Plan', size: 'small' },
    })
    const row = await voter(p, 'complete@example.com')
    expect(row.responses).toEqual({ topic: 'Plan', size: 'small' })
    expect(await votesOf(row.id)).toEqual(votes(p, ['if_need_be', 'no']))
    // Voters answer the questions they consented to: later event edits do not apply.
    await db
      .updateTable('event_types')
      .set({ questions: JSON.stringify([]) })
      .where('id', '=', p.eventTypeId)
      .execute()
    expect(await failure(() => ballot(M, p, token, ['yes', 'yes'], 1))).toMatchObject({
      code: 'invalid_responses',
    })
    await succeeds(() => ballot(M, p, token, ['yes', 'yes'], 1, { responses: { topic: 'Plan' } }))
  }

  /**
   * Every ballot carries join consent, recorded at the decision instant and renewed by each
   * replacement; withdrawal clears it and reactivation needs it again.
   */
  async function verifyConsent(M: Modules) {
    const p = await open('invited')
    const token = await invitee(M, p, 'consent@example.com')
    const before = await snapshot(p)
    for (const consent of [false, undefined, 'yes', 1])
      expect(
        await failure(() => ballot(M, p, token, ['yes', 'no'], 0, { consent: consent as never })),
      ).toMatchObject({ kind: 'invalid', code: 'invalid_ballot' })
    expect(await snapshot(p)).toBe(before)
    const first = await succeeds(() => ballot(M, p, token, ['yes', 'no'], 0))
    let row = await voter(p, 'consent@example.com')
    expect(first.consentedAt).toEqual(expect.any(String))
    expect(iso(row.consent)).toBe(first.consentedAt)
    expect(iso(row.submitted)).toBe(first.consentedAt)
    expect(iso(row.updated)).toBe(first.consentedAt)
    const second = await succeeds(() => ballot(M, p, token, ['no', 'no'], 1))
    expect(
      Temporal.Instant.compare(
        Temporal.Instant.from(second.consentedAt as string),
        Temporal.Instant.from(first.consentedAt as string),
      ),
    ).toBe(1)
    expect(iso((await voter(p, 'consent@example.com')).consent)).toBe(second.consentedAt)
    await succeeds(() => withdraw(M, token, 2))
    row = await voter(p, 'consent@example.com')
    expect(row).toMatchObject({ join_consent_at: null, ballot_submitted_at: null })
    const withdrawn = await snapshot(p)
    expect(
      await failure(() => ballot(M, p, token, ['yes', 'yes'], 3, { consent: false as never })),
    ).toMatchObject({ code: 'invalid_ballot' })
    expect(await snapshot(p)).toBe(withdrawn)
    const back = await succeeds(() => ballot(M, p, token, ['yes', 'yes'], 3))
    expect(iso((await voter(p, 'consent@example.com')).consent)).toBe(back.consentedAt)
  }

  /**
   * Only an active voting credential votes or withdraws, and only an opt-out credential opts
   * out. Every other credential is refused with the same 404 as an unknown one.
   */
  async function verifyPurposeSeparation(M: Modules) {
    const p = await open()
    await succeeds(() => enroll(M, p, 'pending@example.com', '192.0.2.21'))
    const pending = await mailed(p, 'pending@example.com')
    const verified = await publicVoter(M, p, 'verified@example.com', '192.0.2.22')
    const invited = await invitee(M, p, 'invitee@example.com')
    const row = await voter(p, 'invitee@example.com')
    const optOutToken = await optOutCredential(p, row.id)
    // Stored under the other purpose's digest domain: only the purpose column tells them apart.
    const disguisedOptOut = randomBytes(32).toString('base64url')
    await capability(
      p,
      row.id,
      'reminder_opt_out',
      Voters.meetingPollCapabilityDigest('voting', disguisedOptOut),
    )
    const disguisedVoting = randomBytes(32).toString('base64url')
    await capability(
      p,
      row.id,
      'voting',
      Voters.meetingPollCapabilityDigest('reminder_opt_out', disguisedVoting),
      9,
    )
    const unknown = await failure(() =>
      ballot(M, p, randomBytes(32).toString('base64url'), ['yes', 'no'], 0),
    )
    expect(unknown).toMatchObject({ kind: 'not_found', code: 'poll_not_found' })
    const before = await snapshot(p)
    for (const token of [
      pending.token,
      verified.verification,
      optOutToken,
      disguisedOptOut,
      'short',
    ]) {
      expect(await failure(() => ballot(M, p, token, ['yes', 'no'], 0))).toEqual(unknown)
      expect(await failure(() => withdraw(M, token, 0))).toEqual(unknown)
    }
    for (const token of [invited, verified.voting, pending.token, disguisedVoting, 'short'])
      expect(await failure(() => optOut(M, token))).toEqual(unknown)
    expect(await snapshot(p)).toBe(before)

    // The opt-out credential works for its purpose only: no verification, no ballot.
    await succeeds(() => optOut(M, optOutToken))
    expect(await voter(p, 'invitee@example.com')).toMatchObject({
      verified_at: null,
      ballot_revision: 0,
    })

    // A credential revoked by a resend no longer writes; the new one does.
    await succeeds(() => resend(M, p, 'invitee@example.com'))
    expect(await failure(() => ballot(M, p, invited, ['yes', 'no'], 0))).toEqual(unknown)
    expect(await failure(() => withdraw(M, invited, 0))).toEqual(unknown)
    const rotated = (await mailed(p, 'invitee@example.com')).token
    await succeeds(() => ballot(M, p, rotated, ['yes', 'no'], 0))
    // A removed voter's credential went with the row; a revoked opt-out credential is unknown.
    await succeeds(() => ballot(M, p, verified.voting, ['no', 'no'], 0))
    await remove(p, 'verified@example.com')
    expect(await failure(() => ballot(M, p, verified.voting, ['yes', 'no'], 1))).toEqual(unknown)
    expect(await failure(() => withdraw(M, verified.voting, 1))).toEqual(unknown)
    await db
      .updateTable('meeting_poll_capabilities')
      .set({ revoked_at: new Date() })
      .where('voter_id', '=', row.id)
      .where('purpose', '=', 'reminder_opt_out')
      .execute()
    expect(await failure(() => optOut(M, optOutToken))).toEqual(unknown)
  }

  /**
   * Withdrawal erases the ballot, frees the place and skips queued mail, keeping the
   * credential for reactivation. The withdrawn mailbox's invitation stays unchanged, and no
   * resend, recovery or enrollment reaches it.
   */
  async function verifyWithdrawal(M: Modules) {
    const p = await open()
    const token = await invitee(M, p, 'leaving@example.com')
    const row = await voter(p, 'leaving@example.com')
    await succeeds(() =>
      ballot(M, p, token, ['yes', 'yes'], 0, { responses: {}, name: 'Leaving Voter' }),
    )
    const taken = await places(p)
    expect((await deliveries(p, row.id)).map((entry) => [entry.kind, entry.state])).toEqual([
      ['invitation', 'pending'],
    ])
    const kept = await credentials(row.id)
    const result = await succeeds(() => withdraw(M, token, 1))
    expect(result).toMatchObject({
      ballotRevision: 2,
      voter: { status: 'withdrawn', name: 'Leaving Voter' },
      submittedAt: null,
      consentedAt: null,
      votes: [],
      responses: {},
    })
    const after = await voter(p, 'leaving@example.com')
    expect(after).toMatchObject({
      name: 'Leaving Voter',
      email: 'leaving@example.com',
      ballot_submitted_at: null,
      join_consent_at: null,
      responses: {},
      admission_ip_digest: null,
      ballot_revision: 2,
    })
    expect(after.withdrawn).not.toBeNull()
    expect(await votesOf(row.id)).toEqual([])
    expect(await places(p)).toBe(taken - 1)
    // Withdrawal opts out of all poll mail; the credential stays for reactivation.
    expect(
      (await deliveries(p, row.id)).map((entry) => [
        entry.kind,
        entry.state,
        entry.error_class,
        entry.capability_ciphertext,
      ]),
    ).toEqual([['invitation', 'skipped', 'withdrawn', null]])
    expect(await credentials(row.id)).toEqual(kept)

    // The withdrawn mailbox's invitation is unchanged and nothing else reaches it.
    const host = (await revisions(p)).host_revision
    const quiet = await mailbox(p, 'leaving@example.com')
    const again = await succeeds(() => invite(M, p, ['leaving@example.com']))
    expect(again.entries).toEqual([
      { email: 'leaving@example.com', outcome: 'unchanged', voterId: row.id, status: 'withdrawn' },
    ])
    expect(await failure(() => resend(M, p, 'leaving@example.com'))).toMatchObject({
      code: 'voter_withdrawn',
    })
    await succeeds(() => recover(M, p, 'leaving@example.com'))
    await succeeds(() => enroll(M, p, 'leaving@example.com'))
    expect(await mailbox(p, 'leaving@example.com')).toBe(quiet)
    expect(await places(p)).toBe(taken - 1)
    expect((await revisions(p)).host_revision).toBe(host)

    // Reactivation with the same credential takes the place back and mails nothing.
    await succeeds(() => ballot(M, p, token, ['no', 'no'], 2))
    expect(await places(p)).toBe(taken)
    expect(await deliveries(p, row.id)).toHaveLength(1)
  }

  /**
   * Withdrawal opts out of all poll mail, so verifying a withdrawn voter mints, consumes and
   * mails nothing and answers like a repeat: for a public enrollee withdrawn before verifying
   * (storage allows it), a withdrawn invitee and a withdrawn verified public voter.
   */
  async function verifyWithdrawnVerification(M: Modules) {
    const p = await open()
    await succeeds(() => enroll(M, p, 'gone@example.com', '192.0.2.31'))
    const gone = await mailed(p, 'gone@example.com')
    await sql`UPDATE meeting_poll_voters SET withdrawn_at = clock_timestamp(),
      pending_expires_at = NULL, admission_ip_digest = NULL WHERE id = ${gone.voter.id}`.execute(db)
    await sql`UPDATE meeting_poll_deliveries SET state = 'skipped', terminal_at = clock_timestamp(),
      capability_ciphertext = NULL, error_class = 'withdrawn'
      WHERE voter_id = ${gone.voter.id}`.execute(db)
    const before = await snapshot(p)
    const answer = await succeeds(() => M.V.verifyMeetingPollVoter(pub(), { token: gone.token }))
    expect(answer).toEqual({
      voter: {
        pollId: p.pollId,
        voterId: gone.voter.id,
        name: 'Public Voter',
        email: 'gone@example.com',
        timeZone: 'Europe/Berlin',
        locale: 'en',
        status: 'withdrawn',
        deadlineAt: (await deadlineOf(p)).toString(),
      },
      votingToken: null,
    })
    expect(await snapshot(p)).toBe(before)
    expect((await credentials(gone.voter.id)).map((row) => [row.purpose, row.consumed_at])).toEqual(
      [['verification', null]],
    )
    expect(
      (await deliveries(p, gone.voter.id)).map((row) => [row.kind, row.generation, row.state]),
    ).toEqual([['verification', 1, 'skipped']])

    // Reachable through the services: a withdrawn invitee and a withdrawn verified voter.
    const invited = await invitee(M, p, 'invited@example.com')
    await succeeds(() => withdraw(M, invited, 0))
    const verified = await publicVoter(M, p, 'public@example.com', '192.0.2.32')
    await succeeds(() => withdraw(M, verified.voting, 0))
    const settled = await snapshot(p)
    for (const token of [invited, verified.verification, verified.voting])
      expect(await succeeds(() => M.V.verifyMeetingPollVoter(pub(), { token }))).toMatchObject({
        voter: { status: 'withdrawn' },
        votingToken: null,
      })
    expect(await snapshot(p)).toBe(settled)
    expect((await voter(p, 'invited@example.com')).verified_at).toBeNull()
  }

  /**
   * Reactivation takes a place again under the 40-place cap: it fills place 40 exactly, the
   * next one gets the same 409 `poll_full` as any admission and writes nothing, and a freed
   * place lets it in. An active voter's ballot needs no new place.
   */
  async function verifyReactivationCapacity(M: Modules) {
    const p = await open('invited')
    const emails = Array.from({ length: 40 }, (_, index) => `seat-${index}@example.com`)
    await succeeds(() => invite(M, p, emails))
    const [a, b, c] = await Promise.all(
      emails.slice(0, 3).map(async (email) => (await mailed(p, email)).token),
    )
    await succeeds(() => ballot(M, p, a as string, ['yes', 'no'], 0))
    await succeeds(() => withdraw(M, a as string, 1))
    await succeeds(() => withdraw(M, b as string, 0))
    await succeeds(() => invite(M, p, ['late@example.com']))
    expect(await places(p)).toBe(39)
    expect(await succeeds(() => ballot(M, p, a as string, ['no', 'yes'], 2))).toMatchObject({
      ballotRevision: 3,
      voter: { status: 'verified' },
    })
    expect(await places(p)).toBe(40)
    const full = await failure(() => invite(M, p, ['one-more@example.com']))
    expect(full).toMatchObject({ kind: 'conflict', code: 'poll_full' })
    const before = await snapshot(p)
    expect(await failure(() => ballot(M, p, b as string, ['yes', 'yes'], 1))).toEqual(full)
    expect(await snapshot(p)).toBe(before)
    await succeeds(() => ballot(M, p, a as string, ['yes', 'yes'], 3))
    await succeeds(() => withdraw(M, c as string, 0))
    await succeeds(() => ballot(M, p, b as string, ['yes', 'yes'], 1))
    expect(await places(p)).toBe(40)
  }

  /** Reactivation and a new enrollment race for the last place: exactly one gets it. */
  async function verifyReactivationRace(M: Modules) {
    for (const reactivationFirst of [true, false]) {
      const p = await open()
      const emails = Array.from({ length: 40 }, (_, index) => `race-${index}@example.com`)
      await succeeds(() => invite(M, p, emails))
      const token = (await mailed(p, emails[0] as string)).token
      await succeeds(() => withdraw(M, token, 0))
      expect(await places(p)).toBe(39)
      const reactivate = () => ballot(M, p, token, ['yes', 'no'], 1)
      const join = () => enroll(M, p, 'newcomer@example.com')
      const result = reactivationFirst
        ? await queued(p, reactivate, join)
        : await queued(p, join, reactivate)
      expect(result.map(outcome)).toEqual(['fulfilled', { code: 'poll_full' }])
      expect(await places(p)).toBe(40)
    }
  }

  /**
   * Two writes from one form revision race over two connections: the first wins and the
   * second gets 409 `poll_changed` without touching the winner's decision.
   */
  async function verifyBallotRace(M: Modules) {
    const p = await open('invited')
    const token = await invitee(M, p, 'twice@example.com')
    const row = await voter(p, 'twice@example.com')
    const racing = await queued(
      p,
      () => ballot(M, p, token, ['yes', 'no'], 0),
      () => ballot(M, p, token, ['no', 'yes'], 0),
    )
    expect(racing.map(outcome)).toEqual(['fulfilled', { code: 'poll_changed' }])
    expect(await votesOf(row.id)).toEqual(votes(p, ['yes', 'no']))
    const mixed = await queued(
      p,
      () => withdraw(M, token, 1),
      () => ballot(M, p, token, ['no', 'no'], 1),
    )
    expect(mixed.map(outcome)).toEqual(['fulfilled', { code: 'poll_changed' }])
    expect(await voter(p, 'twice@example.com')).toMatchObject({ ballot_revision: 2 })
    expect(await votesOf(row.id)).toEqual([])
  }

  /**
   * The database clock read after the locks decides: at exactly the deadline voting is
   * closed, one microsecond earlier it is open and that instant stamps the write.
   */
  async function verifyDeadlineEquality(M: Modules) {
    const p = await open('invited')
    const edge = await invitee(M, p, 'edge@example.com')
    await succeeds(() => ballot(M, p, edge, ['yes', 'no'], 0))
    const leaver = await invitee(M, p, 'leaver@example.com')
    await succeeds(() => withdraw(M, leaver, 0))
    const fresh = await invitee(M, p, 'fresh@example.com')
    const edgeRow = await voter(p, 'edge@example.com')
    const optOutToken = await optOutCredential(p, edgeRow.id)
    const deadline = await deadlineOf(p)
    try {
      await freeze(p, 0)
      expect((await databaseNow(frozen)).equals(deadline)).toBe(true)
      const before = await snapshot(p)
      for (const attempt of [
        () => ballot(M, p, edge, ['no', 'no'], 1, {}, frozen),
        () => withdraw(M, edge, 1, frozen),
        () => ballot(M, p, leaver, ['yes', 'yes'], 1, {}, frozen),
        () => ballot(M, p, fresh, ['yes', 'yes'], 0, {}, frozen),
        () => M.V.verifyMeetingPollVoter(pub(undefined, frozen), { token: fresh }),
      ])
        expect(await failure(attempt)).toMatchObject({ kind: 'conflict', code: 'poll_closed' })
      expect(await snapshot(p)).toBe(before)
      // A mail preference is honoured at the deadline too.
      expect(await succeeds(() => optOut(M, optOutToken, frozen))).toEqual({
        pollId: p.pollId,
        optedOutAt: deadline.toString(),
      })

      await freeze(p, 1)
      const accepted = await succeeds(() => ballot(M, p, edge, ['no', 'no'], 1, {}, frozen))
      const instant = deadline.subtract({ microseconds: 1 }).toString()
      expect(accepted).toMatchObject({ ballotRevision: 2, submittedAt: instant })
      expect(await succeeds(() => withdraw(M, edge, 2, frozen))).toMatchObject({
        ballotRevision: 3,
      })
      expect(
        await succeeds(() => ballot(M, p, leaver, ['yes', 'yes'], 1, {}, frozen)),
      ).toMatchObject({ ballotRevision: 2, submittedAt: instant })
    } finally {
      await thaw()
    }
  }

  /**
   * Writes queued on the poll lock while the deadline passes read the clock after the lock
   * and are refused; queuing alone refuses nothing.
   */
  async function verifyDeadlineRace(M: Modules) {
    const p = await open('invited')
    const stay = await invitee(M, p, 'stay@example.com')
    const back = await invitee(M, p, 'back@example.com')
    await succeeds(() => ballot(M, p, stay, ['yes', 'no'], 0))
    const waited = await queued(
      p,
      () => ballot(M, p, stay, ['no', 'yes'], 1),
      () => withdraw(M, back, 0),
    )
    expect(waited.map(outcome)).toEqual(['fulfilled', 'fulfilled'])

    const deadline = await deadlineIn(p, 8)
    const before = await snapshot(p)
    const release = await holdPoll(p)
    const attempts: Promise<unknown>[] = []
    let queuedAt: Temporal.Instant
    try {
      for (const attempt of [
        () => ballot(M, p, stay, ['yes', 'yes'], 2),
        () => ballot(M, p, back, ['yes', 'yes'], 1),
        () => withdraw(M, stay, 2),
      ]) {
        const work = attempt()
        work.catch(() => undefined)
        attempts.push(work)
        await waiters(attempts.length)
      }
      queuedAt = await databaseNow()
      while (Temporal.Instant.compare(await databaseNow(), deadline) <= 0) await sleep(50)
    } finally {
      await release()
    }
    expect(Temporal.Instant.compare(queuedAt, deadline)).toBe(-1)
    for (const work of attempts)
      expect(await failure(() => work)).toMatchObject({ kind: 'conflict', code: 'poll_closed' })
    expect(await snapshot(p)).toBe(before)
  }

  /**
   * After the deadline, or once the poll is closed, canceled or its event deleted, ballots,
   * withdrawals and reactivations are refused alike and the stored ballot stays as it was.
   */
  async function verifyReadOnly(M: Modules) {
    const p = await open('invited')
    const voted = await invitee(M, p, 'voted@example.com')
    await succeeds(() => ballot(M, p, voted, ['yes', 'no'], 0))
    const left = await invitee(M, p, 'left@example.com')
    await succeeds(() => withdraw(M, left, 0))
    const fresh = await invitee(M, p, 'fresh@example.com')
    const votedRow = await voter(p, 'voted@example.com')
    const optOutToken = await optOutCredential(p, votedRow.id)
    await pastDeadline(p)
    const before = await snapshot(p)
    const closed = await failure(() => ballot(M, p, voted, ['no', 'no'], 1))
    expect(closed).toMatchObject({ kind: 'conflict', code: 'poll_closed' })
    for (const attempt of [
      () => withdraw(M, voted, 1),
      () => ballot(M, p, left, ['no', 'no'], 1),
      () => ballot(M, p, fresh, ['no', 'no'], 0),
      () => withdraw(M, fresh, 0),
    ])
      expect(await failure(attempt)).toEqual(closed)
    expect(await snapshot(p)).toBe(before)
    expect(await votesOf(votedRow.id)).toEqual(votes(p, ['yes', 'no']))
    // A mail preference is still honoured.
    await succeeds(() => optOut(M, optOutToken))

    const shut = await open('invited')
    const shutToken = await invitee(M, shut, 'shut@example.com')
    await Polls.closeMeetingPoll(shut.ctx, {
      id: shut.pollId,
      expectedHostRevision: (await revisions(shut)).host_revision,
    })
    expect(await failure(() => ballot(M, shut, shutToken, ['yes', 'no'], 0))).toEqual(closed)
    expect(await failure(() => withdraw(M, shutToken, 0))).toEqual(closed)

    const canceled = await open('invited')
    const canceledToken = await invitee(M, canceled, 'canceled@example.com')
    const canceledOptOut = await optOutCredential(
      canceled,
      (await voter(canceled, 'canceled@example.com')).id,
    )
    await Polls.cancelMeetingPoll(canceled.ctx, {
      id: canceled.pollId,
      expectedHostRevision: (await revisions(canceled)).host_revision,
    })
    const canceledError = await failure(() => ballot(M, canceled, canceledToken, ['yes', 'no'], 0))
    expect(canceledError).toMatchObject({ kind: 'conflict', code: 'poll_canceled' })
    expect(await failure(() => withdraw(M, canceledToken, 0))).toEqual(canceledError)
    await succeeds(() => optOut(M, canceledOptOut))

    const deleted = await open('invited')
    const deletedToken = await invitee(M, deleted, 'deleted@example.com')
    const deletedOptOut = await optOutCredential(
      deleted,
      (await voter(deleted, 'deleted@example.com')).id,
    )
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', deleted.eventTypeId)
      .execute()
    expect(await failure(() => ballot(M, deleted, deletedToken, ['yes', 'no'], 0))).toEqual(closed)
    expect(await failure(() => withdraw(M, deletedToken, 0))).toEqual(closed)
    await succeeds(() => optOut(M, deletedOptOut))
  }

  /**
   * Opt-out records the mailbox's first opt-out and skips its queued reminders only, without
   * verification, ballot access or a revision. It survives credential rotation, withdrawal
   * and reactivation; a repeat writes nothing.
   */
  async function verifyOptOut(M: Modules) {
    const p = await open()
    await invitee(M, p, 'quiet@example.com')
    const row = await voter(p, 'quiet@example.com')
    const token = await optOutCredential(p, row.id)
    await queueReminder(p, row.id)
    await invitee(M, p, 'other@example.com')
    const otherRow = await voter(p, 'other@example.com')
    await queueReminder(p, otherRow.id)
    const before = await revisions(p)
    const first = await succeeds(() => optOut(M, token))
    expect(first.pollId).toBe(p.pollId)
    expect(iso((await counter(p, 'quiet@example.com')).optedOut)).toBe(first.optedOutAt)
    expect(
      (await deliveries(p, row.id)).map((entry) => [
        entry.kind,
        entry.state,
        entry.error_class,
        entry.capability_ciphertext === null,
      ]),
    ).toEqual([
      ['invitation', 'pending', null, false],
      ['reminder', 'skipped', 'opted_out', true],
    ])
    expect((await deliveries(p, otherRow.id)).map((entry) => [entry.kind, entry.state])).toEqual([
      ['invitation', 'pending'],
      ['reminder', 'pending'],
    ])
    expect((await counter(p, 'other@example.com')).reminder_opted_out_at).toBeNull()
    expect(await voter(p, 'quiet@example.com')).toMatchObject({
      verified_at: null,
      ballot_revision: 0,
    })
    expect(await revisions(p)).toEqual(before)
    const settled = await snapshot(p)
    expect(await succeeds(() => optOut(M, token))).toEqual(first)
    expect(await snapshot(p)).toBe(settled)

    // Independent of the voting credential line, withdrawal and reactivation.
    await succeeds(() => resend(M, p, 'quiet@example.com'))
    const rotated = (await mailed(p, 'quiet@example.com')).token
    expect(
      (await credentials(row.id)).find((entry) => entry.purpose === 'reminder_opt_out'),
    ).toMatchObject({ revoked_at: null })
    expect(await succeeds(() => optOut(M, token))).toEqual(first)
    await succeeds(() => ballot(M, p, rotated, ['yes', 'no'], 0))
    await succeeds(() => withdraw(M, rotated, 1))
    await succeeds(() => ballot(M, p, rotated, ['yes', 'no'], 2))
    expect(iso((await counter(p, 'quiet@example.com')).optedOut)).toBe(first.optedOutAt)
  }

  /**
   * Ballot, withdrawal and opt-out take the organization before the poll, as public booking
   * and the other public voter writes do: one that waits for the organization holds no poll
   * lock, so organization deletion cannot deadlock with it.
   */
  async function verifyLockOrder(M: Modules) {
    const p = await open('invited')
    const token = await invitee(M, p, 'ordered@example.com')
    const optOutToken = await optOutCredential(p, (await voter(p, 'ordered@example.com')).id)
    for (const attempt of [
      () => ballot(M, p, token, ['yes', 'no'], 0),
      () => optOut(M, optOutToken),
      () => withdraw(M, token, 1),
    ]) {
      const release = await holding((trx) =>
        trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', p.organizationId)
          .forUpdate()
          .execute(),
      )
      const work: Promise<unknown> = attempt()
      work.catch(() => undefined)
      let order: 'queued' | 'settled'
      let probe: 'free' | 'held'
      try {
        order = await queues(work)
        probe = await db
          .transaction()
          .execute((trx) =>
            trx
              .selectFrom('meeting_polls')
              .select('id')
              .where('id', '=', p.pollId)
              .forUpdate()
              .noWait()
              .execute(),
          )
          .then(
            () => 'free' as const,
            () => 'held' as const,
          )
      } finally {
        await release()
      }
      expect(order).toBe('queued')
      expect(probe).toBe('free')
      await succeeds(() => work)
    }
  }

  // --- Behaviour ---------------------------------------------------------------------------

  const REAL: Modules = { V: Voters, B: Ballots }

  it('advances ballot and results revisions on voter writes, never the host revision', async () => {
    await verifyRevisions(REAL)
  })

  it('accepts only a complete ballot with valid answers', async () => {
    await verifyCompleteBallot(REAL)
  })

  it('records join consent with every ballot', async () => {
    await verifyConsent(REAL)
  })

  it('refuses credentials of another purpose alike', async () => {
    await verifyPurposeSeparation(REAL)
  })

  it('withdraws without mail and leaves the withdrawn invitation unchanged', async () => {
    await verifyWithdrawal(REAL)
  })

  it('mints and mails nothing when a withdrawn voter verifies', async () => {
    await verifyWithdrawnVerification(REAL)
  })

  it('reacquires a place on reactivation under the 40-place cap', async () => {
    await verifyReactivationCapacity(REAL)
  })

  it('gives the last place to exactly one of a reactivation and an enrollment', async () => {
    await verifyReactivationRace(REAL)
  })

  it('lets the first of two racing writes from one revision win', async () => {
    await verifyBallotRace(REAL)
  })

  it('treats the exact deadline instant as closed', async () => {
    await verifyDeadlineEquality(REAL)
  })

  it('refuses writes that waited on the poll lock across the deadline', async () => {
    await verifyDeadlineRace(REAL)
  }, 30_000)

  it('keeps ballots read-only after the deadline and once voting closes', async () => {
    await verifyReadOnly(REAL)
  })

  it('records a reminder opt-out once and skips only queued reminders', async () => {
    await verifyOptOut(REAL)
  })

  it('locks the organization before the poll on ballot writes', async () => {
    await verifyLockOrder(REAL)
  })

  // --- Mutation checks --------------------------------------------------------------------

  const verifications = [
    verifyRevisions,
    verifyCompleteBallot,
    verifyConsent,
    verifyPurposeSeparation,
    verifyWithdrawal,
    verifyWithdrawnVerification,
    verifyReactivationCapacity,
    verifyReactivationRace,
    verifyBallotRace,
    verifyDeadlineEquality,
    verifyDeadlineRace,
    verifyReadOnly,
    verifyOptOut,
    verifyLockOrder,
  ]

  it('passes every protection check through unmodified source copies', async () => {
    const copies = await sourceCopy()
    for (const verify of verifications) await verify(copies)
  }, 240_000)

  type Mutant = [string, (M: Modules) => Promise<void>, Mutation]
  const NO_POLL_LOCK: Replacement = [
    '    .forUpdate()\n    .executeTakeFirst()\n  if (!poll) return undefined',
    '    .executeTakeFirst()\n  if (!poll) return undefined',
  ]
  const SUBMIT_REVISIONS =
    '    await advanceRevisions(trx, poll, { host: false })\n    return ownBallot(trx, poll, voter.id)\n  })\n}\n\n/**\n * Withdraw'
  const mutants: Mutant[] = [
    [
      'voter writes advance the host revision',
      verifyRevisions,
      {
        voters: [
          [
            '...(options.host ? { host_revision: options.hostRevision + 1 } : {}),',
            "host_revision: eb('host_revision', '+', 1),",
          ],
        ],
      },
    ],
    [
      'a ballot advances the host revision',
      verifyRevisions,
      {
        ballots: [
          [
            SUBMIT_REVISIONS,
            SUBMIT_REVISIONS.replace(
              '{ host: false })\n',
              '{ host: false })\n    await sql`UPDATE meeting_polls SET host_revision = host_revision + 1 WHERE id = ${poll.id}`.execute(trx)\n',
            ),
          ],
        ],
      },
    ],
    [
      'a withdrawal advances the host revision',
      verifyRevisions,
      {
        ballots: [
          [
            "    await skipQueuedMail(trx, poll, voter.id, 'withdrawn')\n",
            "    await skipQueuedMail(trx, poll, voter.id, 'withdrawn')\n    await sql`UPDATE meeting_polls SET host_revision = host_revision + 1 WHERE id = ${poll.id}`.execute(trx)\n",
          ],
        ],
      },
    ],
    [
      'a ballot leaves the results revision',
      verifyRevisions,
      {
        ballots: [
          [
            SUBMIT_REVISIONS,
            SUBMIT_REVISIONS.replace(
              '    await advanceRevisions(trx, poll, { host: false })\n',
              '',
            ),
          ],
        ],
      },
    ],
    [
      'a stale ballot overwrites a newer one',
      verifyRevisions,
      {
        ballots: [
          [
            '    if (voter.ballot_revision !== expected) throw changed()\n    if (voter.withdrawn) {\n',
            '    if (voter.withdrawn) {\n',
          ],
        ],
      },
    ],
    [
      'a stale withdrawal overwrites a newer ballot',
      verifyRevisions,
      {
        ballots: [
          [
            '    if (voter.ballot_revision !== expected) throw changed()\n    if (voter.withdrawn) return',
            '    if (voter.withdrawn) return',
          ],
        ],
      },
    ],
    [
      'a repeated withdrawal writes again',
      verifyRevisions,
      { ballots: [['    if (voter.withdrawn) return ownBallot(trx, poll, voter.id)\n', '']] },
    ],
    [
      'an invitee ballot leaves the mailbox unconfirmed',
      verifyRevisions,
      {
        ballots: [
          [
            '        verified_at: sql<string>`coalesce(verified_at, ${poll.at}::timestamptz)`,\n',
            '',
          ],
        ],
      },
    ],
    [
      'a partial ballot is accepted',
      verifyCompleteBallot,
      {
        ballots: [
          [
            'if (slots.length !== choices.size || slots.some((slot) => !choices.has(slot.id)))',
            'if ([...choices.keys()].some((id) => !slots.some((slot) => slot.id === id)))',
          ],
        ],
      },
    ],
    [
      'a ballot may name candidates of another poll',
      verifyCompleteBallot,
      {
        ballots: [
          [
            'if (slots.length !== choices.size || slots.some((slot) => !choices.has(slot.id)))',
            'if (slots.length !== choices.size)',
          ],
        ],
      },
    ],
    [
      'answers skip the snapshotted questions',
      verifyCompleteBallot,
      {
        ballots: [
          [
            'const responses = validateResponses(await snapshotQuestions(trx, poll), input.responses ?? {})',
            'const responses = (input.responses ?? {}) as Responses',
          ],
        ],
      },
    ],
    [
      'a ballot without consent is accepted',
      verifyConsent,
      {
        ballots: [
          [
            "  if (input.consent !== true)\n    throw invalidBallot('consent must be true: a ballot agrees to join the meeting if selected')\n",
            '',
          ],
        ],
      },
    ],
    [
      'a replacement keeps the first consent',
      verifyConsent,
      {
        ballots: [
          [
            '        join_consent_at: poll.at,\n',
            '        join_consent_at: sql<string>`coalesce(join_consent_at, ${poll.at}::timestamptz)`,\n',
          ],
        ],
      },
    ],
    [
      'a credential of any purpose casts a ballot',
      verifyPurposeSeparation,
      {
        ballots: [
          [
            "    .where('purpose', '=', 'voting')\n    .where('token_digest', '=', meetingPollCapabilityDigest('voting', token))\n",
            "    .where('token_digest', 'in', [meetingPollCapabilityDigest('voting', token), meetingPollCapabilityDigest('verification', token), meetingPollCapabilityDigest('reminder_opt_out', token)])\n",
          ],
        ],
      },
    ],
    [
      'the ballot lookup ignores the purpose column',
      verifyPurposeSeparation,
      { ballots: [["    .where('purpose', '=', 'voting')\n", '']] },
    ],
    [
      'opt-out accepts credentials of another purpose',
      verifyPurposeSeparation,
      { ballots: [["      .where('purpose', '=', 'reminder_opt_out')\n", '']] },
    ],
    [
      'revoked credentials still write',
      verifyPurposeSeparation,
      { ballots: [["    .where('c.revoked_at', 'is', null)\n", '']] },
    ],
    [
      'withdrawal keeps the votes',
      verifyWithdrawal,
      {
        ballots: [
          [
            "    await trx\n      .deleteFrom('meeting_poll_votes')\n      .where('poll_id', '=', poll.id)\n      .where('voter_id', '=', voter.id)\n      .execute()\n    await skipQueuedMail(",
            '    await skipQueuedMail(',
          ],
        ],
      },
    ],
    [
      'withdrawal leaves queued mail',
      verifyWithdrawal,
      { ballots: [["    await skipQueuedMail(trx, poll, voter.id, 'withdrawn')\n", '']] },
    ],
    [
      'a withdrawn voter verifies, minting and mailing a credential',
      verifyWithdrawnVerification,
      {
        voters: [
          [
            '      if (credential.withdrawn)\n        return { voter: await voterState(trx, poll, voterId), votingToken: null }\n',
            '',
          ],
        ],
      },
    ],
    [
      'a withdrawn invitee verifies',
      verifyWithdrawnVerification,
      {
        voters: [
          ['if (!credential.verified && !credential.withdrawn) {', 'if (!credential.verified) {'],
        ],
      },
    ],
    [
      'reactivation skips the capacity check',
      verifyReactivationCapacity,
      {
        ballots: [
          ['      if (active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()\n', ''],
        ],
      },
    ],
    [
      'reactivation admits a 41st place',
      verifyReactivationCapacity,
      {
        ballots: [
          [
            'if (active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()',
            'if (active > MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()',
          ],
        ],
      },
    ],
    [
      'every ballot checks capacity',
      verifyReactivationCapacity,
      { ballots: [['    if (voter.withdrawn) {\n', '    if (true) {\n']] },
    ],
    ['ballot writes skip the poll row lock', verifyReactivationRace, { voters: [NO_POLL_LOCK] }],
    [
      'ballot writes skip the poll row lock (one voter)',
      verifyBallotRace,
      { voters: [NO_POLL_LOCK] },
    ],
    [
      'a stale ballot overwrites a newer one (race)',
      verifyBallotRace,
      {
        ballots: [
          [
            '    if (voter.ballot_revision !== expected) throw changed()\n    if (voter.withdrawn) {\n',
            '    if (voter.withdrawn) {\n',
          ],
        ],
      },
    ],
    [
      'a ballot is accepted at deadline equality',
      verifyDeadlineEquality,
      {
        voters: [
          [
            'poll.deadline_at <= decision.t AS "deadlinePassed"',
            'poll.deadline_at < decision.t AS "deadlinePassed"',
          ],
        ],
      },
    ],
    [
      'the clock is read before the poll lock',
      verifyDeadlineRace,
      {
        voters: [
          [
            '  try {\n    await lockOrganization(trx, named.organization_id)\n',
            '  const early = await sql<{ t: string }>`SELECT clock_timestamp()::text AS t`.execute(trx)\n  try {\n    await lockOrganization(trx, named.organization_id)\n',
          ],
          [
            '    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)\n',
            '    WITH decision AS MATERIALIZED (SELECT ${early.rows[0]?.t}::timestamptz AS t)\n',
          ],
        ],
      },
    ],
    [
      'the clock is the transaction start',
      verifyDeadlineRace,
      {
        voters: [
          [
            '    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)\n',
            '    WITH decision AS MATERIALIZED (SELECT now() AS t)\n',
          ],
        ],
      },
    ],
    [
      'ballots ignore closed voting',
      verifyReadOnly,
      {
        ballots: [['    requireVotingOpen(poll, pollClosed)\n    const slots', '    const slots']],
      },
    ],
    [
      'withdrawal ignores closed voting',
      verifyReadOnly,
      {
        ballots: [
          [
            '    requireVotingOpen(poll, pollClosed)\n    if (voter.ballot_revision',
            '    if (voter.ballot_revision',
          ],
        ],
      },
    ],
    [
      'voting ignores a passed deadline',
      verifyReadOnly,
      {
        voters: [
          [
            "if (poll.status !== 'open' || poll.deadlinePassed || poll.eventDeleted) throw pollClosed()",
            "if (poll.status !== 'open' || poll.eventDeleted) throw pollClosed()",
          ],
        ],
      },
    ],
    [
      'voting ignores a deleted event',
      verifyReadOnly,
      {
        voters: [
          [
            "if (poll.status !== 'open' || poll.deadlinePassed || poll.eventDeleted) throw pollClosed()",
            "if (poll.status !== 'open' || poll.deadlinePassed) throw pollClosed()",
          ],
        ],
      },
    ],
    [
      'opt-out records nothing',
      verifyOptOut,
      {
        ballots: [
          [
            "    await trx\n      .insertInto('meeting_poll_mailbox_counters')",
            "    if (false) await trx\n      .insertInto('meeting_poll_mailbox_counters')",
          ],
        ],
      },
    ],
    [
      'opt-out leaves queued reminders',
      verifyOptOut,
      {
        ballots: [["    await skipQueuedMail(trx, poll, voter.id, 'opted_out', 'reminder')\n", '']],
      },
    ],
    [
      'opt-out skips all queued mail',
      verifyOptOut,
      {
        ballots: [
          [
            "skipQueuedMail(trx, poll, voter.id, 'opted_out', 'reminder')",
            "skipQueuedMail(trx, poll, voter.id, 'opted_out')",
          ],
        ],
      },
    ],
    [
      'a repeated opt-out moves the first one',
      verifyOptOut,
      {
        ballots: [
          [
            "\n          .where('meeting_poll_mailbox_counters.reminder_opted_out_at', 'is', null),",
            ',',
          ],
        ],
      },
    ],
    [
      'ballot writes skip the organization lock',
      verifyLockOrder,
      {
        voters: [
          [
            '  try {\n    await lockOrganization(trx, named.organization_id)\n  } catch (error) {\n    if (error instanceof DomainError) return undefined\n    throw error\n  }\n',
            '',
          ],
        ],
      },
    ],
  ]

  // Only a failed assertion counts: a mutant that crashes or cannot load is not a detection.
  it.each(mutants)(
    'detects the mutation: %s',
    async (_name, verify, mutation) => {
      const mutated = await sourceCopy(mutation)
      await expect(verify(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
    },
    90_000,
  )
})
