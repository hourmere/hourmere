import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from './tables.ts'

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

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString })
  // The pool discards a broken client and opens a new one on the next query.
  guardPoolErrors(pool)
  return pool
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
