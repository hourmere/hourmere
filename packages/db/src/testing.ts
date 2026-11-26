// Test support: isolated databases, never the data in the development database.
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { createPool, type Database, type Db, guardPoolErrors } from './index.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  MIGRATED_PREFIX_ENV,
  MIGRATED_PREFIX_LAST_FILE,
  MIGRATED_TEMPLATE_ENV,
  MIGRATED_TEMPLATE_SERVER_ENV,
  registerTestDatabaseCleanup,
  templateServer,
  withDeadline,
} from './test-database-registry.ts'

export { cleanupTestDatabases } from './test-database-registry.ts'

/**
 * Runs Kysely statements on a checked-out client. The caller owns the connection and any
 * open transaction, so the callback must not open another transaction or release the client.
 */
export async function withBorrowedConnection<T>(
  client: pg.PoolClient,
  run: (db: Db) => Promise<T>,
): Promise<T> {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        options: {},
        connect: async () =>
          new Proxy(client, {
            get(target, property) {
              if (property === 'release') return () => {}
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          }),
        end: async () => {},
      },
    }),
  })
  try {
    return await run(db)
  } finally {
    await db.destroy()
  }
}

/**
 * Runs `fn` outside any native auth transaction the caller is in, for a test's simulated
 * concurrent writer that deliberately commits on its own connection while a request holds
 * one. The test-time connection-order guard (scripts/test-pool-order-setup.ts) otherwise
 * fails a test that asks another pool for a connection inside an auth transaction.
 */
export function outsideAuthTransaction<T>(fn: () => T): T {
  const held = (globalThis as { [key: symbol]: { exit<R>(callback: () => R): R } | undefined })[
    Symbol.for('hourmere.auth-transaction')
  ]
  return held ? held.exit(fn) : fn()
}

/**
 * Returns and clears the connection-order violations recorded so far, for a mutation test
 * whose broken source copy reproduces that wait on purpose. Other tests fail on them.
 */
export function takePoolOrderViolations(): string[] {
  const recorded = (globalThis as { [key: symbol]: string[] | undefined })[
    Symbol.for('hourmere.pool-order-violations')
  ]
  return recorded ? recorded.splice(0) : []
}

export interface TestDatabase {
  /** Connection string of the throwaway database. */
  url: string
  pool: pg.Pool
  /** Closes the pool and force-drops the database; safe to call more than once. */
  drop: () => Promise<void>
}

export interface TestDatabaseOptions {
  /** Migration tests can start with an empty database. Defaults to true. */
  migrate?: boolean
  /** Optional readable name segment, using up to 16 lowercase letters, digits or underscores. */
  tag?: string
  /**
   * Copies this test template database (see `createTestDatabaseTemplate`) instead of
   * `template1`. Migrations still run unless `migrate` is false; already applied files are
   * skipped, so a clone of a predecessor template applies only the newer migrations.
   *
   * Without this option, a fixture that migrates with the repository's migrations copies the
   * test run's migrated template when one exists on the same server (see
   * scripts/test-database-global-setup.ts); the migration run then only verifies checksums.
   */
  template?: string
}

export interface TestDatabaseTemplate {
  /** Database name; pass it as the `template` option or use `clone`. */
  name: string
  /** Creates an independent copy with CREATE DATABASE … TEMPLATE. */
  clone: (
    migrationsDirectory?: string,
    options?: Omit<TestDatabaseOptions, 'template'>,
  ) => Promise<TestDatabase>
  /** Force-drops the template; safe to call more than once. */
  drop: () => Promise<void>
}

const TEMPLATE_NAME = /^hourmere_test_[a-z0-9_]{1,80}$/

const POOL_CLOSE_GRACE_MS = 250
const CREATE_STATEMENT_TIMEOUT_MS = 30_000
const DROP_STATEMENT_TIMEOUT_MS = 30_000
const DROP_MAX_ATTEMPTS = 3

function adminStatementTimeout(): number {
  const value = process.env.HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS
  if (value === undefined) return 5_000
  const milliseconds = Number(value)
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > 2_147_482_647
  ) {
    throw new Error(
      'HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS must be a positive integer in milliseconds below 2147482648',
    )
  }
  return milliseconds
}

// A CREATE that waits on a lock must notice a client that has gone (interrupt, worker end)
// instead of creating an orphan database after the lock is released.
const CLIENT_CHECK_INTERVAL_MS = 1_000

