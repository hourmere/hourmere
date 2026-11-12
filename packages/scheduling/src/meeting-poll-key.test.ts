// biome-ignore-all lint/suspicious/noTemplateCurlyInString: source-copy mutations target literal template strings
// The meeting-poll key fence (meeting-poll-key.ts) on real throwaway databases. Each scenario
// gets its own copy of a migrated template, because the fence is installation-wide. The
// scenarios run against the real modules and then against source copies with one protection
// broken; a mutant counts as detected only when a real assertion fails.
import { createHmac, hkdfSync, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db, runMigrations } from '@hourmere/db'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Key from './meeting-poll-key.ts'
import * as Voters from './meeting-poll-voters.ts'
import * as Polls from './meeting-polls.ts'
import { createFixtures, createTestTeam, createTestUser, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type KeyModule = typeof Key
type VoterModule = typeof Voters
interface Modules {
  K: KeyModule
  V: VoterModule
}

// Over 32 characters, so a fingerprint of a truncated secret would match a longer one, and
// with prefixes that appear nowhere else, so a leaked prefix is found in any encoding.
const A = 'Zq7xAlphaFenceSecret-0123456789-abcdefghijk'
const B = 'Wv4yBravoFenceSecret-0123456789-abcdefghijk'

const keyLocation = new URL('./meeting-poll-key.ts', import.meta.url)
const votersLocation = new URL('./meeting-poll-voters.ts', import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))

/** The fingerprint the fence must store, derived here independently of the module. */
function expectedFingerprint(secret: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', secret, 'hourmere/meeting-poll', 'key-version/v1', 32))
  return createHmac('sha256', key).update('hourmere/meeting-poll-key-fingerprint/v1').digest()
}

type Replacement = readonly [from: string, to: string]

/** Module source with the replacements applied and every import made absolute. */
function moduleSource(
  location: URL,
  replacements: readonly Replacement[],
  override: Record<string, string> = {},
): string {
  let source = readFileSync(location, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.includes(from), `mutation must match source: ${from}`).toBe(true)
    source = source.replaceAll(from, to)
  }
  return stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${
        override[specifier] ??
        (specifier.startsWith('node:')
          ? specifier
          : specifier.startsWith('.')
            ? new URL(specifier, location).href
            : pathToFileURL(createRequire(location).resolve(specifier)).href)
      }'`,
  )
}

const dataUrl = (code: string) =>
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`

interface Mutation {
  key?: readonly Replacement[]
  voters?: readonly Replacement[]
}

/** Isolated copies of the fence and the voter services; production files are never touched. */
async function load(mutation: Mutation): Promise<Modules> {
  const keyUrl = dataUrl(moduleSource(keyLocation, mutation.key ?? []))
  const K = (await import(keyUrl)) as KeyModule
  const V = (await import(
    dataUrl(
      moduleSource(votersLocation, mutation.voters ?? [], { './meeting-poll-key.ts': keyUrl }),
    )
  )) as VoterModule
  return { K, V }
}

/** Source copies load their own error classes, so compare by name and code. */
async function refusal(action: () => Promise<unknown>) {
  const error = await action().then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof Error)) return expect.unreachable('expected the key fence to refuse')
  return { name: error.name, code: (error as { code?: unknown }).code }
}
const MISMATCH = { name: 'MeetingPollKeyMismatchError', code: 'meeting_poll_key_mismatch' }

/** Expected success, reported as an assertion so that a throwing mutant is not a crash. */
async function succeeds<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
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

const ALWAYS = {
  timeZone: 'UTC',
  weeklyHours: {
    ...weekdays({ start: '00:00', end: '24:00' }),
    saturday: [{ start: '00:00', end: '24:00' }],
    sunday: [{ start: '00:00', end: '24:00' }],
  },
}

let template: TestDatabaseTemplate | undefined

/** One scenario on its own migrated database, which is dropped afterwards. */
async function scenario<T>(run: (db: Db) => Promise<T>): Promise<T> {
  const owned = await (template as TestDatabaseTemplate).clone(undefined, { tag: 'poll_key' })
  try {
    return await run(createDb(owned.pool))
  } finally {
    await owned.drop()
  }
}

/** What the transport step does at server start. */
const start = (K: KeyModule, db: Db, secret: string) =>
  db.transaction().execute((trx) => K.ensureMeetingPollKey(trx, secret))

async function keyState(db: Db) {
  return db
    .selectFrom('meeting_poll_key_state')
    .select(['singleton', 'secret_fingerprint', sql<string>`xmin::text`.as('version')])
    .execute()
}

async function fingerprint(db: Db) {
  const rows = await keyState(db)
  expect(rows).toHaveLength(1)
  return rows[0]?.secret_fingerprint
}

/** Every meeting-poll row, the key state included, to prove a refusal wrote nothing. */
async function snapshot(db: Db) {
  const tables = await sql<{ name: string }>`SELECT table_name AS name
    FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'meeting_poll%'
    ORDER BY table_name`.execute(db)
  const result: Record<string, string[]> = {}
  for (const { name } of tables.rows)
    result[name] = (
      await sql<{ row: string }>`SELECT to_jsonb(t)::text AS row FROM ${sql.table(name)} t
        ORDER BY 1`.execute(db)
    ).rows.map((row) => row.row)
  return result
}

/** Waits until `count` sessions wait for the fence's advisory lock; false after 10 seconds. */
async function fenceWaiters(db: Db, count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(db)
    if ((rows[0]?.waiting ?? 0) >= count) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

/** Waits until a session waits for a row lock; false after 10 seconds. */
async function rowWaiters(db: Db): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype IN ('transactionid', 'tuple') AND NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`.execute(
      db,
    )
    if ((rows[0]?.waiting ?? 0) >= 1) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

