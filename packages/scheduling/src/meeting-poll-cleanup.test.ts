// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-copy mutations target literal template strings
// Meeting-poll cleanup and deletion on a real throwaway database: expired public pending
// reservations, terminal polls past retention, replay tombstones, poll deletion and linked
// booking deletion. Races use two connections in the contender-first shape: the contender
// takes its locks up to and including the contested row and stops there, the other side runs
// as one call, then the contender finishes. Every check runs against the real modules, then
// against isolated source copies (or, for database cascades, a changed schema) with one
// protection broken; a mutant counts as detected only when a real assertion fails.
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
import * as Cleanup from './meeting-poll-cleanup.ts'
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
const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
/** The advisory lock that pauses voter writes of the pausable connection in their transaction. */
const PAUSE = 'hourmere.meeting-poll-cleanup-test.pause'
/** The churning voter replaces their ballot about every second. */
const CHURN_INTERVAL_MS = 1000
const RUNS = 2
/** How long a cleanup may take while something else holds a lock it would need. */
const PROMPT_MS = 5000

interface Modules {
  K: typeof Key
  P: typeof Polls
  V: typeof Voters
  B: typeof Ballots
  R: typeof Results
  C: typeof Cleanup
}
type Replacement = readonly [string, string]
interface Mutation {
  polls?: readonly Replacement[]
  voters?: readonly Replacement[]
  cleanup?: readonly Replacement[]
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

/** Isolated copies of the services, each importing the others' copies. */
async function sourceCopy(mutation: Mutation = {}): Promise<Modules> {
  const key = copy('./meeting-poll-key.ts', [], {})
  const polls = copy('./meeting-polls.ts', mutation.polls ?? [], {})
  const voters = copy('./meeting-poll-voters.ts', mutation.voters ?? [], {
    './meeting-poll-key.ts': key,
    './meeting-polls.ts': polls,
  })
  const ballots = copy('./meeting-poll-ballots.ts', [], {
    './meeting-poll-key.ts': key,
    './meeting-poll-voters.ts': voters,
    './meeting-polls.ts': polls,
  })
  const results = copy('./meeting-poll-results.ts', [], {
    './meeting-poll-key.ts': key,
    './meeting-poll-voters.ts': voters,
    './meeting-polls.ts': polls,
    './meeting-poll-ballots.ts': ballots,
  })
  const cleanup = copy('./meeting-poll-cleanup.ts', mutation.cleanup ?? [], {})
  return {
    K: await import(key),
    P: await import(polls),
    V: await import(voters),
    B: await import(ballots),
    R: await import(results),
    C: await import(cleanup),
  }
}

/** Source copies load their own error classes, so compare by name and code. */
async function failure(fn: () => Promise<unknown>) {
  const error = await fn().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) expect.unreachable('expected the operation to fail')
  const known = error as Error & { code?: string }
  return { name: error.name, code: known.code }
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
const tag = () => randomBytes(5).toString('hex')

describe.skipIf(!serverUrl)('meeting poll cleanup and deletion', () => {
  let owned: TestDatabase
  let db: Db
  /** A second pool whose voter updates and deletes can be paused (PAUSE). */
  let second: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_cleanup' })
    db = createDb(owned.pool)
    // Test-only pause point, in this throwaway database only: while PAUSE is held, a session
    // that sets poll_test.pause stops before each voter update or delete statement, including
    // the ones a poll or booking deletion cascades to, after its poll lock.
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
  async function teamSpace() {
    const fixtures = createFixtures(db)
    const admin = await createTestUser(db, 'Team Admin')
    const member = await createTestUser(db, 'Configured Host')
    for (const user of [admin, member]) await fixtures.schedule(user.id, ALWAYS)
    const t = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(t.id, null, { hosts: [{ userId: member.id }] })
    return space(fixtures, t.id, eventTypeId, admin, member, t.as(admin))
  }

  /** A personal space: its owner manages their own event. */
  async function personalSpace() {
    const fixtures = createFixtures(db)
    const owner = await createTestUser(db, 'Personal Owner')
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: `poll-${tag()}`, time_zone: 'UTC' })
      .execute()
    await fixtures.schedule(owner.id, ALWAYS)
    const organizationId = owner.principal.organization.id
    const eventTypeId = await fixtures.eventType(organizationId, owner.id)
    return space(fixtures, organizationId, eventTypeId, owner, owner, owner.principal)
  }

  function space(
    fixtures: ReturnType<typeof createFixtures>,
    organizationId: string,
    eventTypeId: string,
    admin: TestUser,
    member: TestUser,
    principal: Principal,
  ) {
    const ctx: Voters.MeetingPollHostContext = {
      ...testContext(db, session(principal)),
      meetingPollSecret: SECRET,
    }
    return { fixtures, organizationId, eventTypeId, admin, member, ctx }
  }

  type Space = Awaited<ReturnType<typeof teamSpace>>
  type PollSpace = Awaited<ReturnType<typeof pollIn>>

  async function open(admissionMode: 'public_link' | 'invited' = 'public_link') {
    return pollIn(await teamSpace(), admissionMode)
  }

