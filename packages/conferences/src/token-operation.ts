import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'

export interface TokenOperation {
  id: string
  signal: AbortSignal
  /** Call inside the short owner-first transaction that consumes the result. */
  current(db: Db): Promise<boolean>
}

/** Caller holds the owner row. A claim takes owner FOR UPDATE, so even an absent lease
 * cannot be inserted between this check and credential retirement. Never waits for I/O. */
export async function tryTokenRetirement(db: Db, owner: string, own?: TokenOperation) {
  if (own) return own.current(db)
  const lease = await db
    .selectFrom('conference_token_operations')
    .select('operation_id')
    .where('user_id', '=', owner)
    .where('expires_at', '>', sql<Date>`clock_timestamp()`)
    .forShare()
    .executeTakeFirst()
  return !lease
}

/** OAuth learns its connection after exchange, so serialize by owner using a durable
 * expiring lease. No database lock or checked-out connection spans provider I/O or waits. */
export async function withTokenOperation<T>(
  db: Db,
  owner: string,
  body: (db: Db, lease: TokenOperation) => Promise<T>,
  onBusy?: () => Promise<T>,
  timeoutMs = 15000,
): Promise<T> {
  const id = randomUUID(),
    duration = Math.max(60000, timeoutMs + 15000)
  for (;;) {
    const acquired = await db.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', owner)
        .forUpdate()
        .executeTakeFirst()
      if (!user) throw new DomainError('forbidden', 'conference_session_required', 'Sign in again.')
      return transaction
        .insertInto('conference_token_operations')
        .values({
          user_id: owner,
          operation_id: id,
          expires_at: sql<Date>`clock_timestamp() + ${duration} * interval '1 millisecond'`,
        })
        .onConflict((conflict) =>
          conflict
            .column('user_id')
            .doUpdateSet({
              operation_id: id,
              expires_at: sql<Date>`clock_timestamp() + ${duration} * interval '1 millisecond'`,
            })
            .where('conference_token_operations.expires_at', '<=', sql<Date>`clock_timestamp()`),
        )
        .returning('operation_id')
        .executeTakeFirst()
    })
    if (acquired) break
    if (onBusy) return onBusy()
    await setTimeout(25)
  }
  const lease: TokenOperation = {
    id,
    signal: AbortSignal.timeout(timeoutMs),
    current: async (transaction) =>
      !!(await transaction
        .selectFrom('conference_token_operations')
        .select('operation_id')
        .where('user_id', '=', owner)
        .where('operation_id', '=', id)
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .forShare()
        .executeTakeFirst()),
  }
  try {
    return await body(db, lease)
  } finally {
    // An expired operation can never remove a replacement's lease.
    await db
      .deleteFrom('conference_token_operations')
      .where('user_id', '=', owner)
      .where('operation_id', '=', id)
      .execute()
  }
}
