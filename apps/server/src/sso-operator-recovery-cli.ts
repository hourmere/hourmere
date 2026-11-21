// Offline maintenance only. The server image supplies the instance's database connection.
import { createDb, createPool } from '@hourmere/db'
import { createJobs } from '@hourmere/jobs'
import { z } from 'zod'
import { disableSsoEnforcement, ssoOperatorRecoveryQueue } from './sso-operator-recovery.ts'

const [argument, ...extra] = process.argv.slice(2)
const team = z.uuid().safeParse(argument)
const url = process.env.DATABASE_URL

if (process.env.HOURMERE_SERVER_CONTAINER !== '1') {
  console.error('Run SSO operator recovery inside the Hourmere server container.')
  process.exitCode = 1
} else if (!team.success || extra.length || !url) {
  console.error('Pass one team UUID and use the server container’s configured database.')
  process.exitCode = 1
} else {
  const db = createDb(createPool(url))
  const jobs = createJobs({
    connectionString: url,
    definitions: [ssoOperatorRecoveryQueue],
    work: false,
    migrate: false,
    log: () => {},
  })
  try {
    await jobs.start()
    const result = await disableSsoEnforcement(db, jobs, team.data)
    if (result === 'unknown_team') {
      console.error('Unknown team. Supply the UUID of an existing team.')
      process.exitCode = 1
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
    process.exitCode = 1
  } finally {
    const closed = await Promise.allSettled([jobs.stop(), db.destroy()])
    if (closed.some(({ status }) => status === 'rejected')) {
      console.error('Could not close a maintenance database connection cleanly.')
      process.exitCode = 1
    }
  }
}
