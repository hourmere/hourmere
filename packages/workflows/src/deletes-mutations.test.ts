import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkflowDefinition } from './creates.ts'
import { deleteWorkflowDefinition } from './deletes.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('workflow delete source-copy protections', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_delete_mut' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it.each(['scope', 'revision', 'retirement'] as const)(
    'kills a missing %s protection with a real assertion',
    async (protection) => {
      const source = new URL('./deletes.ts', import.meta.url)
      const original = await readFile(source, 'utf8')
      const substitutions = {
        scope: [
          "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')",
          'if (false)',
        ],
        revision: ['if (current.revision !== parsed.data.expectedRevision)', 'if (false)'],
        retirement: [".where('state', '=', 'pending')", ".where('state', '=', 'claimed')"],
      } as const
      const [before, after] = substitutions[protection]
      expect(original).toContain(before)
      const executable = stripTypeScriptTypes(original.replace(before, after)).replace(
        /from '([^']+)'/g,
        (_, specifier: string) => {
          if (specifier.startsWith('node:')) return `from '${specifier}'`
          const resolved = specifier.startsWith('.')
            ? new URL(specifier, source).href
            : pathToFileURL(createRequire(source).resolve(specifier)).href
          return `from '${resolved}'`
        },
      )
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-delete-mutation-'))
      try {
        const copy = pathToFileURL(join(directory, 'mutation.mjs'))
        await writeFile(copy, executable, { mode: 0o600 })
        const mutated = (await import(/* @vite-ignore */ copy.href))
          .deleteWorkflowDefinition as typeof deleteWorkflowDefinition
        const user = await createTestUser(db),
          ctx = { db, principal: user.principal }
        const input = {
          owner: { kind: 'personal', id: user.id },
          name: 'Prepare',
          scope: { type: 'all_event_types' },
          trigger: { type: 'booking.created' },
          actions: [{ type: 'email', recipients: ['booker'] }],
        }
        const first = await createWorkflowDefinition(ctx, {
          ...input,
          idempotencyKey: randomUUID(),
        })
        let runId: string | undefined
        if (protection === 'retirement') {
          const org = user.principal.organization.id
          const booking = await db
            .insertInto('bookings')
            .values({
              organization_id: org,
              start_at: new Date('2030-01-01T12:00Z'),
              end_at: new Date('2030-01-01T12:30Z'),
              title: 'Call',
              source: 'web',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          const enrollment = await db
            .insertInto('workflow_enrollments')
            .values({
              organization_id: org,
              workflow_id: first.id,
              revision: 1,
              booking_id: booking.id,
              occurrence: 'created',
              trigger: 'booking.created',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          const run = await db
            .insertInto('workflow_runs')
            .values({
              organization_id: org,
              enrollment_id: enrollment.id,
              booking_id: booking.id,
              due_at: new Date('2030-01-01T11:30Z'),
              expires_at: new Date('2030-01-01T12:00Z'),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          runId = run.id
        }
        const assertRefused = async (operation: typeof deleteWorkflowDefinition) => {
          if (protection === 'scope') {
            await expect(
              operation(
                {
                  ...ctx,
                  principal: {
                    ...ctx.principal,
                    kind: 'api_key',
                    apiKeyId: randomUUID(),
                    apiKeyScope: 'read',
                  },
                },
                first.id,
                { expectedRevision: 1 },
              ),
            ).rejects.toMatchObject({ error: 'insufficient_scope' })
          } else if (protection === 'revision') {
            await expect(operation(ctx, first.id, { expectedRevision: 99 })).rejects.toMatchObject({
              code: 'workflow_revision_conflict',
            })
          } else {
            // Roll the assertion transaction back so both implementations see identical fixtures.
            await operation(
              {
                ...ctx,
                audit: {
                  record: async (auditTrx) => {
                    const run = await auditTrx
                      .selectFrom('workflow_runs')
                      .select('state')
                      .where('id', '=', runId as string)
                      .executeTakeFirstOrThrow()
                    expect(run.state).toBe('retired')
                    throw new Error('rollback successful assertion')
                  },
                },
              },
              first.id,
              { expectedRevision: 1 },
            ).catch((error) => {
              if (error instanceof Error && error.message === 'rollback successful assertion')
                return
              throw error
            })
          }
        }
        await assertRefused(deleteWorkflowDefinition)
        let failed = false
        try {
          await assertRefused(mutated)
        } catch (error) {
          if (error instanceof Error && error.name === 'AssertionError') failed = true
          else throw error
        }
        expect(failed).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
