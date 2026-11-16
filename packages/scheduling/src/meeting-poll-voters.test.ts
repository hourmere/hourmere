// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-copy mutations target literal template strings
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
type VoterModule = typeof Voters
const SECRET = 'meeting-poll-voter-test-secret-0123456789'

/** Imports an isolated copy of the voter services; the production file is never overwritten. */
async function sourceCopy(...replacements: (readonly [string, string])[]): Promise<VoterModule> {
  const location = new URL('./meeting-poll-voters.ts', import.meta.url)
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.includes(from), `mutation must match source: ${from}`).toBe(true)
    source = source.replace(from, to)
  }
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`)
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

describe.skipIf(!serverUrl)('meeting poll enrollment and verification', () => {
  let owned: TestDatabase
  let db: Db
  let fixtures: ReturnType<typeof createFixtures>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_voters' })
    db = createDb(owned.pool)
    fixtures = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  // --- Fixtures ---------------------------------------------------------------------------

  async function databaseNow() {
    const { rows } = await sql<{
      now: string
    }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`.execute(
      db,
    )
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

  type Space = Awaited<ReturnType<typeof space>>
  type PollSpace = Awaited<ReturnType<typeof open>>

  /** A team whose admin manages an event hosted by an ordinary member who is always free. */
  async function space() {
    const admin = await createTestUser(db, 'Team Admin')
    const member = await createTestUser(db, 'Configured Host')
    for (const user of [admin, member]) await fixtures.schedule(user.id, ALWAYS)
    const t = await createTestTeam(db, [
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const eventTypeId = await fixtures.eventType(t.id, null, { hosts: [{ userId: member.id }] })
    const as = (user: TestUser): Voters.MeetingPollHostContext => ({
      ...testContext(db, session(t.as(user))),
      meetingPollSecret: SECRET,
    })
    return { organizationId: t.id, eventTypeId, ctx: as(admin), memberCtx: as(member) }
  }

  /** An open poll about a day before its deadline, created through the host service. */
  async function open(admissionMode: 'public_link' | 'invited' = 'public_link') {
    const s: Space = await space()
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
    return { ...s, pollId: created.poll.id, link: created.publicToken as string }
  }

  const pub = (ip = '192.0.2.10'): Voters.MeetingPollPublicContext => ({
    db,
    meetingPollSecret: SECRET,
    trustedIp: ip,
  })

  function enroll(M: VoterModule, p: PollSpace, email: string, ip = '192.0.2.10') {
    return M.enrollMeetingPollVoter(pub(ip), {
      publicToken: p.link,
      name: 'Public Voter',
      email,
      timeZone: 'Europe/Berlin',
    })
  }

  function invite(M: VoterModule, p: PollSpace, emails: string[], key = randomUUID()) {
    return M.inviteMeetingPollVoters(p.ctx, {
      id: p.pollId,
      invitees: emails.map((email) => ({ name: 'Invited Voter', email })),
      idempotencyKey: key,
    })
  }

  function recover(M: VoterModule, p: PollSpace, email: string) {
    return M.recoverMeetingPollVoter(pub(), { pollId: p.pollId, email })
  }

  async function resend(M: VoterModule, p: PollSpace, email: string, key = randomUUID()) {
    const row = await voter(p, email)
    return M.resendMeetingPollInvitation(p.ctx, {
      id: p.pollId,
      voterId: row.id,
      expectedHostRevision: (await revisions(p)).host_revision,
      idempotencyKey: key,
    })
  }

  async function voter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_voters')
      .selectAll()
      .select([
        sql<boolean>`pending_expires_at - created_at = interval '1 hour'`.as('hourLong'),
        sql<string | null>`pending_expires_at::text`.as('pending'),
      ])
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow()
  }

  async function maybeVoter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_voters')
      .select('id')
      .where('poll_id', '=', p.pollId)
      .where('email', '=', email)
      .executeTakeFirst()
  }

  async function credentials(voterId: string) {
    return db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .select(sql<string>`expires_at::text`.as('expires'))
      .where('voter_id', '=', voterId)
      .orderBy('generation')
      .orderBy('id')
      .execute()
  }

  async function deliveries(p: PollSpace, voterId?: string) {
    return db
      .selectFrom('meeting_poll_deliveries')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .$if(voterId !== undefined, (query) => query.where('voter_id', '=', voterId as string))
      .orderBy('id')
      .execute()
  }

  async function counter(p: PollSpace, email: string) {
    return db
      .selectFrom('meeting_poll_mailbox_counters')
      .selectAll()
      .where('poll_id', '=', p.pollId)
      .where('email_key', '=', Voters.meetingPollMailboxKey(SECRET, p.pollId, email))
      .executeTakeFirst()
  }

  async function revisions(p: PollSpace) {
    return db
      .selectFrom('meeting_polls')
      .select(['host_revision', 'results_revision', sql<string>`deadline_at::text`.as('deadline')])
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()
  }

  /** Places in use now: active verified voters, active invitations and live reservations. */
  async function places(p: PollSpace) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM meeting_poll_voters
      WHERE poll_id = ${p.pollId} AND withdrawn_at IS NULL AND (verified_at IS NOT NULL
        OR invited_at IS NOT NULL OR pending_expires_at > clock_timestamp())`.execute(db)
    return Number(rows[0]?.n)
  }

  function opened(
    p: PollSpace,
    row: { voter_id: string | null; generation: number },
    ct: Buffer | null,
  ) {
    return Voters.openMeetingPollCredential(
      SECRET,
      {
        organizationId: p.organizationId,
        pollId: p.pollId,
        voterId: row.voter_id as string,
        generation: row.generation,
      },
      ct,
    )
  }

  /** The credential carried by a mailbox's newest queued mail. */
  async function mailed(p: PollSpace, email: string) {
    const row = await voter(p, email)
    const [delivery] = (await deliveries(p, row.id))
      .filter((entry) => entry.capability_ciphertext !== null)
      .reverse()
    if (!delivery) return expect.unreachable(`no mail queued for ${email}`)
    const credential = opened(p, delivery, delivery.capability_ciphertext)
    if (!credential) return expect.unreachable(`mail for ${email} does not open`)
    return { ...credential, delivery, voter: row }
  }

  /** Move a public reservation and its verification credential an hour into the past. */
  async function expirePending(p: PollSpace, email: string) {
    const row = await voter(p, email)
    const now = await databaseNow()
    const values = {
      created_at: now.subtract({ hours: 2 }).toString(),
      expires: now.subtract({ minutes: 61 }).toString(),
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
  }

  async function withdraw(p: PollSpace, email: string) {
    await sql`UPDATE meeting_poll_voters SET withdrawn_at = clock_timestamp(),
      ballot_submitted_at = NULL, responses = '{}', join_consent_at = NULL,
      admission_ip_digest = NULL WHERE poll_id = ${p.pollId} AND email = ${email}`.execute(db)
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

  /** Public reservations from three addresses per IP, as many as `count`. */
  async function fill(M: VoterModule, p: PollSpace, count: number, prefix: string) {
    for (let i = 0; i < count; i++)
      await succeeds(() =>
        enroll(M, p, `${prefix}-${i}@example.com`, `198.51.100.${Math.floor(i / 3) + 1}`),
      )
  }

  /** A checksum of every row that belongs to the poll, so that any write is noticed. */
  async function snapshot(p: PollSpace) {
    const { rows } = await sql<{ checksum: string }>`SELECT md5(concat_ws('|',
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_polls t WHERE t.id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_voters t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_capabilities t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_deliveries t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_mailbox_counters t WHERE t.poll_id = ${p.pollId}),
      (SELECT string_agg(t::text, ',' ORDER BY t.id) FROM meeting_poll_operations t WHERE t.poll_id = ${p.pollId})
    )) AS checksum`.execute(db)
    return rows[0]?.checksum
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
      await new Promise((resolve) => setTimeout(resolve, 25))
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

  /** Hold the poll row, queue `first` then `second` on it, then release them in that order. */
  async function queued<A, B>(p: PollSpace, first: () => Promise<A>, second: () => Promise<B>) {
    const release = await holding((trx) =>
      trx.selectFrom('meeting_polls').select('id').where('id', '=', p.pollId).forUpdate().execute(),
    )
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
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('expected a lock waiter or a settled operation')
  }

  const outcome = (result: PromiseSettledResult<unknown>) =>
    result.status === 'rejected'
      ? { code: (result.reason as { code?: string }).code }
      : ('fulfilled' as const)

  // --- Checks shared by the real module and its mutated source copies ---------------------

  /** A public enrollment reserves one place for an hour and queues only verification mail. */
  async function verifyEnrollment(M: VoterModule) {
    const p = await open()
    expect(
      await succeeds(() =>
        M.enrollMeetingPollVoter(pub(), {
          publicToken: p.link,
          name: ' Alice ',
          email: '  Alice@Example.COM ',
          timeZone: 'America/New_York',
          locale: 'de',
        }),
      ),
    ).toEqual({ accepted: true })
    const row = await voter(p, 'alice@example.com')
    expect(row).toMatchObject({
      name: 'Alice',
      time_zone: 'America/New_York',
      locale: 'de',
      verified_at: null,
      invited_at: null,
      withdrawn_at: null,
      hourLong: true,
    })
    expect(
      row.email_key.equals(Voters.meetingPollMailboxKey(SECRET, p.pollId, 'alice@example.com')),
    ).toBe(true)
    expect(row.admission_ip_digest).not.toBeNull()
    const [credential, ...others] = await credentials(row.id)
    expect(others).toEqual([])
    expect(credential).toMatchObject({
      purpose: 'verification',
      generation: 1,
      expires: row.pending,
      revoked_at: null,
      consumed_at: null,
    })
    const mail = await deliveries(p)
    expect(
      mail.map((entry) => [entry.kind, entry.generation, entry.sequence, entry.state]),
    ).toEqual([['verification', 1, 0, 'pending']])
    const sent = await mailed(p, 'alice@example.com')
    expect(sent.purpose).toBe('verification')
    expect(
      Voters.meetingPollCapabilityDigest('verification', sent.token).equals(
        credential?.token_digest as Buffer,
      ),
    ).toBe(true)
    expect(await counter(p, 'alice@example.com')).toMatchObject({
      recovery_count: 0,
      resend_count: 0,
      removed_at: null,
    })
    // Admission changes the results, never the host revision.
    expect(await revisions(p)).toMatchObject({ host_revision: 1, results_revision: 2 })

    // An unknown, malformed or rotated link admits nobody.
    for (const publicToken of ['x', randomBytes(32).toString('base64url')])
      expect(
        await failure(() =>
          M.enrollMeetingPollVoter(pub(), {
            publicToken,
            name: 'Nobody',
            email: 'nobody@example.com',
            timeZone: 'UTC',
          }),
        ),
      ).toMatchObject({ kind: 'not_found', code: 'poll_not_found' })
    const rotated = await Polls.rotateMeetingPollLink(p.ctx, {
      id: p.pollId,
      expectedHostRevision: 1,
      idempotencyKey: randomUUID(),
    })
    expect(await failure(() => enroll(M, p, 'late@example.com'))).toMatchObject({
      code: 'poll_not_found',
    })
    await succeeds(() =>
      enroll(M, { ...p, link: rotated.publicToken as string }, 'new@example.com'),
    )
    expect(await failure(() => enroll(M, p, 'not an address'))).toMatchObject({
      kind: 'invalid',
      code: 'invalid_voter',
    })

    // Closed, canceled, past-deadline and deleted-event polls admit nobody.
    const closed = await open()
    await Polls.closeMeetingPoll(closed.ctx, { id: closed.pollId, expectedHostRevision: 1 })
    expect(await failure(() => enroll(M, closed, 'a@example.com'))).toMatchObject({
      code: 'poll_closed',
    })
    const canceled = await open()
    await Polls.cancelMeetingPoll(canceled.ctx, { id: canceled.pollId, expectedHostRevision: 1 })
    expect(await failure(() => enroll(M, canceled, 'a@example.com'))).toMatchObject({
      code: 'poll_canceled',
    })
    const late = await open()
    await pastDeadline(late)
    expect(await failure(() => enroll(M, late, 'a@example.com'))).toMatchObject({
      code: 'poll_closed',
    })
    const deleted = await open()
    await enroll(M, deleted, 'pending@example.com')
    await invite(M, deleted, ['invitee@example.com'])
    const pendingMail = await mailed(deleted, 'pending@example.com')
    const invitationMail = await mailed(deleted, 'invitee@example.com')
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', deleted.eventTypeId)
      .execute()
    expect(await failure(() => enroll(M, deleted, 'a@example.com'))).toMatchObject({
      code: 'poll_closed',
    })
    expect(await failure(() => invite(M, deleted, ['a@example.com']))).toMatchObject({
      code: 'poll_closed',
    })
    // Verification and resend are refused too; recovery answers alike and sends nothing.
    const untouched = await snapshot(deleted)
    for (const { token } of [pendingMail, invitationMail])
      expect(await failure(() => M.verifyMeetingPollVoter(pub(), { token }))).toMatchObject({
        kind: 'conflict',
        code: 'poll_closed',
      })
    expect(await failure(() => resend(M, deleted, 'invitee@example.com'))).toMatchObject({
      kind: 'conflict',
      code: 'poll_closed',
    })
    for (const email of ['pending@example.com', 'invitee@example.com'])
      expect(await succeeds(() => recover(M, deleted, email))).toEqual({ accepted: true })
    expect(await snapshot(deleted)).toBe(untouched)
  }

  /**
   * Enrollment answers 202 alike for new, pending, verified, invited, withdrawn and removed
   * mailboxes and writes nothing for known ones; once full, every enrollment gets the same
   * 409 `poll_full` and writes nothing.
   */
  async function verifyUniformity(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'verified@example.com', '192.0.2.1')
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'verified@example.com')).token,
    })
    await enroll(M, p, 'pending@example.com', '192.0.2.2')
    await enroll(M, p, 'expired@example.com', '192.0.2.3')
    await expirePending(p, 'expired@example.com')
    await invite(M, p, ['invited@example.com'])
    await enroll(M, p, 'withdrawn@example.com', '192.0.2.4')
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'withdrawn@example.com')).token,
    })
    await withdraw(p, 'withdrawn@example.com')
    await enroll(M, p, 'removed@example.com', '192.0.2.5')
    await remove(p, 'removed@example.com')
    const known = ['verified', 'pending', 'invited', 'withdrawn', 'removed'].map(
      (name) => `${name}@example.com`,
    )
    const before = await snapshot(p)
    for (const email of known)
      expect(await succeeds(() => enroll(M, p, email, '192.0.2.9'))).toEqual({ accepted: true })
    expect(await snapshot(p)).toBe(before)
    // From an IP holding three live reservations, every mailbox state gets the same 429,
    // decided before the mailbox is looked at, and nothing is written.
    for (const name of ['a', 'b', 'c'])
      await succeeds(() => enroll(M, p, `ip-${name}@example.com`, '192.0.2.88'))
    const limited = await snapshot(p)
    const refusals = []
    for (const email of [...known, 'expired@example.com', 'fresh@example.com'])
      refusals.push(await failure(() => enroll(M, p, email, '192.0.2.88')))
    expect(refusals[0]).toMatchObject({ name: 'MeetingPollRateLimitError', code: 'rate_limited' })
    expect(
      new Set(refusals.map(({ retryAfterSeconds: _, ...rest }) => JSON.stringify(rest))).size,
    ).toBe(1)
    // Retry-After follows the IP's earliest reservation, so it differs at most by a tick.
    const waits = refusals.map((refusal) => refusal.retryAfterSeconds ?? 0)
    expect(Math.min(...waits)).toBeGreaterThan(3500)
    expect(Math.max(...waits) - Math.min(...waits)).toBeLessThanOrEqual(1)
    expect(await snapshot(p)).toBe(limited)
    const expiredId = (await voter(p, 'expired@example.com')).id
    expect(await succeeds(() => enroll(M, p, 'expired@example.com', '192.0.2.9'))).toEqual({
      accepted: true,
    })
    expect((await voter(p, 'expired@example.com')).id).not.toBe(expiredId)
    expect(await places(p)).toBe(7)
    await fill(M, p, 33, 'filler')
    expect(await places(p)).toBe(40)
    const full = await snapshot(p)
    const answers = []
    for (const email of [...known, 'expired@example.com', 'fresh@example.com'])
      answers.push(await failure(() => enroll(M, p, email, '192.0.2.99')))
    expect(answers[0]).toMatchObject({ kind: 'conflict', code: 'poll_full' })
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1)
    expect(await snapshot(p)).toBe(full)
  }

  /** Forty places: verified, invited and live reservations count; expired and withdrawn do not. */
  async function verifyCapacity(M: VoterModule) {
    const p = await open()
    await invite(
      M,
      p,
      Array.from({ length: 20 }, (_, i) => `invitee-${i}@example.com`),
    )
    await fill(M, p, 19, 'public')
    expect(await places(p)).toBe(39)
    await succeeds(() => enroll(M, p, 'fortieth@example.com', '203.0.113.1'))
    expect(
      await failure(() => enroll(M, p, 'one-too-many@example.com', '203.0.113.1')),
    ).toMatchObject({
      code: 'poll_full',
    })
    // An expired reservation stops counting at once, before any cleanup.
    await expirePending(p, 'public-0@example.com')
    await succeeds(() => enroll(M, p, 'one-too-many@example.com', '203.0.113.1'))
    expect(await places(p)).toBe(40)
    // A withdrawn voter frees its place.
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'public-1@example.com')).token,
    })
    await withdraw(p, 'public-1@example.com')
    await succeeds(() => enroll(M, p, 'after-withdrawal@example.com', '203.0.113.2'))
    expect(await places(p)).toBe(40)
    expect(
      await failure(() => enroll(M, p, 'still-full@example.com', '203.0.113.2')),
    ).toMatchObject({
      code: 'poll_full',
    })
  }

  /** At most three live public reservations per trusted IP (IPv6 by /64) and poll. */
  async function verifyIpCap(M: VoterModule) {
    const p = await open()
    for (const name of ['a', 'b', 'c'])
      await succeeds(() => enroll(M, p, `${name}@example.com`, '192.0.2.50'))
    const limited = await failure(() => enroll(M, p, 'd@example.com', '192.0.2.50'))
    expect(limited).toMatchObject({ code: 'rate_limited' })
    expect(limited.retryAfterSeconds).toBeGreaterThan(3500)
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600)
    expect(await maybeVoter(p, 'd@example.com')).toBeUndefined()
    await succeeds(() => enroll(M, p, 'd@example.com', '192.0.2.51'))
    // Verification frees the allowance; so does expiry.
    await M.verifyMeetingPollVoter(pub(), { token: (await mailed(p, 'a@example.com')).token })
    await succeeds(() => enroll(M, p, 'e@example.com', '192.0.2.50'))
    expect(await failure(() => enroll(M, p, 'f@example.com', '192.0.2.50'))).toMatchObject({
      code: 'rate_limited',
    })
    await expirePending(p, 'b@example.com')
    await succeeds(() => enroll(M, p, 'f@example.com', '192.0.2.50'))
    // Host invitations bypass the IP cap.
    await succeeds(() => invite(M, p, ['g@example.com', 'h@example.com']))
    for (const [index, ip] of [
      '2001:db8:1:2::1',
      '2001:db8:1:2::2',
      '2001:db8:1:2:ffff::3',
    ].entries())
      await succeeds(() => enroll(M, p, `six-${index}@example.com`, ip))
    expect(await failure(() => enroll(M, p, 'six-3@example.com', '2001:db8:1:2::4'))).toMatchObject(
      {
        code: 'rate_limited',
      },
    )
    await succeeds(() => enroll(M, p, 'six-3@example.com', '2001:db8:1:3::4'))
  }

  /** A batch whose new places do not all fit writes nothing; places it does not need are free. */
  async function verifyBatch(M: VoterModule) {
    const p = await open()
    await invite(
      M,
      p,
      Array.from({ length: 37 }, (_, i) => `invitee-${i}@example.com`),
    )
    await enroll(M, p, 'pending@example.com')
    expect(await places(p)).toBe(38)
    const before = await snapshot(p)
    const tooMany = ['pending@example.com', 'n1@example.com', 'n2@example.com', 'n3@example.com']
    expect(await failure(() => invite(M, p, tooMany))).toMatchObject({
      kind: 'conflict',
      code: 'poll_full',
    })
    expect(await snapshot(p)).toBe(before)
    expect(
      await failure(() =>
        invite(
          M,
          p,
          Array.from({ length: 41 }, (_, i) => `batch-${i}@example.com`),
        ),
      ),
    ).toMatchObject({ kind: 'invalid', code: 'poll_limit_exceeded' })
    expect(await snapshot(p)).toBe(before)
    const fits = await succeeds(() =>
      invite(M, p, ['pending@example.com', 'n1@example.com', 'N1@Example.com ', 'n2@example.com']),
    )
    expect(fits.entries.map((entry) => [entry.email, entry.outcome])).toEqual([
      ['pending@example.com', 'upgraded'],
      ['n1@example.com', 'invited'],
      ['n2@example.com', 'invited'],
    ])
    expect(await places(p)).toBe(40)
    // A full poll still accepts a batch that needs no new place.
    const known = await succeeds(() => invite(M, p, ['n1@example.com', 'invitee-0@example.com']))
    expect(known.entries.map((entry) => entry.outcome)).toEqual(['unchanged', 'unchanged'])
  }

  /** Invitation outcomes for each mailbox state, under the poll lock. */
  async function verifyInvitationOutcomes(M: VoterModule) {
    const p = await open()
    await invite(M, p, ['invited@example.com', 'confirmed@example.com'])
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'confirmed@example.com')).token,
    })
    await enroll(M, p, 'verified@example.com', '192.0.2.1')
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'verified@example.com')).token,
    })
    await enroll(M, p, 'pending@example.com', '192.0.2.2')
    await enroll(M, p, 'expired@example.com', '192.0.2.3')
    await expirePending(p, 'expired@example.com')
    await enroll(M, p, 'withdrawn@example.com', '192.0.2.4')
    await M.verifyMeetingPollVoter(pub(), {
      token: (await mailed(p, 'withdrawn@example.com')).token,
    })
    await withdraw(p, 'withdrawn@example.com')
    await invite(M, p, ['removed@example.com'])
    await remove(p, 'removed@example.com')
    const unchanged = ['invited', 'confirmed', 'verified', 'withdrawn'].map(
      (name) => `${name}@example.com`,
    )
    const kept = new Map<string, unknown>()
    for (const email of unchanged) {
      const row = await voter(p, email)
      kept.set(email, {
        row,
        credentials: await credentials(row.id),
        mail: await deliveries(p, row.id),
      })
    }
    const pending = await mailed(p, 'pending@example.com')
    const expired = await mailed(p, 'expired@example.com')
    const { host_revision, results_revision } = await revisions(p)
    const result = await succeeds(() =>
      invite(M, p, [
        ...unchanged,
        'pending@example.com',
        'expired@example.com',
        'removed@example.com',
      ]),
    )
    expect(result.replayed).toBe(false)
    expect(result.entries.map((entry) => [entry.email, entry.outcome, entry.status])).toEqual([
      ['invited@example.com', 'unchanged', 'invited'],
      ['confirmed@example.com', 'unchanged', 'verified'],
      ['verified@example.com', 'unchanged', 'verified'],
      ['withdrawn@example.com', 'unchanged', 'withdrawn'],
      ['pending@example.com', 'upgraded', 'invited'],
      ['expired@example.com', 'invited', 'invited'],
      ['removed@example.com', 'invited', 'invited'],
    ])
    expect(JSON.stringify(result)).not.toContain(pending.token)
    // Unchanged mailboxes keep their row, credential and mail exactly.
    for (const email of unchanged) {
      const row = await voter(p, email)
      expect({
        row,
        credentials: await credentials(row.id),
        mail: await deliveries(p, row.id),
      }).toEqual(kept.get(email))
    }
    // The live reservation becomes the invitation in its place.
    const upgraded = await voter(p, 'pending@example.com')
    expect(upgraded).toMatchObject({
      id: pending.voter.id,
      pending_expires_at: null,
      admission_ip_digest: null,
      verified_at: null,
    })
    expect(upgraded.invited_at).not.toBeNull()
    const [verification, voting] = await credentials(upgraded.id)
    expect(verification).toMatchObject({ purpose: 'verification', capability_ciphertext: null })
    expect(verification?.revoked_at).not.toBeNull()
    expect(voting).toMatchObject({ purpose: 'voting', generation: 2, revoked_at: null })
    expect(voting?.expires).toBe((await revisions(p)).deadline)
    expect(
      (await deliveries(p, upgraded.id)).map((entry) => [
        entry.kind,
        entry.generation,
        entry.state,
      ]),
    ).toEqual([
      ['verification', 1, 'skipped'],
      ['invitation', 2, 'pending'],
    ])
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: pending.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
    const invitation = await mailed(p, 'pending@example.com')
    expect(invitation.purpose).toBe('voting')
    expect(
      (await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: invitation.token }))).voter
        .status,
    ).toBe('verified')
    // The expired reservation is replaced by a new voter; its old credential is gone.
    expect((await voter(p, 'expired@example.com')).id).not.toBe(expired.voter.id)
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: expired.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
    // The host's explicit invitation clears a removal tombstone and spends one resend.
    const reinvited = await counter(p, 'removed@example.com')
    expect(reinvited).toMatchObject({ removed_at: null, resend_count: 1 })
    expect(reinvited?.last_resend_at).toEqual(reinvited?.updated_at)
    expect(await revisions(p)).toMatchObject({
      host_revision: host_revision + 1,
      results_revision: results_revision + 2,
    })
    expect(await places(p)).toBe(6)
  }

  /** Explicit verification: public credentials are consumed and replaced once; repeats mint nothing. */
  async function verifyVerification(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'public@example.com')
    const { token } = await mailed(p, 'public@example.com')
    const first = await succeeds(() => M.verifyMeetingPollVoter(pub(), { token }))
    expect(first.voter).toMatchObject({
      pollId: p.pollId,
      email: 'public@example.com',
      status: 'verified',
    })
    expect(first.votingToken).toEqual(expect.any(String))
    const row = await voter(p, 'public@example.com')
    expect(row).toMatchObject({ pending_expires_at: null, admission_ip_digest: null })
    expect(row.verified_at).not.toBeNull()
    const [verification, voting, ...rest] = await credentials(row.id)
    expect(rest).toEqual([])
    expect(verification).toMatchObject({
      purpose: 'verification',
      capability_ciphertext: null,
      revoked_at: null,
    })
    expect(verification?.consumed_at).not.toBeNull()
    expect(voting).toMatchObject({
      purpose: 'voting',
      generation: 2,
      revoked_at: null,
      consumed_at: null,
    })
    expect(voting?.expires).toBe((await revisions(p)).deadline)
    expect(
      Voters.meetingPollCapabilityDigest('voting', first.votingToken as string).equals(
        voting?.token_digest as Buffer,
      ),
    ).toBe(true)
    expect(
      opened(p, { voter_id: row.id, generation: 2 }, voting?.capability_ciphertext ?? null),
    ).toEqual({
      purpose: 'voting',
      token: first.votingToken,
    })
    // The voting credential is also mailed; the verification link's mail is skipped.
    expect(
      (await deliveries(p)).map((entry) => [entry.kind, entry.generation, entry.state]),
    ).toEqual([
      ['verification', 1, 'skipped'],
      ['verification', 2, 'pending'],
    ])
    expect(await revisions(p)).toMatchObject({ host_revision: 1, results_revision: 3 })
    // Repeats return the state without minting or extending anything.
    const before = await snapshot(p)
    for (const again of [token, first.votingToken as string])
      expect(await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: again }))).toEqual({
        voter: first.voter,
        votingToken: null,
      })
    expect(await snapshot(p)).toBe(before)

    // An invitee verifies with the emailed voting credential, which stays the same.
    await invite(M, p, ['invitee@example.com'])
    const invitation = await mailed(p, 'invitee@example.com')
    const invitee = await succeeds(() =>
      M.verifyMeetingPollVoter(pub(), { token: invitation.token }),
    )
    expect(invitee).toMatchObject({ voter: { status: 'verified' }, votingToken: null })
    expect(await credentials(invitation.voter.id)).toHaveLength(1)

    // Only verification and voting credentials verify, and only by their own digest.
    const optOut = randomBytes(32).toString('base64url')
    await db
      .insertInto('meeting_poll_capabilities')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        voter_id: invitation.voter.id,
        purpose: 'reminder_opt_out',
        token_digest: Voters.meetingPollCapabilityDigest('voting', optOut),
        expires_at: (await revisions(p)).deadline,
      })
      .execute()
    for (const bad of [optOut, randomBytes(32).toString('base64url'), 'short'])
      expect(await failure(() => M.verifyMeetingPollVoter(pub(), { token: bad }))).toMatchObject({
        kind: 'not_found',
        code: 'poll_not_found',
      })
    // Verification needs open voting.
    await Polls.closeMeetingPoll(p.ctx, {
      id: p.pollId,
      expectedHostRevision: (await revisions(p)).host_revision,
    })
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: invitation.token })),
    ).toMatchObject({
      code: 'poll_closed',
    })
  }

  /**
   * A public enrollee's verification mails the new voting credential once, at that
   * credential's generation, and restarts the mailbox's recovery count. Repeats and invitee
   * verifications mail nothing; a mailbox that spent its recovery allowance verifies alike.
   */
  async function verifyVerificationMail(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'public@example.com', '192.0.2.1')
    const enrolled = await mailed(p, 'public@example.com')
    // One lost-mail recovery first, so that the restart is visible.
    await succeeds(() => recover(M, p, 'public@example.com'))
    expect(await counter(p, 'public@example.com')).toMatchObject({ recovery_count: 1 })
    const first = await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: enrolled.token }))
    expect(first.votingToken).toEqual(expect.any(String))
    const voting = (await credentials(enrolled.voter.id)).filter((row) => row.purpose === 'voting')
    expect(voting).toHaveLength(1)
    const sent = await deliveries(p, enrolled.voter.id)
    expect(
      sent.map((entry) => [entry.kind, entry.generation, entry.sequence, entry.state]),
    ).toEqual([
      ['verification', 1, 0, 'skipped'],
      ['recovery', 1, 0, 'skipped'],
      ['verification', 2, 0, 'pending'],
    ])
    const mail = sent[2] as (typeof sent)[number]
    expect(mail.generation).toBe(voting[0]?.generation)
    expect(opened(p, mail, mail.capability_ciphertext)).toEqual({
      purpose: 'voting',
      token: first.votingToken,
    })
    // The mail carries the retained copy of exactly that credential.
    expect(mail.capability_ciphertext?.equals(voting[0]?.capability_ciphertext as Buffer)).toBe(
      true,
    )
    expect(await counter(p, 'public@example.com')).toMatchObject({
      recovery_count: 0,
      last_recovery_at: null,
      resend_count: 0,
    })
    // Repeats with either credential mint and mail nothing.
    const settled = await snapshot(p)
    for (const again of [enrolled.token, first.votingToken as string])
      expect(await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: again }))).toEqual({
        voter: first.voter,
        votingToken: null,
      })
    expect(await snapshot(p)).toBe(settled)
    // Recovery stays for genuinely lost mail and re-delivers the mailed voting credential.
    await succeeds(() => recover(M, p, 'public@example.com'))
    const recovered = await mailed(p, 'public@example.com')
    expect([recovered.delivery.kind, recovered.delivery.generation, recovered.token]).toEqual([
      'recovery',
      2,
      first.votingToken,
    ])

    // An invitee's emailed voting credential stays the same, so nothing new is mailed.
    await invite(M, p, ['invitee@example.com'])
    const invitation = await mailed(p, 'invitee@example.com')
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    const inviteeMail = await deliveries(p, invitation.voter.id)
    const inviteeCounter = await counter(p, 'invitee@example.com')
    expect(
      await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: invitation.token })),
    ).toMatchObject({ voter: { status: 'verified' }, votingToken: null })
    expect(await deliveries(p, invitation.voter.id)).toEqual(inviteeMail)
    expect(await counter(p, 'invitee@example.com')).toEqual(inviteeCounter)
    expect(await credentials(invitation.voter.id)).toHaveLength(1)

    // A mailbox whose recovery allowance is spent still verifies and gets its mail; the
    // answer is shaped exactly like a fresh mailbox's and says nothing about the counters.
    await enroll(M, p, 'spent@example.com', '192.0.2.2')
    await enroll(M, p, 'fresh@example.com', '192.0.2.3')
    const spent = await mailed(p, 'spent@example.com')
    const fresh = await mailed(p, 'fresh@example.com')
    const cooled = sql`UPDATE meeting_poll_mailbox_counters
      SET last_recovery_at = clock_timestamp() - interval '16 minutes'
      WHERE poll_id = ${p.pollId}
        AND email_key = ${Voters.meetingPollMailboxKey(SECRET, p.pollId, 'spent@example.com')}`
    for (let i = 0; i < 4; i++) {
      await succeeds(() => recover(M, p, 'spent@example.com'))
      await cooled.execute(db)
    }
    expect(await deliveries(p, spent.voter.id)).toHaveLength(4)
    expect(await counter(p, 'spent@example.com')).toMatchObject({ recovery_count: 3 })
    const spentAnswer = await succeeds(() =>
      M.verifyMeetingPollVoter(pub(), { token: spent.token }),
    )
    const freshAnswer = await succeeds(() =>
      M.verifyMeetingPollVoter(pub(), { token: fresh.token }),
    )
    const shape = (answer: Voters.VerifyMeetingPollVoterResult) => ({
      ...answer,
      voter: { ...answer.voter, voterId: 'voter', email: 'mailbox' },
      votingToken: typeof answer.votingToken,
    })
    expect(shape(spentAnswer)).toEqual(shape(freshAnswer))
    expect(shape(spentAnswer).votingToken).toBe('string')
    expect(
      (await deliveries(p, spent.voter.id))
        .filter((entry) => entry.state === 'pending')
        .map((entry) => [entry.kind, entry.generation, entry.sequence]),
    ).toEqual([['verification', 2, 0]])
    expect(await counter(p, 'spent@example.com')).toMatchObject({
      recovery_count: 0,
      last_recovery_at: null,
    })
  }

  /**
   * A retained or queued credential opens only under its own organization, poll, voter and
   * generation; a ciphertext copied to another delivery row never opens there. Everything
   * here goes through the module under test, so its own binding is what is checked.
   */
  async function verifyCredentialBinding(M: VoterModule) {
    const p = await open()
    const elsewhere = await open()
    await invite(M, p, ['first@example.com', 'second@example.com'])
    const firstVoter = await voter(p, 'first@example.com')
    const secondVoter = await voter(p, 'second@example.com')
    const queuedFor = async (voterId: string) => {
      const rows = await deliveries(p, voterId)
      return rows[rows.length - 1] as (typeof rows)[number]
    }
    const binding = (row: { voter_id: string | null; generation: number }) => ({
      organizationId: p.organizationId,
      pollId: p.pollId,
      voterId: row.voter_id as string,
      generation: row.generation,
    })
    const openAs = (
      row: { voter_id: string | null; generation: number },
      ciphertext: Buffer | null,
      change: Partial<Voters.MeetingPollCredentialBinding> = {},
    ) => M.openMeetingPollCredential(SECRET, { ...binding(row), ...change }, ciphertext)
    const first = await queuedFor(firstVoter.id)
    const second = await queuedFor(secondVoter.id)
    const firstCopy = first.capability_ciphertext as Buffer
    expect(openAs(first, firstCopy)).toMatchObject({ purpose: 'voting' })
    expect(openAs(second, second.capability_ciphertext)).toMatchObject({ purpose: 'voting' })
    // Another voter, generation, organization or poll opens nothing.
    expect(openAs(first, firstCopy, { voterId: secondVoter.id })).toBeUndefined()
    expect(openAs(first, firstCopy, { generation: first.generation + 1 })).toBeUndefined()
    expect(openAs(first, firstCopy, { organizationId: elsewhere.organizationId })).toBeUndefined()
    expect(openAs(first, firstCopy, { pollId: elsewhere.pollId })).toBeUndefined()
    // A ciphertext moved to another voter's delivery row of the same generation.
    await db
      .updateTable('meeting_poll_deliveries')
      .set({ capability_ciphertext: firstCopy })
      .where('id', '=', second.id)
      .execute()
    const movedToVoter = await queuedFor(secondVoter.id)
    expect(movedToVoter.generation).toBe(first.generation)
    expect(openAs(movedToVoter, movedToVoter.capability_ciphertext)).toBeUndefined()
    // A ciphertext moved to the same voter's next generation after a resend.
    await succeeds(() => resend(M, p, 'first@example.com'))
    const next = await queuedFor(firstVoter.id)
    expect(next.generation).toBe(first.generation + 1)
    expect(openAs(next, next.capability_ciphertext)).toMatchObject({ purpose: 'voting' })
    await db
      .updateTable('meeting_poll_deliveries')
      .set({ capability_ciphertext: firstCopy })
      .where('id', '=', next.id)
      .execute()
    const movedToGeneration = await queuedFor(firstVoter.id)
    expect(openAs(movedToGeneration, movedToGeneration.capability_ciphertext)).toBeUndefined()
  }

  /** Expired credentials never verify, are never re-delivered and never carry over. */
  async function verifyExpiredCredential(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'late@example.com')
    const stale = await mailed(p, 'late@example.com')
    await expirePending(p, 'late@example.com')
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: stale.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
    expect(await voter(p, 'late@example.com')).toMatchObject({ verified_at: null })
    await succeeds(() => recover(M, p, 'late@example.com'))
    expect(await deliveries(p, stale.voter.id)).toHaveLength(1)
    // Enrolling again needs a new place and gives a new voter and credential.
    await succeeds(() => enroll(M, p, 'late@example.com', '192.0.2.77'))
    const renewed = await mailed(p, 'late@example.com')
    expect(renewed.voter.id).not.toBe(stale.voter.id)
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: stale.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
    await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: renewed.token }))

    // A consumed verification credential stops answering when it expires.
    await enroll(M, p, 'brief@example.com', '192.0.2.78')
    const brief = await mailed(p, 'brief@example.com')
    const soon = (await databaseNow()).add({ seconds: 2 }).toString()
    await db
      .updateTable('meeting_poll_voters')
      .set({ pending_expires_at: soon })
      .where('id', '=', brief.voter.id)
      .execute()
    await db
      .updateTable('meeting_poll_capabilities')
      .set({ expires_at: soon })
      .where('voter_id', '=', brief.voter.id)
      .execute()
    await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: brief.token }))
    while (Temporal.Instant.compare(await databaseNow(), Temporal.Instant.from(soon)) <= 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: brief.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })

    // After the deadline nothing verifies, enrolls, invites or is re-delivered.
    await invite(M, p, ['invitee@example.com'])
    const invitation = await mailed(p, 'invitee@example.com')
    await pastDeadline(p)
    const before = await snapshot(p)
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: invitation.token })),
    ).toMatchObject({
      code: 'poll_closed',
    })
    expect(await failure(() => enroll(M, p, 'after@example.com', '192.0.2.79'))).toMatchObject({
      code: 'poll_closed',
    })
    expect(await failure(() => invite(M, p, ['after@example.com']))).toMatchObject({
      code: 'poll_closed',
    })
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    expect(await snapshot(p)).toBe(before)
  }

  /** Invited places and credentials last until the deadline, whatever public enrollees do. */
  async function verifyDurableInvitation(M: VoterModule) {
    const p = await open()
    await invite(M, p, ['invitee@example.com'])
    const invitation = await mailed(p, 'invitee@example.com')
    await sql`UPDATE meeting_poll_voters SET created_at = clock_timestamp() - interval '3 hours',
      invited_at = clock_timestamp() - interval '3 hours' WHERE id = ${invitation.voter.id}`.execute(
      db,
    )
    await fill(M, p, 39, 'crowd')
    expect(await places(p)).toBe(40)
    expect(await failure(() => invite(M, p, ['another@example.com']))).toMatchObject({
      code: 'poll_full',
    })
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    const again = await mailed(p, 'invitee@example.com')
    expect([again.delivery.kind, again.token]).toEqual(['recovery', invitation.token])
    expect(
      (await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: invitation.token }))).voter
        .status,
    ).toBe('verified')
    for (let i = 0; i < 39; i++) await expirePending(p, `crowd-${i}@example.com`)
    expect(await places(p)).toBe(1)
    expect(await voter(p, 'invitee@example.com')).toMatchObject({
      withdrawn_at: null,
      pending_expires_at: null,
    })
    await succeeds(() => invite(M, p, ['another@example.com']))
  }

  /** Recovery re-delivers the current credential unchanged, never revoking or extending it. */
  async function verifyRecovery(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'pending@example.com')
    const first = await mailed(p, 'pending@example.com')
    const kept = {
      row: await voter(p, 'pending@example.com'),
      credentials: await credentials(first.voter.id),
    }
    const before = await revisions(p)
    expect(await succeeds(() => recover(M, p, ' Pending@EXAMPLE.com '))).toEqual({ accepted: true })
    const sent = await deliveries(p, first.voter.id)
    expect(
      sent.map((entry) => [entry.kind, entry.generation, entry.sequence, entry.state]),
    ).toEqual([
      ['verification', 1, 0, 'pending'],
      ['recovery', 1, 0, 'pending'],
    ])
    expect(
      opened(p, sent[1] as (typeof sent)[number], sent[1]?.capability_ciphertext ?? null)?.token,
    ).toBe(first.token)
    expect({
      row: await voter(p, 'pending@example.com'),
      credentials: await credentials(first.voter.id),
    }).toEqual(kept)
    expect(await revisions(p)).toEqual(before)
    expect(await counter(p, 'pending@example.com')).toMatchObject({
      recovery_count: 1,
      resend_count: 0,
    })
    // One delivery per 15 minutes and three per credential, without changing the answer.
    expect(await succeeds(() => recover(M, p, 'pending@example.com'))).toEqual({ accepted: true })
    expect(await deliveries(p, first.voter.id)).toHaveLength(2)
    const cooled = sql`UPDATE meeting_poll_mailbox_counters
      SET last_recovery_at = clock_timestamp() - interval '16 minutes' WHERE poll_id = ${p.pollId}`
    for (const expected of [3, 4, 4]) {
      await cooled.execute(db)
      expect(await succeeds(() => recover(M, p, 'pending@example.com'))).toEqual({ accepted: true })
      expect(await deliveries(p, first.voter.id)).toHaveLength(expected)
    }
    expect((await deliveries(p, first.voter.id)).map((entry) => entry.sequence)).toEqual([
      0, 0, 1, 2,
    ])
    expect(await counter(p, 'pending@example.com')).toMatchObject({ recovery_count: 3 })
    // The original link still works, and the new voting credential restarts the allowance.
    const verified = await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: first.token }))
    expect(await counter(p, 'pending@example.com')).toMatchObject({
      recovery_count: 0,
      last_recovery_at: null,
    })
    await succeeds(() => recover(M, p, 'pending@example.com'))
    const voting = await mailed(p, 'pending@example.com')
    expect([voting.delivery.kind, voting.delivery.generation, voting.token]).toEqual([
      'recovery',
      2,
      verified.votingToken,
    ])

    // Unknown, withdrawn and ineligible requests are accepted alike and send nothing.
    await invite(M, p, ['withdrawn@example.com'])
    await withdraw(p, 'withdrawn@example.com')
    const quiet = await snapshot(p)
    for (const request of [
      { pollId: p.pollId, email: 'stranger@example.com' },
      { pollId: p.pollId, email: 'withdrawn@example.com' },
      { pollId: randomUUID(), email: 'pending@example.com' },
      { pollId: 'not-a-poll', email: 'pending@example.com' },
    ])
      expect(await succeeds(() => M.recoverMeetingPollVoter(pub(), request))).toEqual({
        accepted: true,
      })
    expect(await snapshot(p)).toBe(quiet)

    // Invited mode needs no public link; a poll closed early still re-delivers.
    const invited = await open('invited')
    await invite(M, invited, ['guest@example.com'])
    const guest = await mailed(invited, 'guest@example.com')
    await Polls.closeMeetingPoll(invited.ctx, {
      id: invited.pollId,
      expectedHostRevision: (await revisions(invited)).host_revision,
    })
    await succeeds(() => recover(M, invited, 'guest@example.com'))
    expect((await mailed(invited, 'guest@example.com')).token).toBe(guest.token)
    const canceled = await open()
    await invite(M, canceled, ['guest@example.com'])
    await Polls.cancelMeetingPoll(canceled.ctx, {
      id: canceled.pollId,
      expectedHostRevision: (await revisions(canceled)).host_revision,
    })
    await succeeds(() => recover(M, canceled, 'guest@example.com'))
    expect(await deliveries(canceled)).toHaveLength(1)
  }

  /** Recovery and resend keep separate counters; a resend restarts only recovery's allowance. */
  async function verifyCounters(M: VoterModule) {
    const p = await open()
    await invite(M, p, ['invitee@example.com'])
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    expect(await counter(p, 'invitee@example.com')).toMatchObject({
      recovery_count: 1,
      resend_count: 0,
    })
    await succeeds(() => resend(M, p, 'invitee@example.com'))
    expect(await counter(p, 'invitee@example.com')).toMatchObject({
      recovery_count: 0,
      last_recovery_at: null,
      resend_count: 1,
    })
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    expect(await counter(p, 'invitee@example.com')).toMatchObject({
      recovery_count: 1,
      resend_count: 1,
    })
    const cooling = await failure(() => resend(M, p, 'invitee@example.com'))
    expect(cooling).toMatchObject({ code: 'rate_limited' })
    expect(cooling.retryAfterSeconds).toBeGreaterThan(800)
    expect(cooling.retryAfterSeconds).toBeLessThanOrEqual(900)
    const cooled = sql`UPDATE meeting_poll_mailbox_counters
      SET last_resend_at = clock_timestamp() - interval '16 minutes' WHERE poll_id = ${p.pollId}`
    for (const count of [2, 3]) {
      await cooled.execute(db)
      await succeeds(() => resend(M, p, 'invitee@example.com'))
      expect(await counter(p, 'invitee@example.com')).toMatchObject({ resend_count: count })
    }
    await cooled.execute(db)
    const capped = await failure(() => resend(M, p, 'invitee@example.com'))
    expect(capped).toMatchObject({ code: 'rate_limited', retryAfterSeconds: undefined })
    // Recovery is still allowed after the resend cap.
    await succeeds(() => recover(M, p, 'invitee@example.com'))
    expect(await counter(p, 'invitee@example.com')).toMatchObject({
      recovery_count: 1,
      resend_count: 3,
    })
    // Counters survive removal, and a re-invitation is a resend: with the budget spent, the
    // removed mailbox cannot be invited again and nothing is written.
    await remove(p, 'invitee@example.com')
    const removed = await snapshot(p)
    expect(await failure(() => invite(M, p, ['invitee@example.com']))).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: undefined,
    })
    expect(await snapshot(p)).toBe(removed)
    expect(await counter(p, 'invitee@example.com')).toMatchObject({
      resend_count: 3,
      removed_at: expect.any(Date),
    })
  }

  /** Resend rotates the invitee's credential under the host revision and a retained key. */
  async function verifyResend(M: VoterModule) {
    const p = await open()
    await invite(M, p, ['invitee@example.com', 'other@example.com'])
    const old = await mailed(p, 'invitee@example.com')
    const { host_revision, results_revision } = await revisions(p)
    const key = randomUUID()
    const request = {
      id: p.pollId,
      voterId: old.voter.id,
      expectedHostRevision: host_revision,
      idempotencyKey: key,
    }
    const first = await succeeds(() => M.resendMeetingPollInvitation(p.ctx, request))
    expect(first).toMatchObject({ replayed: false, voterId: old.voter.id })
    expect(first.poll.hostRevision).toBe(host_revision + 1)
    expect(JSON.stringify(first)).not.toMatch(/token/i)
    const [previous, current] = await credentials(old.voter.id)
    expect(previous).toMatchObject({ generation: 1, capability_ciphertext: null })
    expect(previous?.revoked_at).not.toBeNull()
    expect(current).toMatchObject({ purpose: 'voting', generation: 2, revoked_at: null })
    expect(
      (await deliveries(p, old.voter.id)).map((entry) => [
        entry.kind,
        entry.generation,
        entry.state,
      ]),
    ).toEqual([
      ['invitation', 1, 'skipped'],
      ['invitation', 2, 'pending'],
    ])
    // A resend is a host write; the roster and results stay as they were.
    expect(await revisions(p)).toMatchObject({ host_revision: host_revision + 1, results_revision })
    const fresh = await mailed(p, 'invitee@example.com')
    expect(
      await failure(() => M.verifyMeetingPollVoter(pub(), { token: old.token })),
    ).toMatchObject({
      code: 'poll_not_found',
    })
    await succeeds(() => M.verifyMeetingPollVoter(pub(), { token: fresh.token }))
    // A matching retry mails nothing; a changed request under the key conflicts.
    const mail = await deliveries(p)
    const replay = await succeeds(() => M.resendMeetingPollInvitation(p.ctx, request))
    expect(replay).toMatchObject({ replayed: true, voterId: old.voter.id })
    expect(await deliveries(p)).toEqual(mail)
    const other = await voter(p, 'other@example.com')
    expect(
      await failure(() => M.resendMeetingPollInvitation(p.ctx, { ...request, voterId: other.id })),
    ).toMatchObject({ code: 'idempotency_key_reused' })
    const fresher = { ...request, voterId: other.id, idempotencyKey: randomUUID() }
    expect(await failure(() => M.resendMeetingPollInvitation(p.ctx, fresher))).toMatchObject({
      code: 'poll_changed',
    })
    const now = { ...fresher, expectedHostRevision: host_revision + 1 }
    await enroll(M, p, 'public@example.com')
    for (const voterId of [(await voter(p, 'public@example.com')).id, randomUUID(), 'not-a-voter'])
      expect(
        await failure(() =>
          M.resendMeetingPollInvitation(p.ctx, { ...now, voterId, idempotencyKey: randomUUID() }),
        ),
      ).toMatchObject({ kind: 'not_found', code: 'poll_not_found' })
    await withdraw(p, 'other@example.com')
    expect(await failure(() => M.resendMeetingPollInvitation(p.ctx, now))).toMatchObject({
      code: 'voter_withdrawn',
    })
    expect(await failure(() => M.resendMeetingPollInvitation(p.memberCtx, now))).toMatchObject({
      code: 'team_management_access_denied',
    })
    await Polls.closeMeetingPoll(p.ctx, { id: p.pollId, expectedHostRevision: host_revision + 1 })
    expect(
      await failure(() =>
        M.resendMeetingPollInvitation(p.ctx, { ...now, expectedHostRevision: host_revision + 2 }),
      ),
    ).toMatchObject({ code: 'poll_closed' })
  }

  /** An exact invitation replay mails nothing and reports current roster state. */
  async function verifyInviteReplay(M: VoterModule) {
    const p = await open()
    const key = randomUUID()
    const first = await succeeds(() => invite(M, p, ['a@example.com', 'b@example.com'], key))
    expect(first.entries.map((entry) => entry.outcome)).toEqual(['invited', 'invited'])
    await M.verifyMeetingPollVoter(pub(), { token: (await mailed(p, 'b@example.com')).token })
    const before = await snapshot(p)
    const replay = await succeeds(() => invite(M, p, ['a@example.com', 'b@example.com'], key))
    expect(replay.replayed).toBe(true)
    expect(replay.entries).toEqual([
      {
        email: 'a@example.com',
        outcome: 'unchanged',
        voterId: first.entries[0]?.voterId,
        status: 'invited',
      },
      {
        email: 'b@example.com',
        outcome: 'unchanged',
        voterId: first.entries[1]?.voterId,
        status: 'verified',
      },
    ])
    expect(await snapshot(p)).toBe(before)
    expect(await failure(() => invite(M, p, ['a@example.com'], key))).toMatchObject({
      code: 'idempotency_key_reused',
    })
    expect(
      await failure(() => invite(M, { ...p, ctx: p.memberCtx }, ['c@example.com'])),
    ).toMatchObject({
      code: 'team_management_access_denied',
    })
    // A lost response stays recoverable after voting closes.
    await Polls.closeMeetingPoll(p.ctx, {
      id: p.pollId,
      expectedHostRevision: (await revisions(p)).host_revision,
    })
    expect(
      (await succeeds(() => invite(M, p, ['a@example.com', 'b@example.com'], key))).replayed,
    ).toBe(true)
    expect(await failure(() => invite(M, p, ['c@example.com']))).toMatchObject({
      code: 'poll_closed',
    })
  }

  /** Two enrollments for the last place, over two connections: exactly one gets it. */
  async function verifyCapacityRace(M: VoterModule) {
    const p = await open()
    await invite(
      M,
      p,
      Array.from({ length: 39 }, (_, i) => `invitee-${i}@example.com`),
    )
    const queuedResult = await queued(
      p,
      () => enroll(M, p, 'first@example.com', '192.0.2.1'),
      () => enroll(M, p, 'second@example.com', '192.0.2.2'),
    )
    expect(queuedResult.map(outcome)).toEqual(['fulfilled', { code: 'poll_full' }])
    expect(await places(p)).toBe(40)
    const q = await open()
    await invite(
      M,
      q,
      Array.from({ length: 38 }, (_, i) => `invitee-${i}@example.com`),
    )
    const racing = await Promise.allSettled(
      ['a', 'b', 'c'].map((name, i) => enroll(M, q, `${name}@example.com`, `192.0.2.${i + 1}`)),
    )
    expect(racing.map(outcome).filter((entry) => entry === 'fulfilled')).toHaveLength(2)
    expect(racing.map(outcome).filter((entry) => entry !== 'fulfilled')).toEqual([
      { code: 'poll_full' },
    ])
    expect(await places(q)).toBe(40)
    // A batch and an enrollment racing for the last places.
    const r = await open()
    await invite(
      M,
      r,
      Array.from({ length: 38 }, (_, i) => `invitee-${i}@example.com`),
    )
    const mixed = await queued(
      r,
      () => invite(M, r, ['x@example.com', 'y@example.com']),
      () => enroll(M, r, 'z@example.com'),
    )
    expect(mixed.map(outcome)).toEqual(['fulfilled', { code: 'poll_full' }])
    expect(await places(r)).toBe(40)
  }

  /** Two enrollments from one IP for its last pending allowance: exactly one gets it. */
  async function verifyIpRace(M: VoterModule) {
    const p = await open()
    for (const name of ['a', 'b']) await enroll(M, p, `${name}@example.com`, '192.0.2.60')
    const result = await queued(
      p,
      () => enroll(M, p, 'c@example.com', '192.0.2.60'),
      () => enroll(M, p, 'd@example.com', '192.0.2.60'),
    )
    expect(result.map(outcome)).toEqual(['fulfilled', { code: 'rate_limited' }])
    const racing = await Promise.allSettled(
      ['e', 'f'].map((name) => enroll(M, p, `${name}@example.com`, '192.0.2.61')),
    )
    expect(racing.map(outcome)).toEqual(['fulfilled', 'fulfilled'])
    const lastTwo = await Promise.allSettled(
      ['g', 'h'].map((name) => enroll(M, p, `${name}@example.com`, '192.0.2.61')),
    )
    expect(lastTwo.map(outcome).filter((entry) => entry === 'fulfilled')).toHaveLength(1)
    expect(lastTwo.map(outcome).filter((entry) => entry !== 'fulfilled')).toEqual([
      { code: 'rate_limited' },
    ])
  }

  /**
   * Recovery and resend on one mailbox serialize on the poll: recovery re-delivers whichever
   * credential is current at its turn and never revokes it; resend rotates it.
   */
  async function verifyRecoveryResendRace(M: VoterModule) {
    const p = await open()
    await invite(M, p, ['first@example.com', 'second@example.com'])
    const original = await mailed(p, 'first@example.com')
    const host = (await revisions(p)).host_revision
    const recoveryFirst = await queued(
      p,
      () => recover(M, p, 'first@example.com'),
      () =>
        M.resendMeetingPollInvitation(p.ctx, {
          id: p.pollId,
          voterId: original.voter.id,
          expectedHostRevision: host,
          idempotencyKey: randomUUID(),
        }),
    )
    expect(recoveryFirst.map(outcome)).toEqual(['fulfilled', 'fulfilled'])
    const firstMail = await deliveries(p, original.voter.id)
    expect(firstMail.map((entry) => [entry.kind, entry.generation, entry.state])).toEqual([
      ['invitation', 1, 'skipped'],
      ['recovery', 1, 'skipped'],
      ['invitation', 2, 'pending'],
    ])
    expect(await counter(p, 'first@example.com')).toMatchObject({
      resend_count: 1,
      recovery_count: 0,
    })

    const second = await voter(p, 'second@example.com')
    const resendFirst = await queued(
      p,
      () =>
        M.resendMeetingPollInvitation(p.ctx, {
          id: p.pollId,
          voterId: second.id,
          expectedHostRevision: host + 1,
          idempotencyKey: randomUUID(),
        }),
      () => recover(M, p, 'second@example.com'),
    )
    expect(resendFirst.map(outcome)).toEqual(['fulfilled', 'fulfilled'])
    const secondMail = await deliveries(p, second.id)
    expect(secondMail.map((entry) => [entry.kind, entry.generation, entry.state])).toEqual([
      ['invitation', 1, 'skipped'],
      ['invitation', 2, 'pending'],
      ['recovery', 2, 'pending'],
    ])
    const [, rotated, recovered] = secondMail
    expect(
      opened(p, recovered as (typeof secondMail)[number], recovered?.capability_ciphertext ?? null),
    ).toEqual(
      opened(p, rotated as (typeof secondMail)[number], rotated?.capability_ciphertext ?? null),
    )
    expect(
      (await credentials(second.id)).map((entry) => [entry.generation, entry.revoked_at === null]),
    ).toEqual([
      [1, false],
      [2, true],
    ])
    expect(await counter(p, 'second@example.com')).toMatchObject({
      resend_count: 1,
      recovery_count: 1,
    })
  }

  /** Duplicate verifications over two connections mint and mail one voting credential. */
  async function verifyVerificationRace(M: VoterModule) {
    const p = await open()
    await enroll(M, p, 'twice@example.com', '192.0.2.1')
    const twice = await mailed(p, 'twice@example.com')
    const verify = () => M.verifyMeetingPollVoter(pub(), { token: twice.token })
    const result = await queued(p, verify, verify)
    expect(result.map(outcome)).toEqual(['fulfilled', 'fulfilled'])
    const tokens = result.map((entry) =>
      entry.status === 'fulfilled' ? entry.value.votingToken : 'failed',
    )
    expect(tokens[0]).toEqual(expect.any(String))
    expect(tokens[1]).toBeNull()
    const pending = async (voterId: string) =>
      (await deliveries(p, voterId))
        .filter((entry) => entry.state === 'pending')
        .map((entry) => [entry.kind, entry.generation, entry.sequence])
    expect(await pending(twice.voter.id)).toEqual([['verification', 2, 0]])
    expect((await mailed(p, 'twice@example.com')).token).toBe(tokens[0])
    expect(
      (await credentials(twice.voter.id)).filter((row) => row.purpose === 'voting'),
    ).toHaveLength(1)
    // Three truly parallel requests: one voting credential, one mail.
    await enroll(M, p, 'thrice@example.com', '192.0.2.2')
    const thrice = await mailed(p, 'thrice@example.com')
    const parallel = await Promise.allSettled(
      [1, 2, 3].map(() => M.verifyMeetingPollVoter(pub(), { token: thrice.token })),
    )
    expect(parallel.map(outcome)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect(
      parallel.filter((entry) => entry.status === 'fulfilled' && entry.value.votingToken !== null),
    ).toHaveLength(1)
    expect(await pending(thrice.voter.id)).toEqual([['verification', 2, 0]])
  }

  /** An enrollment waiting while the link rotates finds the old link gone. */
  async function verifyRotationRace(M: VoterModule) {
    const p = await open()
    const release = await holding(async (trx) => {
      await trx
        .selectFrom('meeting_polls')
        .select('id')
        .where('id', '=', p.pollId)
        .forUpdate()
        .execute()
      await trx
        .updateTable('meeting_polls')
        .set({ public_token_digest: randomBytes(32) })
        .where('id', '=', p.pollId)
        .execute()
    })
    const attempt = enroll(M, p, 'late@example.com')
    let order: 'queued' | 'settled'
    try {
      order = await queues(attempt)
    } finally {
      await release()
    }
    expect(order).toBe('queued')
    expect(await failure(() => attempt)).toMatchObject({ code: 'poll_not_found' })
    expect(await maybeVoter(p, 'late@example.com')).toBeUndefined()
  }

  /**
   * Public writes take the organization before the poll, as public booking does: one that
   * waits for the organization holds no poll lock, so organization deletion cannot deadlock.
   */
  async function verifyPublicLockOrder(M: VoterModule) {
    const p = await open()
    const release = await holding((trx) =>
      trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', p.organizationId)
        .forUpdate()
        .execute(),
    )
    const attempt = enroll(M, p, 'ordered@example.com')
    let order: 'queued' | 'settled'
    let probe: 'free' | 'held'
    try {
      order = await queues(attempt)
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
    await succeeds(() => attempt)
  }

  // --- Behaviour ---------------------------------------------------------------------------

  it('enrolls a public voter with one hour of reservation and only verification mail', async () => {
    await verifyEnrollment(Voters)
  })

  it('answers every enrollment alike, and alike with 409 poll_full once full', async () => {
    await verifyUniformity(Voters)
  })

  it('caps places at 40, freeing expired reservations and withdrawn voters at once', async () => {
    await verifyCapacity(Voters)
  })

  it('caps live public reservations at three per IP, freed by verification and expiry', async () => {
    await verifyIpCap(Voters)
  })

  it('refuses a whole invitation batch whose new places do not fit', async () => {
    await verifyBatch(Voters)
  })

  it('resolves invitations for active, verified, pending, expired, withdrawn and removed mailboxes', async () => {
    await verifyInvitationOutcomes(Voters)
  })

  it('verifies by explicit request with purpose-bound credentials', async () => {
    await verifyVerification(Voters)
  })

  it('mails the voting credential once when a public enrollee verifies', async () => {
    await verifyVerificationMail(Voters)
  })

  it('opens a credential copy only under its own organization, poll, voter and generation', async () => {
    await verifyCredentialBinding(Voters)
  })

  it('never reuses an expired credential', async () => {
    await verifyExpiredCredential(Voters)
  })

  it('keeps invited places and credentials until the deadline', async () => {
    await verifyDurableInvitation(Voters)
  })

  it('re-delivers the unchanged credential on recovery without revoking it', async () => {
    await verifyRecovery(Voters)
  })

  it('counts recovery and resend separately', async () => {
    await verifyCounters(Voters)
  })

  it('rotates an invitee credential on resend under the host revision and a retained key', async () => {
    await verifyResend(Voters)
  })

  it('replays an invitation without mail and reports current roster state', async () => {
    await verifyInviteReplay(Voters)
  })

  it('gives the last place to exactly one of two racing enrollments', async () => {
    await verifyCapacityRace(Voters)
  })

  it('gives the last IP allowance to exactly one of two racing enrollments', async () => {
    await verifyIpRace(Voters)
  })

  it('serializes recovery and resend on one mailbox', async () => {
    await verifyRecoveryResendRace(Voters)
  })

  it('mails one voting credential for duplicate concurrent verifications', async () => {
    await verifyVerificationRace(Voters)
  })

  it('refuses an enrollment that waited while the link rotated', async () => {
    await verifyRotationRace(Voters)
  })

  it('locks the organization before the poll on public writes', async () => {
    await verifyPublicLockOrder(Voters)
  })

  // --- Mutation checks --------------------------------------------------------------------

  const verifications = [
    verifyEnrollment,
    verifyUniformity,
    verifyCapacity,
    verifyIpCap,
    verifyBatch,
    verifyInvitationOutcomes,
    verifyVerification,
    verifyVerificationMail,
    verifyCredentialBinding,
    verifyExpiredCredential,
    verifyDurableInvitation,
    verifyRecovery,
    verifyCounters,
    verifyResend,
    verifyInviteReplay,
    verifyCapacityRace,
    verifyIpRace,
    verifyRecoveryResendRace,
    verifyVerificationRace,
    verifyRotationRace,
    verifyPublicLockOrder,
  ]

  it('passes every protection check through an unmodified source copy', async () => {
    const copy = await sourceCopy()
    for (const verify of verifications) await verify(copy)
  }, 180_000)

  type Mutation = [string, (M: VoterModule) => Promise<void>, ...(readonly [string, string])[]]
  const NO_POLL_LOCK: readonly [string, string] = [
    '    .forUpdate()\n    .executeTakeFirst()\n  if (!poll) return undefined',
    '    .executeTakeFirst()\n  if (!poll) return undefined',
  ]
  const mutations: Mutation[] = [
    [
      'enrollment skips the capacity check',
      verifyCapacity,
      ['    if (counts.active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()\n', ''],
    ],
    [
      'expired reservations keep their place',
      verifyCapacity,
      [
        'OR invited_at IS NOT NULL OR pending_expires_at > ${at}::timestamptz))::text AS active',
        'OR invited_at IS NOT NULL OR pending_expires_at IS NOT NULL))::text AS active',
      ],
    ],
    [
      'withdrawn voters keep their place',
      verifyCapacity,
      [
        'count(*) FILTER (WHERE withdrawn_at IS NULL AND (verified_at',
        'count(*) FILTER (WHERE ((verified_at',
      ],
      ['::timestamptz))::text AS active', '::timestamptz)))::text AS active'],
    ],
    [
      'enrollment looks at the mailbox before the capacity check',
      verifyUniformity,
      ['    if (counts.active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()\n', ''],
      [
        '    if (counter?.removed_at || (existing && !existing.expired)) return accepted()\n',
        '    if (counter?.removed_at || (existing && !existing.expired)) return accepted()\n    if (counts.active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()\n',
      ],
    ],
    [
      'removed mailboxes enroll again',
      verifyUniformity,
      [
        'if (counter?.removed_at || (existing && !existing.expired)) return accepted()',
        'if (existing && !existing.expired) return accepted()',
      ],
    ],
    [
      'a pending mailbox is enrolled again',
      verifyUniformity,
      [
        'if (counter?.removed_at || (existing && !existing.expired)) return accepted()',
        "if (counter?.removed_at || (existing && !existing.expired && existing.status !== 'pending')) return accepted()",
      ],
    ],
    [
      'an expired reservation blocks enrolling again',
      verifyExpiredCredential,
      [
        'if (counter?.removed_at || (existing && !existing.expired)) return accepted()',
        'if (counter?.removed_at || existing) return accepted()',
      ],
    ],
    [
      'enrollment skips the IP cap',
      verifyIpCap,
      [
        '    if (counts.fromIp >= MEETING_POLL_LIMITS.maxPendingPerIp)\n      throw new MeetingPollRateLimitError(counts.ipRetryAfter ?? undefined)\n',
        '',
      ],
    ],
    [
      'the IP cap counts expired and verified voters',
      verifyIpCap,
      [
        'count(*) FILTER (WHERE pending_expires_at > ${at}::timestamptz\n        AND admission_ip_digest',
        'count(*) FILTER (WHERE true\n        AND admission_ip_digest',
      ],
    ],
    [
      'invitation batches admit what fits',
      verifyBatch,
      [
        'if (active + added > MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()',
        'if (active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()',
      ],
    ],
    [
      'upgraded reservations take a new place',
      verifyBatch,
      [
        "plan.filter((entry) => entry.outcome === 'invited').length",
        "plan.filter((entry) => entry.outcome !== 'unchanged').length",
      ],
    ],
    [
      'known mailboxes are invited again',
      verifyInvitationOutcomes,
      [
        "!voter || voter.expired ? 'invited' : voter.status === 'pending' ? 'upgraded' : 'unchanged'",
        "!voter || voter.expired || voter.status !== 'pending' ? 'invited' : 'upgraded'",
      ],
    ],
    [
      'expired reservations are upgraded instead of replaced',
      verifyInvitationOutcomes,
      ["!voter || voter.expired ? 'invited'", "!voter ? 'invited'"],
    ],
    [
      'upgrades keep the verification credential',
      verifyInvitationOutcomes,
      ["        await retireCredentials(trx, poll, voter.id, 'verification', 'revoked')\n", ''],
    ],
    [
      'invitations keep a removal tombstone',
      verifyInvitationOutcomes,
      ['        clearRemoval: true,\n', '        clearRemoval: false,\n'],
    ],
    [
      'invitations leave the revisions alone',
      verifyInvitationOutcomes,
      [
        '      await advanceRevisions(trx, poll, { host: true, hostRevision: locked.host_revision })\n',
        '      undefined\n',
      ],
    ],
    [
      'voter actions advance the host revision',
      verifyEnrollment,
      [
        '...(options.host ? { host_revision: options.hostRevision + 1 } : {}),',
        "host_revision: eb('host_revision', '+', 1),",
      ],
    ],
    [
      'credential ciphertext is not bound to its voter',
      verifyCredentialBinding,
      [
        ':${binding.pollId}:${binding.voterId}:${binding.generation}`',
        ':${binding.pollId}:${binding.generation}`',
      ],
    ],
    [
      'credential ciphertext is not bound to its generation',
      verifyCredentialBinding,
      [':${binding.voterId}:${binding.generation}`', ':${binding.voterId}`'],
    ],
    [
      'credential ciphertext is not bound to its organization',
      verifyCredentialBinding,
      [':v1:${binding.organizationId}:${binding.pollId}', ':v1:${binding.pollId}'],
    ],
    [
      'admission ignores a soft-deleted event',
      verifyEnrollment,
      [
        "if (poll.status !== 'open' || poll.deadlinePassed || poll.eventDeleted) throw pollClosed()",
        "if (poll.status !== 'open' || poll.deadlinePassed) throw pollClosed()",
      ],
    ],
    [
      'enrollment looks at the mailbox before the per-IP cap',
      verifyUniformity,
      [
        '    if (counts.fromIp >= MEETING_POLL_LIMITS.maxPendingPerIp)\n      throw new MeetingPollRateLimitError(counts.ipRetryAfter ?? undefined)\n',
        '',
      ],
      [
        '    if (counter?.removed_at || (existing && !existing.expired)) return accepted()\n',
        '    if (counter?.removed_at || (existing && !existing.expired)) return accepted()\n    if (counts.fromIp >= MEETING_POLL_LIMITS.maxPendingPerIp)\n      throw new MeetingPollRateLimitError(counts.ipRetryAfter ?? undefined)\n',
      ],
    ],
    [
      'verification ignores a soft-deleted event',
      verifyEnrollment,
      [
        '    requireVotingOpen(poll, pollClosed)\n    const voterId = credential.voter_id\n',
        '    requireVotingOpen({ ...poll, eventDeleted: false }, pollClosed)\n    const voterId = credential.voter_id\n',
      ],
    ],
    [
      'resend ignores a soft-deleted event',
      verifyEnrollment,
      [
        '    requireHostVotingOpen(locked)\n    requireHostRevision(locked, request.expectedHostRevision)\n',
        '    requireHostVotingOpen({ ...locked, eventDeleted: false })\n    requireHostRevision(locked, request.expectedHostRevision)\n',
      ],
    ],
    [
      'recovery ignores a soft-deleted event',
      verifyEnrollment,
      [
        "    (poll.status === 'open' || poll.status === 'closed') &&\n    !poll.deadlinePassed &&\n    !poll.eventDeleted\n",
        "    (poll.status === 'open' || poll.status === 'closed') &&\n    !poll.deadlinePassed\n",
      ],
    ],
    [
      'admission ignores a passed deadline',
      verifyEnrollment,
      [
        "if (poll.status !== 'open' || poll.deadlinePassed || poll.eventDeleted) throw pollClosed()",
        "if (poll.status !== 'open' || poll.eventDeleted) throw pollClosed()",
      ],
    ],
    [
      'verification does not consume its credential',
      verifyVerification,
      ["      await retireCredentials(trx, poll, voterId, 'verification', 'consumed')\n", ''],
    ],
    [
      'a repeated verification mints another voting credential',
      verifyVerification,
      [
        '      if (credential.consumed)\n        return { voter: await voterState(trx, poll, voterId), votingToken: null }\n',
        '',
      ],
    ],
    [
      'verification mails nothing',
      verifyVerificationMail,
      [
        "      await queueCredentialMail(trx, poll, voterId, 'verification', votingCredential, 'first')\n",
        '',
      ],
    ],
    [
      'verification mails at another generation',
      verifyVerificationMail,
      [
        "      await queueCredentialMail(trx, poll, voterId, 'verification', votingCredential, 'first')\n",
        "      await queueCredentialMail(trx, poll, voterId, 'verification', { ...votingCredential, generation: votingCredential.generation + 1 }, 'first')\n",
      ],
    ],
    [
      'a repeated verification mails the voting credential again',
      verifyVerificationMail,
      [
        '      if (credential.consumed)\n        return { voter: await voterState(trx, poll, voterId), votingToken: null }\n',
        "      if (credential.consumed) {\n        const current = await trx\n          .selectFrom('meeting_poll_capabilities')\n          .select(['generation', 'capability_ciphertext'])\n          .where('voter_id', '=', voterId)\n          .where('purpose', '=', 'voting')\n          .where('revoked_at', 'is', null)\n          .executeTakeFirstOrThrow()\n        await queueCredentialMail(trx, poll, voterId, 'verification', { generation: current.generation, ciphertext: current.capability_ciphertext as Buffer }, 'next')\n        return { voter: await voterState(trx, poll, voterId), votingToken: null }\n      }\n",
      ],
    ],
    [
      'verification keeps the recovery count',
      verifyVerificationMail,
      [
        '      await newCurrentCredential(trx, poll, credential.email_key, { clearRemoval: false })\n',
        '',
      ],
    ],
    [
      'other credential purposes verify',
      verifyVerification,
      [
        "eb.and([eb('purpose', '=', 'voting'), eb('token_digest', '=', voting)]),",
        "eb('token_digest', '=', voting),",
      ],
    ],
    [
      'verification ignores closed voting',
      verifyVerification,
      ['    requireVotingOpen(poll, pollClosed)\n    const voterId', '    const voterId'],
    ],
    [
      'expired verification credentials verify',
      verifyExpiredCredential,
      [
        "    if (credential.purpose === 'verification' && !credential.live) throw pollNotFound()\n",
        '',
      ],
    ],
    [
      'revoked credentials verify',
      verifyResend,
      [
        'if (!credential || credential.revoked) throw pollNotFound()',
        'if (!credential) throw pollNotFound()',
      ],
    ],
    [
      'recovery mints a fresh credential',
      verifyRecovery,
      [
        '      { generation: credential.generation, ciphertext: credential.capability_ciphertext },\n',
        "      await issueCredential(trx, poll, voter.id, 'voting', poll.deadline, secret),\n",
      ],
    ],
    [
      'recovery revokes the credential it re-delivers',
      verifyRecovery,
      [
        "    await queueCredentialMail(\n      trx,\n      poll,\n      voter.id,\n      'recovery',",
        "    await retireCredentials(trx, poll, voter.id, purpose, 'revoked')\n    await queueCredentialMail(\n      trx,\n      poll,\n      voter.id,\n      'recovery',",
      ],
    ],
    [
      'recovery revokes the credential it re-delivers (race)',
      verifyRecoveryResendRace,
      [
        "    await queueCredentialMail(\n      trx,\n      poll,\n      voter.id,\n      'recovery',",
        "    await retireCredentials(trx, poll, voter.id, purpose, 'revoked')\n    await queueCredentialMail(\n      trx,\n      poll,\n      voter.id,\n      'recovery',",
      ],
    ],
    [
      'recovery ignores its cooldown',
      verifyRecovery,
      ['||\n      counter.recoveryCooling\n', '|| false\n'],
    ],
    [
      'recovery ignores its cap',
      verifyRecovery,
      ['counter.recovery_count >= MEETING_POLL_LIMITS.maxRecoveriesPerCredential ||', 'false ||'],
    ],
    [
      'recovery reaches withdrawn voters',
      verifyRecovery,
      [
        "if (!voter || voter.status === 'withdrawn' || voter.expired) return",
        'if (!voter || voter.expired) return',
      ],
    ],
    [
      'recovery ignores the poll state',
      verifyRecovery,
      ['if (!poll || !votingOpenOrClosedEarly(poll)) return', 'if (!poll) return'],
    ],
    [
      'recovery re-delivers expired credentials',
      verifyExpiredCredential,
      [
        "if (!voter || voter.status === 'withdrawn' || voter.expired) return",
        "if (!voter || voter.status === 'withdrawn') return",
      ],
      ['      .where(sql<boolean>`expires_at > ${poll.at}::timestamptz`)\n', ''],
    ],
    [
      'recovery spends the resend allowance',
      verifyCounters,
      [
        '        recovery_count: counter.recovery_count + 1,\n',
        '        recovery_count: counter.recovery_count + 1,\n        resend_count: Math.min(3, counter.resend_count + 1),\n',
      ],
    ],
    [
      'a resend keeps the old recovery allowance',
      verifyCounters,
      [
        "        recovery_count: 0,\n        last_recovery_at: null,\n        updated_at: poll.at,\n      })\n      .where('poll_id', '=', poll.id)\n      .where('email_key', '=', voter.email_key)",
        "        updated_at: poll.at,\n      })\n      .where('poll_id', '=', poll.id)\n      .where('email_key', '=', voter.email_key)",
      ],
    ],
    [
      'resends ignore their cooldown',
      verifyCounters,
      [
        '    if (counter.resendRetryAfter !== null)\n      throw new MeetingPollRateLimitError(counter.resendRetryAfter)\n',
        '',
      ],
    ],
    [
      'resends ignore their cap',
      verifyCounters,
      [
        '    if (counter.resend_count >= MEETING_POLL_LIMITS.maxResendsPerMailbox)\n      throw new MeetingPollRateLimitError()\n',
        '',
      ],
    ],
    [
      'a resend keeps the old credential',
      verifyResend,
      ["    await retireCredentials(trx, poll, voter.id, 'voting', 'revoked')\n", ''],
    ],
    [
      'resend ignores expectedHostRevision',
      verifyResend,
      ['    requireHostRevision(locked, request.expectedHostRevision)\n', ''],
    ],
    [
      'resend checks the revision before its receipt',
      verifyResend,
      [
        '    // A lost successful response stays recoverable after the revision has advanced.\n',
        '    requireHostRevision(locked, request.expectedHostRevision)\n',
      ],
    ],
    [
      'resend replay ignores the request fingerprint',
      verifyResend,
      [
        '      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()\n      return { poll: await loadPoll(trx, ctx, poll.id), voterId, replayed: true }',
        '      return { poll: await loadPoll(trx, ctx, poll.id), voterId, replayed: true }',
      ],
    ],
    [
      'resend reaches public voters',
      verifyResend,
      [
        'if (!voter || voter.invited_at === null) throw pollNotFound()',
        'if (!voter) throw pollNotFound()',
      ],
    ],
    [
      'resend reaches withdrawn invitees',
      verifyResend,
      ['    if (voter.withdrawn_at !== null) throw voterWithdrawn()\n', ''],
    ],
    [
      'invitation replay ignores the request fingerprint',
      verifyInviteReplay,
      [
        '      if (!previous.request_fingerprint.equals(receipt.fingerprint)) throw keyReused()\n      const current',
        '      const current',
      ],
    ],
    [
      'invitations skip their receipt lookup',
      verifyInviteReplay,
      [
        '    const previous = await lockedReceipt(trx, receipt)\n    const keys',
        '    const previous = undefined as any\n    const keys',
      ],
    ],
    [
      'invitations check open voting before replay',
      verifyInviteReplay,
      [
        '    const previous = await lockedReceipt(trx, receipt)\n    const keys',
        '    requireHostVotingOpen(locked)\n    const previous = await lockedReceipt(trx, receipt)\n    const keys',
      ],
    ],
    ['public writes skip the poll row lock (capacity)', verifyCapacityRace, NO_POLL_LOCK],
    ['public writes skip the poll row lock (IP cap)', verifyIpRace, NO_POLL_LOCK],
    ['public writes skip the poll row lock (verification)', verifyVerificationRace, NO_POLL_LOCK],
    [
      'enrollment ignores a link rotated while it waited',
      verifyRotationRace,
      [
        "    .$if(publicTokenDigest !== undefined, (query) =>\n      query.where('public_token_digest', '=', publicTokenDigest as Buffer),\n    )\n",
        '',
      ],
    ],
    [
      'public writes lock the poll before the organization',
      verifyPublicLockOrder,
      [
        '  try {\n    await lockOrganization(trx, named.organization_id)\n  } catch (error) {\n    if (error instanceof DomainError) return undefined\n    throw error\n  }\n',
        '',
      ],
    ],
  ]

  // Only a failed assertion counts: a mutant that crashes or cannot load is not a detection.
  it.each(mutations)(
    'detects the mutation: %s',
    async (_name, verify, ...replacements) => {
      const mutated = await sourceCopy(...replacements)
      await expect(verify(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
    },
    60_000,
  )
})
