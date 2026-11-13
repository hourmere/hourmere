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
import { executionMigration, executionTables } from './workflow-storage-execution-protections.ts'
import { revisionContent } from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

// Every row of every table, with its tuple identity: a rewrite or an in-place update of an
// existing row changes xmin or ctid even when the values stay the same. The ledger's new column
// is left out of the value here and checked on its own: every existing row keeps it NULL.
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
      await pool.query(`SELECT value,xmin::text,ctid::text FROM (
        SELECT (to_jsonb(t) - 'workflow_reservation_id')::text AS value,xmin,ctid
        FROM ${quote(table.schema)}.${quote(table.name)} t) r ORDER BY value COLLATE "C"`)
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

// Workflow definitions of 0076 with their revisions: a team workflow at revision 2, a personal
// one and a tombstone; and the shared ledger with booking, sign-in and host rows of every age.
async function seedWorkflowsAndLedger(pool: pg.Pool) {
  const { rows } = await pool.query<{ organization: string; user: string }>(
    `SELECT organization_id AS organization,user_id AS user FROM personal_organizations
    ORDER BY user_id LIMIT 1`,
  )
  const personal = rows[0] as { organization: string; user: string }
  const team = (
    await pool.query<{ id: string }>(
      `SELECT id FROM auth.organization o WHERE NOT EXISTS
        (SELECT FROM personal_organizations p WHERE p.organization_id=o.id) ORDER BY id LIMIT 1`,
    )
  ).rows[0]?.id as string
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const define = async (organization: string, owner: string | null, revisions: number) => {
      const id = (
        await client.query<{ id: string }>(
          'INSERT INTO workflow_definitions (organization_id,owner_user_id) VALUES ($1,$2) RETURNING id',
          [organization, owner],
        )
      ).rows[0]?.id as string
      for (let revision = 1; revision <= revisions; revision++)
        await client.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,$3,$4)',
          [
            organization,
            id,
            revision,
            JSON.stringify(
              revisionContent({
                name: `Synthetic upgrade workflow ${revision}`,
                trigger: { type: 'booking.cancelled', delayMinutes: revision * 30 },
              }),
            ),
          ],
        )
      return id
    }
    const enabled = await define(team, null, 2)
    await client.query('UPDATE workflow_definitions SET enabled=true WHERE id=$1', [enabled])
    await define(personal.organization, personal.user, 1)
    const deleted = await define(team, null, 1)
    await client.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [deleted])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  await pool.query(`INSERT INTO notification_email_sends (recipient_hash, sent_at) VALUES
    (sha256(convert_to('synthetic-booking-recipient', 'UTF8')), now() - interval '10 minutes'),
    (sha256(convert_to('synthetic-booking-recipient', 'UTF8')), now() - interval '5 hours'),
    (sha256(convert_to('synthetic-sign-in-recipient', 'UTF8')), now() - interval '20 minutes'),
    (NULL, now() - interval '30 minutes'),
    (NULL, now() - interval '3 days')`)
}

describe.skipIf(!serverUrl)('workflow execution storage upgrade', () => {
  it('preserves every predecessor row and the ledger, matches a fresh installation and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-workflow-exec-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-workflow-exec-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      // Every migration before 0079: the predecessor schema, whatever lower numbers main has.
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < executionMigration)
        .sort()
      expect(files).toContain('0076_workflow_definitions.sql')
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(directory, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early, { tag: 'wf_exec_upgrade' })
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await seedReminders(upgraded.pool)
      await seedWorkflowsAndLedger(upgraded.pool)

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
        'public.workflow_definitions',
        'public.workflow_revisions',
      ])
        expect(before.rows[table]?.length, table).toBeGreaterThan(0)
      expect(before.rows['public.notification_email_sends']?.length).toBeGreaterThanOrEqual(6)
      expect(before.rows['public.workflow_revisions']).toHaveLength(4)
      for (const table of executionTables) expect(before.rows[`public.${table}`]).toBeUndefined()
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows

      await copyFile(join(migrationsDir, executionMigration), join(directory, executionMigration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([executionMigration])
      // Every predecessor row is unchanged, down to its tuple; the new tables are empty, and
      // every existing ledger row has no workflow reservation.
      expect((await records(upgraded.pool, before.names)).rows).toEqual(before.rows)
      expect(
        (
          await upgraded.pool.query<{ total: number; workflow: number }>(
            `SELECT count(*)::int AS total,count(workflow_reservation_id)::int AS workflow
            FROM notification_email_sends`,
          )
        ).rows[0],
      ).toEqual({ total: before.rows['public.notification_email_sends']?.length, workflow: 0 })
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [executionMigration],
          )
        ).rows,
      ).toEqual(ledger)
      const after = await records(upgraded.pool)
      for (const table of executionTables) expect(after.rows[`public.${table}`]).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'wf_exec_fresh' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(JSON.stringify(schema)).toContain('workflow_recipient_claims_intent')
      expect(JSON.stringify(schema)).toContain('notification_email_sends_workflow_reservation')

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
