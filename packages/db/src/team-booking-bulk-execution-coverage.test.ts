import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0198_team_booking_bulk_execution.sql'
const serverUrl = process.env.DATABASE_URL

async function assertBatchProtections(pool: pg.Pool, teamId: string) {
  const created = pool.query<{ id: string }>(
    `INSERT INTO team_booking_bulk_cancellations (organization_id, actor_user_id, session_id, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + interval '9 minutes'),
            ($1, $2, $3, clock_timestamp() + interval '9 minutes')
     RETURNING id, state, admitted_at, completed_at`,
    [teamId, randomUUID(), randomUUID()],
  )
  const defaultState = { state: 'awaiting_confirmation', admitted_at: null, completed_at: null }
  await expect(created).resolves.toMatchObject({ rows: [defaultState, defaultState] })
  const { rows } = await created
  const [first, second] = rows.map(({ id }) => id)
  const update = (fields: string, id = first) =>
    pool.query(`UPDATE team_booking_bulk_cancellations SET ${fields} WHERE id = $1`, [id])
  await expect(update('state = NULL')).rejects.toMatchObject({ code: '23502', column: 'state' })
  for (const fields of [
    "state = 'unknown'",
    "state = 'queued'",
    "state = 'queued', admitted_at = expires_at",
    "state = 'completed', admitted_at = created_at",
    "state = 'completed', admitted_at = created_at, completed_at = created_at - interval '1 second'",
    'admitted_at = created_at',
  ]) {
    await expect(update(fields)).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_booking_bulk_cancellations_state_check',
    })
  }
  await expect(update("state = 'queued', admitted_at = created_at")).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(update("state = 'running', admitted_at = created_at", second)).rejects.toMatchObject(
    {
      code: '23505',
      constraint: 'team_booking_bulk_cancellations_active_team_idx',
    },
  )

  const inserted = pool.query(
    `INSERT INTO team_booking_bulk_cancellation_items (batch_id, ordinal, booking_id, preview_outcome)
     VALUES ($1, 1, $2, 'eligible'), ($1, 2, $3, 'eligible'), ($1, 3, $4, 'booking_started')
     RETURNING outcome, attempt_count, next_attempt_at, claim_token, claim_expires_at`,
    [first, randomUUID(), randomUUID(), randomUUID()],
  )
  const defaultItem = {
    outcome: null,
    attempt_count: 0,
    next_attempt_at: null,
    claim_token: null,
    claim_expires_at: null,
  }
  await expect(inserted).resolves.toMatchObject({ rows: [defaultItem, defaultItem, defaultItem] })
  const item = (fields: string, ordinal = 1) =>
    pool.query(
      `UPDATE team_booking_bulk_cancellation_items SET ${fields} WHERE batch_id = $1 AND ordinal = $2`,
      [first, ordinal],
    )
  await expect(item('attempt_count = NULL')).rejects.toMatchObject({
    code: '23502',
    column: 'attempt_count',
  })
  for (const [fields, constraint, ordinal] of [
    ["outcome = 'unknown'", 'outcome', 1],
    ["outcome = 'cancelled'", 'outcome', 3],
    ['attempt_count = -1', 'attempt_count', 1],
    ['attempt_count = 4', 'attempt_count', 1],
    ["outcome = 'pending'", 'due', 1],
    ['next_attempt_at = clock_timestamp()', 'due', 1],
    ['claim_token = gen_random_uuid()', 'claim', 1],
    [
      'claim_token = gen_random_uuid(), claim_expires_at = clock_timestamp(), attempt_count = 1',
      'claim',
      1,
    ],
  ] as const) {
    await expect(item(fields, ordinal)).rejects.toMatchObject({
      code: '23514',
      constraint: `team_booking_bulk_items_${constraint}_check`,
    })
  }
  const claim = `outcome = 'pending', next_attempt_at = clock_timestamp(),
    claim_token = gen_random_uuid(), claim_expires_at = clock_timestamp()`
  await expect(item(claim)).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_booking_bulk_items_claim_check',
  })
  await expect(item(`${claim}, attempt_count = 1`)).resolves.toMatchObject({ rowCount: 1 })
  await expect(item(`${claim}, attempt_count = 1`, 2)).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_booking_bulk_items_active_claim_idx',
  })
  await expect(item("outcome = 'booking_started'", 3)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    item(
      "outcome = 'cancelled', next_attempt_at = NULL, claim_token = NULL, claim_expires_at = NULL",
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(item(`${claim}, attempt_count = 1`, 2)).resolves.toMatchObject({ rowCount: 1 })

  await expect(
    update("state = 'completed', completed_at = clock_timestamp()"),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    update("state = 'running', admitted_at = created_at", second),
  ).resolves.toMatchObject({ rowCount: 1 })
}

async function assertRateStorage(pool: pg.Pool, teamId: string) {
  const insert = (organizationId: string, kind: string) =>
    pool.query<{ id: string }>(
      `INSERT INTO team_booking_bulk_request_limits (organization_id, actor_user_id, kind)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [organizationId, randomUUID(), kind],
    )
  const status = insert(teamId, 'status')
  await expect(status).resolves.toMatchObject({ rows: [{ created_at: expect.any(Date) }] })
  const id = (await status).rows[0]?.id
  await expect(insert(teamId, 'preview')).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(randomUUID(), 'status')).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_booking_bulk_request_limits_organization_id_fkey',
  })
  await expect(insert(teamId, 'unknown')).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_booking_bulk_request_limits_kind_check',
  })
  await expect(
    pool.query(
      `INSERT INTO team_booking_bulk_request_limits (id, organization_id, actor_user_id, kind)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'status')`,
      [id, teamId, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'team_booking_bulk_request_limits_pkey' })
  for (const column of ['organization_id', 'actor_user_id', 'kind', 'created_at']) {
    await expect(
      pool.query(`UPDATE team_booking_bulk_request_limits SET ${column} = NULL WHERE id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23502', column })
  }
}

