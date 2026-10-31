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
const migration = '0047_event_type_durations.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function inventory(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

async function records(pool: pg.Pool, tables: Table[], physical = false) {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    const columns = table.columns.map(quote)
    // Backfilling the new list must only rewrite event rows; existing values and
    // timestamps remain exact. Unrelated tables must preserve their tuples too.
    if (physical && (table.schema !== 'public' || table.name !== 'event_types'))
      columns.push('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  }
  return result
}

async function copyPredecessor(directory: string, through = '0046') {
  const files = (await readdir(migrationsDir)).filter(
    (file) => file.endsWith('.sql') && file.slice(0, 4) <= through,
  )
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
}

async function seedEvent(pool: pg.Pool) {
  const organization = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1::uuid,'Duration team',$1::text,now())`,
    [organization],
  )
  const event = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types (organization_id,slug,title,duration_minutes)
        VALUES ($1,'historical','Historical event',30) RETURNING id`,
      [organization],
    )
  ).rows[0]?.id as string
  return { organization, event }
}

function insert(pool: pg.Pool, organization: string, durations: string, duration = 30) {
  return pool.query(
    `INSERT INTO event_types (organization_id,slug,title,duration_minutes,allowed_durations_minutes)
      VALUES ($1,$2,'Duration event',$3,$4::integer[]) RETURNING allowed_durations_minutes`,
    [organization, randomUUID(), duration, durations],
  )
}

async function legacyInsert(pool: pg.Pool, organization: string) {
  await expect(
    pool.query(
      `INSERT INTO event_types (organization_id,slug,title,duration_minutes)
        VALUES ($1,$2,'Legacy event',45) RETURNING allowed_durations_minutes`,
      [organization, randomUUID()],
    ),
  ).resolves.toMatchObject({ rows: [{ allowed_durations_minutes: [45] }] })
}

async function legacyUpdate(pool: pg.Pool, event: string) {
  await expect(
    pool.query(
      `UPDATE event_types SET duration_minutes=45 WHERE id=$1
        RETURNING duration_minutes,allowed_durations_minutes`,
      [event],
    ),
  ).resolves.toMatchObject({ rows: [{ duration_minutes: 45, allowed_durations_minutes: [45] }] })
}

const invalidLists = [
  ['empty', '{}', 30],
  ['too many', '{30,1,2,3,4,5,6,7,8,9,10,11,12}', 30],
  ['below minimum', '{30,0}', 30],
  ['above maximum', '{30,1441}', 30],
  ['missing default', '{15,60}', 30],
  ['duplicates', '{30,30}', 30],
  ['null member', '{30,NULL}', 30],
  ['multidimensional', '{{15,30},{60,90}}', 30],
  ['nonstandard lower bound', '[0:1]={15,30}', 30],
] as const

