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

const serverUrl = process.env.DATABASE_URL as string
const migration = '0194_team_slug_reservations.sql'
const heldSlug = { code: '23505', constraint: 'team_slug_reserved' }

function createTeam(pool: pg.Pool, slug: string, id = randomUUID()) {
  return pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
      VALUES ($1, 'Design Studio', $2, clock_timestamp())`,
    [id, slug],
  )
}

function renameTeam(pool: pg.Pool, teamId: string, slug: string) {
  return pool.query('UPDATE auth.organization SET slug = $2 WHERE id = $1 RETURNING slug', [
    teamId,
    slug,
  ])
}

function insertAuditedUpdate(pool: pg.Pool, teamId: string, details: object) {
  return pool.query(
    `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
       action, target_type, target_id, details)
     VALUES ($1, 'system', 'test', 'none', 'organization.updated', 'organization', $2, $3)`,
    [teamId, teamId, JSON.stringify(details)],
  )
}

async function assertTeamSlugProtections(pool: pg.Pool) {
  const teamId = randomUUID()
  const otherId = randomUUID()
  await expect(createTeam(pool, 'Studio-One', teamId)).resolves.toMatchObject({ rowCount: 1 })
  await expect(createTeam(pool, 'other-studio', otherId)).resolves.toMatchObject({ rowCount: 1 })
  await expect(createTeam(pool, 'STUDIO-ONE')).rejects.toMatchObject({
    code: '23505',
    constraint: 'organization_slug_lower_uidx',
  })

  const {
    rows: [before],
  } = await pool.query<{ now: string }>('SELECT clock_timestamp()::text AS now')
  expect(before).toBeDefined()
  await expect(renameTeam(pool, teamId, 'studio-two')).resolves.toMatchObject({
    rows: [{ slug: 'studio-two' }],
  })
  await expect(
    pool.query(
      `SELECT organization_id, expires_at BETWEEN $2::timestamptz + interval '2160 hours'
         AND clock_timestamp() + interval '2160 hours' AS held_for_90_days
       FROM team_slug_reservations WHERE slug = $1`,
      ['studio-one', before?.now],
    ),
  ).resolves.toMatchObject({ rows: [{ organization_id: teamId, held_for_90_days: true }] })
  await expect(createTeam(pool, 'STUDIO-ONE')).rejects.toMatchObject(heldSlug)
  await expect(renameTeam(pool, otherId, 'studio-one')).rejects.toMatchObject(heldSlug)
  await expect(renameTeam(pool, teamId, 'studio-one')).resolves.toMatchObject({
    rows: [{ slug: 'studio-one' }],
  })
  await expect(
    pool.query(`SELECT slug FROM team_slug_reservations ORDER BY slug`),
  ).resolves.toMatchObject({ rows: [{ slug: 'studio-two' }] })

  await expect(
    pool.query(`INSERT INTO team_slug_reservations VALUES ('studio-two', $1, clock_timestamp())`, [
      otherId,
    ]),
  ).rejects.toMatchObject({ code: '23505', constraint: 'team_slug_reservations_pkey' })
  await expect(
    pool.query(
      `INSERT INTO team_slug_reservations VALUES ('without-owner', $1, clock_timestamp())`,
      [randomUUID()],
    ),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_slug_reservations_organization_id_fkey',
  })
  await expect(
    pool.query(`INSERT INTO team_slug_reservations VALUES ('without-expiry', $1, NULL)`, [teamId]),
  ).rejects.toMatchObject({ code: '23502', column: 'expires_at' })

  await expect(insertAuditedUpdate(pool, teamId, {})).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insertAuditedUpdate(pool, teamId, {
      oldSlug: 'Studio-One',
      newSlug: 'studio-one',
      nameChanged: true,
    }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insertAuditedUpdate(pool, teamId, { oldSlug: null, newSlug: 'studio-one' }),
  ).resolves.toMatchObject({ rowCount: 1 })
  for (const details of [
    { oldName: 'Design Studio' },
    { nameChanged: 'true' },
    { nameChanged: false },
    { newSlug: 'studio-one' },
    { oldSlug: 'Studio-One' },
    { oldSlug: 'legacy/invalid', newSlug: 'studio-one' },
    { oldSlug: 'Studio-One', newSlug: 'STUDIO-ONE' },
    { oldSlug: 'Studio-One', newSlug: null },
    { oldSlug: 'Studio-One', newSlug: 'a'.repeat(65) },
  ]) {
    await expect(insertAuditedUpdate(pool, teamId, details)).rejects.toMatchObject({
      code: '23514',
      constraint: 'audit_events_details_check',
    })
  }

  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [teamId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT organization_id FROM team_slug_reservations'),
  ).resolves.toMatchObject({
    rows: [{ organization_id: null }],
  })
  await expect(createTeam(pool, 'studio-two')).rejects.toMatchObject(heldSlug)
  await expect(
    pool.query(
      `UPDATE team_slug_reservations SET expires_at = clock_timestamp() WHERE slug = 'studio-two'`,
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(renameTeam(pool, otherId, 'studio-two')).resolves.toMatchObject({
    rows: [{ slug: 'studio-two' }],
  })
  await expect(pool.query('SELECT slug FROM team_slug_reservations')).resolves.toMatchObject({
    rows: [{ slug: 'other-studio' }],
  })
}

async function seedPredecessor(pool: pg.Pool, teamId: string) {
  const userId = randomUUID()
  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified")
       VALUES ($1, 'Studio Host', 'studio-host@example.test', true)`,
    [userId],
  )
  await pool.query(
    `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, 'owner', '2026-10-20T15:00:00Z')`,
    [teamId, userId],
  )
  await pool.query(
    `INSERT INTO event_types (organization_id, slug, title, duration_minutes)
       VALUES ($1, 'consultation', 'Consultation', 45)`,
    [teamId],
  )
  await insertAuditedUpdate(pool, teamId, {})
}