function adminPool(url: string, statementTimeout = adminStatementTimeout()): pg.Pool {
  const maintenance = new URL(url)
  // node-pg gives URL parameters precedence over Pool settings. Fixture/session options
  // must not shorten administrative timeouts, including via options or PGOPTIONS.
  for (const key of [
    'statement_timeout',
    'query_timeout',
    'connectionTimeoutMillis',
    'lock_timeout',
    'options',
  ]) {
    maintenance.searchParams.delete(key)
  }
  // A broken server must not leave test shutdown waiting indefinitely.
  const pool = new pg.Pool({
    connectionString: maintenance.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 1_000,
    options: `-c statement_timeout=${statementTimeout} -c lock_timeout=0 -c client_connection_check_interval=${CLIENT_CHECK_INTERVAL_MS}`,
  })
  guardPoolErrors(pool)
  return pool
}

async function dropDatabase(maintenanceUrl: string, name: string): Promise<void> {
  // DROP can wait for backend termination/checkpoints, well beyond fixture setup's timeout.
  const admin = adminPool(
    maintenanceUrl,
    Math.max(adminStatementTimeout(), DROP_STATEMENT_TIMEOUT_MS),
  )
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // Limit termination to this fixture; other tasks share the same Postgres server.
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        )
        // Another pool, or a checked-out client that never released, cannot block removal.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        return
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        const retryable =
          code === '57014' ||
          code === '55006' ||
          (error instanceof Error && error.message === 'Query read timeout')
        if (!retryable || attempt >= DROP_MAX_ATTEMPTS) throw error
        await setTimeout(attempt * 50)
      }
    }
  } finally {
    await admin.end()
  }
}

/** The run's migrated template, when this fixture would otherwise replay every migration. */
function migratedTemplate(
  serverUrl: string,
  migrationsDirectory: string | undefined,
  options: TestDatabaseOptions,
): string | undefined {
  if (options.template !== undefined || options.migrate === false) return undefined
  if (migrationsDirectory !== undefined && resolve(migrationsDirectory) !== resolve(migrationsDir))
    return undefined
  const name = process.env[MIGRATED_TEMPLATE_ENV]
  if (name === undefined || !TEMPLATE_NAME.test(name)) return undefined
  return process.env[MIGRATED_TEMPLATE_SERVER_ENV] === templateServer(serverUrl) ? name : undefined
}

interface MigrationFile {
  name: string
  checksum: string
}

/** The `.sql` files of a directory in run order, with the checksum `runMigrations` records. */
async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  return Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update((await readFile(join(directory, name), 'utf8')).replaceAll('\r\n', '\n'))
        .digest('hex'),
    })),
  )
}

let repositoryMigrations: Promise<MigrationFile[]> | undefined
const predecessorRequests = new Map<string, number>()
const predecessorTemplates = new Map<string, Promise<TestDatabaseTemplate>>()

/** Compare contents as well as names so a copied SQL mutation must still run. */
async function sharedMigrationFiles(directory: string): Promise<MigrationFile[]> {
  try {
    repositoryMigrations ??= migrationFiles(migrationsDir)
    const [files, repository] = await Promise.all([migrationFiles(directory), repositoryMigrations])
    const difference = files.findIndex(
      (file, index) =>
        file.name !== repository[index]?.name || file.checksum !== repository[index]?.checksum,
    )
    return difference === -1 ? files : files.slice(0, difference)
  } catch {
    // Unreadable directories fail in runMigrations with their real error.
    return []
  }
}

function runMigrationPrefix(serverUrl: string): string | undefined {
  const name = process.env[MIGRATED_PREFIX_ENV]
  if (name === undefined || !TEMPLATE_NAME.test(name)) return undefined
  return process.env[MIGRATED_TEMPLATE_SERVER_ENV] === templateServer(serverUrl) ? name : undefined
}

/** The run's 0012 template, when the staged SQL starts with that exact repository prefix. */
export async function findTestMigrationPrefix(
  serverUrl: string,
  directory: string,
): Promise<string | undefined> {
  const name = runMigrationPrefix(serverUrl)
  if (!name) return undefined
  const shared = await sharedMigrationFiles(directory)
  return shared.some((file) => file.name === MIGRATED_PREFIX_LAST_FILE) ? name : undefined
}

