import { parseArgs } from 'node:util'
import pg from 'pg'

export const DEFAULT_MIN_AGE_HOURS = 24

export interface TestDatabaseCandidate {
  name: string
  oid: string
  modifiedAt: Date | null
  connections: number
}

/** Always use the maintenance database, including when DATABASE_URL names hourmere. */
export function maintenanceUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    throw new Error('Expected a PostgreSQL admin URL')
  parsed.pathname = '/postgres'
  // libpq-style URL parameters can otherwise override the pathname.
  parsed.searchParams.delete('database')
  parsed.searchParams.delete('dbname')
  return parsed.toString()
}

export function embeddedPid(name: string): number | null {
  const match = /^hourmere_test_(?:[a-z][a-z0-9_]*_)?([1-9]\d*)_[a-f0-9]+$/.exec(name)
  if (!match) return null // Legacy names (e.g. host_tokens_<uuid>) did not carry a PID.
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid <= 2_147_483_647 ? pid : null
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM and unknown failures cannot establish that a process is dead.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

interface SelectionOptions {
  minAgeHours?: number
  now?: number
  processAlive?: (pid: number) => boolean
}

function ageMilliseconds(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000))
    throw new Error('--older-than-hours must be a finite positive number')
  return hours * 3_600_000
}

/** Pure selection logic; unknown age/activity fails closed. */
export function selectionReason(
  database: TestDatabaseCandidate,
  options: SelectionOptions = {},
): string {
  const age = ageMilliseconds(options.minAgeHours ?? DEFAULT_MIN_AGE_HOURS)
  if (!/^hourmere_test_[a-z0-9_]+$/.test(database.name)) return 'outside test namespace'
  const modified = database.modifiedAt?.getTime()
  if (modified === undefined || !Number.isFinite(modified)) return 'unknown age'
  if ((options.now ?? Date.now()) - modified <= age) return 'too young'
  if (database.connections !== 0) return 'has connections'
  const pid = embeddedPid(database.name)
  if (pid !== null && (options.processAlive ?? isProcessAlive)(pid)) return 'PID is live'
  return 'eligible'
}

/** PG_VERSION mtime approximates creation; a newer timestamp only delays cleanup. */
export async function listTestDatabases(
  admin: pg.Pool,
  name?: string,
): Promise<TestDatabaseCandidate[]> {
  const result = await admin.query<TestDatabaseCandidate>(
    `SELECT d.datname AS name, d.oid::text AS oid,
            (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification AS "modifiedAt",
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid = d.oid) AS connections
       FROM pg_database d
      WHERE starts_with(d.datname, 'hourmere_test_') AND ($1::text IS NULL OR d.datname = $1)
      ORDER BY d.datname`,
    [name ?? null],
  )
  return result.rows
}

interface SweepOptions extends SelectionOptions {
  yes?: boolean
  log?: (message: string) => void
}

/** Processes only this inventory. Rechecks each candidate immediately before DROP. */
export async function sweepTestDatabases(
  admin: pg.Pool,
  inventory: TestDatabaseCandidate[],
  options: SweepOptions = {},
): Promise<number> {
  ageMilliseconds(options.minAgeHours ?? DEFAULT_MIN_AGE_HOURS)
  const log = options.log ?? console.log
  let dropped = 0
  for (const database of inventory) {
    const reason = selectionReason(database, options)
    if (reason !== 'eligible') {
      log(`SKIP ${database.name}: ${reason}`)
      continue
    }
    if (!options.yes) {
      log(
        `WOULD DROP ${database.name} (modified ${database.modifiedAt?.toISOString()}, connections 0)`,
      )
      continue
    }
    const current = (await listTestDatabases(admin, database.name))[0]
    if (
      !current ||
      current.oid !== database.oid ||
      selectionReason(current, options) !== 'eligible'
    ) {
      log(`SKIP ${database.name}: changed since inventory`)
      continue
    }
    try {
      // Deliberately no FORCE: a connection arriving after the check must prevent DROP.
      await admin.query(`DROP DATABASE ${pg.escapeIdentifier(database.name)}`)
      dropped++
      log(`DROPPED ${database.name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== '55006') throw error
      log(`SKIP ${database.name}: acquired connections`)
    }
  }
  return dropped
}

export async function main(argv: string[], env = process.env): Promise<number> {
  let admin: pg.Pool | undefined
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        yes: { type: 'boolean', default: false },
        'admin-url': { type: 'string' },
        'older-than-hours': { type: 'string', default: String(DEFAULT_MIN_AGE_HOURS) },
      },
    })
    const minAgeHours = Number(values['older-than-hours'])
    ageMilliseconds(minAgeHours)
    const url = values['admin-url'] ?? env.DATABASE_URL
    if (!url) throw new Error('Set DATABASE_URL or pass --admin-url')
    admin = new pg.Pool({
      connectionString: maintenanceUrl(url),
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    })
    console.log(
      `${values.yes ? 'APPLY' : 'DRY RUN'}: test databases older than ${minAgeHours} hours`,
    )
    await sweepTestDatabases(admin, await listTestDatabases(admin), {
      yes: values.yes,
      minAgeHours,
    })
    return 0
  } catch {
    // Connection errors and argument errors may include an admin URL/password.
    console.error('Test database cleanup failed. Check arguments, database access and permissions.')
    return 1
  } finally {
    await admin?.end()
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
