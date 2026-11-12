import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertAuditDetailProtections } from './audit-actions-followups-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0078_audit_actions_followups.sql'

/** One journal row per recorded action, as the previous version writes them. */
const journal: [string, string, Record<string, unknown>][] = [
  ['membership.role_changed', 'membership', { oldRole: 'member', newRole: 'admin' }],
  ['api_key.created', 'api_key', { scope: 'bookings' }],
  ['api_key.revoked', 'api_key', {}],
  ['webhook.created', 'webhook', { events: ['booking.created', 'booking.cancelled'] }],
  ['webhook.paused', 'webhook', { events: ['booking.created'] }],
  ['oauth.token_revoked', 'oauth_grant', { familySize: 3 }],
  ['organization.branding_updated', 'organization', { logo: 'selected', primaryColor: 'set' }],
  ['booking.created', 'booking', {}],
  ['booking.cancelled', 'booking', {}],
  ['event_type.updated', 'event_type', {}],
]

describe.skipIf(!serverUrl)('audit action follow-ups migration', () => {
  it('keeps a populated journal, equals a fresh install, reruns as a no-op and admits the new events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-audit-followups-'))
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
      for (const [action, targetType, details] of journal)
        await pool.query(
          `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type, credential_id,
             action, target_type, target_id, details, request_id)
           VALUES ($1, 'user', $2, 'session', $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            organization,
            randomUUID(),
            randomUUID(),
            action,
            targetType,
            randomUUID(),
            JSON.stringify(details),
            randomUUID(),
          ],
        )
      // The predecessor refuses what 0078 admits.
      for (const [action, details] of [
        ['booking.attendee_no_show_changed', { attendeeId: randomUUID(), noShow: 'marked' }],
        ['slack_destination.created', { events: ['booking.created'] }],
      ] as const)
        await expect(
          pool.query(
            `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
             VALUES ('system', 'test', 'none', $1, 'test', 'test', $2::jsonb)`,
            [action, JSON.stringify(details)],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'audit_events_details_check' })
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
      // Every earlier branch still holds, and the new one admits only its allow-list.
      await assertAuditDetailProtections(pool)
      await assertAuditDetailProtections(fresh.pool)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
