// Offline maintenance only. The server image supplies the instance's database connection.
import { createDb, createPool } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { DomainError } from '@hourmere/scheduling'
import type { z } from 'zod'
import { scimProvisioningEnabled } from './config.ts'
import { scimMappingNoticeQueue } from './scim-team-mapping-notices.ts'
import { recoverScimTeamMapping, ScimMappingRecovery } from './scim-team-mapping-recovery.ts'

export async function runScimTeamMappingRecovery(
  url: string,
  target: z.infer<typeof ScimMappingRecovery>,
  resourcesEnabled: boolean,
) {
  if (!resourcesEnabled) {
    console.error('SCIM provisioning is disabled. Enable it before running mapping recovery.')
    return 1
  }
  const db = createDb(createPool(url))
  const jobs = createJobs({
    connectionString: url,
    definitions: [scimMappingNoticeQueue],
    work: false,
    migrate: false,
    log: () => {},
  })
  let exitCode = 0
  try {
    await jobs.start()
    const result = await recoverScimTeamMapping(db, jobs, resourcesEnabled, target)
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
    exitCode = 1
  } finally {
    const closed = await Promise.allSettled([jobs.stop(), db.destroy()])
    if (closed.some(({ status }) => status === 'rejected')) {
      console.error('Could not close a maintenance database connection cleanly.')
      exitCode = 1
    }
  }
  return exitCode
}

if (import.meta.main) {
  const [action, mappingId, parentOrganizationId, childOrganizationId, ...extra] =
    process.argv.slice(2)
  const target = ScimMappingRecovery.safeParse({
    action,
    mappingId,
    parentOrganizationId,
    childOrganizationId,
  })
  const url = process.env.DATABASE_URL
  const scim = scimProvisioningEnabled.safeParse(process.env.SCIM_PROVISIONING_ENABLED)
  if (process.env.HOURMERE_SERVER_CONTAINER !== '1') {
    console.error('Run SCIM mapping recovery inside the Hourmere server container.')
    process.exitCode = 1
  } else if (!target.success || extra.length > 0 || !url) {
    console.error('Pass <suspend|detach> <mapping UUID> <parent UUID> <child UUID>.')
    process.exitCode = 1
  } else if (!scim.success) {
    console.error(scim.error.issues[0]?.message)
    process.exitCode = 1
  } else {
    process.exitCode = await runScimTeamMappingRecovery(url, target.data, scim.data)
  }
}
