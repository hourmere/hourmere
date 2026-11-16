// Routing target markers and retention (docs/routing-forms.md, step a4) against real
// PostgreSQL in a throwaway database. The first test runs before any routing row exists and
// proves the off state: the cleanup finds nothing and issues no write. Protection scenarios
// take the module as a parameter; the source-copy controls at the end require each to fail a
// real assertion on a copy with that one protection removed.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { createDb, type Db } from './index.ts'
import * as Lifecycle from './routing-lifecycle.ts'
import type { DB } from './tables.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type LifecycleModule = typeof Lifecycle
const LIFECYCLE = new URL('./routing-lifecycle.ts', import.meta.url)

/**
 * Imports an isolated, guarded copy with exactly-once replacements; the shipped file is
 * untouched. The guard makes a broken copy fail as a harness error, never as a kill.
 */
async function importCopy(...replacements: (readonly [string, string])[]) {
  let source = readFileSync(LIFECYCLE, 'utf8')
  for (const [from, to] of replacements) {
    expect(source.split(from), `mutation must match once: ${from}`).toHaveLength(2)
    source = source.replace(from, to)
  }
  const module = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, LIFECYCLE).href : import.meta.resolve(specifier)}'`,
  )
  return guardCopy(
    (await import(
      `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`
    )) as LifecycleModule,
  )
}

