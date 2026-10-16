import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

export { runMigrations } from './migrate.ts'

// Table types are added together with the migrations that create the tables.
export type Database = Record<string, never>

export type Db = Kysely<Database>

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString })
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