/** Holds a poll row FOR UPDATE until released, so a voter write waits after its fence. */
async function holdPoll(db: Db, pollId: string) {
  const locked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const done = db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('meeting_polls')
      .select('id')
      .where('id', '=', pollId)
      .forUpdate()
      .execute()
    locked.resolve()
    await release.promise
  })
  await locked.promise
  return {
    release: async () => {
      release.resolve()
      await done
    },
  }
}

/** Settles a promise into a value or its error, so waiting on it never throws. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error: error as Error & { code?: unknown } }),
  )

// --- Polls and voter writes ------------------------------------------------------------------

async function databaseNow(db: Db) {
  const { rows } = await sql<{ now: string }>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`.execute(db)
  return Temporal.Instant.from(rows[0]?.now as string)
}

/** An open public-link poll, created through the host service, with a host context per secret. */
async function openPoll(db: Db) {
  const fixtures = createFixtures(db)
  const admin = await createTestUser(db, 'Team Admin')
  const member = await createTestUser(db, 'Configured Host')
  for (const user of [admin, member]) await fixtures.schedule(user.id, ALWAYS)
  const team = await createTestTeam(db, [
    { user: admin, role: 'admin' },
    { user: member, role: 'member' },
  ])
  const eventTypeId = await fixtures.eventType(team.id, null, { hosts: [{ userId: member.id }] })
  const host = (secret: string): Voters.MeetingPollHostContext => ({
    ...testContext(db, session(team.as(admin))),
    meetingPollSecret: secret,
  })
  const deadline = (await databaseNow(db))
    .round({ smallestUnit: 'hour', roundingMode: 'ceil' })
    .add({ hours: 24 })
  const created = await Polls.createMeetingPoll(host(A), {
    eventTypeId,
    candidateStarts: [
      deadline.add({ hours: 25 }).toString(),
      deadline.add({ hours: 26 }).toString(),
    ],
    deadlineAt: deadline.toString(),
    displayTimeZone: 'UTC',
    admissionMode: 'public_link',
    idempotencyKey: randomUUID(),
  })
  return {
    db,
    host,
    organizationId: team.id,
    pollId: created.poll.id,
    link: created.publicToken as string,
  }
}
type Poll = Awaited<ReturnType<typeof openPoll>>

const pub = (db: Db, secret: string, ip = '192.0.2.10'): Voters.MeetingPollPublicContext => ({
  db,
  meetingPollSecret: secret,
  trustedIp: ip,
})

const enroll = (V: VoterModule, p: Poll, secret: string, email: string, ip = '192.0.2.10') =>
  V.enrollMeetingPollVoter(pub(p.db, secret, ip), {
    publicToken: p.link,
    name: 'Voter',
    email,
    timeZone: 'UTC',
  })

const invite = (V: VoterModule, p: Poll, secret: string, email: string) =>
  V.inviteMeetingPollVoters(p.host(secret), {
    id: p.pollId,
    invitees: [{ name: 'Invitee', email }],
    idempotencyKey: randomUUID(),
  })

async function voterRows(p: Poll, email: string) {
  return p.db
    .selectFrom('meeting_poll_voters')
    .select(['id', 'email_key'])
    .where('poll_id', '=', p.pollId)
    .where('email', '=', email)
    .execute()
}

/** The credential in the mailbox's newest queued mail, opened with `secret`. */
async function mailed(p: Poll, email: string, secret: string) {
  const [voter] = await voterRows(p, email)
  if (!voter) return expect.unreachable(`no voter row for ${email}`)
  const [delivery] = await p.db
    .selectFrom('meeting_poll_deliveries')
    .select(['generation', 'capability_ciphertext'])
    .where('voter_id', '=', voter.id)
    .where('capability_ciphertext', 'is not', null)
    .orderBy('id', 'desc')
    .execute()
  const opened = Voters.openMeetingPollCredential(
    secret,
    {
      organizationId: p.organizationId,
      pollId: p.pollId,
      voterId: voter.id,
      generation: delivery?.generation ?? 0,
    },
    delivery?.capability_ciphertext ?? null,
  )
  if (!opened) return expect.unreachable(`mail for ${email} does not open`)
  return { voterId: voter.id, token: opened.token }
}

