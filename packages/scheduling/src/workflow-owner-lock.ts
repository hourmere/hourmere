import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

/** Serialize workflow admission and event-type creation after locking the organization. */
export async function lockWorkflowOwner(db: Db, organizationId: string, userId: string | null) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-owner:${organizationId}:${userId ?? 'team'}`}, 0))`.execute(
    db,
  )
}
