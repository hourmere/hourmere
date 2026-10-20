// Test support: isolated databases, never the data in the development database.
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createPool, guardPoolErrors } from './index.ts'
import { runMigrations } from './migrate.ts'

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

const activeDatabases = new Set<() => Promise<void>>()
const POOL_CLOSE_GRACE_MS = 250
const SHUTDOWN_TIMEOUT_MS = 15_000
let hooksInstalled = false
let interrupted = false

function adminPool(url: string): pg.Pool {
  // A broken server must not leave test shutdown waiting indefinitely.
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  })
  guardPoolErrors(pool)
  return pool
}

async function withDeadline(operation: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Fallback for a test runner's afterAll hook; callers should still use drop in finally/afterAll. */
export async function cleanupTestDatabases(): Promise<void> {
  const results = await Promise.allSettled([...activeDatabases].map((drop) => drop()))
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, 'Test database cleanup failed')
}

function removeHooks(): void {
  if (!hooksInstalled) return
  process.removeListener('beforeExit', beforeExit)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  hooksInstalled = false
}

function beforeExit(): void {
  void cleanupTestDatabases().catch(() => {
    // Do not print a driver's error: it can contain connection details.
    console.error(
      'Test database cleanup failed; inspect stale test databases with the cleanup script',
    )
    process.exitCode = 1
  })
}

function interrupt(signal: NodeJS.Signals): void {
  const ownsSignal = process.listenerCount(signal) === 1
  if (interrupted) {
    removeHooks()
    if (ownsSignal) process.kill(process.pid, signal)
    return
  }
  interrupted = true
  void withDeadline(
    cleanupTestDatabases().catch(() => {}),
    SHUTDOWN_TIMEOUT_MS,
  ).finally(() => {
    removeHooks()
    // Preserve standalone scripts' normal signal exit. Vitest owns its own cancellation
    // when it has installed a listener. SIGKILL/fatal worker crashes require the sweeper.
    if (ownsSignal) process.kill(process.pid, signal)
  })
}

function installHooks(): void {
  if (hooksInstalled) return
  interrupted = false
  process.once('beforeExit', beforeExit)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  hooksInstalled = true
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
        const admin = adminPool(maintenanceUrl)
        try {
          // Another pool, or a checked-out client that never released, cannot block removal.
          await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
          created = false
        } finally {
          await admin.end()
        }
      }
      activeDatabases.delete(drop)
      if (activeDatabases.size === 0) removeHooks()
      if (poolError) throw poolError
    })().catch((error: unknown) => {
      dropping = undefined
      throw error
    })
    return dropping
  }

  // Register before setup: a failed ALTER, migration, later beforeAll or test assertion
  // still leaves an owner able to clean up. The runner registers cleanupTestDatabases.
  activeDatabases.add(drop)
  installHooks()
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
