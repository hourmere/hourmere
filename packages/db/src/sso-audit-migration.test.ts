import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { assertSsoAuditDetailProtections, ssoAuditTestId } from './sso-audit-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0085_sso_audit_actions.sql'

/** Journal rows as the previous version writes them, one or more per kind of detail rule. */
const journal: [string, string, Record<string, unknown>][] = [
  ['membership.role_changed', 'membership', { oldRole: 'member', newRole: 'admin' }],
  ['membership.invited', 'invitation', {}],
  ['api_key.created', 'api_key', { scope: 'bookings' }],
  ['api_key.revoked', 'api_key', {}],
  ['scim_token.rotated', 'scim_token', {}],
  ['webhook.created', 'webhook', { events: ['booking.created', 'booking.cancelled'] }],
  ['webhook.paused', 'webhook', { events: ['booking.created'] }],
  ['slack_destination.created', 'slack_destination', { events: ['booking.rescheduled'] }],
  ['slack_destination.tested', 'slack_destination', { events: ['booking.created'] }],
  ['oauth.token_revoked', 'oauth_grant', { familySize: 3 }],
  ['organization.branding_updated', 'organization', { logo: 'selected', primaryColor: 'set' }],
  ['booking.created', 'booking', {}],
  ['booking.attendee_no_show_changed', 'booking', { attendeeId: randomUUID(), noShow: 'marked' }],
  ['booking.cancelled', 'booking', {}],
  ['event_type.updated', 'event_type', {}],
]

describe.skipIf(!serverUrl)('SSO audit actions migration', () => {
  it('keeps a populated journal, equals a fresh install, reruns as a no-op and admits the SSO details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sso-audit-'))
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
      const write = (action: string, targetType: string, details: unknown) =>
        pool.query(
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
      for (const [action, targetType, details] of journal) await write(action, targetType, details)
      // The predecessor refuses what 0085 admits.
      const providerId = ssoAuditTestId()
      for (const [action, details] of [
        ['sso_provider.created', { method: 'oidc', providerId, revision: 1 }],
        ['sso_authentication.failed', { method: 'saml', providerId, reason: 'unclassified' }],
        ['sso_enforcement.enabled', { revision: 2 }],
      ] as const)
        await expect(write(action, 'sso_provider', details)).rejects.toMatchObject({
          code: '23514',
          constraint: 'audit_events_details_check',
        })
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
      const checkDefinition = async (target = pool) =>
        (
          await target.query<{ definition: string; validated: boolean }>(
            `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated
             FROM pg_constraint WHERE conname = 'audit_events_details_check'`,
          )
        ).rows
      expect((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(
        journal.length,
      )
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM booking_attendees')).rows[0].n,
      ).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))

      // A row written by hand that the new check refuses (the predecessor's default rule lets an
      // SSO action through with empty details) stops the migration and changes nothing.
      const before = await checkDefinition()
      const handWritten = await write('sso_provider.created', 'sso_provider', {})
      expect(handWritten.rowCount).toBe(1)
      const failure = await runMigrations(pool, directory).then(
        () => undefined,
        (error: unknown) => error as Error & { cause?: { code?: string; constraint?: string } },
      )
      expect(failure?.message).toBe(`migration ${migration} failed`)
      expect(failure?.cause).toMatchObject({
        code: '23514',
        constraint: 'audit_events_details_check',
      })
      expect(await checkDefinition()).toEqual(before)
      expect(
        (
          await pool.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1', [
            migration,
          ])
        ).rows[0].n,
      ).toBe(0)
      await pool.query("DELETE FROM audit_events WHERE action = 'sso_provider.created'")

      const kept = await records()
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records()).toEqual(kept)
      const [after] = await checkDefinition()
      expect(after?.validated).toBe(true)
      expect(after?.definition).not.toBe(before[0]?.definition)
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await checkDefinition(fresh.pool)).toEqual([after])
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records()).toEqual(kept)
      // Every earlier branch still holds, and the SSO branches admit only their allow-lists.
      await assertSsoAuditDetailProtections(pool)
      await assertSsoAuditDetailProtections(fresh.pool)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
