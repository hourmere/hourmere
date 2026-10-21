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
}

const POOL_CLOSE_GRACE_MS = 250
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
    const admin = adminPool(maintenanceUrl)
    try {
      await admin.query(`CREATE DATABASE ${name}`)
      created = true
      // Throwaway data: commits need not wait for the disk (tests stay fast under load).
      await admin.query(`ALTER DATABASE ${name} SET synchronous_commit = off`)
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
