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
const migration = '0053_one_time_booking_links.sql'
const predecessorMigration = '0050_booking_success_redirect.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

async function predecessorFiles(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= predecessorMigration)
    .sort()
  expect(files.at(-1)).toBe(predecessorMigration)
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`
      SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
      WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
        AND table_name NOT IN ('schema_migrations','one_time_booking_links')
      ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(`SELECT to_jsonb(t)::text AS value,xmin::text,ctid::text
        FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
    ).rows
  return result
}

async function seedPredecessor(directory: string) {
  const files = await predecessorFiles(directory)
  const early = files.filter((file) => file.slice(0, 4) <= '0012')
  const earlyDirectory = await mkdtemp(join(tmpdir(), 'hourmere-one-time-early-'))
  let owned: TestDatabase | undefined
  try {
    for (const file of early) await copyFile(join(migrationsDir, file), join(earlyDirectory, file))
    owned = await createTestDatabase(serverUrl as string, earlyDirectory)
    await seedEarly(owned.pool)
    await runMigrations(owned.pool, directory)
    await seedLater(owned.pool)
    await owned.pool.query(`
      UPDATE event_types SET
        allowed_durations_minutes=ARRAY[45,duration_minutes,15],
        notifications='{"reminders":[],"followUps":[]}',
        success_redirect='{"url":"https://example.test/thanks","parameters":["eventTypeSlug"],"includeInviteePersonalData":false,"allowEmbedParent":false}'
      WHERE duration_minutes NOT IN (15,45);
      UPDATE bookings SET
        success_redirect='{"url":"https://example.test/previous","parameters":["eventTypeSlug"],"includeInviteePersonalData":false,"allowEmbedParent":false}'
      WHERE status='confirmed';
      INSERT INTO auth.apikey ("configId",name,"referenceId",key,"createdAt","updatedAt",metadata)
        SELECT 'default','One-time predecessor ' || s.scope,k."referenceId",
          'synthetic-one-time-predecessor-' || s.scope,'2026-01-02T03:04:05.123456Z',
          '2026-02-03T04:05:06.654321Z',json_build_object('scope',s.scope,
            'organizationId',k.metadata::jsonb->>'organizationId','retained','preserve')::text
        FROM (SELECT * FROM auth.apikey ORDER BY id LIMIT 1) k
        CROSS JOIN (VALUES ('read'),('bookings')) AS s(scope)`)
    return owned
  } catch (error) {
    await owned?.drop()
    throw error
  } finally {
    await rm(earlyDirectory, { recursive: true, force: true })
  }
}

interface Fixture {
  pool: pg.Pool
  creator: string
  otherCreator: string
  organization: string
  otherOrganization: string
  event: string
  otherEvent: string
  booking: string
  secondBooking: string
  cancelledBooking: string
}

