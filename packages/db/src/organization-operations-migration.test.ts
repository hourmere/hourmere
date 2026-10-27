import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
interface Table {
  schema: string
  name: string
  columns: string[]
}
async function tables(pool: pg.Pool): Promise<Table[]> {
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

// Read timestamps and every predecessor column inside PostgreSQL so JavaScript's
// millisecond Date precision cannot hide changes. Physical tuples must also survive.
async function records(pool: pg.Pool, inventory: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of inventory)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}

interface Operation {
  operation: string | null
  source: string | null
  actor_user_id?: string | null
  booking_id?: string | null
  target_user_id?: string | null
  previous_role?: string | null
  new_role?: string | null
  api_key_id?: string | null
  oauth_consent_id?: string | null
}
const insert = (pool: pg.Pool, organizationId: string, operation: Operation) =>
  pool.query<{ id: string; occurred_at: Date }>(
    `INSERT INTO organization_operations (organization_id,operation,source,actor_user_id,
      booking_id,target_user_id,previous_role,new_role,api_key_id,oauth_consent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,occurred_at`,
    [
      organizationId,
      operation.operation,
      operation.source,
      operation.actor_user_id ?? null,
      operation.booking_id ?? null,
      operation.target_user_id ?? null,
      operation.previous_role ?? null,
      operation.new_role ?? null,
      operation.api_key_id ?? null,
      operation.oauth_consent_id ?? null,
    ],
  )

