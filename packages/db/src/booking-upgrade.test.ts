import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const url = process.env.DATABASE_URL
// A source-copy directory also lets acceptance probes mutate historical SQL without
// ever editing a published migration in the repository.
const source = fileURLToPath(new URL('../migrations', import.meta.url))

describe.skipIf(!url)('populated booking schema upgrades', () => {
  it('backfills host policy through 0019/0020 without changing booking history', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-booking-upgrade-'))
    let database: TestDatabase | undefined
    try {
      const files = (await readdir(source)).filter((file) => file.endsWith('.sql')).sort()
      for (const file of files.filter((file) => file < '0019')) {
        await copyFile(join(source, file), join(predecessor, file))
      }
      database = await createTestDatabase(url as string, predecessor)
      const pool = database.pool
      const hosts = (
        await pool.query<{ id: string }>(
          `INSERT INTO auth."user" (name,email,"emailVerified") VALUES
          ('Ada','upgrade-ada@example.com',true),('Grace','upgrade-grace@example.com',true)
         RETURNING id`,
        )
      ).rows
        .map((row) => row.id)
        .sort()
      const organization = (
        await pool.query<{ id: string }>(
          `INSERT INTO auth.organization (name,slug,"createdAt")
         VALUES ('Upgrade team','upgrade-team',now()) RETURNING id`,
        )
      ).rows[0]?.id
      const cases = [
        { title: 'Individual', hosts: hosts.slice(0, 1), cancelled: false },
        { title: 'Collective', hosts, cancelled: false },
        { title: 'Cancelled collective', hosts, cancelled: true },
        { title: 'Historical deleted hosts', hosts: [], cancelled: true },
      ]
      const ids: string[] = []
      for (const [index, sample] of cases.entries()) {
        const row = (
          await pool.query<{ id: string }>(
            `INSERT INTO bookings (organization_id,status,cancelled_at,start_at,end_at,title,
             location,responses,manage_token_hash,source,created_at,updated_at)
           VALUES ($1,$2,$3,'2026-11-02T10:00Z'::timestamptz + $4::int * interval '1 day',
             '2026-11-02T10:30Z'::timestamptz + $4::int * interval '1 day',$5,
             '{"kind":"phone","number":"+15555550100"}','{"purpose":"Upgrade fixture"}',
             sha256(convert_to($5::text,'UTF8')),'web','2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z')
           RETURNING id`,
            [
              organization,
              sample.cancelled ? 'cancelled' : 'confirmed',
              sample.cancelled ? '2026-03-01T00:00Z' : null,
              index,
              sample.title,
            ],
          )
        ).rows[0]
        const id = row?.id as string
        ids.push(id)
        for (const host of sample.hosts) {
          await pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
            id,
            host,
          ])
        }
        await pool.query(
          `INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
           VALUES ($1,'Synthetic Invitee','upgrade-invitee@example.com','UTC',true)`,
          [id],
        )
      }
      const snapshot = async () =>
        (
          await pool.query(
            `SELECT to_jsonb(b) - 'required_host_user_ids' - 'hosts_use_default_schedule' AS booking
         FROM bookings b ORDER BY id`,
          )
        ).rows
      const history = await snapshot()
      for (const file of files.filter((file) => file >= '0019' && file < '0021')) {
        await copyFile(join(source, file), join(predecessor, file))
        expect(await runMigrations(pool, predecessor)).toEqual([file])
        expect(await snapshot()).toEqual(history)
      }
      const policy = (
        await pool.query<{
          id: string
          required_host_user_ids: string[]
          hosts_use_default_schedule: boolean
        }>('SELECT id,required_host_user_ids,hosts_use_default_schedule FROM bookings ORDER BY id')
      ).rows
      expect(policy).toEqual(
        cases.map((sample, index) => ({
          id: ids[index],
          required_host_user_ids: sample.hosts,
          hosts_use_default_schedule: sample.hosts.length > 1,
        })),
      )
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM booking_attendees')).rows,
      ).toEqual([{ count: 4 }])
      expect(await runMigrations(pool, predecessor)).toEqual([])
    } finally {
      await database?.drop()
      await rm(predecessor, { recursive: true, force: true })
    }
  })
})
