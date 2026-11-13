// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-copy mutations target literal template strings
// Host results, voter removal and bulk removal of unverified enrollees on a real throwaway
// database. Every race uses two connections in the contender-first shape: the contender takes
// its locks up to and including the contested row and stops there, the writer runs as one
// service call until it waits, then the contender finishes. The checks run against the real modules, then
// against isolated source copies with one protection broken; a mutant counts as detected only
// when a real assertion fails.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Ballots from './meeting-poll-ballots.ts'
import * as Key from './meeting-poll-key.ts'
import * as Results from './meeting-poll-results.ts'
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
const OTHER = 'meeting-poll-other-test-secret-9876543210'
const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
/** The advisory lock that pauses writes of the pausable connection inside their transaction. */
const PAUSE = 'hourmere.meeting-poll-results-test.pause'
/** The churning voter replaces their ballot about every second. */
const CHURN_INTERVAL_MS = 1000
/** How often each host operation runs against the churn. */
const RUNS = 3
const MISMATCH = { name: 'MeetingPollKeyMismatchError', code: 'meeting_poll_key_mismatch' }

/** The services under test: the real modules or mutated source copies of all five. */
interface Modules {
  K: typeof Key
  P: typeof Polls
  V: typeof Voters
  B: typeof Ballots
  R: typeof Results
}
type Replacement = readonly [string, string]
interface Mutation {
  key?: readonly Replacement[]
  polls?: readonly Replacement[]
  voters?: readonly Replacement[]
  ballots?: readonly Replacement[]
  results?: readonly Replacement[]
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
 * Isolated copies of the key fence, host lifecycle, voter, ballot and results services, each
 * importing the others' copies, so a mutation in a shared helper reaches every caller. The
 * production files are never overwritten.
 */
async function sourceCopy(mutation: Mutation = {}): Promise<Modules> {
  const key = copy('./meeting-poll-key.ts', mutation.key ?? [], {})
  const polls = copy('./meeting-polls.ts', mutation.polls ?? [], {})
  const voters = copy('./meeting-poll-voters.ts', mutation.voters ?? [], {
    './meeting-poll-key.ts': key,
    './meeting-polls.ts': polls,
  })
  const ballots = copy('./meeting-poll-ballots.ts', mutation.ballots ?? [], {
    './meeting-poll-key.ts': key,
    './meeting-poll-voters.ts': voters,
    './meeting-polls.ts': polls,
  })
  const results = copy('./meeting-poll-results.ts', mutation.results ?? [], {
    './meeting-poll-key.ts': key,
    './meeting-poll-voters.ts': voters,
    './meeting-polls.ts': polls,
    './meeting-poll-ballots.ts': ballots,
  })
  return {
    K: await import(key),
    P: await import(polls),
    V: await import(voters),
    B: await import(ballots),
    R: await import(results),
  }
}

/** Source copies load their own error classes, so compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) expect.unreachable('expected the operation to fail')
  const known = error as Error & { code?: string; retryAfterSeconds?: number }
  return { name: error.name, code: known.code, retryAfterSeconds: known.retryAfterSeconds }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const outcome = (result: PromiseSettledResult<unknown> | undefined) =>
  result?.status === 'rejected'
    ? { code: (result.reason as { code?: string }).code }
    : result?.status === 'fulfilled'
      ? ('fulfilled' as const)
      : 'missing'

const ALWAYS = {
  timeZone: 'UTC',
  weeklyHours: {
    ...weekdays({ start: '00:00', end: '24:00' }),
    saturday: [{ start: '00:00', end: '24:00' }],
    sunday: [{ start: '00:00', end: '24:00' }],
  },
}

type Value = Ballots.MeetingPollVoteValue
type Row = Record<string, unknown>
const POLL_TABLES = [
  'meeting_polls',
  'meeting_poll_slots',
  'meeting_poll_voters',
  'meeting_poll_votes',
  'meeting_poll_capabilities',
  'meeting_poll_deliveries',
  'meeting_poll_mailbox_counters',
  'meeting_poll_operations',
] as const
type Tables = Record<(typeof POLL_TABLES)[number], Row[]>
/** The documented fields of a host roster entry (MeetingPollRosterEntry), sorted. */
const ROSTER_FIELDS = [
  'voterId',
  'name',
  'email',
  'status',
  'timeZone',
  'locale',
  'invitedAt',
  'verifiedAt',
  'withdrawnAt',
  'pendingExpiresAt',
  'ballotRevision',
  'submittedAt',
  'consentedAt',
  'votes',
  'responses',
].sort()

describe.skipIf(!serverUrl)('meeting poll results and voter removal', () => {
  let owned: TestDatabase
  let db: Db
  /** A second connection pool whose voter updates and deletes can be paused (PAUSE). */
  let second: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_results' })
    db = createDb(owned.pool)
    // Test-only pause point, in this throwaway database only: while PAUSE is held, a session
    // that sets poll_test.pause stops before each voter update or delete statement, which its
    // service issues after the key fence and the organization, poll and event locks.
    await sql`CREATE FUNCTION poll_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('poll_test.pause', true) = 'on' THEN
          PERFORM pg_advisory_lock_shared(hashtextextended(${sql.lit(PAUSE)}, 0));
          PERFORM pg_advisory_unlock_shared(hashtextextended(${sql.lit(PAUSE)}, 0));
        END IF;
        RETURN NULL;
      END $$`.execute(db)
    await sql`CREATE TRIGGER poll_test_pause BEFORE UPDATE OR DELETE ON meeting_poll_voters
      FOR EACH STATEMENT EXECUTE FUNCTION poll_test_pause()`.execute(db)
    const url = new URL(owned.url)
    url.searchParams.set('options', '-c poll_test.pause=on')
    second = createDb(createPool(url.toString()))
  }, 120_000)
  afterAll(async () => {
    await second?.destroy()
    await owned?.drop()
  })

  // --- Fixtures ---------------------------------------------------------------------------

