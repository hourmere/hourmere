import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { copyRoutingPredecessor, quote, routingMigration } from './routing-storage-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
async function records(pool: pg.Pool, tables?: { schema: string; name: string }[]) {
  const names =
    tables ??
    (
      await pool.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
      AND table_name <> 'schema_migrations' ORDER BY table_schema,table_name`)
    ).rows
  const rows: Record<string, unknown[]> = {}
  for (const table of names)
    rows[`${table.schema}.${table.name}`] = (
      await pool.query(`SELECT to_jsonb(t)::text AS value,xmin::text,ctid::text
      FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
    ).rows
  return { names, rows }
}

describe.skipIf(!serverUrl)('routing storage upgrade', () => {
  it('preserves a populated predecessor, matches fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-routing-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-routing-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = await copyRoutingPredecessor(directory)
      expect(files.some((file) => file.startsWith('0071'))).toBe(false)
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early)
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await upgraded.pool.query(`
        INSERT INTO scim_provisioning_tokens
          (organization_id,name,token_hash,previous_token_hash,previous_valid_until,
           created_by_user_id,rotated_by_user_id,rotated_at,last_used_at)
          SELECT o.id,'Synthetic rotated provisioning credential',repeat('x',43),repeat('y',43),
            '2030-01-01T00:00Z',u.id,u.id,'2026-11-01T00:00Z','2026-11-02T00:00Z'
          FROM auth.organization o CROSS JOIN auth."user" u ORDER BY o.id,u.id LIMIT 1;
        UPDATE event_types SET allowed_durations_minutes=ARRAY[15,duration_minutes,60],
          success_redirect='{"url":"https://example.test/thank-you","parameters":[],"includeInviteePersonalData":false,"allowEmbedParent":false}'
          WHERE duration_minutes NOT IN (15,60);
        UPDATE booking_attendees SET no_show_marked_at='2026-11-01T00:00:00.123456Z',
          no_show_marked_by=(SELECT id FROM auth."user" ORDER BY id LIMIT 1)
          WHERE is_booker AND booking_id IN (SELECT id FROM bookings WHERE status='confirmed');
        INSERT INTO one_time_booking_links (organization_id,event_type_id,creator_user_id,token_hash)
          SELECT e.organization_id,e.id,u.id,repeat('e',64)
          FROM event_types e CROSS JOIN auth."user" u WHERE e.deleted_at IS NULL
          ORDER BY e.id,u.id LIMIT 1;`)
      const before = await records(upgraded.pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'auth.member',
        'auth.apikey',
        'bookings',
        'booking_attendees',
        'event_types',
        'one_time_booking_links',
        'webhooks',
        'calendar_connections',
        'scim_provisioning_tokens',
      ]) {
        const name = table.includes('.') ? table : `public.${table}`
        expect(before.rows[name]?.length, name).toBeGreaterThan(0)
      }
      const oldLedger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows
      await copyFile(join(migrationsDir, routingMigration), join(directory, routingMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([routingMigration])
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [routingMigration],
          )
        ).rows,
      ).toEqual(oldLedger)
      fresh = await createTestDatabase(serverUrl as string, directory)
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      const allBefore = await records(upgraded.pool)
      const ledgerBefore = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await records(upgraded.pool)).toEqual(allBefore)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(ledgerBefore)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
      await rm(early, { recursive: true, force: true })
    }
  }, 60_000)
})
