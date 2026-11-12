import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { operationsMigration, operationsTable } from './routing-storage-operations-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

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

// Routing configuration as the services of the predecessor leave it: an enabled form with its
// published version, dependency and receipts (one live with encrypted answers, one consumed
// by a booking with its routing snapshot), and an archived form with two versions.
async function seedRouting(pool: pg.Pool) {
  await pool.query(`DO $$
  DECLARE
    team uuid;
    author uuid;
    event_id uuid;
    booking_id uuid;
    live_form uuid;
    live_version uuid;
    archived_form uuid;
    archived_version uuid;
    question text := '0190d1a2-0000-7000-8000-000000000001';
    rule text := '0190d1a2-0000-7000-8000-000000000002';
  BEGIN
    SELECT id INTO team FROM auth.organization WHERE slug = 'upgrade-team';
    SELECT "userId" INTO author FROM auth.member WHERE "organizationId" = team AND role = 'owner';
    SELECT id INTO event_id FROM event_types WHERE slug = 'upgrade-event-2';
    SELECT id INTO booking_id FROM bookings WHERE organization_id = team ORDER BY id LIMIT 1;
    INSERT INTO routing_forms (organization_id, slug, created_by_user_id, draft, created_at, updated_at)
      VALUES (team, 'qualification', author, jsonb_build_object('title', 'Qualification 東京',
        'description', E'Two questions\\nthen a team call', 'questions', jsonb_build_array(
          jsonb_build_object('id', question, 'type', 'short_text', 'label', 'Company', 'required', true)),
        'rules', jsonb_build_array(), 'fallback', jsonb_build_object('kind', 'event', 'eventTypeId', event_id)),
        '2026-11-01T08:00:00.123456Z', '2026-11-01T08:00:00.123456Z')
      RETURNING id INTO live_form;
    INSERT INTO routing_form_versions (organization_id, form_id, version_number, questions, rules,
        fallback, published_at, published_by_user_id)
      VALUES (team, live_form, 1, jsonb_build_array(jsonb_build_object('id', question,
        'type', 'short_text', 'label', 'Company', 'required', true)),
        jsonb_build_array(jsonb_build_object('id', rule, 'conditions', jsonb_build_array(
          jsonb_build_object('questionId', question, 'operator', 'equals', 'value', 'Acme')),
          'target', jsonb_build_object('kind', 'message', 'message', 'Thanks, Acme'))),
        jsonb_build_object('kind', 'event', 'eventTypeId', event_id),
        '2026-11-01T09:00:00.123456Z', author)
      RETURNING id INTO live_version;
    UPDATE routing_forms SET published_version_id = live_version, enabled = true, draft_revision = 3
      WHERE id = live_form;
    INSERT INTO routing_target_dependencies (organization_id, version_id, rule_id, event_type_id,
        health_code, health_checked_at)
      VALUES (team, live_version, 'fallback', event_id, 'ok', '2026-11-01T09:00:00.123456Z');
    INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
        answers_ciphertext, matched_rule_id, resolved_rule_id, resolved_target, created_at, expires_at)
      VALUES (team, live_form, live_version, repeat('a', 64), '\\x73796e746865746963'::bytea,
        'fallback', 'fallback', jsonb_build_object('kind', 'event', 'eventTypeId', event_id),
        '2026-11-01T10:00:00Z', '2099-01-01T00:00:00Z');
    INSERT INTO routing_receipts (organization_id, form_id, version_id, token_hash,
        answers_ciphertext, matched_rule_id, resolved_rule_id, resolved_target, created_at,
        expires_at, consumed_booking_id)
      VALUES (team, live_form, live_version, repeat('b', 64), NULL, rule, 'fallback',
        jsonb_build_object('kind', 'event', 'eventTypeId', event_id), '2026-11-01T10:05:00Z',
        '2026-11-01T10:35:00Z', booking_id);
    INSERT INTO booking_routing (booking_id, organization_id, form_id, version_id, version_number,
        matched_rule_id, resolved_rule_id, questions, answers)
      VALUES (booking_id, team, live_form, live_version, 1, rule, 'fallback',
        jsonb_build_array(jsonb_build_object('id', question, 'label', 'Company')),
        jsonb_build_object(question, 'Acme'));
    INSERT INTO routing_forms (organization_id, slug, created_by_user_id, draft)
      VALUES (team, 'retired', author, jsonb_build_object('title', 'Retired', 'questions',
        jsonb_build_array(), 'rules', jsonb_build_array(), 'fallback',
        jsonb_build_object('kind', 'message', 'message', 'Closed')))
      RETURNING id INTO archived_form;
    INSERT INTO routing_form_versions (organization_id, form_id, version_number, questions, rules,
        fallback, published_by_user_id)
      VALUES (team, archived_form, 1, '[]', '[]', '{"kind":"message","message":"Open"}', author);
    INSERT INTO routing_form_versions (organization_id, form_id, version_number, questions, rules,
        fallback, published_by_user_id)
      VALUES (team, archived_form, 2, '[]', '[]', '{"kind":"message","message":"Closed"}', author)
      RETURNING id INTO archived_version;
    UPDATE routing_forms SET published_version_id = archived_version, draft_revision = 5,
        archived_at = '2026-11-02T08:00:00Z' WHERE id = archived_form;
  END $$`)
}

describe.skipIf(!serverUrl)('routing form operation storage upgrade', () => {
  it('preserves routing configuration and every other row, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-routing-operations-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-routing-operations-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      // Every migration before 0083: the predecessor schema, whatever lower numbers main has.
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < operationsMigration)
        .sort()
      expect(files).toContain('0072_routing_forms.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'routing_op_up' })
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedRouting(upgraded.pool)

      const before = await records(upgraded.pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'auth.member',
        'auth.apikey',
        'public.event_types',
        'public.bookings',
        'public.routing_forms',
        'public.routing_form_versions',
        'public.routing_target_dependencies',
        'public.routing_receipts',
        'public.booking_routing',
      ])
        expect(before.rows[table]?.length, table).toBeGreaterThan(0)
      expect(before.rows['public.routing_forms']).toHaveLength(2)
      expect(before.rows['public.routing_form_versions']).toHaveLength(3)
      expect(before.rows[`public.${operationsTable}`]).toBeUndefined()
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows

      await copyFile(join(migrationsDir, operationsMigration), join(directory, operationsMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([operationsMigration])
      // Every predecessor row is unchanged, down to its tuple; the new table is empty.
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [operationsMigration],
          )
        ).rows,
      ).toEqual(ledger)
      const after = await records(upgraded.pool)
      expect(after.rows[`public.${operationsTable}`]).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'routing_op_fresh' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(JSON.stringify(schema)).toContain(`${operationsTable}_request_key`)

      const ledgerBefore = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
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
  }, 120_000)
})
