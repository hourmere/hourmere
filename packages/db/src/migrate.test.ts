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
})
