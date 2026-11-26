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
const migration = '0188_microsoft_teams_event_locations.sql'
const location = { kind: 'microsoft_teams' }
const locations = [{ id: 'teams', ...location, isDefault: true }]
const invalidOptions = { code: '23514', constraint: 'event_types_locations_valid' }

async function createTeam(pool: pg.Pool) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ('Studio',$1,now()) RETURNING id`,
    [`teams-location-${randomUUID()}`],
  )
  return rows[0]?.id as string
}

function insertType(pool: pg.Pool, teamId: string, options: unknown) {
  return pool.query(
    `INSERT INTO event_types (organization_id,slug,title,duration_minutes,locations)
      VALUES ($1,$2,'Consultation',30,$3::jsonb) RETURNING location,locations`,
    [teamId, randomUUID(), JSON.stringify(options)],
  )
}

async function assertLocationVocabulary(pool: pg.Pool) {
  const team = await createTeam(pool)
  await expect(insertType(pool, team, locations)).resolves.toMatchObject({
    rows: [{ location, locations }],
  })
  await expect(
    insertType(pool, team, [{ id: 'invalid', kind: 'unknown_provider' }]),
  ).rejects.toMatchObject(invalidOptions)
  await expect(
    insertType(pool, team, [...locations, { ...locations[0], id: 'duplicate' }]),
  ).rejects.toMatchObject(invalidOptions)
}

async function seedPredecessor(pool: pg.Pool, teamId: string) {
  const host = randomUUID()
  const event = randomUUID()
  const booking = randomUUID()
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified")
      VALUES ($1,'Host','teams-migration-host@example.test',true)`,
    [host],
  )
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
      VALUES ($1,$2,'owner','2026-11-20T00:00:00Z')`,
    [teamId, host],
  )
  await pool.query(
    `INSERT INTO event_types (id,organization_id,slug,title,duration_minutes,locations,updated_at)
      VALUES ($1,$2,'consultation','Consultation',30,
        '[{"id":"online","kind":"link","url":"https://example.test/consult"},{"id":"office","kind":"in_person","address":"1 Main Street","isDefault":true}]',
        '2026-11-20T00:00:00.123456Z')`,
    [event, teamId],
  )
  await pool.query('INSERT INTO event_type_hosts (event_type_id,user_id) VALUES ($1,$2)', [
    event,
    host,
  ])
  await pool.query(
    `INSERT INTO bookings
      (id,organization_id,event_type_id,start_at,end_at,title,location,location_option,source,required_host_user_ids,updated_at)
      VALUES ($1,$2,$3,'2030-11-20T15:00:00Z','2030-11-20T15:30:00Z','Consultation',
        '{"kind":"link","url":"https://example.test/consult"}',
        '{"id":"online","kind":"link","url":"https://example.test/consult"}','web',ARRAY[$4]::uuid[],
        '2026-11-20T01:00:00.654321Z')`,
    [booking, teamId, event, host],
  )
  await pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [booking, host])
  await pool.query(
    `INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
      VALUES ($1,'Invitee','teams-migration-invitee@example.test','America/Los_Angeles',true)`,
    [booking],
  )
  return { event, booking }
}

async function existingRows(pool: pg.Pool, ids: { event: string; booking: string }) {
  return (
    await pool.query(
      `SELECT 'event_type' AS relation,to_jsonb(e) AS data,xmin::text,ctid::text
        FROM event_types e WHERE id=$1
      UNION ALL SELECT 'booking',to_jsonb(b),xmin::text,ctid::text FROM bookings b WHERE id=$2
      UNION ALL SELECT 'attendee',to_jsonb(a),xmin::text,ctid::text
        FROM booking_attendees a WHERE booking_id=$2
      ORDER BY relation`,
      [ids.event, ids.booking],
    )
  ).rows
}

describe.skipIf(!serverUrl)('Microsoft Teams location migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'keeps the existing catalogued constraints and expands their accepted vocabulary',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertLocationVocabulary,
      })
      // Only a helper function body changes. The predecessor owns the constraints.
      expect(report.problems).toEqual([])
      expect(report.results).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves predecessor data, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'teams_loc_up' })
        const team = await createTeam(upgraded.pool)
        const ids = await seedPredecessor(upgraded.pool, team)
        const before = await existingRows(upgraded.pool, ids)
        expect(before).toHaveLength(3)
        await expect(insertType(upgraded.pool, team, locations)).rejects.toMatchObject(
          invalidOptions,
        )

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        expect(await existingRows(upgraded.pool, ids)).toEqual(before)
        await assertLocationVocabulary(upgraded.pool)

        fresh = await predecessor.clone(undefined, {
          tag: 'teams_loc_new',
          migrate: false,
        })
        expect(await runMigrations(fresh.pool, directory)).toEqual([migration])
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await assertLocationVocabulary(fresh.pool)
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await existingRows(upgraded.pool, ids)).toEqual(before)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
