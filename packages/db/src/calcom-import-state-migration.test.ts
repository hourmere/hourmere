import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0060_calcom_import_state.sql'
const predecessor = '0058_one_time_link_idempotency.sql'
const fingerprint = 'a'.repeat(64)
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

async function copyPredecessor(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= predecessor)
    .sort()
  expect(files.at(-1)).toBe(predecessor)
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`
      SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
      WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
        AND table_name NOT IN ('schema_migrations','import_sources','import_items')
      ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT (to_jsonb(t) - $1::text[])::text AS value,xmin::text,ctid::text
        FROM ${quote(table.schema)}.${quote(table.name)} t
        ORDER BY (to_jsonb(t) - $1::text[])::text COLLATE "C"`,
        [table.name === 'bookings' ? ['import_questions'] : []],
      )
    ).rows
  return result
}

interface Fixture {
  pool: pg.Pool
  source: string
  otherSource: string
  owner: string
  organization: string
  schedule: string
  event: string
  booking: string
}

async function fixture(pool: pg.Pool): Promise<Fixture> {
  const owner = (
    await pool.query<{ id: string }>(`INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Synthetic import owner','owner@example.test',true) RETURNING id`)
  ).rows[0]?.id as string
  await pool.query(
    `INSERT INTO profiles (user_id,handle,time_zone) VALUES ($1,'import-owner','UTC')`,
    [owner],
  )
  const organization = (
    await pool.query<{ id: string }>(`INSERT INTO auth.organization (name,slug,"createdAt")
      VALUES ('Import personal','import-personal',now()) RETURNING id`)
  ).rows[0]?.id as string
  await pool.query('INSERT INTO personal_organizations VALUES ($1,$2)', [owner, organization])
  const schedule = (
    await pool.query<{ id: string }>(
      `INSERT INTO schedules (user_id,name,time_zone,weekly_hours)
      VALUES ($1,'Working hours','UTC','{}') RETURNING id`,
      [owner],
    )
  ).rows[0]?.id as string
  const event = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types
      (organization_id,owner_user_id,slug,title,duration_minutes,is_active)
      VALUES ($1,$2,'import-event','Import event',30,false) RETURNING id`,
      [organization, owner],
    )
  ).rows[0]?.id as string
  const booking = (
    await pool.query<{ id: string }>(
      `INSERT INTO bookings
      (organization_id,event_type_id,start_at,end_at,title,source,import_questions)
      VALUES ($1,$2,'2040-01-02T09:00Z','2040-01-02T09:30Z','Imported meeting','import','[]') RETURNING id`,
      [organization, event],
    )
  ).rows[0]?.id as string
  await pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
    booking,
    owner,
  ])
  await pool.query(
    `INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
    VALUES ($1,'Synthetic attendee','attendee@example.test','UTC',true)`,
    [booking],
  )
  const sources = (
    await pool.query<{ id: string }>(
      `INSERT INTO import_sources
      (schema_fingerprint,source_version,created_by_user_id)
      VALUES ($1,'calcom-baseline',$2),($1,'caldiy-baseline',$2) RETURNING id`,
      [fingerprint, owner],
    )
  ).rows
  return {
    pool,
    owner,
    organization,
    schedule,
    event,
    booking,
    source: sources[0]?.id as string,
    otherSource: sources[1]?.id as string,
  }
}

async function insertItem(f: Fixture, overrides: Record<string, unknown> = {}) {
  const values = {
    source_id: f.source,
    entity_kind: 'event_type',
    source_primary_key: '123',
    source_user_primary_key: '456',
    target_id: f.event,
    source_fingerprint: fingerprint,
    target_fingerprint: fingerprint,
    policy: 'disabled_draft',
    contract_version: 1,
    question_crosswalk: {
      questions: [
        { source: 'custom-field', target: 'stable-question', options: { legacy: 'stable-option' } },
      ],
    },
    ...overrides,
  }
  const fields = Object.keys(values)
  await f.pool.query(
    `INSERT INTO import_items (${fields.map(quote).join(',')})
    VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.entries(values).map(([key, value]) =>
      key === 'question_crosswalk' ? JSON.stringify(value) : value,
    ),
  )
}