const admitted = 'booking.bulk_cancellation_admitted'
const completed = 'booking.bulk_cancellation_completed'
const outcomeCounts = {
  pending: 0,
  cancelled: 2,
  already_cancelled: 0,
  booking_started: 1,
  booking_not_supported: 0,
  booking_unavailable: 0,
  booking_host_departed: 0,
  authorization_lost: 0,
  processing_failed: 0,
}

function appendAudit(pool: pg.Pool, action: string, details: unknown, organizationId: string) {
  return pool.query(
    `INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type, action,
       target_type, target_id, details)
     VALUES ($1, 'system', 'migration-fixture', 'none', $2, 'booking', $3, $4::jsonb)
     RETURNING details`,
    [organizationId, action, randomUUID(), JSON.stringify(details)],
  )
}

async function assertAuditDetails(pool: pg.Pool, teamId: string) {
  const details = { counts: outcomeCounts }
  await expect(appendAudit(pool, admitted, { selectedCount: 3 }, teamId)).resolves.toMatchObject({
    rows: [{ details: { selectedCount: 3 } }],
  })
  await expect(appendAudit(pool, completed, details, teamId)).resolves.toMatchObject({
    rows: [{ details }],
  })
  const refused = { code: '23514', constraint: 'audit_events_details_check' }
  for (const invalid of [
    {},
    [],
    { selectedCount: 0 },
    { selectedCount: 26 },
    {
      selectedCount: '3',
    },
    { selectedCount: 2.5 },
    { selectedCount: 3, email: 'fixture@example.test' },
  ]) {
    await expect(appendAudit(pool, admitted, invalid, teamId)).rejects.toMatchObject(refused)
  }
  for (const invalid of [
    {},
    { counts: [] },
    { counts: {} },
    { ...details, name: 'private fixture' },
    { counts: { ...outcomeCounts, bookingId: randomUUID() } },
    { counts: { ...outcomeCounts, pending: 1 } },
    { counts: { ...outcomeCounts, cancelled: -1 } },
    { counts: { ...outcomeCounts, cancelled: 1.5 } },
    { counts: { ...outcomeCounts, cancelled: '2' } },
    { counts: { ...outcomeCounts, cancelled: 25 } },
  ]) {
    await expect(appendAudit(pool, completed, invalid, teamId)).rejects.toMatchObject(refused)
  }
  await expect(
    appendAudit(pool, 'organization.branding_updated', { logo: 'selected' }, teamId),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    appendAudit(pool, 'organization.branding_updated', { logo: 'private fixture' }, teamId),
  ).rejects.toMatchObject(refused)
}

