import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuditEvent } from './audit.ts'
import { createDb, type Db } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('audit source-copy mutations', () => {
  let owned: TestDatabase
  let db: Db
  let directory: string
  let source: string
  let sequence = 0
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    directory = await mkdtemp(join(tmpdir(), 'hourmere-audit-source-'))
    source = await readFile(new URL('./audit.ts', import.meta.url), 'utf8')
    // Resolve runtime dependency from the original workspace when copying the module.
    source = source.replace(
      "from 'kysely'",
      `from '${pathToFileURL(join(process.cwd(), 'node_modules/kysely/dist/index.js')).href}'`,
    )
  })
  afterAll(async () => {
    await owned?.drop()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  const event: AuditEvent = {
    organizationId: null,
    actor: { type: 'system', id: 'test' },
    credential: { type: 'none' },
    action: 'booking.created',
    targetType: 'booking',
    targetId: 'synthetic',
  }
  async function load(text: string): Promise<typeof import('./audit.ts')> {
    const file = join(directory, `audit-${sequence++}.ts`)
    await writeFile(file, text)
    return import(/* @vite-ignore */ pathToFileURL(file).href)
  }
  it('detects a removed INSERT and passes restored source', async () => {
    const assertion = async (text: string) => {
      const module = await load(text)
      const before = await db.selectFrom('audit_events').select('id').execute()
      await db.transaction().execute((trx) => module.writeAuditEvent(trx, event))
      expect((await db.selectFrom('audit_events').select('id').execute()).length).toBe(
        before.length + 1,
      )
    }
    await assertion(source)
    await expect(
      assertion(
        source.replace(
          '  await sql`INSERT INTO audit_events',
          '  return; await sql`INSERT INTO audit_events',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertion(source)
  })
  it('detects widened detail allow-list and passes restored source', async () => {
    const assertion = async (text: string) => {
      const module = await load(text)
      await expect(
        db
          .transaction()
          .execute((trx) =>
            module.writeAuditEvent(trx, { ...event, details: { email: 'private' } }),
          ),
      ).rejects.toThrow('allow-listed')
    }
    await assertion(source)
    await expect(
      assertion(source.replace("'booking.created': []", "'booking.created': ['email']")),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertion(source)
  })
  it('detects widened action-specific detail lists and passes restored source', async () => {
    for (const action of [
      'membership.role_changed',
      'api_key.created',
      'api_key.rotated',
      'webhook.created',
      'webhook.updated',
      'webhook.deleted',
      'webhook.secret_rotated',
      'webhook.paused',
      'webhook.resumed',
      'oauth.token_revoked',
    ] as const) {
      const assertion = async (text: string) => {
        const module = await load(text)
        await expect(
          db.transaction().execute((trx) =>
            module.writeAuditEvent(trx, {
              ...event,
              action,
              details: { secret: 'private' },
            }),
          ),
        ).rejects.toThrow('allow-listed')
      }
      await assertion(source)
      const mutated = source.replace(`'${action}': [`, `'${action}': ['secret', `)
      expect(mutated).not.toBe(source)
      await expect(assertion(mutated)).rejects.toMatchObject({ name: 'AssertionError' })
      await assertion(source)
    }
  })
  it('detects removed request context propagation and passes restored source', async () => {
    const assertion = async (text: string) => {
      const module = await load(text)
      await module.withAuditRequest('test-request', () =>
        db.transaction().execute((trx) => module.writeAuditEvent(trx, event)),
      )
      const row = await db
        .selectFrom('audit_events')
        .select('request_id')
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow()
      expect(row.request_id).toBe('test-request')
    }
    await assertion(source)
    await expect(
      assertion(
        source.replace(
          'event.requestId ?? requestContext.getStore() ?? null',
          'event.requestId ?? null',
        ),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await assertion(source)
  })
})
