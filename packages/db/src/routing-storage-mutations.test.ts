import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  copyRoutingPredecessor,
  routingFixture,
  routingMigration,
} from './routing-storage-fixtures.ts'
import { routingProtections } from './routing-storage-protections.ts'
import { MIGRATION_REPLAY_TIMEOUT, useMigrationReplay } from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'

vi.setConfig({ testTimeout: MIGRATION_REPLAY_TIMEOUT, hookTimeout: MIGRATION_REPLAY_TIMEOUT })

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('routing storage source-copy mutations', () => {
  // This source-copy test skips meeting polls, so the shared history ends at 0070.
  const replay = useMigrationReplay(serverUrl as string, '0071_meeting_polls.sql')

  it.each(Object.keys(routingProtections))(
    'detects broken %s and passes restored SQL',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-routing-mutation-'))
      let owned: TestDatabase | undefined
      try {
        await copyRoutingPredecessor(directory)
        const source = await readFile(join(migrationsDir, routingMigration), 'utf8')
        const target = routingProtections[name]
        if (!target) throw new Error(`Missing protection ${name}`)
        const check = async (sql: string) => {
          await writeFile(join(directory, routingMigration), sql)
          owned = await replay.predecessor.clone(directory, {
            tag: 'routing_mutation',
          })
          try {
            await target.check(await routingFixture(owned.pool))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        const mutant = target.break(source)
        expect(mutant).not.toBe(source)
        // Only a real assertion failure counts; SQL/setup failures do not detect a mutant.
        await expect(check(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
        await check(source)
      } finally {
        await owned?.drop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
