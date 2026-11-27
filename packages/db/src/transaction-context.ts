import { AsyncLocalStorage } from 'node:async_hooks'
import type { Transaction, TransactionBuilder } from 'kysely'

const transactionContext = new AsyncLocalStorage<{ active: number }>()

export function inTransactionCallback(): boolean {
  return (transactionContext.getStore()?.active ?? 0) > 0
}

/** Track callback transactions, including builders with an explicit isolation or access mode. */
export function trackTransaction<DB>(builder: TransactionBuilder<DB>): TransactionBuilder<DB> {
  const execute = builder.execute.bind(builder)
  const setAccessMode = builder.setAccessMode.bind(builder)
  const setIsolationLevel = builder.setIsolationLevel.bind(builder)
  return Object.assign(builder, {
    execute: <T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
      const context = transactionContext.getStore() ?? { active: 0 }
      return transactionContext.run(context, async () => {
        context.active++
        try {
          return await execute(callback)
        } finally {
          context.active--
        }
      })
    },
    setAccessMode: (mode: Parameters<TransactionBuilder<DB>['setAccessMode']>[0]) =>
      trackTransaction(setAccessMode(mode)),
    setIsolationLevel: (level: Parameters<TransactionBuilder<DB>['setIsolationLevel']>[0]) =>
      trackTransaction(setIsolationLevel(level)),
  })
}