describe.skipIf(!serverUrl)('organization operation migration', () => {
  it('preserves all populated predecessor columns and timestamps, matches a fresh install and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-operations-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      const candidates = files.filter((file) => file.endsWith('_organization_operations.sql'))
      expect(candidates).toHaveLength(1)
      const migration = candidates[0] as string
      const initial = files.filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'operations_old',
      })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`UPDATE bookings SET cancelled_source='mcp',cancelled_api_key_id=NULL,
        cancelled_oauth_consent_id=(SELECT id FROM mcp_oauth_grants LIMIT 1)
        WHERE title='Upgrade booking 4'`)
      expect(
        (
          await pool.query(`SELECT count(*)::integer AS count FROM bookings
            WHERE start_at::text LIKE '%.123456+00' AND end_at::text LIKE '%.654321+00'
              AND created_at::text LIKE '%.123456+00'`)
        ).rows[0]?.count,
      ).toBeGreaterThan(0)
      expect(
        (
          await pool.query(`SELECT count(*)::integer AS count FROM bookings
            WHERE cancelled_oauth_consent_id IS NOT NULL AND cancelled_source='mcp'`)
        ).rows,
      ).toEqual([{ count: 1 }])
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.booking_attendees']).toHaveLength(15)
      expect(before['public.booking_notifications']?.length).toBeGreaterThan(0)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: initial.at(-1) })

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect((await pool.query('SELECT * FROM organization_operations')).rows).toEqual([])
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor, { tag: 'operations_new' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
      const latest = await tables(pool)
      const acknowledged = await records(pool, latest)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, latest)).toEqual(acknowledged)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('bounds event shapes and credential origins, retains deleted identities and cascades with its business records', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'operations' })
    const pool = owned.pool
    try {
      const organizationId = randomUUID()
      const actorId = randomUUID()
      const targetId = randomUUID()
      const apiKeyId = randomUUID()
      const consentId = randomUUID()
      await pool.query(
        `INSERT INTO auth.organization (id,name,slug,"createdAt")
          VALUES ($1,'Operation test team','operation-test-team',now())`,
        [organizationId],
      )
      for (const [id, name] of [
        [actorId, 'Actor'],
        [targetId, 'Target'],
      ] as const)
        await pool.query(
          `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)`,
          [id, name, `${name.toLowerCase()}@example.test`],
        )
      await pool.query(
        `INSERT INTO auth.apikey (id,"configId",name,"referenceId",key,"createdAt","updatedAt")
          VALUES ($1,'default','Synthetic operation key',$2,'synthetic-operation-key',now(),now())`,
        [apiKeyId, actorId],
      )
      await pool.query(
        `INSERT INTO mcp_oauth_grants (id,user_id,organization_id,client_id)
          VALUES ($1,$2,$3,'synthetic-operation-client')`,
        [consentId, actorId, organizationId],
      )
      const bookingIds: string[] = []
      for (let day = 1; day <= 6; day++) {
        const bookingId = randomUUID()
        bookingIds.push(bookingId)
        await pool.query(
          `INSERT INTO bookings (id,organization_id,start_at,end_at,title,source)
            VALUES ($1,$2,'2030-01-01T10:00Z'::timestamptz+$3::integer*interval '1 day',
              '2030-01-01T10:30Z'::timestamptz+$3::integer*interval '1 day','Synthetic operation','web')`,
          [bookingId, organizationId, day],
        )
      }
      const cancellation: Operation = {
        operation: 'booking_cancelled',
        source: 'web',
        actor_user_id: actorId,
        booking_id: bookingIds[0],
      }
      const removal: Operation = {
        operation: 'member_removed',
        source: 'web',
        actor_user_id: actorId,
        target_user_id: targetId,
        previous_role: 'admin,member',
      }
      const roleChange: Operation = {
        ...removal,
        operation: 'member_role_changed',
        new_role: 'member',
      }
      const beforeInsert = (await pool.query<{ stamp: string }>('SELECT now()::text AS stamp'))
        .rows[0]?.stamp
      const first = (await insert(pool, organizationId, cancellation)).rows[0]
      expect(first?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(first?.occurred_at).toBeInstanceOf(Date)
      expect(
        (
          await pool.query(
            `SELECT occurred_at >= $1::timestamptz AND occurred_at <= now() AS current
              FROM organization_operations WHERE id=$2`,
            [beforeInsert, first?.id],
          )
        ).rows,
      ).toEqual([{ current: true }])
      for (const operation of [
        { ...cancellation, booking_id: bookingIds[1], actor_user_id: null, source: 'embed' },
        { ...cancellation, booking_id: bookingIds[2], source: 'api', api_key_id: apiKeyId },
        { ...cancellation, booking_id: bookingIds[3], source: 'mcp', api_key_id: apiKeyId },
        { ...cancellation, booking_id: bookingIds[4], source: 'mcp', oauth_consent_id: consentId },
        removal,
        roleChange,
        { ...roleChange, previous_role: 'a'.repeat(255), new_role: 'b'.repeat(255) },
      ])
        await expect(insert(pool, organizationId, operation)).resolves.toMatchObject({
          rowCount: 1,
        })
      await expect(insert(pool, organizationId, cancellation)).rejects.toMatchObject({
        code: '23505',
      })
      const available = { ...cancellation, booking_id: bookingIds[5] }
      const invalid: [string, Operation][] = [
        ['unknown operation', { ...available, operation: 'unknown' }],
        ['missing operation', { ...available, operation: null }],
        ['unknown source', { ...available, source: 'unknown' }],
        ['missing source', { ...available, source: null }],
        ['cancellation without booking', { ...available, booking_id: null }],
        ['cancellation with target', { ...available, target_user_id: targetId }],
        ['cancellation with previous role', { ...available, previous_role: 'member' }],
        ['cancellation with new role', { ...available, new_role: 'admin' }],
        ['removal without actor', { ...removal, actor_user_id: null }],
        ['removal without target', { ...removal, target_user_id: null }],
        ['removal without previous role', { ...removal, previous_role: null }],
        ['removal with new role', { ...removal, new_role: 'admin' }],
        ['removal with booking', { ...removal, booking_id: bookingIds[5] }],
        ['role change without actor', { ...roleChange, actor_user_id: null }],
        ['role change without target', { ...roleChange, target_user_id: null }],
        ['role change without previous role', { ...roleChange, previous_role: null }],
        ['role change without new role', { ...roleChange, new_role: null }],
        ['role change with booking', { ...roleChange, booking_id: bookingIds[5] }],
        ['empty previous role', { ...roleChange, previous_role: '' }],
        ['long previous role', { ...roleChange, previous_role: 'a'.repeat(256) }],
        ['empty new role', { ...roleChange, new_role: '' }],
        ['long new role', { ...roleChange, new_role: 'b'.repeat(256) }],
        ['web with key', { ...available, api_key_id: apiKeyId }],
        ['embed with key', { ...available, source: 'embed', api_key_id: apiKeyId }],
        ['web with OAuth', { ...available, oauth_consent_id: consentId }],
        ['api with OAuth', { ...available, source: 'api', oauth_consent_id: consentId }],
        [
          'MCP with both credentials',
          { ...available, source: 'mcp', api_key_id: apiKeyId, oauth_consent_id: consentId },
        ],
        ['removal from API', { ...removal, source: 'api', api_key_id: apiKeyId }],
        ['role change from MCP', { ...roleChange, source: 'mcp', oauth_consent_id: consentId }],
      ]
      for (const [name, operation] of invalid)
        await expect(insert(pool, organizationId, operation), name).rejects.toMatchObject({
          code: name.startsWith('missing ') ? '23502' : '23514',
        })
      await expect(
        insert(pool, organizationId, { ...available, booking_id: randomUUID() }),
      ).rejects.toMatchObject({ code: '23503' })
      await expect(insert(pool, randomUUID(), removal)).rejects.toMatchObject({ code: '23503' })
      await expect(
        pool.query(
          `INSERT INTO organization_operations (organization_id,operation,source,actor_user_id,
            target_user_id,previous_role) VALUES (NULL,'member_removed','web',$1,$2,'member')`,
          [actorId, targetId],
        ),
      ).rejects.toMatchObject({ code: '23502' })
      await expect(
        pool.query(
          `INSERT INTO organization_operations (organization_id,operation,source,actor_user_id,
            target_user_id,previous_role,occurred_at) VALUES ($1,'member_removed','web',$2,$3,'member',NULL)`,
          [organizationId, actorId, targetId],
        ),
      ).rejects.toMatchObject({ code: '23502' })
      const businessRecords = (
        await pool.query('SELECT * FROM organization_operations ORDER BY id')
      ).rows
      expect(businessRecords).toHaveLength(8)
      await pool.query('DELETE FROM auth.apikey WHERE id=$1', [apiKeyId])
      await pool.query('DELETE FROM mcp_oauth_grants WHERE id=$1', [consentId])
      await pool.query('DELETE FROM auth."user" WHERE id=ANY($1::uuid[])', [[actorId, targetId]])
      expect((await pool.query('SELECT * FROM organization_operations ORDER BY id')).rows).toEqual(
        businessRecords,
      )
      expect(
        (
          await pool.query(`SELECT i.indisvalid,i.indisready,i.indoption::text AS ordering,
            pg_get_indexdef(i.indexrelid,1,true) AS organization,
            pg_get_indexdef(i.indexrelid,2,true) AS time,
            pg_get_indexdef(i.indexrelid,3,true) AS id FROM pg_index i
            WHERE i.indexrelid=to_regclass('organization_operations_organization_time')`)
        ).rows,
      ).toEqual([
        {
          indisvalid: true,
          indisready: true,
          ordering: '0 3 3',
          organization: 'organization_id',
          time: 'occurred_at',
          id: 'id',
        },
      ])
      await expect(
        pool.query('DELETE FROM bookings WHERE id=$1', [bookingIds[0]]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect(
        (await pool.query('SELECT count(*)::integer AS count FROM organization_operations')).rows,
      ).toEqual([{ count: 7 }])
      await expect(
        pool.query('DELETE FROM auth.organization WHERE id=$1', [organizationId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect((await pool.query('SELECT * FROM organization_operations')).rows).toEqual([])
      expect(pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)
})
