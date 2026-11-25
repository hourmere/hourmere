import { type RawBuilder, sql } from 'kysely'

/** Retain PostgreSQL's microseconds independently of session DateStyle and TimeZone. */
export function databaseInstantText(instant: RawBuilder<unknown>) {
  return sql<string>`to_char(${instant} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}
