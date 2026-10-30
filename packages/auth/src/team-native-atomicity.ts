import { runWithTransaction } from '@better-auth/core/context'
import { kyselyAdapter } from '@better-auth/kysely-adapter'
import type { Database, Db } from '@hourmere/db'
import type { BetterAuthOptions } from 'better-auth'
import type {
  DefaultOrganizationPlugin,
  OrganizationOptions,
} from 'better-auth/plugins/organization'
import { sql, type Transaction } from 'kysely'

/** Keep the native validators, middleware, hooks, response shapes and error codes. */
export function nativeTeamTransactions<O extends OrganizationOptions>(
  plugin: DefaultOrganizationPlugin<O>,
): DefaultOrganizationPlugin<O> {
  const createOrganization = plugin.endpoints.createOrganization
  plugin.endpoints.createOrganization = Object.assign(
    (context: Parameters<typeof createOrganization>[0]) => {
      if (!context?.context) return createOrganization(context)
      return runWithTransaction(context.context.adapter, () => createOrganization(context))
    },
    createOrganization,
  ) as typeof createOrganization
  const acceptInvitation = plugin.endpoints.acceptInvitation
  plugin.endpoints.acceptInvitation = Object.assign(
    (context: Parameters<typeof acceptInvitation>[0]) => {
      if (!context?.context) return acceptInvitation(context)
      return runWithTransaction(context.context.adapter, () => acceptInvitation(context))
    },
    acceptInvitation,
  ) as typeof acceptInvitation
  return plugin
}

/**
 * Share the native adapter's connection with the application's locked write guards.
 * Plugin init wrappers still decorate the adapter and every transaction adapter.
 */
export function teamTransactionAdapter(
  db: Db,
  runInTransaction: <T>(trx: Transaction<Database>, operation: () => Promise<T>) => Promise<T>,
) {
  const adapter = kyselyAdapter(db, { type: 'postgres', transaction: true })
  return (options: BetterAuthOptions) => {
    const instance = adapter(options)
    instance.transaction = (callback) =>
      db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // Native models resolve to auth first; the policy also reads public tables.
          // Set this only for the transaction. A withSchema plugin would also rewrite
          // qualified auth-table aliases in the application's existing join queries.
          await sql`SET LOCAL search_path TO auth, public`.execute(trx)
          return runInTransaction(trx, async () =>
            callback(kyselyAdapter(trx, { type: 'postgres', transaction: false })(options)),
          )
        })
    return instance
  }
}
