import { AsyncLocalStorage } from 'node:async_hooks'
import { runWithTransaction } from '@better-auth/core/context'
import { kyselyAdapter } from '@better-auth/kysely-adapter'
import type { Database, Db } from '@hourmere/db'
import type { BetterAuthOptions } from 'better-auth'
import type {
  DefaultOrganizationPlugin,
  OrganizationOptions,
} from 'better-auth/plugins/organization'
import { sql, type Transaction } from 'kysely'
import { withAuthAuditTransaction } from './audit.ts'
import { mcpOAuthConsentTransaction } from './mcp-oauth.ts'
import { scimMappingDetachRequired } from './organization-context.ts'
import { isUuid, mapOrganizationSlugConflict } from './organizations.ts'

const AUTH_TRANSACTION = Symbol.for('hourmere.auth-transaction')

const databaseErrorCode = (error: unknown) =>
  error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined

function isOriginalDatabaseError(error: unknown): boolean {
  const code = databaseErrorCode(error)
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && code !== '25P02'
}

/**
 * Set while code runs inside a native auth transaction. Such code must never ask another pool
 * for a connection: the MCP OAuth broker holds an application transaction while it waits for
 * an auth connection, so the opposite order can deadlock. Shared through a global symbol so
 * the test-time guard (scripts/test-pool-order-setup.ts) sees it without importing this
 * package, including in isolated source copies.
 */
const globalStore = globalThis as { [AUTH_TRANSACTION]?: AsyncLocalStorage<true> }
const heldAuthTransaction = globalStore[AUTH_TRANSACTION] ?? new AsyncLocalStorage<true>()
globalStore[AUTH_TRANSACTION] = heldAuthTransaction

/** Keep the native validators, middleware, hooks, response shapes and error codes. */
export function nativeTeamTransactions<O extends OrganizationOptions>(
  plugin: DefaultOrganizationPlugin<O>,
  currentTransaction: () => Transaction<Database> | undefined,
): DefaultOrganizationPlugin<O> {
  const createOrganization = plugin.endpoints.createOrganization
  plugin.endpoints.createOrganization = Object.assign(
    (context: Parameters<typeof createOrganization>[0]) => {
      if (!context?.context) return createOrganization(context)
      return runWithTransaction(context.context.adapter, () => createOrganization(context)).catch(
        mapOrganizationSlugConflict,
      )
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
  const addMember = plugin.endpoints.addMember
  plugin.endpoints.addMember = Object.assign((context: Parameters<typeof addMember>[0]) => {
    if (!context?.context) return addMember(context)
    return runWithTransaction(context.context.adapter, () => addMember(context))
  }, addMember) as typeof addMember
  const setActiveOrganization = plugin.endpoints.setActiveOrganization
  plugin.endpoints.setActiveOrganization = Object.assign(
    (context: Parameters<typeof setActiveOrganization>[0]) => {
      if (!context?.context || context.request) return setActiveOrganization(context)
      return runWithTransaction(context.context.adapter, () => setActiveOrganization(context))
    },
    setActiveOrganization,
  ) as typeof setActiveOrganization
  const deleteOrganization = plugin.endpoints.deleteOrganization
  plugin.endpoints.deleteOrganization = Object.assign(
    async (context: Parameters<typeof deleteOrganization>[0]) => {
      try {
        if (!context?.context) return await deleteOrganization(context)
        return await runWithTransaction(context.context.adapter, async () => {
          // The launch guard refuses deletion. If enabled later, take the team lock
          // before Better Auth checks the owner's role or clears their session.
          const trx = currentTransaction()
          const organizationId = context.body?.organizationId
          if (!trx) throw new Error('Team deletion requires a transaction')
          if (typeof organizationId === 'string' && isUuid(organizationId)) {
            await trx
              .selectFrom('auth.organization')
              .select('id')
              .where('id', '=', organizationId)
              .forUpdate()
              .executeTakeFirst()
          }
          return deleteOrganization(context)
        })
      } catch (error) {
        // The FK is the final check if a link is created between a preflight and the cascade.
        if (
          databaseErrorCode(error) === '23503' &&
          error &&
          typeof error === 'object' &&
          'constraint' in error &&
          (error.constraint === 'scim_team_mappings_live_child_fkey' ||
            error.constraint === 'scim_team_mappings_live_connection_scope')
        )
          throw scimMappingDetachRequired()
        throw error
      }
    },
    deleteOrganization,
  ) as typeof deleteOrganization
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
    // Consent issuance reads its just-written native consent before returning the
    // code. Bind base adapter operations to the same transaction as the new grant.
    for (const method of [
      'findOne',
      'findMany',
      'count',
      'create',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ] as const) {
      const base = instance[method].bind(instance)
      Object.assign(instance, {
        [method]: (...args: unknown[]) => {
          const consent = mcpOAuthConsentTransaction()
          if (!consent) return Reflect.apply(base, instance, args)
          const scoped = kyselyAdapter(consent, { type: 'postgres', transaction: false })(options)
          return Reflect.apply(scoped[method], scoped, args)
        },
      })
    }
    instance.transaction = (callback) => {
      const run = (trx: Transaction<Database>) =>
        heldAuthTransaction.run(true, async () => {
          // Native models resolve to auth first; the policy also reads public tables.
          // Set this only for the transaction. A withSchema plugin would also rewrite
          // qualified auth-table aliases in the application's existing join queries.
          await sql`SET LOCAL search_path TO auth, public`.execute(trx)
          let originalError: unknown
          const transactionAdapter = new Proxy(
            kyselyAdapter(trx, { type: 'postgres', transaction: false })(options),
            {
              get(target, key, receiver) {
                const operation = Reflect.get(target, key, receiver)
                if (typeof operation !== 'function') return operation
                return async (...args: unknown[]) => {
                  try {
                    return await Reflect.apply(operation, target, args)
                  } catch (error) {
                    if (isOriginalDatabaseError(error)) {
                      originalError ??= error
                    }
                    throw error
                  }
                }
              },
            },
          )
          try {
            return await withAuthAuditTransaction(trx, () =>
              runInTransaction(trx, async () => callback(transactionAdapter)),
            )
          } catch (error) {
            // Native invitation compensation can run after a PostgreSQL error has
            // already aborted the transaction. Keep that original exception for the
            // existing caller/logger, rather than its secondary 25P02 cleanup failure.
            if (originalError !== undefined && databaseErrorCode(error) === '25P02') {
              throw originalError
            }
            throw error
          }
        })
      const consent = mcpOAuthConsentTransaction()
      return consent
        ? run(consent)
        : db.transaction().setIsolationLevel('read committed').execute(run)
    }
    return instance
  }
}