async function createPredecessorTemplate(
  serverUrl: string,
  files: MigrationFile[],
  key: string,
  runPrefix: string | undefined,
): Promise<TestDatabaseTemplate> {
  // The template is dropped with the file's other fixtures (it owns a cleanup like any
  // fixture). Registered first, so a cleanup that starts while the template is still being
  // built also forgets it, and a later fixture builds a new one instead of copying a
  // database that no longer exists.
  const unregister = registerTestDatabaseCleanup(async () => {
    predecessorTemplates.delete(key)
    predecessorRequests.delete(key)
    unregister()
  })
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-predecessor-'))
  try {
    for (const file of files) {
      await copyFile(join(migrationsDir, file.name), join(directory, file.name))
    }
    return await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        await runMigrations(pool, directory)
      },
      { tag: 'predecessor', template: runPrefix },
    )
  } catch (error) {
    unregister()
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Source-copy and upgrade tests migrate a directory that starts with byte-identical copies of
 * the repository's first migrations and then holds a changed or later file. Use the run's
 * 0012 checkpoint when compatible. For repeated longer histories, prepare and copy their
 * shared leading migrations. The runner verifies all copied checksums before applying the rest.
 */
function predecessorTemplate(
  serverUrl: string,
  migrationsDirectory: string | undefined,
  options: TestDatabaseOptions,
): Promise<string | undefined> | undefined {
  // Decided synchronously when it cannot apply, so other fixtures start CREATE at once.
  if (options.template !== undefined || options.migrate === false) return undefined
  if (migrationsDirectory === undefined) return undefined
  if (resolve(migrationsDirectory) === resolve(migrationsDir)) return undefined
  return sharedPredecessorTemplate(serverUrl, migrationsDirectory, options)
}

async function sharedPredecessorTemplate(
  serverUrl: string,
  migrationsDirectory: string,
  options: TestDatabaseOptions,
): Promise<string | undefined> {
  const files = await sharedMigrationFiles(migrationsDirectory)
  if (files.length === 0) return undefined
  // Every repository migration, possibly followed by more files: the run's template applies.
  if (files.length === (await repositoryMigrations)?.length) {
    const template = migratedTemplate(serverUrl, undefined, options)
    if (template) return template
  }
  const runPrefix = files.some((file) => file.name === MIGRATED_PREFIX_LAST_FILE)
    ? runMigrationPrefix(serverUrl)
    : undefined
  if (runPrefix && files.at(-1)?.name === MIGRATED_PREFIX_LAST_FILE) return runPrefix
  const key = `${templateServer(serverUrl)} ${files.length}`
  const requests = (predecessorRequests.get(key) ?? 0) + 1
  predecessorRequests.set(key, requests)
  // Only repeated fixtures pay for a new template.
  if (requests < 2) return runPrefix
  let template = predecessorTemplates.get(key)
  if (!template) {
    template = createPredecessorTemplate(serverUrl, files, key, runPrefix)
    predecessorTemplates.set(key, template)
  }
  try {
    return (await template).name
  } catch {
    predecessorTemplates.delete(key)
    // The fixture applies the remaining migrations itself and reports any setup failure.
    return runPrefix
  }
}

/** Creates a new database on serverUrl's server, using postgres only for maintenance. */
export async function createTestDatabase(
  serverUrl: string,
  migrationsDirectory?: string,
  options: TestDatabaseOptions = {},
): Promise<TestDatabase> {
  if (options.tag !== undefined && !/^[a-z][a-z0-9_]{0,15}$/.test(options.tag)) {
    throw new Error('Test database tag must contain 1–16 lowercase letters, digits or underscores')
  }
  if (options.template !== undefined && !TEMPLATE_NAME.test(options.template)) {
    throw new Error('Test database templates must be test databases')
  }
  const name = `hourmere_test_${options.tag ? `${options.tag}_` : ''}${process.pid}_${randomBytes(8).toString('hex')}`
  const maintenance = new URL(serverUrl)
  if (maintenance.protocol !== 'postgres:' && maintenance.protocol !== 'postgresql:') {
    throw new Error('Test database URL must use postgres:// or postgresql://')
  }
  maintenance.searchParams.delete('database')
  maintenance.searchParams.delete('dbname')
  maintenance.pathname = '/postgres'
  const maintenanceUrl = maintenance.toString()
  const database = new URL(maintenanceUrl)
  database.pathname = `/${name}`
  const url = database.toString()
  let pool: pg.Pool | undefined
  let created = false
  let setup: Promise<void> | undefined
  let dropping: Promise<void> | undefined
  let poolEnding: Promise<void> | undefined

  const drop = (): Promise<void> => {
    if (dropping) return dropping
    dropping = (async () => {
      // A signal during CREATE/ALTER must not drop first and then leave a newly created DB.
      await setup?.catch(() => {})
      let poolError: unknown
      poolEnding ??= pool?.end().catch((error: unknown) => {
        poolError = error
      })
      if (poolEnding) await withDeadline(poolEnding, POOL_CLOSE_GRACE_MS)
      if (created) {
        await dropDatabase(maintenanceUrl, name)
        created = false
      }
      unregister()
      if (poolError) throw poolError
    })().catch((error: unknown) => {
      dropping = undefined
      throw error
    })
    return dropping
  }

  // Register before setup: a failed ALTER, migration, later beforeAll or test assertion
  // still leaves an owner able to clean up. The runner registers cleanupTestDatabases.
  const unregister = registerTestDatabaseCleanup(drop)
  setup = (async () => {
    // Resolved after registration: a signal while a predecessor template is built still
    // finds this fixture's owner.
    let template = options.template ?? migratedTemplate(serverUrl, migrationsDirectory, options)
    const predecessor = template
      ? undefined
      : predecessorTemplate(serverUrl, migrationsDirectory, options)
    if (predecessor) template = await predecessor
    // CREATE copies its whole template and waits for conflicting locks on it; under CI load
    // that can outlast the default admin timeout. Like DROP, only this statement waits longer.
    const creator = adminPool(
      maintenanceUrl,
      Math.max(adminStatementTimeout(), CREATE_STATEMENT_TIMEOUT_MS),
    )
    try {
      await creator.query(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ''}`)
      created = true
    } finally {
      await creator.end()
    }
    // The ALTERs only update a catalog row of a database nobody else knows yet, so they keep
    // the short default and a broken server still fails fast.
    const admin = adminPool(maintenanceUrl)
    try {
      // Throwaway data: commits need not wait for the disk (tests stay fast under load).
      await admin.query(`ALTER DATABASE ${name} SET synchronous_commit = off`)
      // Autovacuum can analyze one churned fixture table before the tables it joins, which
      // can lift an ordinary read's estimate past the JIT thresholds for the rest of a file.
      // Each run then spends 150-300 ms compiling a sub-millisecond query; JIT never changes
      // a result, so fixtures run without it.
      await admin.query(`ALTER DATABASE ${name} SET jit = off`)
    } finally {
      await admin.end()
    }
  })()
  try {
    await setup
    pool = createPool(url)
    if (options.migrate !== false) await runMigrations(pool, migrationsDirectory)
    return { url, pool, drop }
  } catch (error) {
    try {
      await drop()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Test database setup and cleanup failed')
    }
    throw error
  }
}

/**
 * Prepares a database once (for example migrations up to a checkpoint) for cheap copies.
 * `prepare` gets its own pool, which is closed before cloning: PostgreSQL copies a
 * template only while nobody is connected to it. Drop the template after its clones.
 */
export async function createTestDatabaseTemplate(
  serverUrl: string,
  prepare: (pool: pg.Pool) => Promise<void>,
  options: Pick<TestDatabaseOptions, 'tag' | 'template'> = {},
): Promise<TestDatabaseTemplate> {
  const template = await createTestDatabase(serverUrl, undefined, { ...options, migrate: false })
  const name = new URL(template.url).pathname.slice(1)
  const pool = createPool(template.url)
  try {
    await prepare(pool)
  } catch (error) {
    await pool.end().catch(() => {})
    await template.drop()
    throw error
  }
  await pool.end()
  return {
    name,
    clone: (migrationsDirectory, cloneOptions = {}) =>
      createTestDatabase(serverUrl, migrationsDirectory, { ...cloneOptions, template: name }),
    drop: template.drop,
  }
}

/**
 * True when a `query` or `connect` call passes a callback, in any position (`query(text, cb)`,
 * `query(text, values, cb)`, `connect(cb)`) or as the `callback` of a query config object
 * (`query({ text, callback })`). pg then hands the result and any error to the callback, not
 * to the promise the caller would await.
 */
export function passesCallback(args: readonly unknown[]): boolean {
  return args.some(
    (argument) =>
      typeof argument === 'function' ||
      (typeof argument === 'object' &&
        argument !== null &&
        typeof (argument as { callback?: unknown }).callback === 'function'),
  )
}

/**
 * pg.Pool.query discards its connection after any failed statement, so a test that expects
 * many constraint violations would open (and leave in TIME_WAIT) a connection for each one.
 * This view of the pool keeps the connection: a single failed statement outside a transaction
 * leaves the session usable. Everything else, including connect() and end(), is unchanged.
 */
export function reuseConnectionsAfterErrors(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return (...args: unknown[]) => {
          // Refused synchronously: a callback-style caller would otherwise wait forever.
          if (passesCallback(args))
            throw new TypeError(
              'pools with connection reuse use the promise form of query: callbacks are not supported',
            )
          const [text, values] = args as [string | pg.QueryConfig, unknown[] | undefined]
          return (async () => {
            const client = await target.connect()
            try {
              return await client.query(text, values)
            } finally {
              client.release()
            }
          })()
        }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
