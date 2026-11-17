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
import { updateWorkflowDefinition } from './updates.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('workflow update source-copy protections', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_update_mut' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it.each(['scope', 'revision', 'cap'] as const)(
    'kills a missing %s protection with a real assertion',
    async (protection) => {
      const source = new URL('./updates.ts', import.meta.url)
      const original = await readFile(source, 'utf8')
      const substitutions = {
        scope: [
          "if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')",
          'if (false)',
        ],
        revision: ['if (current.revision !== expectedRevision)', 'if (false)'],
        cap: ['if (count >= WORKFLOW_MAX_ENABLED_PER_EVENT)', 'if (false)'],
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
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-update-mutation-'))
      try {
        const copy = pathToFileURL(join(directory, 'mutation.mjs'))
        await writeFile(copy, executable, { mode: 0o600 })
        const mutated = (await import(/* @vite-ignore */ copy.href))
          .updateWorkflowDefinition as typeof updateWorkflowDefinition
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
        if (protection === 'cap')
          for (let i = 0; i < 5; i++)
            await createWorkflowDefinition(ctx, {
              ...input,
              idempotencyKey: randomUUID(),
              enabled: true,
            })
        const assertRefused = async (operation: typeof updateWorkflowDefinition) => {
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
                { expectedRevision: 1, enabled: true },
              ),
            ).rejects.toMatchObject({ error: 'insufficient_scope' })
          } else if (protection === 'revision') {
            await expect(
              operation(ctx, first.id, { expectedRevision: 99, name: 'Stale' }),
            ).rejects.toMatchObject({ code: 'workflow_revision_conflict' })
          } else {
            await expect(
              operation(ctx, first.id, { expectedRevision: 1, enabled: true }),
            ).rejects.toMatchObject({ code: 'workflow_limit_reached' })
          }
        }
        await assertRefused(updateWorkflowDefinition)
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