async function allMappings(f: Fixture) {
  for (const [kind, id] of [
    ['user', f.owner],
    ['profile', f.owner],
    ['schedule', f.schedule],
    ['event_type', f.event],
    ['booking', f.booking],
  ])
    await insertItem(f, { entity_kind: kind, target_id: id })
}

async function assertTombstones(f: Fixture, kinds: string[]) {
  const rows = (
    await f.pool.query(`SELECT entity_kind,source_user_primary_key,target_id,source_fingerprint,target_fingerprint,
    policy,question_crosswalk,deleted_at IS NOT NULL AS deleted FROM import_items ORDER BY entity_kind`)
  ).rows
  expect(rows.filter((row) => kinds.includes(row.entity_kind))).toEqual(
    kinds.toSorted().map((kind) => ({
      entity_kind: kind,
      source_user_primary_key: '456',
      target_id: null,
      source_fingerprint: null,
      target_fingerprint: null,
      policy: null,
      question_crosswalk: {},
      deleted: true,
    })),
  )
}

const assertions: Record<string, (f: Fixture) => Promise<void>> = {
  'random source namespace': async (f) => {
    expect(f.source[14]).toBe('4')
    expect(f.otherSource[14]).toBe('4')
    expect(f.source).not.toBe(f.otherSource)
  },
  'source tuple uniqueness': async (f) => {
    await insertItem(f)
    // The same tuple is rejected even when it points at a different live target.
    await expect(
      insertItem(f, { entity_kind: 'user', target_id: f.owner }),
    ).resolves.toBeUndefined()
    await expect(insertItem(f, { entity_kind: 'user', target_id: f.owner })).rejects.toMatchObject({
      code: '23505',
      constraint: 'import_items_pkey',
    })
  },
  'target uniqueness and shared matched users': async (f) => {
    await insertItem(f)
    await expect(insertItem(f, { source_id: f.otherSource })).rejects.toMatchObject({
      code: '23505',
    })
    await insertItem(f, { entity_kind: 'user', target_id: f.owner })
    await insertItem(f, { entity_kind: 'user', target_id: f.owner, source_id: f.otherSource })
  },
  'opaque source keys': async (f) => {
    await expect(
      insertItem(f, { source_primary_key: 'personal@example.test' }),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'opaque source owner keys': async (f) => {
    await expect(
      insertItem(f, { source_user_primary_key: 'personal@example.test' }),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'source fingerprint shape': async (f) => {
    await expect(insertItem(f, { source_fingerprint: 'not-a-sha256' })).rejects.toMatchObject({
      code: '23514',
    })
  },
  'target fingerprint shape': async (f) => {
    await expect(insertItem(f, { target_fingerprint: 'not-a-sha256' })).rejects.toMatchObject({
      code: '23514',
    })
  },
  'contract version': async (f) => {
    await expect(insertItem(f, { contract_version: 2 })).rejects.toMatchObject({ code: '23514' })
  },
  'crosswalk shape': async (f) => {
    await expect(insertItem(f, { question_crosswalk: [] })).rejects.toMatchObject({ code: '23514' })
  },
  'source schema fingerprint': async (f) => {
    await expect(
      f.pool.query(`INSERT INTO import_sources (schema_fingerprint,source_version)
      VALUES ('not-a-sha256','baseline')`),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'live mapping shape': async (f) => {
    await expect(insertItem(f, { source_fingerprint: null })).rejects.toMatchObject({
      code: '23514',
    })
  },
  'target existence': async (f) => {
    await expect(insertItem(f, { target_id: randomUUID() })).rejects.toMatchObject({
      code: '23503',
      constraint: 'import_items_target_exists',
    })
  },
  'immutable source identity': async (f) => {
    await expect(
      f.pool.query(
        `UPDATE import_sources SET schema_fingerprint=repeat('b',64)
      WHERE id=$1`,
        [f.source],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'immutable crosswalk and mapping': async (f) => {
    await insertItem(f)
    await expect(
      f.pool.query(`UPDATE import_items SET question_crosswalk='{}' WHERE source_id=$1`, [
        f.source,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query('DELETE FROM import_items WHERE source_id=$1', [f.source]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query("UPDATE import_items SET source_user_primary_key='789' WHERE source_id=$1", [
        f.source,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'target deletion tombstones': async (f) => {
    await allMappings(f)
    await f.pool.query('DELETE FROM schedules WHERE id=$1', [f.schedule])
    await f.pool.query('DELETE FROM profiles WHERE user_id=$1', [f.owner])
    await f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking])
    await f.pool.query('DELETE FROM event_types WHERE id=$1', [f.event])
    await assertTombstones(f, ['profile', 'schedule', 'booking', 'event_type'])
  },
  'event soft deletion tombstone': async (f) => {
    await insertItem(f)
    await f.pool.query('UPDATE event_types SET deleted_at=now() WHERE id=$1', [f.event])
    await assertTombstones(f, ['event_type'])
  },
  'owner erasure tombstones': async (f) => {
    await allMappings(f)
    const client = await f.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL search_path=auth')
      await client.query('DELETE FROM "user" WHERE id=$1', [f.owner])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await assertTombstones(f, ['user', 'profile', 'schedule', 'event_type', 'booking'])
    expect((await f.pool.query('SELECT created_by_user_id FROM import_sources')).rows).toEqual([
      { created_by_user_id: null },
      { created_by_user_id: null },
    ])
    expect(
      (
        await f.pool.query(`SELECT (SELECT count(*) FROM bookings)::int AS bookings,
      (SELECT count(*) FROM booking_attendees)::int AS attendees,
      (SELECT count(*) FROM auth.organization)::int AS organizations`)
      ).rows,
    ).toEqual([{ bookings: 0, attendees: 0, organizations: 0 }])
  },
  'irreversible tombstones': async (f) => {
    await insertItem(f)
    await f.pool.query('DELETE FROM event_types WHERE id=$1', [f.event])
    await expect(
      f.pool.query(
        `UPDATE import_items SET target_id=$1,deleted_at=NULL,
      source_fingerprint=$2,target_fingerprint=$2,policy='disabled_draft'`,
        [randomUUID(), fingerprint],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'import booking capability and busy status': async (f) => {
    await expect(
      f.pool.query(
        `UPDATE bookings SET manage_token_hash=sha256('secret'::bytea)
      WHERE id=$1`,
        [f.booking],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=now()
      WHERE id=$1`,
        [f.booking],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool
        .query(
          `INSERT INTO bookings (organization_id,start_at,end_at,title,source,import_questions)
      VALUES ($1,'2040-01-02T09:15Z','2040-01-02T09:45Z','Conflict','import','[]') RETURNING id`,
          [f.organization],
        )
        .then(async (result) => {
          await f.pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
            result.rows[0].id,
            f.owner,
          ])
        }),
    ).rejects.toMatchObject({ code: '23P01' })
  },
  'immutable imported booking source': async (f) => {
    await expect(
      f.pool.query(`UPDATE bookings SET source='web',import_questions=NULL WHERE id=$1`, [
        f.booking,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'import question snapshot': async (f) => {
    await expect(
      f.pool.query('UPDATE bookings SET import_questions=NULL WHERE id=$1', [f.booking]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query("UPDATE bookings SET import_questions='{}' WHERE id=$1", [f.booking]),
    ).rejects.toMatchObject({ code: '23514' })
  },
}

for (const kind of ['profile', 'event_type', 'booking'])
  assertions[`${kind} deletion tombstone`] = assertions['target deletion tombstones'] as (
    f: Fixture,
  ) => Promise<void>
assertions['import booking busy status'] = assertions[
  'import booking capability and busy status'
] as (f: Fixture) => Promise<void>

const mutations: Record<string, (source: string) => string> = {
  'random source namespace': (source) =>
    `${source}\nALTER TABLE import_sources ALTER COLUMN id SET DEFAULT uuidv7();`,
  'source tuple uniqueness': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_pkey;`,
  'target uniqueness and shared matched users': (source) =>
    `${source}\nDROP INDEX import_items_target;`,
  'opaque source keys': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_source_primary_key_check;`,
  'opaque source owner keys': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_source_user_primary_key_check;`,
  'source fingerprint shape': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_source_fingerprint_check;`,
  'target fingerprint shape': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_target_fingerprint_check;`,
  'contract version': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_contract_version_check;`,
  'crosswalk shape': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_question_crosswalk_check;`,
  'source schema fingerprint': (source) =>
    `${source}\nALTER TABLE import_sources DROP CONSTRAINT import_sources_schema_fingerprint_check;`,
  'live mapping shape': (source) =>
    `${source}\nALTER TABLE import_items DROP CONSTRAINT import_items_live_or_tombstone;`,
  'target existence': (source) =>
    `${source}\nDROP TRIGGER import_items_target_exists ON import_items;`,
  'immutable source identity': (source) =>
    `${source}\nDROP TRIGGER import_sources_immutable ON import_sources;`,
  'immutable crosswalk and mapping': (source) =>
    `${source}\nDROP TRIGGER import_items_immutable ON import_items;`,
  'target deletion tombstones': (source) =>
    `${source}\nDROP TRIGGER import_schedule_deleted ON schedules;`,
  'profile deletion tombstone': (source) =>
    `${source}\nDROP TRIGGER import_profile_deleted ON profiles;`,
  'event_type deletion tombstone': (source) =>
    `${source}\nDROP TRIGGER import_event_type_deleted ON event_types;`,
  'booking deletion tombstone': (source) =>
    `${source}\nDROP TRIGGER import_booking_deleted ON bookings;`,
  'event soft deletion tombstone': (source) =>
    `${source}\nDROP TRIGGER import_event_type_soft_deleted ON event_types;`,
  'owner erasure tombstones': (source) =>
    `${source}\nDROP TRIGGER import_user_deleted ON auth."user";`,
  'irreversible tombstones': (source) =>
    `${source}\nDROP TRIGGER import_items_immutable ON import_items;`,
  'import booking capability and busy status': (source) =>
    `${source}\nALTER TABLE bookings DROP CONSTRAINT bookings_import_local_only;`,
  'import booking busy status': (source) => source.replace("AND status = 'confirmed'", ''),
  'immutable imported booking source': (source) =>
    `${source}\nDROP TRIGGER bookings_import_source_immutable ON bookings;`,
  'import question snapshot': (source) =>
    `${source}\nALTER TABLE bookings DROP CONSTRAINT bookings_import_questions;`,
}

describe.skipIf(!serverUrl)('Cal.com import state migration', () => {
  it('preserves populated predecessor data, matches fresh schema and reapplies without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-import-upgrade-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-import-early-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = await copyPredecessor(directory)
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(early, file))
      upgraded = await createTestDatabase(serverUrl as string, early)
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      const before = await records(upgraded.pool)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool)).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      const query =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const ledger = (await upgraded.pool.query(query)).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect((await upgraded.pool.query(query)).rows).toEqual(ledger)
      expect(await records(upgraded.pool)).toEqual(before)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
      await rm(early, { recursive: true, force: true })
    }
  }, 60_000)

  it('detects a source-copy historical overwrite and passes after restoring the migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-import-preservation-'))
    const early = await mkdtemp(join(tmpdir(), 'hourmere-import-preservation-early-'))
    let owned: TestDatabase | undefined
    try {
      const files = await copyPredecessor(directory)
      for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
        await copyFile(join(migrationsDir, file), join(early, file))
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const check = async (sql: string) => {
        await rm(join(directory, migration), { force: true })
        owned = await createTestDatabase(serverUrl as string, early)
        try {
          await seedEarly(owned.pool)
          await runMigrations(owned.pool, directory)
          await seedLater(owned.pool)
          const before = await records(owned.pool)
          await writeFile(join(directory, migration), sql)
          expect(await runMigrations(owned.pool, directory)).toEqual([migration])
          expect(await records(owned.pool)).toEqual(before)
        } finally {
          await owned.drop()
          owned = undefined
        }
      }
      await check(source)
      await expect(
        check(`${source}\nUPDATE bookings SET title='Overwritten history';`),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await check(source)
    } finally {
      await owned?.drop()
      await rm(directory, { recursive: true, force: true })
      await rm(early, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(Object.keys(assertions))(
    'enforces %s and detects its source-copy mutation',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-import-mutation-'))
      let owned: TestDatabase | undefined
      try {
        await copyPredecessor(directory)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const check = async (sql: string) => {
          await writeFile(join(directory, migration), sql)
          owned = await createTestDatabase(serverUrl as string, directory)
          try {
            await assertions[name]?.(await fixture(owned.pool))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        const mutant = mutations[name]?.(source) as string
        expect(mutant).not.toBe(source)
        await expect(check(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
        await check(source)
      } finally {
        await owned?.drop()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
