import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRecord } from './group-seats-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const issuedAt = '2032-05-04T09:00:00Z'
const decidedAt = '2032-05-04T10:00:00Z'
const appliedAt = '2032-05-04T11:00:00Z'
const startAt = '2032-05-04T12:00:00Z'

async function seedTeam(pool: pg.Pool) {
  const suffix = randomUUID()
  const organizationId = await insertRecord(pool, 'auth.organization', {
    name: 'Handoff team',
    slug: `handoff-${suffix}`,
    createdAt: issuedAt,
  })
  const managerId = await insertRecord(pool, 'auth."user"', {
    name: 'Handoff manager',
    email: `manager-${suffix}@example.test`,
    emailVerified: true,
  })
  const departingId = await insertRecord(pool, 'auth."user"', {
    name: 'Departing host',
    email: `departing-${suffix}@example.test`,
    emailVerified: true,
  })
  await insertRecord(pool, 'auth.member', {
    organizationId,
    userId: managerId,
    role: 'owner',
    createdAt: issuedAt,
  })
  const eventId = await insertRecord(pool, 'event_types', {
    organization_id: organizationId,
    slug: 'handoff-race',
    title: 'Appointment',
    duration_minutes: 30,
  })
  return { organizationId, managerId, departingId, eventId }
}

type Team = Awaited<ReturnType<typeof seedTeam>>

async function seedBooking(pool: pg.Pool, team: Team, status: 'cancelled' | 'confirmed') {
  const source = status === 'cancelled'
  return insertRecord(pool, 'bookings', {
    organization_id: team.organizationId,
    event_type_id: team.eventId,
    source: 'web',
    title: 'Appointment',
    start_at: startAt,
    end_at: '2032-05-04T12:30:00Z',
    required_host_user_ids: [source ? team.departingId : team.managerId],
    status,
    cancelled_at: source ? appliedAt : null,
  })
}

async function seedApprovedOffer(
  pool: pg.Pool,
  team: Team,
  sourceId: string,
  version: number,
  state: 'live' | 'closed',
) {
  const offerId = await insertRecord(pool, 'departure_handoff_offers', {
    id: randomUUID(),
    organization_id: team.organizationId,
    source_booking_id: sourceId,
    state,
    version,
    issued_at: issuedAt,
    expires_at: startAt,
    departing_user_id: team.departingId,
    proposer_user_id: team.managerId,
    target_start_at: startAt,
    duration_minutes: 30,
    terms_digest: 'a'.repeat(64),
  })
  const recipientId = await insertRecord(pool, 'departure_handoff_recipients', {
    id: randomUUID(),
    organization_id: team.organizationId,
    source_booking_id: sourceId,
    offer_id: offerId,
    offer_version: version,
    recipient_key: 'booker@example.test',
    decision: 'approved',
    decided_at: decidedAt,
  })
  return { sourceId, offerId, version, recipientId }
}

type Receipt = Awaited<ReturnType<typeof seedApprovedOffer>> & { replacementId: string }

function insertReceipt(client: pg.PoolClient, team: Team, receipt: Receipt) {
  return client.query(
    `INSERT INTO departure_booking_handoffs
      (organization_id, source_booking_id, offer_id, offer_version, replacement_booking_id,
       applying_user_id, applied_at, recipient_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      team.organizationId,
      receipt.sourceId,
      receipt.offerId,
      receipt.version,
      receipt.replacementId,
      team.managerId,
      appliedAt,
      [receipt.recipientId],
    ],
  )
}

async function assertReceiptRace(
  pool: pg.Pool,
  team: Team,
  winner: Receipt,
  contender: Receipt,
  constraint: string,
) {
  const first = await pool.connect()
  let second: pg.PoolClient | undefined
  try {
    second = await pool.connect()
    const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      ?.pid
    const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]?.pid
    await first.query('BEGIN')
    await second.query('BEGIN')
    await expect(insertReceipt(first, team, winner)).resolves.toMatchObject({ rowCount: 1 })

    // Wait for PostgreSQL to observe the real lock conflict before committing the winner.
    // Also observe early completion so removing uniqueness fails the rejection assertion.
    let settled = false
    const attempt = insertReceipt(second, team, contender)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    const isBlocked = async () =>
      (
        await pool.query<{ blocked: boolean }>(
          'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
          [firstPid, secondPid],
        )
      ).rows[0]?.blocked === true
    await expect.poll(async () => settled || (await isBlocked())).toBe(true)
    const contended = !settled && (await isBlocked())

    await first.query('COMMIT')
    await expect(attempt).resolves.toMatchObject({ code: '23505', constraint })
    expect(contended).toBe(true)
  } finally {
    try {
      await first.query('ROLLBACK')
    } finally {
      first.release()
      if (second) {
        try {
          await second.query('ROLLBACK')
        } finally {
          second.release()
        }
      }
    }
  }

  const { rows } = await pool.query(
    `SELECT source_booking_id, replacement_booking_id, offer_id, offer_version, recipient_ids
     FROM departure_booking_handoffs WHERE organization_id = $1`,
    [team.organizationId],
  )
  expect(rows).toEqual([
    {
      source_booking_id: winner.sourceId,
      replacement_booking_id: winner.replacementId,
      offer_id: winner.offerId,
      offer_version: winner.version,
      recipient_ids: [winner.recipientId],
    },
  ])
}

describe.skipIf(!serverUrl)('departure booking handoff receipt races', () => {
  let database: TestDatabase
  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string, undefined, { tag: 'handoff_race' })
  })
  afterAll(async () => {
    await database?.drop()
  })

  it('allows only one receipt across competing offers for the same source booking', async () => {
    const { pool } = database
    const team = await seedTeam(pool)
    const sourceId = await seedBooking(pool, team, 'cancelled')
    const first = await seedApprovedOffer(pool, team, sourceId, 1, 'closed')
    const second = await seedApprovedOffer(pool, team, sourceId, 2, 'live')

    await assertReceiptRace(
      pool,
      team,
      { ...first, replacementId: await seedBooking(pool, team, 'confirmed') },
      { ...second, replacementId: await seedBooking(pool, team, 'confirmed') },
      'departure_booking_handoffs_pkey',
    )
  })

  it('allows only one source to claim the same replacement booking', async () => {
    const { pool } = database
    const team = await seedTeam(pool)
    const firstSourceId = await seedBooking(pool, team, 'cancelled')
    const secondSourceId = await seedBooking(pool, team, 'cancelled')
    const replacementId = await seedBooking(pool, team, 'confirmed')
    const first = await seedApprovedOffer(pool, team, firstSourceId, 1, 'live')
    const second = await seedApprovedOffer(pool, team, secondSourceId, 1, 'live')

    await assertReceiptRace(
      pool,
      team,
      { ...first, replacementId },
      { ...second, replacementId },
      'departure_booking_handoffs_replacement_key',
    )
  })
})
