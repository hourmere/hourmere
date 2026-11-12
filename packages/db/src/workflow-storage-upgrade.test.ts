import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'
import { workflowMigration, workflowTables } from './workflow-storage-protections.ts'

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

// Configured reminders and follow-ups with a host note, booking snapshots of both execution
// modes, their scheduled messages in several states, sent reminder and follow-up receipts
// and the mail-budget ledger: what workflows sit beside and must leave untouched.
async function seedReminders(pool: pg.Pool) {
  await pool.query(`DO $$
  DECLARE
    settings jsonb := '{"reminders":[{"id":"two-hours","offsetMinutes":120,"recipients":{"invitee":true,"guests":false,"host":true}},{"id":"day-before","offsetMinutes":1440,"recipients":{"invitee":true,"guests":true,"host":false}}],"followUps":[{"id":"thanks","offsetMinutes":60,"recipients":{"invitee":true,"guests":true,"host":false},"hostNote":"Thank you for joining.\\nSee you soon."}]}';
    legacy jsonb := '{"reminders":[{"id":"default-24h","offsetMinutes":1440,"recipients":{"invitee":true,"guests":true,"host":true}}],"followUps":[]}';
    event_id uuid;
    organization uuid;
    host uuid;
    configured uuid;
    defaulted uuid;
    attendee uuid;
  BEGIN
    SELECT id, organization_id INTO event_id, organization FROM event_types
      WHERE slug = 'upgrade-individual-zoom';
    SELECT id INTO host FROM auth."user" ORDER BY id LIMIT 1;
    UPDATE event_types SET notifications = settings WHERE id = event_id;
    INSERT INTO bookings (organization_id, event_type_id, start_at, end_at, title, source,
      notification_snapshot, created_at, updated_at)
    VALUES (organization, event_id, '2028-05-02T09:00:00.123456Z', '2028-05-02T09:30:00.123456Z',
      'Synthetic configured reminders', 'web',
      jsonb_build_object('version', 1, 'executionMode', 'configurable', 'notifications', settings),
      '2026-10-01T08:00:00.123456Z', '2026-10-01T08:00:00.123456Z')
    RETURNING id INTO configured;
    INSERT INTO bookings (organization_id, event_type_id, start_at, end_at, title, source,
      notification_snapshot, created_at, updated_at)
    VALUES (organization, event_id, '2028-05-03T09:00:00Z', '2028-05-03T09:30:00Z',
      'Synthetic legacy default reminder', 'api',
      jsonb_build_object('version', 1, 'executionMode', 'legacy_default', 'notifications', legacy),
      '2026-10-01T08:05:00Z', '2026-10-01T08:05:00Z')
    RETURNING id INTO defaulted;
    INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
      VALUES (configured, 'Synthetic reminded invitee', 'reminded@example.test', 'Asia/Shanghai',
        'zh-CN', true)
      RETURNING id INTO attendee;
    INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
      VALUES (defaulted, 'Synthetic legacy invitee', 'legacy@example.test', 'UTC', 'en', true);
    INSERT INTO booking_scheduled_messages (organization_id, booking_id, kind, rule_id,
      anchor_start_at, anchor_end_at, due_at, expires_at, state, skip_reason, error_code,
      attempts, next_attempt_at, created_at, updated_at) VALUES
      (organization, configured, 'reminder', 'two-hours', '2028-05-02T09:00:00.123456Z',
        '2028-05-02T09:30:00.123456Z', '2028-05-02T07:00:00.123456Z', '2028-05-02T09:00:00.123456Z',
        'pending', NULL, NULL, 0, '2028-05-02T07:00:00.123456Z', '2026-10-01T08:00:00.123456Z',
        '2026-10-01T08:00:00.123456Z'),
      (organization, configured, 'reminder', 'day-before', '2028-05-02T09:00:00.123456Z',
        '2028-05-02T09:30:00.123456Z', '2028-05-01T09:00:00.123456Z', '2028-05-02T09:00:00.123456Z',
        'completed', NULL, NULL, 1, '2028-05-01T09:00:00.123456Z', '2026-10-01T08:00:00.123456Z',
        '2028-05-01T09:00:01Z'),
      (organization, configured, 'follow_up', 'thanks', '2028-05-02T09:00:00.123456Z',
        '2028-05-02T09:30:00.123456Z', '2028-05-02T10:30:00.123456Z', '2028-05-03T10:30:00.123456Z',
        'failed', NULL, 'delivery_failed', 13, '2028-05-02T17:00:00Z', '2026-10-01T08:00:00.123456Z',
        '2028-05-02T17:00:00Z'),
      (organization, defaulted, 'reminder', 'default-24h', '2028-05-03T09:00:00Z',
        '2028-05-03T09:30:00Z', '2028-05-02T09:00:00Z', '2028-05-03T09:00:00Z', 'skipped',
        'recipient_limit', NULL, 0, '2028-05-02T09:00:00Z', '2026-10-01T08:05:00Z',
        '2028-05-02T09:00:00Z');
    INSERT INTO booking_notifications (booking_id, kind, message_key, recipient, outcome, created_at)
      VALUES (configured, 'reminder', 'day-before', 'attendee:' || attendee, 'sent',
          '2028-05-01T09:00:01Z'),
        (configured, 'follow_up', 'thanks', 'host:' || host, 'rejected', '2028-05-02T10:30:01Z');
    INSERT INTO notification_email_sends (recipient_hash, sent_at)
      VALUES (sha256(convert_to('synthetic-reminded-invitee', 'UTF8')), '2028-05-01T09:00:01Z');
  END $$`)
}

