import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  bookingRoutingValues,
  insertRow,
  receiptValues,
  routingFixture,
  versionValues,
} from './routing-storage-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0165_routed_booking_replay.sql'

async function assertReplayProtections(pool: pg.Pool) {
  const fixture = await routingFixture(pool)
  const insertReplay = (
    record: ReturnType<typeof bookingRoutingValues>,
    fingerprint: Buffer | null,
  ) =>
    pool.query(
      `INSERT INTO booking_routing (organization_id, booking_id, form_id, version_id,
       version_number, matched_rule_id, resolved_rule_id, questions, answers, replay_fingerprint)
       VALUES ($1, $2, $3, $4, 1, 'fallback', 'fallback', '[]', '{}', $5)`,
      [record.organization_id, record.booking_id, record.form_id, record.version_id, fingerprint],
    )
  const first = bookingRoutingValues(fixture)
  const second = {
    ...first,
    booking_id: fixture.otherBooking,
    organization_id: fixture.otherOrganization,
    form_id: fixture.otherForm,
    version_id: fixture.otherVersion,
  }
  const fingerprint = Buffer.alloc(32, 0xaf)
  await expect(insertReplay(first, fingerprint.subarray(1))).rejects.toMatchObject({
    code: '23514',
    constraint: 'booking_routing_replay_fingerprint_shape',
  })
  await expect(insertReplay(first, fingerprint)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insertReplay(second, fingerprint)).rejects.toMatchObject({
    code: '23505',
    constraint: 'booking_routing_replay_fingerprint',
  })
  await expect(insertReplay(second, null)).resolves.toMatchObject({ rowCount: 1 })
}

async function seedRoutingSnapshot(pool: pg.Pool) {
  const fixture = await routingFixture(pool)
  const { organization, form, event, booking } = fixture
  const questionId = '0190d1a2-0000-7000-8000-000000000001'
  const optionId = '0190d1a2-0000-7000-8000-000000000002'
  const questions = JSON.stringify([
    {
      id: questionId,
      type: 'select',
      label: 'Office',
      required: true,
      options: [{ id: optionId, label: '東京' }],
    },
  ])
  const target = JSON.stringify({ kind: 'event', eventTypeId: event, mappings: [] })
  const version = await insertRow(pool, 'routing_form_versions', {
    ...versionValues(fixture),
    version_number: 2,
    questions,
    fallback: target,
  })
  await pool.query(
    'UPDATE routing_forms SET published_version_id = $2, enabled = true WHERE id = $1',
    [form, version],
  )
  await insertRow(pool, 'routing_target_dependencies', {
    organization_id: organization,
    version_id: version,
    rule_id: 'fallback',
    event_type_id: event,
    health_code: 'ok',
  })
  const issued = { ...fixture, version }
  await insertRow(pool, 'routing_receipts', { ...receiptValues(issued), resolved_target: target })
  await insertRow(pool, 'routing_receipts', {
    ...receiptValues(issued),
    resolved_target: target,
    answers_ciphertext: null,
    consumed_booking_id: booking,
  })
  await insertRow(pool, 'booking_routing', {
    ...bookingRoutingValues(issued),
    version_number: 2,
    questions,
    answers: JSON.stringify({ [questionId]: optionId }),
  })
}

async function routingRows(pool: pg.Pool) {
  const tables = [
    'bookings',
    'routing_forms',
    'routing_form_versions',
    'routing_target_dependencies',
    'routing_receipts',
    'booking_routing',
  ]
  const entries = []
  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT to_jsonb(r) - 'replay_fingerprint' AS record, xmin::text, ctid::text
       FROM ${table} AS r ORDER BY to_jsonb(r)::text COLLATE "C"`,
    )
    entries.push([table, rows] as const)
  }
  return Object.fromEntries(entries)
}

describe.skipIf(!serverUrl)('routed booking replay migration', () => {
  it('fails an assertion when either replay protection is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration,
      assertions: assertReplayProtections,
    })
    expect(report.problems).toEqual([])
    expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(2)
  }, 600_000)

  it('preserves predecessor rows, matches a fresh installation and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-routing-replay-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const predecessors = (await readdir(migrationsDir)).filter(
        (file) => file.endsWith('.sql') && file < migration,
      )
      for (const file of predecessors) {
        await copyFile(join(migrationsDir, file), join(directory, file))
      }
      upgraded = await createTestDatabase(serverUrl as string, directory, {
        tag: 'routed_replay_up',
      })
      await seedRoutingSnapshot(upgraded.pool)
      const before = await routingRows(upgraded.pool)
      expect(before.booking_routing).toHaveLength(1)
      expect(before.routing_receipts).toHaveLength(2)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await routingRows(upgraded.pool)).toEqual(before)
      await expect(
        upgraded.pool.query('SELECT replay_fingerprint FROM booking_routing'),
      ).resolves.toMatchObject({ rows: [{ replay_fingerprint: null }] })

      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'route_replay_new' })
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await routingRows(upgraded.pool)).toEqual(before)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
