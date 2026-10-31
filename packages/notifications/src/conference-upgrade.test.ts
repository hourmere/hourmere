import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from '../../db/src/migrate.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('conference migrations preserve populated predecessor data', () => {
  it('upgrades0023 without changing historical values, then does nothing', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-conference-predecessor-'))
    const migrations = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of migrations) {
      if (file.endsWith('.sql') && file < '0024')
        await cp(join(migrationsDir, file), join(predecessor, file))
    }
    const owned = await createTestDatabase(serverUrl as string, predecessor)
    try {
      const db = createDb(owned.pool)
      const f = createFixtures(db)
      const host = await f.host()
      const event = await f.eventType(host.organizationId, host.userId, {
        location: { kind: 'google_meet', autoCreate: true },
      })
      const booking = await f.booking(
        host.organizationId,
        [host.userId],
        '2030-11-04T09:00Z',
        '2030-11-04T09:30Z',
        { eventTypeId: event },
      )
      await db
        .insertInto('booking_conferences')
        .values({
          root_booking_id: booking,
          booking_id: booking,
          organization_id: host.organizationId,
          organizer_user_id: host.userId,
          state: 'ready',
          applied_revision: 0,
          external_event_id: 'historical_meet',
          invitation_organizer_name: 'Synthetic Host',
          invitation_organizer_email: 'host@example.test',
        })
        .execute()
      await db
        .insertInto('booking_conference_notifications')
        .values([
          { booking_id: booking, kind: 'confirmed', delivered: true, due_at: '2029-06-01T09:00Z' },
          { booking_id: booking, kind: 'reminder', delivered: false, due_at: '2030-11-03T09:00Z' },
        ])
        .execute()
      await db
        .insertInto('booking_notifications')
        .values({ booking_id: booking, kind: 'confirmed', recipient: `host:${host.userId}` })
        .execute()
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: host.userId,
          token: 'synthetic-upgrade-session',
          expiresAt: '2030-11-05T09:00Z',
          updatedAt: '2029-06-01T09:00Z',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const connection = (
        await owned.pool.query<{ id: string }>(
          `INSERT INTO conference_connections (user_id,provider,external_user_id,credentials,scopes,status,created_at,updated_at) VALUES ($1,'zoom','synthetic-pinned-id',$2,ARRAY['user:read:user'],'active','2029-06-01T09:00Z','2029-06-01T09:00Z') RETURNING id`,
          [host.userId, Buffer.from('synthetic-encrypted-identity')],
        )
      ).rows[0]
      if (!connection) throw new Error('Expected the synthetic identity connection')
      await owned.pool.query(
        `INSERT INTO conference_oauth_states (state_hash,user_id,session_id,connection_id,verifier,expires_at) VALUES ($1,$2,$3,$4,$5,'2030-11-05T09:00Z')`,
        [
          'a'.repeat(64),
          host.userId,
          session.id,
          connection.id,
          Buffer.from('synthetic-encrypted-verifier'),
        ],
      )
      const tables = [
        'bookings',
        'event_types',
        'booking_conferences',
        'booking_conference_notifications',
        'booking_notifications',
        'conference_connections',
        'conference_oauth_states',
      ] as const
      const before = new Map<string, Record<string, unknown>[]>()
      for (const table of tables) {
        const rows = (
          await owned.pool.query(`SELECT *,xmin::text AS original_xmin FROM ${table} ORDER BY 1`)
        ).rows
        // 0037 intentionally retires this unused flag. 0038 backfills booking
        // organizer metadata and 0047 backfills event duration lists, so those
        // tables change physical tuples; every retained predecessor value,
        // including updated_at, must survive.
        if (table === 'booking_conferences')
          for (const row of rows) {
            expect(row.retry_conference).toBe(false)
            delete row.retry_conference
          }
        before.set(table, rows)
      }
      const applied = await runMigrations(owned.pool)
      let previousIndex = -1
      for (const migration of [
        '0024_conference_notification_retries.sql',
        '0025_automatic_zoom.sql',
        '0026_conference_notification_skips.sql',
        '0027_nontransitive_invited_signup.sql',
        '0028_webhook_interrupted_deliveries.sql',
        '0029_host_reschedule_tokens.sql',
        '0030_mcp_oauth_client_activity.sql',
        '0038_booking_ical_identity.sql',
        '0047_event_type_durations.sql',
      ]) {
        const index = applied.indexOf(migration)
        expect(index, migration).toBeGreaterThan(previousIndex)
        previousIndex = index
      }
      for (const table of tables) {
        const old = before.get(table) as Record<string, unknown>[]
        const after = (
          await owned.pool.query(`SELECT *,xmin::text AS original_xmin FROM ${table} ORDER BY 1`)
        ).rows
        expect(after).toHaveLength(old.length)
        if (table === 'booking_conferences')
          for (const row of after) expect(row).not.toHaveProperty('retry_conference')
        if (table === 'bookings')
          for (const [index, row] of after.entries()) {
            expect(row.original_xmin).not.toBe(old[index]?.original_xmin)
            expect(row).toMatchObject({
              ical_version: 1,
              ical_organizer_name: 'Synthetic Host',
              ical_organizer_email: 'host@example.test',
            })
          }
        if (table === 'event_types')
          for (const [index, row] of after.entries()) {
            expect(row.original_xmin).not.toBe(old[index]?.original_xmin)
            expect(row.allowed_durations_minutes).toEqual([old[index]?.duration_minutes])
          }
        const predecessorKeys = (row: Record<string, unknown>) =>
          Object.keys(row).filter(
            (key) => (table !== 'bookings' && table !== 'event_types') || key !== 'original_xmin',
          )
        expect(
          after.map((row, index) =>
            Object.fromEntries(predecessorKeys(old[index] ?? {}).map((key) => [key, row[key]])),
          ),
        ).toEqual(
          old.map((row) => Object.fromEntries(predecessorKeys(row).map((key) => [key, row[key]]))),
        )
      }
      const notices = await db
        .selectFrom('booking_conference_notifications')
        .selectAll()
        .orderBy('kind')
        .execute()
      expect(
        notices.map((row) => ({
          kind: row.kind,
          attempts: row.attempts,
          skipped_at: row.skipped_at,
          lease_id: row.lease_id,
          exhausted_at: row.exhausted_at,
        })),
      ).toEqual([
        { kind: 'confirmed', attempts: 0, skipped_at: null, lease_id: null, exhausted_at: null },
        { kind: 'reminder', attempts: 0, skipped_at: null, lease_id: null, exhausted_at: null },
      ])
      expect(
        await db
          .selectFrom('conference_connections')
          .select(['mode', 'scopes'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ mode: 'identity', scopes: ['user:read:user'] })
      expect(
        await db
          .selectFrom('conference_oauth_states')
          .select(['mode', 'binding_version'])
          .executeTakeFirstOrThrow(),
      ).toEqual({ mode: 'identity', binding_version: 1 })
      expect(await runMigrations(owned.pool)).toEqual([])
    } finally {
      await owned.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  })

  it('installs fresh, enforces distinct terminal skips and reruns as a no-op', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const db = createDb(owned.pool)
      const f = createFixtures(db)
      const host = await f.host()
      const booking = await f.booking(
        host.organizationId,
        [host.userId],
        '2030-11-04T09:00Z',
        '2030-11-04T09:30Z',
      )
      await db
        .insertInto('booking_conference_notifications')
        .values({ booking_id: booking, kind: 'confirmed', skipped_at: '2030-11-03T09:00Z' })
        .execute()
      await expect(
        db
          .updateTable('booking_conference_notifications')
          .set({ delivered: true })
          .where('booking_id', '=', booking)
          .execute(),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'conference_notification_skipped_terminal',
      })
      await expect(
        db
          .updateTable('booking_conference_notifications')
          .set({ exhausted_at: '2030-11-03T09:00Z' })
          .where('booking_id', '=', booking)
          .execute(),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'conference_notification_skipped_terminal',
      })
      expect(await runMigrations(owned.pool)).toEqual([])
    } finally {
      await owned.drop()
    }
  })
})
