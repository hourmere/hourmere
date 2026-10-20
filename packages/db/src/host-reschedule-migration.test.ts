import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0029_host_reschedule_tokens.sql'

/** The bootstrap connection only creates and drops this test's disposable database. */
async function withDatabase(check: (pool: pg.Pool) => Promise<void>) {
  const owned = await createTestDatabase(serverUrl as string, undefined, {
    migrate: false,
    tag: 'host_tokens',
  })
  try {
    await check(owned.pool)
  } finally {
    await owned.drop()
  }
}

const nullable = async (pool: pg.Pool) =>
  (
    await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bookings'
          AND column_name = 'manage_token_hash'`,
    )
  ).rows[0]?.is_nullable

/** Compare complete scheduling records without including token digests in test output. */
const snapshot = async (pool: pg.Pool) =>
  (
    await pool.query<{ digest: string }>(
      `SELECT md5(jsonb_build_object(
        'bookings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM bookings b),
        'hosts', (SELECT jsonb_agg(to_jsonb(h) ORDER BY booking_id,user_id) FROM booking_hosts h),
        'attendees', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM booking_attendees a),
        'notifications', (SELECT jsonb_agg(to_jsonb(n) ORDER BY booking_id,kind,recipient)
                            FROM booking_notifications n),
        'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM event_types e)
      )::text) AS digest`,
    )
  ).rows[0]?.digest

describe.skipIf(!serverUrl)('host reschedule token migration', () => {
  it('preserves predecessor bookings, attendees and email links, and remains unique', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-host-tokens-predecessor-'))
    try {
      for (const file of await readdir(migrationsDir))
        if (file.endsWith('.sql') && file < migration)
          await copyFile(join(migrationsDir, file), join(predecessor, file))
      await withDatabase(async (pool) => {
        expect((await runMigrations(pool, predecessor)).at(-1)).toBe(
          '0028_webhook_interrupted_deliveries.sql',
        )
        expect(await nullable(pool)).toBe('NO')
        const organizationId = randomUUID()
        const hostId = randomUUID()
        const eventTypeId = randomUUID()
        const previousId = randomUUID()
        const bookingId = randomUUID()
        await pool.query(
          `INSERT INTO auth."user" (id,name,email,"emailVerified")
             VALUES ($1,'Ada Host','host@example.com',true)`,
          [hostId],
        )
        await pool.query(
          `INSERT INTO auth.organization (id,name,slug,"createdAt")
             VALUES ($1,'Example Team','migration-team',now())`,
          [organizationId],
        )
        await pool.query(
          `INSERT INTO auth.member ("userId","organizationId",role,"createdAt")
             VALUES ($1,$2,'owner',now())`,
          [hostId, organizationId],
        )
        await pool.query(
          `INSERT INTO event_types (id,organization_id,owner_user_id,slug,title,duration_minutes,
             questions,allow_guests)
           VALUES ($1,$2,$3,'intro','Compiler discussion',30,
             '[{"id":"topic","label":"Topic","type":"short_text"}]',true)`,
          [eventTypeId, organizationId, hostId],
        )
        await pool.query(`INSERT INTO event_type_hosts (event_type_id,user_id) VALUES ($1,$2)`, [
          eventTypeId,
          hostId,
        ])
        for (const [id, previous, status, hour, marker] of [
          [previousId, null, 'cancelled', 9, 'previous'],
          [bookingId, previousId, 'confirmed', 10, 'current'],
        ] as const) {
          await pool.query(
            `INSERT INTO bookings (id,organization_id,event_type_id,start_at,end_at,title,
               manage_token_hash,responses,source,required_host_user_ids,rescheduled_from_id,
               status,cancelled_at,cancelled_source)
             VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 minutes',
               'Compiler discussion with Grace',sha256($5::bytea),'{"topic":"compilers"}',
               'mcp',ARRAY[$6::uuid],$7,$8,
               CASE WHEN $8 = 'cancelled' THEN now() END,
               CASE WHEN $8 = 'cancelled' THEN 'mcp' END)`,
            [
              id,
              organizationId,
              eventTypeId,
              `2026-11-02T${hour}:00Z`,
              marker,
              hostId,
              previous,
              status,
            ],
          )
          await pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
            id,
            hostId,
          ])
          await pool.query(
            `INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
               VALUES ($1,'Grace','invitee@example.com','America/New_York',true),
                      ($1,'Guest','guest@example.com','UTC',false)`,
            [id],
          )
        }
        await pool.query(
          `INSERT INTO booking_notifications (booking_id,kind,recipient,manage_token_hash)
             SELECT $1,'confirmed','attendee:' || id,sha256('email-link'::bytea)
               FROM booking_attendees WHERE booking_id = $1 AND is_booker`,
          [previousId],
        )
        const before = await snapshot(pool)
        await copyFile(join(migrationsDir, migration), join(predecessor, migration))
        expect(await runMigrations(pool, predecessor)).toEqual([migration])
        expect(await nullable(pool)).toBe('YES')
        expect((await snapshot(pool)) === before).toBe(true)
        await expect(
          pool.query('UPDATE bookings SET manage_token_hash = sha256($1::bytea) WHERE id = $2', [
            'current',
            previousId,
          ]),
        ).rejects.toMatchObject({ code: '23505' })
        await pool.query('UPDATE bookings SET manage_token_hash = NULL WHERE id = $1', [previousId])
        const after = await snapshot(pool)
        expect(await runMigrations(pool, predecessor)).toEqual([])
        expect((await snapshot(pool)) === after).toBe(true)
      })
    } finally {
      await rm(predecessor, { recursive: true, force: true })
    }
  })

  it('supports a fresh install and a no-op second migration run', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'hourmere-host-tokens-fresh-'))
    try {
      for (const file of await readdir(migrationsDir))
        if (file.endsWith('.sql') && file <= migration)
          await copyFile(join(migrationsDir, file), join(fresh, file))
      await withDatabase(async (pool) => {
        expect(await runMigrations(pool, fresh)).toContain(migration)
        expect(await nullable(pool)).toBe('YES')
        expect(await runMigrations(pool, fresh)).toEqual([])
      })
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })
})
