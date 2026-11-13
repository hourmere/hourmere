import { randomUUID } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestUser } from '../../scheduling/src/testing.ts'
import { applyImport } from './apply.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import {
  buildPreview,
  extractForPreview,
  type PreviewPlan,
  previewImport,
  registerImportSource,
  type SourceInput,
} from './preview.ts'
import { createSourceFixture } from './source-fixture.ts'
import { type ImportAuthorization, readTargetIdentities, readTargetState } from './target.ts'

interface IdentityRead {
  jit: boolean
  cost: number
}
interface Recorder {
  pool: pg.Pool
  /** One EXPLAIN (ANALYZE) of every identity read, on the importer's own connection. */
  reads: IdentityRead[]
  /** The session's `jit` right after each COMMIT or ROLLBACK the importer sends. */
  afterTransaction: string[]
}
type Query = (...args: unknown[]) => Promise<pg.QueryResult>
interface Failures {
  /** Throw instead of running this identity read (1-based), before it reaches the server. */
  identityRead?: number
  /** Reject every ROLLBACK before it reaches the server, so the transaction stays open. */
  rollback?: boolean
}

// Production PostgreSQL runs with jit=on; the test helper turns it off per database.
// Each session here starts with the server default restored, as an operator's would.
const jitSession = (url: string) =>
  new pg.Pool({ connectionString: url, max: 1, options: '-c jit=on' })