  /** An open poll with two candidates, about a day before its deadline. */
  async function pollIn(s: Space, admissionMode: 'public_link' | 'invited' = 'public_link') {
    const deadline = (await databaseNow())
      .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
      .add({ hours: 24 })
    const created = await Polls.createMeetingPoll(s.ctx, {
      eventTypeId: s.eventTypeId,
      candidateStarts: [0, 1].map((index) => deadline.add({ hours: 25 + index }).toString()),
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

  function enroll(M: Modules, p: PollSpace, email: string, ip = '192.0.2.10', name = 'Voter') {
    return M.V.enrollMeetingPollVoter(pub(ip), {
      publicToken: p.link,
      name,
      email,
      timeZone: 'Europe/Berlin',
    })
  }

  function invite(M: Modules, p: PollSpace, emails: string[], name = 'Invited Voter') {
    return M.V.inviteMeetingPollVoters(p.ctx, {
      id: p.pollId,
      invitees: emails.map((email) => ({ name, email })),
      idempotencyKey: randomUUID(),
    })
  }

  async function invitee(M: Modules, p: PollSpace, email: string, name?: string) {
    await succeeds(() => invite(M, p, [email], name))
    return (await mailed(p, email)).token
  }

  async function publicVoter(M: Modules, p: PollSpace, email: string, ip: string, name?: string) {
    await succeeds(() => enroll(M, p, email, ip, name))
    const { token } = await mailed(p, email)
    const verified = await succeeds(() => M.V.verifyMeetingPollVoter(pub(ip), { token }))
    return verified.votingToken as string
  }

  function ballot(
    M: Modules,
    p: PollSpace,
    token: string,
    values: Value[],
    expectedBallotRevision: number,
    on: Db = db,
  ) {
    return M.B.submitMeetingPollBallot(pub(undefined, on), {
      token,
      votes: p.slotIds.map((slotId, index) => ({ slotId, value: values[index] as Value })),
      consent: true,
      expectedBallotRevision,
    })
  }

  function remove(M: Modules, p: PollSpace, voterId: string, expectedHostRevision: number) {
    return M.R.removeMeetingPollVoter(p.ctx, { id: p.pollId, voterId, expectedHostRevision })
  }

  function deletePoll(M: Modules, p: PollSpace, expectedHostRevision: number, on: Db = db) {
    return M.P.deleteMeetingPoll(
      { ...p.ctx, db: on },
      {
        id: p.pollId,
        expectedHostRevision,
      },
    )
  }

  function cleanup(M: Modules, options?: Cleanup.MeetingPollCleanupOptions) {
    return M.C.cleanupMeetingPolls(db, options)
  }

  /** Run cleanup pages until one reports nothing more. */
  async function drain(M: Modules, options?: Cleanup.MeetingPollCleanupOptions) {
    for (let page = 0; page < 100; page++)
      if (!(await succeeds(() => cleanup(M, options))).more) return
    expect.unreachable('cleanup did not drain')
  }

  async function voter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_voters')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
  }

  async function voterCount(p: PollSpace, email?: string) {
    const rows = await db
      .selectFrom('meeting_poll_voters')
      .select('id')
      .where('poll_id', '=', p.pollId)
      .$if(email !== undefined, (query) => query.where('email', '=', email as string))
      .execute()
    return rows.length
  }

  async function revisions(p: PollSpace) {
    return db
      .selectFrom('meeting_polls')
      .select(['host_revision', 'results_revision'])
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
  }

  async function pollExists(pollId: string) {
    const row = await db
      .selectFrom('meeting_polls')
      .select('id')
      .where('id', '=', pollId)
      .executeTakeFirst()
    return row !== undefined
  }

  /** The credential carried by a mailbox's newest queued mail. */
  async function mailed(p: PollSpace, email: string) {
    const row = await voter(p, email)
    const [delivery] = (
      await db
        .selectFrom('meeting_poll_deliveries')
        .selectAll()
        .where('voter_id', '=', row.id)
        .where('capability_ciphertext', 'is not', null)
        .orderBy('id', 'desc')
        .execute()
    ).slice(0, 1)
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

  /** Move a public reservation `minutes` past its expiry, as a late worker would find it. */
  async function expirePending(p: PollSpace, email: string, minutes = 1) {
    const row = await voter(p, email)
    const now = await databaseNow()
    const values = {
      created_at: now.subtract({ minutes: 60 + minutes }).toString(),
      expires: now.subtract({ minutes }).toString(),
    }
    await db
      .updateTable('meeting_poll_voters')
      .set({ created_at: values.created_at, pending_expires_at: values.expires })
      .where('id', '=', row.id)
      .execute()
    await db
      .updateTable('meeting_poll_capabilities')
      .set({ created_at: values.created_at, expires_at: values.expires })
      .where('voter_id', '=', row.id)
      .where('purpose', '=', 'verification')
      .execute()
    return row
  }

  /** Link the poll to a booking of its first candidate, as finalization will. */
  async function schedule(p: PollSpace, daysAgo = 0) {
    const slot = await db
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
      booking_id = ${bookingId},
      scheduled_at = clock_timestamp() - make_interval(days => ${daysAgo})
      WHERE id = ${p.pollId}`.execute(db)
    return bookingId
  }

  /**
   * Age a poll so that it reached `state` `days` ago. Creation and the deadline move back
   * with it; candidates are fixed history and stay.
   */
  async function age(p: PollSpace, state: 'open' | 'closed' | 'canceled', days: number) {
    const ended = sql`clock_timestamp() - make_interval(days => ${days})`
    await sql`UPDATE meeting_polls SET created_at = ${ended} - interval '2 days',
      deadline_at = ${ended}, status = ${state},
      closed_at = ${state === 'closed' ? ended : null},
      canceled_at = ${state === 'canceled' ? ended : null}
      WHERE id = ${p.pollId}`.execute(db)
  }

  /** A poll with every kind of voter row, credential, delivery, counter and receipt. */
  async function populated(M: Modules, s?: Space) {
    const p = await pollIn(s ?? (await teamSpace()))
    const mark = tag()
    const email = (who: string) => `${who}-${mark}@example.com`
    const name = (who: string) => `Voter ${who} ${mark}`
    const verified = await publicVoter(M, p, email('verified'), '192.0.2.21', name('verified'))
    await succeeds(() => ballot(M, p, verified, ['yes', 'no'], 0))
    const invited = await invitee(M, p, email('invited'), name('invited'))
    await succeeds(() => ballot(M, p, invited, ['if_need_be', 'yes'], 0))
    const withdrawing = await invitee(M, p, email('withdrawn'), name('withdrawn'))
    await succeeds(() => ballot(M, p, withdrawing, ['no', 'no'], 0))
    await succeeds(() =>
      M.B.withdrawMeetingPollVoter(pub(), { token: withdrawing, expectedBallotRevision: 1 }),
    )
    await succeeds(() => enroll(M, p, email('pending'), '192.0.2.22', name('pending')))
    await succeeds(() => enroll(M, p, email('expired'), '192.0.2.23', name('expired')))
    await expirePending(p, email('expired'))
    await invitee(M, p, email('removed'), name('removed'))
    const removed = await voter(p, email('removed'))
    await succeeds(async () => remove(M, p, removed.id, (await revisions(p)).host_revision))
    // A resend receipt and a rotated link add receipts of every kind but finalize.
    await succeeds(async () =>
      M.V.resendMeetingPollInvitation(p.ctx, {
        id: p.pollId,
        voterId: (await voter(p, email('invited'))).id,
        expectedHostRevision: (await revisions(p)).host_revision,
        idempotencyKey: randomUUID(),
      }),
    )
    const rotated = await succeeds(async () =>
      M.P.rotateMeetingPollLink(p.ctx, {
        id: p.pollId,
        expectedHostRevision: (await revisions(p)).host_revision,
        idempotencyKey: randomUUID(),
      }),
    )
    // The opt-out credential and a queued reminder that later mail steps write.
    const target = await voter(p, email('invited'))
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: target.id,
        purpose: 'reminder_opt_out',
        token_digest: randomBytes(32),
        expires_at: sql<Date>`(SELECT deadline_at FROM meeting_polls WHERE id = ${p.pollId})`,
      })
      .execute()
    await db
      .insertInto('meeting_poll_deliveries')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: target.id,
        kind: 'reminder',
        capability_ciphertext: randomBytes(64),
      })
      .execute()
    return {
      ...p,
      link: rotated.publicToken as string,
      email,
      name,
      mark,
      emails: ['verified', 'invited', 'withdrawn', 'pending', 'expired', 'removed'].map(email),
    }
  }

  /**
   * Every stored value of the poll that identifies a voter, a credential or the poll: IDs,
   * names, mailboxes, digests and ciphertexts, as text in hex, as each appears in `to_jsonb`.
   */
  async function needles(pollId: string, voterIds?: readonly string[]) {
    const found = new Set<string>()
    const add = (value: unknown) => {
      if (value === null || value === undefined) return
      if (Buffer.isBuffer(value)) found.add(value.toString('hex'))
      else if (value instanceof Date) return
      else if (typeof value === 'string' && value.length >= 8) found.add(value.toLowerCase())
    }
    const voters = await db
      .selectFrom('meeting_poll_voters')
      .selectAll()
      .where('poll_id', '=', pollId)
      .$if(voterIds !== undefined, (query) => query.where('id', 'in', voterIds as string[]))
      .execute()
    // The mailbox digest of an expired voter stays on the poll's counter row by design.
    for (const row of voters)
      for (const value of [
        row.id,
        row.name,
        row.email,
        row.admission_ip_digest,
        ...(voterIds === undefined ? [row.email_key] : []),
      ])
        add(value)
    const ids = voters.map((row) => row.id)
    if (ids.length > 0) {
      for (const row of await db
        .selectFrom('meeting_poll_capabilities')
        .selectAll()
        .where('voter_id', 'in', ids)
        .execute())
        for (const value of [row.id, row.token_digest, row.capability_ciphertext]) add(value)
      for (const row of await db
        .selectFrom('meeting_poll_deliveries')
        .selectAll()
        .where('voter_id', 'in', ids)
        .execute())
        for (const value of [row.id, row.capability_ciphertext]) add(value)
      for (const row of await db
        .selectFrom('meeting_poll_votes')
        .select('id')
        .where('voter_id', 'in', ids)
        .execute())
        add(row.id)
    }
    if (voterIds === undefined) {
      add(pollId)
      for (const row of await db
        .selectFrom('meeting_poll_mailbox_counters')
        .select(['id', 'email_key'])
        .where('poll_id', '=', pollId)
        .execute())
        for (const value of [row.id, row.email_key]) add(value)
      for (const row of await db
        .selectFrom('meeting_poll_slots')
        .select('id')
        .where('poll_id', '=', pollId)
        .execute())
        add(row.id)
      const poll = await db
        .selectFrom('meeting_polls')
        .select(['title', 'public_token_digest'])
        .where('id', '=', pollId)
        .executeTakeFirstOrThrow()
      add(poll.public_token_digest)
    }
    return [...found]
  }

  /** Every base table of the database, scanned row by row for `values`; the hits by table. */
  async function scan(values: readonly string[]) {
    const { rows: relations } = await sql<{ schema: string; name: string }>`
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1, 2`.execute(db)
    expect(relations.length, 'the scan covers the whole schema').toBeGreaterThan(50)
    const hits: Record<string, string[]> = {}
    for (const relation of relations) {
      const { rows } = await sql<{ row: string }>`SELECT lower(to_jsonb(t)::text) AS row
        FROM ${sql.table(`${relation.schema}.${relation.name}`)} t`.execute(db)
      for (const { row } of rows)
        for (const value of values)
          if (row.includes(value)) {
            const table = `${relation.schema}.${relation.name}`
            hits[table] = [...(hits[table] ?? []), value]
          }
    }
    return hits
  }

  /** The replay tombstones of a deleted poll: no reference, purge 90 days after deletion. */
  async function expectTombstones(receiptIds: readonly string[], deletedAt: Temporal.Instant) {
    const rows = await db
      .selectFrom('meeting_poll_operations')
      .select([
        'poll_id',
        'booking_id',
        sql<string>`to_char(purge_at AT TIME ZONE 'UTC', ${sql.lit(FORMAT)})`.as('purge'),
      ])
      .where('id', 'in', receiptIds)
      .execute()
    expect(rows).toHaveLength(receiptIds.length)
    for (const row of rows) {
      expect(row).toMatchObject({ poll_id: null, booking_id: null })
      const purge = Temporal.Instant.from(row.purge)
      const days = deletedAt.until(purge).total({ unit: 'hours' }) / 24
      expect(days, 'replay tombstones are purged 90 days after deletion').toBeGreaterThan(89.99)
      expect(days).toBeLessThan(90.01)
    }
  }

  async function receiptIds(pollId: string) {
    return (
      await db
        .selectFrom('meeting_poll_operations')
        .select('id')
        .where('poll_id', '=', pollId)
        .execute()
    ).map((row) => row.id)
  }

  // --- Concurrency helpers ----------------------------------------------------------------

  /** Waits until `count` sessions of this database wait for a lock; false after 10 seconds. */
  async function waiters(count: number): Promise<boolean> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((await lockWaits()) >= count) return true
      await sleep(25)
    }
    return false
  }

  async function lockWaits() {
    const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count
      FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock'`.execute(db)
    return Number(rows[0]?.count)
  }

  /** Hold `hold` in its own transaction until the returned release is awaited. */
  async function holding(hold: (trx: Db) => Promise<unknown>, on: Db = db) {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = on.transaction().execute(async (trx) => {
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
   * its transaction after its locks up to the poll row: each writer must wait before the
   * contender may finish. Returns every settlement, contender first.
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
        expect(await waiters(index + 2), 'the writer waits for the contended row').toBe(true)
      }
    } catch (error) {
      refused = error
    } finally {
      await release()
    }
    const settled = await Promise.allSettled(work)
    if (refused !== undefined) throw refused
    return settled
  }

  /**
   * Cleanup while `hold` keeps a lock: it must finish without waiting. The hold is released
   * and a cleanup that did wait is settled before a failed expectation is reported.
   */
  async function cleanupWhileHeld(
    M: Modules,
    release: () => Promise<void>,
    options?: Cleanup.MeetingPollCleanupOptions,
  ) {
    const started = cleanup(M, options)
    started.catch(() => undefined)
    let result: Awaited<typeof started> | 'waited'
    try {
      result = await Promise.race([started, sleep(PROMPT_MS).then(() => 'waited' as const)])
    } finally {
      await release()
      await Promise.allSettled([started])
    }
    expect(result, 'cleanup never waits for a lock').not.toBe('waited')
    return result as Awaited<typeof started>
  }

  /** A voter replacing their whole ballot about every second on the pausable connection. */
  function churn(M: Modules, p: PollSpace, token: string) {
    let revision = 0
    const stopping = Promise.withResolvers<void>()
    let stopped = false
    const outcomes: string[] = []
    const ended = (async () => {
      while (!stopped) {
        const values: Value[] = p.slotIds.map((_, index) =>
          (revision + index) % 2 === 0 ? 'yes' : 'no',
        )
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

  // --- Checks shared by the real modules and their mutated copies ------------------------

  /**
   * Expired public reservations: a late sweep deletes exactly them, with their votes,
   * credentials and deliveries; no name, mailbox, IP digest or credential is left anywhere.
   * Revisions do not move, the mailbox counter stays with the poll, and the mailbox may
   * enroll again.
   */
  async function verifyExpiryCleanup(M: Modules) {
    await drain(M)
    const p = await populated(M)
    const sibling = await populated(M)
    // A second expired reservation in the same poll, a whole day late.
    await succeeds(() => enroll(M, p, p.email('late'), '192.0.2.24', p.name('late')))
    const late = await expirePending(p, p.email('late'), 24 * 60)
    const expired = await voter(p, p.email('expired'))
    const expiredIds = [expired.id, late.id]
    const values = await needles(p.pollId, expiredIds)
    expect(values.length, 'non-vacuous').toBeGreaterThan(10)
    for (const row of [expired, late]) expect(row.admission_ip_digest).not.toBeNull()
    const kept = await db
      .selectFrom('meeting_poll_voters')
      .select('id')
      .where('poll_id', 'in', [p.pollId, sibling.pollId])
      .where('id', 'not in', expiredIds)
      .where('email', '!=', sibling.email('expired'))
      .orderBy('id')
      .execute()
    const counters = await db
      .selectFrom('meeting_poll_mailbox_counters')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .orderBy('id')
      .execute()
    const before = await revisions(p)

    const page = await succeeds(() => cleanup(M))
    expect(page).toMatchObject({ expiredReservations: 3, more: false })
    expect(await voterCount(p, p.email('expired'))).toBe(0)
    expect(await voterCount(p, p.email('late'))).toBe(0)
    expect(await voterCount(sibling, sibling.email('expired'))).toBe(0)
    // Everybody else stays, the live reservation included.
    expect(
      await db
        .selectFrom('meeting_poll_voters')
        .select('id')
        .where('poll_id', 'in', [p.pollId, sibling.pollId])
        .orderBy('id')
        .execute(),
    ).toEqual(kept)
    expect(await voterCount(p, p.email('pending'))).toBe(1)
    // Expiry already stopped counting: no revision moves.
    expect(await revisions(p)).toEqual(before)
    // The mailbox ledger is kept for the poll's lifetime, unchanged and without a removal.
    expect(
      await db
        .selectFrom('meeting_poll_mailbox_counters')
        .selectAll()
        .where('poll_id', '=', p.pollId)
        .orderBy('id')
        .execute(),
    ).toEqual(counters)
    // No name, mailbox, IP digest, credential or ID of an expired voter is left anywhere.
    expect(await scan(values), 'personal data left after expiry cleanup').toEqual({})
    // A repeat finds nothing.
    expect(await succeeds(() => cleanup(M))).toMatchObject({ expiredReservations: 0, more: false })
    // The expired mailbox enrolls again as new.
    await succeeds(() => enroll(M, p, p.email('expired'), '192.0.2.25', p.name('expired')))
    expect(await voterCount(p, p.email('expired')), 'an expired mailbox may enroll again').toBe(1)
  }

  /** Each page takes at most `limit` rows of each kind and reports whether more remain. */
  async function verifyBatchCaps(M: Modules) {
    await drain(M, { terminalRetentionDays: 30 })
    const p = await open()
    for (const index of [1, 2, 3]) {
      await succeeds(() => enroll(M, p, `capped-${index}@example.com`, `192.0.2.3${index}`))
      await expirePending(p, `capped-${index}@example.com`)
    }
    const first = await succeeds(() => cleanup(M, { limit: 2 }))
    expect(first.expiredReservations, 'one page deletes at most the batch').toBe(2)
    expect(first.more).toBe(true)
    expect(await voterCount(p)).toBe(1)
    const second = await succeeds(() => cleanup(M, { limit: 2 }))
    expect(second).toMatchObject({ expiredReservations: 1, more: false })

    // Terminal polls past retention, at most the batch per page.
    const s = await teamSpace()
    const terminal = [await pollIn(s), await pollIn(s), await pollIn(s)]
    for (const poll of terminal) await age(poll, 'closed', 40)
    const kept = await pollIn(s)
    const t1 = await succeeds(() => cleanup(M, { limit: 2, terminalRetentionDays: 30 }))
    expect(t1.terminalPolls, 'one page deletes at most the batch of polls').toBe(2)
    expect(t1.more).toBe(true)
    const t2 = await succeeds(() => cleanup(M, { limit: 2, terminalRetentionDays: 30 }))
    expect(t2).toMatchObject({ terminalPolls: 1 })
    for (const poll of terminal) expect(await pollExists(poll.pollId)).toBe(false)
    expect(await pollExists(kept.pollId)).toBe(true)

    // Replay tombstones once due: their receipts were tombstoned by the deletions above.
    await sql`UPDATE meeting_poll_operations SET purge_at = clock_timestamp() - interval '1 second'
      WHERE poll_id IS NULL AND organization_id = ${s.organizationId}`.execute(db)
    const due = await db
      .selectFrom('meeting_poll_operations')
      .select('id')
      .where('poll_id', 'is', null)
      .where('organization_id', '=', s.organizationId)
      .execute()
    expect(due.length, 'non-vacuous').toBe(3)
    const r1 = await succeeds(() => cleanup(M, { limit: 2 }))
    expect(r1.receipts, 'one page purges at most the batch of tombstones').toBe(2)
    expect(r1.more).toBe(true)
    expect(await succeeds(() => cleanup(M, { limit: 2 }))).toMatchObject({ receipts: 1 })
    // The live poll's receipt stays.
    expect(await receiptIds(kept.pollId)).toHaveLength(1)
    await expect(cleanup(M, { limit: 501 })).rejects.toThrow(TypeError)
    await expect(cleanup(M, { terminalRetentionDays: 0 })).rejects.toThrow(TypeError)
  }

  /**
   * Cleanup skips whatever another transaction holds, without waiting: the poll (a paused
   * ballot or a host write), the organization, a personal owner, a receipt. It deletes the
   * rest and finds the skipped rows on a later run.
   */
  async function verifyNeverWaits(M: Modules) {
    await drain(M, { terminalRetentionDays: 30 })
    // A voter's ballot holds the poll: the paused contender.
    const busy = await open()
    const token = await invitee(M, busy, 'busy-voter@example.com')
    await succeeds(() => enroll(M, busy, 'busy-expired@example.com', '192.0.2.40'))
    await expirePending(busy, 'busy-expired@example.com')
    const idle = await open()
    await succeeds(() => enroll(M, idle, 'idle-expired@example.com', '192.0.2.41'))
    await expirePending(idle, 'idle-expired@example.com')
    const release = await holdPause()
    const paused = ballot(M, busy, token, ['yes', 'yes'], 0, second)
    paused.catch(() => undefined)
    let held: Cleanup.MeetingPollCleanupResult
    try {
      expect(await waiters(1), 'the ballot pauses holding the poll').toBe(true)
      // Releasing the pause lets the ballot commit and frees the poll for a cleanup that waited.
      held = await cleanupWhileHeld(M, release)
    } finally {
      await release()
    }
    expect(outcome((await Promise.allSettled([paused]))[0])).toBe('fulfilled')
    expect(held.expiredReservations, 'the unheld poll is cleaned').toBe(1)
    expect(await voterCount(idle, 'idle-expired@example.com')).toBe(0)
    expect(await voterCount(busy, 'busy-expired@example.com'), 'the held poll is skipped').toBe(1)
    expect(await succeeds(() => cleanup(M))).toMatchObject({ expiredReservations: 1 })
    expect(await voterCount(busy, 'busy-expired@example.com'), 'and found later').toBe(0)

    // The organization, as an organization update or deletion holds it.
    const team = await open()
    await succeeds(() => enroll(M, team, 'team-expired@example.com', '192.0.2.42'))
    await expirePending(team, 'team-expired@example.com')
    const org = await holding((trx) =>
      trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', team.organizationId)
        .forUpdate()
        .execute(),
    )
    const orgPage = await cleanupWhileHeld(M, org)
    expect(orgPage.expiredReservations).toBe(0)
    expect(await voterCount(team, 'team-expired@example.com')).toBe(1)
    expect(await succeeds(() => cleanup(M))).toMatchObject({ expiredReservations: 1 })

    // A personal owner's user row, as a user deletion holds it first.
    const mine = await pollIn(await personalSpace())
    await succeeds(() => enroll(M, mine, 'personal-expired@example.com', '192.0.2.43'))
    await expirePending(mine, 'personal-expired@example.com')
    const user = await holding((trx) =>
      trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', mine.admin.id)
        .forUpdate()
        .execute(),
    )
    const userPage = await cleanupWhileHeld(M, user)
    expect(userPage.expiredReservations).toBe(0)
    expect(await voterCount(mine, 'personal-expired@example.com')).toBe(1)
    expect(await succeeds(() => cleanup(M))).toMatchObject({ expiredReservations: 1 })

    // A terminal poll that a host write holds.
    const old = await open()
    await age(old, 'canceled', 40)
    const pollHold = await holding((trx) =>
      trx
        .selectFrom('meeting_polls')
        .select('id')
        .where('id', '=', old.pollId)
        .forUpdate()
        .execute(),
    )
    const terminalPage = await cleanupWhileHeld(M, pollHold, { terminalRetentionDays: 30 })
    expect(terminalPage.terminalPolls).toBe(0)
    expect(await pollExists(old.pollId)).toBe(true)

    // A due replay tombstone that a replay holds.
    await succeeds(() => cleanup(M, { terminalRetentionDays: 30 }))
    expect(await pollExists(old.pollId)).toBe(false)
    await sql`UPDATE meeting_poll_operations SET purge_at = clock_timestamp() - interval '1 second'
      WHERE poll_id IS NULL AND organization_id = ${old.organizationId}`.execute(db)
    const [receipt] = await db
      .selectFrom('meeting_poll_operations')
      .select('id')
      .where('poll_id', 'is', null)
      .where('organization_id', '=', old.organizationId)
      .execute()
    if (!receipt) return expect.unreachable('a tombstone exists')
    const receiptHold = await holding((trx) =>
      trx
        .selectFrom('meeting_poll_operations')
        .select('id')
        .where('id', '=', receipt.id)
        .forUpdate()
        .execute(),
    )
    const receiptPage = await cleanupWhileHeld(M, receiptHold)
    expect(receiptPage.receipts).toBe(0)
    expect(await succeeds(() => cleanup(M))).toMatchObject({ receipts: 1 })
  }

  /**
   * Organization deletion holds the organization and then cascades through voter rows before
   * the poll. Cleanup takes the organization first (skipping it here), so it never holds the
   * poll while it waits for a voter row the deletion holds: no wait and no deadlock.
   */
  async function verifyCleanupLockOrder(M: Modules) {
    await drain(M)
    const p = await open()
    await succeeds(() => enroll(M, p, 'doomed@example.com', '192.0.2.51'))
    const doomed = await expirePending(p, 'doomed@example.com')
    const step = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const deletion = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', p.organizationId)
        .forUpdate()
        .execute()
      // The cascade reaches the voter rows first, the poll afterwards.
      await trx
        .selectFrom('meeting_poll_voters')
        .select('id')
        .where('id', '=', doomed.id)
        .forUpdate()
        .execute()
      step.resolve()
      await proceed.promise
      await trx.deleteFrom('auth.organization').where('id', '=', p.organizationId).execute()
    })
    deletion.catch(() => step.resolve())
    await step.promise
    const page = await cleanupWhileHeld(M, async () => {
      proceed.resolve()
    })
    const settled = await Promise.allSettled([deletion])
    expect(settled.map(outcome), 'organization deletion completes').toEqual(['fulfilled'])
    expect(page.expiredReservations).toBe(0)
    expect(await pollExists(p.pollId)).toBe(false)
  }

  /**
   * A delayed worker never keeps capacity: with the sweep not run, expired reservations
   * neither take one of the 40 places nor one of an IP's three pending reservations.
   */
  async function verifyCapacityWithoutWorker(M: Modules) {
    await drain(M)
    const p = await open()
    for (const index of [1, 2, 3]) {
      await succeeds(() => enroll(M, p, `ip-${index}@example.com`, '192.0.2.61'))
      await expirePending(p, `ip-${index}@example.com`)
    }
    await succeeds(() => enroll(M, p, 'ip-4@example.com', '192.0.2.61'))
    expect(await voterCount(p, 'ip-4@example.com'), 'expired rows hold no IP allowance').toBe(1)
    const invitees = Array.from({ length: 35 }, (_, index) => `seat-${index}@example.com`)
    await succeeds(() => invite(M, p, invitees))
    // 35 invitations and one live reservation: four places are free; expired rows take none.
    await succeeds(() => enroll(M, p, 'late-1@example.com', '192.0.2.62'))
    await succeeds(() => enroll(M, p, 'late-2@example.com', '192.0.2.62'))
    await succeeds(() => enroll(M, p, 'late-3@example.com', '192.0.2.63'))
    await succeeds(() => invite(M, p, ['last-seat@example.com']))
    expect(await voterCount(p, 'last-seat@example.com'), 'expired rows hold no place').toBe(1)
    expect(await failure(() => invite(M, p, ['one-too-many@example.com']))).toMatchObject({
      code: 'poll_full',
    })
  }

  /** Deletion never fails with `poll_changed` while a voter replaces their ballot. */
  async function verifyDeleteChurn(M: Modules) {
    for (let run = 0; run < RUNS; run++) {
      const p = await open('invited')
      const token = await invitee(M, p, `churner-${run}@example.com`)
      await invitee(M, p, `bystander-${run}@example.com`)
      const voting = churn(M, p, token)
      let outcomes: string[]
      try {
        expect(await voting.replaced(1)).toBe(true)
        const seen = await revisions(p)
        const [hostOutcome] = await contenderFirst(undefined, [
          () => deletePoll(M, p, seen.host_revision),
        ])
        expect(outcome(hostOutcome), 'deletion is not refused by ballots').toBe('fulfilled')
        expect(await pollExists(p.pollId)).toBe(false)
        // The voter's next ballot finds no credential.
        expect(await voting.replaced(1)).toBe(false)
      } finally {
        outcomes = await voting.stop()
      }
      const last = outcomes.at(-1)
      expect(last, 'the deleted voter is gone').toBe('poll_not_found')
      expect(
        outcomes.slice(0, -1).every((entry) => entry === 'ok'),
        outcomes.join(),
      ).toBe(true)
    }
    // A deletion paused after its poll lock: voter and host writes queue and find nothing.
    const p = await open()
    const token = await publicVoter(M, p, 'queued@example.com', '192.0.2.71')
    const settled = await contenderFirst(
      async () => deletePoll(M, p, (await revisions(p)).host_revision, second),
      [
        () => ballot(M, p, token, ['yes', 'no'], 0),
        () => enroll(M, p, 'newcomer@example.com', '192.0.2.72'),
        () => invite(M, p, ['host-added@example.com']),
      ],
    )
    expect(settled.map(outcome)).toEqual([
      'fulfilled',
      { code: 'poll_not_found' },
      { code: 'poll_not_found' },
      { code: 'poll_not_found' },
    ])
  }

  /**
   * Poll deletion, in every state, leaves no personal data anywhere: only the receipts'
   * pseudonymous replay tombstones remain. A linked booking is preserved.
   */
  async function verifyDeletionPrivacy(M: Modules) {
    for (const state of ['open', 'closed', 'canceled', 'scheduled'] as const) {
      const p = await populated(M)
      const values = await needles(p.pollId)
      expect(values.length, 'non-vacuous').toBeGreaterThan(40)
      expect(Object.keys(await scan(values)).sort(), 'the scan sees stored data').toEqual(
        expect.arrayContaining([
          'public.meeting_poll_capabilities',
          'public.meeting_poll_deliveries',
          'public.meeting_poll_mailbox_counters',
          'public.meeting_poll_voters',
          'public.meeting_poll_votes',
        ]),
      )
      let bookingId: string | undefined
      if (state === 'closed')
        await succeeds(async () =>
          M.P.closeMeetingPoll(p.ctx, {
            id: p.pollId,
            expectedHostRevision: (await revisions(p)).host_revision,
          }),
        )
      if (state === 'canceled')
        await succeeds(async () =>
          M.P.cancelMeetingPoll(p.ctx, {
            id: p.pollId,
            expectedHostRevision: (await revisions(p)).host_revision,
          }),
        )
      if (state === 'scheduled') bookingId = await schedule(p)
      const receipts = await receiptIds(p.pollId)
      expect(receipts.length, 'create, invitations, resend and rotation receipts').toBeGreaterThan(
        5,
      )
      await succeeds(async () => deletePoll(M, p, (await revisions(p)).host_revision))
      const deletedAt = await databaseNow()
      expect(await scan(values), `personal data left after deleting a ${state} poll`).toEqual({})
      await expectTombstones(receipts, deletedAt)
      if (bookingId)
        expect(
          await db
            .selectFrom('bookings')
            .select('id')
            .where('id', '=', bookingId)
            .executeTakeFirst(),
          'the linked booking is preserved',
        ).toEqual({ id: bookingId })
    }
  }

  /**
   * Terminal polls past the installation's retention are deleted like a poll deletion;
   * younger, open and linked-booking history stays, and without a retention nothing goes.
   */
  async function verifyTerminalCleanup(M: Modules) {
    await drain(M, { terminalRetentionDays: 30 })
    const s = await teamSpace()
    const closed = await populated(M, s)
    await age(closed, 'closed', 31)
    const canceled = await populated(M, s)
    await age(canceled, 'canceled', 45)
    const abandoned = await populated(M, s)
    await age(abandoned, 'open', 31)
    // A booking takes its host's time, so each scheduled poll has its own space.
    const scheduled = await populated(M)
    const bookingId = await schedule(scheduled, 31)
    const recentlyScheduled = await populated(M)
    await schedule(recentlyScheduled, 29)
    const recent = await populated(M, s)
    await age(recent, 'closed', 29)
    const live = await populated(M, s)
    const due = [closed, canceled, abandoned, scheduled]
    const values = (await Promise.all(due.map((p) => needles(p.pollId)))).flat()
    const receipts = (await Promise.all(due.map((p) => receiptIds(p.pollId)))).flat()

    // No installation retention: terminal history stays.
    await drain(M)
    for (const p of [...due, recentlyScheduled, recent, live])
      expect(await pollExists(p.pollId)).toBe(true)

    await drain(M, { terminalRetentionDays: 30 })
    const deletedAt = await databaseNow()
    for (const p of due) expect(await pollExists(p.pollId), 'past retention').toBe(false)
    for (const p of [recentlyScheduled, recent, live])
      expect(await pollExists(p.pollId), 'within retention').toBe(true)
    expect(await scan(values), 'personal data left after terminal cleanup').toEqual({})
    await expectTombstones(receipts, deletedAt)
    // Scheduled history follows its scheduling instant; its booking is never deleted.
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', bookingId).executeTakeFirst(),
    ).toEqual({ id: bookingId })
  }

  /**
   * Deleting a linked booking deletes its poll's history first: no personal data, replay
   * tombstones only. Booking deletion and poll deletion serialize on the poll in either order.
   */
  async function verifyBookingDeletion(M: Modules) {
    const p = await populated(M)
    const bookingId = await schedule(p)
    const values = await needles(p.pollId)
    const receipts = await receiptIds(p.pollId)
    await succeeds(() => db.deleteFrom('bookings').where('id', '=', bookingId).execute())
    const deletedAt = await databaseNow()
    expect(await pollExists(p.pollId)).toBe(false)
    expect(await scan(values), 'personal data left after booking deletion').toEqual({})
    await expectTombstones(receipts, deletedAt)

    // The poll deletion first, paused in its cascade: the booking deletion waits, then
    // finds no poll and deletes the booking.
    const first = await populated(M)
    const firstBooking = await schedule(first)
    const host = (await revisions(first)).host_revision
    const pollFirst = await contenderFirst(
      () => deletePoll(M, first, host, second),
      [() => db.deleteFrom('bookings').where('id', '=', firstBooking).execute()],
    )
    expect(pollFirst.map(outcome)).toEqual(['fulfilled', 'fulfilled'])
    expect(await pollExists(first.pollId)).toBe(false)

    // The booking deletion first, paused in its cascade: the poll deletion waits for the
    // poll and then finds none.
    const later = await populated(M)
    const laterBooking = await schedule(later)
    const laterHost = (await revisions(later)).host_revision
    const bookingFirst = await contenderFirst(
      () => second.deleteFrom('bookings').where('id', '=', laterBooking).execute(),
      [() => deletePoll(M, later, laterHost)],
    )
    expect(bookingFirst.map(outcome)).toEqual(['fulfilled', { code: 'poll_not_found' }])
    expect(await pollExists(later.pollId)).toBe(false)
  }

  /**
   * Organization deletion takes the organization, then cascades. Poll deletion waits for the
   * organization before it locks the poll, so it never deadlocks with it: deletion wins.
   */
  async function verifyDeletionLockOrder(M: Modules) {
    const p = await populated(M)
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
    const work = deletePoll(M, p, host)
    work.catch(() => undefined)
    const queued = await waiters(1)
    proceed.resolve()
    const settled = await Promise.allSettled([deletion, work])
    expect(queued, 'poll deletion waits for the organization').toBe(true)
    expect(settled.map(outcome)).toEqual(['fulfilled', { code: 'team_management_access_denied' }])
  }

  // --- Behaviour ---------------------------------------------------------------------------

  const REAL: Modules = { K: Key, P: Polls, V: Voters, B: Ballots, R: Results, C: Cleanup }

  it('deletes expired public reservations and nothing else, leaving no personal data', async () => {
    await verifyExpiryCleanup(REAL)
  }, 120_000)

  it('caps every cleanup page and reports when more remain', async () => {
    await verifyBatchCaps(REAL)
  }, 120_000)

  it('skips held polls, organizations, owners and receipts without waiting', async () => {
    await verifyNeverWaits(REAL)
  }, 120_000)

  it('takes the organization before the poll, as organization deletion does', async () => {
    await verifyCleanupLockOrder(REAL)
  }, 60_000)

  it('never lets an expired reservation hold a place before the sweep runs', async () => {
    await verifyCapacityWithoutWorker(REAL)
  }, 120_000)

  it('deletes against a voter replacing their ballot every second', async () => {
    await verifyDeleteChurn(REAL)
  }, 120_000)

  it('leaves only pseudonymous replay tombstones after deleting a poll in any state', async () => {
    await verifyDeletionPrivacy(REAL)
  }, 240_000)

  it('deletes terminal polls past retention and keeps the rest', async () => {
    await verifyTerminalCleanup(REAL)
  }, 240_000)

  it('deletes poll history with its booking and serializes both deletions', async () => {
    await verifyBookingDeletion(REAL)
  }, 120_000)

  it('waits for the organization before the poll on deletion', async () => {
    await verifyDeletionLockOrder(REAL)
  }, 60_000)

  // --- Mutation checks --------------------------------------------------------------------

  const verifications = [
    verifyExpiryCleanup,
    verifyBatchCaps,
    verifyNeverWaits,
    verifyCleanupLockOrder,
    verifyCapacityWithoutWorker,
    verifyDeleteChurn,
    verifyDeletionPrivacy,
    verifyTerminalCleanup,
    verifyBookingDeletion,
    verifyDeletionLockOrder,
  ]

  it('passes every protection check through unmodified source copies', async () => {
    const copies = await sourceCopy()
    for (const verify of verifications) await verify(copies)
  }, 900_000)

  type Mutant = [string, (M: Modules) => Promise<void>, Mutation]
  const DELETE_OPENING =
    '    const poll = await lockManagedPoll(trx, ctx, request.id)\n    requireHostRevision(poll, request.expectedHostRevision)\n    const deleted = await trx\n'
  const DELETE_LOCK = '    const poll = await lockManagedPoll(trx, ctx, request.id)\n'
  /** Deletion reads `query` before its poll lock and refuses when it changed under the lock. */
  const preLock = (query: string): Replacement => [
    DELETE_OPENING,
    DELETE_OPENING.replace(
      DELETE_LOCK,
      `    const early = (await sql\`${query}\`.execute(trx)).rows[0]\n${DELETE_LOCK}    const late = (await sql\`${query}\`.execute(trx)).rows[0]\n    if (JSON.stringify(late) !== JSON.stringify(early)) throw Object.assign(new Error('poll_changed'), { code: 'poll_changed' })\n`,
    ),
  ]
  const EXPIRED_DELETE =
    '    const deleted = await sql<{ id: string }>`\n      DELETE FROM meeting_poll_voters WHERE id IN ('
  const mutants: Mutant[] = [
    [
      'cleanup waits for a poll another transaction holds',
      verifyNeverWaits,
      { cleanup: [['    ORDER BY id FOR UPDATE SKIP LOCKED`', '    ORDER BY id FOR UPDATE`']] },
    ],
    [
      'cleanup waits for an organization another transaction holds',
      verifyNeverWaits,
      { cleanup: [['    ORDER BY o.id FOR SHARE SKIP LOCKED`', '    ORDER BY o.id FOR SHARE`']] },
    ],
    [
      'cleanup waits for a personal owner another transaction holds',
      verifyNeverWaits,
      { cleanup: [['    ORDER BY u.id FOR SHARE SKIP LOCKED`', '    ORDER BY u.id FOR SHARE`']] },
    ],
    [
      'receipt purge waits for a receipt another transaction holds',
      verifyNeverWaits,
      { cleanup: [['LIMIT ${limit} FOR UPDATE SKIP LOCKED)', 'LIMIT ${limit} FOR UPDATE)']] },
    ],
    [
      'cleanup locks the poll without the organization first',
      verifyCleanupLockOrder,
      { cleanup: [['    ORDER BY o.id FOR SHARE SKIP LOCKED`', '    ORDER BY o.id`']] },
    ],
    [
      'expired cleanup has no batch cap',
      verifyBatchCaps,
      {
        cleanup: [
          [
            '        ORDER BY pending_expires_at, id LIMIT ${limit})',
            '        ORDER BY pending_expires_at, id)',
          ],
        ],
      },
    ],
    [
      'terminal cleanup has no batch cap',
      verifyBatchCaps,
      {
        cleanup: [
          [
            "WHEN 'closed' THEN closed_at ELSE deadline_at END), id\n      LIMIT ${limit}`",
            "WHEN 'closed' THEN closed_at ELSE deadline_at END), id`",
          ],
        ],
      },
    ],
    [
      'receipt purge has no batch cap',
      verifyBatchCaps,
      {
        cleanup: [
          [
            '        ORDER BY purge_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)',
            '        ORDER BY purge_at, id FOR UPDATE SKIP LOCKED)',
          ],
        ],
      },
    ],
    [
      'expiry cleanup keeps the voter row, with its name and mailbox, as a tombstone',
      verifyExpiryCleanup,
      {
        cleanup: [
          [
            '      DELETE FROM meeting_poll_voters WHERE id IN (',
            '      DELETE FROM meeting_poll_capabilities WHERE voter_id IN (',
          ],
        ],
      },
    ],
    [
      'expiry cleanup tombstones the expired mailbox',
      verifyExpiryCleanup,
      {
        cleanup: [
          [
            EXPIRED_DELETE,
            '    await sql`UPDATE meeting_poll_mailbox_counters AS c SET removed_at = ${at}::timestamptz FROM meeting_poll_voters AS v WHERE v.poll_id = c.poll_id AND v.email_key = c.email_key AND v.poll_id = ANY(${polls}::uuid[]) AND v.verified_at IS NULL AND v.invited_at IS NULL AND v.pending_expires_at <= ${at}::timestamptz`.execute(trx)\n' +
              EXPIRED_DELETE,
          ],
        ],
      },
    ],
    [
      'expiry cleanup deletes live reservations',
      verifyExpiryCleanup,
      {
        cleanup: [
          [
            '          AND pending_expires_at <= ${at}::timestamptz\n',
            "          AND pending_expires_at <= ${at}::timestamptz + interval '2 hours'\n",
          ],
        ],
      },
    ],
    [
      'terminal cleanup deletes the voters and keeps the poll',
      verifyTerminalCleanup,
      {
        cleanup: [
          [
            '      DELETE FROM meeting_polls\n',
            '      DELETE FROM meeting_poll_voters WHERE poll_id IN (SELECT id FROM meeting_polls\n',
          ],
          ['AND ${due(sql`${at}::timestamptz`)}\n', 'AND ${due(sql`${at}::timestamptz`)})\n'],
        ],
      },
    ],
    [
      'terminal cleanup ignores the retention period',
      verifyTerminalCleanup,
      {
        cleanup: [
          [
            '    <= ${at} - make_interval(days => ${retentionDays})`',
            '    <= ${at} - make_interval(days => 0)`',
          ],
        ],
      },
    ],
    [
      'capacity counts expired reservations',
      verifyCapacityWithoutWorker,
      {
        voters: [
          [
            '        OR invited_at IS NOT NULL OR pending_expires_at > ${at}::timestamptz))::text AS active,',
            '        OR invited_at IS NOT NULL OR pending_expires_at IS NOT NULL))::text AS active,',
          ],
        ],
      },
    ],
    [
      'the IP allowance counts expired reservations',
      verifyCapacityWithoutWorker,
      {
        voters: [
          [
            '      count(*) FILTER (WHERE pending_expires_at > ${at}::timestamptz\n        AND admission_ip_digest',
            '      count(*) FILTER (WHERE pending_expires_at IS NOT NULL\n        AND admission_ip_digest',
          ],
        ],
      },
    ],
    [
      'deletion checks the results revision',
      verifyDeleteChurn,
      {
        polls: [
          preLock('SELECT results_revision AS v FROM meeting_polls WHERE id = ${request.id}'),
        ],
      },
    ],
    [
      'deletion checks the ballot revisions',
      verifyDeleteChurn,
      {
        polls: [
          preLock(
            'SELECT coalesce(sum(ballot_revision), 0)::int AS v FROM meeting_poll_voters WHERE poll_id = ${request.id}',
          ),
        ],
      },
    ],
    [
      'deletion locks the poll before the organization',
      verifyDeletionLockOrder,
      {
        polls: [
          [
            DELETE_OPENING,
            `    await trx.selectFrom('meeting_polls').select('id').where('id', '=', request.id).forUpdate().execute()\n${DELETE_OPENING}`,
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
    300_000,
  )

  /** A foreign key of `table` to `target`, dropped; restore deletes orphans and re-adds it. */
  async function dropForeignKey(table: string, target: string) {
    const { rows } = await sql<{ name: string; definition: string }>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = ${table}::regclass AND confrelid = ${target}::regclass
        AND contype = 'f'`.execute(db)
    expect(rows, `one ${table} foreign key to ${target}`).toHaveLength(1)
    const [{ name, definition }] = rows as [(typeof rows)[number]]
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.ref(name)}`.execute(db)
    return async () => {
      const parent = target === 'meeting_polls' ? 'poll_id' : 'voter_id'
      await sql`DELETE FROM ${sql.table(table)} AS child WHERE NOT EXISTS (
        SELECT 1 FROM ${sql.table(target)} AS parent WHERE parent.id = child.${sql.ref(parent)})`.execute(
        db,
      )
      await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.ref(name)} ${sql.raw(definition)}`.execute(
        db,
      )
    }
  }

  /** Database cascades the services rely on, each broken in this throwaway database. */
  const schemaMutants: [
    string,
    (M: Modules) => Promise<void>,
    () => Promise<() => Promise<void>>,
  ][] = [
    [
      'mailbox counters outlive their poll',
      verifyDeletionPrivacy,
      () => dropForeignKey('meeting_poll_mailbox_counters', 'meeting_polls'),
    ],
    [
      'credentials outlive their expired voter',
      verifyExpiryCleanup,
      () => dropForeignKey('meeting_poll_capabilities', 'meeting_poll_voters'),
    ],
    [
      'booking deletion keeps its poll history',
      verifyBookingDeletion,
      async () => {
        await sql`DROP TRIGGER bookings_meeting_poll_privacy ON bookings`.execute(db)
        return async () => {
          await sql`CREATE TRIGGER bookings_meeting_poll_privacy BEFORE DELETE ON bookings
            FOR EACH ROW EXECUTE FUNCTION delete_booking_meeting_poll()`.execute(db)
        }
      },
    ],
  ]

  it.each(schemaMutants)(
    'detects the schema mutation: %s',
    async (_name, verify, mutate) => {
      const restore = await mutate()
      try {
        await expect(verify(REAL)).rejects.toMatchObject({ name: 'AssertionError' })
      } finally {
        await restore()
      }
    },
    300_000,
  )
})
