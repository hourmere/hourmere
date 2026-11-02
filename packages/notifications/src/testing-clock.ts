import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { vi } from 'vitest'

/** SMTP lease deadlines use database wall time, independently of the injected message clock. */
export async function alignSmtpDateNowWithDatabase(db: Db) {
  const wall = (
    await db.selectNoFrom(sql<Date>`clock_timestamp()`.as('now')).executeTakeFirstOrThrow()
  ).now.getTime()
  const started = performance.now()
  vi.spyOn(Date, 'now').mockImplementation(() => Math.trunc(wall + performance.now() - started))
}