function record(pool: pg.Pool, fail: Failures = {}): Recorder {
  const reads: IdentityRead[] = []
  const afterTransaction: string[] = []
  let identityReads = 0
  const wrap = (client: pg.PoolClient) =>
    new Proxy(client, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, values?: unknown[]) => {
            const query = target.query.bind(target) as Query
            if (text.includes('AS memberships')) {
              if (++identityReads === fail.identityRead)
                throw new Error('synthetic identity read failure')
              const explained = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, values)
              const plan = explained.rows[0]['QUERY PLAN'][0]
              reads.push({ jit: Object.hasOwn(plan, 'JIT'), cost: plan.Plan['Total Cost'] })
            }
            if (fail.rollback && text === 'ROLLBACK') throw new Error('synthetic rollback failure')
            const result = await query(text, values)
            if (text === 'COMMIT' || text === 'ROLLBACK')
              afterTransaction.push((await query('SHOW jit')).rows[0].jit)
            return result
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const connect = async () => wrap(await pool.connect())
  const proxy = new Proxy(pool, {
    get(target, key) {
      if (key === 'connect') return connect
      if (key === 'query')
        return async (...args: unknown[]) => {
          const client = await connect()
          try {
            return await (client.query as Query)(...args)
          } finally {
            client.release()
          }
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { pool: proxy, reads, afterTransaction }
}

describe.skipIf(!process.env.DATABASE_URL)('Cal.com importer identity reads without JIT', () => {
  let target: TestDatabase
  let source: Awaited<ReturnType<typeof createSourceFixture>>
  const users: string[] = []
  beforeAll(async () => {
    target = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'calcom_jit',
    })
    source = await createSourceFixture('cal.diy-a5ee96f77edd')
  }, 30_000)
  afterEach(async () => {
    await target.pool.query('DELETE FROM auth."user" WHERE id=ANY($1::uuid[])', [users.splice(0)])
  })
  afterAll(async () => {
    try {
      await source?.drop()
    } finally {
      await target?.drop()
    }
  }, 60_000)

  async function setup() {
    const suffix = randomUUID()
    const user = await createTestUser(createDb(target.pool))
    users.push(user.id)
    await target.pool.query('UPDATE auth."user" SET email=$1 WHERE id=$2', [
      `owner-${suffix}@example.test`,
      user.id,
    ])
    await source.db.pool.query(
      'UPDATE users SET email=CASE id WHEN 1 THEN $1 ELSE $2 END WHERE id IN (1,2)',
      [`Owner-${suffix}@example.test`, `other-${suffix}@example.test`],
    )
    const input: SourceInput = {
      connectionString: source.connectionString,
      sourceId: randomUUID(),
      sourceVersion: 'cal.diy-a5ee96f77edd',
      selectedUserIds: [1],
      utcTimestampsConfirmed: true,
      authorization: {
        operatorUserId: user.id,
        operatorAuthorized: true,
        owners: [{ sourceUserId: 1, targetUserId: user.id, importPersonalData: true }],
      },
      bookingDecisions: [
        { sourceBookingId: 1000, sourceUserId: 1, singleHostAndAttendeeRolesConfirmed: true },
      ],
    }
    const snapshot = await extractForPreview(target.pool, input, '2040-01-01T00:00:00.000Z')
    input.sourceId = await registerImportSource(target.pool, snapshot, input.authorization)
    const { connectionString: _connectionString, ...options } = input
    const plan = buildPreview(
      snapshot,
      await readTargetState(target.pool, input.sourceId, input.authorization, snapshot.cutoff),
      options,
    )
    // The state autovacuum produced in CI: a tiny auth."user" analyzed (this case's one
    // row), while the joined profile and organization tables were never analyzed.
    await target.pool.query('ANALYZE auth."user"')
    for (const table of ['profiles', 'personal_organizations'])
      await target.pool.query("SELECT pg_clear_relation_stats('public',$1)", [table])
    await target.pool.query("SELECT pg_clear_relation_stats('auth','member')")
    return { input, plan }
  }

  // The importer's identity read with the session default, outside any transaction.
  async function controlRead(authorization: ImportAuthorization) {
    const pool = jitSession(target.url)
    try {
      const control = record(pool)
      await readTargetIdentities(control.pool, authorization)
      return required(control.reads[0])
    } finally {
      await pool.end()
    }
  }
  // Mutation controls must not count a fixture that missed the JIT state as a kill,
  // so this precondition throws a plain error rather than failing an assertion.
  async function requireJitState(authorization: ImportAuthorization) {
    const control = await controlRead(authorization)
    if (!control.jit || control.cost <= 100_000)
      throw new Error(
        `Fixture did not price the identity read past JIT: ${JSON.stringify(control)}`,
      )
  }
  // The same precondition for the importer's own reads: statistics that changed during the
  // run are a harness error, never a killed mutation.
  function requirePricedPastJit(reads: IdentityRead[]) {
    if (!(Math.max(...reads.map((read) => read.cost)) > 100_000))
      throw new Error(`Fixture lost the JIT state during the run: ${JSON.stringify(reads)}`)
  }
  const comparable = (preview: PreviewPlan) => ({
    ...preview,
    cutoff: '',
    extractedAt: '',
    plan: { ...preview.plan, cutoff: '', extractedAt: '' },
    planFingerprint: '',
  })

  async function previewWithoutJit(preview = previewImport) {
    const f = await setup()
    await requireJitState(f.input.authorization)
    const pool = jitSession(target.url)
    try {
      const recorder = record(pool)
      const live = await preview(recorder.pool, f.input)
      // Extraction and the preview snapshot each read identities.
      expect(recorder.reads.length).toBeGreaterThanOrEqual(2)
      requirePricedPastJit(recorder.reads)
      expect(recorder.reads.filter((read) => read.jit)).toEqual([])
      expect(recorder.afterTransaction.length).toBeGreaterThanOrEqual(2)
      expect(recorder.afterTransaction.filter((jit) => jit !== 'on')).toEqual([])
      // max: 1, so this is the same pooled session the preview used.
      expect((await pool.query('SHOW jit')).rows).toEqual([{ jit: 'on' }])
      expect(comparable(live)).toEqual(comparable(await previewImport(target.pool, f.input)))
    } finally {
      await pool.end()
    }
  }

  async function applyWithoutJit(apply = applyImport) {
    const f = await setup()
    await requireJitState(f.input.authorization)
    const pool = jitSession(target.url)
    try {
      const recorder = record(pool)
      expect(await apply(recorder.pool, f.plan, f.input)).toMatchObject({
        status: 'applied',
        committed: true,
        failures: [],
      })
      // Re-extraction before the transaction, then the target checks inside it.
      expect(recorder.reads.length).toBeGreaterThanOrEqual(3)
      requirePricedPastJit(recorder.reads)
      expect(recorder.reads.filter((read) => read.jit)).toEqual([])
      expect(recorder.afterTransaction.length).toBeGreaterThanOrEqual(2)
      expect(recorder.afterTransaction.filter((jit) => jit !== 'on')).toEqual([])
    } finally {
      await pool.end()
    }
  }

  async function failedReadRollsBack(preview = previewImport) {
    const f = await setup()
    const pool = jitSession(target.url)
    try {
      const recorder = record(pool, { identityRead: 1 })
      await expect(preview(recorder.pool, f.input)).rejects.toThrow(
        'synthetic identity read failure',
      )
      expect(recorder.afterTransaction).toEqual(['on'])
      // The pooled session left no open transaction and kept its own setting.
      expect((await pool.query('SHOW jit')).rows).toEqual([{ jit: 'on' }])
    } finally {
      await pool.end()
    }
  }

  // The session's backend and the two settings an open importer transaction would leak.
  async function session(pool: pg.Pool) {
    const result = await pool.query<{ pid: number; jit: string; readOnly: string }>(
      `SELECT pg_backend_pid() AS pid, current_setting('jit') AS jit,
      current_setting('transaction_read_only') AS "readOnly"`,
    )
    return required(result.rows[0])
  }

  // Preview reads identities once in the extraction transaction, then once in its snapshot
  // transaction. The chosen read fails and its ROLLBACK is rejected before reaching the
  // server, so the session is still inside a read-only transaction with JIT off.
  async function failedRollbackDiscards(identityRead: 1 | 2, preview = previewImport) {
    const f = await setup()
    const pool = jitSession(target.url)
    try {
      // max: 1, so the importer runs on this session.
      const before = await session(pool)
      expect(before).toMatchObject({ jit: 'on', readOnly: 'off' })
      const recorder = record(pool, { identityRead, rollback: true })
      await expect(preview(recorder.pool, f.input)).rejects.toThrow(
        'synthetic identity read failure',
      )
      // A failing snapshot read comes after the extraction transaction committed.
      expect(recorder.afterTransaction).toEqual(identityRead === 2 ? ['on'] : [])
      // The session was dropped, not pooled; the next one is a new, clean backend.
      expect(pool.totalCount).toBe(0)
      const next = await session(pool)
      expect(next.pid).not.toBe(before.pid)
      expect(next).toMatchObject({ jit: 'on', readOnly: 'off' })
    } finally {
      await pool.end()
    }
  }

  it('prices the identity read past every JIT threshold in the fixture state', async () => {
    const f = await setup()
    const pool = jitSession(target.url)
    try {
      expect((await pool.query('SELECT pg_jit_available() AS available')).rows).toEqual([
        { available: true },
      ])
    } finally {
      await pool.end()
    }
    const control = await controlRead(f.input.authorization)
    expect(control.jit).toBe(true)
    expect(control.cost).toBeGreaterThan(500_000)
  })
  it('previews with JIT off for every identity read and keeps the session default', async () => {
    await previewWithoutJit()
  }, 20_000)
  it('applies with JIT off for every identity read and keeps the session default', async () => {
    await applyWithoutJit()
  }, 20_000)
  it('rolls back a failed identity read and returns a clean pooled session', async () => {
    await failedReadRollsBack()
  }, 20_000)
  it('discards the extraction session when its rollback fails', async () => {
    await failedRollbackDiscards(1)
  }, 20_000)
  it('discards the preview snapshot session when its rollback fails', async () => {
    await failedRollbackDiscards(2)
  }, 20_000)

  const applySource = new URL('./apply.ts', import.meta.url)
  const previewSource = new URL('./preview.ts', import.meta.url)
  const extractionJit =
    "await client.query('BEGIN READ ONLY') await client.query('SET LOCAL jit = off')"
  it.each([
    {
      name: 'a missing JIT setting in the apply transaction',
      before: "await client.query('SET LOCAL jit = off')",
      after: '',
    },
    {
      name: 'a session-wide JIT setting in the apply transaction',
      before: "await client.query('SET LOCAL jit = off')",
      after: "await client.query('SET jit = off')",
    },
  ])(
    'detects $name in an isolated source copy',
    async ({ before, after }) => {
      await checkSourceMutation(
        applySource,
        before,
        after,
        (module) => module.applyImport as typeof applyImport,
        applyWithoutJit,
      )
    },
    30_000,
  )
  it.each([
    {
      name: 'a missing JIT setting in the extraction read',
      before: extractionJit,
      after: "await client.query('BEGIN READ ONLY')",
      run: previewWithoutJit,
    },
    {
      name: 'a session-wide JIT setting in the extraction read',
      before: extractionJit,
      after: "await client.query('BEGIN READ ONLY'); await client.query('SET jit = off')",
      run: previewWithoutJit,
    },
    {
      name: 'a missing JIT setting in the preview transaction',
      before:
        "// The target state includes the same identity read as extraction above. await client.query('SET LOCAL jit = off')",
      after: '',
      run: previewWithoutJit,
    },
    {
      name: 'a missing rollback of the extraction read',
      // The preview snapshot has the same catch; the extraction's comment keeps this unique.
      before:
        "await client.query('ROLLBACK').catch(() => { discard = true }) throw error } finally { // A session whose rollback failed",
      after: 'throw error } finally { // A session whose rollback failed',
      run: failedReadRollsBack,
    },
    {
      name: 'a pooled extraction session after a failed rollback',
      before: 'never pool it. client.release(discard)',
      // The needle starts inside a line comment; the call must stay on its own line.
      after: 'never pool it.\n    client.release()',
      run: (preview: typeof previewImport) => failedRollbackDiscards(1, preview),
    },
    {
      name: 'a pooled preview snapshot session after a failed rollback',
      before: 'is never pooled. client.release(discard)',
      after: 'is never pooled.\n    client.release()',
      run: (preview: typeof previewImport) => failedRollbackDiscards(2, preview),
    },
  ])(
    'detects $name in an isolated source copy',
    async ({ before, after, run }) => {
      await checkSourceMutation(
        previewSource,
        before,
        after,
        (module) => module.previewImport as typeof previewImport,
        run,
      )
    },
    30_000,
  )
})
