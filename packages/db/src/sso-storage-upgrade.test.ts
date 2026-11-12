import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { copySsoPredecessor, quote, ssoMigration, ssoTables } from './sso-storage-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL

// Every row of every table, with its tuple identity: a rewrite or an in-place update of
// an existing row changes xmin or ctid even when the values stay the same.
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

// Teams, roles (including Better Auth's comma-separated form), a personal organization,
// an invitation, a SCIM credential, member-role history and a routing form: the data SSO
// configuration will sit next to.
async function seedTeams(pool: pg.Pool) {
  await pool.query(`
    WITH people AS (
      INSERT INTO auth."user" (name,email,"emailVerified")
      SELECT 'Synthetic SSO upgrade person ' || n, 'sso-upgrade-' || n || '@example.test', true
      FROM generate_series(1,4) n RETURNING id, email
    ), teams AS (
      INSERT INTO auth.organization (name,slug,"createdAt",metadata)
      VALUES ('Synthetic Acme','synthetic-acme','2026-10-01T09:00:00.123456Z','{"plan":"team"}'),
        ('Synthetic Globex','synthetic-globex','2026-10-02T09:00:00Z',NULL)
      RETURNING id, slug
    ), roles(email, slug, role) AS (VALUES
      ('sso-upgrade-1@example.test','synthetic-acme','owner'),
      ('sso-upgrade-2@example.test','synthetic-acme','admin, owner'),
      ('sso-upgrade-3@example.test','synthetic-acme','member'),
      ('sso-upgrade-4@example.test','synthetic-globex','owner'))
    INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      SELECT t.id, p.id, r.role, '2026-10-03T10:00:00Z' FROM roles r
      JOIN people p ON p.email = r.email JOIN teams t ON t.slug = r.slug;
    WITH person AS (
      INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Synthetic SSO personal user','sso-upgrade-personal@example.test',true) RETURNING id
    ), personal AS (
      INSERT INTO auth.organization (name,slug,"createdAt")
      VALUES ('Synthetic personal','synthetic-sso-personal',now()) RETURNING id
    ), marker AS (
      INSERT INTO personal_organizations (user_id,organization_id)
      SELECT person.id, personal.id FROM person, personal RETURNING organization_id
    )
    INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      SELECT personal.id, person.id, 'owner', now() FROM person, personal;
    INSERT INTO auth.invitation ("organizationId",email,role,status,"expiresAt","inviterId","createdAt")
      SELECT o.id,'sso-upgrade-invitee@example.test','member','pending','2030-01-01T00:00Z',u.id,now()
      FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-acme' AND u.email='sso-upgrade-1@example.test';
    INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash,created_by_user_id)
      SELECT o.id,'Synthetic IdP provisioning',repeat('s',43),u.id
      FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-acme' AND u.email='sso-upgrade-1@example.test';
    INSERT INTO organization_operations
      (organization_id,operation,actor_user_id,target_user_id,previous_role,new_role,source)
      SELECT o.id,'member_role_changed',a.id,b.id,'admin','admin, owner','web'
      FROM auth.organization o, auth."user" a, auth."user" b
      WHERE o.slug='synthetic-acme' AND a.email='sso-upgrade-1@example.test'
        AND b.email='sso-upgrade-2@example.test';
    INSERT INTO routing_forms (organization_id,slug,created_by_user_id,draft)
      SELECT o.id,'synthetic-intake',u.id,'{"title":"Synthetic intake"}'
      FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-acme' AND u.email='sso-upgrade-1@example.test';`)
}

describe.skipIf(!serverUrl)('SSO configuration storage upgrade', () => {
  it('preserves a populated predecessor, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-sso-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = await copySsoPredecessor(directory)
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'sso_upgrade' })
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedTeams(upgraded.pool)
      const before = await records(upgraded.pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'auth.member',
        'auth.invitation',
        'auth.session',
        'auth.apikey',
        'public.personal_organizations',
        'public.scim_provisioning_tokens',
        'public.organization_operations',
        'public.routing_forms',
        'public.bookings',
        'public.event_types',
      ])
        expect(before.rows[table]?.length, table).toBeGreaterThan(0)
      for (const table of ssoTables) expect(before.rows[`public.${table}`]).toBeUndefined()
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows

      await copyFile(join(migrationsDir, ssoMigration), join(directory, ssoMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([ssoMigration])
      // Every predecessor row is unchanged, down to its tuple; the new tables are empty.
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [ssoMigration],
          )
        ).rows,
      ).toEqual(ledger)
      const after = await records(upgraded.pool)
      for (const table of ssoTables) expect(after.rows[`public.${table}`]).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_fresh' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(JSON.stringify(schema)).toContain('sso_domains_active_name')

      const ledgerBefore = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await records(upgraded.pool)).toEqual(after)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(ledgerBefore)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(2)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(2)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
      await rm(early, { recursive: true, force: true })
    }
  }, 60_000)
})
