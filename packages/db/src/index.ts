import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from './tables.ts'

export { runMigrations } from './migrate.ts'
export type * from './tables.ts'

// Generated from the migrated database by `npm run db:types`; CI fails if it is stale.
export type Database = DB

export type Db = Kysely<Database>

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString })
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
