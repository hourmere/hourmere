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
const migration = '0058_one_time_link_idempotency.sql'
const predecessor = '0053_one_time_booking_links.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const markerColumns = ['idempotency_key', 'idempotency_actor_kind', 'idempotency_actor_id']

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
        AND table_name <> 'schema_migrations'
      ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables) {
    // Snapshot every predecessor field, exact PostgreSQL timestamps and physical tuples.
    const value =
      table.name === 'one_time_booking_links' ? 'to_jsonb(t) - $1::text[]' : 'to_jsonb(t)'
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT (${value})::text AS value,xmin::text,ctid::text
          FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY (${value})::text COLLATE "C"`,
        table.name === 'one_time_booking_links' ? [markerColumns] : [],
      )
    ).rows
  }
  return result
}

interface Fixture {
  pool: pg.Pool
  organization: string
  otherOrganization: string
  creator: string
  otherCreator: string
  event: string
  otherEvent: string
  actor: string
}

async function fixture(pool: pg.Pool): Promise<Fixture> {
  const users = (
    await pool.query<{ id: string }>(`INSERT INTO auth."user" (name,email,"emailVerified") VALUES
      ('Synthetic retry owner','retry-owner@example.test',true),
      ('Synthetic second owner','retry-second@example.test',true) RETURNING id`)
  ).rows
  const organizations = (
    await pool.query<{ id: string }>(`INSERT INTO auth.organization (name,slug,"createdAt") VALUES
      ('Retry team','retry-team',now()),('Other retry team','other-retry-team',now()) RETURNING id`)
  ).rows
  const organization = organizations[0]?.id as string
  const otherOrganization = organizations[1]?.id as string
  const events = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types (organization_id,slug,title,duration_minutes) VALUES
        ($1,'retry-event','Retry event',30),($2,'other-retry-event','Other retry event',30) RETURNING id`,
      [organization, otherOrganization],
    )
  ).rows
  return {
    pool,
    organization,
    otherOrganization,
    creator: users[0]?.id as string,
    otherCreator: users[1]?.id as string,
    event: events[0]?.id as string,
    otherEvent: events[1]?.id as string,
    actor: randomUUID(),
  }
}