  async function databaseNow(on: Db = db) {
    const { rows } = await sql<{
      now: string
    }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${sql.lit(FORMAT)}) AS now`.execute(on)
    return Temporal.Instant.from(rows[0]?.now as string)
  }

  /** A team whose admin manages an event hosted by an ordinary member who is always free. */
  async function space(on: Db) {
    const fixtures = createFixtures(on)
    const admin = await createTestUser(on, 'Team Admin')
    const member = await createTestUser(on, 'Configured Host')
    for (const user of [admin, member]) await fixtures.schedule(user.id, ALWAYS)
    const t = await createTestTeam(on, [
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(t.id, null, { hosts: [{ userId: member.id }] })
    const as = (user: TestUser): Voters.MeetingPollHostContext => ({
      ...testContext(on, session(t.as(user))),
      meetingPollSecret: SECRET,
    })
    return {
      db: on,
      fixtures,
      admin,
      member,
      organizationId: t.id,
      eventTypeId,
      ctx: as(admin),
      memberCtx: as(member),
      principal: t.as(admin),
    }
  }

  type PollSpace = Awaited<ReturnType<typeof open>>

  /** An open poll, about a day before its deadline. */
  async function open(
    admissionMode: 'public_link' | 'invited' = 'public_link',
    candidates = 2,
    on: Db = db,
  ) {
    return pollIn(await space(on), admissionMode, candidates)
  }

  /** Another poll on the same event of the same team, managed by the same admin. */
  async function pollIn(
    s: Awaited<ReturnType<typeof space>>,
    admissionMode: 'public_link' | 'invited' = 'public_link',
    candidates = 2,
  ) {
    const on = s.db
    const deadline = (await databaseNow(on))
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    const created = await Polls.createMeetingPoll(s.ctx, {
      eventTypeId: s.eventTypeId,
      candidateStarts: Array.from({ length: candidates }, (_, index) =>
        deadline.add({ hours: 25 + index }).toString(),
      ),
      deadlineAt: deadline.toString(),
      displayTimeZone: 'Europe/Berlin',
      admissionMode,
      idempotencyKey: randomUUID(),
    })
    const slots = await on
      .selectFrom('meeting_poll_slots')
      .select('id')
      .where('poll_id', '=', created.poll.id)
      .orderBy('position')
      .execute()
    return {
      ...s,
      db: on,
      pollId: created.poll.id,
      link: created.publicToken as string,
      slotIds: slots.map((slot) => slot.id),
    }
  }

  const pub = (
    ip = '192.0.2.10',
    on: Db = db,
    secret = SECRET,
  ): Voters.MeetingPollPublicContext => ({
    db: on,
    meetingPollSecret: secret,
    trustedIp: ip,
  })

  function enroll(M: Modules, p: PollSpace, email: string, ip = '192.0.2.10', on: Db = p.db) {
    return M.V.enrollMeetingPollVoter(pub(ip, on), {
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
    return M.V.recoverMeetingPollVoter(pub(undefined, p.db), { pollId: p.pollId, email })
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

  /** A verified public voter and its voting credential. */
  async function publicVoter(M: Modules, p: PollSpace, email: string, ip: string) {
    await succeeds(() => enroll(M, p, email, ip))
    const { token } = await mailed(p, email)
    const verified = await succeeds(() => M.V.verifyMeetingPollVoter(pub(ip, p.db), { token }))
    return verified.votingToken as string
  }

  function votes(p: PollSpace, values: Value[]) {
    return p.slotIds.map((slotId, index) => ({ slotId, value: values[index] as Value }))
  }

  function ballot(
    M: Modules,
    p: PollSpace,
    token: string,
    values: Value[],
    expectedBallotRevision: number,
    on: Db = p.db,
  ) {
    return M.B.submitMeetingPollBallot(pub(undefined, on), {
      token,
      votes: votes(p, values),
      consent: true,
      expectedBallotRevision,
    })
  }

  function withdraw(M: Modules, p: PollSpace, token: string, expectedBallotRevision: number) {
    return M.B.withdrawMeetingPollVoter(pub(undefined, p.db), { token, expectedBallotRevision })
  }

  function optOut(M: Modules, p: PollSpace, token: string) {
    return M.B.optOutOfMeetingPollReminders(pub(undefined, p.db), { token })
  }

  function results(M: Modules, p: PollSpace) {
    return M.R.getMeetingPollResults(p.ctx, p.pollId)
  }

  async function remove(M: Modules, p: PollSpace, voterId: string, expectedHostRevision?: number) {
    return M.R.removeMeetingPollVoter(p.ctx, {
      id: p.pollId,
      voterId,
      expectedHostRevision: expectedHostRevision ?? (await revisions(p)).host_revision,
    })
  }

  async function removeUnverified(M: Modules, p: PollSpace, expectedHostRevision?: number) {
    return M.R.removeUnverifiedMeetingPollVoters(p.ctx, {
      id: p.pollId,
      expectedHostRevision: expectedHostRevision ?? (await revisions(p)).host_revision,
    })
  }

  /** The purpose-limited opt-out credential that later mail steps put in invitations. */
  async function optOutCredential(p: PollSpace, voterId: string) {
    const token = randomBytes(32).toString('base64url')
    await p.db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: voterId,
        purpose: 'reminder_opt_out',
        token_digest: Voters.meetingPollCapabilityDigest('reminder_opt_out', token),
        expires_at: (await revisions(p)).deadline,
      })
      .execute()
    return token
  }

  /** A queued deadline reminder, as the later reminder job writes it. */
  async function queueReminder(p: PollSpace, voterId: string) {
    await p.db
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

  async function voter(p: PollSpace, email: string) {
    return p.db
      .selectFrom('meeting_poll_voters')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
  }

  async function voterIds(p: PollSpace, emails: string[]) {
    const rows = await p.db
      .selectFrom('meeting_poll_voters')
      .select('id')
      .where('poll_id', '=', p.pollId)
      .where('email', 'in', emails)
      .orderBy('id')
      .execute()
    return rows.map((row) => row.id)
  }

  async function voterCount(p: PollSpace, email: string) {
    const rows = await p.db
      .selectFrom('meeting_poll_voters')
      .select('id')
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .execute()
    return rows.length
  }

  async function deliveries(p: PollSpace, voterId: string) {
    return p.db
      .selectFrom('meeting_poll_deliveries')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('voter_id', '=', voterId)
      .orderBy('id')
      .execute()
  }

  async function counter(p: PollSpace, email: string) {
    return p.db
      .selectFrom('meeting_poll_mailbox_counters')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('email_key', '=', Voters.meetingPollMailboxKey(SECRET, p.pollId, email))
      .executeTakeFirstOrThrow()
  }

  async function revisions(p: PollSpace) {
    return p.db
      .selectFrom('meeting_polls')
      .select([
        'host_revision',
        'results_revision',
        'status',
        sql<string>`deadline_at::text`.as('deadline'),
      ])
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
  }

  /** Places in use now: active verified voters, active invitations and live reservations. */
  async function places(p: PollSpace) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM meeting_poll_voters
      WHERE poll_id = ${p.pollId} AND withdrawn_at IS NULL AND (verified_at IS NOT NULL
        OR invited_at IS NOT NULL OR pending_expires_at > clock_timestamp())`.execute(p.db)
    return Number(rows[0]?.n)
  }

  /** Every row of the poll, table by table, in id order. */
  async function tables(p: PollSpace): Promise<Tables> {
    const result = {} as Tables
    for (const table of POLL_TABLES)
      result[table] = (
        await sql<{ row: Row }>`SELECT to_jsonb(t) AS row FROM ${sql.table(table)} t
          WHERE ${sql.ref(table === 'meeting_polls' ? 'id' : 'poll_id')} = ${p.pollId}
          ORDER BY id`.execute(p.db)
      ).rows.map((entry) => entry.row)
    return result
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

  async function expirePending(p: PollSpace, email: string) {
    const row = await voter(p, email)
    const now = await databaseNow(p.db)
    const values = {
      created_at: now.subtract({ hours: 2 }).toString(),
      expires: now.subtract({ minutes: 61 }).toString(),
    }
    await p.db
      .updateTable('meeting_poll_voters')
      .set({ created_at: values.created_at, pending_expires_at: values.expires })
      .where('id', '=', row.id)
      .execute()
    await p.db
      .updateTable('meeting_poll_capabilities')
      .set({ created_at: values.created_at, expires_at: values.expires })
      .where('voter_id', '=', row.id)
      .where('purpose', '=', 'verification')
      .execute()
  }

  async function pastDeadline(p: PollSpace) {
    await sql`WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
      UPDATE meeting_polls SET created_at = decision.t - interval '2 hours',
        deadline_at = decision.t - interval '1 hour'
      FROM decision WHERE id = ${p.pollId}`.execute(p.db)
  }

  async function scheduled(p: PollSpace) {
    const slot = await p.db
      .selectFrom('meeting_poll_slots')
      .select(['id', 'start_at', 'end_at'])
      .where('poll_id', '=', p.pollId)
      .orderBy('position')
      .executeTakeFirstOrThrow()
    const bookingId = await p.fixtures.booking(
      p.organizationId,
      [p.member.id],
      slot.start_at.toISOString(),
      slot.end_at.toISOString(),
      { eventTypeId: p.eventTypeId },
    )
    await sql`UPDATE meeting_polls SET status = 'scheduled', chosen_slot_id = ${slot.id},
      booking_id = ${bookingId}, scheduled_at = clock_timestamp() WHERE id = ${p.pollId}`.execute(
      p.db,
    )
  }

  /** A real, enabled API key of the team admin with this scope. */
  async function apiKeyContext(
    p: PollSpace,
    scope: 'full' | 'read' | 'bookings',
  ): Promise<Voters.MeetingPollHostContext> {
    const row = await p.db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: p.admin.id,
        key: createHash('sha256').update(randomUUID()).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope, organizationId: p.organizationId }),
        enabled: true,
        expiresAt: null,
        lastRefillAt: null,
        lastRequest: null,
        name: null,
        permissions: null,
        prefix: null,
        rateLimitEnabled: false,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: null,
        start: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      ...testContext(p.db, {
        kind: 'api_key',
        apiKeyId: row.id,
        apiKeyScope: scope,
        user: p.principal.user,
        organization: p.principal.organization,
      }),
      meetingPollSecret: SECRET,
    }
  }

  // --- Concurrency helpers ----------------------------------------------------------------

  /** Waits until `count` sessions of this database wait for a lock; false after 10 seconds. */
  async function waiters(count: number): Promise<boolean> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count
        FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock'`.execute(db)
      if (Number(rows[0]?.count) >= count) return true
      await sleep(25)
    }
    return false
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

  const holdPause = () =>
    holding((trx) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${PAUSE}, 0))`.execute(trx))

  /**
   * Run `writers` as single steps while `contender`, on the pausable connection, stops inside
   * its transaction after its locks up to the poll row: each writer must wait for that row
   * before the contender may finish. Returns every settlement, contender first.
   */
  async function contenderFirst(
    contender: (() => Promise<unknown>) | undefined,
    writers: (() => Promise<unknown>)[],
  ) {
    const release = await holdPause()
    const work: Promise<unknown>[] = []
    let refused: unknown
    try {
      if (contender) {
        const started = contender()
        started.catch(() => undefined)
        work.push(started)
      }
      expect(await waiters(1), 'the contender pauses holding the poll lock').toBe(true)
      for (const [index, writer] of writers.entries()) {
        const started = writer()
        started.catch(() => undefined)
        work.push(started)
        expect(await waiters(index + 2), 'the writer waits for the poll row').toBe(true)
      }
    } catch (error) {
      refused = error
    } finally {
      await release()
    }
    // Every started write settles before a failed expectation is reported, so none still
    // holds or waits for a lock when the next check counts lock waiters.
    const settled = await Promise.allSettled(work)
    if (refused !== undefined) throw refused
    return settled
  }

  /**
   * A voter who replaces their whole ballot about every second on the pausable connection,
   * from expected ballot revision `start`, until stopped or refused.
   */
  function churn(M: Modules, p: PollSpace, token: string, start = 0) {
    let revision = start
    const stopping = Promise.withResolvers<void>()
    let stopped = false
    const outcomes: string[] = []
    const ended = (async () => {
      while (!stopped) {
        const values = p.slotIds.map((_, index) => ((revision + index) % 2 === 0 ? 'yes' : 'no'))
        const result = await ballot(M, p, token, values, revision, second).then(
          (own) => {
            revision = own.ballotRevision
            return 'ok'
          },
          (error: { code?: string; message?: string }) => error.code ?? String(error.message),
        )
        outcomes.push(result)
        if (result !== 'ok') return
        await Promise.race([sleep(CHURN_INTERVAL_MS), stopping.promise])
      }
    })()
    return {
      outcomes,
      /** Waits until the voter has replaced their ballot `count` more times. */
      async replaced(count: number) {
        const target = outcomes.filter((entry) => entry === 'ok').length + count
        for (let attempt = 0; attempt < 400; attempt++) {
          if (outcomes.filter((entry) => entry === 'ok').length >= target) return true
          if (outcomes.some((entry) => entry !== 'ok')) return false
          await sleep(25)
        }
        return false
      },
      async stop() {
        stopped = true
        stopping.resolve()
        await ended
        return outcomes
      },
    }
  }

  /** Every churned ballot was accepted; only `terminal` may end the churn. */
  function expectChurn(outcomes: string[], terminal?: string) {
    const last = outcomes.at(-1)
    const accepted = terminal !== undefined && last === terminal ? outcomes.slice(0, -1) : outcomes
    expect(accepted.length).toBeGreaterThan(0)
    expect(
      accepted.every((entry) => entry === 'ok'),
      outcomes.join(','),
    ).toBe(true)
  }

  // --- Checks shared by the real modules and their mutated source copies ------------------

  /**
   * The results projection on a fixture with counted, replaced, withdrawn, reactivated,
   * silent, confirmed, pending, expired and removed voters: separate counts of counted
   * ballots only, the roster with each ballot, both revisions, and no secret material.
   */
  async function verifyResults(M: Modules) {
    const p = await open('public_link', 3)
    const tokens: string[] = []
    const first = await invitee(M, p, 'first@example.com')
    await succeeds(() => ballot(M, p, first, ['yes', 'if_need_be', 'no'], 0))
    const pub1 = await publicVoter(M, p, 'public@example.com', '192.0.2.21')
    await succeeds(() => ballot(M, p, pub1, ['yes', 'yes', 'if_need_be'], 0))
    const replaced = await invitee(M, p, 'replaced@example.com')
    await succeeds(() => ballot(M, p, replaced, ['no', 'no', 'no'], 0))
    await succeeds(() => ballot(M, p, replaced, ['if_need_be', 'no', 'yes'], 1))
    const left = await invitee(M, p, 'withdrawn@example.com')
    await succeeds(() => ballot(M, p, left, ['yes', 'yes', 'yes'], 0))
    await succeeds(() => withdraw(M, p, left, 1))
    const back = await invitee(M, p, 'reactivated@example.com')
    await succeeds(() => ballot(M, p, back, ['no', 'yes', 'yes'], 0))
    await succeeds(() => withdraw(M, p, back, 1))
    await succeeds(() => ballot(M, p, back, ['yes', 'no', 'if_need_be'], 2))
    tokens.push(first, pub1, replaced, left, back, await invitee(M, p, 'silent@example.com'))
    const confirmed = await invitee(M, p, 'confirmed@example.com')
    await succeeds(() => M.V.verifyMeetingPollVoter(pub(undefined, p.db), { token: confirmed }))
    const gone = await invitee(M, p, 'removed@example.com')
    await succeeds(() => ballot(M, p, gone, ['yes', 'yes', 'yes'], 0))
    await succeeds(async () => remove(M, p, (await voter(p, 'removed@example.com')).id))
    await succeeds(() => enroll(M, p, 'unverified@example.com', '192.0.2.22'))
    await succeeds(() => removeUnverified(M, p))
    await succeeds(() => enroll(M, p, 'pending@example.com', '192.0.2.23'))
    const pendingToken = (await mailed(p, 'pending@example.com')).token
    await succeeds(() => enroll(M, p, 'expired@example.com', '192.0.2.24'))
    await expirePending(p, 'expired@example.com')
    tokens.push(confirmed, gone, pendingToken)
    // Another poll's voters, ballots and live reservations never leak into these results.
    const foreign = await open('public_link', 3)
    await succeeds(() => enroll(M, foreign, 'foreign-pending@example.com', '192.0.2.25'))
    const stranger = await invitee(M, foreign, 'foreign-voter@example.com')
    await succeeds(() => ballot(M, foreign, stranger, ['no', 'no', 'no'], 0))
    // Nor do those of another poll on the same event that the same admin manages.
    const sibling = await pollIn(p, 'public_link', 3)
    await succeeds(() => enroll(M, sibling, 'sibling-pending@example.com', '192.0.2.26'))
    const cousin = await invitee(M, sibling, 'sibling-voter@example.com')
    await succeeds(() => ballot(M, sibling, cousin, ['no', 'no', 'no'], 0))

    // Every stored digest of this poll's voters and credentials, removed and expired ones
    // included: none may reach the host in any encoding.
    const digests = [
      ...(
        await p.db
          .selectFrom('meeting_poll_voters')
          .select(['email_key', 'admission_ip_digest'])
          .where('poll_id', '=', p.pollId)
          .execute()
      ).flatMap((row) => [row.email_key, row.admission_ip_digest]),
      ...(
        await p.db
          .selectFrom('meeting_poll_mailbox_counters')
          .select('email_key')
          .where('poll_id', '=', p.pollId)
          .execute()
      ).map((row) => row.email_key),
      ...(
        await p.db
          .selectFrom('meeting_poll_capabilities')
          .select('token_digest')
          .where('poll_id', '=', p.pollId)
          .execute()
      ).map((row) => row.token_digest),
    ].filter((digest): digest is Buffer => digest !== null)
    // Non-vacuous: the live and the expired reservation still hold their IP digests.
    const ipDigests = (
      await p.db
        .selectFrom('meeting_poll_voters')
        .select('admission_ip_digest')
        .where('poll_id', '=', p.pollId)
        .where('admission_ip_digest', 'is not', null)
        .execute()
    ).length
    expect(ipDigests).toBe(2)
    const before = await tables(p)
    const read = await succeeds(() => results(M, p))
    // A read writes nothing.
    expect(await tables(p)).toEqual(before)
    const stored = await revisions(p)
    expect(read.resultsRevision).toBe(stored.results_revision)
    expect(read.poll.hostRevision).toBe(stored.host_revision)
    expect(read.countedBallots).toBe(4)
    expect(
      read.candidates.map(({ id, position, yes, ifNeedBe, no }) => ({
        id,
        position,
        yes,
        ifNeedBe,
        no,
      })),
    ).toEqual([
      { id: p.slotIds[0], position: 0, yes: 3, ifNeedBe: 1, no: 0 },
      { id: p.slotIds[1], position: 1, yes: 1, ifNeedBe: 1, no: 2 },
      { id: p.slotIds[2], position: 2, yes: 1, ifNeedBe: 2, no: 1 },
    ])
    expect(read.candidates.map(({ startAt, endAt }) => ({ startAt, endAt }))).toEqual(
      read.poll.candidates.map(({ startAt, endAt }) => ({ startAt, endAt })),
    )
    const entry = (email: string) => read.roster.find((row) => row.email === email)
    expect(read.roster.map((row) => [row.email, row.status, row.ballotRevision])).toEqual([
      ['first@example.com', 'verified', 1],
      ['public@example.com', 'verified', 1],
      ['replaced@example.com', 'verified', 2],
      ['withdrawn@example.com', 'withdrawn', 2],
      ['reactivated@example.com', 'verified', 3],
      ['silent@example.com', 'invited', 0],
      ['confirmed@example.com', 'verified', 0],
      ['pending@example.com', 'pending', 0],
    ])
    expect(entry('first@example.com')?.votes).toEqual(votes(p, ['yes', 'if_need_be', 'no']))
    expect(entry('public@example.com')?.votes).toEqual(votes(p, ['yes', 'yes', 'if_need_be']))
    expect(entry('replaced@example.com')?.votes).toEqual(votes(p, ['if_need_be', 'no', 'yes']))
    expect(entry('reactivated@example.com')?.votes).toEqual(votes(p, ['yes', 'no', 'if_need_be']))
    for (const email of [
      'withdrawn@example.com',
      'silent@example.com',
      'confirmed@example.com',
      'pending@example.com',
    ]) {
      // A missing ballot is shown as missing, never as `no`.
      expect(entry(email)).toMatchObject({ votes: [], submittedAt: null, consentedAt: null })
    }
    const public1 = await voter(p, 'public@example.com')
    expect(entry('public@example.com')).toEqual({
      voterId: public1.id,
      name: 'Public Voter',
      email: 'public@example.com',
      status: 'verified',
      timeZone: 'Europe/Berlin',
      locale: 'en',
      invitedAt: null,
      verifiedAt: expect.any(String),
      withdrawnAt: null,
      pendingExpiresAt: null,
      ballotRevision: 1,
      submittedAt: expect.any(String),
      consentedAt: expect.any(String),
      votes: votes(p, ['yes', 'yes', 'if_need_be']),
      responses: {},
    })
    expect(
      Temporal.Instant.from(entry('public@example.com')?.verifiedAt as string).epochMilliseconds,
    ).toBe((public1.verified_at as Date).getTime())
    expect(entry('first@example.com')?.invitedAt).not.toBeNull()
    expect(entry('withdrawn@example.com')?.withdrawnAt).not.toBeNull()
    expect(entry('pending@example.com')?.pendingExpiresAt).not.toBeNull()
    expect(entry('pending@example.com')?.verifiedAt).toBeNull()
    // No credential, digest or IP digest reaches the host.
    const text = JSON.stringify(read)
    for (const token of tokens) expect(text).not.toContain(token)
    for (const field of ['email_key', 'admission_ip_digest', 'capability', 'token', 'digest'])
      expect(text).not.toContain(field)
    expect(text).not.toContain(
      Voters.meetingPollMailboxKey(SECRET, p.pollId, 'first@example.com').toString('hex'),
    )
    // Exactly the documented fields, for every roster entry and at the top level.
    expect(Object.keys(read).sort(), 'results fields').toEqual([
      'candidates',
      'countedBallots',
      'poll',
      'resultsRevision',
      'roster',
    ])
    for (const candidate of read.candidates)
      expect(Object.keys(candidate).sort(), 'candidate fields').toEqual([
        'endAt',
        'id',
        'ifNeedBe',
        'no',
        'position',
        'startAt',
        'yes',
      ])
    for (const row of read.roster)
      expect(Object.keys(row).sort(), `roster entry fields of ${row.email}`).toEqual(ROSTER_FIELDS)
    for (const digest of digests)
      for (const encoding of ['hex', 'base64', 'base64url'] as const)
        expect(text, `results reveal an encoded digest (${encoding})`).not.toContain(
          digest.toString(encoding),
        )

    // A ballot changes the results revision and the counts; the host revision stays.
    await succeeds(() => ballot(M, p, first, ['no', 'no', 'no'], 1))
    const later = await succeeds(() => results(M, p))
    expect(later.resultsRevision).toBe(read.resultsRevision + 1)
    expect(later.poll.hostRevision).toBe(read.poll.hostRevision)
    expect(later.candidates.map(({ yes, ifNeedBe, no }) => [yes, ifNeedBe, no])).toEqual([
      [2, 1, 1],
      [1, 0, 3],
      [1, 2, 1],
    ])
    // Results stay readable once voting closes.
    await succeeds(() =>
      M.P.closeMeetingPoll(p.ctx, { id: p.pollId, expectedHostRevision: later.poll.hostRevision }),
    )
    const closed = await succeeds(() => results(M, p))
    expect(closed.poll.status).toBe('closed')
    expect(closed.candidates).toEqual(later.candidates)
  }

  /**
   * A results read that arrives while a ballot holds the poll waits for it, then reports that
   * ballot under the revision it produced: counts and revision never come from two states.
   */
  async function verifyResultsConsistency(M: Modules) {
    const p = await open('invited')
    const token = await invitee(M, p, 'steady@example.com')
    await succeeds(() => ballot(M, p, token, ['yes', 'yes'], 0))
    const before = await succeeds(() => results(M, p))
    const [replaced, read] = await contenderFirst(
      () => ballot(M, p, token, ['no', 'if_need_be'], 1, second),
      [() => results(M, p)],
    )
    expect(outcome(replaced)).toBe('fulfilled')
    expect(outcome(read)).toBe('fulfilled')
    const seen = (read as PromiseFulfilledResult<Results.MeetingPollResults>).value
    expect(seen.resultsRevision).toBe(before.resultsRevision + 1)
    expect(seen.candidates.map(({ yes, ifNeedBe, no }) => [yes, ifNeedBe, no])).toEqual([
      [0, 0, 1],
      [0, 1, 0],
    ])
    expect(seen.roster).toMatchObject([{ email: 'steady@example.com', ballotRevision: 2 }])
  }

  /** Managers read results, read keys included; nobody else, and unrelated IDs stay opaque. */
  async function verifyResultsAuthority(M: Modules) {
    const p = await open()
    const other = await open()
    const reader = await apiKeyContext(p, 'read')
    expect((await succeeds(() => M.R.getMeetingPollResults(reader, p.pollId))).poll.id).toBe(
      p.pollId,
    )
    expect(await failure(() => M.R.getMeetingPollResults(p.memberCtx, p.pollId))).toMatchObject({
      code: 'team_management_access_denied',
    })
    for (const id of [other.pollId, randomUUID(), 'not-a-poll'])
      expect(await failure(() => M.R.getMeetingPollResults(p.ctx, id))).toMatchObject({
        code: 'poll_not_found',
      })
  }

  /**
   * Removal deletes exactly the voter's rows (votes, credentials and mail included), sends no
   * mail, keeps only the mailbox counter row, marked removed with every count and the
   * opt-out intact, and advances the host and results revisions once.
   */
  async function verifyRemoval(M: Modules) {
    const p = await open()
    const token = await invitee(M, p, 'target@example.com')
    await succeeds(() => resend(M, p, 'target@example.com'))
    const current = (await mailed(p, 'target@example.com')).token
    expect(current).not.toBe(token)
    await succeeds(() => ballot(M, p, current, ['yes', 'no'], 0))
    await succeeds(() => recover(M, p, 'target@example.com'))
    const target = await voter(p, 'target@example.com')
    const optOutToken = await optOutCredential(p, target.id)
    await succeeds(() => optOut(M, p, optOutToken))
    await queueReminder(p, target.id)
    await sql`UPDATE meeting_poll_mailbox_counters SET reminder_consumed_at = clock_timestamp()
      WHERE poll_id = ${p.pollId} AND email_key = ${target.email_key}`.execute(p.db)
    const other = await publicVoter(M, p, 'other@example.com', '192.0.2.40')
    await succeeds(() => ballot(M, p, other, ['no', 'yes'], 0))
    await succeeds(() => enroll(M, p, 'pending@example.com', '192.0.2.41'))
    const kept = await counter(p, 'target@example.com')
    expect(kept).toMatchObject({ resend_count: 1, recovery_count: 1, removed_at: null })
    expect(kept.reminder_opted_out_at).not.toBeNull()
    expect(kept.reminder_consumed_at).not.toBeNull()
    const placesBefore = await places(p)
    const before = await tables(p)
    const seen = await revisions(p)

    const removed = await succeeds(() => remove(M, p, target.id, seen.host_revision))
    expect(removed.removedVoterIds).toEqual([target.id])
    expect(removed.poll.hostRevision).toBe(seen.host_revision + 1)
    expect(removed.resultsRevision).toBe(seen.results_revision + 1)
    expect(await revisions(p)).toMatchObject({
      host_revision: seen.host_revision + 1,
      results_revision: seen.results_revision + 1,
    })
    expect(await places(p)).toBe(placesBefore - 1)

    // Every table: exactly the voter's rows are gone; only its counter row outlives it.
    const after = await tables(p)
    const at = (after.meeting_polls[0] as Row).updated_at
    const ofTarget = (row: Row) => row.voter_id === target.id || row.id === target.id
    expect(after.meeting_poll_voters).toEqual(
      before.meeting_poll_voters.filter((r) => !ofTarget(r)),
    )
    for (const table of [
      'meeting_poll_votes',
      'meeting_poll_capabilities',
      'meeting_poll_deliveries',
    ] as const) {
      expect(before[table].some(ofTarget), table).toBe(true)
      expect(after[table], table).toEqual(before[table].filter((row) => !ofTarget(row)))
    }
    expect(after.meeting_poll_slots).toEqual(before.meeting_poll_slots)
    expect(after.meeting_poll_operations).toEqual(before.meeting_poll_operations)
    const key = (before.meeting_poll_voters.find((row) => row.id === target.id) as Row).email_key
    expect(after.meeting_poll_mailbox_counters).toEqual(
      before.meeting_poll_mailbox_counters.map((row) =>
        row.email_key === key ? { ...row, removed_at: at, updated_at: at } : row,
      ),
    )
    expect(after.meeting_polls).toEqual([
      {
        ...before.meeting_polls[0],
        host_revision: seen.host_revision + 1,
        results_revision: seen.results_revision + 1,
        updated_at: at,
      },
    ])

    // The removed voter's credentials name no one; the mailbox cannot rejoin by itself.
    for (const attempt of [
      () => ballot(M, p, current, ['no', 'no'], 1),
      () => withdraw(M, p, current, 1),
      () => M.V.verifyMeetingPollVoter(pub(undefined, p.db), { token: current }),
      () => optOut(M, p, optOutToken),
    ])
      expect(await failure(attempt)).toMatchObject({ code: 'poll_not_found' })
    await succeeds(() => recover(M, p, 'target@example.com'))
    await succeeds(() => enroll(M, p, 'target@example.com', '192.0.2.42'))
    expect(await tables(p)).toEqual(after)

    // A retry after a lost response finds no voter, before the revision check.
    expect(await failure(() => remove(M, p, target.id, seen.host_revision))).toMatchObject({
      code: 'poll_not_found',
    })
    // A stale host revision refuses a live voter's removal and writes nothing.
    const otherRow = await voter(p, 'other@example.com')
    expect(await failure(() => remove(M, p, otherRow.id, seen.host_revision))).toMatchObject({
      code: 'poll_changed',
    })
    for (const id of [randomUUID(), 'not-a-voter'])
      expect(await failure(() => remove(M, p, id))).toMatchObject({ code: 'poll_not_found' })
    // A voter of another poll the same admin manages is not this poll's voter.
    const sibling = await pollIn(p)
    await succeeds(() => enroll(M, sibling, 'sibling@example.com', '192.0.2.43'))
    const siblingRows = await tables(sibling)
    const cousin = await voter(sibling, 'sibling@example.com')
    expect(await failure(() => remove(M, p, cousin.id))).toMatchObject({ code: 'poll_not_found' })
    expect(await tables(sibling)).toEqual(siblingRows)
    expect(await tables(p)).toEqual(after)

    // A live public reservation is removable too: its place and IP allowance are freed.
    const pending = await voter(p, 'pending@example.com')
    await succeeds(() => remove(M, p, pending.id))
    expect(await voterCount(p, 'pending@example.com')).toBe(0)
    expect(await counter(p, 'pending@example.com')).toMatchObject({ removed_at: expect.any(Date) })
    expect(await places(p)).toBe(placesBefore - 2)
  }

  /**
   * Removal while open or closed (by the host or the deadline); refused on canceled and
   * scheduled polls, for read keys and members, and for an expired reservation, which is
   * already gone for the host. Refusals write nothing.
   */
  async function verifyRemovalRules(M: Modules) {
    const p = await open()
    await succeeds(() => publicVoter(M, p, 'closed@example.com', '192.0.2.50'))
    await succeeds(() => enroll(M, p, 'expired@example.com', '192.0.2.51'))
    await expirePending(p, 'expired@example.com')
    await succeeds(() => enroll(M, p, 'reader@example.com', '192.0.2.52'))
    const reader = await apiKeyContext(p, 'read')
    const expired = await voter(p, 'expired@example.com')
    const live = await voter(p, 'reader@example.com')
    const before = await tables(p)
    const host = (await revisions(p)).host_revision
    expect(await failure(() => remove(M, p, expired.id))).toMatchObject({ code: 'poll_not_found' })
    for (const ctx of [reader, p.memberCtx]) {
      const scoped = { ...p, ctx }
      expect(await failure(() => remove(M, scoped, live.id, host))).toMatchObject(
        ctx === reader ? { name: 'ApiKeyScopeError' } : { code: 'team_management_access_denied' },
      )
      expect(await failure(() => removeUnverified(M, scoped, host))).toMatchObject(
        ctx === reader ? { name: 'ApiKeyScopeError' } : { code: 'team_management_access_denied' },
      )
    }
    expect(await tables(p)).toEqual(before)

    await succeeds(() => M.P.closeMeetingPoll(p.ctx, { id: p.pollId, expectedHostRevision: host }))
    await succeeds(async () => remove(M, p, (await voter(p, 'closed@example.com')).id))
    expect((await succeeds(() => removeUnverified(M, p))).removedVoterIds).toEqual([live.id])

    const late = await open()
    await succeeds(() => publicVoter(M, late, 'late@example.com', '192.0.2.53'))
    await pastDeadline(late)
    await succeeds(async () => remove(M, late, (await voter(late, 'late@example.com')).id))

    // A soft-deleted event keeps its poll history: results stay readable and removal works.
    const retired = await open()
    await succeeds(() => publicVoter(M, retired, 'retired@example.com', '192.0.2.56'))
    await sql`UPDATE event_types SET deleted_at = clock_timestamp()
      WHERE id = ${retired.eventTypeId}`.execute(retired.db)
    expect((await succeeds(() => results(M, retired))).roster).toHaveLength(1)
    await succeeds(async () => remove(M, retired, (await voter(retired, 'retired@example.com')).id))
    expect(await voterCount(retired, 'retired@example.com')).toBe(0)

    const canceled = await open()
    await succeeds(() => publicVoter(M, canceled, 'canceled@example.com', '192.0.2.54'))
    await succeeds(async () =>
      M.P.cancelMeetingPoll(canceled.ctx, {
        id: canceled.pollId,
        expectedHostRevision: (await revisions(canceled)).host_revision,
      }),
    )
    const booked = await open()
    await succeeds(() => publicVoter(M, booked, 'booked@example.com', '192.0.2.55'))
    await scheduled(booked)
    for (const [poll, code] of [
      [canceled, 'poll_canceled'],
      [booked, 'poll_already_scheduled'],
    ] as const) {
      const frozen = await tables(poll)
      const row = await voter(
        poll,
        `${code === 'poll_canceled' ? 'canceled' : 'booked'}@example.com`,
      )
      expect(await failure(() => remove(M, poll, row.id))).toMatchObject({ code })
      expect(await failure(() => removeUnverified(M, poll))).toMatchObject({ code })
      expect(await tables(poll)).toEqual(frozen)
    }
  }

  /**
   * Bulk removal takes exactly the live unverified public reservations: never host invitees
   * (verified or not), verified or withdrawn voters, or expired reservations. Each removed
   * mailbox keeps a tombstoned counter; nothing to remove writes nothing.
   */
  async function verifyBulkRemoval(M: Modules) {
    const p = await open()
    await succeeds(() => enroll(M, p, 'p1@example.com', '192.0.2.60'))
    await succeeds(() => enroll(M, p, 'p2@example.com', '192.0.2.61'))
    await succeeds(() => enroll(M, p, 'expired@example.com', '192.0.2.62'))
    await expirePending(p, 'expired@example.com')
    const verified = await publicVoter(M, p, 'verified@example.com', '192.0.2.63')
    await succeeds(() => ballot(M, p, verified, ['yes', 'no'], 0))
    await succeeds(() => invite(M, p, ['unconfirmed@example.com']))
    const confirmed = await invitee(M, p, 'confirmed@example.com')
    await succeeds(() => ballot(M, p, confirmed, ['no', 'yes'], 0))
    const leaver = await invitee(M, p, 'leaver@example.com')
    await succeeds(() => withdraw(M, p, leaver, 0))
    const leaverPublic = await publicVoter(M, p, 'public-leaver@example.com', '192.0.2.64')
    await succeeds(() => withdraw(M, p, leaverPublic, 0))
    await succeeds(() => enroll(M, p, 'upgraded@example.com', '192.0.2.65'))
    await succeeds(() => invite(M, p, ['upgraded@example.com']))
    const pending = await voterIds(p, ['p1@example.com', 'p2@example.com'])
    const before = await tables(p)
    const seen = await revisions(p)

    expect(await failure(() => removeUnverified(M, p, seen.host_revision - 1))).toMatchObject({
      code: 'poll_changed',
    })
    expect(await tables(p)).toEqual(before)

    const removed = await succeeds(() => removeUnverified(M, p, seen.host_revision))
    expect(removed.removedVoterIds).toEqual(pending)
    expect(removed.poll.hostRevision).toBe(seen.host_revision + 1)
    expect(removed.resultsRevision).toBe(seen.results_revision + 1)
    const after = await tables(p)
    const at = (after.meeting_polls[0] as Row).updated_at
    const gone = (row: Row) =>
      pending.includes(row.id as string) || pending.includes(row.voter_id as string)
    for (const table of [
      'meeting_poll_voters',
      'meeting_poll_votes',
      'meeting_poll_capabilities',
      'meeting_poll_deliveries',
    ] as const)
      expect(after[table], table).toEqual(before[table].filter((row) => !gone(row)))
    const keys = before.meeting_poll_voters
      .filter((row) => pending.includes(row.id as string))
      .map((row) => row.email_key)
    expect(keys).toHaveLength(2)
    expect(after.meeting_poll_mailbox_counters).toEqual(
      before.meeting_poll_mailbox_counters.map((row) =>
        keys.includes(row.email_key) ? { ...row, removed_at: at, updated_at: at } : row,
      ),
    )
    // The removed mailboxes cannot enroll again; their IP allowance is free for others.
    await succeeds(() => enroll(M, p, 'p1@example.com', '192.0.2.60'))
    expect(await voterCount(p, 'p1@example.com')).toBe(0)
    await succeeds(() => enroll(M, p, 'fresh@example.com', '192.0.2.60'))
    expect(await voterCount(p, 'fresh@example.com')).toBe(1)

    // Nothing left to remove but the newcomer; then nothing at all, which writes nothing.
    expect((await succeeds(() => removeUnverified(M, p))).removedVoterIds).toHaveLength(1)
    const settled = await tables(p)
    const idle = await succeeds(() => removeUnverified(M, p))
    expect(idle.removedVoterIds).toEqual([])
    expect(await tables(p)).toEqual(settled)

    const invited = await open('invited')
    await succeeds(() => invite(M, invited, ['only@example.com']))
    const quiet = await tables(invited)
    expect((await succeeds(() => removeUnverified(M, invited))).removedVoterIds).toEqual([])
    expect(await tables(invited)).toEqual(quiet)
  }

  /**
   * Removal blocks rejoining; only a host invitation re-admits the mailbox, as a new voter
   * with one invitation mail and a new place. Opt-outs, reminder receipts and resend budgets
   * (count and cooldown) survive removal and re-invitation; the recovery count restarts
   * only because the re-invitation mails a new credential.
   */
  async function verifyReinvitation(M: Modules) {
    const p = await open()
    const first = await invitee(M, p, 'again@example.com')
    await succeeds(() => ballot(M, p, first, ['yes', 'yes'], 0))
    await succeeds(() => resend(M, p, 'again@example.com'))
    await succeeds(() => recover(M, p, 'again@example.com'))
    const old = await voter(p, 'again@example.com')
    const optOutToken = await optOutCredential(p, old.id)
    await succeeds(() => optOut(M, p, optOutToken))
    await sql`UPDATE meeting_poll_mailbox_counters SET reminder_consumed_at = clock_timestamp()
      WHERE poll_id = ${p.pollId} AND email_key = ${old.email_key}`.execute(p.db)
    const original = await counter(p, 'again@example.com')
    expect(original).toMatchObject({ resend_count: 1, recovery_count: 1 })
    expect(original.reminder_opted_out_at).not.toBeNull()
    const mailbox = (await mailed(p, 'again@example.com')).token

    await succeeds(() => remove(M, p, old.id))
    const tombstone = await counter(p, 'again@example.com')
    expect(tombstone).toEqual({
      ...original,
      removed_at: expect.any(Date),
      updated_at: expect.any(Date),
    })
    // The tombstone blocks self-enrollment and recovery; old links name no one.
    const blocked = await tables(p)
    await succeeds(() => enroll(M, p, 'again@example.com', '192.0.2.70'))
    await succeeds(() => recover(M, p, 'again@example.com'))
    expect(await failure(() => ballot(M, p, mailbox, ['no', 'no'], 1))).toMatchObject({
      code: 'poll_not_found',
    })
    expect(await tables(p)).toEqual(blocked)

    // A re-invitation mails the removed mailbox again, so it follows the resend budget: the
    // resend a moment ago is still cooling down, and the whole request writes nothing.
    const placesBefore = await places(p)
    const early = await failure(() => invite(M, p, ['again@example.com']))
    expect(early).toMatchObject({ code: 'rate_limited' })
    expect(early.retryAfterSeconds).toBeGreaterThan(800)
    expect(early.retryAfterSeconds).toBeLessThanOrEqual(900)
    expect(await tables(p)).toEqual(blocked)
    // The same refusal holds a fresh mailbox in the same batch back: all or nothing.
    expect(
      await failure(() => invite(M, p, ['again@example.com', 'bystander@example.com'])),
    ).toMatchObject({ code: 'rate_limited', retryAfterSeconds: early.retryAfterSeconds })
    expect(await tables(p)).toEqual(blocked)
    await sql`UPDATE meeting_poll_mailbox_counters
      SET last_resend_at = last_resend_at - interval '16 minutes'
      WHERE poll_id = ${p.pollId} AND email_key = ${old.email_key}`.execute(p.db)
    const cooled = await counter(p, 'again@example.com')

    const again = await succeeds(() => invite(M, p, ['again@example.com']))
    expect(again.entries).toMatchObject([{ outcome: 'invited', status: 'invited' }])
    const fresh = await voter(p, 'again@example.com')
    expect(fresh.id).not.toBe(old.id)
    expect(fresh.verified_at).toBeNull()
    expect(await places(p)).toBe(placesBefore + 1)
    expect((await deliveries(p, fresh.id)).map((row) => [row.kind, row.state])).toEqual([
      ['invitation', 'pending'],
    ])
    const spentOne = await counter(p, 'again@example.com')
    expect(spentOne).toEqual({
      ...cooled,
      // The re-invitation spent a resend at its decision instant.
      resend_count: 2,
      last_resend_at: spentOne.updated_at,
      // A new credential was mailed, so recovery starts again for it.
      recovery_count: 0,
      last_recovery_at: null,
      removed_at: null,
      updated_at: expect.any(Date),
    })
    const decided = await p.db
      .selectFrom('meeting_polls')
      .select('updated_at')
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
    expect(spentOne.updated_at).toEqual(decided.updated_at)
    // Its cooldown started again: the re-invited mailbox cannot be resent at once.
    const cooling = await failure(() => resend(M, p, 'again@example.com'))
    expect(cooling).toMatchObject({ code: 'rate_limited' })
    expect(cooling.retryAfterSeconds).toBeGreaterThan(800)
    const renewed = (await mailed(p, 'again@example.com')).token
    await succeeds(() => ballot(M, p, renewed, ['no', 'yes'], 0))

    // A spent resend budget stays spent across removal: no re-invitation, no Retry-After,
    // and the batch, fresh mailbox included, writes nothing.
    await succeeds(() => invite(M, p, ['spent@example.com']))
    const spent = await voter(p, 'spent@example.com')
    await sql`UPDATE meeting_poll_mailbox_counters SET resend_count = 3,
      last_resend_at = clock_timestamp() - interval '1 hour'
      WHERE poll_id = ${p.pollId} AND email_key = ${spent.email_key}`.execute(p.db)
    await succeeds(() => remove(M, p, spent.id))
    for (const batch of [
      ['spent@example.com'],
      ['bystander@example.com', 'spent@example.com'],
      // A capped mailbox gives no Retry-After even beside one that is only cooling down.
      ['spent@example.com', 'again@example.com'],
    ]) {
      if (batch.includes('again@example.com'))
        await succeeds(async () => remove(M, p, (await voter(p, 'again@example.com')).id))
      const before = await tables(p)
      expect(await failure(() => invite(M, p, batch)), batch.join()).toMatchObject({
        code: 'rate_limited',
        retryAfterSeconds: undefined,
      })
      expect(await tables(p)).toEqual(before)
    }
    expect(await voterCount(p, 'bystander@example.com')).toBe(0)
    expect(await counter(p, 'spent@example.com')).toMatchObject({
      resend_count: 3,
      removed_at: expect.any(Date),
    })

    // A withdrawn voter: re-invitation leaves them unchanged, but removal and re-invitation
    // deliberately send one invitation; the reminder opt-out still applies.
    const quitter = await invitee(M, p, 'quitter@example.com')
    await succeeds(() => withdraw(M, p, quitter, 0))
    const withdrawn = await voter(p, 'quitter@example.com')
    await succeeds(async () => optOut(M, p, await optOutCredential(p, withdrawn.id)))
    const optedOut = (await counter(p, 'quitter@example.com')).reminder_opted_out_at
    expect(optedOut).not.toBeNull()
    const unchanged = await succeeds(() => invite(M, p, ['quitter@example.com']))
    expect(unchanged.entries).toMatchObject([{ outcome: 'unchanged', status: 'withdrawn' }])
    await succeeds(() => remove(M, p, withdrawn.id))
    const reinvited = await succeeds(() => invite(M, p, ['quitter@example.com']))
    expect(reinvited.entries).toMatchObject([{ outcome: 'invited', status: 'invited' }])
    const back = await voter(p, 'quitter@example.com')
    expect((await deliveries(p, back.id)).map((row) => row.kind)).toEqual(['invitation'])
    expect((await counter(p, 'quitter@example.com')).reminder_opted_out_at).toEqual(optedOut)
  }

  /** A full poll frees a place on removal; the removed mailbox takes one again on re-invitation. */
  async function verifyRemovalCapacity(M: Modules) {
    const p = await open()
    const emails = Array.from({ length: 40 }, (_, index) => `seat-${index}@example.com`)
    await succeeds(() => invite(M, p, emails))
    expect(await failure(() => enroll(M, p, 'late@example.com', '192.0.2.80'))).toMatchObject({
      code: 'poll_full',
    })
    await succeeds(async () => remove(M, p, (await voter(p, 'seat-0@example.com')).id))
    expect(await places(p)).toBe(39)
    await succeeds(() => invite(M, p, ['seat-0@example.com']))
    expect(await places(p)).toBe(40)
    expect(await failure(() => invite(M, p, ['late@example.com']))).toMatchObject({
      code: 'poll_full',
    })
  }

  /** Results, removal and bulk removal refuse a mismatched secret and write nothing. */
  async function verifyKeyFence(M: Modules) {
    const p = await open()
    await succeeds(() => enroll(M, p, 'keyed@example.com', '192.0.2.90'))
    const target = await voter(p, 'keyed@example.com')
    const before = await tables(p)
    const host = (await revisions(p)).host_revision
    const mismatched = { ...p.ctx, meetingPollSecret: OTHER }
    for (const attempt of [
      () => M.R.getMeetingPollResults(mismatched, p.pollId),
      () =>
        M.R.removeMeetingPollVoter(mismatched, {
          id: p.pollId,
          voterId: target.id,
          expectedHostRevision: host,
        }),
      () =>
        M.R.removeUnverifiedMeetingPollVoters(mismatched, {
          id: p.pollId,
          expectedHostRevision: host,
        }),
    ])
      expect(await failure(attempt)).toMatchObject(MISMATCH)
    expect(await tables(p)).toEqual(before)
  }

  /**
   * On an installation of its own: once every voter is removed only mailbox counters remain,
   * and they still hold the key, tombstone or not. Without them another secret is recorded.
   */
  async function verifyKeyLeftovers(M: Modules) {
    const scratch = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'poll_result_key',
    })
    const kdb = createDb(scratch.pool)
    try {
      const p = await open('public_link', 2, kdb)
      await succeeds(() => enroll(M, p, 'pending@example.com', '192.0.2.95'))
      await succeeds(() => publicVoter(M, p, 'public@example.com', '192.0.2.96'))
      const token = await invitee(M, p, 'invitee@example.com')
      await succeeds(() => ballot(M, p, token, ['yes', 'no'], 0))
      await succeeds(() => removeUnverified(M, p))
      for (const email of ['public@example.com', 'invitee@example.com'])
        await succeeds(async () => remove(M, p, (await voter(p, email)).id))
      const counts = await sql<{ voters: string; counters: string; tombstones: string }>`SELECT
        (SELECT count(*) FROM meeting_poll_voters)::text AS voters,
        (SELECT count(*) FROM meeting_poll_mailbox_counters)::text AS counters,
        (SELECT count(*) FROM meeting_poll_mailbox_counters WHERE removed_at IS NOT NULL)::text
          AS tombstones`.execute(kdb)
      expect(counts.rows[0]).toEqual({ voters: '0', counters: '3', tombstones: '3' })
      const start = (secret: string) =>
        kdb.transaction().execute((trx) => M.K.ensureMeetingPollKey(trx, secret))
      const key = await kdb.selectFrom('meeting_poll_key_state').selectAll().execute()
      expect(await failure(() => start(OTHER))).toMatchObject(MISMATCH)
      // A counter without a tombstone is keyed data as well.
      await sql`UPDATE meeting_poll_mailbox_counters SET removed_at = NULL`.execute(kdb)
      expect(await failure(() => start(OTHER))).toMatchObject(MISMATCH)
      expect(await kdb.selectFrom('meeting_poll_key_state').selectAll().execute()).toEqual(key)
      // Only the counters held the key.
      await sql`DELETE FROM meeting_poll_mailbox_counters`.execute(kdb)
      await succeeds(() => start(OTHER))
    } finally {
      await scratch.drop()
    }
  }

  // --- Host operations against a voter replacing their ballot every second ---------------

  async function churnLifecycle(M: Modules, operation: 'close' | 'cancel') {
    for (let run = 0; run < RUNS; run++) {
      const p = await open('invited')
      const token = await invitee(M, p, `churner-${run}@example.com`)
      const voting = churn(M, p, token)
      let outcomes: string[]
      try {
        expect(await voting.replaced(1)).toBe(true)
        const seen = await succeeds(() => results(M, p))
        const input = { id: p.pollId, expectedHostRevision: seen.poll.hostRevision }
        const [hostOutcome] = await contenderFirst(undefined, [
          () =>
            operation === 'close'
              ? M.P.closeMeetingPoll(p.ctx, input)
              : M.P.cancelMeetingPoll(p.ctx, input),
        ])
        expect(outcome(hostOutcome)).toBe('fulfilled')
        const after = await revisions(p)
        expect(after.status).toBe(operation === 'close' ? 'closed' : 'canceled')
        expect(after.host_revision).toBe(seen.poll.hostRevision + 1)
        // The paused ballot committed after the host read its revision.
        expect(after.results_revision).toBeGreaterThan(seen.resultsRevision)
      } finally {
        outcomes = await voting.stop()
      }
      expectChurn(outcomes, operation === 'close' ? 'poll_closed' : 'poll_canceled')
    }
  }

  async function verifyChurnClose(M: Modules) {
    await churnLifecycle(M, 'close')
  }

  async function verifyChurnCancel(M: Modules) {
    await churnLifecycle(M, 'cancel')
  }

  async function verifyChurnRotate(M: Modules) {
    const p = await open('public_link')
    const voting = churn(M, p, await invitee(M, p, 'churner@example.com'))
    let outcomes: string[]
    try {
      for (let run = 0; run < RUNS; run++) {
        expect(await voting.replaced(1)).toBe(true)
        const seen = await succeeds(() => results(M, p))
        const [rotated] = await contenderFirst(undefined, [
          () =>
            M.P.rotateMeetingPollLink(p.ctx, {
              id: p.pollId,
              expectedHostRevision: seen.poll.hostRevision,
              idempotencyKey: randomUUID(),
            }),
        ])
        expect(outcome(rotated)).toBe('fulfilled')
        const after = await revisions(p)
        expect(after.host_revision).toBe(seen.poll.hostRevision + 1)
        expect(after.results_revision).toBeGreaterThan(seen.resultsRevision)
      }
    } finally {
      outcomes = await voting.stop()
    }
    expectChurn(outcomes)
  }

  /**
   * Remove other voters and the churning voter itself while their ballot is in flight: the
   * removal waits for the ballot, then removes, and the results revision moves for both.
   */
  async function verifyChurnRemoveVoter(M: Modules) {
    const p = await open('public_link')
    await succeeds(() => publicVoter(M, p, 'victim-0@example.com', '192.0.2.100'))
    await succeeds(() => publicVoter(M, p, 'victim-1@example.com', '192.0.2.101'))
    let voting = churn(M, p, await invitee(M, p, 'churner-0@example.com'))
    const outcomes: string[][] = []
    try {
      for (const target of ['victim-0', 'churner-0', 'victim-1']) {
        expect(await voting.replaced(1)).toBe(true)
        const seen = await succeeds(() => results(M, p))
        const voterId = (await voter(p, `${target}@example.com`)).id
        const [removal] = await contenderFirst(undefined, [
          () =>
            M.R.removeMeetingPollVoter(p.ctx, {
              id: p.pollId,
              voterId,
              expectedHostRevision: seen.poll.hostRevision,
            }),
        ])
        expect(outcome(removal)).toBe('fulfilled')
        expect(await voterCount(p, `${target}@example.com`)).toBe(0)
        const after = await revisions(p)
        expect(after.host_revision).toBe(seen.poll.hostRevision + 1)
        // The paused ballot and the removal each moved the results revision.
        expect(after.results_revision).toBeGreaterThanOrEqual(seen.resultsRevision + 2)
        if (target === 'churner-0') {
          const ended = await voting.stop()
          expectChurn(ended, 'poll_not_found')
          voting = churn(M, p, await invitee(M, p, 'churner-1@example.com'))
        }
      }
    } finally {
      outcomes.push(await voting.stop())
    }
    expectChurn(outcomes[0] as string[])
  }

  async function verifyChurnRemoveUnverified(M: Modules) {
    const p = await open('public_link')
    const voting = churn(M, p, await invitee(M, p, 'churner@example.com'))
    let outcomes: string[]
    try {
      for (let run = 0; run < RUNS; run++) {
        const emails = [`pending-${run}-a@example.com`, `pending-${run}-b@example.com`]
        for (const [index, email] of emails.entries())
          await succeeds(() => enroll(M, p, email, `198.51.100.${run * 2 + index + 1}`))
        const pending = await voterIds(p, emails)
        expect(await voting.replaced(1)).toBe(true)
        const seen = await succeeds(() => results(M, p))
        const [bulk] = await contenderFirst(undefined, [
          () =>
            M.R.removeUnverifiedMeetingPollVoters(p.ctx, {
              id: p.pollId,
              expectedHostRevision: seen.poll.hostRevision,
            }),
        ])
        expect(outcome(bulk)).toBe('fulfilled')
        expect(
          (bulk as PromiseFulfilledResult<Results.MeetingPollRemovalResult>).value.removedVoterIds,
        ).toEqual(pending)
        expect(await voterCount(p, 'churner@example.com')).toBe(1)
        const after = await revisions(p)
        expect(after.host_revision).toBe(seen.poll.hostRevision + 1)
        expect(after.results_revision).toBeGreaterThanOrEqual(seen.resultsRevision + 2)
      }
    } finally {
      outcomes = await voting.stop()
    }
    expectChurn(outcomes)
  }

  /**
   * A verification paused inside its transaction holds the poll; a bulk removal queued behind
   * it then sees a verified voter and keeps it. In the other order the removal wins and the
   * queued verification, ballot and enrollment find no voter and write nothing.
   */
  async function verifyRemovalRaces(M: Modules) {
    const p = await open()
    await succeeds(() => enroll(M, p, 'racer@example.com', '192.0.2.110'))
    await succeeds(() => enroll(M, p, 'idle@example.com', '192.0.2.111'))
    const { token } = await mailed(p, 'racer@example.com')
    const idle = await voter(p, 'idle@example.com')
    const host = (await revisions(p)).host_revision
    const [verified, bulk] = await contenderFirst(
      () => M.V.verifyMeetingPollVoter(pub('192.0.2.110', second), { token }),
      [() => removeUnverified(M, p, host)],
    )
    expect(outcome(verified)).toBe('fulfilled')
    expect(outcome(bulk)).toBe('fulfilled')
    expect(
      (bulk as PromiseFulfilledResult<Results.MeetingPollRemovalResult>).value.removedVoterIds,
    ).toEqual([idle.id])
    expect((await voter(p, 'racer@example.com')).verified_at).not.toBeNull()

    // The removal first, paused after its locks; the voter's own writes queue behind it.
    const target = await invitee(M, p, 'target@example.com')
    const row = await voter(p, 'target@example.com')
    const pausedHost = { ...p.ctx, db: second }
    const current = (await revisions(p)).host_revision
    const settled = await contenderFirst(
      () =>
        M.R.removeMeetingPollVoter(pausedHost, {
          id: p.pollId,
          voterId: row.id,
          expectedHostRevision: current,
        }),
      [
        () => ballot(M, p, target, ['yes', 'yes'], 0),
        () => M.V.verifyMeetingPollVoter(pub(undefined, p.db), { token: target }),
        () => enroll(M, p, 'target@example.com', '192.0.2.112'),
      ],
    )
    expect(settled.map(outcome)).toEqual([
      'fulfilled',
      { code: 'poll_not_found' },
      { code: 'poll_not_found' },
      'fulfilled',
    ])
    expect(await voterCount(p, 'target@example.com')).toBe(0)
    expect((await counter(p, 'target@example.com')).removed_at).not.toBeNull()
  }

  /**
   * Organization deletion takes the organization first and then deletes the poll. Removal,
   * bulk removal and the results read wait for the organization before they lock the poll,
   * so they never deadlock with it: deletion wins and they are refused.
   */
  async function verifyLockOrder(M: Modules) {
    for (const writer of ['remove', 'bulk', 'results'] as const) {
      const p = await open()
      await succeeds(() => enroll(M, p, 'doomed@example.com', '192.0.2.120'))
      const row = await voter(p, 'doomed@example.com')
      const host = (await revisions(p)).host_revision
      const locked = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const deletion = db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', p.organizationId)
          .forUpdate()
          .execute()
        locked.resolve()
        await proceed.promise
        await trx.deleteFrom('auth.organization').where('id', '=', p.organizationId).execute()
      })
      deletion.catch(() => locked.resolve())
      await locked.promise
      const work =
        writer === 'remove'
          ? remove(M, p, row.id, host)
          : writer === 'bulk'
            ? removeUnverified(M, p, host)
            : results(M, p)
      work.catch(() => undefined)
      const queued = await waiters(1)
      proceed.resolve()
      const settled = await Promise.allSettled([deletion, work])
      expect(queued, `${writer} waits for the organization`).toBe(true)
      expect(settled.map(outcome), writer).toEqual([
        'fulfilled',
        { code: 'team_management_access_denied' },
      ])
    }
  }

  // --- Behaviour ---------------------------------------------------------------------------

  const REAL: Modules = { K: Key, P: Polls, V: Voters, B: Ballots, R: Results }

  it('projects separate counts of counted ballots, the roster and both revisions', async () => {
    await verifyResults(REAL)
  }, 60_000)

  it('reports a ballot that held the poll under the revision it produced', async () => {
    await verifyResultsConsistency(REAL)
  })

  it('lets managers and read keys read results; others get the usual refusals', async () => {
    await verifyResultsAuthority(REAL)
  })

  it('removes a voter behind a mailbox tombstone, keeping only the counter row', async () => {
    await verifyRemoval(REAL)
  })

  it('removes while open or closed and refuses canceled, scheduled and foreign callers', async () => {
    await verifyRemovalRules(REAL)
  })

  it('bulk-removes only live unverified public reservations', async () => {
    await verifyBulkRemoval(REAL)
  })

  it('re-admits a removed mailbox only by host invitation, keeping its accounting', async () => {
    await verifyReinvitation(REAL)
  })

  it('frees a place on removal and takes one on re-invitation', async () => {
    await verifyRemovalCapacity(REAL)
  })

  it('refuses results and removal under a mismatched secret', async () => {
    await verifyKeyFence(REAL)
  })

  it('keeps the key fence while removal leftovers exist', async () => {
    await verifyKeyLeftovers(REAL)
  }, 120_000)

  it('closes against a voter replacing their ballot every second', async () => {
    await verifyChurnClose(REAL)
  }, 60_000)

  it('cancels against a voter replacing their ballot every second', async () => {
    await verifyChurnCancel(REAL)
  }, 60_000)

  it('rotates the link against a voter replacing their ballot every second', async () => {
    await verifyChurnRotate(REAL)
  }, 60_000)

  it('removes voters, the churning one included, against ballot churn', async () => {
    await verifyChurnRemoveVoter(REAL)
  }, 60_000)

  it('bulk-removes unverified voters against ballot churn', async () => {
    await verifyChurnRemoveUnverified(REAL)
  }, 60_000)

  it('serializes removal with verification, ballots and enrollment on the poll lock', async () => {
    await verifyRemovalRaces(REAL)
  }, 60_000)

  it('waits for the organization before the poll, as organization deletion does', async () => {
    await verifyLockOrder(REAL)
  }, 60_000)

  // --- Mutation checks --------------------------------------------------------------------

  const verifications = [
    verifyResults,
    verifyResultsConsistency,
    verifyResultsAuthority,
    verifyRemoval,
    verifyRemovalRules,
    verifyBulkRemoval,
    verifyReinvitation,
    verifyRemovalCapacity,
    verifyKeyFence,
    verifyKeyLeftovers,
    verifyChurnClose,
    verifyChurnCancel,
    verifyChurnRotate,
    verifyChurnRemoveVoter,
    verifyChurnRemoveUnverified,
    verifyRemovalRaces,
    verifyLockOrder,
  ]

  it('passes every protection check through unmodified source copies', async () => {
    const copies = await sourceCopy()
    for (const verify of verifications) await verify(copies)
  }, 600_000)

  /** Name, check, mutation and, optionally, the assertion message that must report it. */
  type Mutant = [string, (M: Modules) => Promise<void>, Mutation, string?]
  const LOCKED = '    const locked = await lockManagedPoll(trx, ctx, request.id)\n'
  const POLL_LOCK = '    const poll = await lockManagedPoll(trx, ctx, request.id)\n'
  const FENCE = '    await ensureMeetingPollKey(trx, secret)\n'
  const REMOVE_OPENING = `${FENCE}${LOCKED}    requireRemovable(locked)\n    if (!isUuid(voterId)) throw pollNotFound()\n`
  const BULK_OPENING = `${FENCE}${LOCKED}    requireRemovable(locked)\n    requireHostRevision(locked, request.expectedHostRevision)\n    const voters = await trx\n`
  const CLOSE_OPENING = `${POLL_LOCK}    if (poll.effectiveStatus === 'closed') return loadPoll(trx, ctx, poll.id)\n`
  const CANCEL_OPENING = `${POLL_LOCK}    if (poll.status === 'canceled') return loadPoll(trx, ctx, poll.id)\n`
  const ROTATE_OPENING = `${POLL_LOCK}    const receipt = receiptIdentity(ctx, 'rotate_link'`
  const RESULTS_REVISION =
    'SELECT results_revision AS v FROM meeting_polls WHERE id = ${request.id}'
  const BALLOT_REVISION =
    'SELECT ballot_revision AS v FROM meeting_poll_voters WHERE id = ${voterId}'
  /** The write reads `query` before its poll lock and refuses when it changed under the lock. */
  const preLock = (opening: string, lock: string, query: string): Replacement => [
    opening,
    opening.replace(
      lock,
      `    const early = (await sql\`${query}\`.execute(trx)).rows[0]\n${lock}    const late = (await sql\`${query}\`.execute(trx)).rows[0]\n    if (JSON.stringify(late) !== JSON.stringify(early)) throw Object.assign(new Error('poll_changed'), { code: 'poll_changed' })\n`,
    ),
  ]
  /** The write takes `statement` before its first lock of the host order. */
  const before = (opening: string, lock: string, statement: string): Replacement => [
    opening,
    opening.replace(lock, `    await ${statement}\n${lock}`),
  ]
  const COUNTER_UPSERT = "  await trx\n    .insertInto('meeting_poll_mailbox_counters')"
  const DELETE_COUNTER: Replacement = [
    COUNTER_UPSERT,
    `  await trx.deleteFrom('meeting_poll_mailbox_counters').where('poll_id', '=', locked.id).where('email_key', 'in', voters.map((voter) => voter.email_key)).execute()\n  if (false) ${COUNTER_UPSERT.trimStart()}`,
  ]
  /** The voter delete still runs (and reaches the pause point) but deletes nothing. */
  const KEEP_VOTER: Replacement = [
    "    .deleteFrom('meeting_poll_voters')\n    .where('poll_id', '=', locked.id)\n",
    "    .deleteFrom('meeting_poll_voters')\n    .where('poll_id', '=', locked.id)\n    .where(sql<boolean>`false`)\n",
  ]
  const TOMBSTONE_UPDATE =
    '        removed_at: locked.at,\n        updated_at: locked.at,\n      }),'
  const BULK_FILTER =
    "      .where('verified_at', 'is', null)\n      .where('invited_at', 'is', null)\n      .where('withdrawn_at', 'is', null)\n      .where(sql<boolean>`pending_expires_at > ${locked.at}::timestamptz`)\n"
  const CLEAR_REMOVAL = '        ...(clearRemoval ? { removed_at: null } : {}),'
  const mutants: Mutant[] = [
    [
      'the roster carries the admission IP digest of pending voters',
      verifyResults,
      {
        results: [
          [
            "        'responses',\n        sql<MeetingPollVoterState['status']>",
            "        'responses',\n        'admission_ip_digest',\n        sql<MeetingPollVoterState['status']>",
          ],
          [
            '        responses: voter.responses as Responses,\n      })),',
            "        responses: voter.responses as Responses,\n        ...(voter.admission_ip_digest ? { ip: Buffer.from(voter.admission_ip_digest).toString('base64url') } : {}),\n      })),",
          ],
        ],
      },
    ],
    [
      'the roster hides a pending IP digest in a documented field',
      verifyResults,
      {
        results: [
          [
            "        'responses',\n        sql<MeetingPollVoterState['status']>",
            "        'responses',\n        'admission_ip_digest',\n        sql<MeetingPollVoterState['status']>",
          ],
          [
            '        pendingExpiresAt: instant(voter.pendingExpires),\n',
            "        pendingExpiresAt: voter.admission_ip_digest ? Buffer.from(voter.admission_ip_digest).toString('base64url') : instant(voter.pendingExpires),\n",
          ],
        ],
      },
      'results reveal an encoded digest (base64url)',
    ],
    [
      're-invitation bypasses the resend cooldown',
      verifyReinvitation,
      { voters: [['  if (retryAfter > 0) throw new MeetingPollRateLimitError(retryAfter)\n', '']] },
    ],
    [
      're-invitation bypasses the resend cap',
      verifyReinvitation,
      { voters: [['  if (capped) throw new MeetingPollRateLimitError()\n', '']] },
    ],
    [
      're-invitation is not counted as a resend',
      verifyReinvitation,
      {
        voters: [
          [
            '        resend: reinvited.some((removed) => removed.equals(key)),\n',
            '        resend: false,\n',
          ],
        ],
      },
    ],
    [
      'a refused re-invitation batch admits its other entries',
      verifyReinvitation,
      {
        voters: [
          [
            "      plan.filter((entry) => entry.outcome === 'invited').map((entry) => entry.key),\n    )\n",
            "      plan.filter((entry) => entry.outcome === 'invited').map((entry) => entry.key),\n    ).catch(async (error) => {\n      const removed = await trx.selectFrom('meeting_poll_mailbox_counters').select('email_key').where('poll_id', '=', poll.id).where('removed_at', 'is not', null).execute()\n      for (let index = plan.length - 1; index >= 0; index--)\n        if (plan[index].outcome === 'invited' && removed.some((row) => row.email_key.equals(plan[index].key))) plan.splice(index, 1)\n      if (plan.length === 0) throw error\n      return []\n    })\n",
          ],
        ],
      },
    ],
    [
      'remove-voter checks the results revision',
      verifyChurnRemoveVoter,
      { results: [preLock(REMOVE_OPENING, LOCKED, RESULTS_REVISION)] },
    ],
    [
      "remove-voter checks the voter's ballot revision",
      verifyChurnRemoveVoter,
      { results: [preLock(REMOVE_OPENING, LOCKED, BALLOT_REVISION)] },
    ],
    [
      'remove-unverified checks the results revision',
      verifyChurnRemoveUnverified,
      { results: [preLock(BULK_OPENING, LOCKED, RESULTS_REVISION)] },
    ],
    [
      'close checks the results revision',
      verifyChurnClose,
      { polls: [preLock(CLOSE_OPENING, POLL_LOCK, RESULTS_REVISION)] },
    ],
    [
      'cancel checks the results revision',
      verifyChurnCancel,
      { polls: [preLock(CANCEL_OPENING, POLL_LOCK, RESULTS_REVISION)] },
    ],
    [
      'rotate-link checks the results revision',
      verifyChurnRotate,
      { polls: [preLock(ROTATE_OPENING, POLL_LOCK, RESULTS_REVISION)] },
    ],
    [
      'host writes compare the results revision as their host revision',
      verifyChurnClose,
      {
        polls: [
          [
            "      'host_revision',\n      'display_time_zone',\n    ])",
            "      sql<number>`results_revision`.as('host_revision'),\n      'display_time_zone',\n    ])",
          ],
        ],
      },
    ],
    [
      'voter ballots advance the host revision',
      verifyChurnRotate,
      {
        voters: [
          [
            '      ...(options.host ? { host_revision: options.hostRevision + 1 } : {}),',
            "      host_revision: eb('host_revision', '+', 1),",
          ],
        ],
      },
    ],
    [
      'removal leaves the results revision',
      verifyRemoval,
      {
        results: [
          [
            '    hostRevision: locked.host_revision,\n  })',
            '    hostRevision: locked.host_revision,\n    results: false,\n  })',
          ],
        ],
      },
    ],
    [
      'removal leaves the host revision',
      verifyRemoval,
      {
        results: [
          [
            '  await advanceRevisions(trx, hostPoll(locked), {\n    host: true,\n    hostRevision: locked.host_revision,\n  })',
            '  await advanceRevisions(trx, hostPoll(locked), { host: false })',
          ],
        ],
      },
    ],
    ['removal deletes the counter row', verifyRemoval, { results: [DELETE_COUNTER] }],
    [
      'removal deletes the counter row, releasing the key fence',
      verifyKeyLeftovers,
      { results: [DELETE_COUNTER] },
    ],
    ['removal keeps the voter row', verifyRemoval, { results: [KEEP_VOTER] }],
    [
      'removal keeps the voter row for queued voter writes',
      verifyRemovalRaces,
      { results: [KEEP_VOTER] },
    ],
    [
      'removal leaves no rejoin block',
      verifyReinvitation,
      {
        results: [
          [
            '        removed_at: locked.at,\n        created_at: locked.at,',
            '        created_at: locked.at,',
          ],
          [TOMBSTONE_UPDATE, '        updated_at: locked.at,\n      }),'],
        ],
      },
    ],
    [
      'removal resets the resend and recovery budgets',
      verifyRemoval,
      {
        results: [
          [
            TOMBSTONE_UPDATE,
            '        removed_at: locked.at,\n        resend_count: 0,\n        last_resend_at: null,\n        recovery_count: 0,\n        last_recovery_at: null,\n        updated_at: locked.at,\n      }),',
          ],
        ],
      },
    ],
    [
      'removal drops the opt-out and the reminder receipt',
      verifyRemoval,
      {
        results: [
          [
            TOMBSTONE_UPDATE,
            '        removed_at: locked.at,\n        reminder_opted_out_at: null,\n        reminder_consumed_at: null,\n        updated_at: locked.at,\n      }),',
          ],
        ],
      },
    ],
    [
      're-invitation resets the resend budget',
      verifyReinvitation,
      {
        voters: [
          [
            CLEAR_REMOVAL,
            '        ...(clearRemoval ? { removed_at: null, resend_count: 0, last_resend_at: null } : {}),',
          ],
        ],
      },
    ],
    [
      're-invitation drops the opt-out',
      verifyReinvitation,
      {
        voters: [
          [
            CLEAR_REMOVAL,
            '        ...(clearRemoval ? { removed_at: null, reminder_opted_out_at: null } : {}),',
          ],
        ],
      },
    ],
    [
      're-invitation keeps the removal tombstone',
      verifyReinvitation,
      { voters: [['        clearRemoval: true,\n', '        clearRemoval: false,\n']] },
    ],
    [
      'bulk removal takes unverified invitees',
      verifyBulkRemoval,
      {
        results: [
          [
            BULK_FILTER,
            "      .where('verified_at', 'is', null)\n      .where('withdrawn_at', 'is', null)\n",
          ],
        ],
      },
    ],
    [
      'bulk removal takes verified and withdrawn public voters',
      verifyBulkRemoval,
      { results: [[BULK_FILTER, "      .where('invited_at', 'is', null)\n"]] },
    ],
    [
      'bulk removal takes expired reservations',
      verifyBulkRemoval,
      {
        results: [
          [
            "      .where(sql<boolean>`pending_expires_at > ${locked.at}::timestamptz`)\n      .orderBy('id')",
            "      .where('pending_expires_at', 'is not', null)\n      .orderBy('id')",
          ],
        ],
      },
    ],
    [
      'bulk removal decides from a read before the poll lock',
      verifyRemovalRaces,
      {
        results: [
          [
            BULK_OPENING,
            `${FENCE}    const early = await trx.selectFrom('meeting_poll_voters').select(['id', 'email_key']).where('poll_id', '=', request.id).where('verified_at', 'is', null).where('invited_at', 'is', null).where('withdrawn_at', 'is', null).where(sql\`pending_expires_at > clock_timestamp()\`).orderBy('id').execute()\n${LOCKED}    requireRemovable(locked)\n    requireHostRevision(locked, request.expectedHostRevision)\n    const voters = early\n    const unused = await trx\n`,
          ],
        ],
      },
    ],
    [
      'bulk removal locks voter rows before the poll',
      verifyRemovalRaces,
      {
        results: [
          before(
            BULK_OPENING,
            LOCKED,
            "trx.selectFrom('meeting_poll_voters').select('id').where('poll_id', '=', request.id).where('pending_expires_at', 'is not', null).forUpdate().execute()",
          ),
        ],
      },
    ],
    [
      'remove-voter locks the voter row before the poll',
      verifyChurnRemoveVoter,
      {
        results: [
          before(
            REMOVE_OPENING,
            LOCKED,
            "trx.selectFrom('meeting_poll_voters').select('id').where('id', '=', voterId).forUpdate().execute()",
          ),
        ],
      },
    ],
    [
      'remove-voter locks the poll before the organization',
      verifyLockOrder,
      {
        results: [
          before(
            REMOVE_OPENING,
            LOCKED,
            "trx.selectFrom('meeting_polls').select('id').where('id', '=', request.id).forUpdate().execute()",
          ),
        ],
      },
    ],
    [
      'remove-unverified locks the poll before the organization',
      verifyLockOrder,
      {
        results: [
          before(
            BULK_OPENING,
            LOCKED,
            "trx.selectFrom('meeting_polls').select('id').where('id', '=', request.id).forUpdate().execute()",
          ),
        ],
      },
    ],
    [
      'results lock the poll before the organization',
      verifyLockOrder,
      {
        results: [
          [
            '  const authority = await lockAuthority(trx, ctx)\n',
            "  await trx.selectFrom('meeting_polls').select('id').where('id', '=', id).forShare().execute()\n  const authority = await lockAuthority(trx, ctx)\n",
          ],
        ],
      },
    ],
    [
      'results read voters outside the key fence',
      verifyKeyFence,
      {
        results: [
          [
            `${FENCE}    const poll = await lockResultsPoll(`,
            '    const poll = await lockResultsPoll(',
          ],
        ],
      },
    ],
    [
      'remove-voter skips the key fence',
      verifyKeyFence,
      { results: [[REMOVE_OPENING, REMOVE_OPENING.replace(FENCE, '')]] },
    ],
    [
      'remove-unverified skips the key fence',
      verifyKeyFence,
      { results: [[BULK_OPENING, BULK_OPENING.replace(FENCE, '')]] },
    ],
    [
      'the key fence counts only tombstoned counters',
      verifyKeyLeftovers,
      {
        key: [
          [
            'OR EXISTS (SELECT FROM meeting_poll_mailbox_counters) AS keyed',
            'OR EXISTS (SELECT FROM meeting_poll_mailbox_counters WHERE removed_at IS NOT NULL) AS keyed',
          ],
        ],
      },
    ],
    [
      'the key fence ignores counters',
      verifyKeyLeftovers,
      {
        key: [
          ['\n      OR EXISTS (SELECT FROM meeting_poll_mailbox_counters) AS keyed', ' AS keyed'],
        ],
      },
    ],
    [
      'results count ballots that do not count',
      verifyResults,
      {
        results: [
          [
            "sql<boolean>`verified_at IS NOT NULL AND withdrawn_at IS NULL\n          AND ballot_submitted_at IS NOT NULL`.as('counted')",
            "sql<boolean>`true`.as('counted')",
          ],
        ],
      },
    ],
    [
      'results count a missing ballot as no',
      verifyResults,
      {
        results: [
          [
            '    return {\n      poll: metadata,',
            '    for (const voter of voters)\n      if (!ballots.has(voter.id)) for (const tally of tallies.values()) tally.no += 1\n    return {\n      poll: metadata,',
          ],
        ],
      },
    ],
    [
      'results list expired reservations',
      verifyResults,
      {
        results: [
          [
            '      .where(\n        sql<boolean>`(pending_expires_at IS NULL OR pending_expires_at > ${poll.at}::timestamptz)`,\n      )\n',
            '',
          ],
        ],
      },
    ],
    [
      'the results roster loses the parentheses around its expiry test',
      verifyResults,
      {
        results: [
          [
            '`(pending_expires_at IS NULL OR pending_expires_at > ${poll.at}::timestamptz)`',
            '`pending_expires_at IS NULL OR pending_expires_at > ${poll.at}::timestamptz`',
          ],
        ],
      },
    ],
    [
      'removal refuses closed polls',
      verifyRemovalRules,
      {
        results: [
          [
            "  if (poll.status === 'canceled') throw pollCanceled()\n",
            "  if (poll.status === 'canceled') throw pollCanceled()\n  if (poll.effectiveStatus === 'closed') throw pollCanceled()\n",
          ],
        ],
      },
    ],
    [
      'removal changes a scheduled poll',
      verifyRemovalRules,
      { results: [["  if (poll.status === 'scheduled') throw alreadyScheduled()\n", '']] },
    ],
    [
      'removal changes a canceled poll',
      verifyRemovalRules,
      { results: [["  if (poll.status === 'canceled') throw pollCanceled()\n", '']] },
    ],
    [
      'removal takes an expired reservation',
      verifyRemovalRules,
      {
        results: [
          [
            '      .where(\n        sql<boolean>`(pending_expires_at IS NULL OR pending_expires_at > ${locked.at}::timestamptz)`,\n      )\n',
            '',
          ],
        ],
      },
    ],
    [
      'removal loses the parentheses around its expiry test',
      verifyRemoval,
      {
        results: [
          [
            '`(pending_expires_at IS NULL OR pending_expires_at > ${locked.at}::timestamptz)`',
            '`pending_expires_at IS NULL OR pending_expires_at > ${locked.at}::timestamptz`',
          ],
        ],
      },
    ],
    [
      'read keys remove voters',
      verifyRemovalRules,
      {
        results: [
          [
            '  requireWriteScope(ctx)\n  const secret = requireSecret(ctx.meetingPollSecret)\n  const request = validHostWrite(input)\n  const voterId',
            '  const secret = requireSecret(ctx.meetingPollSecret)\n  const request = validHostWrite(input)\n  const voterId',
          ],
        ],
      },
    ],
    [
      'remove-voter skips the host revision check',
      verifyRemoval,
      {
        results: [
          [
            '    if (voters.length === 0) throw pollNotFound()\n    requireHostRevision(locked, request.expectedHostRevision)\n',
            '    if (voters.length === 0) throw pollNotFound()\n',
          ],
        ],
      },
    ],
    [
      'remove-unverified skips the host revision check',
      verifyBulkRemoval,
      {
        results: [
          [
            '    requireRemovable(locked)\n    requireHostRevision(locked, request.expectedHostRevision)\n    const voters = await trx\n',
            '    requireRemovable(locked)\n    const voters = await trx\n',
          ],
        ],
      },
    ],
    [
      'removal finds a voter of another poll',
      verifyRemoval,
      {
        results: [
          [
            "      .where('id', '=', voterId)\n      .where('poll_id', '=', locked.id)\n",
            "      .where('id', '=', voterId)\n",
          ],
        ],
      },
    ],
    [
      "the results roster lists other polls' voters",
      verifyResults,
      {
        results: [
          [
            "      .where('poll_id', '=', poll.id)\n      .where('organization_id', '=', poll.organizationId)\n      // An expired",
            "      .where('organization_id', '=', poll.organizationId)\n      // An expired",
          ],
        ],
      },
    ],
    [
      'the results read does not lock the poll',
      verifyResultsConsistency,
      {
        results: [
          [
            '    .forShare()\n    .executeTakeFirst()\n  if (!poll) throw pollNotFound()\n',
            '    .executeTakeFirst()\n  if (!poll) throw pollNotFound()\n',
          ],
        ],
      },
    ],
    [
      'removal refuses a soft-deleted event',
      verifyRemovalRules,
      {
        results: [
          [
            "  if (poll.status === 'canceled') throw pollCanceled()\n",
            "  if (poll.status === 'canceled') throw pollCanceled()\n  if (poll.eventDeleted) throw pollCanceled()\n",
          ],
        ],
      },
    ],
    [
      'removal checks the host revision before finding the voter',
      verifyRemoval,
      {
        results: [
          [
            '    if (voters.length === 0) throw pollNotFound()\n    requireHostRevision(locked, request.expectedHostRevision)\n',
            '    requireHostRevision(locked, request.expectedHostRevision)\n    if (voters.length === 0) throw pollNotFound()\n',
          ],
        ],
      },
    ],
  ]

  // Only a failed assertion counts: a mutant that crashes or cannot load is not a detection.
  it.each(mutants)(
    'detects the mutation: %s',
    async (_name, verify, mutation, message) => {
      const mutated = await sourceCopy(mutation)
      await expect(verify(mutated)).rejects.toMatchObject({
        name: 'AssertionError',
        ...(message === undefined ? {} : { message: expect.stringContaining(message) }),
      })
    },
    180_000,
  )
})
