import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const url = process.env.DATABASE_URL

function withSearchPath(connectionString: string, schema: string) {
  const u = new URL(connectionString)
  u.searchParams.set('options', `-c search_path=${schema}`)
  return u.toString()
}

describe.skipIf(!url)('runMigrations', () => {
  const schema = `test_${process.pid}_${Date.now()}`
  let dir: string
  let pool: ReturnType<typeof createPool>
  let database: TestDatabase

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hourmere-migrations-'))
    database = await createTestDatabase(url as string)
    await database.pool.query(`CREATE SCHEMA ${schema}`)
    pool = createPool(withSearchPath(database.url, schema))
  })

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool?.end()
    await database?.drop()
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
    const eolPool = createPool(withSearchPath(database.url, otherSchema))
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

  it('serializes concurrent startup from three independent pools', async () => {
    const concurrent = await mkdtemp(join(tmpdir(), 'hourmere-concurrent-migrations-'))
    const otherSchema = `${schema}_concurrent`
    await database.pool.query(`CREATE SCHEMA ${otherSchema}`)
    const firstPool = createPool(withSearchPath(database.url, otherSchema))
    const pools = [
      firstPool,
      ...Array.from({ length: 2 }, () => createPool(withSearchPath(database.url, otherSchema))),
    ]
    try {
      // Delay within the first file so every contender has entered the migration runner
      // before any can record the file. Removing the advisory lock races the same DDL.
      await writeFile(
        join(concurrent, '0001_start.sql'),
        'SELECT pg_sleep(0.1); CREATE TABLE startup (id int PRIMARY KEY); INSERT INTO startup VALUES (1);',
      )
      await writeFile(
        join(concurrent, '0002_finish.sql'),
        'ALTER TABLE startup ADD COLUMN note text;',
      )
      const runs = await Promise.allSettled(
        pools.map((candidate) => runMigrations(candidate, concurrent)),
      )
      expect(runs.map((run) => run.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
      const applied = runs.flatMap((run) => (run.status === 'fulfilled' ? [run.value] : []))
      expect(applied.filter((files) => files.length > 0)).toEqual([
        ['0001_start.sql', '0002_finish.sql'],
      ])
      expect((await firstPool.query('SELECT id FROM startup')).rows).toEqual([{ id: 1 }])
      expect(
        (await firstPool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows,
      ).toEqual([{ count: 2 }])
    } finally {
      await Promise.all(pools.map((candidate) => candidate.end()))
      await database.pool.query(`DROP SCHEMA ${otherSchema} CASCADE`)
      await rm(concurrent, { recursive: true, force: true })
    }
  })
})
