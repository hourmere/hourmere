import { AsyncLocalStorage } from 'node:async_hooks'
import { sql, type Transaction, type TransactionBuilder } from 'kysely'
import type { Database } from './index.ts'

type TeamTransaction = Transaction<Database>

export interface TeamWriteCheck {
  organizationId: string
  identity: { sessionId: string; userId: string } | null
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

/** A shared service may reuse the caller's proof check only for the same actor and team. */
export function teamWriteCheckFor(
  organizationId: string,
  identity: TeamWriteCheck['identity'],
): TeamWriteCheck | undefined {
  const check = activeCheck.getStore()
  if (
    check?.organizationId.toLowerCase() === organizationId.toLowerCase() &&
    check.identity?.sessionId === identity?.sessionId &&
    check.identity?.userId === identity?.userId
  )
    return check
  return undefined
}

export async function checkTeamWriteDeadline(
  trx: TeamTransaction,
  deadline: string | undefined,
  expired: () => never,
) {
  if (!deadline) return
  const { rows } = await sql<{ live: boolean }>`SELECT
    ${deadline}::timestamptz > clock_timestamp() AS live`.execute(trx)
  if (!rows[0]?.live) expired()
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
      await checkTeamWriteDeadline(trx, verified.deadline, check.expired)
    } else {
      await check.lockProof(trx)
    }
    return result
  })
}

/** Use after the service's authorization locks and immediately before changing its own proof. */
export async function checkTeamWriteBeforeAuthorityChange(trx: TeamTransaction) {
  const check = activeCheck.getStore()
  if (!check) return
  const deadline = await check.lockProof(trx)
  checkedBeforeChange.set(trx, { deadline })
  return deadline
}
