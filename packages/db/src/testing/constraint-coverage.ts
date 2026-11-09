/**
 * Constraint coverage: every constraint, index and trigger that a migration creates must be
 * guarded by an assertion that fails when that one object is removed.
 *
 * How it works:
 * 1. A throwaway template database applies the migrations before `migration` and records the
 *    catalog, applies `migration` and records it again, then applies the remaining
 *    migrations. The objects created (or redefined) by `migration` are the difference, read
 *    from `pg_constraint` (except NOT NULL and constraint-trigger rows), `pg_index` (indexes
 *    that do not back a primary key, unique or exclusion constraint), `pg_trigger` (user
 *    triggers, including constraint triggers, with a digest of the complete function
 *    definition from `pg_get_functiondef`: body, language, volatility, SECURITY DEFINER and
 *    `SET` clauses such as `search_path`) and `pg_attribute` (NOT NULL columns outside the
 *    primary key, with their default). Nothing is listed by hand.
 * 2. The enumerated objects and their definitions must equal the committed expectation file,
 *    so adding, removing or redefining an object needs a reviewed expectation change. Rewrite
 *    it after review with `HOURMERE_UPDATE_CONSTRAINT_COVERAGE=1`.
 * 3. The assertion suite must pass on two unmodified copies of the template (a check that
 *    fails only sometimes would make dropped objects look covered).
 * 4. For every object, a fresh `CREATE DATABASE … TEMPLATE` copy drops exactly that object and
 *    runs the suite again. Each object that is not allow-listed must fail; an allow-listed
 *    object must not (otherwise the entry is stale).
 *
 * What makes a failure count as coverage is what the database did, not how the suite
 * asserted it. Every rejected `query` on the pool handed to the suite, on the clients it
 * hands out through `connect()`, on `connect()` itself, and on pools opened through
 * `openRelatedPool`, is recorded with its SQLSTATE. On every copy, baseline or dropped,
 * passing or failing:
 * - a recorded error of any class other than 23 (integrity constraint), 22 (data exception)
 *   or P0 (raised by a trigger or function), or without a SQLSTATE at all (lost connection,
 *   socket or driver error), aborts the whole run and names the object and the error. This
 *   holds when the suite swallowed the error, turned it into a string or boolean, asserted on
 *   `error.code`, used `toHaveProperty`, `toThrow(/regex/)` or an `allSettled` result;
 * - a failure that is not an `AssertionError` (a raw database error, even an integrity one,
 *   outside an `expect`; a `TypeError`; the per-object timeout) aborts;
 * - an `AssertionError` is then walked: its `actual` value, `actual.cause`, its `cause` chain
 *   (`expect(...).resolves` puts the rejection there), nested assertions and
 *   `AggregateError.errors`. A received value that is an Error without an integrity code, an
 *   assertion that expected a code and received none, or any linked error whose code is not
 *   23/22/P0 or is missing, aborts;
 * - what remains, an assertion about an integrity rejection or a plain value mismatch with
 *   no unrelated database error behind it, counts.
 * A check that must provoke a non-integrity error therefore cannot be part of a coverage
 * suite. Open additional pools only with `openRelatedPool(pool, url)`, so that their errors
 * are recorded too; errors on other pools are invisible to the verdict.
 *
 * What the helper does not see, and what must be guarded by behavioural checks, source-copy
 * mutations or other tests instead:
 * - defaults on nullable and primary-key columns (only NOT NULL defaults are pinned);
 * - column types (CI's `db:types -- --verify` covers the generated types);
 * - row-level security policies and whether RLS is enabled;
 * - whether a trigger is enabled, disabled or replica-only (`tgenabled`);
 * - functions that a trigger function calls (only the trigger's own function is digested);
 * - NOT NULL constraints on domains (domain CHECKs are seen, table columns are seen);
 * - grants, privileges and ownership (what `SECURITY DEFINER` runs as);
 * - objects a migration drops or alters away;
 * - a loosened predicate, FK action, unique key or trigger clause, which only the pinned
 *   definitions make visible in review.
 *
 * Usage, from a `*.test.ts` file (the suite throws on the first failing assertion and must
 * only touch rows it creates, because one database serves the whole suite):
 *
 *   import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
 *
 *   it('fails an assertion when any 0072 object is dropped', async () => {
 *     const report = await checkConstraintCoverage({
 *       serverUrl: process.env.DATABASE_URL as string,
 *       migration: '0072_routing_forms.sql',
 *       assertions: assertRoutingFormProtections, // (pool: pg.Pool) => Promise<void>
 *       allowList: { 'constraint public.t.t_key': 'One-line reason it is not a protection' },
 *     })
 *     expect(report.problems).toEqual([])
 *   }, 600_000)
 *
 * The expectation file defaults to `testing/migration-objects/<migration>.json` (not a
 * `coverage` directory, which .gitignore excludes). Keep the allow-list to objects that are
 * not protections on their own (for example an FK target key that only restates the primary
 * key), each with a reason. Pair the coverage run with source-copy mutation tests that relax
 * the predicates and clauses listed above, and with checks of column defaults, which are not
 * objects. Set `HOURMERE_CONSTRAINT_COVERAGE_REPORT=<file>` to write the per-object results.
 */
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { createPool } from '../index.ts'
import { migrationsDir, runMigrations } from '../migrate.ts'
import {
  createTestDatabaseTemplate,
  reuseConnectionsAfterErrors,
  type TestDatabaseTemplate,
} from '../testing.ts'

