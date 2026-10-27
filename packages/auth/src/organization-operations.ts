import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context'
import type { BetterAuthPlugin } from 'better-auth'
import type { DBTransactionAdapter } from 'better-auth/adapters'

interface Member {
  id: string
  organizationId: string
  userId: string
  role: string
}

const removalPaths = new Set(['/organization/remove-member', '/organization/leave'])

/**
 * Records only successful member operations at Better Auth's persistence boundary. The
 * private models use the same transaction adapter as the membership write; application
 * migrations own these public tables, not Better Auth's schema generator.
 */
export function organizationOperationRecords(): BetterAuthPlugin {
  return {
    id: 'organization-operation-records',
    schema: {
      organizationOperation: {
        modelName: 'public.organization_operations',
        disableMigration: true,
        fields: {
          organizationId: { type: 'string', fieldName: 'organization_id' },
          operation: { type: 'string' },
          actorUserId: { type: 'string', fieldName: 'actor_user_id' },
          targetUserId: { type: 'string', fieldName: 'target_user_id' },
          previousRole: { type: 'string', fieldName: 'previous_role' },
          newRole: { type: 'string', fieldName: 'new_role', required: false },
          source: { type: 'string' },
          occurredAt: { type: 'date', fieldName: 'occurred_at' },
        },
      },
      personalOrganizationMarker: {
        modelName: 'public.personal_organizations',
        disableMigration: true,
        fields: {
          organizationId: { type: 'string', fieldName: 'organization_id' },
        },
      },
    },
    init(ctx) {
      const isPersonal = async (adapter: DBTransactionAdapter, organizationId: string) =>
        Boolean(
          await adapter.findOne({
            model: 'personalOrganizationMarker',
            where: [{ field: 'organizationId', value: organizationId }],
            // This marker has no id column.
            select: ['organizationId'],
          }),
        )

      const record = async (
        adapter: DBTransactionAdapter,
        member: Member,
        actorUserId: string,
        newRole?: string,
      ) => {
        const inserted = await adapter.create<Record<string, unknown>, { id: string }>({
          model: 'organizationOperation',
          data: {
            organizationId: member.organizationId,
            operation: newRole === undefined ? 'member_removed' : 'member_role_changed',
            actorUserId,
            targetUserId: member.userId,
            previousRole: member.role,
            newRole: newRole ?? null,
            source: 'web',
            occurredAt: new Date(),
          },
        })
        return inserted.id
      }

      const discard = (adapter: DBTransactionAdapter, id: string) =>
        adapter.delete({
          model: 'organizationOperation',
          where: [{ field: 'id', value: id }],
        })

      const stamp = (adapter: DBTransactionAdapter, id: string, previousRole?: string) =>
        adapter.update({
          model: 'organizationOperation',
          where: [{ field: 'id', value: id }],
          update: {
            ...(previousRole === undefined ? {} : { previousRole }),
            occurredAt: new Date(),
          },
        })

      const wrap = (adapter: DBTransactionAdapter, inTransaction: boolean) => {
        const update = adapter.update
        adapter.update = async <T>(request: Parameters<DBTransactionAdapter['update']>[0]) => {
          const endpoint = tryGetCurrentAuthEndpointContext()
          const actorUserId = endpoint?.context.session?.user.id
          if (
            request.model !== 'member' ||
            endpoint?.path !== '/organization/update-member-role' ||
            !actorUserId ||
            typeof request.update.role !== 'string'
          )
            return update<T>(request)
          if (!inTransaction) return ctx.adapter.transaction((trx) => trx.update<T>(request))

          // The role predicate ties the recorded previous role to the actual update,
          // including a concurrent change between the read and the write. A no-op still
          // uses that predicate so it cannot overwrite an intervening role without a record.
          for (let attempt = 0; attempt < 5; attempt++) {
            const member = await adapter.findOne<Member>({
              model: 'member',
              where: request.where,
            })
            if (!member) return null
            // The eventual record acquires its organization FK lock first, matching
            // writers that lock the organization before its members. Both this record
            // and the member write remain invisible until the transaction commits.
            // A missed conditional UPDATE can retain a member lock, so no-ops also
            // reserve the FK before their first attempt and discard their record below.
            const operationId = !(await isPersonal(adapter, member.organizationId))
              ? await record(adapter, member, actorUserId, request.update.role)
              : undefined
            const updated = await update<T>({
              ...request,
              where: [
                ...request.where,
                { field: 'role', value: member.role },
                { field: 'organizationId', value: member.organizationId },
                { field: 'userId', value: member.userId },
              ],
            })
            if (!updated) {
              if (operationId) await discard(adapter, operationId)
              continue
            }
            if (operationId) {
              if (member.role === request.update.role) await discard(adapter, operationId)
              else await stamp(adapter, operationId)
            }
            return updated
          }
          throw new Error('Member role changed concurrently; retry the operation')
        }

        const remove = adapter.delete
        adapter.delete = async (request) => {
          const endpoint = tryGetCurrentAuthEndpointContext()
          const actorUserId = endpoint?.context.session?.user.id
          if (request.model !== 'member' || !removalPaths.has(endpoint?.path ?? '') || !actorUserId)
            return remove(request)
          if (!inTransaction) return ctx.adapter.transaction((trx) => trx.delete(request))

          const snapshot = await adapter.findOne<Member>(request)
          if (!snapshot) return
          const operationId = !(await isPersonal(adapter, snapshot.organizationId))
            ? await record(adapter, snapshot, actorUserId)
            : undefined
          // Acquire the organization FK before the delete locks its member. Constrain
          // DELETE RETURNING to the recorded identity, then retain the role from the row
          // actually removed, including a role change after the initial snapshot.
          const member = await adapter.consumeOne<Member>({
            ...request,
            where: [
              ...request.where,
              { field: 'organizationId', value: snapshot.organizationId },
              { field: 'userId', value: snapshot.userId },
            ],
          })
          if (!member) {
            if (operationId) await discard(adapter, operationId)
            return
          }
          if (operationId) await stamp(adapter, operationId, member.role)
        }
        return adapter
      }

      const adapter = ctx.adapter
      wrap(adapter, false)
      const transaction = adapter.transaction
      adapter.transaction = (callback) => transaction((trx) => callback(wrap(trx, true)))
    },
  }
}
