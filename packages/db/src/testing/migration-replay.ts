import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { migrationsDir, runMigrations } from '../migrate.ts'
import {
  createTestDatabaseTemplate,
  findTestMigrationPrefix,
  type TestDatabaseTemplate,
} from '../testing.ts'

export const MIGRATION_REPLAY_TIMEOUT = 120_000
export const MIGRATION_COVERAGE_TIMEOUT = 600_000

/**
 * Register a pristine predecessor for a suite that needs multiple copies of the same history.
 * Start each branch with a clone. Add the target to the staged directory when upgrading a clone.
 */
export function useMigrationReplay(
  serverUrl: string,
  migration: string,
): { readonly directory: string; readonly predecessor: TestDatabaseTemplate } {
  let directory: string
  let predecessor: TestDatabaseTemplate

  beforeAll(async () => {
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql'))
    if (!files.includes(migration)) throw new Error(`Unknown migration ${migration}`)
    directory = await mkdtemp(join(tmpdir(), 'hourmere-replay-'))
    await Promise.all(
      files
        .filter((file) => file < migration)
        .map((file) => copyFile(join(migrationsDir, file), join(directory, file))),
    )
    predecessor = await createTestDatabaseTemplate(
      serverUrl,
      async (pool) => {
        await runMigrations(pool, directory)
      },
      { tag: 'replay', template: await findTestMigrationPrefix(serverUrl, directory) },
    )
  }, MIGRATION_REPLAY_TIMEOUT)

  afterAll(async () => {
    try {
      await predecessor?.drop()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }, MIGRATION_REPLAY_TIMEOUT)

  return {
    get directory() {
      return directory
    },
    get predecessor() {
      return predecessor
    },
  }
}
