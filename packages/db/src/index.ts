import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

export { runMigrations } from './migrate.ts'

// Table types are added together with the migrations that create the tables.
export type Database = Record<string, never>

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
