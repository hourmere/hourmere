import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createDb, runMigrations } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { expect, it } from 'vitest'
import { createWebhook } from './service.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0028_webhook_interrupted_deliveries.sql'

it.skipIf(!serverUrl)(
  'preserves predecessor webhook data, supports fresh installs and reruns safely',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hourmere-webhook-predecessor-'))
    let owned: TestDatabase | undefined
    try {
      owned = await createTestDatabase(serverUrl as string, undefined, {
        migrate: false,
        tag: 'webhook_upgrade',
      })
      const pool = owned.pool
      const source = new URL('../../db/migrations/', import.meta.url)
      const predecessors = (await readdir(source))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of predecessors) await copyFile(new URL(file, source), join(dir, file))
      const predecessor = await runMigrations(pool, dir)
      expect(predecessor).toEqual(predecessors)
      expect(predecessor.at(-1)).toBe('0027_nontransitive_invited_signup.sql')
      const db = createDb(pool)
      const user = await createTestUser(db)
      const key = Buffer.alloc(32, 9).toString('base64')
      const { webhook } = await createWebhook(
        testContext(db, user.principal),
        {
          enabled: true,
          encryptionKey: key,
        },
        { url: 'https://hooks.example.com/bookings', events: ['booking.created'] },
      )
      const f = createFixtures(db)
      for (const [i, error] of [
        null,
        'transport_error',
        'http_error',
        'disabled',
        'expired',
        'secret_unavailable',
      ].entries()) {
        const bookingId = await f.booking(
          user.principal.organization.id,
          [],
          '2026-11-03T09:00Z',
          '2026-11-03T09:30Z',
        )
        await db
          .insertInto('webhook_deliveries')
          .values({
            webhook_id: webhook.id,
            organization_id: webhook.organizationId,
            booking_id: bookingId,
            event_id: bookingId,
            event_type: 'booking.created',
            payload: JSON.stringify({ id: bookingId, data: { bookingId } }),
            status: i === 0 ? 'delivered' : i < 3 ? 'pending' : i === 5 ? 'failed' : 'skipped',
            attempts: i === 5 ? 13 : i + 1,
            last_error: error,
            http_status: i === 0 ? 204 : i === 2 ? 503 : null,
            last_attempt_at: new Date('2026-11-01T12:00:00Z'),
            delivered_at: i === 0 ? new Date('2026-11-01T12:00:00Z') : null,
          })
          .execute()
      }
      const snapshot = async () => ({
        webhooks: await db.selectFrom('webhooks').selectAll().orderBy('id').execute(),
        deliveries: await db.selectFrom('webhook_deliveries').selectAll().orderBy('id').execute(),
      })
      const before = await snapshot()
      // Only this migration joins the predecessor set, so later migrations cannot change
      // what this test applies or observes.
      await copyFile(new URL(migration, source), join(dir, migration))
      expect(await runMigrations(pool, dir)).toEqual([migration])
      expect(isDeepStrictEqual(await snapshot(), before)).toBe(true)
      expect(await runMigrations(pool, dir)).toEqual([])
      for (const error of ['interrupted', 'job_missing'])
        await db
          .updateTable('webhook_deliveries')
          .set({ last_error: error })
          .where('webhook_id', '=', webhook.id)
          .execute()
      await expect(
        db
          .updateTable('webhook_deliveries')
          .set({ last_error: 'unbounded_external_error' })
          .where('webhook_id', '=', webhook.id)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' })
      await pool.query('DROP SCHEMA public CASCADE')
      await pool.query('DROP SCHEMA auth CASCADE')
      await pool.query('CREATE SCHEMA public')
      expect(await runMigrations(pool, dir)).toEqual([...predecessors, migration])
      expect(await runMigrations(pool, dir)).toEqual([])
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,
      ).toBe(0)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  },
)
