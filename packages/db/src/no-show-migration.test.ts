import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0070_attendee_no_show.sql'
const PREVIOUS_EVENTS = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.reschedule_requested',
  'booking.reschedule_request_expired',
]
describe.skipIf(!serverUrl)('attendee no-show migration', () => {
  it('upgrades from every earlier migration, matches a fresh install, reruns without writes, and keeps the previous capture working', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-no-show-'))
    let old: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      old = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(old.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(old.pool, directory)
      await seedLater(old.pool)
      const pool = old.pool
      // A 0064 reschedule-request receipt must survive and keep its request-scoped identity.
      const requestId = (
        await pool.query(`INSERT INTO webhook_deliveries (webhook_id,organization_id,booking_id,event_id,event_type,payload,request_id)
          SELECT webhook_id,organization_id,booking_id,gen_random_uuid(),'booking.reschedule_requested','{}',gen_random_uuid()
          FROM webhook_deliveries WHERE event_type='booking.created' AND request_id IS NULL
          ORDER BY id LIMIT 1 RETURNING request_id`)
      ).rows[0].request_id as string
      const snapshot = async () =>
        (
          await pool.query(
            `SELECT to_jsonb(a)-'no_show_marked_at'-'no_show_marked_by' AS row FROM booking_attendees a ORDER BY id`,
          )
        ).rows
      const webhookSnapshot = async () => ({
        hooks: (await pool.query('SELECT to_jsonb(w) AS row FROM webhooks w ORDER BY id')).rows,
        deliveries: (
          await pool.query('SELECT to_jsonb(w) AS row FROM webhook_deliveries w ORDER BY id')
        ).rows,
        indexes: (
          await pool.query(
            `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='webhook_deliveries' ORDER BY 1`,
          )
        ).rows,
      })
      const webhookBefore = await webhookSnapshot()
      expect(webhookBefore.hooks.length).toBeGreaterThan(0)
      expect(webhookBefore.deliveries.length).toBeGreaterThan(0)
      expect(webhookBefore.indexes).toContainEqual({
        indexname: 'webhook_deliveries_webhook_id_booking_id_event_type_request_key',
        indexdef: expect.stringContaining(
          '(webhook_id, booking_id, event_type, request_id) NULLS NOT DISTINCT',
        ),
      })
      const before = await snapshot()
      expect(before.length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(old.pool, directory)).toEqual([migration])
      expect(await snapshot()).toEqual(before)
      expect(await webhookSnapshot()).toEqual(webhookBefore)
      expect(
        (
          await old.pool.query(
            'SELECT count(*)::int AS n FROM booking_attendees WHERE no_show_marked_at IS NOT NULL OR no_show_marked_by IS NOT NULL',
          )
        ).rows,
      ).toEqual([{ n: 0 }])
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(old.pool))
      const ledger = (await old.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows
      expect(await runMigrations(old.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshot()).toEqual(before)
      expect(await webhookSnapshot()).toEqual(webhookBefore)
      expect((await old.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
        ledger,
      )
      await expect(
        old.pool.query('UPDATE booking_attendees SET no_show_marked_at=now()'),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        old.pool.query('UPDATE booking_attendees SET no_show_marked_by=gen_random_uuid()'),
      ).rejects.toMatchObject({ code: '23514' })

      // The previous release's capture statement, unchanged, against the upgraded schema.
      const target = (
        await pool.query(
          `SELECT webhook_id, organization_id, booking_id FROM webhook_deliveries
          WHERE event_type='booking.created' AND request_id IS NULL ORDER BY id LIMIT 1`,
        )
      ).rows[0]
      const capture = (eventType: string, request: string | null) =>
        pool.query(
          `insert into "webhook_deliveries" ("webhook_id", "organization_id", "booking_id", "event_id", "event_type", "request_id", "payload", "created_at")
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict ("webhook_id", "booking_id", "event_type", "request_id") do nothing returning "id"`,
          [
            target.webhook_id,
            target.organization_id,
            target.booking_id,
            randomUUID(),
            eventType,
            request,
            '{}',
            new Date(),
          ],
        )
      expect((await capture('booking.created', null)).rowCount).toBe(0)
      // The seeded receipt belongs to this target; a replacement request is a new receipt.
      expect((await capture('booking.reschedule_requested', requestId)).rowCount).toBe(0)
      const replacement = randomUUID()
      expect((await capture('booking.reschedule_requested', replacement)).rowCount).toBe(1)
      expect((await capture('booking.reschedule_requested', replacement)).rowCount).toBe(0)
      const change = randomUUID()
      expect((await capture('booking.attendee_no_show_changed', change)).rowCount).toBe(1)
      expect((await capture('booking.attendee_no_show_changed', change)).rowCount).toBe(0)
      expect((await capture('booking.attendee_no_show_changed', randomUUID())).rowCount).toBe(1)
      await expect(capture('booking.unknown', randomUUID())).rejects.toMatchObject({
        code: '23514',
      })
      // Previous subscriptions keep validating; only the new event is added.
      await pool.query('UPDATE webhooks SET events=$1', [PREVIOUS_EVENTS])
      await pool.query('UPDATE webhooks SET events=$1', [
        [...PREVIOUS_EVENTS, 'booking.attendee_no_show_changed'],
      ])
      await expect(
        pool.query('UPDATE webhooks SET events=$1', [
          ['booking.attendee_no_show_changed', 'booking.unknown'],
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await fresh?.drop()
      await old?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
