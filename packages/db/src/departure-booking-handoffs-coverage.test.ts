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
const migration = '0199_departure_booking_handoffs.sql'
const offerTable = 'departure_handoff_offers'
const recipientTable = 'departure_handoff_recipients'
const receiptTable = 'departure_booking_handoffs'
const teamTables = [offerTable, recipientTable, receiptTable]
const issuedAt = '2030-05-10T09:00:00.123456Z'
const decidedAt = '2030-05-10T10:00:00.123456Z'
const appliedAt = '2030-05-10T11:00:00.123456Z'
const expiresAt = '2030-05-11T09:00:00.123456Z'
const targetStart = '2030-05-12T09:00:00.123456Z'
const digest = 'a'.repeat(64)

async function seedBookings(pool: pg.Pool) {
  const teamId = randomUUID()
  const otherTeamId = randomUUID()
  const proposerId = randomUUID()
  const applyingId = randomUUID()
  const departingId = randomUUID()
  const successorId = randomUUID()
  const eventId = randomUUID()
  const sourceId = randomUUID()
  const replacementId = randomUUID()
  const anotherSourceId = randomUUID()
  const otherBookingId = randomUUID()
  await expect(
    pool.query(
      `WITH people AS (
        INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES
          ($3, 'Fixture owner', 'handoff-owner@example.test', true),
          ($4, 'Fixture admin', 'handoff-admin@example.test', true),
          ($5, 'Original host', 'handoff-departing@example.test', true),
          ($6, 'Successor host', 'handoff-successor@example.test', true)
      ), teams AS (
        INSERT INTO auth.organization (id, name, slug, "createdAt", metadata) VALUES
          ($1, 'Team 東京', 'handoff-team', $12, '{"department":"support"}'),
          ($2, 'Another team', 'handoff-other-team', $12, NULL)
      ), membership AS (
        INSERT INTO auth.member ("userId", "organizationId", role, "createdAt") VALUES
          ($3, $1, 'owner', $12), ($4, $1, 'admin', $12), ($5, $1, 'member', $12),
          ($6, $1, 'member', $12), ($6, $2, 'owner', $12)
      ), event_type AS (
        INSERT INTO event_types (id, organization_id, slug, title, duration_minutes, allow_guests, questions)
        VALUES ($7, $1, 'handoff', 'Handoff fixture event', 30, true,
                '[{"id":"notes","label":"Notes","type":"short_text"}]')
      ), event_host AS (
        INSERT INTO event_type_hosts (event_type_id, user_id) VALUES ($7, $5)
      ), booking AS (
        INSERT INTO bookings (id, organization_id, event_type_id, start_at, end_at,
                              title, source, required_host_user_ids, location, responses, manage_token_hash)
        VALUES ($8, $1, $7, '2030-05-12T09:00:00.123456Z', '2030-05-12T09:30:00.123456Z',
                'Fixture team booking', 'web', ARRAY[$5::uuid], '{"kind":"in_person","address":"Fixture room"}',
                '{"notes":"Saved fixture answer"}', decode(repeat('01', 32), 'hex')),
               ($9, $1, $7, '2030-05-12T10:00:00.123456Z', '2030-05-12T10:30:00.123456Z',
                'Another fixture booking', 'web', ARRAY[$6::uuid], NULL, '{}', NULL),
               ($10, $1, $7, '2030-05-12T11:00:00.123456Z', '2030-05-12T11:30:00.123456Z',
                'Later fixture booking', 'web', ARRAY[$5::uuid], NULL, '{}', NULL),
               ($11, $2, NULL, '2030-05-12T13:00:00.123456Z', '2030-05-12T13:30:00.123456Z',
                'Different team booking', 'web', ARRAY[$6::uuid], NULL, '{}', NULL)
        RETURNING id, required_host_user_ids
      ), host AS (
        INSERT INTO booking_hosts (booking_id, user_id)
        SELECT id, required_host_user_ids[1] FROM booking
      )
      INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
      VALUES ($8, 'Fixture booker', 'booker@example.test', 'Asia/Tokyo', 'ja', true),
             ($8, 'Fixture guest', 'guest@example.test', 'America/Los_Angeles', NULL, false)`,
      [
        teamId,
        otherTeamId,
        proposerId,
        applyingId,
        departingId,
        successorId,
        eventId,
        sourceId,
        replacementId,
        anotherSourceId,
        otherBookingId,
        issuedAt,
      ],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  return {
    teamId,
    otherTeamId,
    proposerId,
    applyingId,
    departingId,
    successorId,
    sourceId,
    replacementId,
    anotherSourceId,
    otherBookingId,
  }
}

type Fixture = Awaited<ReturnType<typeof seedBookings>>

function offerValues(fixture: Fixture, sourceId = fixture.sourceId) {
  return {
    organization_id: fixture.teamId,
    source_booking_id: sourceId,
    id: randomUUID(),
    version: 1,
    state: 'live',
    issued_at: issuedAt,
    expires_at: expiresAt,
    departing_user_id: fixture.departingId,
    proposer_user_id: fixture.proposerId,
    target_start_at: targetStart,
    duration_minutes: 30,
    location_option_id: randomUUID(),
    terms_digest: digest,
  }
}

type OfferValues = ReturnType<typeof offerValues>

function recipientValues(offer: OfferValues, recipientKey = 'booker@example.test') {
  return {
    organization_id: offer.organization_id,
    source_booking_id: offer.source_booking_id,
    offer_id: offer.id,
    offer_version: offer.version,
    id: randomUUID(),
    recipient_key: recipientKey,
    decision: 'approved',
    decided_at: decidedAt,
  }
}

function receiptValues(fixture: Fixture, offer: OfferValues, recipientIds: string[]) {
  return {
    organization_id: offer.organization_id,
    source_booking_id: offer.source_booking_id,
    offer_id: offer.id,
    offer_version: offer.version,
    replacement_booking_id: fixture.replacementId,
    applying_user_id: fixture.applyingId,
    applied_at: appliedAt,
    recipient_ids: recipientIds,
  }
}

function insertRow(pool: pg.Pool | pg.PoolClient, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  const placeholders = columns.map((_, index) => `$${index + 1}`)
  return pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(values),
  )
}

async function assertRequired(
  pool: pg.Pool,
  table: string,
  values: Record<string, unknown>,
  columns: string[],
) {
  for (const column of columns) {
    await expect(insertRow(pool, table, { ...values, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
}

async function withRollback(pool: pg.Pool, assertions: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await assertions(client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }
}

async function snapshotRows(pool: pg.Pool, tables: readonly string[]) {
  // The source booking has a microsecond timestamp, which JSON text preserves.
  return Promise.all(
    tables.map(async (table) => {
      const result = await pool.query(
        `SELECT to_jsonb(t)::text AS row, xmin::text, ctid::text FROM ${table} t ORDER BY row`,
      )
      return result.rows
    }),
  )
}

async function assertOfferProtections(pool: pg.Pool, fixture: Fixture) {
  const offer = offerValues(fixture)
  await assertRequired(pool, offerTable, offer, [
    'proposer_user_id',
    'departing_user_id',
    'target_start_at',
    'duration_minutes',
    'terms_digest',
    'issued_at',
    'expires_at',
    'state',
  ])
  for (const [patch, constraint] of [
    [{ version: 0 }, 'version'],
    [{ duration_minutes: 0 }, 'duration'],
    [{ terms_digest: 'A'.repeat(64) }, 'digest'],
    [{ terms_digest: 'a'.repeat(63) }, 'digest'],
    [{ state: 'approved' }, 'state'],
    [{ expires_at: issuedAt }, 'window'],
    [
      { expires_at: '2030-05-12T09:00:00.123457Z', target_start_at: '2030-05-13T09:00:00Z' },
      'window',
    ],
    [{ expires_at: '2030-05-10T13:00:00Z', target_start_at: '2030-05-10T12:00:00Z' }, 'window'],
    [{ target_start_at: 'infinity' }, 'window'],
  ] as const) {
    await expect(insertRow(pool, offerTable, { ...offer, ...patch })).rejects.toMatchObject({
      code: '23514',
      constraint: `departure_handoff_offers_${constraint}_check`,
    })
  }
  await expect(
    insertRow(pool, offerTable, { ...offer, source_booking_id: fixture.otherBookingId }),
  ).rejects.toMatchObject({ code: '23503', constraint: 'departure_handoff_offers_source_fk' })

  const { state: _state, ...defaulted } = offer
  await expect(insertRow(pool, offerTable, defaulted)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT state FROM departure_handoff_offers WHERE id = $1', [offer.id]),
  ).resolves.toMatchObject({ rows: [{ state: 'live' }] })
  await expect(
    insertRow(pool, offerTable, { ...offer, id: randomUUID(), state: 'closed' }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_offers_source_version_key',
  })
  await expect(insertRow(pool, offerTable, { ...offer, version: 2 })).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_offers_one_live',
  })
  const updateOffer = (assignment: string) =>
    pool.query(`UPDATE departure_handoff_offers SET ${assignment} WHERE id = $1 AND version = 1`, [
      offer.id,
    ])
  for (const assignment of [
    'version = 3',
    "terms_digest = repeat('b', 64)",
    'location_option_id = NULL',
    'duration_minutes = 60',
    "target_start_at = target_start_at + interval '1 hour'",
    "issued_at = issued_at - interval '1 hour'",
    "expires_at = expires_at - interval '1 hour'",
    'departing_user_id = proposer_user_id',
    'proposer_user_id = departing_user_id',
  ]) {
    await expect(updateOffer(assignment)).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_offers_immutable',
    })
  }
  await expect(updateOffer("state = 'closed'")).resolves.toMatchObject({ rowCount: 1 })
  await expect(updateOffer("state = 'live'")).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_offers_immutable',
  })
  const current = { ...offer, version: 2 }
  await expect(insertRow(pool, offerTable, current)).resolves.toMatchObject({ rowCount: 1 })
  return { previous: offer, current }
}