async function insertLink(f: Fixture, overrides: Record<string, unknown> = {}) {
  const values = {
    organization_id: f.organization,
    event_type_id: f.event,
    creator_user_id: f.creator,
    token_hash: randomUUID().replaceAll('-', '').repeat(2),
    idempotency_key: 'retained-create-request',
    idempotency_actor_kind: 'session',
    idempotency_actor_id: f.actor,
    ...overrides,
  }
  const fields = Object.keys(values)
  return (
    await f.pool.query<{ id: string }>(
      `INSERT INTO one_time_booking_links (${fields.map(quote).join(',')})
        VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

async function seedPredecessor(directory: string) {
  const files = await copyPredecessor(directory)
  const earlyDirectory = await mkdtemp(join(tmpdir(), 'hourmere-link-retry-early-'))
  let owned: TestDatabase | undefined
  try {
    for (const file of files.filter((file) => file.slice(0, 4) <= '0012'))
      await copyFile(join(migrationsDir, file), join(earlyDirectory, file))
    owned = await createTestDatabase(serverUrl as string, earlyDirectory)
    await seedEarly(owned.pool)
    await runMigrations(owned.pool, directory)
    await seedLater(owned.pool)
    const f = await fixture(owned.pool)
    for (const [state, token] of [
      ['active', 'a'],
      ['expired', 'b'],
      ['revoked', 'c'],
    ])
      await owned.pool.query(
        `INSERT INTO one_time_booking_links
          (organization_id,event_type_id,creator_user_id,token_hash,state,expires_at,
           prefill_name,prefill_email,revoked_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,'2030-03-04T05:06:07.123456Z','Predecessor invitee',
            'predecessor@example.test',$6,'2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z')`,
        [
          f.organization,
          f.event,
          f.creator,
          token?.repeat(64),
          state,
          state === 'revoked' ? '2026-02-03T04:05:06.654321Z' : null,
        ],
      )
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `WITH booking AS (
          INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source)
          VALUES ($1,$2,'2030-04-05T09:00Z','2030-04-05T09:30Z','Used predecessor link','web')
          RETURNING id)
        INSERT INTO one_time_booking_links
          (organization_id,event_type_id,creator_user_id,token_hash,state,booking_id,used_at)
          SELECT $1,$2,$3,repeat('d',64),'used',id,clock_timestamp() FROM booking`,
        [f.organization, f.event, f.creator],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return owned
  } catch (error) {
    await owned?.drop()
    throw error
  } finally {
    await rm(earlyDirectory, { recursive: true, force: true })
  }
}

const assertions: Record<string, (f: Fixture) => Promise<void>> = {
  'printable bounded key': async (f) => {
    for (const key of ['', 'x'.repeat(256), ' ', 'line\nbreak', 'tab\tkey', '\u007f', '请求'])
      await expect(insertLink(f, { idempotency_key: key })).rejects.toMatchObject({ code: '23514' })
    await insertLink(f, { idempotency_key: '!'.repeat(255) })
  },
  'complete marker': async (f) => {
    for (const values of [
      { idempotency_key: null },
      { idempotency_actor_kind: null },
      { idempotency_actor_id: null },
      { idempotency_key: null, idempotency_actor_kind: null },
      { idempotency_key: null, idempotency_actor_id: null },
      { idempotency_actor_kind: null, idempotency_actor_id: null },
    ])
      await expect(insertLink(f, values)).rejects.toMatchObject({ code: '23514' })
    await insertLink(f, {
      idempotency_key: null,
      idempotency_actor_kind: null,
      idempotency_actor_id: null,
    })
  },
  'actor vocabulary': async (f) => {
    await expect(insertLink(f, { idempotency_actor_kind: 'unknown' })).rejects.toMatchObject({
      code: '23514',
    })
    for (const kind of ['session', 'api_key', 'oauth'])
      await insertLink(f, { idempotency_actor_kind: kind })
  },
  'scoped uniqueness': async (f) => {
    await insertLink(f)
    await expect(insertLink(f)).rejects.toMatchObject({ code: '23505' })
    await insertLink(f, { idempotency_actor_id: randomUUID() })
    await insertLink(f, { idempotency_actor_kind: 'api_key' })
    await insertLink(f, { creator_user_id: f.otherCreator })
    await insertLink(f, { organization_id: f.otherOrganization, event_type_id: f.otherEvent })
    await insertLink(f, { idempotency_key: 'another-request' })
    const withoutMarker = Object.fromEntries(markerColumns.map((column) => [column, null]))
    await insertLink(f, withoutMarker)
    await insertLink(f, withoutMarker)
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM one_time_booking_links')).rows,
    ).toEqual([{ n: 8 }])
  },
  'immutable marker': async (f) => {
    const id = await insertLink(f)
    for (const values of [
      { idempotency_key: 'different-key' },
      { idempotency_actor_kind: 'oauth' },
      { idempotency_actor_id: randomUUID() },
      Object.fromEntries(markerColumns.map((column) => [column, null])),
    ]) {
      const fields = Object.keys(values)
      await expect(
        f.pool.query(
          `UPDATE one_time_booking_links SET ${fields.map((field, i) => `${quote(field)}=$${i + 1}`).join(',')}
            WHERE id=$${fields.length + 1}`,
          [...Object.values(values), id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'one_time_booking_links_idempotency_immutable',
      })
    }
  },
}

const mutations: Record<string, (source: string) => string> = {
  'printable bounded key': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_idempotency_key_format;`,
  'complete marker': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_idempotency_shape;`,
  'actor vocabulary': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_idempotency_actor_kind;`,
  'scoped uniqueness': (source) => `${source}\nDROP INDEX one_time_booking_links_idempotency_key;`,
  'immutable marker': (source) =>
    `${source}\nDROP TRIGGER one_time_booking_links_idempotency_guard ON one_time_booking_links;`,
}

describe.skipIf(!serverUrl)('one-time link create idempotency migration', () => {
  it('preserves populated 0053 data, matches fresh schema and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-link-retry-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await seedPredecessor(directory)
      const before = await records(upgraded.pool)
      expect(before['public.one_time_booking_links']).toHaveLength(4)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool)).toEqual(before)
      expect(
        (
          await upgraded.pool.query(`SELECT count(*)::int AS n FROM one_time_booking_links
        WHERE idempotency_key IS NULL AND idempotency_actor_kind IS NULL AND idempotency_actor_id IS NULL`)
        ).rows,
      ).toEqual([{ n: 4 }])
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      const ledgerQuery =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const ledger = (await upgraded.pool.query(ledgerQuery)).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect((await upgraded.pool.query(ledgerQuery)).rows).toEqual(ledger)
      expect(await records(upgraded.pool)).toEqual(before)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(Object.keys(assertions))(
    'enforces %s and detects its source-copy mutation',
    async (protection) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-link-retry-mutation-'))
      let owned: TestDatabase | undefined
      try {
        await copyPredecessor(directory)
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const check = async (sql: string) => {
          await writeFile(join(directory, migration), sql)
          owned = await createTestDatabase(serverUrl as string, directory)
          try {
            await assertions[protection]?.(await fixture(owned.pool))
            expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        const mutant = mutations[protection]?.(source) as string
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

  it('detects a source-copy historical overwrite and passes with restored source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-link-retry-preservation-'))
    let owned: TestDatabase | undefined
    try {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const check = async (sql: string) => {
        await rm(join(directory, migration), { force: true })
        owned = await seedPredecessor(directory)
        try {
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
        check(`${source}\nUPDATE event_types SET title='Overwritten history';`),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await check(source)
    } finally {
      await owned?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('detects a source-copy credential cascade that removes retained retry attribution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-link-retry-attribution-'))
    let owned: TestDatabase | undefined
    try {
      await copyPredecessor(directory)
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const check = async (sql: string) => {
        await writeFile(join(directory, migration), sql)
        owned = await createTestDatabase(serverUrl as string, directory)
        try {
          const f = await fixture(owned.pool)
          const session = (
            await f.pool.query<{ id: string }>(
              `INSERT INTO auth.session
            ("userId",token,"expiresAt","createdAt","updatedAt")
            VALUES ($1,'synthetic-retained-retry-session','2040-01-01',now(),now()) RETURNING id`,
              [f.creator],
            )
          ).rows[0]?.id as string
          const id = await insertLink(f, { idempotency_actor_id: session })
          await f.pool.query('DELETE FROM auth.session WHERE id=$1', [session])
          expect(
            (await f.pool.query('SELECT id FROM one_time_booking_links WHERE id=$1', [id])).rows,
          ).toEqual([{ id }])
          await expect(insertLink(f, { idempotency_actor_id: session })).rejects.toMatchObject({
            code: '23505',
          })
        } finally {
          await owned.drop()
          owned = undefined
        }
      }
      await check(source)
      await expect(
        check(`${source}\nALTER TABLE one_time_booking_links ADD FOREIGN KEY
        (idempotency_actor_id) REFERENCES auth.session(id) ON DELETE CASCADE;`),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await check(source)
    } finally {
      await owned?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps UUIDv7 defaults and historical retry attribution after credential and creator deletion', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      const session = (
        await f.pool.query<{ id: string }>(
          `INSERT INTO auth.session
        ("userId",token,"expiresAt","createdAt","updatedAt")
        VALUES ($1,'synthetic-retry-session','2040-01-01',now(),now()) RETURNING id`,
          [f.creator],
        )
      ).rows[0]?.id as string
      const key = (
        await f.pool.query<{ id: string }>(
          `INSERT INTO auth.apikey
        ("configId","referenceId",key,"createdAt","updatedAt")
        VALUES ('default',$1,'synthetic-retry-api-key',now(),now()) RETURNING id`,
          [f.creator],
        )
      ).rows[0]?.id as string
      const sessionLink = await insertLink(f, { idempotency_actor_id: session })
      const keyLink = await insertLink(f, {
        idempotency_actor_kind: 'api_key',
        idempotency_actor_id: key,
      })
      expect(sessionLink[14]).toBe('7')
      expect(keyLink[14]).toBe('7')
      const query =
        'SELECT to_jsonb(t)::text AS value,xmin::text,ctid::text FROM one_time_booking_links t ORDER BY id'
      const before = (await f.pool.query(query)).rows
      await f.pool.query('DELETE FROM auth.session WHERE id=$1', [session])
      await f.pool.query('DELETE FROM auth.apikey WHERE id=$1', [key])
      await f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.creator])
      expect((await f.pool.query(query)).rows).toEqual(before)
      await expect(insertLink(f, { idempotency_actor_id: session })).rejects.toMatchObject({
        code: '23505',
      })
      await expect(
        insertLink(f, { idempotency_actor_kind: 'api_key', idempotency_actor_id: key }),
      ).rejects.toMatchObject({ code: '23505' })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)
})
