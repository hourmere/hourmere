import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createDb, runMigrations } from '@hourmere/db'
import { MIGRATION_REPLAY_TIMEOUT } from '@hourmere/db/migration-replay'
import {
  createTestDatabaseTemplate,
  type TestDatabase,
  type TestDatabaseTemplate,
} from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { expect, it, vi } from 'vitest'
import { encryptWebhookSecret } from './crypto.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0028_webhook_interrupted_deliveries.sql'

vi.setConfig({ testTimeout: MIGRATION_REPLAY_TIMEOUT })

it.skipIf(!serverUrl)(
  'preserves predecessor webhook data, supports fresh installs and reruns safely',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hourmere-webhook-predecessor-'))
    let owned: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    let template: TestDatabaseTemplate | undefined
    try {
      const source = new URL('../../db/migrations/', import.meta.url)
      const predecessors = (await readdir(source))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of predecessors) await copyFile(new URL(file, source), join(dir, file))
      template = await createTestDatabaseTemplate(
        serverUrl as string,
        async (pool) => {
          const applied = await runMigrations(pool, dir)
          expect(applied).toEqual(predecessors)
          expect(applied.at(-1)).toBe('0027_nontransitive_invited_signup.sql')
        },
        { tag: 'webhook_prev' },
      )
      owned = await template.clone(undefined, { migrate: false, tag: 'webhook_upgrade' })
      const pool = owned.pool
      const db = createDb(pool)
      const user = await createTestUser(db)
      const key = Buffer.alloc(32, 9).toString('base64')
      // Seed the historical schema directly: current services also write later columns and tables.
      const webhook = { id: randomUUID(), organizationId: user.principal.organization.id }
      await db
        .insertInto('webhooks')
        .values({
          id: webhook.id,
          organization_id: webhook.organizationId,
          url: 'https://hooks.example.com/bookings',
          events: ['booking.created'],
          secret_ciphertext: encryptWebhookSecret(
            'synthetic',
            key,
            webhook.id,
            webhook.organizationId,
          ),
        })
        .execute()
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
      fresh = await template.clone(undefined, { migrate: false, tag: 'webhook_fresh' })
      expect(await runMigrations(fresh.pool, dir)).toEqual([migration])
      const installed = await fresh.pool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      )
      expect(installed.rows.map(({ name }) => name)).toEqual([...predecessors, migration])
      expect(await runMigrations(fresh.pool, dir)).toEqual([])
      expect(
        (await fresh.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,
      ).toBe(0)
    } finally {
      try {
        await Promise.all([owned?.drop(), fresh?.drop()])
      } finally {
        await template?.drop()
        await rm(dir, { recursive: true, force: true })
      }
    }
  },
)