async function assertRecipientProtections(
  pool: pg.Pool,
  previous: OfferValues,
  current: OfferValues,
  fixture: Fixture,
) {
  const earlierApproval = recipientValues(previous)
  await expect(insertRow(pool, recipientTable, earlierApproval)).resolves.toMatchObject({
    rowCount: 1,
  })
  const booker = recipientValues(current)
  const guest = recipientValues(current, 'guest@example.test')
  await assertRequired(pool, recipientTable, booker, [
    'organization_id',
    'source_booking_id',
    'offer_id',
    'offer_version',
    'recipient_key',
  ])
  for (const recipient_key of ['', 'Booker@example.test', ' booker@example.test ']) {
    await expect(
      insertRow(pool, recipientTable, { ...booker, recipient_key }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_recipients_mailbox_check',
    })
  }
  for (const patch of [
    { decision: null },
    { decision: 'pending' },
    { decided_at: null },
    { decided_at: 'infinity' },
  ]) {
    await expect(insertRow(pool, recipientTable, { ...booker, ...patch })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_recipients_decision_check',
    })
  }
  for (const patch of [
    { organization_id: fixture.otherTeamId },
    { source_booking_id: fixture.anotherSourceId },
    { offer_version: 3 },
    { offer_id: randomUUID() },
  ]) {
    await expect(insertRow(pool, recipientTable, { ...booker, ...patch })).rejects.toMatchObject({
      code: '23503',
      constraint: 'departure_handoff_recipients_offer_fk',
    })
  }
  await expect(insertRow(pool, recipientTable, booker)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insertRow(pool, recipientTable, {
      ...recipientValues(previous, guest.recipient_key),
      id: booker.id,
    }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_recipients_pkey',
  })
  await expect(
    insertRow(pool, recipientTable, { ...booker, id: randomUUID() }),
  ).rejects.toMatchObject({ code: '23505', constraint: 'departure_handoff_recipients_mailbox_key' })
  const { decision: _decision, decided_at: _decidedAt, ...pending } = guest
  await expect(insertRow(pool, recipientTable, pending)).resolves.toMatchObject({ rowCount: 1 })
  const updateBooker = (assignment: string) =>
    pool.query(`UPDATE departure_handoff_recipients SET ${assignment} WHERE id = $1`, [booker.id])
  for (const assignment of [
    "recipient_key = 'different@example.test'",
    'offer_version = 1',
    "decision = 'declined'",
    'decision = NULL, decided_at = NULL',
    "decided_at = decided_at + interval '1 minute'",
  ]) {
    await expect(updateBooker(assignment)).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_recipients_immutable',
    })
  }
  return { earlierApproval, booker, guest }
}

