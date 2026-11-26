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
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0147_workflow_webhook_outbox.sql'
const legacyEvents = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.reschedule_requested',
  'booking.reschedule_request_expired',
  'booking.attendee_no_show_changed',
] as const
const start = '2030-01-05T09:00:00.000Z'
const end = '2030-01-05T09:30:00.000Z'
const capturedAt = '2030-01-02T09:00:00.123456Z'
const attemptedAt = '2030-01-02T09:00:00.654321Z'

async function fixture(pool: pg.Pool) {
  const organizationId = randomUUID()
  const bookingId = randomUUID()
  const webhookId = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id,name,slug,"createdAt")
       VALUES ($1,'Webhook upgrade team','webhook-upgrade',$2)`,
      [organizationId, capturedAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO bookings (id,organization_id,start_at,end_at,title,source,created_at)
       VALUES ($1,$2,$3,$4,'Synthetic booking','web',$5)`,
      [bookingId, organizationId, start, end, capturedAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO webhooks (id,organization_id,url,events,secret_ciphertext,created_at,updated_at)
       VALUES ($1,$2,'https://hooks.example.test/synthetic',$3,decode('abcd','hex'),$4,$4)`,
      [webhookId, organizationId, legacyEvents, capturedAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  return { organizationId, bookingId, webhookId }
}

async function seedPredecessor(pool: pg.Pool) {
  const { organizationId, bookingId, webhookId } = await fixture(pool)
  const requestId = randomUUID()
  const attendeeId = randomUUID()
  const markedBy = randomUUID()
  const requestCreatedAt = '2030-01-01T09:00:00.123456Z'
  await pool.query(
    `INSERT INTO booking_reschedule_requests
       (id,booking_id,idempotency_key,state,expires_at,created_at,resolved_at)
     VALUES ($1,$2,$3,'expired',$4,$5,$4)`,
    [requestId, bookingId, randomUUID(), attemptedAt, requestCreatedAt],
  )
  await pool.query(
    `INSERT INTO booking_attendees (id,booking_id,name,email,time_zone,is_booker)
     VALUES ($1,$2,'Synthetic attendee','attendee@example.test','UTC',true)`,
    [attendeeId, bookingId],
  )
  for (const [index, event] of [...legacyEvents, 'booking.attendee_no_show_changed'].entries()) {
    const eventId = randomUUID()
    const attendance = event === 'booking.attendee_no_show_changed'
    const request = event.startsWith('booking.reschedule_request')
    const delivered = index % 2 === 0
    const payload = JSON.stringify({
      id: eventId,
      type: event,
      occurredAt: capturedAt,
      data: {
        bookingId,
        organizationId,
        eventTypeId: null,
        start,
        end,
        status: event === 'booking.cancelled' ? 'cancelled' : 'confirmed',
        source: 'web',
        rescheduledFromId: null,
        ...(request && { requestId }),
        ...(attendance && {
          attendeeId,
          noShowMarkedAt: delivered ? null : capturedAt,
          noShowMarkedBy: delivered ? null : markedBy,
        }),
      },
    })
    await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id,organization_id,booking_id,event_id,event_type,
         request_id,payload,status,attempts,http_status,last_error,created_at,last_attempt_at,delivered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,$9,$10,$11,$12,$13)`,
      [
        webhookId,
        organizationId,
        bookingId,
        eventId,
        event,
        request ? requestId : attendance ? eventId : null,
        payload,
        delivered ? 'delivered' : 'pending',
        delivered ? 204 : 503,
        delivered ? null : 'http_error',
        capturedAt,
        attemptedAt,
        delivered ? attemptedAt : null,
      ],
    )
  }
}

async function snapshotDeliveries(pool: pg.Pool) {
  // Keep timestamp precision, payload bytes and tuple identities in the comparison.
  return (
    await pool.query(
      `SELECT (to_jsonb(d) - 'workflow_run_id')::text AS row,xmin::text,ctid::text
       FROM webhook_deliveries d ORDER BY id`,
    )
  ).rows
}

async function assertDeliveryStorage(pool: pg.Pool) {
  const { organizationId, bookingId, webhookId } = await fixture(pool)
  const runId = randomUUID()
  const requestId = randomUUID()
  const delivery = (eventType: string, run: string | null = null, request: string | null = null) =>
    pool.query(
      `INSERT INTO webhook_deliveries
         (webhook_id,organization_id,booking_id,event_id,event_type,workflow_run_id,request_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')`,
      [webhookId, organizationId, bookingId, randomUUID(), eventType, run, request],
    )
  await expect(delivery('booking.unknown')).rejects.toMatchObject({
    code: '23514',
    constraint: 'webhook_deliveries_event_type_check',
  })
  await expect(delivery('workflow.executed')).rejects.toMatchObject({
    code: '23514',
    constraint: 'webhook_deliveries_workflow_run_kind',
  })
  await expect(delivery('booking.created', runId)).rejects.toMatchObject({
    code: '23514',
    constraint: 'webhook_deliveries_workflow_run_kind',
  })
  await expect(delivery('workflow.executed', runId, requestId)).rejects.toMatchObject({
    code: '23514',
    constraint: 'webhook_deliveries_workflow_run_request_exclusive',
  })
  const duplicate = { code: '23505', constraint: 'webhook_deliveries_identity_key' }
  await expect(delivery('booking.created')).resolves.toMatchObject({ rowCount: 1 })
  await expect(delivery('booking.created')).rejects.toMatchObject(duplicate)
  await expect(delivery('booking.reschedule_requested', null, requestId)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(delivery('booking.reschedule_requested', null, requestId)).rejects.toMatchObject(
    duplicate,
  )
  await expect(delivery('workflow.executed', runId)).resolves.toMatchObject({ rowCount: 1 })
  await expect(delivery('workflow.executed', randomUUID())).resolves.toMatchObject({ rowCount: 1 })
  await expect(delivery('workflow.executed', runId)).rejects.toMatchObject(duplicate)
}

describe.skipIf(!serverUrl)('workflow webhook outbox migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'keeps populated predecessor tuples, matches fresh schema and reruns without writes',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        const pool = upgraded.pool
        await seedPredecessor(pool)
        const before = await snapshotDeliveries(pool)
        expect(before).toHaveLength(7)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await snapshotDeliveries(pool)).toEqual(before)
        await expect(
          pool.query('SELECT count(workflow_run_id)::int AS runs FROM webhook_deliveries'),
        ).resolves.toMatchObject({ rows: [{ runs: 0 }] })

        fresh = await predecessor.clone(undefined, { migrate: false })
        expect(await runMigrations(fresh.pool, directory)).toEqual([migration])
        const upgradedSchema = await snapshotSchema(pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(upgradedSchema)
        const ledger = 'SELECT name,checksum FROM schema_migrations ORDER BY name'
        expect((await fresh.pool.query(ledger)).rows).toEqual((await pool.query(ledger)).rows)

        const applied = 'SELECT * FROM schema_migrations ORDER BY name'
        const beforeRerun = (await pool.query(applied)).rows
        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect((await pool.query(applied)).rows).toEqual(beforeRerun)
        expect(await snapshotDeliveries(pool)).toEqual(before)
        expect(await snapshotSchema(pool)).toEqual(upgradedSchema)
      } finally {
        await fresh?.drop()
        await upgraded?.drop()
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )

  it(
    'fails a storage assertion when any 0147 object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertDeliveryStorage,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ status }) => status)).toEqual([
        'covered',
        'covered',
        'covered',
        'covered',
      ])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
