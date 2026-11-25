// Offline maintenance only. The server image supplies the instance's database connection.
import { createDb, createPool } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { z } from 'zod'
import { scimProvisioningEnabled } from './config.ts'
import { disableSsoEnforcement, ssoOperatorRecoveryQueue } from './sso-operator-recovery.ts'

export async function runSsoOperatorRecovery(
  [argument, ...extra]: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  if (env.HOURMERE_SERVER_CONTAINER !== '1') {
    console.error('Run SSO operator recovery inside the Hourmere server container.')
    return 1
  }
  const team = z.uuid().safeParse(argument)
  const url = env.DATABASE_URL
  if (!team.success || extra.length || !url) {
    console.error('Pass one team UUID and use the server container’s configured database.')
    return 1
  }
  const scim = scimProvisioningEnabled.safeParse(env.SCIM_PROVISIONING_ENABLED)
  if (!scim.success) {
    console.error(scim.error.issues[0]?.message)
    return 1
  }

  const db = createDb(createPool(url))
  const jobs = createJobs({
    connectionString: url,
    definitions: [ssoOperatorRecoveryQueue],
    work: false,
    migrate: false,
    log: () => {},
  })
  let exitCode = 0
  try {
    await jobs.start()
    const result = await disableSsoEnforcement(db, jobs, team.data, scim.data)
    if (result === 'unknown_team') {
      console.error('Unknown team. Supply the UUID of an existing team.')
      exitCode = 1
    } else {
      console.log(
        result === 'disabled'
          ? 'SSO enforcement disabled. Owner notifications queued.'
          : 'SSO enforcement is already off. No changes made.',
      )
    }
  } catch {
    console.error(
      'SSO operator recovery did not complete. Check the instance database and job queue, then retry.',
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
  process.exitCode = await runSsoOperatorRecovery(process.argv.slice(2), process.env)
}
