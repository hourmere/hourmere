import { AsyncLocalStorage } from 'node:async_hooks'
import { sql, type Transaction, type TransactionBuilder } from 'kysely'
import type { Database } from './index.ts'

type TeamTransaction = Transaction<Database>

interface TeamWriteCheck {
  /** Checks and locks live authority, returning its deadline if proof was required. */
  lockProof: (trx: TeamTransaction) => Promise<string | undefined>
  expired: () => never
}

const activeCheck = new AsyncLocalStorage<TeamWriteCheck>()
const checkedBeforeChange = new WeakMap<TeamTransaction, { deadline: string | undefined }>()

/** Only the authenticated team transport enters this scope after finding a stored policy. */
export function withTeamWriteCheck<T>(check: TeamWriteCheck, write: () => Promise<T>): Promise<T> {
  return activeCheck.run(check, write)
}

/** Join the service's existing write transaction and verify authority before it commits. */
export function teamWriteTransaction<T>(
  transaction: TransactionBuilder<Database>,
  write: (trx: TeamTransaction) => Promise<T>,
): Promise<T> {
  const check = activeCheck.getStore()
  if (!check) return transaction.execute(write)
  return transaction.execute(async (trx) => {
    const result = await write(trx)
    const verified = checkedBeforeChange.get(trx)
    if (verified) {
      // A write can deliberately remove its own authority. The locked proof was valid
      // before that transition, and its absolute deadline still applies at commit.
      if (verified.deadline) {
        const { rows } = await sql<{ live: boolean }>`SELECT
          ${verified.deadline}::timestamptz > clock_timestamp() AS live`.execute(trx)
        if (!rows[0]?.live) check.expired()
      }
    } else {
      await check.lockProof(trx)
    }
    return result
  })
}

/** Use after the service's authorization locks and immediately before changing its own proof. */
export async function checkTeamWriteBeforeAuthorityChange(trx: TeamTransaction): Promise<void> {
  const check = activeCheck.getStore()
  if (check) checkedBeforeChange.set(trx, { deadline: await check.lockProof(trx) })
}
