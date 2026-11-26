import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0192_scim_invitation_attribution.sql'

const insertAudit = (pool: pg.Pool, actor: string, credential: string) =>
  pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id)
     VALUES ($1, $2, $3, 'membership.invited', 'invitation', $4)`,
    [actor, randomUUID(), credential, randomUUID()],
  )

async function assertAttributionProtections(pool: pg.Pool) {
  await expect(insertAudit(pool, 'scim_connection', 'none')).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(insertAudit(pool, 'scim_connection', 'session')).rejects.toMatchObject({
    code: '23514',
    constraint: 'audit_scim_connection_actor_credential',
  })
  await expect(insertAudit(pool, 'unknown_actor', 'none')).rejects.toMatchObject({
    code: '23514',
    constraint: 'audit_events_actor_type_check',
  })
  await expect(
    pool.query(
      `WITH owner AS (
         INSERT INTO auth."user" (name, email, "emailVerified")
         VALUES ('Owner', 'owner@example.test', true) RETURNING id
       ), team AS (
         INSERT INTO auth.organization (name, slug, "createdAt")
         VALUES ('Team', 'team', now()) RETURNING id
       ), invitation AS (
         INSERT INTO auth.invitation ("organizationId", "inviterId", email, role, status, "expiresAt")
         SELECT team.id, owner.id, 'invitee@example.test', 'member', 'pending', now() + interval '48 hours'
         FROM team CROSS JOIN owner
         RETURNING id
       )
       INSERT INTO invitation_deliveries (invitation_id, state)
       SELECT id, 'queued' FROM invitation RETURNING scim_issued`,
    ),
  ).resolves.toMatchObject({ rows: [{ scim_issued: false }] })
  await expect(
    pool.query('UPDATE invitation_deliveries SET scim_issued = NULL'),
  ).rejects.toMatchObject({
    code: '23502',
    column: 'scim_issued',
  })
}

async function seedPredecessor(pool: pg.Pool) {
  await pool.query(`
    DO $fixture$
    DECLARE
      owner_id uuid;
      team_id uuid;
      other_team_id uuid;
      token_id uuid := gen_random_uuid();
      stamp timestamptz := clock_timestamp() - interval '2 hours';
      expiry timestamptz := stamp + interval '48 hours';
    BEGIN
      INSERT INTO auth."user" (name, email, "emailVerified")
        VALUES ('Owner', 'owner@example.test', true) RETURNING id INTO owner_id;
      INSERT INTO auth.organization (name, slug, "createdAt")
        VALUES ('Team', 'team', stamp) RETURNING id INTO team_id;
      INSERT INTO auth.organization (name, slug, "createdAt")
        VALUES ('Other team', 'other-team', stamp) RETURNING id INTO other_team_id;
      INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
        VALUES (team_id, owner_id, 'owner', stamp);
      INSERT INTO auth.invitation ("organizationId", "inviterId", email, role, status, "createdAt", "expiresAt")
        VALUES (team_id, owner_id, 'scim@example.test', 'member', 'pending', stamp, expiry),
               (team_id, owner_id, 'human@example.test', 'member', 'pending', stamp, expiry),
               (team_id, owner_id, 'resent@example.test', 'member', 'pending', stamp, expiry),
               (team_id, owner_id, 'expired@example.test', 'member', 'pending', stamp, stamp + interval '1 hour'),
               (team_id, owner_id, 'canceled@example.test', 'member', 'canceled', stamp, expiry),
               (team_id, owner_id, 'other-team@example.test', 'member', 'pending', stamp, expiry);
      INSERT INTO invitation_deliveries (invitation_id, state, generation, resend_request_id,
        authorized_by_user_id, created_at, generation_started_at, due_at, updated_at)
        SELECT id, 'queued', CASE WHEN email = 'resent@example.test' THEN 2 ELSE 1 END,
          CASE WHEN email = 'resent@example.test' THEN gen_random_uuid() END, owner_id,
          stamp, stamp, stamp, stamp
        FROM auth.invitation;
      INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
        occurred_at, action, target_type, target_id)
        SELECT CASE WHEN email = 'other-team@example.test' THEN other_team_id ELSE team_id END,
          CASE WHEN email = 'human@example.test' THEN 'user' ELSE 'scim_token' END,
          CASE WHEN email = 'human@example.test' THEN owner_id ELSE token_id END,
          'none', stamp, 'membership.invited', 'invitation', id
        FROM auth.invitation;
      INSERT INTO invitation_email_requests (user_id, organization_id, recipient_hash, requested_at)
        VALUES (owner_id, team_id, decode(repeat('ab', 32), 'hex'), stamp);
    END $fixture$
  `)
}

async function originalRows(pool: pg.Pool) {
  return (
    await pool.query(`
      SELECT 'audit' AS relation, to_jsonb(e) AS data FROM audit_events e
      UNION ALL
      SELECT 'invitation', to_jsonb(i) FROM auth.invitation i
      UNION ALL
      SELECT 'delivery', to_jsonb(d) - 'scim_issued' FROM invitation_deliveries d
      UNION ALL
      SELECT 'admission', to_jsonb(a) FROM invitation_email_requests a
      ORDER BY relation, data
    `)
  ).rows
}

describe.skipIf(!serverUrl)('SCIM invitation attribution migration', () => {
  it('fails an assertion when any 0192 catalogued object is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertAttributionProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.results.map(({ status }) => status)).toEqual(['covered', 'covered', 'covered'])
  })

  it('backfills only the original live SCIM generation and preserves populated predecessor data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-invitation-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl as string, directory)
      const pool = upgraded.pool
      await seedPredecessor(pool)
      const before = await originalRows(pool)
      expect(before).toHaveLength(19)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await originalRows(pool)).toEqual(before)
      expect(
        (
          await pool.query(`
            SELECT i.email
            FROM invitation_deliveries d JOIN auth.invitation i ON i.id = d.invitation_id
            WHERE d.scim_issued
          `)
        ).rows,
      ).toEqual([{ email: 'scim@example.test' }])

      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await originalRows(pool)).toEqual(before)
      for (const database of [upgraded, fresh]) {
        await expect(
          database.pool.query(`
            INSERT INTO invitation_email_requests (organization_id, recipient_hash, requested_at)
            VALUES (gen_random_uuid(), decode(repeat('cd', 32), 'hex'), now())
            RETURNING user_id
          `),
        ).resolves.toMatchObject({ rows: [{ user_id: null }] })
      }
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
