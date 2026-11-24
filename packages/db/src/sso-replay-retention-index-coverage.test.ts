import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { seeded } from './sso-identity-fixtures.ts'
import { at, digest, insert, samlProviderValues, ssoFixture } from './sso-storage-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0185_sso_replay_retention_index.sql'
const index = 'sso_replay_cache_retain_until_idx'

async function assertRetentionIndex(pool: pg.Pool) {
  await expect(
    pool.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index
       WHERE indexrelid = to_regclass($1) AND indisready AND indisvalid`,
      [`public.${index}`],
    ),
  ).resolves.toMatchObject({
    rows: [
      { definition: `CREATE INDEX ${index} ON public.sso_replay_cache USING btree (retain_until)` },
    ],
  })
}

async function seedReplayRows(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { team } = await ssoFixture(client)
    const provider = await insert(client, 'sso_providers', samlProviderValues(team))
    for (const kind of ['saml_request', 'saml_assertion', 'saml_response']) {
      const key = { organization_id: team, provider_id: provider.id, kind }
      await insert(client, 'sso_replay_cache', {
        ...key,
        key_digest: digest(),
        retain_until: at(360),
      })
      // Model a previously consumed ID that aged past retention before upgrade.
      await seeded(client, 'sso_replay_cache', {
        ...key,
        key_digest: digest(),
        consumed_at: at(-720),
        retain_until: at(-360),
      })
    }
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

async function replayRows(pool: pg.Pool) {
  return (
    await pool.query(`SELECT to_jsonb(entry)::text AS value, xmin::text, ctid::text
      FROM sso_replay_cache entry ORDER BY provider_id, kind, key_digest`)
  ).rows
}

describe.skipIf(!serverUrl)('SSO replay retention index', () => {
  it('fails the retention index assertion when the index is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertRetentionIndex,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`index public.sso_replay_cache.${index}`, 'covered'],
    ])
  })

  it('preserves live and expired cache rows, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-replay-index-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(directory, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_replay_up' })
      await seedReplayRows(upgraded.pool)
      const before = await replayRows(upgraded.pool)
      expect(before).toHaveLength(6)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_replay_new' })
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await replayRows(upgraded.pool)).toEqual(before)
      await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await replayRows(upgraded.pool)).toEqual(before)
    } finally {
      await Promise.all([
        upgraded?.drop(),
        fresh?.drop(),
        rm(directory, { recursive: true, force: true }),
      ])
    }
  })
})
