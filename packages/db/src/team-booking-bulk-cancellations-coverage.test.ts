import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

async function assertReceiptProtections(pool: pg.Pool) {
  const organizationId = randomUUID()
  const actorId = randomUUID()
  const sessionId = randomUUID()
  const bookingId = randomUUID()
  const insertHeader = `INSERT INTO team_booking_bulk_cancellations
    (organization_id, actor_user_id, session_id, expires_at)
    VALUES ($1, $2, $3, clock_timestamp() + interval '9 minutes') RETURNING id`
  const insertItem = `INSERT INTO team_booking_bulk_cancellation_items
    (batch_id, ordinal, booking_id, preview_outcome) VALUES ($1, $2, $3, $4)`
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       VALUES ($1, 'Bulk preview team', 'bulk-preview-team', clock_timestamp())`,
      [organizationId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  const created = pool.query<{ id: string }>(insertHeader, [organizationId, actorId, sessionId])
  await expect(created).resolves.toMatchObject({ rowCount: 1 })
  const first = (await created).rows[0]?.id
  const another = pool.query<{ id: string }>(insertHeader, [organizationId, actorId, sessionId])
  await expect(another).resolves.toMatchObject({ rowCount: 1 })
  const second = (await another).rows[0]?.id
  expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  expect(second).toBeDefined()
  expect(first).not.toBe(second)

  await expect(
    pool.query(
      `INSERT INTO team_booking_bulk_cancellations
       (id, organization_id, actor_user_id, session_id, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '9 minutes')`,
      [first, organizationId, actorId, sessionId],
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'team_booking_bulk_cancellations_pkey' })
  await expect(pool.query(insertHeader, [randomUUID(), actorId, sessionId])).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_booking_bulk_cancellations_organization_id_fkey',
  })
  for (const column of [
    'organization_id',
    'actor_user_id',
    'session_id',
    'created_at',
    'expires_at',
  ]) {
    await expect(
      pool.query(`UPDATE team_booking_bulk_cancellations SET ${column} = NULL WHERE id = $1`, [
        first,
      ]),
    ).rejects.toMatchObject({ code: '23502', column })
  }
  for (const expiry of ['created_at', "created_at + interval '10 minutes 1 second'"]) {
    await expect(
      pool.query(
        `UPDATE team_booking_bulk_cancellations SET expires_at = ${expiry} WHERE id = $1`,
        [first],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_booking_bulk_cancellations_expiry_check',
    })
  }
  await expect(
    pool.query(`SELECT pg_get_indexdef(
      to_regclass('public.team_booking_bulk_cancellations_organization_idx')) AS definition`),
  ).resolves.toMatchObject({
    rows: [{ definition: expect.stringMatching(/USING btree \(organization_id\)$/) }],
  })

  await expect(pool.query(insertItem, [first, 1, bookingId, 'eligible'])).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query(insertItem, [first, 25, randomUUID(), 'booking_unavailable']),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query(insertItem, [second, 1, bookingId, 'eligible'])).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query(insertItem, [randomUUID(), 1, bookingId, 'eligible']),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_booking_bulk_cancellation_items_batch_id_fkey',
  })
  await expect(pool.query(insertItem, [first, 1, randomUUID(), 'eligible'])).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_booking_bulk_cancellation_items_pkey',
  })
  await expect(pool.query(insertItem, [first, 2, bookingId, 'eligible'])).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_booking_bulk_cancellation_items_batch_id_booking_id_key',
  })
  for (const ordinal of [0, 26]) {
    await expect(
      pool.query(insertItem, [first, ordinal, randomUUID(), 'eligible']),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_booking_bulk_cancellation_items_ordinal_check',
    })
  }
  await expect(pool.query(insertItem, [first, 2, randomUUID(), 'pending'])).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_booking_bulk_cancellation_items_preview_outcome_check',
  })
  await expect(pool.query(insertItem, [first, 2, null, 'eligible'])).rejects.toMatchObject({
    code: '23502',
    column: 'booking_id',
  })
  await expect(pool.query(insertItem, [first, 2, randomUUID(), null])).rejects.toMatchObject({
    code: '23502',
    column: 'preview_outcome',
  })

  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [organizationId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query('SELECT id FROM team_booking_bulk_cancellations')).resolves.toMatchObject(
    {
      rows: [],
    },
  )
  await expect(
    pool.query('SELECT batch_id FROM team_booking_bulk_cancellation_items'),
  ).resolves.toMatchObject({
    rows: [],
  })
}

describe.skipIf(!process.env.DATABASE_URL)(
  'team booking bulk cancellation preview constraints',
  () => {
    it('detects a missing constraint for each independently droppable object', async () => {
      const report = await checkConstraintCoverage({
        serverUrl: process.env.DATABASE_URL as string,
        migration: '0196_team_booking_bulk_cancellations.sql',
        assertions: assertReceiptProtections,
        concurrency: 2,
        allowList: {
          'constraint public.team_booking_bulk_cancellations.team_booking_bulk_cancellations_pkey':
            'The item foreign key needs this target primary key, which PostgreSQL cannot drop in isolation.',
        },
      })
      expect(report.problems).toEqual([])
    }, 600_000)
  },
)
