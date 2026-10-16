import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { runMigrations } from './migrate.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('runMigrations', () => {
  const schema = `test_${process.pid}_${Date.now()}`
  let dir: string
  let pool: ReturnType<typeof createPool>

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hourmere-migrations-'))
    const admin = createPool(url as string)
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.end()
    pool = createPool(url as string)
    pool.on('connect', (client) => client.query(`SET search_path TO ${schema}`))
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool?.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('applies files in name order and skips them on the next run', async () => {
    await writeFile(join(dir, '0002_b.sql'), 'ALTER TABLE a ADD COLUMN note text;')
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int PRIMARY KEY);')

    expect(await runMigrations(pool, dir)).toEqual(['0001_a.sql', '0002_b.sql'])
    expect(await runMigrations(pool, dir)).toEqual([])

    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'a' ORDER BY ordinal_position`,
      [schema],
    )
    expect(cols.rows.map((r) => r.column_name)).toEqual(['id', 'note'])
  })

  it('rolls back a failing file and leaves it unrecorded', async () => {
    await writeFile(join(dir, '0003_bad.sql'), 'CREATE TABLE c (id int); SELECT no_such_fn();')

    await expect(runMigrations(pool, dir)).rejects.toThrow('migration 0003_bad.sql failed')

    const c = await pool.query(`SELECT to_regclass('${schema}.c') AS t`)
    expect(c.rows[0].t).toBeNull()
    const recorded = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
    expect(recorded.rows.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql'])
  })

  it('refuses an applied migration whose contents changed', async () => {
    await writeFile(join(dir, '0003_bad.sql'), 'SELECT 1;')
    await runMigrations(pool, dir)
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE a (id bigint PRIMARY KEY);')

    await expect(runMigrations(pool, dir)).rejects.toThrow(
      'migration 0001_a.sql was changed after it was applied',
    )
  })

  it('rejects file names that break the NNNN_name.sql rule', async () => {
    const other = await mkdtemp(join(tmpdir(), 'hourmere-migrations-'))
    await writeFile(join(other, '10_late.sql'), 'SELECT 1;')
    try {
      await expect(runMigrations(pool, other)).rejects.toThrow(
        'migration file name 10_late.sql does not match NNNN_name.sql',
      )
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('treats CRLF and LF copies of a migration as the same file', async () => {
    const crlf = await mkdtemp(join(tmpdir(), 'hourmere-migrations-'))
    const lf = await mkdtemp(join(tmpdir(), 'hourmere-migrations-'))
    const otherSchema = `${schema}_eol`
    await pool.query(`CREATE SCHEMA ${otherSchema}`)
    const eolPool = createPool(url as string)
    eolPool.on('connect', (client) => client.query(`SET search_path TO ${otherSchema}`))
    try {
      await writeFile(join(crlf, '0001_t.sql'), 'CREATE TABLE t (id int);\r\nSELECT 1;\r\n')
      await writeFile(join(lf, '0001_t.sql'), 'CREATE TABLE t (id int);\nSELECT 1;\n')
      expect(await runMigrations(eolPool, crlf)).toEqual(['0001_t.sql'])
      expect(await runMigrations(eolPool, lf)).toEqual([])
    } finally {
      await eolPool.query(`DROP SCHEMA ${otherSchema} CASCADE`)
      await eolPool.end()
      await rm(crlf, { recursive: true, force: true })
      await rm(lf, { recursive: true, force: true })
    }
  })
})