export type CoverageObjectKind = 'constraint' | 'index' | 'trigger' | 'not_null'

export interface CoverageObject {
  /** `<kind> <schema>.<table>.<name>`; NOT NULL objects are named after their column. */
  key: string
  kind: CoverageObjectKind
  /** Catalog definition: constraint/index/trigger definition, function digest, default. */
  definition: string
  /** Statement that removes exactly this object. */
  drop: string
}

export interface CoverageResult {
  key: string
  status: 'covered' | 'uncovered' | 'undroppable' | 'allowed'
  /** First failing assertion (covered), the drop error (undroppable) or the allow reason. */
  detail: string
}

export interface ConstraintCoverageOptions {
  /** Admin URL of the server that hosts throwaway databases (normally `DATABASE_URL`). */
  serverUrl: string
  /** Migration file name, for example `0071_meeting_polls.sql`. */
  migration: string
  /** Protection suite; must reject when any protection is missing. Use only rows it creates. */
  assertions: (pool: pg.Pool) => Promise<void>
  /** Object key → one-line reason it is not a protection on its own. */
  allowList?: Record<string, string>
  /** Defaults to `testing/migration-objects/<migration basename>.json` next to this helper. */
  expectationFile?: string
  /** Defaults to the repository's migration directory. */
  migrationsDirectory?: string
  /** Parallel copies; each holds the suite's connections plus one during setup. Default 4. */
  concurrency?: number
  /** Per-object budget for one suite run. Default 120 s. */
  timeoutMs?: number
  /** Budget for the whole run; stays below Vitest's test timeout. Default 540 s. */
  deadlineMs?: number
}

export interface ConstraintCoverageReport {
  objects: CoverageObject[]
  results: CoverageResult[]
  /** Empty when every object is covered or allow-listed and matches the expectation file. */
  problems: string[]
}

interface Expectation {
  migration: string
  objects: Record<string, string>
}