describe.skipIf(!serverUrl)('workflow definition storage upgrade', () => {
  it('preserves reminders, follow-ups and booking snapshots, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-workflow-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      // Every migration before 0076: the predecessor schema, whatever lower numbers main has.
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < workflowMigration)
        .sort()
      expect(files).toContain('0074_sso_configuration.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'workflow_upgrade' })
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedReminders(upgraded.pool)

      const before = await records(upgraded.pool)
      for (const table of [
        'auth.user',
        'auth.organization',
        'public.personal_organizations',
        'public.event_types',
        'public.bookings',
        'public.booking_attendees',
        'public.booking_scheduled_messages',
        'public.booking_notifications',
        'public.notification_email_sends',
        'public.webhooks',
        'public.webhook_deliveries',
      ])
        expect(before.rows[table]?.length, table).toBeGreaterThan(0)
      const seeded = async () =>
        (
          await upgraded?.pool.query(`SELECT
          (SELECT count(*)::int FROM event_types WHERE jsonb_array_length(notifications->'followUps')>0) AS follow_up_settings,
          (SELECT count(*)::int FROM bookings WHERE notification_snapshot->>'executionMode'='configurable') AS configured,
          (SELECT count(*)::int FROM bookings WHERE notification_snapshot->>'executionMode'='legacy_default') AS legacy,
          (SELECT count(*)::int FROM bookings WHERE notification_snapshot IS NULL) AS unmarked,
          (SELECT count(DISTINCT kind)::int FROM booking_scheduled_messages) AS scheduled_kinds,
          (SELECT count(DISTINCT kind)::int FROM booking_notifications
            WHERE kind IN ('reminder','follow_up')) AS receipt_kinds`)
        )?.rows[0]
      expect(await seeded()).toEqual({
        follow_up_settings: 1,
        configured: 1,
        legacy: 1,
        unmarked: expect.any(Number),
        scheduled_kinds: 2,
        receipt_kinds: 2,
      })
      expect((await seeded())?.unmarked).toBeGreaterThan(0)
      for (const table of workflowTables) expect(before.rows[`public.${table}`]).toBeUndefined()
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows

      await copyFile(join(migrationsDir, workflowMigration), join(directory, workflowMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([workflowMigration])
      // Every predecessor row is unchanged, down to its tuple; the new tables are empty.
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [workflowMigration],
          )
        ).rows,
      ).toEqual(ledger)
      const after = await records(upgraded.pool)
      for (const table of workflowTables) expect(after.rows[`public.${table}`]).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'workflow_fresh' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(JSON.stringify(schema)).toContain('workflow_definitions_current_revision')

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
