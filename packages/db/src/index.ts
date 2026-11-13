import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from './tables.ts'

export { importedBookingCondition } from './imported-booking-condition.ts'
export { importedBookingIds, isImportedBooking } from './imported-bookings.ts'
export type * from './meeting-poll-types.ts'
export { runMigrations } from './migrate.ts'
export type * from './tables.ts'

// Generated from the migrated database by `npm run db:types`; CI fails if it is stale.
export type Database = DB

export type Db = Kysely<Database>

// node-postgres turns DATE into a Date at local midnight, which shifts the day in any time
// zone west or east of UTC. Calendar dates stay 'YYYY-MM-DD' strings.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v)

/**
 * Keeps a dropped connection (Postgres restart, failover, pg_terminate_backend,
 * idle_in_transaction_session_timeout) from killing the process with an unhandled 'error'.
 * pg-pool listens only on idle clients, re-emitting their errors on the pool and discarding
 * them; a checked-out client (e.g. a transaction kept open while a mail server answers) has
 * no listener of its own, so it gets one while it is out. Its next query then fails, which
 * its caller handles. Each error is logged once; `label` names the pool.
 */
export function guardPoolErrors(pool: pg.Pool, label = ''): void {
  // Vitest forwards console output over IPC. After its parent has gone, logging
  // can exit an orphan on EPIPE before DROP DATABASE WITH (FORCE) finishes.
  pool.on('error', (err) => {
    if (process.connected !== false) {
      console.error(`idle Postgres client error${label}: ${err.message}`)
    }
  })
  const inUse = (err: Error) => {
    if (process.connected !== false) {
      console.error(`Postgres client error while in use${label}: ${err.message}`)
    }
  }
  pool.on('acquire', (client) => client.on('error', inUse))
  pool.on('release', (_err, client) => client.removeListener('error', inUse))
}

/**
 * How long a query waits for a connection, whether the pool must free one or open a new one,
 * before it fails. Without a limit an exhausted pool (a leak, a stuck transaction, a database
 * that stopped answering) queues every later request forever; with it they fail, and the
 * server answers 503 service_unavailable. The server sets it from DATABASE_CONNECTION_TIMEOUT.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000

export interface PoolOptions {
  /** Milliseconds; default DEFAULT_CONNECTION_TIMEOUT_MS. 0 waits indefinitely. */
  connectionTimeoutMillis?: number | undefined
}

/** The pool's connection settings for `options`, shared by the application and auth pools. */
export function poolTimeouts(options: PoolOptions = {}): pg.PoolConfig {
  return {
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  }
}

// node-postgres (pg-pool) reports both limits with plain errors; only the message tells them
// apart. The first: no pooled connection was free in time. The second: opening a new one took
// too long.
const CONNECTION_TIMEOUT_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
])

/** True when `error`, or an error it wraps, is a pool's connection timeout. */
export function isConnectionTimeout(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (CONNECTION_TIMEOUT_MESSAGES.has(current.message)) return true
    current = current.cause
  }
  return false
}

export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...poolTimeouts(options) })
  // The pool discards a broken client and opens a new one on the next query.
  guardPoolErrors(pool)
  return pool
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