const catalogQuery = `
WITH user_relations AS (
  SELECT c.oid,c.relname,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
)
SELECT 'constraint' AS kind,r.nspname AS schema,r.relname AS table,con.conname AS name,
  pg_get_constraintdef(con.oid) AS definition,
  format('ALTER TABLE %I.%I DROP CONSTRAINT %I',r.nspname,r.relname,con.conname) AS drop
FROM pg_constraint con JOIN user_relations r ON r.oid=con.conrelid
WHERE con.contype NOT IN ('n','t')
UNION ALL
SELECT 'constraint',n.nspname,t.typname,con.conname,pg_get_constraintdef(con.oid),
  format('ALTER DOMAIN %I.%I DROP CONSTRAINT %I',n.nspname,t.typname,con.conname)
FROM pg_constraint con JOIN pg_type t ON t.oid=con.contypid JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE con.contype='c' AND n.nspname NOT IN ('pg_catalog','information_schema')
UNION ALL
SELECT 'index',r.nspname,r.relname,i.relname,pg_get_indexdef(x.indexrelid),
  format('DROP INDEX %I.%I',r.nspname,i.relname)
FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN user_relations r ON r.oid=x.indrelid
WHERE NOT EXISTS (SELECT FROM pg_constraint con WHERE con.conindid=x.indexrelid
  AND con.conrelid=x.indrelid AND con.contype IN ('p','u','x'))
UNION ALL
SELECT 'trigger',r.nspname,r.relname,tg.tgname,
  pg_get_triggerdef(tg.oid)||' -- function '
    ||CASE WHEN p.prosecdef THEN 'SECURITY DEFINER ' ELSE '' END
    ||coalesce('SET '||array_to_string(p.proconfig,' SET ')||' ','')
    ||'md5 '||md5(pg_get_functiondef(p.oid)),
  format('DROP TRIGGER %I ON %I.%I',tg.tgname,r.nspname,r.relname)
FROM pg_trigger tg JOIN user_relations r ON r.oid=tg.tgrelid JOIN pg_proc p ON p.oid=tg.tgfoid
WHERE NOT tg.tgisinternal
UNION ALL
SELECT 'not_null',r.nspname,r.relname,a.attname,
  'NOT NULL'||coalesce(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),''),
  format('ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',r.nspname,r.relname,a.attname)
FROM pg_attribute a JOIN user_relations r ON r.oid=a.attrelid JOIN pg_class c ON c.oid=r.oid
LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND c.relkind IN ('r','p')
  AND NOT EXISTS (SELECT FROM pg_index x WHERE x.indrelid=c.oid AND x.indisprimary
    AND a.attnum=ANY(x.indkey))`

async function catalog(pool: pg.Pool): Promise<Map<string, CoverageObject>> {
  const rows = (
    await pool.query<{
      kind: CoverageObjectKind
      schema: string
      table: string
      name: string
      definition: string
      drop: string
    }>(catalogQuery)
  ).rows
  return new Map(
    rows.map((row) => {
      const key = `${row.kind} ${row.schema}.${row.table}.${row.name}`
      return [key, { key, kind: row.kind, definition: row.definition, drop: row.drop }]
    }),
  )
}

