import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { clearConferenceConnection } from './disconnect.ts'
import type { ConferenceDeps } from './index.ts'

const identityId = /^[A-Za-z0-9_-]{1,128}$/
function affectedEvents(db: Db, connectionId: string) {
  return db
    .selectFrom('event_types')
    .select(['id', 'organization_id'])
    .where('zoom_connection_id', '=', connectionId)
    .where('is_active', '=', true)
    .where(sql<boolean>`location @> '{"kind":"zoom","autoCreate":true}'::jsonb`)
    .orderBy('id')
}

/** Called only after authenticating the Zoom event. Account IDs are not persisted:
 * external_user_id is globally unique, so an account must never widen deletion. */
export async function deauthorizeZoomConnections(
  deps: Pick<ConferenceDeps, 'db'>,
  identity: { userId: string; accountId: string },
): Promise<void> {
  if (!identityId.test(identity.userId) || !identityId.test(identity.accountId)) return
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.db.transaction().execute(async (db) => {
        const candidate = await db
          .selectFrom('conference_connections')
          .select(['id', 'user_id'])
          .where('provider', '=', 'zoom')
          .where('external_user_id', '=', identity.userId)
          .executeTakeFirst()
        if (!candidate?.user_id) return

        // Match OAuth/refresh/worker owner-first protection before touching the
        // connection, so an in-flight operation cannot restore removed access.
        const owner = await db
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', candidate.user_id)
          .forUpdate()
          .executeTakeFirst()
        if (!owner) return
        const current = await db
          .selectFrom('conference_connections')
          .select('id')
          .where('id', '=', candidate.id)
          .where('user_id', '=', owner.id)
          .where('provider', '=', 'zoom')
          .where('external_user_id', '=', identity.userId)
          .forUpdate()
          .executeTakeFirst()
        if (!current) return

        // Settings take organization/event locks before owner protection. Never
        // wait in the opposite order: NOWAIT rolls back for a bounded retry, then
        // lets Zoom retry a failed delivery if contention persists. New connection
        // selections cannot commit while this owner lock is held.
        const before = await affectedEvents(db, current.id).execute()
        const organizations = [...new Set(before.map((row) => row.organization_id))].sort()
        if (organizations.length)
          await db
            .selectFrom('auth.organization')
            .select('id')
            .where('id', 'in', organizations)
            .orderBy('id')
            .forShare()
            .noWait()
            .execute()
        const events = await affectedEvents(db, current.id).forUpdate().noWait().execute()
        if (events.length)
          await db
            .updateTable('event_types')
            .set({ is_active: false })
            .where(
              'id',
              'in',
              events.map((row) => row.id),
            )
            .execute()
        await clearConferenceConnection(db, owner.id, current.id, true)
      })
      return
    } catch (error) {
      if ((error as { code?: string }).code !== '55P03' || attempt >= 2) throw error
    }
  }
}
