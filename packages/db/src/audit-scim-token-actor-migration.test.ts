import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertScimTokenActorProtections } from './audit-scim-token-actor-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0082_audit_scim_token_actor.sql'

/** One journal row per earlier actor and credential shape, as the previous version writes them. */
const journal: [string, string | null, string, Record<string, string | null>][] = [
  ['user', randomUUID(), 'session', { credential_id: randomUUID() }],
  ['api_key', randomUUID(), 'api_key', { credential_id: randomUUID(), credential_scope: 'full' }],
  ['user', randomUUID(), 'oauth', { oauth_client_id: 'client', oauth_grant_id: randomUUID() }],
  ['oauth_client', 'client', 'oauth', { oauth_client_id: 'client', oauth_grant_id: randomUUID() }],
  ['system', 'webhook-delivery', 'none', {}],
  ['anonymous', null, 'none', {}],
  ['external_api_key', null, 'none', {}],
  ['external_oauth_client', null, 'none', {}],
  ['external_user', null, 'none', {}],
]

describe.skipIf(!serverUrl)('SCIM provisioning token actor migration', () => {
  it('keeps a populated journal, equals a fresh install, reruns as a no-op and admits the token actor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-audit-scim-actor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file < '0013'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(upgraded.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      const pool = upgraded.pool
      const organization = (
        await pool.query<{ id: string }>('SELECT id FROM auth.organization ORDER BY id LIMIT 1')
      ).rows[0]?.id
      expect(organization).toBeTruthy()
      for (const [actorType, actorId, credentialType, credential] of journal)
        await pool.query(
          `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
             credential_id, credential_scope, oauth_client_id, oauth_grant_id,
             action, target_type, target_id, request_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'booking.created', 'booking', $9, $10)`,
          [
            organization,
            actorType,
            actorId,
            credentialType,
            credential.credential_id ?? null,
            credential.credential_scope ?? null,
            credential.oauth_client_id ?? null,
            credential.oauth_grant_id ?? null,
            randomUUID(),
            randomUUID(),
          ],
        )
      // The predecessor refuses the provisioning token actor.
      await expect(
        pool.query(
          `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id)
           VALUES ('scim_token', $1, 'none', 'scim_user.created', 'scim_user', $2)`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'audit_events_actor_type_check' })
      const tables = (
        await pool.query<{ schema: string; name: string }>(
          `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
           WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE'
             AND table_name <> 'schema_migrations' ORDER BY 1,2`,
        )
      ).rows
      const records = async () => {
        const result: unknown[] = []
        for (const table of tables)
          result.push(
            (
              await pool.query(
                `SELECT to_jsonb(t)::text, xmin::text, ctid::text FROM "${table.schema}"."${table.name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
              )
            ).rows,
          )
        return result
      }
      const before = await records()
      expect((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(
        journal.length,
      )
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM booking_attendees')).rows[0].n,
      ).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records()).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records()).toEqual(before)
      // Every earlier actor type still holds, and the token actor needs credential none.
      await assertScimTokenActorProtections(pool)
      await assertScimTokenActorProtections(fresh.pool)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