async function predecessorRows(pool: pg.Pool, teamId: string) {
  return (
    await pool.query(
      `SELECT to_jsonb(o) AS organization, to_jsonb(m) AS owner, to_jsonb(e) AS event,
              to_jsonb(a) AS update_audit
       FROM auth.organization o
       JOIN auth.member m ON m."organizationId" = o.id
       JOIN event_types e ON e.organization_id = o.id
       JOIN audit_events a ON a.organization_id = o.id
       WHERE o.id = $1`,
      [teamId],
    )
  ).rows
}

describe.skipIf(!serverUrl)('Team slug reservations migration', () => {
  it('fails an assertion when any slug or audit protection is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl,
      migration,
      assertions: assertTeamSlugProtections,
    })
    expect(report.problems).toEqual([])
  })

  it('rejects a claim when a repeatable-read snapshot predates the reservation', async () => {
    const database = await createTestDatabase(serverUrl, undefined, { tag: 'team_slug_rr' })
    try {
      const teamId = randomUUID()
      await createTeam(database.pool, 'released-address', teamId)
      const claimant = await database.pool.connect()
      try {
        await claimant.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        await expect(
          claimant.query("SELECT slug FROM team_slug_reservations WHERE slug = 'released-address'"),
        ).resolves.toMatchObject({ rows: [] })
        await renameTeam(database.pool, teamId, 'replacement-address')
        await expect(
          claimant.query(
            `INSERT INTO auth.organization (name, slug, "createdAt")
              VALUES ('Other Studio', 'released-address', clock_timestamp())`,
          ),
        ).rejects.toMatchObject({ code: '40001' })
      } finally {
        try {
          await claimant.query('ROLLBACK')
        } finally {
          claimant.release()
        }
      }
      await expect(createTeam(database.pool, 'released-address')).rejects.toMatchObject(heldSlug)
    } finally {
      await database.drop()
    }
  })

  it('reports case collisions, preserves predecessor rows, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-team-slugs-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl, directory, { tag: 'team_slug_up' })
      const { pool } = upgraded
      const teamId = randomUUID()
      const conflictId = randomUUID()
      await createTeam(pool, 'Legacy-Studio', teamId)
      await createTeam(pool, 'legacy-studio', conflictId)
      await seedPredecessor(pool, teamId)
      const before = await predecessorRows(pool, teamId)
      expect(before).toHaveLength(1)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      await expect(runMigrations(pool, directory)).rejects.toMatchObject({
        cause: {
          code: '23505',
          message:
            'Case-insensitive organization slug collisions must be resolved before upgrading',
          detail: `Conflicting organization IDs by slug: ${[teamId, conflictId].sort().join(', ')}`,
        },
      })
      await expect(
        pool.query('SELECT slug FROM auth.organization ORDER BY id'),
      ).resolves.toMatchObject({
        rowCount: 2,
      })
      await expect(
        pool.query(`SELECT to_regclass('public.team_slug_reservations') AS reservations`),
      ).resolves.toMatchObject({ rows: [{ reservations: null }] })
      expect(await predecessorRows(pool, teamId)).toEqual(before)

      await pool.query('DELETE FROM auth.organization WHERE id = $1', [conflictId])
      await expect(runMigrations(pool, directory)).resolves.toEqual([migration])
      expect(await predecessorRows(pool, teamId)).toEqual(before)
      await expect(pool.query('SELECT slug FROM team_slug_reservations')).resolves.toMatchObject({
        rows: [],
      })

      fresh = await createTestDatabase(serverUrl, directory, { tag: 'team_slug_fresh' })
      expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
      await expect(runMigrations(pool, directory)).resolves.toEqual([])
      await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
      expect(await predecessorRows(pool, teamId)).toEqual(before)
    } finally {
      try {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
})