async function fixture(pool: pg.Pool): Promise<Fixture> {
  const creator = (
    await pool.query<{ id: string }>(`INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Synthetic host','one-time-host@example.test',true) RETURNING id`)
  ).rows[0]?.id as string
  const otherCreator = (
    await pool.query<{ id: string }>(`INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Other host','other-one-time-host@example.test',true) RETURNING id`)
  ).rows[0]?.id as string
  const organizations = (
    await pool.query<{ id: string }>(`INSERT INTO auth.organization (name,slug,"createdAt") VALUES
      ('Synthetic team','one-time-team',now()),('Other team','other-one-time-team',now()) RETURNING id`)
  ).rows
  const organization = organizations[0]?.id as string
  const otherOrganization = organizations[1]?.id as string
  await pool.query(
    `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
    VALUES ($1,$2,'owner',now()),($3,$4,'owner',now())`,
    [organization, creator, otherOrganization, otherCreator],
  )
  const events = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types
      (organization_id,slug,title,duration_minutes) VALUES
      ($1,'one-time-event','One-time event',30),($1,'other-event','Other event',30) RETURNING id`,
      [organization],
    )
  ).rows
  const event = events[0]?.id as string
  const otherEvent = events[1]?.id as string
  const bookings = (
    await pool.query<{ id: string }>(
      `INSERT INTO bookings
      (organization_id,event_type_id,start_at,end_at,title,source,status,cancelled_at) VALUES
      ($1,$2,'2030-01-01T09:00Z','2030-01-01T09:30Z','First booking','web','confirmed',NULL),
      ($1,$2,'2030-01-02T09:00Z','2030-01-02T09:30Z','Second booking','web','confirmed',NULL),
      ($1,$2,'2030-01-03T09:00Z','2030-01-03T09:30Z','Cancelled booking','web','cancelled',now())
      RETURNING id`,
      [organization, event],
    )
  ).rows
  return {
    pool,
    creator,
    otherCreator,
    organization,
    otherOrganization,
    event,
    otherEvent,
    booking: bookings[0]?.id as string,
    secondBooking: bookings[1]?.id as string,
    cancelledBooking: bookings[2]?.id as string,
  }
}

async function insertLink(f: Fixture, overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    organization_id: f.organization,
    event_type_id: f.event,
    creator_user_id: f.creator,
    token_hash: 'a'.repeat(64),
    ...overrides,
  }
  const fields = Object.keys(values)
  return (
    await f.pool.query<{ id: string }>(
      `INSERT INTO one_time_booking_links
    (${fields.map(quote).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})
    RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

const used = (f: Fixture) => ({
  state: 'used',
  booking_id: f.booking,
  used_at: '2026-01-01T00:00Z',
})
const checkViolation = { code: '23514' }

const assertions: Record<string, (f: Fixture) => Promise<void>> = {
  'hash format': async (f) => {
    for (const token_hash of ['synthetic-raw-capability', 'A'.repeat(64), 'a'.repeat(63)])
      await expect(insertLink(f, { token_hash })).rejects.toMatchObject(checkViolation)
  },
  'unique hash': async (f) => {
    await insertLink(f)
    await expect(insertLink(f)).rejects.toMatchObject({ code: '23505' })
  },
  'bounded name': async (f) => {
    await expect(insertLink(f, { prefill_name: '名'.repeat(201) })).rejects.toMatchObject(
      checkViolation,
    )
  },
  'bounded email': async (f) => {
    await expect(insertLink(f, { prefill_email: 'a'.repeat(321) })).rejects.toMatchObject(
      checkViolation,
    )
  },
  'state vocabulary': async (f) => {
    await expect(insertLink(f, { state: 'available' })).rejects.toMatchObject(checkViolation)
  },
  'used shape': async (f) => {
    for (const values of [
      { booking_id: f.booking },
      { used_at: new Date() },
      { ...used(f), used_at: null },
    ])
      await expect(insertLink(f, values)).rejects.toMatchObject(checkViolation)
  },
  'revoked shape': async (f) => {
    for (const values of [{ state: 'revoked' }, { revoked_at: new Date() }])
      await expect(insertLink(f, values)).rejects.toMatchObject(checkViolation)
  },
  'event tenancy': async (f) => {
    await expect(insertLink(f, { organization_id: f.otherOrganization })).rejects.toMatchObject({
      code: '23503',
    })
  },
  'creator reference': async (f) => {
    await expect(
      insertLink(f, { creator_user_id: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: '23503' })
  },
  'unique booking': async (f) => {
    await insertLink(f, used(f))
    await expect(insertLink(f, { ...used(f), token_hash: 'b'.repeat(64) })).rejects.toMatchObject({
      code: '23505',
    })
  },
  'immutable issuance': async (f) => {
    const id = await insertLink(f)
    for (const [field, value] of Object.entries({
      token_hash: 'b'.repeat(64),
      event_type_id: f.otherEvent,
      creator_user_id: f.otherCreator,
      expires_at: '2040-01-01T00:00Z',
      prefill_name: 'Replacement',
      prefill_email: 'other@example.test',
      created_at: '2020-01-01T00:00Z',
    }))
      await expect(
        f.pool.query(`UPDATE one_time_booking_links SET ${quote(field)}=$1 WHERE id=$2`, [
          value,
          id,
        ]),
      ).rejects.toMatchObject(checkViolation)
  },
  'terminal state': async (f) => {
    for (const [i, state] of ['used', 'expired', 'revoked'].entries()) {
      const id = await insertLink(f, {
        token_hash: String(i).repeat(64),
        state,
        ...(state === 'used' ? used(f) : {}),
        ...(state === 'revoked' ? { revoked_at: new Date() } : {}),
      })
      await expect(
        f.pool.query(
          `UPDATE one_time_booking_links SET state='active',
        booking_id=NULL,used_at=NULL,revoked_at=NULL WHERE id=$1`,
          [id],
        ),
      ).rejects.toMatchObject(checkViolation)
      if (state === 'used') {
        await expect(
          f.pool.query('UPDATE one_time_booking_links SET booking_id=$1 WHERE id=$2', [
            f.secondBooking,
            id,
          ]),
        ).rejects.toMatchObject(checkViolation)
        await expect(
          f.pool.query(
            "UPDATE one_time_booking_links SET used_at=used_at+interval '1 day' WHERE id=$1",
            [id],
          ),
        ).rejects.toMatchObject(checkViolation)
      }
    }
  },
  'confirmed same-event booking': async (f) => {
    await expect(
      insertLink(f, { ...used(f), booking_id: f.cancelledBooking }),
    ).rejects.toMatchObject(checkViolation)
    await expect(insertLink(f, { ...used(f), event_type_id: f.otherEvent })).rejects.toMatchObject(
      checkViolation,
    )
    await expect(
      insertLink(f, { ...used(f), booking_id: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject(checkViolation)
  },
  'database-clock expiry': async (f) => {
    const expiry = (
      await f.pool.query<{ expiry: Date }>("SELECT clock_timestamp()-interval '1 second' AS expiry")
    ).rows[0]?.expiry
    await expect(insertLink(f, { ...used(f), expires_at: expiry })).rejects.toMatchObject(
      checkViolation,
    )
  },
  'database wall clock': async (f) => {
    const client = await f.pool.connect()
    try {
      await client.query('BEGIN')
      const expiry = (
        await client.query<{ expiry: Date }>(
          "SELECT clock_timestamp()+interval '50 milliseconds' AS expiry",
        )
      ).rows[0]?.expiry
      await client.query('SELECT pg_sleep(0.08)')
      await expect(
        client.query(
          `INSERT INTO one_time_booking_links
          (organization_id,event_type_id,creator_user_id,token_hash,state,booking_id,used_at,expires_at)
          VALUES ($1,$2,$3,$4,'used',$5,clock_timestamp(),$6)`,
          [f.organization, f.event, f.creator, 'a'.repeat(64), f.booking, expiry],
        ),
      ).rejects.toMatchObject({
        ...checkViolation,
        constraint: 'one_time_booking_links_claim_expired',
      })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  },
  'retained booking evidence': async (f) => {
    await insertLink(f, used(f))
    await expect(
      f.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking]),
    ).rejects.toMatchObject({ code: '23503' })
  },
}

const mutations: Record<string, (source: string) => string> = {
  'hash format': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_token_hash_check;`,
  'unique hash': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_token_hash_key;`,
  'bounded name': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_prefill_name_check;`,
  'bounded email': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_prefill_email_check;`,
  'state vocabulary': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_state_check;`,
  'used shape': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_used_shape;`,
  'revoked shape': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_revoked_shape;`,
  'event tenancy': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_event_type_id_organization_id_fkey;`,
  'creator reference': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_creator_user_id_fkey;`,
  'unique booking': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_booking_id_key;`,
  'immutable issuance': (source) =>
    source.replace(
      'IF ROW(NEW.id, NEW.organization_id',
      'IF false AND ROW(NEW.id, NEW.organization_id',
    ),
  'terminal state': (source) =>
    source.replace("IF OLD.state <> 'active' AND", "IF false AND OLD.state <> 'active' AND"),
  'confirmed same-event booking': (source) => source.replace('IF NOT FOUND THEN', 'IF false THEN'),
  'database-clock expiry': (source) =>
    source.replace(
      'IF NEW.expires_at IS NOT NULL AND',
      'IF false AND NEW.expires_at IS NOT NULL AND',
    ),
  'database wall clock': (source) => source.replace('<= clock_timestamp()', '<= now()'),
  'retained booking evidence': (source) =>
    `${source}\nALTER TABLE one_time_booking_links DROP CONSTRAINT one_time_booking_links_booking_id_organization_id_fkey;`,
}

describe.skipIf(!serverUrl)('one-time booking links migration', () => {
  it('preserves populated 0050 predecessor data, matches fresh schema and reruns without changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-one-time-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await seedPredecessor(directory)
      const before = await records(upgraded.pool)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      expect(before['public.event_types']?.length).toBeGreaterThan(0)
      const acknowledgements = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool)).toEqual(before)
      expect((await upgraded.pool.query('SELECT * FROM one_time_booking_links')).rows).toEqual([])
      expect(
        (
          await upgraded.pool.query(
            'SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',
            [migration],
          )
        ).rows,
      ).toEqual(acknowledgements)
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const acknowledged = (
        await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool)).toEqual(before)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(acknowledged)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('detects source-copy historical-data overwrite and passes again with restored source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-one-time-preservation-'))
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
          expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
        } finally {
          await owned.drop()
          owned = undefined
        }
      }
      await check(source)
      await expect(
        check(`${source}\nUPDATE event_types SET success_redirect=NULL;`),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await check(source)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it.each(Object.keys(assertions))(
    'enforces %s and detects its source-copy mutation',
    async (protection) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-one-time-mutation-'))
      let owned: TestDatabase | undefined
      try {
        await predecessorFiles(directory)
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
        try {
          await owned?.drop()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )

  it('retains use after cancellation and cascades with the organization', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const f = await fixture(owned.pool)
      const id = await insertLink(f, used(f))
      await f.pool.query(
        "UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",
        [f.booking],
      )
      expect(
        (
          await f.pool.query(
            'SELECT state,booking_id,used_at IS NOT NULL AS has_used_at FROM one_time_booking_links WHERE id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ state: 'used', booking_id: f.booking, has_used_at: true }])
      await f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization])
      expect(
        (await f.pool.query('SELECT * FROM one_time_booking_links WHERE id=$1', [id])).rows,
      ).toEqual([])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)
})