/** What a later removal step leaves: no voter row, only the mailbox tombstone. */
async function remove(p: Poll, secret: string, email: string) {
  await p.db
    .deleteFrom('meeting_poll_voters')
    .where('poll_id', '=', p.pollId)
    .where('email', '=', email)
    .execute()
  await sql`UPDATE meeting_poll_mailbox_counters SET removed_at = clock_timestamp()
    WHERE poll_id = ${p.pollId}
      AND email_key = ${Voters.meetingPollMailboxKey(secret, p.pollId, email)}`.execute(p.db)
}

/** Every stored credential ciphertext, each opened with `secret`. */
async function ciphertextsOpen(p: Poll, secret: string) {
  const rows = await sql<{ voter_id: string; generation: number; ciphertext: Buffer }>`
    SELECT voter_id, generation, capability_ciphertext AS ciphertext FROM meeting_poll_capabilities
      WHERE poll_id = ${p.pollId} AND capability_ciphertext IS NOT NULL
    UNION ALL
    SELECT voter_id, generation, capability_ciphertext FROM meeting_poll_deliveries
      WHERE poll_id = ${p.pollId} AND capability_ciphertext IS NOT NULL`.execute(p.db)
  return rows.rows.map(
    (row) =>
      Voters.openMeetingPollCredential(
        secret,
        {
          organizationId: p.organizationId,
          pollId: p.pollId,
          voterId: row.voter_id,
          generation: row.generation,
        },
        row.ciphertext,
      ) !== undefined,
  )
}

// --- Scenarios ---------------------------------------------------------------------------------

/** First use records a keyed fingerprint once; the same secret then changes nothing. */
async function verifyFirstUse({ K }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const [recorded] = await keyState(db)
    expect(recorded?.singleton).toBe(true)
    expect(recorded?.secret_fingerprint).toEqual(expectedFingerprint(A))
    await succeeds(() => start(K, db, A))
    expect(await keyState(db), 'the same secret rewrites nothing').toEqual([recorded])
    // Outside a transaction the advisory lock would end with the statement.
    expect(
      await K.ensureMeetingPollKey(db, A).then(
        () => 'accepted',
        (error: Error) => error.message,
      ),
    ).toBe('Meeting poll key checks need a transaction')
    // A later snapshot would miss writers that committed while the check waited.
    expect(
      await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute((trx) => K.ensureMeetingPollKey(trx, A))
        .then(
          () => 'accepted',
          (error: Error) => error.message,
        ),
    ).toBe('Meeting poll key checks need a read committed transaction')
  })
}

/**
 * The rotation hazards, each tried under a switched secret: a second enrollment of a
 * known mailbox, re-entry of a removed mailbox, a second place for a re-invited invitee,
 * recovery that would queue nothing (or an undecryptable copy), verification and resend. Each
 * is refused and nothing is written; restoring the secret restores service.
 */
async function verifySwitchedSecret({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    await succeeds(() => enroll(V, p, A, 'alice@example.com', '192.0.2.1'))
    await succeeds(() => enroll(V, p, A, 'bob@example.com', '192.0.2.2'))
    await succeeds(() => enroll(V, p, A, 'dave@example.com', '192.0.2.3'))
    await succeeds(() => invite(V, p, A, 'carol@example.com'))
    await remove(p, A, 'bob@example.com')
    const alice = await mailed(p, 'alice@example.com', A)
    const [carol] = await voterRows(p, 'carol@example.com')
    const before = await snapshot(db)
    const { host_revision } = await db
      .selectFrom('meeting_polls')
      .select('host_revision')
      .where('id', '=', p.pollId)
      .executeTakeFirstOrThrow()

    const attempts: [string, () => Promise<unknown>][] = [
      ['enroll a known mailbox again', () => enroll(V, p, B, 'alice@example.com', '192.0.2.4')],
      ['enroll a removed mailbox', () => enroll(V, p, B, 'bob@example.com', '192.0.2.5')],
      ['invite an invitee again', () => invite(V, p, B, 'carol@example.com')],
      [
        'recover a voter enrolled under the old secret',
        () =>
          V.recoverMeetingPollVoter(pub(db, B), { pollId: p.pollId, email: 'dave@example.com' }),
      ],
      ['verify a mailbox', () => V.verifyMeetingPollVoter(pub(db, B), { token: alice.token })],
      [
        'resend an invitation',
        () =>
          V.resendMeetingPollInvitation(p.host(B), {
            id: p.pollId,
            voterId: carol?.id as string,
            expectedHostRevision: host_revision,
            idempotencyKey: randomUUID(),
          }),
      ],
    ]
    for (const [name, attempt] of attempts) expect(await refusal(attempt), name).toEqual(MISMATCH)
    expect(await snapshot(db), 'refusals write nothing').toEqual(before)
    expect(await fingerprint(db)).toEqual(expectedFingerprint(A))
    expect(await ciphertextsOpen(p, A), 'no ciphertext under another secret').not.toContain(false)

    // Restoring the secret the data was written under restores service unchanged.
    await succeeds(() =>
      V.recoverMeetingPollVoter(pub(db, A), { pollId: p.pollId, email: 'dave@example.com' }),
    )
    const recovery = await db
      .selectFrom('meeting_poll_deliveries')
      .select('kind')
      .where('poll_id', '=', p.pollId)
      .where('kind', '=', 'recovery')
      .execute()
    expect(recovery).toHaveLength(1)
    expect(await ciphertextsOpen(p, A)).not.toContain(false)
    expect(await voterRows(p, 'alice@example.com')).toHaveLength(1)
    expect(await voterRows(p, 'bob@example.com')).toHaveLength(0)
  })
}

