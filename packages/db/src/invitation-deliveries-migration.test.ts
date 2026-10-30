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
const errors = [
  'transport_error',
  'smtp_auth',
  'smtp_temporary',
  'smtp_permanent',
  'smtp_not_configured',
  'mail_rate_limited',
  'interrupted',
  'attempts_exhausted',
  'invitation_ineligible',
  'legacy_delivery_unknown',
]

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

// Keep every value and timestamp inside PostgreSQL, including microseconds and
// physical tuples, so a silent rewrite cannot pass a millisecond Date comparison.
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

async function migrationFiles() {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
  const candidates = files.filter((file) => file.endsWith('_invitation_deliveries.sql'))
  expect(candidates).toHaveLength(1)
  return { files, migration: candidates[0] as string }
}

async function invitationFixture(pool: pg.Pool) {
  const organizationId = randomUUID()
  const inviterId = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
      VALUES ($1,'Delivery test team',$2,now());`,
    [organizationId, `delivery-${organizationId}`],
  )
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified")
      VALUES ($1,'Delivery inviter',$2,true)`,
    [inviterId, `inviter-${inviterId}@example.test`],
  )
  return async () => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO auth.invitation
        (id,"organizationId",email,role,status,"expiresAt","inviterId")
        VALUES ($1,$2,$3,'member','pending',now()+interval '3 days',$4)`,
      [id, organizationId, `invitee-${id}@example.test`, inviterId],
    )
    return id
  }
}

type Delivery = Record<string, string | number | null>
const insert = (pool: pg.Pool, invitationId: string, changes: Delivery = {}) => {
  const values: Delivery = { invitation_id: invitationId, state: 'queued', ...changes }
  return pool.query(
    `INSERT INTO invitation_deliveries (${Object.keys(values).map(quote).join(',')})
      VALUES (${Object.keys(values)
        .map((_, i) => `$${i + 1}`)
        .join(',')}) RETURNING *`,
    Object.values(values),
  )
}

describe.skipIf(!serverUrl)('invitation delivery migration', () => {
  it('preserves populated predecessor data, backfills only live pending invitations, matches fresh schema and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-invitation-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const { files, migration } = await migrationFiles()
      const initial = files.filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invitation_old',
      })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`INSERT INTO auth.invitation
        ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        SELECT "organizationId",'migration-'||fixture.name||'@example.test',fixture.role,
          fixture.status,fixture.expires,'2026-01-02T03:04:05.123456Z',"inviterId"
        FROM auth.invitation CROSS JOIN (VALUES
          ('pending','admin','pending',now()+interval '1 day'),
          ('accepted','member','accepted',now()+interval '1 day'),
          ('canceled',NULL,'canceled',now()+interval '1 day'),
          ('rejected','member','rejected',now()+interval '1 day'),
          ('expired','member','pending',now()-interval '1 second'),
          ('accepted-expired','admin','accepted',now()-interval '1 day')
        ) AS fixture(name,role,status,expires);
        INSERT INTO notification_email_sends (recipient_hash,sent_at) VALUES
          (sha256(convert_to('synthetic-mail-recipient','UTF8')),'2026-02-03T04:05:06.654321Z'),
          (NULL,'2026-01-02T03:04:05.123456Z');`)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['auth.invitation']).toHaveLength(7)
      expect(before['auth.verification']?.length).toBeGreaterThan(0)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      expect(before['public.notification_email_sends']).toHaveLength(2)
      expect(before['public.bookings']).toHaveLength(8)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: initial.at(-1) })
      const eligible = (
        await pool.query(`SELECT id AS invitation_id FROM auth.invitation
          WHERE status='pending' AND "expiresAt">now() ORDER BY id`)
      ).rows
      expect(eligible).toHaveLength(2)

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (
          await pool.query(
            `SELECT invitation_id,generation,state,attempts,lease_id,lease_until,
            last_job_id,resend_request_id,smtp_accepted_at,last_error_code,
            due_at=created_at AND created_at=updated_at AS same_migration_time,
            due_at >= (SELECT applied_at FROM schema_migrations WHERE name=$1)
              AS migration_time FROM invitation_deliveries ORDER BY invitation_id`,
            [migration],
          )
        ).rows,
      ).toEqual(
        eligible.map((row) => ({
          ...row,
          generation: 1,
          state: 'failed',
          attempts: 0,
          lease_id: null,
          lease_until: null,
          last_job_id: null,
          resend_request_id: null,
          smtp_accepted_at: null,
          last_error_code: 'legacy_delivery_unknown',
          same_migration_time: true,
          migration_time: true,
        })),
      )
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor, { tag: 'invitation_new' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect((await fresh.pool.query('SELECT * FROM invitation_deliveries')).rows).toEqual([])
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

  it('enforces bounded attempts, generations, states, leases, SMTP acceptance and safe terminal errors', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'delivery_checks',
    })
    const pool = owned.pool
    try {
      const invitation = await invitationFixture(pool)
      const valid: Delivery[] = [
        {},
        { generation: 32, attempts: 4, last_job_id: randomUUID(), resend_request_id: randomUUID() },
        { state: 'sending', attempts: 1, lease_id: randomUUID(), lease_until: '2030-01-01T00:00Z' },
        { state: 'sending', attempts: 4, lease_id: randomUUID(), lease_until: '2030-01-01T00:00Z' },
        { state: 'smtp_accepted', attempts: 1, smtp_accepted_at: '2026-01-02T03:04:05.123456Z' },
        { state: 'failed', last_error_code: 'legacy_delivery_unknown' },
        { state: 'skipped', last_error_code: 'invitation_ineligible' },
        ...errors.map((last_error_code) => ({ last_error_code })),
      ]
      for (const delivery of valid)
        await expect(insert(pool, await invitation(), delivery)).resolves.toMatchObject({
          rowCount: 1,
        })
      const unused = await invitation()
      const sending: Delivery = {
        state: 'sending',
        attempts: 1,
        lease_id: randomUUID(),
        lease_until: '2030-01-01T00:00Z',
      }
      const invalid: [string, string, Delivery][] = [
        ['generation zero', 'generation', { generation: 0 }],
        ['generation above budget', 'generation', { generation: 33 }],
        ['negative attempts', 'attempts', { attempts: -1 }],
        ['fifth attempt', 'attempts', { attempts: 5 }],
        ['unknown state', 'state', { state: 'sent' }],
        ['unknown error', 'error_code', { last_error_code: 'provider response' }],
        ['empty error', 'error_code', { last_error_code: '' }],
        ['long error', 'error_code', { last_error_code: 'x'.repeat(1024) }],
        ['sending without lease', 'lease', { state: 'sending', attempts: 1 }],
        ['sending without lease id', 'lease', { ...sending, lease_id: null }],
        ['sending without lease deadline', 'lease', { ...sending, lease_until: null }],
        ['sending without consumed attempt', 'lease', { ...sending, attempts: 0 }],
        ['queued with lease', 'lease', { ...sending, state: 'queued' }],
        ['queued with lease id only', 'lease', { lease_id: randomUUID() }],
        ['queued with lease deadline only', 'lease', { lease_until: '2030-01-01T00:00Z' }],
        [
          'failed with lease',
          'lease',
          { ...sending, state: 'failed', last_error_code: 'smtp_auth' },
        ],
        [
          'skipped with lease',
          'lease',
          { ...sending, state: 'skipped', last_error_code: 'invitation_ineligible' },
        ],
        [
          'accepted with lease',
          'lease',
          { ...sending, state: 'smtp_accepted', smtp_accepted_at: '2030-01-01T00:00Z' },
        ],
        ['accepted without timestamp', 'smtp_accepted', { state: 'smtp_accepted' }],
        [
          'queued with acceptance timestamp',
          'smtp_accepted',
          { smtp_accepted_at: '2030-01-01T00:00Z' },
        ],
        [
          'sending with acceptance timestamp',
          'smtp_accepted',
          { ...sending, smtp_accepted_at: '2030-01-01T00:00Z' },
        ],
        [
          'failed with acceptance timestamp',
          'smtp_accepted',
          { state: 'failed', last_error_code: 'smtp_auth', smtp_accepted_at: '2030-01-01T00:00Z' },
        ],
        [
          'skipped with acceptance timestamp',
          'smtp_accepted',
          {
            state: 'skipped',
            last_error_code: 'invitation_ineligible',
            smtp_accepted_at: '2030-01-01T00:00Z',
          },
        ],
        ['failed without error', 'terminal_error', { state: 'failed' }],
        ['skipped without error', 'terminal_error', { state: 'skipped' }],
      ]
      for (const [name, constraint, changes] of invalid)
        await expect(insert(pool, unused, changes), name).rejects.toMatchObject({
          code: '23514',
          constraint: `invitation_deliveries_${constraint}`,
        })
      for (const column of [
        'invitation_id',
        'generation',
        'state',
        'attempts',
        'due_at',
        'created_at',
        'updated_at',
        'generation_started_at',
        'expiry_duration_ms',
      ])
        await expect(
          insert(pool, unused, { [column]: null }),
          `${column} is required`,
        ).rejects.toMatchObject({
          code: '23502',
          column,
        })
      expect(
        (await pool.query('SELECT count(*)::integer AS count FROM invitation_deliveries')).rows,
      ).toEqual([{ count: valid.length }])
      expect(pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)

  it('keeps one current record under concurrent retries, rolls back writes and cascades only with its invitation', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'delivery_atomic',
    })
    const pool = owned.pool
    try {
      const invitation = await invitationFixture(pool)
      const invitationId = await invitation()
      const requestId = randomUUID()
      const original = await records(
        pool,
        (await tables(pool)).filter((table) => table.schema === 'auth'),
      )
      const attempts = await Promise.allSettled([
        insert(pool, invitationId, { resend_request_id: requestId }),
        insert(pool, invitationId, { resend_request_id: requestId }),
      ])
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({
        reason: { code: '23505', constraint: 'invitation_deliveries_pkey' },
      })
      expect(
        (
          await pool.query(
            'SELECT invitation_id,generation,state,attempts,resend_request_id FROM invitation_deliveries',
          )
        ).rows,
      ).toEqual([
        {
          invitation_id: invitationId,
          generation: 1,
          state: 'queued',
          attempts: 0,
          resend_request_id: requestId,
        },
      ])
      await expect(insert(pool, randomUUID())).rejects.toMatchObject({
        code: '23503',
        constraint: 'invitation_deliveries_invitation_id_fkey',
      })
      const rollbackId = await invitation()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE invitation_deliveries SET generation=2,resend_request_id=$2 WHERE invitation_id=$1`,
          [invitationId, randomUUID()],
        )
        await client.query(
          `INSERT INTO invitation_deliveries (invitation_id,state) VALUES ($1,'queued')`,
          [rollbackId],
        )
        await client.query('ROLLBACK')
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect(
        (
          await pool.query(
            'SELECT invitation_id,generation,resend_request_id FROM invitation_deliveries',
          )
        ).rows,
      ).toEqual([{ invitation_id: invitationId, generation: 1, resend_request_id: requestId }])
      expect(
        await records(
          pool,
          (await tables(pool)).filter(
            (table) => table.schema === 'auth' && table.name !== 'invitation',
          ),
        ),
      ).toEqual(
        Object.fromEntries(Object.entries(original).filter(([name]) => name !== 'auth.invitation')),
      )
      expect(
        (await pool.query(`SELECT status FROM auth.invitation WHERE id=$1`, [invitationId])).rows,
      ).toEqual([{ status: 'pending' }])
      await pool.query('DELETE FROM invitation_deliveries WHERE invitation_id=$1', [invitationId])
      expect(
        (await pool.query('SELECT id FROM auth.invitation WHERE id=$1', [invitationId])).rows,
      ).toEqual([{ id: invitationId }])
      await insert(pool, invitationId)
      await expect(
        pool.query('DELETE FROM auth.invitation WHERE id=$1', [invitationId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect((await pool.query('SELECT * FROM invitation_deliveries')).rows).toEqual([])
      expect(
        (await pool.query('SELECT id FROM auth.invitation WHERE id=$1', [rollbackId])).rows,
      ).toEqual([{ id: rollbackId }])
      expect(pool.totalCount).toBeLessThanOrEqual(2)
    } finally {
      await owned.drop()
    }
  }, 60_000)

  it('indexes queued and sending records by due time and invitation id', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'delivery_index',
    })
    try {
      expect(
        (await tables(owned.pool)).find(
          (table) => table.schema === 'public' && table.name === 'invitation_deliveries',
        )?.columns,
      ).toEqual([
        'invitation_id',
        'generation',
        'state',
        'attempts',
        'due_at',
        'lease_id',
        'lease_until',
        'last_job_id',
        'resend_request_id',
        'smtp_accepted_at',
        'last_error_code',
        'created_at',
        'updated_at',
        'generation_started_at',
        'expiry_duration_ms',
      ])
      expect(
        (
          await owned.pool.query(`SELECT i.indisvalid,i.indisready,
            pg_get_indexdef(i.indexrelid,1,true) AS due_at,
            pg_get_indexdef(i.indexrelid,2,true) AS invitation_id,
            pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i
            WHERE i.indexrelid=to_regclass('public.invitation_deliveries_due_idx')`)
        ).rows,
      ).toEqual([
        {
          indisvalid: true,
          indisready: true,
          due_at: 'due_at',
          invitation_id: 'invitation_id',
          predicate: "(state = ANY (ARRAY['queued'::text, 'sending'::text]))",
        },
      ])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)

  it('rolls back the complete migration and legacy backfill when recording the migration fails', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-invitation-rollback-'))
    let owned: TestDatabase | undefined
    try {
      const { files, migration } = await migrationFiles()
      for (const file of files.filter((file) => file < migration))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      owned = await createTestDatabase(serverUrl as string, predecessor, { tag: 'delivery_revert' })
      const invitation = await invitationFixture(owned.pool)
      await invitation()
      const inventory = await tables(owned.pool)
      const before = await records(owned.pool, inventory)
      const ledgerQuery =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const ledger = (await owned.pool.query(ledgerQuery)).rows
      // Fail after the whole SQL file succeeds. A statement failure within that
      // single query would also roll back through PostgreSQL's implicit transaction
      // and could not prove that the ledger and schema share the runner transaction.
      await owned.pool.query(`CREATE FUNCTION public.reject_delivery_migration_ledger()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name='${migration}' THEN
            RAISE EXCEPTION 'synthetic migration ledger failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_delivery_migration_ledger BEFORE INSERT ON public.schema_migrations
          FOR EACH ROW EXECUTE FUNCTION public.reject_delivery_migration_ledger();`)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      await expect(runMigrations(owned.pool, predecessor)).rejects.toMatchObject({
        cause: { code: 'P0001' },
      })
      expect(await records(owned.pool, inventory)).toEqual(before)
      expect((await owned.pool.query(ledgerQuery)).rows).toEqual(ledger)
      expect(
        (
          await owned.pool.query(`SELECT to_regclass('public.invitation_deliveries') AS delivery,
        to_regclass('public.invitation_deliveries_due_idx') AS due`)
        ).rows,
      ).toEqual([{ delivery: null, due: null }])
      await owned.pool.query(`DROP TRIGGER reject_delivery_migration_ledger ON public.schema_migrations;
        DROP FUNCTION public.reject_delivery_migration_ledger();`)
      expect(await runMigrations(owned.pool, predecessor)).toEqual([migration])
      expect(
        (await owned.pool.query('SELECT state,last_error_code FROM invitation_deliveries')).rows,
      ).toEqual([{ state: 'failed', last_error_code: 'legacy_delivery_unknown' }])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
