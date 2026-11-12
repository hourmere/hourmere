import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  copyIdentityPredecessor,
  identityFixture,
  identityMigration,
  identityTables,
} from './sso-identity-fixtures.ts'
import { type IdentityProtection, identityProtections } from './sso-identity-protections.ts'
import { checkLinkIdentityRace, checkReplayRace } from './sso-identity-races.ts'
import { inRolledBackTransaction } from './sso-storage-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
// Optional local report of which assertion each mutation failed (one JSON line each).
const report = process.env.HOURMERE_SSO_MUTATION_REPORT

const cases = Object.entries(identityProtections).flatMap(([protection, { mutants }]) =>
  mutants.map((mutant) => [protection, mutant.name] as const),
)

describe.skipIf(!serverUrl)('SSO identity storage source-copy mutations', () => {
  let directory: string
  let predecessor: TestDatabase
  let source: string

  // One database at the predecessor schema (through 0074). Each run applies the migration as
  // written or mutated in a transaction, checks one protection and rolls everything back.
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-identity-mutation-'))
    await copyIdentityPredecessor(directory)
    predecessor = await createTestDatabase(serverUrl as string, directory, {
      tag: 'sso_id_mutation',
    })
    source = await readFile(join(migrationsDir, identityMigration), 'utf8')
  })
  afterAll(async () => {
    await predecessor?.drop()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  const run = (sql: string, protection: IdentityProtection) =>
    inRolledBackTransaction(predecessor.pool, async (db) => {
      await db.query(sql)
      await protection.check(await identityFixture(db))
    })

  it.each(cases)(
    '%s: detects "%s"',
    async (name, mutantName) => {
      const protection = identityProtections[name] as IdentityProtection
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
        "SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1) AND relkind = 'r'",
        [[...identityTables]],
      )
      expect(rows[0]?.n).toBe(0)
      expect(predecessor.pool.totalCount).toBeLessThanOrEqual(2)
      // Each case takes about 0.1 s; the margin absorbs a loaded shared database server.
    },
    30_000,
  )

  // A race on a database whose 0075 also runs `drop`; the race commits its own rows.
  async function raceMutant(drop: string, race: (pool: pg.Pool) => Promise<void>) {
    const mutated = await mkdtemp(join(tmpdir(), 'hourmere-sso-identity-race-'))
    let owned: TestDatabase | undefined
    try {
      await copyIdentityPredecessor(mutated)
      await writeFile(join(mutated, identityMigration), `${source}\n${drop}\n`)
      owned = await createTestDatabase(serverUrl as string, mutated, { tag: 'sso_id_race' })
      await expect(race(owned.pool)).rejects.toMatchObject({ name: 'AssertionError' })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    } finally {
      await owned?.drop()
      await rm(mutated, { recursive: true, force: true })
    }
  }

  it('detects a missing live-identity index under concurrent writers', async () => {
    await raceMutant('DROP INDEX sso_identity_links_live_identity;', checkLinkIdentityRace)
  }, 60_000)

  it('detects a missing replay key under concurrent writers', async () => {
    await raceMutant(
      'ALTER TABLE sso_replay_cache DROP CONSTRAINT sso_replay_cache_pkey;',
      checkReplayRace,
    )
  }, 60_000)
})