/**
 * The startup check that the transport step will call. Without keyed data a different secret
 * is recorded; with any keyed data (a voter row or a removal tombstone) it is refused and
 * nothing changes.
 */
async function verifyStartupCheck({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    // Polls hold no keyed data: a secret changed before any voter exists is recorded.
    await succeeds(() => start(K, db, B))
    expect(await fingerprint(db)).toEqual(expectedFingerprint(B))
    await succeeds(() => enroll(V, p, B, 'ann@example.com'))

    const refused = async (stage: string) => {
      const before = await snapshot(db)
      expect(await refusal(() => start(K, db, A)), stage).toEqual(MISMATCH)
      expect(await snapshot(db), `${stage}: nothing written`).toEqual(before)
    }
    await refused('voter data')
    // Only voter rows remain: no mailbox counter.
    await db.deleteFrom('meeting_poll_mailbox_counters').execute()
    await refused('voter rows only')
    // Only a removal tombstone remains.
    await db.deleteFrom('meeting_poll_voters').execute()
    await db
      .insertInto('meeting_poll_mailbox_counters')
      .values({
        organization_id: p.organizationId,
        poll_id: p.pollId,
        email_key: Voters.meetingPollMailboxKey(B, p.pollId, 'ann@example.com'),
        removed_at: sql<string>`clock_timestamp()`,
      })
      .execute()
    await refused('a removal tombstone only')
    // No keyed data is left (the poll stays): the other secret is recorded again.
    await db.deleteFrom('meeting_poll_mailbox_counters').execute()
    await succeeds(() => start(K, db, A))
    expect(await fingerprint(db)).toEqual(expectedFingerprint(A))
    expect(await db.selectFrom('meeting_polls').select('id').execute()).toHaveLength(1)
    // A fingerprint lost beside keyed data is never re-adopted: every secret is refused.
    await succeeds(() => enroll(V, p, A, 'bea@example.com'))
    await db.deleteFrom('meeting_poll_key_state').execute()
    for (const secret of [A, B])
      expect(await refusal(() => start(K, db, secret)), 'a lost fingerprint').toEqual(MISMATCH)
    expect(await keyState(db)).toEqual([])
  })
}

/** A process with another secret is refused at once, without waiting for in-flight writers. */
async function verifyRefusalWithoutLock({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    await succeeds(() => enroll(V, p, A, 'ann@example.com'))
    const holder = await holdPoll(db, p.pollId)
    const writer = settle(enroll(V, p, A, 'bea@example.com', '192.0.2.20'))
    const writerWaits = await rowWaiters(db)
    const other = settle(start(K, db, B))
    const early = await Promise.race([
      other,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ])
    await holder.release()
    expect(writerWaits, 'the writer holds the fence while it waits for the poll row').toBe(true)
    expect((await writer).error).toBeUndefined()
    const refused = (await other).error
    expect({ name: refused?.name, code: refused?.code }, 'the other secret').toEqual(MISMATCH)
    expect(early, 'refused while the writer still holds the fence').toBeDefined()
  })
}

