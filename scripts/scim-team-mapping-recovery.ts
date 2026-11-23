// Offline SCIM resource test harness. The production image does not ship this entry point.
import { createDb, createPool } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { DomainError } from '@hourmere/scheduling'
import { scimMappingNoticeQueue } from '../apps/server/src/scim-team-mapping-notices.ts'
import {
  recoverScimTeamMapping,
  ScimMappingRecovery,
} from '../apps/server/src/scim-team-mapping-recovery.ts'

const [flag, action, mappingId, parentOrganizationId, childOrganizationId, ...extra] =
  process.argv.slice(2)
const target = ScimMappingRecovery.safeParse({
  action,
  mappingId,
  parentOrganizationId,
  childOrganizationId,
})
const url = process.env.DATABASE_URL

if (flag !== '--resource-test' || !target.success || extra.length > 0 || !url) {
  console.error(
    'Usage with the resource test database configured: scim-team-mapping-recovery.ts --resource-test <suspend|detach> <mapping UUID> <parent UUID> <child UUID>',
  )
  process.exitCode = 1
} else {
  const db = createDb(createPool(url))
  const jobs = createJobs({
    connectionString: url,
    definitions: [scimMappingNoticeQueue],
    work: false,
    migrate: false,
    log: () => {},
  })
  try {
    await jobs.start()
    const result = await recoverScimTeamMapping(db, jobs, true, target.data)
    console.log(
      result === 'unchanged' ? 'No changes made.' : `Mapping ${result}. Owner notices queued.`,
    )
  } catch (error) {
    const reason = error instanceof DomainError ? error.code : undefined
    console.error(
      reason === 'scim_mapping_access_denied'
        ? 'No mapping matches the supplied identifiers.'
        : reason === 'scim_mapping_privileged_member' ||
            reason === 'scim_mapping_roster_requires_departure'
          ? 'Detachment is blocked. The child team must resolve privileged roles or departure impact before retrying.'
          : 'SCIM mapping recovery did not complete. Check the instance database and job queue, then retry.',
    )
    process.exitCode = 1
  } finally {
    const closed = await Promise.allSettled([jobs.stop(), db.destroy()])
    if (closed.some(({ status }) => status === 'rejected')) {
      console.error('Could not close a maintenance database connection cleanly.')
      process.exitCode = 1
    }
  }
}
