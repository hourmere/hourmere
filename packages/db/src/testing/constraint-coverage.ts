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
 *    triggers, including constraint triggers, with a digest of the function body) and
 *    `pg_attribute` (NOT NULL columns outside the primary key, with their default). Nothing
 *    is listed by hand.
 * 2. The enumerated objects and their definitions must equal the committed expectation file,
 *    so adding, removing or redefining an object needs a reviewed expectation change. Rewrite
 *    it after review with `HOURMERE_UPDATE_CONSTRAINT_COVERAGE=1`.
 * 3. The assertion suite must pass on an unmodified copy of the template.
 * 4. For every object, a fresh `CREATE DATABASE … TEMPLATE` copy drops exactly that object and
 *    runs the suite again. Each object that is not allow-listed must fail an assertion; an
 *    allow-listed object must not (otherwise the entry is stale). Only an AssertionError
 *    counts: any other error, or an assertion about a connection, lock, deadlock or syntax
 *    error, aborts the run, so write every expected outcome as an `expect`.
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
 * key), each with a reason. Dropping one object cannot detect a loosened predicate, a changed
 * FK action, a widened unique key or a weaker trigger-function clause; the definitions in the
 * expectation file only make such changes visible in review. Pair this with source-copy
 * mutation tests that relax them, and with checks of column defaults, which are not objects.
 * Set `HOURMERE_CONSTRAINT_COVERAGE_REPORT=<file>` to write the per-object results as JSON.
 */
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
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
  pg_get_triggerdef(tg.oid)||' -- function md5 '||md5(p.prosrc),
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

// Connection, transaction-state, rollback (deadlock), syntax/privilege, resource, lock,
// operator-intervention, system and internal errors say nothing about a dropped object.
const unrelatedState = /^(08|25|40|42|53|55|57|58|XX)/

/** Only a real assertion about the schema counts as a failure caused by the dropped object. */
function assertionFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'AssertionError') return false
  const code = ((error as { actual?: unknown }).actual as { code?: unknown } | null)?.code
  return !(typeof code === 'string' && unrelatedState.test(code))
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

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split('\n')[0] ?? '').slice(0, 240)
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
    try {
      // Suites expect many failed statements; keep their connection instead of reopening it.
      await withTimeout(assertions(reuseConnectionsAfterErrors(copy.pool)), timeoutMs, label)
      return {}
    } catch (failure) {
      if (!assertionFailure(failure))
        throw new Error(
          `Constraint coverage could not evaluate ${label}: expected an assertion failure, got ${firstLine(failure)}`,
          { cause: failure },
        )
      return { failure }
    }
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

    const baseline = await runOnCopy(template, options.assertions, timeoutMs, 'the baseline')
    if (baseline.failure)
      throw new Error('The assertion suite fails on the unmodified schema', {
        cause: baseline.failure,
      })

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