/** Near misses never pass: letter case, a longer secret, one changed character or byte. */
async function verifyNearMisses({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    await succeeds(() => enroll(V, p, A, 'ann@example.com'))
    const swapped = [...A]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('')
    expect(swapped.toLowerCase()).toBe(A.toLowerCase())
    for (const [name, secret] of [
      ['other letter case', swapped],
      ['one more character', `${A}x`],
      ['last character changed', `${A.slice(0, -1)}8`],
    ] as const)
      expect(await refusal(() => start(K, db, secret)), name).toEqual(MISMATCH)
    const recorded = expectedFingerprint(A)
    for (const [name, index] of [
      ['first byte', 0],
      ['last byte', 31],
    ] as const) {
      const changed = Buffer.from(recorded)
      changed[index] = (changed[index] as number) ^ 1
      await db.updateTable('meeting_poll_key_state').set({ secret_fingerprint: changed }).execute()
      expect(await refusal(() => start(K, db, A)), `stored ${name} differs`).toEqual(MISMATCH)
    }
    await db.updateTable('meeting_poll_key_state').set({ secret_fingerprint: recorded }).execute()
    await succeeds(() => start(K, db, A))
  })
}

/**
 * Concurrent first uses over two connections record one row. With the same secret the second
 * waits for the first and then passes; with another secret it waits while the first use writes
 * voter data and is then refused.
 */
async function verifyFirstUseRace({ K, V }: Modules) {
  await scenario(async (db) => {
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = settle(
      db.transaction().execute(async (trx) => {
        await K.ensureMeetingPollKey(trx, A)
        held.resolve()
        await release.promise
      }),
    )
    await held.promise
    const second = settle(start(K, db, A))
    const waited = await fenceWaiters(db, 1)
    release.resolve()
    expect((await first).error).toBeUndefined()
    expect((await second).error, 'the second first use passes').toBeUndefined()
    expect(waited, 'the second first use waits for the first').toBe(true)
    expect(await keyState(db)).toHaveLength(1)
    expect(await fingerprint(db)).toEqual(expectedFingerprint(A))
  })
  await scenario(async (db) => {
    const p = await openPoll(db)
    const holder = await holdPoll(db, p.pollId)
    // The enrollment records its secret first, then waits for the poll row.
    const enrollment = settle(enroll(V, p, A, 'ann@example.com'))
    const enrollmentWaits = await rowWaiters(db)
    const other = settle(start(K, db, B))
    const otherWaits = await fenceWaiters(db, 1)
    await holder.release()
    expect(enrollmentWaits, 'the enrollment waits for the poll row').toBe(true)
    expect((await enrollment).error).toBeUndefined()
    const refused = (await other).error
    expect({ name: refused?.name, code: refused?.code }, 'the other secret').toEqual(MISMATCH)
    expect(otherWaits, 'the other first use waits for the enrollment').toBe(true)
    expect(await keyState(db)).toHaveLength(1)
    expect(await fingerprint(db)).toEqual(expectedFingerprint(A))
    expect(await voterRows(p, 'ann@example.com')).toHaveLength(1)
  })
}

/** A key change waits for writers under the recorded key, then sees their data and refuses. */
async function verifyChangeWaitsForWriters({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    const holder = await holdPoll(db, p.pollId)
    const enrollment = settle(enroll(V, p, A, 'ann@example.com'))
    const enrollmentWaits = await rowWaiters(db)
    const change = settle(start(K, db, B))
    const changeWaits = await fenceWaiters(db, 1)
    await holder.release()
    expect(enrollmentWaits, 'the enrollment waits for the poll row').toBe(true)
    expect((await enrollment).error).toBeUndefined()
    const refused = (await change).error
    expect({ name: refused?.name, code: refused?.code }, 'the key change').toEqual(MISMATCH)
    expect(changeWaits, 'the key change waits for the in-flight writer').toBe(true)
    expect(await fingerprint(db)).toEqual(expectedFingerprint(A))
    expect(await voterRows(p, 'ann@example.com')).toHaveLength(1)
  })
}

/** A writer that saw the old key before a change committed fails closed instead of writing. */
async function verifyStaleWriter({ K, V }: Modules) {
  await scenario(async (db) => {
    await succeeds(() => start(K, db, A))
    const p = await openPoll(db)
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const change = settle(
      db.transaction().execute(async (trx) => {
        await K.ensureMeetingPollKey(trx, B)
        held.resolve()
        await release.promise
      }),
    )
    await held.promise
    const enrollment = settle(enroll(V, p, A, 'ann@example.com'))
    const waits = await fenceWaiters(db, 1)
    release.resolve()
    expect((await change).error).toBeUndefined()
    const refused = (await enrollment).error
    expect({ name: refused?.name, code: refused?.code }, 'the stale writer').toEqual(MISMATCH)
    expect(waits, 'the writer waits for the key change').toBe(true)
    expect(await fingerprint(db)).toEqual(expectedFingerprint(B))
    expect(await voterRows(p, 'ann@example.com')).toHaveLength(0)
  })
}