/** Objects `migration` creates or redefines that still exist after every later migration. */
async function prepareTemplate(
  serverUrl: string,
  migration: string,
  migrationsDirectory: string,
): Promise<{ template: TestDatabaseTemplate; objects: CoverageObject[] }> {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort()
  if (!files.includes(migration)) throw new Error(`Unknown migration ${migration}`)
  const staging = await mkdtemp(join(tmpdir(), 'hourmere-coverage-'))
  let objects: CoverageObject[] = []
  try {
    const template = await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        for (const file of files.filter((file) => file < migration))
          await copyFile(join(migrationsDirectory, file), join(staging, file))
        await runMigrations(pool, staging)
        const before = await catalog(pool)
        await copyFile(join(migrationsDirectory, migration), join(staging, migration))
        await runMigrations(pool, staging)
        const created = [...(await catalog(pool)).values()]
          .filter((object) => before.get(object.key)?.definition !== object.definition)
          .map((object) => object.key)
        await runMigrations(pool, migrationsDirectory)
        const current = await catalog(pool)
        objects = created.flatMap((key) => current.get(key) ?? []).sort(byKey)
      },
      { tag: 'coverage' },
    )
    return { template, objects }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const byKey = (a: { key: string }, b: { key: string }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0

// Only these SQLSTATE classes describe a rejected write: integrity constraint violations (23),
// data exceptions (22) and errors raised by a trigger or function (P0). Every other class
// (connection 08, transaction state 25, deadlock 40, syntax 42, resources 53, locks 55,
// timeouts and shutdown 57, …) says nothing about the dropped object.
const integrityState = /^(23|22|P0)/

function firstLine(error: unknown): string {
  // An assertion's `actual` can be a plain subset of the error (for example `{ code }`).
  const message = (error as { message?: unknown } | null)?.message
  let text: string
  if (typeof message === 'string') text = message
  else if (typeof error === 'object' && error !== null) {
    try {
      text = JSON.stringify(error)
    } catch {
      text = String(error)
    }
  } else text = String(error)
  return (text.split('\n')[0] ?? '').slice(0, 240)
}

const sqlState = (value: unknown): string | undefined => {
  const code = (value as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** An Error, or an object shaped like one (a plain copy keeps `message` and `stack`). */
const errorLike = (value: unknown): boolean =>
  value instanceof Error ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { stack?: unknown }).stack === 'string')

/** One rejected query on a pool the helper handed to the suite. */
export interface RecordedQueryError {
  /** SQLSTATE, or undefined for connection, socket and driver errors. */
  code: string | undefined
  message: string
  sql: string | undefined
}

const ledgerKey = Symbol.for('hourmere.constraint-coverage.query-errors')

/**
 * The ledger is the verdict's source of truth: every rejection of `query` on the pool, of
 * `connect()`, and of `query` on every client it hands out is recorded, whatever the suite
 * then does with the error (asserts on it, converts it to a string, swallows it).
 */
function recordQueryErrors(pool: pg.Pool, ledger: RecordedQueryError[]): pg.Pool {
  const record = (error: unknown, sql: unknown) => {
    const text =
      typeof sql === 'string'
        ? sql
        : ((sql as { text?: unknown } | null)?.text as string | undefined)
    ledger.push({
      code: sqlState(error),
      message: firstLine(error),
      sql: typeof text === 'string' ? text.slice(0, 160) : undefined,
    })
  }
  const recordingQuery =
    (target: pg.Pool | pg.PoolClient) =>
    async (...args: unknown[]) => {
      try {
        return await (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
      } catch (error) {
        record(error, args[0])
        throw error
      }
    }
  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, property) {
        if (property === 'query') return recordingQuery(target)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return new Proxy(pool, {
    get(target, property) {
      if (property === ledgerKey) return ledger
      if (property === 'query') return recordingQuery(target)
      if (property === 'connect')
        return async () => {
          try {
            return wrapClient(await target.connect())
          } catch (error) {
            record(error, undefined)
            throw error
          }
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Opens another pool for the suite (for example with a different `search_path`) that records
 * into the same ledger as `pool`, so its errors take part in the verdict. Outside a coverage
 * run it is an ordinary pool. Close it in the check that opened it.
 */
export function openRelatedPool(pool: pg.Pool, connectionString: string): pg.Pool {
  const related = createPool(connectionString)
  const ledger = (pool as unknown as Record<symbol, unknown>)[ledgerKey] as
    | RecordedQueryError[]
    | undefined
  return ledger ? recordQueryErrors(related, ledger) : related
}

/** Recorded database errors that are not integrity rejections, formatted for the abort. */
function nonIntegrityRecords(ledger: RecordedQueryError[]): string[] {
  return ledger
    .filter((entry) => entry.code === undefined || !integrityState.test(entry.code))
    .map(
      (entry) =>
        `${entry.code === undefined ? 'an error without SQLSTATE' : `code ${entry.code}`}: ${entry.message}${entry.sql ? ` (statement: ${entry.sql})` : ''}`,
    )
}

/**
 * Second line of defence, applied to the thrown failure itself: it must be an AssertionError,
 * and every error reachable from it (`actual`, `actual.cause`, `cause` chains and
 * `AggregateError.errors`) must carry an integrity SQLSTATE. A received value that is an Error
 * without one, a nested assertion about such an error, or an error without a code anywhere
 * in the graph, aborts. Returns the reason, or undefined when the failure counts.
 */
function notIntegrityAssertion(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'AssertionError')
    return `${error instanceof Error ? error.name : typeof error}${sqlState(error) ? ` ${sqlState(error)}` : ''}: ${firstLine(error)}`
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  const enqueue = (value: unknown) => {
    if (typeof value === 'object' && value !== null && !seen.has(value)) queue.push(value)
  }
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    if (seen.has(current)) continue
    seen.add(current)
    const withLinks = current as { cause?: unknown; errors?: unknown }
    if (current instanceof Error && current.name === 'AssertionError') {
      const { actual, expected } = current as { actual?: unknown; expected?: unknown }
      const code = sqlState(actual)
      if (code !== undefined && !integrityState.test(code))
        return `an assertion about an error with code ${code}: ${firstLine(actual)}`
      if (code === undefined && errorLike(actual))
        return `an assertion about an error without SQLSTATE: ${firstLine(actual)}`
      // toMatchObject keeps only the compared keys of the received error: an expected code
      // that is missing from the received value means the rejection carried no SQLSTATE.
      if (code === undefined && sqlState(expected) !== undefined)
        return `an assertion that expected code ${sqlState(expected)} but received none: ${firstLine(current)}`
      enqueue(actual)
    } else if (errorLike(current) || sqlState(current) !== undefined) {
      const code = sqlState(current)
      if (code === undefined)
        return `an error without SQLSTATE in the cause chain: ${firstLine(current)}`
      if (!integrityState.test(code))
        return `an error with code ${code} in the cause chain: ${firstLine(current)}`
    }
    enqueue(withLinks.cause)
    if (Array.isArray(withLinks.errors)) for (const entry of withLinks.errors) enqueue(entry)
  }
  return undefined
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number, label: string) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Copying the template is infrastructure, not part of the check: on a busy shared server the
 * CREATE/ALTER DATABASE can exceed the admin timeout. Retry it (never the assertions).
 */
async function cloneWithRetry(template: TestDatabaseTemplate, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await template.clone(undefined, { migrate: false, tag: 'coverage' })
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
    }
  }
}

async function runOnCopy(
  template: TestDatabaseTemplate,
  assertions: ConstraintCoverageOptions['assertions'],
  timeoutMs: number,
  label: string,
  drop?: string,
): Promise<{ dropError?: unknown; failure?: unknown }> {
  const copy = await cloneWithRetry(template)
  try {
    if (drop) {
      try {
        await copy.pool.query(drop)
      } catch (dropError) {
        return { dropError }
      }
    }
    const ledger: RecordedQueryError[] = []
    // Every query error is recorded first; suites also expect many failed statements, so the
    // outer view keeps their connection instead of reopening it after each one.
    const suitePool = reuseConnectionsAfterErrors(recordQueryErrors(copy.pool, ledger))
    let failure: unknown
    let failed = false
    try {
      await withTimeout(assertions(suitePool), timeoutMs, label)
    } catch (error) {
      failed = true
      failure = error
    }
    // The verdict comes from what the database did, whatever the suite asserted: any recorded
    // error that is not an integrity rejection aborts, on a failed and on a passing run alike.
    const unrelated = nonIntegrityRecords(ledger)
    if (unrelated.length > 0)
      throw new Error(
        `Constraint coverage could not evaluate ${label}: the database reported ${unrelated.length} error(s) that are not integrity rejections: ${unrelated.join('; ')}${failed ? `; the suite then failed with ${firstLine(failure)}` : '; the suite passed anyway'}`,
        { cause: failure },
      )
    if (!failed) return {}
    const reason = notIntegrityAssertion(failure)
    if (reason !== undefined)
      throw new Error(
        `Constraint coverage could not evaluate ${label}: expected an assertion about an integrity rejection, got ${reason}${ledger.length === 0 ? ' (the database reported no error)' : ''}`,
        { cause: failure },
      )
    return { failure }
  } finally {
    await copy.drop()
  }
}

async function readExpectation(file: string): Promise<Expectation | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Expectation
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

export async function checkConstraintCoverage(
  options: ConstraintCoverageOptions,
): Promise<ConstraintCoverageReport> {
  const started = Date.now()
  const migrationsDirectory = options.migrationsDirectory ?? migrationsDir
  const expectationFile =
    options.expectationFile ??
    fileURLToPath(
      new URL(`./migration-objects/${basename(options.migration, '.sql')}.json`, import.meta.url),
    )
  const allowList = options.allowList ?? {}
  const timeoutMs = options.timeoutMs ?? 120_000
  const deadlineMs = options.deadlineMs ?? 540_000
  const problems: string[] = []
  const { template, objects } = await prepareTemplate(
    options.serverUrl,
    options.migration,
    migrationsDirectory,
  )
  try {
    const keys = objects.map((object) => object.key)
    const definitions = Object.fromEntries(objects.map((object) => [object.key, object.definition]))
    if (process.env.HOURMERE_UPDATE_CONSTRAINT_COVERAGE === '1') {
      const expectation: Expectation = { migration: options.migration, objects: definitions }
      await writeFile(expectationFile, `${JSON.stringify(expectation, null, 2)}\n`)
    }
    const expectation = await readExpectation(expectationFile)
    if (!expectation) {
      problems.push(`missing expectation file ${expectationFile}`)
    } else {
      if (expectation.migration !== options.migration)
        problems.push(`expectation file names ${expectation.migration}, not ${options.migration}`)
      const expected = expectation.objects ?? {}
      for (const key of keys) {
        if (!Object.hasOwn(expected, key)) problems.push(`not in the expectation file: ${key}`)
        else if (expected[key] !== definitions[key]) problems.push(`definition changed: ${key}`)
      }
      for (const key of Object.keys(expected))
        if (!Object.hasOwn(definitions, key)) problems.push(`expected but not created: ${key}`)
    }
    for (const key of Object.keys(allowList))
      if (!Object.hasOwn(definitions, key)) problems.push(`allow-list entry is not created: ${key}`)

    // Twice: a check that fails only sometimes would make dropped objects look covered.
    for (const [first, second] of [
      await Promise.all([
        runOnCopy(template, options.assertions, timeoutMs, 'the baseline'),
        runOnCopy(template, options.assertions, timeoutMs, 'the second baseline'),
      ]),
    ]) {
      const baseline = first.failure ? first : second
      if (baseline.failure)
        throw new Error(
          `The assertion suite fails on the unmodified schema${first.failure ? '' : ' (on the second baseline run only)'}`,
          { cause: baseline.failure },
        )
    }

    const results: CoverageResult[] = []
    const pending = [...objects]
    let aborted = false
    const worker = async () => {
      for (let object = pending.shift(); object && !aborted; object = pending.shift()) {
        if (Date.now() - started > deadlineMs)
          throw new Error(`Constraint coverage exceeded its ${deadlineMs} ms budget`)
        const outcome = await runOnCopy(
          template,
          options.assertions,
          timeoutMs,
          object.key,
          object.drop,
        )
        const reason = allowList[object.key]
        if (reason !== undefined) {
          results.push({ key: object.key, status: 'allowed', detail: reason })
          if (outcome.failure)
            problems.push(
              `allow-listed but an assertion fails without it, remove the entry: ${object.key}`,
            )
        } else if (outcome.dropError) {
          results.push({
            key: object.key,
            status: 'undroppable',
            detail: firstLine(outcome.dropError),
          })
          problems.push(`cannot drop ${object.key} alone: ${firstLine(outcome.dropError)}`)
        } else if (outcome.failure) {
          results.push({ key: object.key, status: 'covered', detail: firstLine(outcome.failure) })
        } else {
          results.push({ key: object.key, status: 'uncovered', detail: object.drop })
          problems.push(`no assertion fails after ${object.drop} (${object.key})`)
        }
      }
    }
    // Settle every worker before the template is dropped; the first error aborts the rest.
    const settled = await Promise.allSettled(
      Array.from({ length: options.concurrency ?? 4 }, () =>
        worker().catch((error: unknown) => {
          aborted = true
          throw error
        }),
      ),
    )
    const failed = settled.find((outcome) => outcome.status === 'rejected')
    if (failed) throw failed.reason
    results.sort(byKey)
    problems.sort()
    const reportFile = process.env.HOURMERE_CONSTRAINT_COVERAGE_REPORT
    if (reportFile)
      await writeFile(
        reportFile,
        `${JSON.stringify({ migration: options.migration, results }, null, 2)}\n`,
      )
    return { objects, results, problems }
  } finally {
    await template.drop()
  }
}
