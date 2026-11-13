import { appendFile, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabaseTemplate, type TestDatabaseTemplate } from './testing.ts'
import {
  type WorkflowProtection,
  workflowFixture,
  workflowMigration,
  workflowProtections,
} from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL
// Optional local report of which assertion each mutant failed (one JSON line each).
const report = process.env.HOURMERE_WORKFLOW_MUTATION_REPORT

const cases = Object.entries(workflowProtections).flatMap(([protection, { mutants }]) =>
  mutants.map((mutant) => [protection, mutant.name] as const),
)

// Each mutant weakens one predicate, clause or trigger rule of 0076, which dropping a whole
// catalog object (workflow-storage-coverage.test.ts) cannot reach, and must make its
// protection's check fail with an assertion. Every copy starts from a predecessor template.
describe.skipIf(!serverUrl)('workflow definition storage source-copy mutations', () => {
  let template: TestDatabaseTemplate | undefined
  let source: string

  beforeAll(async () => {
    const predecessors = await mkdtemp(join(tmpdir(), 'hourmere-workflow-predecessors-'))
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < workflowMigration)
        .sort()
      expect(files).toContain('0074_sso_configuration.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(predecessors, file))
      template = await createTestDatabaseTemplate(
        serverUrl as string,
        async (pool) => {
          await runMigrations(pool, predecessors)
        },
        { tag: 'workflowmut' },
      )
    } finally {
      await rm(predecessors, { recursive: true, force: true })
    }
    source = await readFile(join(migrationsDir, workflowMigration), 'utf8')
  }, 120_000)
  afterAll(() => template?.drop())

  /** Applies `sql` as 0076 to a predecessor copy and runs the protection's check on it. */
  async function run(sql: string, protection: WorkflowProtection) {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-mutation-'))
    try {
      await writeFile(join(directory, workflowMigration), sql)
      const owned = await (template as TestDatabaseTemplate).clone(directory, {
        tag: 'workflowmut',
      })
      try {
        await protection.check(await workflowFixture(owned.pool))
        expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
      } finally {
        await owned.drop()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('runs every check unmutated on the predecessor plus 0076', async () => {
    for (const protection of Object.values(workflowProtections)) await run(source, protection)
  }, 120_000)

  it.each(cases)(
    '%s: detects "%s"',
    async (name, mutantName) => {
      const protection = workflowProtections[name] as WorkflowProtection
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
