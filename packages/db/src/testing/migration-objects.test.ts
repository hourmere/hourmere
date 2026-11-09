import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from '../migrate.ts'

// Constraint coverage (constraint-coverage.ts) is required from this migration on.
const firstCoveredMigration = 71

/**
 * Migrations that merge from open pull requests before their coverage test; each gets its
 * `migration-objects/<migration>.json` and a coverage test in a follow-up change, which also
 * removes the entry here. Adding a new migration to this list needs the same review.
 */
const coverageFollowsLater = new Set(['0072_routing_forms.sql', '0073_scim_identity.sql'])

const expectationFiles = new Set(
  readdirSync(fileURLToPath(new URL('./migration-objects/', import.meta.url)))
    .filter((file) => file.endsWith('.json'))
    .map((file) => basename(file, '.json')),
)

const migrationNumber = (file: string) => Number.parseInt(file.slice(0, 4), 10)

describe('constraint coverage adoption', () => {
  const migrations = readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .sort()

  it('has an expectation file for every migration from 0071 on', () => {
    const missing = migrations.filter(
      (file) =>
        migrationNumber(file) >= firstCoveredMigration &&
        !expectationFiles.has(basename(file, '.sql')) &&
        !coverageFollowsLater.has(file),
    )
    expect(
      missing,
      'add a constraint coverage test and its migration-objects file (CONTRIBUTING.md)',
    ).toEqual([])
  })

  it('lists only later-covered migrations that still lack their expectation file', () => {
    const stale = [...coverageFollowsLater].filter((file) =>
      expectationFiles.has(basename(file, '.sql')),
    )
    expect(stale, 'remove the entry: the migration now has its expectation file').toEqual([])
    for (const file of coverageFollowsLater) {
      expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/)
      expect(migrationNumber(file)).toBeGreaterThan(firstCoveredMigration)
    }
  })

  it('names expectation files after existing migrations', () => {
    const names = new Set(migrations.map((file) => basename(file, '.sql')))
    expect([...expectationFiles].filter((name) => !names.has(name))).toEqual([])
  })
})
