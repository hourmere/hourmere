import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0062_reschedule_requests.sql'
describe.skipIf(!serverUrl)('reschedule request migration', () => {
  it('preserves predecessor bookings and webhook receipts, supports fresh install and no-op rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-reschedule-predecessor-'))
    const owned = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
    try {
      for (const file of await readdir(migrationsDir))
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(owned.pool, directory)
      const org = randomUUID(),
        booking = randomUUID(),
        webhook = randomUUID()
      await owned.pool.query(
        `INSERT INTO auth.organization(id,name,slug,"createdAt") VALUES($1,'Reschedule upgrade','reschedule-upgrade',now())`,
        [org],
      )
      await owned.pool.query(
        `INSERT INTO bookings(id,organization_id,start_at,end_at,title,manage_token_hash,source) VALUES($1,$2,'2030-01-02T09:00Z','2030-01-02T09:30Z','Original meeting',decode(repeat('ab',32),'hex'),'web')`,
        [booking, org],
      )
      await owned.pool.query(
        `INSERT INTO webhooks(id,organization_id,url,events,secret_ciphertext) VALUES($1,$2,'https://example.test/hook',ARRAY['booking.created'],decode('abcd','hex'))`,
        [webhook, org],
      )
      await owned.pool.query(
        `INSERT INTO webhook_deliveries(webhook_id,organization_id,booking_id,event_id,event_type,payload) VALUES($1,$2,$3,$4,'booking.created','{}')`,
        [webhook, org, booking, randomUUID()],
      )
      const snapshot = async () =>
        (
          await owned.pool.query(
            `SELECT (SELECT jsonb_agg(to_jsonb(b)) FROM bookings b) bookings,(SELECT jsonb_agg(to_jsonb(d)-'request_id') FROM webhook_deliveries d) deliveries`,
          )
        ).rows
      const before = await snapshot()
      expect(await runMigrations(owned.pool)).toEqual([migration])
      expect(await snapshot()).toEqual(before)
      expect(await runMigrations(owned.pool)).toEqual([])
      await owned.pool.query(
        `INSERT INTO booking_reschedule_requests(booking_id,idempotency_key,expires_at,created_at) VALUES($1,$2,'2030-01-02T09:00Z',now())`,
        [booking, randomUUID()],
      )
      await expect(
        owned.pool.query(
          `INSERT INTO booking_reschedule_requests(booking_id,idempotency_key,expires_at,created_at) VALUES($1,$2,'2030-01-02T09:00Z',now())`,
          [booking, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23505' })
    } finally {
      await owned.drop()
      await rm(directory, { recursive: true, force: true })
    }
    const fresh = await createTestDatabase(serverUrl as string)
    try {
      expect(await runMigrations(fresh.pool)).toEqual([])
      expect(
        (await fresh.pool.query('SELECT count(*) FROM booking_reschedule_requests')).rows[0].count,
      ).toBe('0')
    } finally {
      await fresh.drop()
    }
  })
})
