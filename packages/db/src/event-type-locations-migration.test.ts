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
const migration = '0056_event_type_locations.sql'
const predecessor = '0053_one_time_booking_links.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

async function copyPredecessor(directory: string, through = predecessor) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= through)
    .sort()
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

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

async function records(pool: pg.Pool, tables: Table[], includeChangedPhysical = false) {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    const columns = table.columns.map(quote)
    if (
      includeChangedPhysical ||
      table.schema !== 'public' ||
      !['event_types', 'bookings'].includes(table.name)
    )
      columns.push('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map(({ row }) => row)
  }
  return result
}

const legacyLocations = [
  { kind: 'google_meet', autoCreate: true },
  { kind: 'zoom', autoCreate: true },
  { kind: 'phone', number: '+14155550123' },
  { kind: 'phone' },
  { kind: 'in_person', address: 'Suite 12, 3 Example Street' },
  { kind: 'link', url: 'https://example.test/meeting?retained=yes' },
  null,
] as const

async function seedLocations(pool: pg.Pool) {
  const organization = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
      VALUES ($1::uuid,'Location team',$1::text,'2025-01-02T03:04:05.123456Z')`,
    [organization],
  )
  const events: string[] = []
  const bookings: string[] = []
  for (const [index, location] of legacyLocations.entries()) {
    const event = (
      await pool.query<{ id: string }>(
        `INSERT INTO event_types (organization_id,slug,title,duration_minutes,location,created_at,updated_at)
          VALUES ($1,$2,'Historical location',30,$3::jsonb,
            '2025-01-02T03:04:05.123456Z','2025-02-03T04:05:06.654321Z') RETURNING id`,
        [
          organization,
          `historical-location-${index}`,
          location === null ? null : JSON.stringify(location),
        ],
      )
    ).rows[0]?.id as string
    events.push(event)
    const resolved =
      location?.kind === 'google_meet' || location?.kind === 'zoom'
        ? { ...location, url: `https://example.test/resolved-${index}` }
        : location
    bookings.push(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,location,source,created_at,updated_at)
            VALUES ($1,$2,'2030-01-02T09:00Z','2030-01-02T09:30Z','Historical booking',$3::jsonb,'web',
              '2025-01-02T03:04:05.123456Z','2025-02-03T04:05:06.654321Z') RETURNING id`,
          [organization, event, resolved === null ? null : JSON.stringify(resolved)],
        )
      ).rows[0]?.id as string,
    )
  }
  // JSON null and SQL NULL are different; legacy absence is SQL NULL.
  await pool.query('UPDATE event_types SET location=NULL WHERE id=$1', [events.at(-1)])
  await pool.query('UPDATE bookings SET location=NULL WHERE id=$1', [bookings.at(-1)])
  return { organization, events, bookings }
}

function insert(pool: pg.Pool | pg.PoolClient, organization: string, options: unknown) {
  return pool.query(
    `INSERT INTO event_types (organization_id,slug,title,duration_minutes,locations)
      VALUES ($1,$2,'Location options',30,$3::jsonb) RETURNING location,locations`,
    [organization, randomUUID(), options === null ? null : JSON.stringify(options)],
  )
}

const invalidLists: [string, unknown][] = [
  ['array shape', {}],
  ['empty list', []],
  [
    'maximum list',
    ['google_meet', 'zoom', 'phone', 'in_person', 'link', 'link'].map((kind, index) => ({
      id: `option-${index}`,
      kind,
    })),
  ],
  ['option object', [null]],
  ['id string', [{ id: 1, kind: 'phone' }]],
  ['id present', [{ kind: 'phone' }]],
  ['id nonempty', [{ id: '', kind: 'phone' }]],
  ['kind string', [{ id: 'phone', kind: 1 }]],
  ['kind present', [{ id: 'phone' }]],
  ['kind known', [{ id: 'other', kind: 'other' }]],
  [
    'distinct ids',
    [
      { id: 'same', kind: 'phone' },
      { id: 'same', kind: 'link' },
    ],
  ],
  [
    'distinct kinds',
    [
      { id: 'one', kind: 'phone' },
      { id: 'two', kind: 'phone' },
    ],
  ],
  ['default true', [{ id: 'one', kind: 'phone', isDefault: false }]],
  [
    'single default',
    [
      { id: 'one', kind: 'phone', isDefault: true },
      { id: 'two', kind: 'link', isDefault: true },
    ],
  ],
]

const options = [
  { id: 'phone', kind: 'phone', number: '+14155550123', label: 'Call us' },
  { id: 'office', kind: 'in_person', address: 'Example Street', isDefault: true, label: 'Office' },
]

function insertCustomBooking(pool: pg.Pool | pg.PoolClient, organization: string, event: string) {
  return pool.query(
    `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,location,created_at,updated_at)
      VALUES ($1,$2,'2031-01-01T09:00Z','2031-01-01T09:30Z','Historical custom location','web',
        '{"kind":"custom","text":"private-only-conference-link"}',
        '2025-01-02T03:04:05.123456Z','2025-02-03T04:05:06.654321Z') RETURNING location,location_option`,
    [organization, event],
  )
}

const customLocation = { kind: 'custom', text: 'private-only-conference-link' }

describe.skipIf(!serverUrl)('event type location migration', () => {
  it('upgrades populated 0053 data, preserving historical fields and matching a fresh install and no-op rerun', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-locations-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      await copyPredecessor(directory, '0012_zz.sql')
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'locations_old' })
      await seedEarly(upgraded.pool)
      expect((await copyPredecessor(directory)).at(-1)).toBe(predecessor)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      const { organization, events, bookings } = await seedLocations(upgraded.pool)
      // Historical resolved booking payloads were never constrained to the
      // service's supported event-location kinds.
      await upgraded.pool.query(
        `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,location,created_at,updated_at)
          VALUES ($1,$2,'2031-01-01T09:00Z','2031-01-01T09:30Z','Historical custom location','web',$3::jsonb,
            '2025-01-02T03:04:05.123456Z','2025-02-03T04:05:06.654321Z')`,
        [organization, events[0], JSON.stringify(customLocation)],
      )
      const tables = await inventory(upgraded.pool)
      const before = await records(upgraded.pool, tables)
      expect(before['public.bookings']?.length).toBeGreaterThan(7)
      expect(before['public.booking_conferences']?.length).toBeGreaterThan(0)
      const oldEvents = (
        await upgraded.pool.query<{ id: string; location: Record<string, unknown> | null }>(
          'SELECT id,location FROM event_types ORDER BY id',
        )
      ).rows
      const oldBookings = (
        await upgraded.pool.query<{ id: string; location: Record<string, unknown> | null }>(
          'SELECT id,location FROM bookings ORDER BY id',
        )
      ).rows
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, tables)).toEqual(before)
      expect(
        (await upgraded.pool.query('SELECT id,locations FROM event_types ORDER BY id')).rows,
      ).toEqual(
        oldEvents.map(({ id, location }) => ({
          id,
          locations: location ? [{ id: 'legacy', ...location }] : null,
        })),
      )
      expect(
        (await upgraded.pool.query('SELECT id,location_option FROM bookings ORDER BY id')).rows,
      ).toEqual(
        oldBookings.map(({ id, location }) => ({
          id,
          location_option: location ? { id: 'legacy', ...location } : null,
        })),
      )
      expect(
        (
          await upgraded.pool.query('SELECT locations FROM event_types WHERE id=$1', [
            events.at(-1),
          ])
        ).rows,
      ).toEqual([{ locations: null }])
      expect(
        (
          await upgraded.pool.query('SELECT location_option FROM bookings WHERE id=$1', [
            bookings.at(-1),
          ])
        ).rows,
      ).toEqual([{ location_option: null }])
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'locations_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await upgraded.pool.query(ledger)).rows
      const latest = await inventory(upgraded.pool)
      const acknowledged = await records(upgraded.pool, latest, true)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool, latest, true)).toEqual(acknowledged)
      expect((await upgraded.pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
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

  it('validates structure and supports old writes, explicit defaults and immutable booking choices', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'locations_rules',
    })
    try {
      const { organization, events, bookings } = await seedLocations(owned.pool)
      for (const [name, list] of invalidLists)
        await expect(insert(owned.pool, organization, list), name).rejects.toMatchObject({
          code: '23514',
        })
      await expect(insert(owned.pool, organization, null)).resolves.toMatchObject({
        rows: [{ location: null, locations: null }],
      })
      await expect(insert(owned.pool, organization, options)).resolves.toMatchObject({
        rows: [{ location: { kind: 'in_person', address: 'Example Street' }, locations: options }],
      })
      await expect(
        insert(
          owned.pool,
          organization,
          options.map(({ isDefault: _, ...option }) => option),
        ),
      ).resolves.toMatchObject({
        rows: [{ location: { kind: 'phone', number: '+14155550123' } }],
      })
      const maximum = ['google_meet', 'zoom', 'phone', 'in_person', 'link'].map((kind) => ({
        id: kind,
        kind,
      }))
      await expect(insert(owned.pool, organization, maximum)).resolves.toMatchObject({
        rowCount: 1,
      })
      const event = events[0]
      await expect(
        insertCustomBooking(owned.pool, organization, event as string),
      ).resolves.toMatchObject({
        rows: [{ location: customLocation, location_option: { id: 'legacy', ...customLocation } }],
      })
      await owned.pool.query('UPDATE event_types SET locations=$2::jsonb WHERE id=$1', [
        event,
        JSON.stringify(options),
      ])
      await expect(
        owned.pool.query(
          "UPDATE event_types SET title='Renamed',location=location WHERE id=$1 RETURNING locations",
          [event],
        ),
      ).resolves.toMatchObject({ rows: [{ locations: options }] })
      await expect(
        owned.pool.query(
          `UPDATE event_types SET location='{"kind":"link","url":"https://example.test/new"}' WHERE id=$1 RETURNING locations`,
          [event],
        ),
      ).resolves.toMatchObject({
        rows: [{ locations: [{ id: 'legacy', kind: 'link', url: 'https://example.test/new' }] }],
      })
      await expect(
        owned.pool.query('UPDATE event_types SET location=NULL WHERE id=$1 RETURNING locations', [
          event,
        ]),
      ).resolves.toMatchObject({ rows: [{ locations: null }] })
      await expect(
        owned.pool.query(
          `UPDATE event_types SET location='{"kind":"phone"}',locations=$2::jsonb WHERE id=$1 RETURNING location`,
          [event, JSON.stringify(options)],
        ),
      ).resolves.toMatchObject({
        rows: [{ location: { kind: 'in_person', address: 'Example Street' } }],
      })
      await expect(
        owned.pool.query('UPDATE event_types SET locations=NULL WHERE id=$1 RETURNING location', [
          event,
        ]),
      ).resolves.toMatchObject({ rows: [{ location: null }] })
      const snapshot = {
        id: 'legacy',
        ...legacyLocations[0],
        url: 'https://example.test/resolved-0',
      }
      await expect(
        owned.pool.query(
          `UPDATE bookings SET location='{"kind":"google_meet","url":"https://example.test/later"}' WHERE id=$1 RETURNING location_option`,
          [bookings[0]],
        ),
      ).resolves.toMatchObject({ rows: [{ location_option: snapshot }] })
      await expect(
        owned.pool.query(
          `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,location,location_option)
        VALUES ($1,$2,'2031-01-01T09:00Z','2031-01-01T09:30Z','Chosen booking','web','{"kind":"phone","phone":"123"}','{"id":"chosen","kind":"phone"}') RETURNING location_option`,
          [organization, event],
        ),
      ).resolves.toMatchObject({ rows: [{ location_option: { id: 'chosen', kind: 'phone' } }] })
      await expect(
        owned.pool.query(`UPDATE bookings SET location_option='{"kind":"phone"}' WHERE id=$1`, [
          bookings[0],
        ]),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        owned.pool.query(
          `UPDATE bookings SET location_option='{"id":"replacement","kind":"phone"}' WHERE id=$1`,
          [bookings[0]],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 30_000)

  it('detects source-copy mutations of every structural rule, backfill and compatibility protection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-locations-mutant-'))
    let owned: TestDatabase | undefined
    let client: pg.PoolClient | undefined
    try {
      await copyPredecessor(directory)
      owned = await createTestDatabase(serverUrl as string, directory, { tag: 'locations_mutant' })
      const fixture = await seedLocations(owned.pool)
      client = await owned.pool.connect()
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const idType = "    AND jsonb_typeof(option->'id') = 'string'\n"
      const idLength = "    AND length(option->>'id') > 0\n"
      const kindType = "    AND jsonb_typeof(option->'kind') = 'string'\n"
      const kindKnown =
        "    AND (NOT known_kind OR option->>'kind' IN ('google_meet', 'zoom', 'phone', 'in_person', 'link'))\n"
      const replacements: Record<string, [string, string][]> = {
        'array shape': [
          [
            "IF jsonb_typeof(options) IS DISTINCT FROM 'array' THEN RETURN false; END IF;",
            "IF jsonb_typeof(options) IS DISTINCT FROM 'array' THEN RETURN true; END IF;",
          ],
        ],
        'empty list': [
          ['jsonb_array_length(options) NOT BETWEEN 1 AND 5', 'jsonb_array_length(options) > 5'],
        ],
        'maximum list': [
          ['jsonb_array_length(options) NOT BETWEEN 1 AND 5', 'jsonb_array_length(options) < 1'],
          ["count(DISTINCT value->>'kind') = count(*)", 'true'],
        ],
        'option object': [
          [
            "RETURN jsonb_typeof(option) = 'object'",
            "RETURN jsonb_typeof(option) <> 'object' OR jsonb_typeof(option) = 'object'",
          ],
        ],
        'id string': [[idType, '']],
        'id present': [
          [idType, ''],
          [idLength, ''],
        ],
        'id nonempty': [[idLength, "    AND length(option->>'id') >= 0\n"]],
        'kind string': [
          [kindType, ''],
          [kindKnown, ''],
        ],
        'kind present': [
          [kindType, ''],
          [kindKnown, ''],
        ],
        'kind known': [[kindKnown, '']],
        'distinct ids': [["count(DISTINCT value->>'id') = count(*)", 'true']],
        'distinct kinds': [["count(DISTINCT value->>'kind') = count(*)", 'true']],
        'default true': [
          ["AND (NOT option ? 'isDefault' OR option->'isDefault' = 'true'::jsonb)", ''],
        ],
        'single default': [
          ["count(*) FILTER (WHERE value->'isDefault' = 'true'::jsonb) <= 1", 'true'],
        ],
        'event backfill': [
          [
            "SET locations = jsonb_build_array(jsonb_build_object('id', 'legacy') || location)",
            "SET locations = jsonb_build_array(jsonb_build_object('id', 'changed') || location)",
          ],
        ],
        'booking backfill': [
          [
            "SET location_option = jsonb_build_object('id', 'legacy') || location",
            "SET location_option = jsonb_build_object('id', 'changed') || location",
          ],
        ],
        'event null backfill': [
          [
            "SET locations = jsonb_build_array(jsonb_build_object('id', 'legacy') || location)\n  WHERE location IS NOT NULL;",
            "SET locations = jsonb_build_array(jsonb_build_object('id', 'legacy') || coalesce(location, '{\"kind\":\"phone\"}'::jsonb));",
          ],
        ],
        'booking null backfill': [
          [
            "SET location_option = jsonb_build_object('id', 'legacy') || location\n  WHERE location IS NOT NULL;",
            "SET location_option = jsonb_build_object('id', 'legacy') || coalesce(location, '{\"kind\":\"phone\"}'::jsonb);",
          ],
        ],
        'event timestamp preservation': [
          ['ALTER TABLE event_types DISABLE TRIGGER event_types_updated_at;', ''],
        ],
        'booking timestamp preservation': [
          ['ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;', ''],
        ],
        'event timestamp trigger restored': [
          ['ALTER TABLE event_types ENABLE TRIGGER event_types_updated_at;', ''],
        ],
        'booking timestamp trigger restored': [
          ['ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;', ''],
        ],
        'legacy event insert': [["TG_OP = 'INSERT' AND NEW.locations IS NULL", 'false']],
        'legacy event update': [['AND NEW.location IS DISTINCT FROM OLD.location', 'AND false']],
        'explicit event insert': [
          ["TG_OP = 'INSERT' AND NEW.locations IS NULL", "TG_OP = 'INSERT'"],
        ],
        'explicit event update': [['AND NEW.locations IS NOT DISTINCT FROM OLD.locations', '']],
        'multi list preservation': [['AND NEW.location IS DISTINCT FROM OLD.location', '']],
        'default projection': [
          [
            "ORDER BY (value->'isDefault' = 'true'::jsonb) DESC NULLS LAST, ordinality",
            'ORDER BY ordinality',
          ],
        ],
        'metadata projection': [
          ["value - 'id' - 'label' - 'isDefault' INTO NEW.location", 'value INTO NEW.location'],
        ],
        'legacy booking insert': [
          [
            'ELSIF NEW.location_option IS NULL AND NEW.location IS NOT NULL THEN',
            'ELSIF false THEN',
          ],
        ],
        'explicit booking insert': [
          [
            'ELSIF NEW.location_option IS NULL AND NEW.location IS NOT NULL THEN',
            'ELSIF NEW.location IS NOT NULL THEN',
          ],
        ],
        'snapshot immutability': [
          ['IF NEW.location_option IS DISTINCT FROM OLD.location_option THEN', 'IF false THEN'],
        ],
        'resolved location preservation': [
          [
            'BEFORE INSERT OR UPDATE OF location_option ON bookings',
            'BEFORE INSERT OR UPDATE OF location, location_option ON bookings',
          ],
          [
            "IF TG_OP = 'UPDATE' THEN",
            "IF TG_OP = 'UPDATE' THEN\n    NEW.location_option := jsonb_build_object('id', 'legacy') || NEW.location;",
          ],
        ],
        'event constraint': [
          ['CHECK (locations IS NULL OR valid_event_type_locations(locations));', 'CHECK (true);'],
        ],
        'booking constraint': [
          [
            'CHECK (location_option IS NULL OR valid_location_option(location_option, false) IS TRUE);',
            'CHECK (true);',
          ],
        ],
        'legacy custom booking preservation': [
          [
            'valid_location_option(location_option, false) IS TRUE',
            'valid_location_option(location_option, true) IS TRUE',
          ],
        ],
      }
      const query = (text: string, values?: unknown[]) =>
        (client as pg.PoolClient).query(text, values)
      const event = fixture.events[0]
      const booking = fixture.bookings[0]
      const verify = async (name: string) => {
        const invalid = invalidLists.find(([candidate]) => candidate === name)
        if (invalid) {
          const individual = [
            'option object',
            'id string',
            'id present',
            'id nonempty',
            'kind string',
            'kind present',
            'kind known',
            'default true',
          ].includes(name)
          const value = individual ? (invalid[1] as unknown[])[0] : invalid[1]
          const fn = individual ? 'valid_location_option' : 'valid_event_type_locations'
          expect(
            (await query(`SELECT ${fn}($1::jsonb) IS TRUE AS valid`, [JSON.stringify(value)])).rows,
          ).toEqual([{ valid: false }])
        } else if (name === 'event backfill' || name === 'booking backfill') {
          const table = name === 'event backfill' ? 'event_types' : 'bookings'
          const column = name === 'event backfill' ? 'locations' : 'location_option'
          const expected =
            name === 'event backfill'
              ? [{ id: 'legacy', ...legacyLocations[0] }]
              : { id: 'legacy', ...legacyLocations[0], url: 'https://example.test/resolved-0' }
          expect(
            (
              await query(`SELECT ${column} AS value FROM ${table} WHERE id=$1`, [
                table === 'event_types' ? event : booking,
              ])
            ).rows,
          ).toEqual([{ value: expected }])
        } else if (name.endsWith('null backfill')) {
          const isEvent = name.startsWith('event')
          expect(
            (
              await query(
                `SELECT ${isEvent ? 'locations' : 'location_option'} AS value FROM ${isEvent ? 'event_types' : 'bookings'} WHERE id=$1`,
                [isEvent ? fixture.events.at(-1) : fixture.bookings.at(-1)],
              )
            ).rows,
          ).toEqual([{ value: null }])
        } else if (name.endsWith('timestamp preservation')) {
          const isEvent = name.startsWith('event')
          expect(
            (
              await query(
                `SELECT updated_at::text FROM ${isEvent ? 'event_types' : 'bookings'} WHERE id=$1`,
                [isEvent ? event : booking],
              )
            ).rows,
          ).toEqual([{ updated_at: '2025-02-03 04:05:06.654321+00' }])
        } else if (name.endsWith('timestamp trigger restored')) {
          const isEvent = name.startsWith('event')
          expect(
            (
              await query(
                `UPDATE ${isEvent ? 'event_types' : 'bookings'} SET title='Updated' WHERE id=$1 RETURNING updated_at > '2025-02-03T04:05:06.654321Z' AS updated`,
                [isEvent ? event : booking],
              )
            ).rows,
          ).toEqual([{ updated: true }])
        } else if (name === 'legacy event insert') {
          expect(
            (
              await query(
                `INSERT INTO event_types (organization_id,slug,title,duration_minutes,location) VALUES ($1,$2,'Legacy',30,'{"kind":"phone","number":"+14155550123"}') RETURNING locations`,
                [fixture.organization, randomUUID()],
              )
            ).rows,
          ).toEqual([{ locations: [{ id: 'legacy', kind: 'phone', number: '+14155550123' }] }])
        } else if (name === 'legacy event update') {
          expect(
            (
              await query(
                `UPDATE event_types SET location='{"kind":"phone"}' WHERE id=$1 RETURNING locations`,
                [event],
              )
            ).rows,
          ).toEqual([{ locations: [{ id: 'legacy', kind: 'phone' }] }])
        } else if (name === 'explicit event insert') {
          expect(
            (
              await query(
                `INSERT INTO event_types (organization_id,slug,title,duration_minutes,location,locations) VALUES ($1,$2,'Explicit',30,'{"kind":"phone"}',$3::jsonb) RETURNING locations`,
                [fixture.organization, randomUUID(), JSON.stringify(options)],
              )
            ).rows,
          ).toEqual([{ locations: options }])
        } else if (name === 'explicit event update') {
          expect(
            (
              await query(
                `UPDATE event_types SET location='{"kind":"phone"}',locations=$2::jsonb WHERE id=$1 RETURNING locations`,
                [event, JSON.stringify(options)],
              )
            ).rows,
          ).toEqual([{ locations: options }])
        } else if (name === 'multi list preservation') {
          await query('UPDATE event_types SET locations=$2::jsonb WHERE id=$1', [
            event,
            JSON.stringify(options),
          ])
          expect(
            (
              await query(
                'UPDATE event_types SET location=location WHERE id=$1 RETURNING locations',
                [event],
              )
            ).rows,
          ).toEqual([{ locations: options }])
        } else if (name === 'default projection' || name === 'metadata projection') {
          expect(
            (await insert(client as pg.PoolClient, fixture.organization, options)).rows,
          ).toEqual([
            { location: { kind: 'in_person', address: 'Example Street' }, locations: options },
          ])
        } else if (
          name === 'legacy booking insert' ||
          name === 'explicit booking insert' ||
          name === 'booking constraint'
        ) {
          const explicit =
            name === 'explicit booking insert'
              ? { id: 'chosen', kind: 'phone' }
              : name === 'booking constraint'
                ? { kind: 'phone' }
                : null
          const operation = query(
            `INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,source,location,location_option) VALUES ($1,$2,'2031-01-01T09:00Z','2031-01-01T09:30Z','Snapshot','web','{"kind":"phone","number":"+14155550123"}',$3::jsonb) RETURNING location_option`,
            [fixture.organization, event, explicit === null ? null : JSON.stringify(explicit)],
          )
          if (name === 'booking constraint')
            await expect(operation).rejects.toMatchObject({ code: '23514' })
          else
            expect((await operation).rows).toEqual([
              {
                location_option: explicit ?? {
                  id: 'legacy',
                  kind: 'phone',
                  number: '+14155550123',
                },
              },
            ])
        } else if (name === 'legacy custom booking preservation') {
          await expect(
            insertCustomBooking(client as pg.PoolClient, fixture.organization, event as string),
          ).resolves.toMatchObject({
            rows: [
              { location: customLocation, location_option: { id: 'legacy', ...customLocation } },
            ],
          })
        } else if (name === 'snapshot immutability') {
          await expect(
            query(
              `UPDATE bookings SET location_option='{"id":"changed","kind":"phone"}' WHERE id=$1`,
              [booking],
            ),
          ).rejects.toMatchObject({ code: '23514' })
        } else if (name === 'resolved location preservation') {
          await expect(
            query(
              `UPDATE bookings SET location='{"kind":"google_meet","url":"https://example.test/later"}' WHERE id=$1 RETURNING location_option`,
              [booking],
            ),
          ).resolves.toMatchObject({
            rows: [
              {
                location_option: {
                  id: 'legacy',
                  ...legacyLocations[0],
                  url: 'https://example.test/resolved-0',
                },
              },
            ],
          })
        } else if (name === 'event constraint') {
          await expect(
            insert(client as pg.PoolClient, fixture.organization, []),
          ).rejects.toMatchObject({ code: '23514' })
        } else throw new Error(`Missing mutation assertion: ${name}`)
      }
      const check = async (sql: string, name: string) => {
        const copy = join(directory, migration)
        await writeFile(copy, sql)
        await query('BEGIN')
        try {
          // Execute the copied SQL in a rollback-only transaction: every trial
          // starts with the identical populated predecessor and one connection.
          await query(await readFile(copy, 'utf8'))
          await verify(name)
        } finally {
          await query('ROLLBACK')
        }
      }
      for (const [name, edits] of Object.entries(replacements)) {
        let mutant = source
        for (const [before, after] of edits) {
          expect(mutant, name).toContain(before)
          mutant = mutant.replace(before, after)
        }
        await check(source, name)
        await expect(check(mutant, name), name).rejects.toMatchObject({ name: 'AssertionError' })
        await check(source, name)
      }
      expect(Object.keys(replacements)).toHaveLength(36)
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      client?.release()
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
