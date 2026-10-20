import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as databaseModule from './index.ts'
import * as migrationModule from './migrate.ts'
import { cleanupTestDatabases, createTestDatabase } from './testing.ts'

function fakePool() {
  return {
    query: vi.fn(async (_sql: string) => ({ rows: [] })),
    end: vi.fn(async () => {}),
    on: vi.fn(),
  }
}

describe('test database ownership', () => {
  let admin: ReturnType<typeof fakePool>
  let pool: ReturnType<typeof fakePool>
  let events: string[]

  beforeEach(() => {
    admin = fakePool()
    pool = fakePool()
    events = []
    admin.query.mockImplementation(async (sql) => {
      events.push(sql)
      return { rows: [] }
    })
    pool.end.mockImplementation(async () => {
      events.push('pool.end')
    })
    vi.spyOn(pg, 'Pool').mockImplementation(function (this: pg.Pool) {
      Object.assign(this, admin)
      return this
    })
    vi.spyOn(databaseModule, 'createPool').mockReturnValue(pool as unknown as pg.Pool)
    vi.spyOn(migrationModule, 'runMigrations').mockResolvedValue([])
  })

  afterEach(async () => {
    await cleanupTestDatabases()
    vi.restoreAllMocks()
  })

  it('uses postgres for maintenance, embeds the pid and migrates by default', async () => {
    const owned = await createTestDatabase(
      'postgres://test:password@localhost/hourmere',
      '/migrations',
    )
    expect(new URL(owned.url).pathname).toMatch(
      new RegExp(`^/hourmere_test_${process.pid}_[a-f0-9]{16}$`),
    )
    expect(pg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://test:password@localhost/postgres',
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
      }),
    )
    expect(migrationModule.runMigrations).toHaveBeenCalledWith(pool, '/migrations')
    await owned.drop()
    expect(events.at(-2)).toBe('pool.end')
    expect(events.at(-1)).toMatch(/^DROP DATABASE IF EXISTS hourmere_test_.* WITH \(FORCE\)$/)
    expect(admin.end).toHaveBeenCalledTimes(2)
  })

  it('supports tagged raw databases without changing their cleanup', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere', undefined, {
      tag: 'upgrade',
      migrate: false,
    })
    expect(new URL(owned.url).pathname).toMatch(
      new RegExp(`^/hourmere_test_upgrade_${process.pid}_[a-f0-9]{16}$`),
    )
    expect(migrationModule.runMigrations).not.toHaveBeenCalled()
    await owned.drop()
    expect(admin.query).toHaveBeenLastCalledWith(expect.stringContaining('WITH (FORCE)'))
  })

  it('removes database query overrides from both maintenance and fixture URLs', async () => {
    const owned = await createTestDatabase(
      'postgresql://localhost/hourmere?database=hourmere&dbname=hourmere&sslmode=disable',
    )
    for (const value of [owned.url, vi.mocked(pg.Pool).mock.calls[0]?.[0]?.connectionString]) {
      const parsed = new URL(value as string)
      expect(parsed.searchParams.has('database')).toBe(false)
      expect(parsed.searchParams.has('dbname')).toBe(false)
      expect(parsed.searchParams.get('sslmode')).toBe('disable')
    }
    await owned.drop()
  })

  it('rejects unsupported URL protocols before creating a pool', async () => {
    await expect(createTestDatabase('socket:///hourmere?db=hourmere')).rejects.toThrow(
      'Test database URL',
    )
    expect(pg.Pool).not.toHaveBeenCalled()
  })

  it('rejects unsafe tags before creating a pool', async () => {
    await expect(
      createTestDatabase('postgres://localhost/hourmere', undefined, { tag: 'unsafe; DROP' }),
    ).rejects.toThrow('Test database tag')
    expect(pg.Pool).not.toHaveBeenCalled()
  })

  it('drops a created database when ALTER fails before a pool is returned', async () => {
    admin.query.mockImplementation(async (sql) => {
      events.push(sql)
      if (sql.startsWith('ALTER')) throw new Error('alter failed')
      return { rows: [] }
    })
    await expect(createTestDatabase('postgres://localhost/hourmere')).rejects.toThrow(
      'alter failed',
    )
    expect(databaseModule.createPool).not.toHaveBeenCalled()
    expect(admin.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP .*WITH \(FORCE\)$/))
    expect(admin.end).toHaveBeenCalledTimes(2)
  })

  it('ends the pool and drops the database when migration fails', async () => {
    vi.mocked(migrationModule.runMigrations).mockRejectedValue(new Error('migration failed'))
    await expect(createTestDatabase('postgres://localhost/hourmere')).rejects.toThrow(
      'migration failed',
    )
    expect(events.at(-2)).toBe('pool.end')
    expect(events.at(-1)).toMatch(/^DROP .*WITH \(FORCE\)$/)
  })

  it('keeps cleanup ownership when caller setup or assertions fail', async () => {
    await createTestDatabase('postgres://localhost/hourmere')
    await cleanupTestDatabases()
    expect(pool.end).toHaveBeenCalledOnce()
    expect(admin.query).toHaveBeenLastCalledWith(expect.stringMatching(/^DROP /))
  })

  it('shares one drop between concurrent, explicit and fallback cleanup', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    await Promise.all([owned.drop(), owned.drop(), cleanupTestDatabases()])
    await owned.drop()
    expect(pool.end).toHaveBeenCalledOnce()
    expect(admin.query.mock.calls.filter(([sql]) => sql.startsWith('DROP'))).toHaveLength(1)
  })

  it('can retry a failed drop without ending the pool twice', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    admin.query.mockRejectedValueOnce(new Error('drop failed'))
    await expect(owned.drop()).rejects.toThrow('drop failed')
    await owned.drop()
    expect(pool.end).toHaveBeenCalledOnce()
    expect(admin.end).toHaveBeenCalledTimes(3)
  })

  it('forces removal even if orderly pool closure is stuck', async () => {
    let finishClose: (() => void) | undefined
    pool.end.mockReturnValue(new Promise<void>((resolve) => (finishClose = resolve)))
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    const dropping = owned.drop()
    try {
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(admin.query).toHaveBeenLastCalledWith(expect.stringContaining('WITH (FORCE)'))
    } finally {
      finishClose?.()
      await dropping
    }
  })

  it('installs interruption hooks only while databases are owned', async () => {
    const counts = ['SIGINT', 'SIGTERM', 'beforeExit'].map((event) => process.listenerCount(event))
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    expect(
      ['SIGINT', 'SIGTERM', 'beforeExit'].map((event) => process.listenerCount(event)),
    ).toEqual(counts.map((count) => count + 1))
    await owned.drop()
    expect(
      ['SIGINT', 'SIGTERM', 'beforeExit'].map((event) => process.listenerCount(event)),
    ).toEqual(counts)
  })

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'runs registered cleanup when handling %s',
    async (signal) => {
      await createTestDatabase('postgres://localhost/hourmere')
      vi.spyOn(process, 'kill').mockReturnValue(true)
      const listener = process.listeners(signal).at(-1)
      expect(listener).toBeTypeOf('function')
      listener?.(signal)
      await vi.waitFor(() => {
        expect(admin.query).toHaveBeenLastCalledWith(expect.stringContaining('WITH (FORCE)'))
      })
      expect(pool.end).toHaveBeenCalledOnce()
    },
  )

  it('waits for pending CREATE/ALTER before fallback cleanup', async () => {
    let finishCreate: (() => void) | undefined
    admin.query.mockImplementation(async (sql) => {
      events.push(sql)
      if (sql.startsWith('CREATE')) await new Promise<void>((resolve) => (finishCreate = resolve))
      return { rows: [] }
    })
    const creation = createTestDatabase('postgres://localhost/hourmere', undefined, {
      migrate: false,
    })
    const cleanup = cleanupTestDatabases()
    expect(events).toHaveLength(1)
    finishCreate?.()
    await creation
    await cleanup
    expect(events.findIndex((sql) => sql.startsWith('DROP'))).toBeGreaterThan(
      events.findIndex((sql) => sql.startsWith('ALTER')),
    )
  })
})

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('real test database cleanup', () => {
  let admin: pg.Pool
  const directories: string[] = []
  const children: ChildProcess[] = []

  beforeAll(() => {
    const maintenance = new URL(serverUrl as string)
    maintenance.pathname = '/postgres'
    admin = new pg.Pool({ connectionString: maintenance.toString(), max: 1 })
  })

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    await cleanupTestDatabases()
    await admin.end()
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
  })

  async function exists(name: string): Promise<boolean> {
    const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return result.rowCount !== 0
  }

  it('creates migrated fixtures with synchronous_commit disabled', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    try {
      expect((await owned.pool.query('SHOW synchronous_commit')).rows).toEqual([
        { synchronous_commit: 'off' },
      ])
      expect(
        (await owned.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations'))
          .rows[0]?.n,
      ).toBeGreaterThan(0)
    } finally {
      await owned.drop()
    }
  })

  it('starts migration fixtures empty and force-drops an unreleased client', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      migrate: false,
      tag: 'raw',
    })
    const client = await owned.pool.connect()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        (await client.query("SELECT to_regclass('schema_migrations') AS table_name")).rows,
      ).toEqual([{ table_name: null }])
      await owned.drop()
      expect(await exists(new URL(owned.url).pathname.slice(1))).toBe(false)
    } finally {
      client.release(true)
      errorLog.mockRestore()
      await owned.drop()
    }
  })

  it('removes the database when a real migration fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-failing-migration-'))
    directories.push(directory)
    await writeFile(join(directory, '0001_broken.sql'), 'CREATE TABLE broken (')
    const before = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`hourmere_test_broken_${process.pid}_%`],
    )
    await expect(
      createTestDatabase(serverUrl as string, directory, { tag: 'broken' }),
    ).rejects.toThrow('migration 0001_broken.sql failed')
    expect(
      (
        await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
          `hourmere_test_broken_${process.pid}_%`,
        ])
      ).rows,
    ).toEqual(before.rows)
  })

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cleans a standalone interrupted process on %s with a checked-out client',
    async (signal) => {
      const source = `
        import { createTestDatabase } from ${JSON.stringify(new URL('./testing.ts', import.meta.url).href)};
        const owned = await createTestDatabase(process.env.DATABASE_URL, undefined, { migrate: false, tag: 'signal' });
        await owned.pool.connect();
        process.stdout.write(new URL(owned.url).pathname.slice(1) + '\\n');
        setInterval(() => {}, 1000);
      `
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, DATABASE_URL: serverUrl as string },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      const exited = once(child, 'exit')
      const [output] = await once(child.stdout as NodeJS.ReadableStream, 'data')
      const name = String(output).trim()
      expect(name).toMatch(/^hourmere_test_signal_\d+_[a-f0-9]{16}$/)
      expect(await exists(name)).toBe(true)
      child.kill(signal)
      expect(await exited).toEqual([null, signal])
      expect(await exists(name)).toBe(false)
    },
    20_000,
  )
})
