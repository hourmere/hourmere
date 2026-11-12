import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  copyIdentityPredecessor,
  identityMigration,
  identityTables,
} from './sso-identity-fixtures.ts'
import { quote, sealed } from './sso-storage-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL

// Every row of every table, with its tuple identity: a rewrite or an in-place update of an
// existing row changes xmin or ctid even when the values stay the same.
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

// What identity storage will sit next to: teams with every role, a personal organization, an
// invitation, sessions, an API key bound to a team and an MCP OAuth grant, SCIM credentials
// and admission tombstones, and the SSO configuration of 0074 (an enforced policy, a live and
// a retired provider, a verified and a pending claim, provider domains, a recovery owner and a
// nomination).
async function seedTeams(pool: pg.Pool) {
  await pool.query(`
    WITH people AS (
      INSERT INTO auth."user" (name,email,"emailVerified")
      SELECT 'Synthetic SSO identity person ' || n, 'sso-identity-' || n || '@example.test', true
      FROM generate_series(1,4) n RETURNING id, email
    ), teams AS (
      INSERT INTO auth.organization (name,slug,"createdAt",metadata)
      VALUES ('Synthetic Initech','synthetic-initech','2026-10-01T09:00:00.123456Z','{"plan":"team"}'),
        ('Synthetic Umbrella','synthetic-umbrella','2026-10-02T09:00:00Z',NULL)
      RETURNING id, slug
    ), roles(email, slug, role) AS (VALUES
      ('sso-identity-1@example.test','synthetic-initech','owner'),
      ('sso-identity-2@example.test','synthetic-initech','admin, owner'),
      ('sso-identity-3@example.test','synthetic-initech','member'),
      ('sso-identity-4@example.test','synthetic-umbrella','owner'))
    INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      SELECT t.id, p.id, r.role, '2026-10-03T10:00:00Z' FROM roles r
      JOIN people p ON p.email = r.email JOIN teams t ON t.slug = r.slug;
    WITH person AS (
      INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Synthetic SSO identity personal user','sso-identity-personal@example.test',true) RETURNING id
    ), personal AS (
      INSERT INTO auth.organization (name,slug,"createdAt")
      VALUES ('Synthetic personal','synthetic-sso-identity-personal',now()) RETURNING id
    ), marker AS (
      INSERT INTO personal_organizations (user_id,organization_id)
      SELECT person.id, personal.id FROM person, personal RETURNING organization_id
    )
    INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      SELECT personal.id, person.id, 'owner', now() FROM person, personal;
    INSERT INTO auth.invitation ("organizationId",email,role,status,"expiresAt","inviterId","createdAt")
      SELECT o.id,'sso-identity-invitee@example.test','member','pending','2030-01-01T00:00Z',u.id,now()
      FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-initech' AND u.email='sso-identity-1@example.test';
    INSERT INTO auth.session ("expiresAt",token,"updatedAt","userId","activeOrganizationId")
      SELECT '2030-01-01T00:00Z', 'synthetic-session-' || u.email, now(), u.id, o.id::text
      FROM auth."user" u, auth.organization o
      WHERE u.email LIKE 'sso-identity-_@example.test' AND o.slug='synthetic-initech';
    INSERT INTO auth.apikey ("configId","referenceId",key,"createdAt","updatedAt",metadata)
      SELECT 'default', u.id::text, repeat('k',64), now(), now(),
        json_build_object('scope','read','organizationId',o.id)::text
      FROM auth."user" u, auth.organization o
      WHERE u.email='sso-identity-3@example.test' AND o.slug='synthetic-initech';
    INSERT INTO mcp_oauth_grants (user_id,organization_id,client_id)
      SELECT u.id, o.id, 'synthetic-mcp-client' FROM auth."user" u, auth.organization o
      WHERE u.email='sso-identity-3@example.test' AND o.slug='synthetic-initech';
    INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash,created_by_user_id)
      SELECT o.id,'Synthetic IdP provisioning',repeat('t',43),u.id
      FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-initech' AND u.email='sso-identity-1@example.test';
    INSERT INTO scim_membership_blocks (organization_id,user_id,identity_email,source,kind)
      SELECT o.id, u.id, u.email, 'local', 'removal' FROM auth.organization o, auth."user" u
      WHERE o.slug='synthetic-initech' AND u.email='sso-identity-4@example.test';
    INSERT INTO sso_policies (organization_id,require_sso,admission,policy_revision,trust_generation)
      SELECT id, true, 'jit', 4, 3 FROM auth.organization WHERE slug='synthetic-initech';`)
  const team = (
    await pool.query<{ id: string }>(
      "SELECT id FROM auth.organization WHERE slug='synthetic-initech'",
    )
  ).rows[0]?.id
  const providers = []
  for (const [protocol, clientId, retired] of [
    ['oidc', 'synthetic-client', false],
    ['saml', null, true],
  ] as const)
    providers.push(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sso_providers
            (organization_id,protocol,display_name,issuer,client_id,configuration,revision,enabled,retired_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            team,
            protocol,
            `Synthetic ${protocol.toUpperCase()}`,
            `https://idp.example.test/${protocol}`,
            clientId,
            sealed(),
            retired ? 1 : 2,
            !retired,
            retired ? '2026-10-20T00:00Z' : null,
          ],
        )
      ).rows[0]?.id,
    )
  const domains = []
  for (const [name, verified] of [
    ['synthetic-initech.example', true],
    ['initech-pending.example', false],
  ] as const)
    domains.push(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sso_domains (organization_id,name,challenge_digest,challenge_expires_at,
            claimed_at,verified_at,verification_expires_at,last_checked_at,last_check_outcome,next_check_at)
          VALUES ($1,$2,repeat('c',64),now() + interval '1 day',$3,$3,$4,$5,$6,$7) RETURNING id`,
          verified
            ? [
                team,
                name,
                new Date(Date.now() - 86_400_000).toISOString(),
                new Date(Date.now() + 6 * 86_400_000).toISOString(),
                new Date().toISOString(),
                'positive',
                new Date(Date.now() + 86_400_000).toISOString(),
              ]
            : [team, name, null, null, null, null, null],
        )
      ).rows[0]?.id,
    )
  await pool.query(
    `INSERT INTO sso_provider_domains (organization_id,provider_id,domain_id) VALUES ($1,$2,$3),($1,$2,$4)`,
    [team, providers[0], domains[0], domains[1]],
  )
  await pool.query(`
    INSERT INTO sso_recovery_owners (organization_id,user_id,member_id,nominated_by_user_id)
      SELECT m."organizationId", m."userId", m.id, m."userId" FROM auth.member m
      JOIN auth."user" u ON u.id = m."userId" WHERE u.email='sso-identity-1@example.test';
    INSERT INTO sso_recovery_nominations (organization_id,member_id,user_id,nominated_by_user_id,expires_at)
      SELECT m."organizationId", m.id, m."userId", o."userId", now() + interval '3 days'
      FROM auth.member m JOIN auth."user" u ON u.id = m."userId"
      JOIN auth.member o ON o."organizationId" = m."organizationId" AND o.role = 'owner'
      WHERE u.email='sso-identity-2@example.test';`)
}

describe.skipIf(!serverUrl)('SSO identity storage upgrade', () => {
  it('preserves a populated predecessor, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-identity-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-sso-identity-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = await copyIdentityPredecessor(directory)
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'sso_id_upgrade' })
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
        'public.mcp_oauth_grants',
        'public.scim_provisioning_tokens',
        'public.scim_membership_blocks',
        'public.sso_policies',
        'public.sso_providers',
        'public.sso_domains',
        'public.sso_provider_domains',
        'public.sso_recovery_owners',
        'public.sso_recovery_nominations',
        'public.bookings',
        'public.event_types',
      ])
        expect(before.rows[table]?.length, table).toBeGreaterThan(0)
      expect(before.rows['public.sso_providers']).toHaveLength(2)
      expect(before.rows['public.sso_domains']).toHaveLength(2)
      for (const table of identityTables) expect(before.rows[`public.${table}`]).toBeUndefined()
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows

      await copyFile(join(migrationsDir, identityMigration), join(directory, identityMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([identityMigration])
      // Every predecessor row, the SSO configuration included, is unchanged down to its tuple;
      // the new tables are empty.
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [identityMigration],
          )
        ).rows,
      ).toEqual(ledger)
      const after = await records(upgraded.pool)
      for (const table of identityTables) expect(after.rows[`public.${table}`]).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'sso_id_fresh' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(JSON.stringify(schema)).toContain('sso_identity_links_live_identity')

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