async function assertExecutionProtections(pool: pg.Pool) {
  const teamId = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       VALUES ($1, 'Bulk execution team', 'bulk-execution-fixture', clock_timestamp())`,
      [teamId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await assertBatchProtections(pool, teamId)
  await assertRateStorage(pool, teamId)
  await assertAuditDetails(pool, teamId)
  for (const [index, columns] of [
    ['team_booking_bulk_cancellations_admissions_idx', '(organization_id, admitted_at)'],
    ['team_booking_bulk_cancellations_completed_retention_idx', '(completed_at, id)'],
    ['team_booking_bulk_cancellations_preview_expiry_idx', '(expires_at, id)'],
    [
      'team_booking_bulk_request_limits_actor_idx',
      '(organization_id, kind, actor_user_id, created_at)',
    ],
    ['team_booking_bulk_request_limits_cleanup_idx', '(created_at, id)'],
    ['team_booking_bulk_request_limits_team_idx', '(organization_id, kind, created_at)'],
  ]) {
    await expect(
      pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [
        'public',
        index,
      ]),
    ).resolves.toMatchObject({ rows: [{ indexdef: expect.stringContaining(columns as string) }] })
  }
  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [teamId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT id FROM team_booking_bulk_request_limits'),
  ).resolves.toMatchObject({
    rows: [],
  })
}

async function seedPredecessor(pool: pg.Pool) {
  const seeded = pool.query<{ id: string; organization_id: string }>(`
    WITH actor AS (
      INSERT INTO auth."user" (name, email, "emailVerified")
      VALUES ('Migration manager', 'manager@example.test', true) RETURNING id
    ), team AS (
      INSERT INTO auth.organization (name, slug, "createdAt")
      VALUES ('Migration team', 'migration-team', clock_timestamp()) RETURNING id
    ), role AS (
      INSERT INTO auth.member ("userId", "organizationId", role, "createdAt")
      SELECT actor.id, team.id, 'owner', clock_timestamp() FROM actor, team
    ), session AS (
      INSERT INTO auth.session ("userId", "activeOrganizationId", token, "expiresAt", "updatedAt")
      SELECT actor.id, team.id::text, 'synthetic-bulk-session',
        clock_timestamp() + interval '1 hour', clock_timestamp()
      FROM actor, team RETURNING id
    ), booking AS (
      INSERT INTO bookings (organization_id, start_at, end_at, title, source, required_host_user_ids)
      SELECT team.id, '2030-05-10T09:00:00.123456Z', '2030-05-10T09:30:00.654321Z',
        'Team booking 東京', 'web', ARRAY[actor.id] FROM team, actor RETURNING id
    ), receipt AS (
      INSERT INTO team_booking_bulk_cancellations
        (organization_id, actor_user_id, session_id, expires_at)
      SELECT team.id, actor.id, session.id, clock_timestamp() + interval '9 minutes'
      FROM team, actor, session RETURNING id, organization_id
    ), selection AS (
      INSERT INTO team_booking_bulk_cancellation_items (batch_id, ordinal, booking_id, preview_outcome)
      SELECT receipt.id, 1, booking.id, 'eligible' FROM receipt, booking
    )
    SELECT * FROM receipt
  `)
  await expect(seeded).resolves.toMatchObject({ rowCount: 1 })
  return (await seeded).rows[0]
}

const predecessorData = async (pool: pg.Pool) =>
  (
    await pool.query(`
      SELECT
        (SELECT to_jsonb(booking) FROM bookings booking) AS booking,
        (SELECT to_jsonb(session) FROM auth.session session) AS session,
        (SELECT to_jsonb(audit) FROM audit_events audit) AS audit,
        (SELECT to_jsonb(receipt) - ARRAY['state', 'admitted_at', 'completed_at']
          FROM team_booking_bulk_cancellations receipt) AS receipt,
        (SELECT to_jsonb(item) - ARRAY['outcome', 'attempt_count', 'next_attempt_at', 'claim_token', 'claim_expires_at']
          FROM team_booking_bulk_cancellation_items item) AS item
    `)
  ).rows

describe.skipIf(!serverUrl)('team booking bulk execution migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'protects batch state, claim fences, request accounting and audit details',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        assertions: assertExecutionProtections,
        predecessorTemplate: replay.predecessor,
        concurrency: 2,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves populated preview receipts and prior journal entries through upgrade and re-run',
    async () => {
      const upgraded = await replay.predecessor.clone(replay.directory, { tag: 'bulk_run_upgrade' })
      let fresh: TestDatabase | undefined
      try {
        const seeded = await seedPredecessor(upgraded.pool)
        if (!seeded) throw new Error('Predecessor did not return a receipt')
        await appendAudit(
          upgraded.pool,
          'organization.branding_updated',
          { logo: 'selected' },
          seeded.organization_id,
        )
        const before = await predecessorData(upgraded.pool)
        const check = await upgraded.pool.query<{ expression: string }>(
          `SELECT pg_get_expr(conbin, conrelid) AS expression FROM pg_constraint
         WHERE conrelid = 'audit_events'::regclass AND conname = 'audit_events_details_check'`,
        )

        await copyFile(join(migrationsDir, migration), join(replay.directory, migration))
        await expect(runMigrations(upgraded.pool, replay.directory)).resolves.toEqual([migration])
        expect(await predecessorData(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query(
            'SELECT state, admitted_at, completed_at FROM team_booking_bulk_cancellations WHERE id = $1',
            [seeded.id],
          ),
        ).resolves.toMatchObject({
          rows: [{ state: 'awaiting_confirmation', admitted_at: null, completed_at: null }],
        })
        await expect(
          upgraded.pool.query(
            'SELECT outcome, attempt_count FROM team_booking_bulk_cancellation_items WHERE batch_id = $1',
            [seeded.id],
          ),
        ).resolves.toMatchObject({ rows: [{ outcome: null, attempt_count: 0 }] })
        const previous = await upgraded.pool.query<{ body: string }>(
          `SELECT pg_get_functiondef('audit_event_pre_bulk_details_valid(audit_events)'::regprocedure) AS body`,
        )
        // PostgreSQL deparses the stored SQL body with different parentheses and whitespace.
        expect(
          previous.rows[0]?.body?.replaceAll('previous_event.', '').replace(/[\s()]/g, ''),
        ).toContain(check.rows[0]?.expression?.replace(/[\s()]/g, ''))
        fresh = await createTestDatabase(serverUrl as string, undefined, {
          migrate: false,
          tag: 'bulk_run_fresh',
        })
        await expect(runMigrations(fresh.pool, replay.directory)).resolves.toContain(migration)
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(upgraded.pool, replay.directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, replay.directory)).resolves.toEqual([])
        expect(await predecessorData(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