async function assertReceiptProtections(
  pool: pg.Pool,
  fixture: Fixture,
  current: OfferValues,
  { earlierApproval, booker, guest }: Awaited<ReturnType<typeof assertRecipientProtections>>,
) {
  const receipt = receiptValues(fixture, current, [booker.id, guest.id])
  await expect(insertRow(pool, receiptTable, receipt)).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_booking_handoffs_evidence',
  })
  await expect(
    pool.query(
      "UPDATE departure_handoff_recipients SET decision = 'approved', decided_at = $2 WHERE id = $1",
      [guest.id, decidedAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await assertRequired(pool, receiptTable, receipt, [
    'organization_id',
    'replacement_booking_id',
    'offer_id',
    'offer_version',
    'applying_user_id',
    'applied_at',
    'recipient_ids',
  ])
  for (const patch of [
    { recipient_ids: [booker.id] },
    { recipient_ids: [booker.id, booker.id] },
    { recipient_ids: [booker.id, null] },
    { recipient_ids: [earlierApproval.id, guest.id] },
    { applied_at: expiresAt },
    { applied_at: issuedAt },
  ]) {
    await expect(insertRow(pool, receiptTable, { ...receipt, ...patch })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_booking_handoffs_evidence',
    })
  }
  for (const recipient_ids of [[], [[booker.id, guest.id]]]) {
    await expect(
      insertRow(pool, receiptTable, { ...receipt, recipient_ids }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_booking_handoffs_recipients_check',
    })
  }
  await expect(
    insertRow(pool, receiptTable, { ...receipt, replacement_booking_id: fixture.sourceId }),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_booking_handoffs_distinct_check',
  })
  await expect(
    insertRow(pool, receiptTable, { ...receipt, replacement_booking_id: fixture.otherBookingId }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'departure_booking_handoffs_replacement_fk',
  })
  // A receipt cannot precede the proposal version it records.
  await withRollback(pool, async (client) => {
    await expect(
      insertRow(client, receiptTable, { ...receipt, offer_version: 3 }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'departure_booking_handoffs_offer_fk' })
  })
  await expect(insertRow(pool, receiptTable, receipt)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('DELETE FROM departure_handoff_offers WHERE id = $1 AND version = $2', [
      current.id,
      current.version,
    ]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'departure_booking_handoffs_immutable' })
  await expect(
    insertRow(pool, receiptTable, { ...receipt, replacement_booking_id: fixture.anotherSourceId }),
  ).rejects.toMatchObject({ code: '23505', constraint: 'departure_booking_handoffs_pkey' })
  const anotherOffer = offerValues(fixture, fixture.anotherSourceId)
  const anotherRecipient = recipientValues(anotherOffer)
  await expect(insertRow(pool, offerTable, anotherOffer)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insertRow(pool, recipientTable, anotherRecipient)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    insertRow(pool, receiptTable, receiptValues(fixture, anotherOffer, [anotherRecipient.id])),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_booking_handoffs_replacement_key',
  })
  await expect(
    pool.query(
      'UPDATE departure_booking_handoffs SET applying_user_id = $2 WHERE source_booking_id = $1',
      [fixture.sourceId, fixture.proposerId],
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: 'departure_booking_handoffs_immutable' })
  await expect(
    pool.query('DELETE FROM departure_booking_handoffs WHERE source_booking_id = $1', [
      fixture.sourceId,
    ]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'departure_booking_handoffs_immutable' })
}