/** Neither secret, nor a prefix of it in any encoding, reaches a table, a log line or an error. */
async function verifyNoSecretMaterial({ K, V }: Modules) {
  const output: string[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }),
  )
  try {
    await scenario(async (db) => {
      await succeeds(() => start(K, db, A))
      const p = await openPoll(db)
      await succeeds(() => enroll(V, p, A, 'ann@example.com'))
      await succeeds(() => invite(V, p, A, 'carol@example.com'))
      const ann = await mailed(p, 'ann@example.com', A)
      await succeeds(() => V.verifyMeetingPollVoter(pub(db, A), { token: ann.token }))
      await succeeds(() =>
        V.recoverMeetingPollVoter(pub(db, A), { pollId: p.pollId, email: 'ann@example.com' }),
      )
      const refused = await start(K, db, B).then(
        () => expect.unreachable('expected the key fence to refuse'),
        (error: Error) => error,
      )
      output.push(String(refused.message), String(refused.stack))
      const tables = await sql<{ schema: string; name: string }>`SELECT table_schema AS schema,
          table_name AS name FROM information_schema.tables
        WHERE table_schema IN ('public', 'auth') AND table_type = 'BASE TABLE'`.execute(db)
      const dump: string[] = []
      for (const table of tables.rows)
        for (const row of (
          await sql<{ row: string }>`SELECT to_jsonb(t)::text AS row
            FROM ${sql.table(`${table.schema}.${table.name}`)} t`.execute(db)
        ).rows)
          dump.push(row.row)
      const haystack = [...dump, ...output].join('\n').toLowerCase()
      for (const secret of [A, B]) {
        const bytes = Buffer.from(secret)
        for (const needle of [
          secret,
          bytes.subarray(0, 16).toString('hex'),
          bytes.subarray(0, 16).toString('base64'),
        ])
          expect(haystack.includes(needle.toLowerCase()), `found ${needle}`).toBe(false)
      }
      // The scan sees stored bytes: the recorded fingerprint is in it.
      expect(dump.join('\n')).toContain(expectedFingerprint(A).toString('hex'))
    })
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

// --- Static wiring checks ------------------------------------------------------------------------

/** Exported services in a voter module that receive a voter context, with their fence state. */
function fencedServices(source: string) {
  const services = [
    ...source.matchAll(
      /^export async function (\w+)\(\n {2}ctx: MeetingPoll(?:Public|Host)Context,/gm,
    ),
  ]
  return services.map((match, index) => {
    const body = source.slice(match.index, services[index + 1]?.index ?? source.length)
    const opening = '.transaction().execute(async (trx) => {\n'
    const at = body.indexOf(opening)
    const first =
      at < 0
        ? ''
        : (body
            .slice(at + opening.length)
            .split('\n')[0]
            ?.trim() ?? '')
    return { service: match[1], fenced: /^await ensureMeetingPollKey\(trx, \S/.test(first) }
  })
}

const voterModules = () =>
  readdirSync(new URL('.', import.meta.url))
    .filter((file) => /^meeting-poll-[a-z-]+\.ts$/.test(file) && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(new URL(file, import.meta.url), 'utf8') }))

function verifyEveryServiceFenced(modules: { file: string; source: string }[]) {
  const services = modules.flatMap(({ file, source }) =>
    fencedServices(source).map((entry) => ({ file, ...entry })),
  )
  expect(services.map((entry) => entry.service)).toEqual(
    expect.arrayContaining([
      'enrollMeetingPollVoter',
      'verifyMeetingPollVoter',
      'recoverMeetingPollVoter',
      'inviteMeetingPollVoters',
      'resendMeetingPollInvitation',
      'submitMeetingPollBallot',
      'withdrawMeetingPollVoter',
      'optOutOfMeetingPollReminders',
    ]),
  )
  for (const entry of services)
    expect(entry.fenced, `${entry.file} ${entry.service} takes the key fence first`).toBe(true)
}

// The fence names that production code may use, and where: the generated table types, the
// storage test support and the meeting-poll services. The transport step that supplies the
// secret adds its server start (and its workers) here when it wires the startup check.
const FENCE_NAMES = /ensureMeetingPollKey|MeetingPollKeyMismatchError|meeting[-_]poll[-_]key/i
const FENCE_USERS =
  /^packages\/(db\/src\/(tables|meeting-poll-key-state-[a-z]+)\.ts|scheduling\/src\/meeting-poll-[a-z-]+\.ts)$/

/** Every non-test source file in the src directory of each apps, packages and tools workspace. */
function productionSources(): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        files.push(relative(root, path))
    }
  }
  for (const group of ['apps', 'packages', 'tools'])
    for (const name of readdirSync(join(root, group))) {
      const source = join(root, group, name, 'src')
      try {
        if (statSync(source).isDirectory()) walk(source)
      } catch {
        // Not a workspace with sources.
      }
    }
  return files.sort()
}

