// Every mutation is applied to an isolated source copy, then the real assertion is
// run against original -> broken -> restored migrations. Setup/runtime SQL failures
// cannot count as mutation detection: only a Vitest AssertionError is accepted.
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupFixture } from './group-seats-fixtures.ts'
import {
  type Protection,
  groupSourceProtections as protections,
} from './group-seats-source-mutations.ts'
import { migrationsDir } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0059_group_seats.sql'
describe.skipIf(!serverUrl)('group storage source-copy protections', () => {
  it.each(Object.keys(protections))(
    'detects broken %s and passes with restored source',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-group-source-copy-'))
      let owned: TestDatabase | undefined
      try {
        for (const file of (await readdir(migrationsDir)).filter(
          (file) => file.endsWith('.sql') && file < migration,
        ))
          await copyFile(join(migrationsDir, file), join(directory, file))
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const target = protections[name] as Protection
        const check = async (sql: string) => {
          await writeFile(join(directory, migration), sql)
          owned = await createTestDatabase(serverUrl as string, directory, {
            tag: 'group_mutation',
          })
          try {
            await target.check(await groupFixture(owned.pool))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        const mutant = target.break(source)
        expect(mutant).not.toBe(source)
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