async function assertStorageProtections(pool: pg.Pool) {
  const fixture = await seedBookings(pool)
  const { previous, current } = await assertOfferProtections(pool, fixture)
  const recipients = await assertRecipientProtections(pool, previous, current, fixture)
  await assertReceiptProtections(pool, fixture, current, recipients)

  const beforeRemoval = await snapshotRows(pool, teamTables)
  await expect(
    pool.query(
      'DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = ANY($2::uuid[])',
      [fixture.teamId, [fixture.applyingId, fixture.departingId]],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  expect(await snapshotRows(pool, teamTables)).toEqual(beforeRemoval)
  await expect(
    pool.query('DELETE FROM departure_handoff_recipients WHERE source_booking_id = $1', [
      fixture.sourceId,
    ]),
  ).resolves.toMatchObject({ rowCount: 3 })
  await expect(
    pool.query('SELECT recipient_ids FROM departure_booking_handoffs'),
  ).resolves.toMatchObject({
    rows: [{ recipient_ids: [recipients.booker.id, recipients.guest.id] }],
  })

  // Verify each booking cascade independently, leaving the original pair for team deletion.
  for (const bookingId of [fixture.sourceId, fixture.replacementId]) {
    await withRollback(pool, async (client) => {
      await expect(
        client.query('DELETE FROM bookings WHERE id = $1', [bookingId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        client.query('SELECT source_booking_id FROM departure_booking_handoffs'),
      ).resolves.toMatchObject({ rows: [] })
    })
  }
  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [fixture.teamId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  expect(await snapshotRows(pool, teamTables)).toEqual([[], [], []])
  await expect(pool.query('SELECT id FROM bookings')).resolves.toMatchObject({
    rows: [{ id: fixture.otherBookingId }],
  })
}

describe.skipIf(!serverUrl)('departure booking handoff migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'detects a missing database protection for each independently droppable object',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertStorageProtections,
        concurrency: 2,
        allowList: {
          'constraint public.departure_booking_handoffs.departure_booking_handoffs_source_fk':
            'The exact-offer foreign key and the offer’s source foreign key already enforce and cascade this binding.',
          'constraint public.departure_handoff_offers.departure_handoff_offers_pkey':
            'Recipient and receipt foreign keys need this target key, which PostgreSQL cannot drop in isolation.',
        },
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it('enforces handoff scope, immutable consent and receipt retention', async () => {
    const installed = await createTestDatabase(serverUrl as string)
    try {
      await assertStorageProtections(installed.pool)
    } finally {
      await installed.drop()
    }
  })

  it(
    'preserves predecessor team bookings and their host snapshots, matches fresh install, and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      const existingTables = [
        'auth."user"',
        'auth.organization',
        'auth.member',
        'event_types',
        'event_type_hosts',
        'bookings',
        'booking_hosts',
        'booking_attendees',
      ]
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        const { pool } = upgraded
        const fixture = await seedBookings(pool)
        const before = await snapshotRows(pool, existingTables)
        expect(before.map((rows) => rows.length)).toEqual([4, 2, 5, 1, 1, 4, 4, 2])

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await snapshotRows(pool, existingTables)).toEqual(before)
        expect(await snapshotRows(pool, teamTables)).toEqual([[], [], []])
        await expect(
          pool.query('UPDATE bookings SET required_host_user_ids = ARRAY[$2::uuid] WHERE id = $1', [
            fixture.sourceId,
            fixture.successorId,
          ]),
        ).rejects.toMatchObject({ code: '23514', message: 'required booking hosts are immutable' })

        fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
        const stagedMigrations = (await readdir(directory)).sort()
        expect(await runMigrations(fresh.pool, directory)).toEqual(stagedMigrations)
        const schema = await snapshotSchema(pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)

        const offer = offerValues(fixture)
        const recipient = recipientValues(offer)
        await expect(insertRow(pool, offerTable, offer)).resolves.toMatchObject({ rowCount: 1 })
        await expect(insertRow(pool, recipientTable, recipient)).resolves.toMatchObject({
          rowCount: 1,
        })
        const added = await snapshotRows(pool, teamTables)
        expect(added.map((rows) => rows.length)).toEqual([1, 1, 0])
        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotSchema(pool)).toEqual(schema)
        expect(await snapshotRows(pool, existingTables)).toEqual(before)
        expect(await snapshotRows(pool, teamTables)).toEqual(added)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
