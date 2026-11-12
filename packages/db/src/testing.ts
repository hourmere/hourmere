// Test support: isolated databases, never the data in the development database.
import { randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { createPool, guardPoolErrors } from './index.ts'
import { runMigrations } from './migrate.ts'
import { registerTestDatabaseCleanup, withDeadline } from './test-database-registry.ts'

export { cleanupTestDatabases } from './test-database-registry.ts'

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
    options: `-c statement_timeout=${statementTimeout} -c lock_timeout=0`,
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
    // CREATE copies its whole template and waits for conflicting locks on it; under CI load
    // that can outlast the default admin timeout. Like DROP, only this statement waits longer.
    const creator = adminPool(
      maintenanceUrl,
      Math.max(adminStatementTimeout(), CREATE_STATEMENT_TIMEOUT_MS),
    )
    try {
      await creator.query(
        `CREATE DATABASE ${name}${options.template ? ` TEMPLATE ${options.template}` : ''}`,
      )
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
  options: Pick<TestDatabaseOptions, 'tag'> = {},
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
