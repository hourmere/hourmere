import { appendFile, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  type OperationsProtection,
  operationsFixture,
  operationsMigration,
  operationsProtections,
} from './routing-storage-operations-protections.ts'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
// Optional local report of which assertion each mutant failed (one JSON line each).
const report = process.env.HOURMERE_ROUTING_OPERATIONS_MUTATION_REPORT

const cases = Object.entries(operationsProtections).flatMap(([protection, { mutants }]) =>
  mutants.map((mutant) => [protection, mutant.name] as const),
)

// Each mutant weakens one predicate, key, action or trigger clause of 0083, which dropping a
// whole catalog object (routing-storage-operations-coverage.test.ts) cannot reach, and must
// make its protection's check fail with an assertion. Every copy starts from a template of
// the predecessor migrations.
describe.skipIf(!serverUrl)('routing form operation storage source-copy mutations', () => {
  let template: TestDatabaseTemplate | undefined
  let source: string

  beforeAll(async () => {
    const predecessors = await mkdtemp(join(tmpdir(), 'hourmere-routing-operations-predecessors-'))
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < operationsMigration)
        .sort()
      expect(files).toContain('0072_routing_forms.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(predecessors, file))
      template = await createTestDatabaseTemplate(
        serverUrl as string,
        async (pool) => {
          await runMigrations(pool, predecessors)
        },
        { tag: 'routingopmut' },
      )
    } finally {
      await rm(predecessors, { recursive: true, force: true })
    }
    source = await readFile(join(migrationsDir, operationsMigration), 'utf8')
  }, 120_000)
  afterAll(() => template?.drop())

  /** Applies `sql` as 0083 to a predecessor copy and runs the protection's check on it. */
  async function run(sql: string, protection: OperationsProtection) {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-routing-operations-mutation-'))
    try {
      await writeFile(join(directory, operationsMigration), sql)
      const owned = await (template as TestDatabaseTemplate).clone(directory, {
        tag: 'routingopmut',
      })
      try {
        await protection.check(await operationsFixture(owned.pool))
        expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
      } finally {
        await owned.drop()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('runs every check unmutated on the predecessor plus 0083', async () => {
    for (const protection of Object.values(operationsProtections)) await run(source, protection)
  }, 120_000)

  it.each(cases)(
    '%s: detects "%s"',
    async (name, mutantName) => {
      const protection = operationsProtections[name] as OperationsProtection
      const mutant = protection.mutants.find((candidate) => candidate.name === mutantName)
      if (!mutant) throw new Error(`Missing mutant ${mutantName}`)
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
    },
    60_000,
  )
})