/** Expected success, reported as an assertion so that a throwing mutant is not a crash. */
async function succeeds<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string }
    return expect.unreachable(`expected success, got ${code} ${message}`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!serverUrl)('routing lifecycle storage', () => {
  let owned: TestDatabase
  let db: Db
  /** A cleanup connection whose lock waits fail with 55P03 after one second. */
  let noWait: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_ret' })
    db = createDb(owned.pool)
    noWait = createDb(
      new pg.Pool({ connectionString: owned.url, max: 2, options: '-c lock_timeout=1000' }),
    )
  })
  afterAll(async () => {
    await noWait?.destroy()
    await owned?.drop()
  })

  const query = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await owned.pool.query<T>(text, params)).rows

  async function insert(table: string, values: Record<string, unknown>) {
    const fields = Object.keys(values)
    const rows = await query<{ id: string }>(
      `INSERT INTO ${table} (${fields.map((field) => `"${field}"`).join(',')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(values),
    )
    return rows[0] as Record<string, unknown> & { id: string }
  }

  /** An organization with a publisher and one event-target UUID (no event FK by design). */
  async function organization() {
    const user = await insert('auth."user"', {
      name: 'Routing host',
      email: `routing-${randomUUID()}@example.test`,
      emailVerified: true,
    })
    const org = await insert('auth.organization', {
      name: 'Routing team',
      slug: `routing-${randomUUID()}`,
      createdAt: new Date(),
    })
    return { id: org.id, user: user.id }
  }
  type Org = Awaited<ReturnType<typeof organization>>

  async function form(org: Org) {
    return (
      await insert('routing_forms', {
        organization_id: org.id,
        slug: `form-${randomUUID().slice(0, 8)}`,
        created_by_user_id: org.user,
        draft: JSON.stringify({ title: 'Routing', questions: [], rules: [], fallback: {} }),
      })
    ).id
  }

  /** The next version of `formId`, optionally made current. */
  async function version(org: Org, formId: string, current = false) {
    const [{ next }] = (await query<{ next: number }>(
      'SELECT last_version_number + 1 AS next FROM routing_forms WHERE id = $1',
      [formId],
    )) as [{ next: number }]
    const { id } = await insert('routing_form_versions', {
      organization_id: org.id,
      form_id: formId,
      version_number: next,
      questions: '[]',
      rules: '[]',
      fallback: JSON.stringify({ kind: 'message', message: 'Thank you' }),
      published_by_user_id: org.user,
    })
    if (current)
      await query('UPDATE routing_forms SET published_version_id = $1 WHERE id = $2', [id, formId])
    return id
  }

  async function dependency(org: Org, versionId: string, ruleId: string, eventTypeId: string) {
    await insert('routing_target_dependencies', {
      organization_id: org.id,
      version_id: versionId,
      rule_id: ruleId,
      event_type_id: eventTypeId,
      health_code: 'ok',
      health_checked_at: new Date('2026-01-01T00:00:00Z'),
    })
  }

  /** The replay record of a publication that carried a request key. */
  async function publication(org: Org, formId: string, versionId: string) {
    await insert('routing_form_operations', {
      organization_id: org.id,
      operation: 'publish',
      actor_kind: 'session',
      actor_id: org.user,
      request_id: randomUUID(),
      request_fingerprint: randomBytes(32),
      form_id: formId,
      version_id: versionId,
    })
  }

  async function booking(org: Org) {
    return (
      await insert('bookings', {
        organization_id: org.id,
        start_at: '2030-01-01T09:00:00Z',
        end_at: '2030-01-01T09:30:00Z',
        title: 'Routed booking',
        source: 'web',
        status: 'confirmed',
      })
    ).id
  }

  /** A receipt that expires `minutes` from now (negative: already expired). */
  async function receipt(
    org: Org,
    formId: string,
    versionId: string,
    minutes: number,
    consumedBookingId: string | null = null,
  ) {
    return (
      await query<{ id: string }>(
        `INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
           answers_ciphertext, matched_rule_id, resolved_rule_id, resolved_target, created_at,
           expires_at, consumed_booking_id)
         VALUES ($1, $2, $3, md5(random()::text) || md5(random()::text), $4, 'fallback',
           'fallback', '{"kind":"message"}', now() + make_interval(mins => $5) - interval '30 minutes',
           now() + make_interval(mins => $5), $6)
         RETURNING id`,
        [
          org.id,
          formId,
          versionId,
          consumedBookingId === null ? Buffer.from('synthetic encrypted answers') : null,
          minutes,
          consumedBookingId,
        ],
      )
    )[0]?.id as string
  }

  /** A connection holding `statement`'s row locks in an open transaction. */
  async function hold(statement: string, params: unknown[]) {
    const client: pg.PoolClient = await owned.pool.connect()
    await client.query('BEGIN')
    await client.query(statement, params)
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid as number
    return {
      pid,
      async close() {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      },
    }
  }

  /**
   * Whether `work` finishes without ever waiting behind the `holders`' locks. It is false as
   * soon as a session of this database waits behind one of them, however slow the database is.
   */
  async function finishesWithoutWaiting<T>(work: Promise<T>, holders: number[]) {
    let settled = false
    const done = () => {
      settled = true
    }
    work.then(done, done)
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      if (settled) return true
      const [{ waiting }] = (await query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND pg_blocking_pids(pid) && $1::int[]`,
        [holders],
      )) as [{ waiting: number }]
      if (waiting > 0) return false
      await sleep(10)
    }
    return expect.unreachable('cleanup neither finished nor waited within a minute')
  }

  async function lockable(table: string, where: string, params: unknown[]) {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT 1 FROM ${table} WHERE ${where} FOR UPDATE NOWAIT`, params)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') return false
      throw error
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  /** Runs the version sweep to its end, returning the rows each transaction deleted. */
  async function sweep(
    L: LifecycleModule,
    options: { scan?: number; limit?: number } = {},
    on: Db = db,
  ) {
    const batches: number[] = []
    let after: string | null = null
    do {
      const result: Lifecycle.RoutingVersionCleanup = await succeeds(() =>
        L.deleteUnreferencedRoutingVersions(on, { ...options, after }),
      )
      batches.push(result.deleted)
      after = result.next
    } while (after !== null)
    return batches
  }

  async function drain(L: LifecycleModule) {
    while ((await L.purgeExpiredRoutingReceipts(db)) > 0) {}
    await sweep(L)
  }

  // --- Off: no routing data ----------------------------------------------------------------

  it('finds nothing and writes nothing while no routing data exists', async () => {
    for (const table of [
      'routing_forms',
      'routing_form_versions',
      'routing_target_dependencies',
      'routing_receipts',
    ])
      expect(await query(`SELECT 1 FROM ${table}`), table).toEqual([])
    const statements: string[] = []
    const recorded = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log: (event) => {
        statements.push(event.query.sql)
      },
    })
    expect(await Lifecycle.purgeExpiredRoutingReceipts(recorded)).toBe(0)
    expect(await Lifecycle.deleteUnreferencedRoutingVersions(recorded)).toEqual({
      deleted: 0,
      next: null,
    })
    expect(await Lifecycle.routingTargetsInUse(recorded, randomUUID(), [randomUUID()])).toEqual([])
    expect(statements.filter((statement) => /^\s*select\b/i.test(statement))).toHaveLength(3)
    expect(
      statements.filter((statement) => !/^\s*(select|begin|commit|rollback)\b/i.test(statement)),
      'no statement but reads',
    ).toEqual([])
  })

  // --- Protection scenarios ----------------------------------------------------------------

  /**
   * Markers change only on the current version of the organization's live forms, rule and
   * fallback alike; history, archived forms and other organizations keep theirs. Only the
   * dependency rows are locked.
   */
  async function marksCurrentTargetsOnly(L: LifecycleModule) {
    const org = await organization()
    const other = await organization()
    const event = randomUUID()
    const unused = randomUUID()
    const live = await form(org)
    const old = await version(org, live)
    const current = await version(org, live, true)
    const archived = await form(org)
    const archivedCurrent = await version(org, archived, true)
    await query('UPDATE routing_forms SET archived_at = now() WHERE id = $1', [archived])
    const foreign = await form(other)
    const foreignCurrent = await version(other, foreign, true)
    const rule = randomUUID()
    await dependency(org, old, rule, event)
    await dependency(org, current, rule, event)
    await dependency(org, current, 'fallback', event)
    await dependency(org, archivedCurrent, 'fallback', event)
    await dependency(other, foreignCurrent, 'fallback', event)
    // Event types that only an archived form or a superseded version targets.
    const archivedOnly = randomUUID()
    const oldOnly = randomUUID()
    await dependency(org, archivedCurrent, randomUUID(), archivedOnly)
    await dependency(org, old, randomUUID(), oldOnly)
    const health = async () =>
      Object.fromEntries(
        (
          await query<{ version_id: string; rule_id: string; health_code: string }>(
            `SELECT version_id, rule_id, health_code FROM routing_target_dependencies
             WHERE event_type_id = $1`,
            [event],
          )
        ).map((row) => [
          `${row.version_id === current ? 'current' : row.version_id === old ? 'old' : row.version_id === archivedCurrent ? 'archived' : 'foreign'}:${row.rule_id === 'fallback' ? 'fallback' : 'rule'}`,
          row.health_code,
        ]),
      )
    expect(await L.routingTargetsInUse(db, org.id, [event, unused, archivedOnly, oldOnly])).toEqual(
      [event],
    )
    const at = new Date('2026-11-12T10:00:00Z')
    expect(
      await L.setRoutingTargetHealth(
        db,
        org.id,
        [{ eventTypeId: event, health: 'unavailable' }],
        at,
      ),
    ).toBe(2)
    expect(await health(), 'the fallback is marked with the rule').toEqual({
      'current:rule': 'unavailable',
      'current:fallback': 'unavailable',
      'old:rule': 'ok',
      'archived:fallback': 'ok',
      'foreign:fallback': 'ok',
    })
    const checked = await query<{ at: Date }>(
      'SELECT health_checked_at AS at FROM routing_target_dependencies WHERE version_id = $1',
      [current],
    )
    expect(checked.map((row) => row.at.toISOString())).toEqual([at.toISOString(), at.toISOString()])
    // Unchanged rows keep their check time; nothing else is touched.
    expect(
      await L.setRoutingTargetHealth(
        db,
        org.id,
        [{ eventTypeId: event, health: 'unavailable' }],
        new Date(),
      ),
    ).toBe(0)
    expect(
      (
        await query<{ at: Date }>(
          'SELECT health_checked_at AS at FROM routing_target_dependencies WHERE version_id = $1',
          [current],
        )
      ).map((row) => row.at.toISOString()),
    ).toEqual([at.toISOString(), at.toISOString()])
    // Within the marking transaction, forms and versions stay free; dependency rows are held.
    await db.transaction().execute(async (trx) => {
      await L.setRoutingTargetHealth(trx, org.id, [{ eventTypeId: event, health: 'ok' }], at)
      expect(await lockable('routing_forms', 'id = $1', [live])).toBe(true)
      expect(await lockable('routing_form_versions', 'id = $1', [current])).toBe(true)
      expect(await lockable('routing_target_dependencies', 'version_id = $1', [current])).toBe(
        false,
      )
    })
    expect((await health())['current:fallback']).toBe('ok')
  }

  /**
   * Expired, unconsumed receipts go with their encrypted answers, oldest first and one bounded
   * batch per call; live receipts and consumed evidence stay byte for byte.
   */
  async function purgesExpiredAnswersAndKeepsEvidence(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const versionId = await version(org, formId, true)
    const expired = [
      await receipt(org, formId, versionId, -60),
      await receipt(org, formId, versionId, -30),
      await receipt(org, formId, versionId, -1),
    ]
    const live = [
      await receipt(org, formId, versionId, 10),
      await receipt(org, formId, versionId, 29),
    ]
    const consumed = [
      await receipt(org, formId, versionId, -24 * 60 * 30, await booking(org)),
      await receipt(org, formId, versionId, -5, await booking(org)),
      await receipt(org, formId, versionId, 15, await booking(org)),
    ]
    const kept = async () =>
      query<Record<string, unknown>>(
        'SELECT * FROM routing_receipts WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[...live, ...consumed]],
      )
    const before = await kept()
    expect(await L.purgeExpiredRoutingReceipts(db, 2)).toBe(2)
    expect(await kept(), 'consumed evidence and live receipts are retained').toEqual(before)
    expect(
      (
        await query<{ id: string }>('SELECT id FROM routing_receipts WHERE id = ANY($1::uuid[])', [
          expired,
        ])
      ).map((row) => row.id),
      'oldest first',
    ).toEqual([expired[2]])
    expect(await L.purgeExpiredRoutingReceipts(db, 2)).toBe(1)
    expect(await L.purgeExpiredRoutingReceipts(db, 2)).toBe(0)
    expect(
      await query('SELECT id FROM routing_receipts WHERE id = ANY($1::uuid[])', [expired]),
      'expired answers are purged',
    ).toEqual([])
    expect(await kept(), 'consumed evidence and live receipts are retained').toEqual(before)
    expect(before.filter((row) => row.answers_ciphertext !== null)).toHaveLength(2)
  }

  /** A backlog larger than a batch drains in full batches of the documented size. */
  async function drainsBacklogInBoundedBatches(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const versionId = await version(org, formId, true)
    await query(
      `INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
         answers_ciphertext, matched_rule_id, resolved_rule_id, resolved_target, created_at,
         expires_at)
       SELECT $1, $2, $3, md5(random()::text || n) || md5(random()::text || n), '\\x00',
         'fallback', 'fallback', '{}', now() - interval '2 hours' + make_interval(secs => n),
         now() - interval '90 minutes' + make_interval(secs => n)
       FROM generate_series(1, 1234) AS n`,
      [org.id, formId, versionId],
    )
    const batches: number[] = []
    for (
      let batch = await L.purgeExpiredRoutingReceipts(db);
      ;
      batch = await L.purgeExpiredRoutingReceipts(db)
    ) {
      batches.push(batch)
      if (batch === 0 || batches.length > 10) break
    }
    expect(batches).toEqual([500, 500, 234, 0])
    expect(L.ROUTING_RECEIPT_PURGE_BATCH).toBe(500)
  }

  /** A receipt another transaction holds (a booking consuming it) is skipped, not waited for. */
  async function skipsHeldReceipts(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const versionId = await version(org, formId, true)
    const held = await receipt(org, formId, versionId, -10)
    const free = await receipt(org, formId, versionId, -5)
    const holder = await hold('SELECT 1 FROM routing_receipts WHERE id = $1 FOR UPDATE', [held])
    const purge = L.purgeExpiredRoutingReceipts(db)
    try {
      expect(
        await finishesWithoutWaiting(purge, [holder.pid]),
        'cleanup never waits for a receipt lock',
      ).toBe(true)
      expect(await purge).toBe(1)
      expect(await query('SELECT id FROM routing_receipts WHERE id = $1', [free])).toEqual([])
      expect(await query('SELECT id FROM routing_receipts WHERE id = $1', [held])).toHaveLength(1)
    } finally {
      await holder.close()
      await purge.catch(() => {})
    }
    expect(await L.purgeExpiredRoutingReceipts(db)).toBe(1)
  }

  /**
   * Versions that are no form's current version and that no receipt references go with their
   * dependency rows; current versions, receipted versions (consumed evidence included) and
   * booking snapshots stay, and version numbers are never reused.
   */
  async function deletesOnlyUnreferencedVersions(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const free = await version(org, formId)
    const expiredReceipt = await version(org, formId)
    const consumedReceipt = await version(org, formId)
    const liveReceipt = await version(org, formId)
    const superseded = await version(org, formId)
    const current = await version(org, formId, true)
    const archived = await form(org)
    await version(org, archived)
    const archivedCurrent = await version(org, archived, true)
    await query('UPDATE routing_forms SET archived_at = now() WHERE id = $1', [archived])
    for (const id of [free, superseded, current])
      await dependency(org, id, 'fallback', randomUUID())
    await receipt(org, formId, expiredReceipt, -10)
    const bookingId = await booking(org)
    await receipt(org, formId, consumedReceipt, -10, bookingId)
    await receipt(org, formId, liveReceipt, 20)
    // A booking snapshot attributed to a version that cleanup removes.
    await insert('booking_routing', {
      booking_id: bookingId,
      organization_id: org.id,
      form_id: formId,
      version_id: free,
      version_number: 1,
      matched_rule_id: 'fallback',
      resolved_rule_id: 'fallback',
      questions: '[]',
      answers: '{}',
    })
    const remaining = async () =>
      (
        await query<{ id: string }>(
          'SELECT id FROM routing_form_versions WHERE organization_id = $1 ORDER BY id',
          [org.id],
        )
      ).map((row) => row.id)
    expect((await sweep(L)).reduce((sum, n) => sum + n, 0)).toBe(3)
    expect(await remaining()).toEqual(
      [expiredReceipt, consumedReceipt, liveReceipt, current, archivedCurrent].sort(),
    )
    expect(
      await query('SELECT 1 FROM routing_target_dependencies WHERE version_id = ANY($1::uuid[])', [
        [free, superseded],
      ]),
      'dependency rows go with their version',
    ).toEqual([])
    expect(
      await query('SELECT 1 FROM routing_target_dependencies WHERE version_id = $1', [current]),
    ).toHaveLength(1)
    expect(
      await query('SELECT version_id FROM booking_routing WHERE booking_id = $1', [bookingId]),
    ).toEqual([{ version_id: free }])
    expect(
      await query('SELECT last_version_number FROM routing_forms WHERE id = $1', [formId]),
    ).toEqual([{ last_version_number: 6 }])
    // Purging the expired receipt frees its version; consumed and live receipts keep theirs.
    expect(await L.purgeExpiredRoutingReceipts(db)).toBe(1)
    expect((await sweep(L)).reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(await remaining()).toEqual(
      [consumedReceipt, liveReceipt, current, archivedCurrent].sort(),
    )
  }

  /** A large version backlog drains at most `limit` per transaction, examining `scan` each. */
  async function drainsVersionsInBoundedBatches(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    await query(
      `INSERT INTO routing_form_versions (organization_id, form_id, version_number, questions,
         rules, fallback, published_by_user_id)
       SELECT $1, $2, n, '[]', '[]', '{"kind":"message","message":"Thank you"}', $3
       FROM generate_series(1, 250) AS n`,
      [org.id, formId, org.user],
    )
    await version(org, formId, true)
    expect(await sweep(L)).toEqual([100, 100, 50])
    expect(L.ROUTING_VERSION_CLEANUP_BATCH).toBe(100)
    expect(L.ROUTING_VERSION_SCAN_BATCH).toBe(1000)
    await query(
      `INSERT INTO routing_form_versions (organization_id, form_id, version_number, questions,
         rules, fallback, published_by_user_id)
       SELECT $1, $2, 251 + n, '[]', '[]', '{"kind":"message","message":"Thank you"}', $3
       FROM generate_series(1, 120) AS n`,
      [org.id, formId, org.user],
    )
    await version(org, formId, true)
    const batches = await sweep(L, { scan: 50 })
    expect(
      Math.max(...batches),
      'a transaction examines at most `scan` versions',
    ).toBeLessThanOrEqual(50)
    expect(batches.reduce((sum, n) => sum + n, 0)).toBe(121)
    expect(
      await query('SELECT count(*)::int AS count FROM routing_form_versions WHERE form_id = $1', [
        formId,
      ]),
    ).toEqual([{ count: 1 }])
  }

  /**
   * Cleanup never waits: a version a receipt insert is pinning, or one whose dependency row an
   * invalidation holds, is left for a later sweep while the others go.
   */
  async function skipsHeldVersions(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const pinned = await version(org, formId)
    const marked = await version(org, formId)
    const free = await version(org, formId)
    await version(org, formId, true)
    await dependency(org, marked, 'fallback', randomUUID())
    // A receipt insert holds this key-share lock on its version until it commits.
    const pin = await hold('SELECT 1 FROM routing_form_versions WHERE id = $1 FOR KEY SHARE', [
      pinned,
    ])
    const mark = await hold(
      "UPDATE routing_target_dependencies SET health_code = 'unavailable' WHERE version_id = $1",
      [marked],
    )
    // A publication of the form holds the form row; cleanup takes no form lock.
    const publish = await hold('SELECT 1 FROM routing_forms WHERE id = $1 FOR UPDATE', [formId])
    const cleanup = sweep(L)
    try {
      expect(
        await finishesWithoutWaiting(cleanup, [pin.pid, mark.pid, publish.pid]),
        'cleanup never waits for a lock',
      ).toBe(true)
      expect((await cleanup).reduce((sum, n) => sum + n, 0)).toBe(1)
      expect(
        (
          await query<{ id: string }>(
            'SELECT id FROM routing_form_versions WHERE id = ANY($1::uuid[])',
            [[pinned, marked, free]],
          )
        )
          .map((row) => row.id)
          .sort(),
      ).toEqual([pinned, marked].sort())
    } finally {
      await pin.close()
      await mark.close()
      await publish.close()
      await cleanup.catch(() => {})
    }
    expect((await sweep(L)).reduce((sum, n) => sum + n, 0)).toBe(2)
  }

  /**
   * Cleanup never waits for a publication replay: a replay share-locks the record of the
   * publication it returns, so a version whose record is held is left for a later sweep, while
   * the other versions go with their records. The sweep runs on a connection with a short
   * lock_timeout, so a wait would also fail it with 55P03.
   */
  async function skipsVersionsWithHeldReplayRecords(L: LifecycleModule) {
    await drain(L)
    const org = await organization()
    const formId = await form(org)
    const replayed = await version(org, formId)
    const free = await version(org, formId)
    const current = await version(org, formId, true)
    for (const id of [replayed, free, current]) await publication(org, formId, id)
    await dependency(org, replayed, 'fallback', randomUUID())
    await dependency(org, free, 'fallback', randomUUID())
    const remaining = async (table: string, column: string) =>
      (
        await query<{ id: string }>(
          `SELECT ${column} AS id FROM ${table} WHERE form_id = $1 ORDER BY ${column}`,
          [formId],
        )
      ).map((row) => row.id)
    // The replay's own lookup, which holds the record until the replay commits.
    const replay = await hold(
      `SELECT 1 FROM routing_form_operations
       WHERE organization_id = $1 AND form_id = $2 AND version_id = $3 FOR SHARE`,
      [org.id, formId, replayed],
    )
    const cleanup = sweep(L, {}, noWait)
    try {
      expect(
        await finishesWithoutWaiting(cleanup, [replay.pid]),
        'cleanup never waits for a replay',
      ).toBe(true)
      expect((await cleanup).reduce((sum, n) => sum + n, 0)).toBe(1)
      expect(await remaining('routing_form_versions', 'id')).toEqual([replayed, current].sort())
      expect(
        await remaining('routing_form_operations', 'version_id'),
        'a deleted version takes its replay record with it',
      ).toEqual([replayed, current].sort())
    } finally {
      await replay.close()
      await cleanup.catch(() => {})
    }
    // Once the replay has committed, the next sweep deletes the version and its record.
    expect((await sweep(L, {}, noWait)).reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(await remaining('routing_form_versions', 'id')).toEqual([current])
    expect(await remaining('routing_form_operations', 'version_id')).toEqual([current])
  }

  // --- The shipped module ------------------------------------------------------------------

  it('marks the current version of live forms only, the fallback included', () =>
    marksCurrentTargetsOnly(Lifecycle))

  it('purges expired answers and keeps live receipts and consumed evidence', () =>
    purgesExpiredAnswersAndKeepsEvidence(Lifecycle))

  it('drains a receipt backlog in bounded batches', () => drainsBacklogInBoundedBatches(Lifecycle))

  it('skips receipts another transaction holds instead of waiting', () =>
    skipsHeldReceipts(Lifecycle))

  it('deletes only versions that are not current and that no receipt references', () =>
    deletesOnlyUnreferencedVersions(Lifecycle))

  it('drains a version backlog in bounded batches', () => drainsVersionsInBoundedBatches(Lifecycle))

  it('skips versions and dependency rows another transaction holds instead of waiting', () =>
    skipsHeldVersions(Lifecycle))

  it('skips versions whose publication replay record another transaction holds', () =>
    skipsVersionsWithHeldReplayRecords(Lifecycle))

  it('refuses unbounded batch sizes', async () => {
    for (const limit of [0, -1, 1.5, Number.POSITIVE_INFINITY])
      await expect(Lifecycle.purgeExpiredRoutingReceipts(db, limit)).rejects.toThrow(RangeError)
    await expect(Lifecycle.deleteUnreferencedRoutingVersions(db, { scan: 0 })).rejects.toThrow(
      RangeError,
    )
  })

  // --- Source-copy mutation controls ------------------------------------------------------

  /** The copy is made first, so a stale replacement fails instead of counting as a kill. */
  async function killed(
    replacements: (readonly [string, string])[],
    scenario: (L: LifecycleModule) => Promise<unknown>,
  ) {
    await expectKilled(await importCopy(...replacements), scenario)
  }

  it('fails when marking skips the fallback', () =>
    killed(
      [
        [
          `        AND f.archived_at IS NULL\n        AND d.health_code <> \${health}`,
          `        AND f.archived_at IS NULL\n        AND d.rule_id <> 'fallback'\n        AND d.health_code <> \${health}`,
        ],
      ],
      marksCurrentTargetsOnly,
    ))

  it('fails when marking reaches superseded versions', () =>
    killed(
      [
        [
          '        AND f.published_version_id = d.version_id\n',
          '        AND f.id = (SELECT v.form_id FROM routing_form_versions v WHERE v.id = d.version_id)\n',
        ],
      ],
      marksCurrentTargetsOnly,
    ))

  it('fails when marking reaches archived forms', () =>
    killed(
      [
        [
          `        AND f.archived_at IS NULL\n        AND d.health_code <> \${health}`,
          `        AND d.health_code <> \${health}`,
        ],
      ],
      marksCurrentTargetsOnly,
    ))

  it('fails when targets of archived forms count as in use', () =>
    killed(
      [
        [
          '      AND f.archived_at IS NULL\n    ORDER BY d.event_type_id',
          '    ORDER BY d.event_type_id',
        ],
      ],
      marksCurrentTargetsOnly,
    ))

  it('fails when the version cleanup waits for held versions', () =>
    killed(
      [
        [
          `      LIMIT \${limit}\n      FOR UPDATE OF v SKIP LOCKED`,
          `      LIMIT \${limit}\n      FOR UPDATE OF v`,
        ],
      ],
      skipsHeldVersions,
    ))

  it('fails when the purge deletes consumed evidence', () =>
    killed(
      [
        [
          '      WHERE consumed_booking_id IS NULL AND expires_at <= statement_timestamp()',
          '      WHERE expires_at <= statement_timestamp()',
        ],
        [
          `WHERE id = ANY(\${rows.map((row) => row.id)}::uuid[]) AND consumed_booking_id IS NULL`,
          `WHERE id = ANY(\${rows.map((row) => row.id)}::uuid[])`,
        ],
      ],
      purgesExpiredAnswersAndKeepsEvidence,
    ))

  it('fails when the receipt batch is unbounded', () =>
    killed([[`      LIMIT \${batch}\n`, '']], drainsBacklogInBoundedBatches))

  it('fails when the version batch is unbounded', () =>
    killed([[`      LIMIT \${limit}\n`, '']], drainsVersionsInBoundedBatches))

  it('fails when the purge waits for held receipts', () =>
    killed(
      [
        [
          `      ORDER BY expires_at, id\n      LIMIT \${batch}\n      FOR UPDATE SKIP LOCKED`,
          `      ORDER BY expires_at, id\n      LIMIT \${batch}\n      FOR UPDATE`,
        ],
      ],
      skipsHeldReceipts,
    ))

  it('fails when the version cleanup waits for dependency rows', () =>
    killed(
      [
        [
          `        WHERE version_id = ANY(\${ids}::uuid[])\n        FOR UPDATE SKIP LOCKED`,
          `        WHERE version_id = ANY(\${ids}::uuid[])\n        FOR UPDATE`,
        ],
      ],
      skipsHeldVersions,
    ))

  it('fails when the version cleanup waits for replay records', () =>
    killed(
      [
        [
          `      // then the replay record of its idempotent publication, which a replay share-locks while
      // it returns the version.
      const { rows: lockedOperations } = await sql<{ version_id: string }>\`
        SELECT o.version_id FROM routing_form_operations o
        JOIN routing_form_versions v ON v.organization_id = o.organization_id
          AND v.form_id = o.form_id AND v.id = o.version_id
        WHERE v.id = ANY(\${ids}::uuid[])
        FOR UPDATE OF o SKIP LOCKED\`.execute(trx)
      const { rows: operations } = await sql<{ version_id: string; count: number }>\`
        SELECT o.version_id, count(*)::int AS count FROM routing_form_operations o
        JOIN routing_form_versions v ON v.organization_id = o.organization_id
          AND v.form_id = o.form_id AND v.id = o.version_id
        WHERE v.id = ANY(\${ids}::uuid[])
        GROUP BY o.version_id\`.execute(trx)
`,
          '',
        ],
        ['[...locked, ...lockedOperations]', 'locked'],
        ['[...totals, ...operations]', 'totals'],
      ],
      skipsVersionsWithHeldReplayRecords,
    ))

  it('fails when the version cleanup deletes a receipted version', () =>
    killed(
      [
        [
          `        AND NOT EXISTS (
          SELECT FROM routing_receipts r
          WHERE r.organization_id = v.organization_id AND r.form_id = v.form_id
            AND r.version_id = v.id
        )
`,
          '',
        ],
      ],
      deletesOnlyUnreferencedVersions,
    ))
})
