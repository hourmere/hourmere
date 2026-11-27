import { randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
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

const serverUrl = process.env.DATABASE_URL
const migration = '0201_departure_handoff_delivery.sql'
const offers = 'departure_handoff_offers'
const recipients = 'departure_handoff_recipients'
const budgets = 'departure_handoff_send_budgets'
const deliveries = 'departure_handoff_deliveries'
const issuedAt = '2030-05-10T09:00:00.123456Z'
const appliedAt = '2030-05-10T11:00:00.123456Z'
const expiresAt = '2030-05-11T09:00:00.123456Z'
const startAt = '2030-05-12T09:00:00.123456Z'
const digest = 'd'.repeat(64)

function insert(pool: pg.Pool, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  const parameters = columns.map((_, index) => `$${index + 1}`)
  return pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${parameters.join(', ')})`,
    Object.values(values),
  )
}

async function seed(pool: pg.Pool) {
  const teamId = randomUUID()
  const otherTeamId = randomUUID()
  const hostId = randomUUID()
  const replacementHostId = randomUUID()
  const sourceId = randomUUID()
  const replacementId = randomUUID()
  const eventId = randomUUID()
  await expect(
    pool.query(
      `WITH people AS (
        INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES
          ($3, 'Original host', 'handoff-original@example.test', true),
          ($4, 'Replacement host', 'handoff-replacement@example.test', true)
      ), teams AS (
        INSERT INTO auth.organization (id, name, slug, "createdAt") VALUES
          ($1, 'Handoff team', 'handoff-team', $8), ($2, 'Other team', 'handoff-other-team', $8)
      ), members AS (
        INSERT INTO auth.member ("userId", "organizationId", role, "createdAt") VALUES
          ($3, $1, 'owner', $8), ($4, $1, 'member', $8)
      ), event AS (
        INSERT INTO event_types (id, organization_id, slug, title, duration_minutes, allow_guests)
          VALUES ($7, $1, 'handoff-event', 'Handoff event', 30, true)
      ), event_host AS (
        INSERT INTO event_type_hosts (event_type_id, user_id) VALUES ($7, $4)
      ), booked AS (
        INSERT INTO bookings (id, organization_id, event_type_id, source, title, start_at,
                              end_at, required_host_user_ids, responses)
        VALUES ($5, $1, $7, 'web', 'Appointment with original host', $9::timestamptz,
                $9::timestamptz + interval '30 minutes', ARRAY[$3::uuid], '{"notes":"Fixture"}'),
               ($6, $1, $7, 'web', 'Appointment with replacement host',
                $9::timestamptz + interval '60 minutes', $9::timestamptz + interval '90 minutes',
                ARRAY[$4::uuid], '{}')
        RETURNING id, required_host_user_ids
      ), host AS (
        INSERT INTO booking_hosts (booking_id, user_id)
          SELECT id, required_host_user_ids[1] FROM booked
      )
      INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
        VALUES ($5, 'Booker', 'booker@example.test', 'Asia/Shanghai', 'zh-CN', true),
               ($5, 'Guest', 'guest@example.test', 'America/New_York', 'en', false)`,
      [
        teamId,
        otherTeamId,
        hostId,
        replacementHostId,
        sourceId,
        replacementId,
        eventId,
        issuedAt,
        startAt,
      ],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  const offer = {
    id: randomUUID(),
    organization_id: teamId,
    source_booking_id: sourceId,
    version: 1,
    proposer_user_id: hostId,
    departing_user_id: hostId,
    target_start_at: startAt,
    duration_minutes: 30,
    terms_digest: digest,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }
  await expect(insert(pool, offers, offer)).resolves.toMatchObject({ rowCount: 1 })
  const recipientIds = [randomUUID(), randomUUID()] as const
  for (const [index, recipient_key] of ['booker@example.test', 'guest@example.test'].entries()) {
    await expect(
      insert(pool, recipients, {
        id: recipientIds[index],
        organization_id: teamId,
        source_booking_id: sourceId,
        offer_id: offer.id,
        offer_version: offer.version,
        recipient_key,
      }),
    ).resolves.toMatchObject({ rowCount: 1 })
  }
  return { offer, recipientIds, teamId, otherTeamId, hostId, sourceId, replacementId }
}

async function assertDeliveryProtections(pool: pg.Pool) {
  const { offer, recipientIds, teamId, otherTeamId, sourceId } = await seed(pool)
  const [bookerId, guestId] = recipientIds
  const writeOffer = (state: string, reason: string) =>
    pool.query('UPDATE departure_handoff_offers SET state = $1, close_reason = $2 WHERE id = $3', [
      state,
      reason,
      offer.id,
    ])
  await expect(writeOffer('live', 'withdrawn')).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_offers_close_reason_check',
  })
  await expect(writeOffer('closed', 'arbitrary')).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_offers_close_reason_check',
  })
  await expect(
    pool.query(
      "SELECT to_regclass('public.departure_handoff_offers_expiry_idx') IS NOT NULL AS indexed",
    ),
  ).resolves.toMatchObject({ rows: [{ indexed: true }] })

  const writeDigest = (id: string, value: string | null) =>
    pool.query('UPDATE departure_handoff_recipients SET token_digest = $2 WHERE id = $1', [
      id,
      value,
    ])
  await expect(writeDigest(bookerId, 'plaintext-token')).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_recipients_token_digest_check',
  })
  await expect(writeDigest(bookerId, digest)).resolves.toMatchObject({ rowCount: 1 })
  await expect(writeDigest(guestId, digest)).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_recipients_token_digest_key',
  })
  await expect(writeDigest(bookerId, null)).resolves.toMatchObject({ rowCount: 1 })
  await expect(writeDigest(guestId, digest)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      "UPDATE departure_handoff_recipients SET decision = 'approved', decided_at = $2 WHERE id = $1",
      [guestId, appliedAt],
    ),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_recipients_token_digest_check',
  })
  await expect(
    pool.query(
      `UPDATE departure_handoff_recipients
        SET decision = 'approved', decided_at = $2, token_digest = NULL WHERE id = $1`,
      [guestId, appliedAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(writeDigest(guestId, digest)).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_recipients_token_digest_check',
  })

  const budget = {
    organization_id: teamId,
    source_booking_id: sourceId,
    recipient_hash: digest,
    counted_sends: 3,
  }
  await expect(
    insert(pool, budgets, { ...budget, organization_id: otherTeamId }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'departure_handoff_send_budgets_source_fk',
  })
  await expect(
    insert(pool, budgets, { ...budget, recipient_hash: 'booker@example.test' }),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_send_budgets_recipient_hash_check',
  })
  for (const counted_sends of [0, 4]) {
    await expect(insert(pool, budgets, { ...budget, counted_sends })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_send_budgets_counted_sends_check',
    })
  }
  await expect(insert(pool, budgets, { ...budget, counted_sends: null })).rejects.toMatchObject({
    code: '23502',
    column: 'counted_sends',
  })
  await expect(insert(pool, budgets, budget)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, budgets, budget)).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_send_budgets_pkey',
  })

  const initial = { job_id: randomUUID(), recipient_id: bookerId }
  await expect(
    insert(pool, deliveries, { ...initial, recipient_id: randomUUID() }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'departure_handoff_deliveries_recipient_fk',
  })
  for (const column of ['recipient_id', 'state', 'created_at']) {
    await expect(insert(pool, deliveries, { ...initial, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
  await expect(insert(pool, deliveries, { ...initial, state: 'arbitrary' })).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_deliveries_state_check',
  })
  await expect(
    insert(pool, deliveries, { ...initial, created_at: 'infinity' }),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_deliveries_created_at_check',
  })
  await expect(insert(pool, deliveries, initial)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      'SELECT state, created_at <= clock_timestamp() AS stamped FROM departure_handoff_deliveries',
    ),
  ).resolves.toMatchObject({ rows: [{ state: 'queued', stamped: true }] })
  await expect(
    insert(pool, deliveries, { ...initial, recipient_id: guestId }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_deliveries_pkey',
  })
  const resend = { job_id: randomUUID(), recipient_id: bookerId, request_key: randomUUID() }
  await expect(insert(pool, deliveries, resend)).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_deliveries_one_queued',
  })
  await expect(
    pool.query("UPDATE departure_handoff_deliveries SET state = 'unknown' WHERE job_id = $1", [
      initial.job_id,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, deliveries, { ...initial, job_id: randomUUID(), state: 'unknown' }),
  ).rejects.toMatchObject({ code: '23505', constraint: 'departure_handoff_deliveries_request_key' })
  await expect(insert(pool, deliveries, resend)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, deliveries, { ...resend, job_id: randomUUID(), state: 'sent' }),
  ).rejects.toMatchObject({ code: '23505', constraint: 'departure_handoff_deliveries_request_key' })

  await expect(writeOffer('closed', 'withdrawn')).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('DELETE FROM departure_handoff_offers WHERE id = $1', [offer.id]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT job_id FROM departure_handoff_deliveries'),
  ).resolves.toMatchObject({
    rows: [],
  })
  await expect(
    pool.query('SELECT counted_sends FROM departure_handoff_send_budgets'),
  ).resolves.toMatchObject({ rows: [{ counted_sends: 3 }] })
  await expect(pool.query('DELETE FROM bookings WHERE id = $1', [sourceId])).resolves.toMatchObject(
    {
      rowCount: 1,
    },
  )
  await expect(
    pool.query('SELECT counted_sends FROM departure_handoff_send_budgets'),
  ).resolves.toMatchObject({ rows: [] })
}

async function snapshotPredecessor(pool: pg.Pool) {
  const projections = [
    ['bookings', 'to_jsonb(t)'],
    ['booking_hosts', 'to_jsonb(t)'],
    ['booking_attendees', 'to_jsonb(t)'],
    ['departure_handoff_offers', "to_jsonb(t) - 'close_reason'"],
    ['departure_handoff_recipients', "to_jsonb(t) - 'token_digest'"],
    ['departure_booking_handoffs', 'to_jsonb(t)'],
  ]
  return Promise.all(
    projections.map(async ([table, projection]) => {
      const result = await pool.query(
        `SELECT (${projection})::text AS row, xmin::text, ctid::text FROM ${table} t ORDER BY row`,
      )
      return result.rows
    }),
  )
}

describe.skipIf(!serverUrl)('departure handoff delivery migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'detects a removed delivery or send budget constraint',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertDeliveryProtections,
        concurrency: 2,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves populated predecessor offers and receipts, matches a fresh install, and reruns without writes',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        const { pool } = upgraded
        const { offer, recipientIds, teamId, hostId, sourceId, replacementId } = await seed(pool)
        await expect(
          pool.query(
            "UPDATE departure_handoff_recipients SET decision = 'approved', decided_at = $2 WHERE offer_id = $1",
            [offer.id, '2030-05-10T10:00:00.123456Z'],
          ),
        ).resolves.toMatchObject({ rowCount: 2 })
        await expect(
          pool.query("UPDATE bookings SET status = 'cancelled', cancelled_at = $2 WHERE id = $1", [
            sourceId,
            appliedAt,
          ]),
        ).resolves.toMatchObject({ rowCount: 1 })
        await expect(
          insert(pool, 'departure_booking_handoffs', {
            organization_id: teamId,
            offer_id: offer.id,
            offer_version: offer.version,
            source_booking_id: sourceId,
            replacement_booking_id: replacementId,
            applying_user_id: hostId,
            applied_at: appliedAt,
            recipient_ids: recipientIds,
          }),
        ).resolves.toMatchObject({ rowCount: 1 })
        await expect(
          pool.query("UPDATE departure_handoff_offers SET state = 'closed' WHERE id = $1", [
            offer.id,
          ]),
        ).resolves.toMatchObject({ rowCount: 1 })
        const before = await snapshotPredecessor(pool)
        expect(before.map((rows) => rows.length)).toEqual([2, 2, 2, 1, 2, 1])

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await snapshotPredecessor(pool)).toEqual(before)
        await expect(
          pool.query('SELECT close_reason FROM departure_handoff_offers'),
        ).resolves.toMatchObject({ rows: [{ close_reason: null }] })
        await expect(
          pool.query('SELECT token_digest FROM departure_handoff_recipients'),
        ).resolves.toMatchObject({ rows: [{ token_digest: null }, { token_digest: null }] })
        await expect(
          pool.query('SELECT counted_sends FROM departure_handoff_send_budgets'),
        ).resolves.toMatchObject({ rows: [] })
        await expect(
          pool.query('SELECT job_id FROM departure_handoff_deliveries'),
        ).resolves.toMatchObject({ rows: [] })

        fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
        expect(await runMigrations(fresh.pool, directory)).toEqual(
          (await readdir(directory)).sort(),
        )
        const schema = await snapshotSchema(pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotSchema(pool)).toEqual(schema)
        expect(await snapshotPredecessor(pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
