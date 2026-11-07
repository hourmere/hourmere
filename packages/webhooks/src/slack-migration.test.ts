import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb, runMigrations } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { expect, it } from 'vitest'
import { snapshotSchema } from '../../db/src/upgrade-schema-snapshot.ts'
import { encryptWebhookSecret } from './crypto.ts'

it.skipIf(!process.env.DATABASE_URL)(
  '0068 preserves predecessor endpoints and delivery history, matches a fresh install and reruns as a no-op',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hourmere-slack-predecessor-'))
    let owned: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    const migration = '0068_slack_destinations.sql'
    try {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        migrate: false,
        tag: 'slack_upgrade',
      })
      const source = new URL('../../db/migrations/', import.meta.url)
      const predecessors = (await readdir(source))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of predecessors) await copyFile(new URL(file, source), join(dir, file))
      expect(await runMigrations(owned.pool, dir)).toEqual(predecessors)
      const db = createDb(owned.pool)
      const user = await createTestUser(db)
      const id = randomUUID()
      await db
        .insertInto('webhooks')
        .values({
          id,
          organization_id: user.principal.organization.id,
          url: 'https://hooks.example.com/bookings',
          events: ['booking.created'],
          secret_ciphertext: encryptWebhookSecret(
            'synthetic',
            Buffer.alloc(32, 9).toString('base64'),
            id,
            user.principal.organization.id,
          ),
        })
        .execute()
      const bookingId = await createFixtures(db).booking(
        user.principal.organization.id,
        [user.id],
        '2026-11-03T09:00Z',
        '2026-11-03T09:30Z',
      )
      await db
        .insertInto('webhook_deliveries')
        .values({
          webhook_id: id,
          organization_id: user.principal.organization.id,
          booking_id: bookingId,
          event_id: randomUUID(),
          event_type: 'booking.created',
          payload: '{"synthetic":true}',
          attempts: 3,
          status: 'pending',
          last_error: 'http_error',
          http_status: 503,
        })
        .execute()
      const before = await db.selectFrom('webhooks').selectAll().executeTakeFirstOrThrow()
      const history = await db.selectFrom('webhook_deliveries').selectAll().execute()
      await copyFile(new URL(migration, source), join(dir, migration))
      expect(await runMigrations(owned.pool, dir)).toEqual([migration])
      expect(await db.selectFrom('webhooks').selectAll().executeTakeFirstOrThrow()).toEqual({
        ...before,
        destination_kind: 'webhook',
        url_ciphertext: null,
        event_type_id: null,
        pause_reason: null,
      })
      expect(await db.selectFrom('webhook_deliveries').selectAll().execute()).toEqual(history)
      expect(await runMigrations(owned.pool, dir)).toEqual([])
      // A fresh install from the same files (only the predecessors plus 0068) must produce
      // exactly the upgraded auth and public schemas: columns, constraints, indexes, triggers.
      fresh = await createTestDatabase(process.env.DATABASE_URL as string, dir, {
        tag: 'slack_fresh',
      })
      expect(await snapshotSchema(owned.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(fresh.pool, dir)).toEqual([])
      expect(await runMigrations(owned.pool, dir)).toEqual([])
    } finally {
      try {
        await fresh?.drop()
        await owned?.drop()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  },
  // Two throwaway databases and two catalog snapshots; keep clear of the 5 s default.
  60_000,
)
