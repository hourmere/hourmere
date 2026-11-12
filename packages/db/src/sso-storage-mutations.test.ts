import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  copySsoPredecessor,
  inRolledBackTransaction,
  ssoFixture,
  ssoMigration,
} from './sso-storage-fixtures.ts'
import { type SsoProtection, ssoProtections } from './sso-storage-protections.ts'
import { checkActiveClaimRace } from './sso-storage-races.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
// Optional local report of which assertion each mutation failed (one JSON line each).
const report = process.env.HOURMERE_SSO_MUTATION_REPORT

const cases = Object.entries(ssoProtections).flatMap(([protection, { mutants }]) =>
  mutants.map((mutant) => [protection, mutant.name] as const),
)

describe.skipIf(!serverUrl)('SSO configuration storage source-copy mutations', () => {
  let directory: string
  let predecessor: TestDatabase
  let source: string

  // One database at the predecessor schema. Each run applies the migration as written or
  // mutated in a transaction, checks one protection and rolls everything back.
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-mutation-'))
    await copySsoPredecessor(directory)
    predecessor = await createTestDatabase(serverUrl as string, directory, {
      tag: 'sso_mutation',
    })
    source = await readFile(join(migrationsDir, ssoMigration), 'utf8')
  })
  afterAll(async () => {
    await predecessor?.drop()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const run = (sql: string, protection: SsoProtection) =>
    inRolledBackTransaction(predecessor.pool, async (db) => {
      await db.query(sql)
      await protection.check(await ssoFixture(db))
    })

  it.each(cases)('%s: detects "%s"', async (name, mutantName) => {
    const protection = ssoProtections[name] as SsoProtection
    const mutant = protection.mutants.find((candidate) => candidate.name === mutantName)
    if (!mutant) throw new Error(`Missing mutant ${mutantName}`)
    await run(source, protection)
    const mutated = mutant.apply(source)
    expect(mutated).not.toBe(source)
    // Only a failed assertion counts; SQL or setup errors do not detect a mutant.
    const error = await run(mutated, protection).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    )
    expect(error).toMatchObject({ name: 'AssertionError' })
    if (report)
      await appendFile(
        report,
        `${JSON.stringify({ protection: name, mutant: mutantName, failed: error?.message.split('\n')[0] })}\n`,
      )
    // The predecessor database is unchanged for the next run.
    const { rows } = await predecessor.pool.query(
      "SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'sso\\_%'",
    )
    expect(rows[0]?.n).toBe(0)
    expect(predecessor.pool.totalCount).toBeLessThanOrEqual(2)
  })

  it('detects a missing active-claim index under concurrent writers', async () => {
    const mutated = await mkdtemp(join(tmpdir(), 'hourmere-sso-race-'))
    let owned: TestDatabase | undefined
    try {
      await copySsoPredecessor(mutated)
      await copyFile(join(migrationsDir, ssoMigration), join(mutated, ssoMigration))
      await writeFile(
        join(mutated, ssoMigration),
        `${source}\nDROP INDEX sso_domains_active_name;\n`,
      )
      owned = await createTestDatabase(serverUrl as string, mutated, { tag: 'sso_race' })
      await expect(checkActiveClaimRace(owned.pool)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
    } finally {
      await owned?.drop()
      await rm(mutated, { recursive: true, force: true })
    }
  }, 60_000)
})