describe('meeting poll key fence wiring (off: no transport supplies the secret)', () => {
  it('runs every voter service through the key fence before anything else', () => {
    verifyEveryServiceFenced(voterModules())
  })

  it.each([
    'enrollMeetingPollVoter',
    'verifyMeetingPollVoter',
    'recoverMeetingPollVoter',
    'inviteMeetingPollVoters',
    'resendMeetingPollInvitation',
  ])('detects a source copy where %s skips the fence', (service) => {
    const modules = voterModules().map(({ file, source }) => {
      const at = source.indexOf(`export async function ${service}(`)
      if (at < 0) return { file, source }
      const fence = source.indexOf('    await ensureMeetingPollKey(trx, secret)\n', at)
      expect(fence, `${service} has a fence call`).toBeGreaterThan(at)
      return {
        file,
        source:
          source.slice(0, fence) +
          source.slice(fence + '    await ensureMeetingPollKey(trx, secret)\n'.length),
      }
    })
    expect(() => verifyEveryServiceFenced(modules)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('is used only by the meeting-poll services, so no production surface calls it yet', () => {
    const users = productionSources().filter((file) =>
      FENCE_NAMES.test(readFileSync(join(root, file), 'utf8')),
    )
    expect(users.filter((file) => !FENCE_USERS.test(file))).toEqual([])
    expect(users).toEqual(
      expect.arrayContaining([
        'packages/db/src/tables.ts',
        'packages/scheduling/src/meeting-poll-key.ts',
        'packages/scheduling/src/meeting-poll-voters.ts',
      ]),
    )
    for (const name of ['server.ts', 'jobs.ts', 'index.ts'])
      expect(
        users.some((file) => file.endsWith(`/${name}`)),
        name,
      ).toBe(false)
  })
})

describe.skipIf(!serverUrl)('meeting poll key fence', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    template = await createTestDatabaseTemplate(
      serverUrl as string,
      async (pool) => {
        await runMigrations(pool)
      },
      { tag: 'poll_key' },
    )
  }, 120_000)
  afterAll(async () => {
    await template?.drop()
  })

  const real: Modules = { K: Key, V: Voters }

  it('records a keyed fingerprint once on first use, never the secret', () => verifyFirstUse(real))
  it('refuses every voter write under a switched secret and writes nothing', () =>
    verifySwitchedSecret(real))
  it('off: the startup check refuses a mismatched key while keyed data exists', () =>
    verifyStartupCheck(real))
  it('refuses near misses of the recorded secret', () => verifyNearMisses(real))
  it('refuses another secret without waiting for in-flight writers', () =>
    verifyRefusalWithoutLock(real))
  it('serializes concurrent first uses over two connections to one row', () =>
    verifyFirstUseRace(real))
  it('makes a key change wait for in-flight writers', () => verifyChangeWaitsForWriters(real))
  it('fails a writer closed when the key changed while it waited', () => verifyStaleWriter(real))
  it('keeps secret material out of the database and the logs', () => verifyNoSecretMaterial(real))

  const FENCE_CALL = '    await ensureMeetingPollKey(trx, secret)\n'
  const fenceCallIn = (before: string): Replacement => [`${before}${FENCE_CALL}`, before]
  const mutations: [string, (m: Modules) => Promise<void>, Mutation][] = [
    ['the voter services skip the fence', verifySwitchedSecret, { voters: [[FENCE_CALL, '']] }],
    [
      'enrollment skips the fence',
      verifySwitchedSecret,
      {
        voters: [
          fenceCallIn(
            '  const digest = meetingPollPublicTokenDigest(publicToken)\n  return ctx.db.transaction().execute(async (trx) => {\n',
          ),
        ],
      },
    ],
    [
      'verification skips the fence',
      verifySwitchedSecret,
      {
        voters: [
          fenceCallIn(
            "  const voting = meetingPollCapabilityDigest('voting', token)\n  return ctx.db.transaction().execute(async (trx) => {\n",
          ),
        ],
      },
    ],
    [
      'recovery skips the fence',
      verifySwitchedSecret,
      {
        voters: [
          fenceCallIn(
            '  const pollId = input.pollId\n  await ctx.db.transaction().execute(async (trx) => {\n',
          ),
        ],
      },
    ],
    [
      'invitation skips the fence',
      verifySwitchedSecret,
      {
        voters: [
          fenceCallIn(
            '  const request = validInvitation(input)\n  return ctx.db.transaction().execute(async (trx) => {\n',
          ),
        ],
      },
    ],
    [
      'resend skips the fence',
      verifySwitchedSecret,
      {
        voters: [
          fenceCallIn(
            '  const voterId = input.voterId\n  return ctx.db.transaction().execute(async (trx) => {\n',
          ),
        ],
      },
    ],
    [
      'the fence never refuses a changed key after the lock',
      verifyChangeWaitsForWriters,
      { key: [['  if (await keyedDataExists(db)) throw new MeetingPollKeyMismatchError()\n', '']] },
    ],
    [
      'the fence never refuses a changed key',
      verifySwitchedSecret,
      {
        key: [
          ['  if (await keyedDataExists(db)) throw new MeetingPollKeyMismatchError()\n', ''],
          [
            '  if (!same && (await keyedDataExists(db))) throw new MeetingPollKeyMismatchError()\n',
            '',
          ],
        ],
      },
    ],
    [
      'another secret waits for the fence before it is refused',
      verifyRefusalWithoutLock,
      {
        key: [
          [
            '  if (!same && (await keyedDataExists(db))) throw new MeetingPollKeyMismatchError()\n',
            '',
          ],
        ],
      },
    ],
    [
      'first use ignores keyed data',
      verifyStartupCheck,
      {
        key: [
          [
            '  if (!same && (await keyedDataExists(db)))',
            '  if (!same && seen !== undefined && (await keyedDataExists(db)))',
          ],
          [
            '  if (await keyedDataExists(db)) throw new MeetingPollKeyMismatchError()\n  if (recorded === undefined)',
            '  if (recorded !== undefined && (await keyedDataExists(db))) throw new MeetingPollKeyMismatchError()\n  if (recorded === undefined)',
          ],
        ],
      },
    ],
    [
      'the recorded secret takes no lock',
      verifyChangeWaitsForWriters,
      {
        key: [
          [
            '  if (same) await sql`SELECT pg_advisory_xact_lock_shared(${FENCE})`.execute(db)\n  else',
            '  if (same) {\n  } else',
          ],
        ],
      },
    ],
    [
      'the fence runs under any isolation level',
      verifyFirstUse,
      {
        key: [
          [
            "  if (rows[0]?.isolation !== 'read committed')\n    throw new Error('Meeting poll key checks need a read committed transaction')\n",
            '',
          ],
        ],
      },
    ],
    [
      'the fence refuses a changed key even without keyed data',
      verifyStartupCheck,
      {
        key: [
          [
            '  if (await keyedDataExists(db)) throw new MeetingPollKeyMismatchError()\n',
            '  throw new MeetingPollKeyMismatchError()\n',
          ],
        ],
      },
    ],
    [
      'the fence ignores voter rows',
      verifyStartupCheck,
      { key: [['    SELECT EXISTS (SELECT FROM meeting_poll_voters)\n      OR ', '    SELECT ']] },
    ],
    [
      'the fence ignores removal tombstones',
      verifyStartupCheck,
      { key: [['\n      OR EXISTS (SELECT FROM meeting_poll_mailbox_counters)', '']] },
    ],
    [
      'the fingerprint ignores letter case',
      verifyNearMisses,
      { key: [['fingerprintOf(secret)', 'fingerprintOf(secret.toLowerCase())']] },
    ],
    [
      'the fingerprint covers only the first 32 characters',
      verifyNearMisses,
      { key: [['fingerprintOf(secret)', 'fingerprintOf(secret.slice(0, 32))']] },
    ],
    [
      'fingerprints compare only a prefix',
      verifyNearMisses,
      { key: [['?.equals(fingerprint)', '?.subarray(0, 16).equals(fingerprint.subarray(0, 16))']] },
    ],
    [
      'both first uses insert (first use shares the lock)',
      verifyFirstUseRace,
      { key: [['  if (same) await sql', '  if (same || seen === undefined) await sql']] },
    ],
    [
      'the fence trusts its read from before the lock',
      verifyFirstUseRace,
      {
        key: [['  const recorded = await recordedFingerprint(db)\n', '  const recorded = seen\n']],
      },
    ],
    [
      'a key change does not wait for writers',
      verifyChangeWaitsForWriters,
      {
        key: [
          [
            '  else await sql`SELECT pg_advisory_xact_lock(${FENCE})`',
            '  else await sql`SELECT pg_advisory_xact_lock_shared(${FENCE})`',
          ],
        ],
      },
    ],
    [
      'a writer continues after the key changed',
      verifyStaleWriter,
      { key: [['  if (same) throw new MeetingPollKeyMismatchError()\n', '  if (same) return\n']] },
    ],
    [
      'the fence runs outside a transaction',
      verifyFirstUse,
      {
        key: [
          [
            "  if (!db.isTransaction) throw new Error('Meeting poll key checks need a transaction')\n",
            '',
          ],
        ],
      },
    ],
    [
      'the secret is stored in clear',
      verifyNoSecretMaterial,
      {
        key: [
          [
            '  const fingerprint = fingerprintOf(secret)\n',
            "  const fingerprint = Buffer.from(secret.padEnd(32, '#')).subarray(0, 32)\n",
          ],
        ],
      },
    ],
  ]

  // Only a failed assertion counts: a mutant that crashes or cannot load is not a detection.
  it.each(mutations)(
    'detects the mutation: %s',
    async (_name, verify, mutation) => {
      const mutated = await load(mutation)
      await expect(verify(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
    },
    90_000,
  )
})
