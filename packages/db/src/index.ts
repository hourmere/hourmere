import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from './tables.ts'

export { runMigrations } from './migrate.ts'
export type * from './tables.ts'

// Generated from the migrated database by `npm run db:types`; CI fails if it is stale.
export type Database = DB

export type Db = Kysely<Database>

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString })
  // Without a listener, an idle client dropped by the server (Postgres restart, failover)
  // emits an unhandled 'error' and kills the process. The pool discards that client and
  // opens a new one on the next query.
  pool.on('error', (err) => console.error(`idle Postgres client error: ${err.message}`))
  return pool
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
