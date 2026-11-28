import { sql } from 'kysely'
import type { Db } from './index.ts'

/** The caller holds the organization lock and has applied an actual fixed-role change. */
export async function advanceAffectedMembership(
  db: Db,
  organizationId: string,
  memberId: string,
  previousGeneration: number | null,
) {
  if (previousGeneration === null || previousGeneration <= 1) return
  // The assignment clearance trigger may already have advanced this generation.
  await db
    .updateTable('team_member_authorizations')
    .set({ generation: sql<number>`generation + 1` })
    .where('organization_id', '=', organizationId)
    .where('member_id', '=', memberId)
    .where('generation', '=', previousGeneration)
    .execute()
}