describe.skipIf(!serverUrl)('event type duration migration', () => {
  it('backfills populated 0046 data without changing old fields, matches fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-durations-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      await copyPredecessor(directory, '0012')
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'duration_old' })
      await seedEarly(upgraded.pool)
      await copyPredecessor(directory)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await upgraded.pool.query(`UPDATE event_types SET duration_minutes=
        CASE slug WHEN 'upgrade-event-1' THEN 1 WHEN 'upgrade-event-2' THEN 15
          WHEN 'upgrade-event-3' THEN 60 WHEN 'upgrade-event-4' THEN 1440 ELSE 30 END`)
      const tables = await inventory(upgraded.pool)
      const before = await records(upgraded.pool, tables, true)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.event_types']).toHaveLength(7)
      expect(
        (await upgraded.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0046_current_inviter_signup.sql' })
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, tables, true)).toEqual(before)
      expect(
        (
          await upgraded.pool.query(`SELECT duration_minutes,allowed_durations_minutes
            FROM event_types ORDER BY duration_minutes`)
        ).rows,
      ).toEqual(
        [1, 15, 30, 30, 30, 60, 1440].map((duration) => ({
          duration_minutes: duration,
          allowed_durations_minutes: [duration],
        })),
      )
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'duration_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await upgraded.pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
      const latest = await inventory(upgraded.pool)
      const acknowledged = await records(upgraded.pool, latest, true)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool, latest, true)).toEqual(acknowledged)
      expect((await upgraded.pool.query(ledger)).rows).toEqual(recorded)
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

  it('validates list bounds, shape, distinct values and default membership while preserving legacy writes', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'duration_lists',
    })
    try {
      const { organization, event } = await seedEvent(owned.pool)
      for (const [duration, list] of [
        [1, '{1}'],
        [1440, '{1440}'],
        [30, '{60,15,30}'],
        [30, '{30,1,2,3,4,5,6,7,8,9,10,11}'],
      ] as const)
        await expect(insert(owned.pool, organization, list, duration)).resolves.toMatchObject({
          rowCount: 1,
        })
      await expect(insert(owned.pool, organization, '{60,15,30}')).resolves.toMatchObject({
        rows: [{ allowed_durations_minutes: [60, 15, 30] }],
      })
      for (const [name, list, duration] of invalidLists)
        await expect(insert(owned.pool, organization, list, duration), name).rejects.toMatchObject({
          code: '23514',
        })
      await legacyInsert(owned.pool, organization)
      await legacyUpdate(owned.pool, event)
      await expect(
        owned.pool.query('UPDATE event_types SET allowed_durations_minutes=NULL WHERE id=$1', [
          event,
        ]),
      ).rejects.toMatchObject({ code: '23502' })
      await owned.pool.query(
        'UPDATE event_types SET allowed_durations_minutes=ARRAY[15,30,45,60] WHERE id=$1',
        [event],
      )
      await expect(
        owned.pool.query('UPDATE event_types SET duration_minutes=15 WHERE id=$1', [event]),
      ).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        owned.pool.query('UPDATE event_types SET duration_minutes=90 WHERE id=$1', [event]),
      ).rejects.toMatchObject({ code: '23514' })
      expect(
        (
          await owned.pool.query(
            'SELECT duration_minutes,allowed_durations_minutes FROM event_types WHERE id=$1',
            [event],
          )
        ).rows,
      ).toEqual([{ duration_minutes: 15, allowed_durations_minutes: [15, 30, 45, 60] }])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 30_000)

  it.each([
    'empty',
    'too many',
    'below minimum',
    'above maximum',
    'missing default',
    'duplicates',
    'null member',
    'multidimensional',
    'nonstandard lower bound',
    'not null',
    'legacy insert',
    'legacy update',
    'explicit insert',
    'explicit update',
    'multi list preservation',
    'singleton backfill',
    'timestamp preservation',
    'timestamp trigger restored',
  ])(
    'detects a source-copy mutation of %s and passes after restoring it',
    async (protection) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-durations-mutant-'))
      let owned: TestDatabase | undefined
      try {
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const replacements: Record<string, [string, string]> = {
          empty: ['cardinality(durations) BETWEEN 1 AND 12', 'cardinality(durations) <= 12'],
          'too many': ['cardinality(durations) BETWEEN 1 AND 12', 'cardinality(durations) >= 1'],
          'below minimum': ['duration NOT BETWEEN 1 AND 1440', 'duration > 1440'],
          'above maximum': ['duration NOT BETWEEN 1 AND 1440', 'duration < 1'],
          'missing default': ['AND default_duration = ANY(durations)', ''],
          duplicates: ['count(DISTINCT duration)', 'count(*)'],
          'null member': ['count(DISTINCT duration)', 'count(*)'],
          multidimensional: ['array_ndims(durations) = 1', 'true'],
          'nonstandard lower bound': ['AND array_lower(durations, 1) = 1', ''],
          'not null': ['ALTER COLUMN allowed_durations_minutes SET NOT NULL,', ''],
          'legacy insert': ["TG_OP = 'INSERT' AND", 'false AND'],
          'legacy update': [
            'AND OLD.allowed_durations_minutes = ARRAY[OLD.duration_minutes] THEN',
            'AND false THEN',
          ],
          'explicit insert': [
            "TG_OP = 'INSERT' AND NEW.allowed_durations_minutes IS NULL",
            "TG_OP = 'INSERT'",
          ],
          'explicit update': [
            'AND NEW.allowed_durations_minutes IS NOT DISTINCT FROM OLD.allowed_durations_minutes',
            '',
          ],
          'multi list preservation': [
            'AND OLD.allowed_durations_minutes = ARRAY[OLD.duration_minutes] THEN',
            'THEN',
          ],
          'singleton backfill': [
            'SET allowed_durations_minutes = ARRAY[duration_minutes];',
            'SET allowed_durations_minutes = ARRAY[duration_minutes,1440];',
          ],
          'timestamp preservation': [
            'ALTER TABLE event_types DISABLE TRIGGER event_types_updated_at;',
            '',
          ],
          'timestamp trigger restored': [
            'ALTER TABLE event_types ENABLE TRIGGER event_types_updated_at;',
            '',
          ],
        }
        const replacement = replacements[protection] as [string, string]
        let mutant = source.replace(...replacement)
        // Default membership also rejects empty lists. Remove both guards to make
        // the empty-list negative control observable through a real INSERT.
        if (protection === 'empty')
          mutant = mutant.replace('AND default_duration = ANY(durations)', '')
        expect(mutant).not.toBe(source)
        await copyPredecessor(directory)
        const check = async (sql: string) => {
          owned = await createTestDatabase(serverUrl as string, directory, {
            tag: 'duration_mutant',
          })
          try {
            const { organization, event } = await seedEvent(owned.pool)
            await owned.pool.query('ALTER TABLE event_types DISABLE TRIGGER event_types_updated_at')
            await owned.pool.query(
              "UPDATE event_types SET updated_at='2020-01-02T03:04:05.123456Z'",
            )
            await owned.pool.query('ALTER TABLE event_types ENABLE TRIGGER event_types_updated_at')
            const path = join(directory, migration)
            await writeFile(path, sql)
            await runMigrations(owned.pool, directory)
            if (protection === 'legacy insert') await legacyInsert(owned.pool, organization)
            else if (protection === 'legacy update') await legacyUpdate(owned.pool, event)
            else if (protection === 'explicit insert')
              await expect(insert(owned.pool, organization, '{60,15,30}')).resolves.toMatchObject({
                rows: [{ allowed_durations_minutes: [60, 15, 30] }],
              })
            else if (protection === 'explicit update')
              await expect(
                owned.pool.query(
                  `UPDATE event_types SET duration_minutes=60,allowed_durations_minutes=ARRAY[30,60]
                    WHERE id=$1 RETURNING allowed_durations_minutes`,
                  [event],
                ),
              ).resolves.toMatchObject({ rows: [{ allowed_durations_minutes: [30, 60] }] })
            else if (protection === 'multi list preservation') {
              await owned.pool.query(
                'UPDATE event_types SET allowed_durations_minutes=ARRAY[15,30,60] WHERE id=$1',
                [event],
              )
              await expect(
                owned.pool.query(
                  `UPDATE event_types SET duration_minutes=15 WHERE id=$1
                    RETURNING allowed_durations_minutes`,
                  [event],
                ),
              ).resolves.toMatchObject({ rows: [{ allowed_durations_minutes: [15, 30, 60] }] })
            } else if (protection === 'not null')
              await expect(
                owned.pool.query(
                  'UPDATE event_types SET allowed_durations_minutes=NULL WHERE id=$1',
                  [event],
                ),
              ).rejects.toMatchObject({ code: '23502' })
            else if (protection === 'singleton backfill')
              expect(
                (await owned.pool.query('SELECT allowed_durations_minutes FROM event_types')).rows,
              ).toEqual([{ allowed_durations_minutes: [30] }])
            else if (protection === 'timestamp preservation')
              expect(
                (await owned.pool.query('SELECT updated_at::text FROM event_types')).rows,
              ).toEqual([{ updated_at: '2020-01-02 03:04:05.123456+00' }])
            else if (protection === 'timestamp trigger restored')
              await expect(
                owned.pool.query(
                  `UPDATE event_types SET title='Edited event' WHERE id=$1
                    RETURNING updated_at > '2020-01-02T03:04:05.123456Z' AS updated`,
                  [event],
                ),
              ).resolves.toMatchObject({ rows: [{ updated: true }] })
            else {
              const invalid = invalidLists.find(([name]) => name === protection)
              expect(invalid).toBeDefined()
              await expect(
                insert(owned.pool, organization, invalid?.[1] as string, invalid?.[2]),
              ).rejects.toMatchObject({ code: '23514' })
            }
            expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
          } finally {
            await owned.drop()
            owned = undefined
            await rm(join(directory, migration), { force: true })
          }
        }
        await check(source)
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
})
