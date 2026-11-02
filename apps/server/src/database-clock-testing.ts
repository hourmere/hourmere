import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { vi } from 'vitest'

// Native auth checks must share the clock that created invitation expiry in
// PostgreSQL; shifting Node alone cannot move the database's clock.
export async function withDatabaseClock<T>(db: Db, operation: () => T | Promise<T>): Promise<T> {
  const { now } = await db
    .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
    .executeTakeFirstOrThrow()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  try {
    return await operation()
  } finally {
    vi.useRealTimers()
  }
}
