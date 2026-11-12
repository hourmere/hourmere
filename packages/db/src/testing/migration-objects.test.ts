import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from '../migrate.ts'

// Constraint coverage (constraint-coverage.ts) is required from this migration on, for every
// migration: each ships its expectation file and coverage test in the same change.
const firstCoveredMigration = 71

const expectationFiles = new Set(
  readdirSync(fileURLToPath(new URL('./migration-objects/', import.meta.url)))
    .filter((file) => file.endsWith('.json'))
    .map((file) => basename(file, '.json')),
)

const migrationNumber = (name: string) => Number.parseInt(name.slice(0, 4), 10)

describe('constraint coverage adoption', () => {
  const migrations = readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .map((file) => basename(file, '.sql'))
    .sort()

  it('has an expectation file for exactly the migrations from 0071 on', () => {
    // Both sides are compared whole, so a migration cannot be left out of the requirement
    // while its expectation file still exists, nor its file removed while it is required.
    expect(
      [...expectationFiles].filter((name) => migrationNumber(name) >= firstCoveredMigration).sort(),
      'add a constraint coverage test and its migration-objects file (CONTRIBUTING.md)',
    ).toEqual(migrations.filter((name) => migrationNumber(name) >= firstCoveredMigration))
  })

  it('names expectation files after existing migrations', () => {
    const names = new Set(migrations)
    expect([...expectationFiles].filter((name) => !names.has(name))).toEqual([])
  })
})
