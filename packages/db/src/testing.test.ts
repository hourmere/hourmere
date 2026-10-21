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
    query: vi.fn(async (_sql: string, _values?: string[]) => ({ rows: [] })),
    end: vi.fn(async () => {}),
    on: vi.fn(),
  }
}

describe('test database ownership', () => {
  let admin: ReturnType<typeof fakePool>
  let pool: ReturnType<typeof fakePool>
  let events: string[]

  beforeEach(() => {
    vi.stubEnv('HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS', undefined)
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
    vi.unstubAllEnvs()
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
        query_timeout: 6_000,
      }),
    )
    expect(migrationModule.runMigrations).toHaveBeenCalledWith(pool, '/migrations')
    await owned.drop()
    expect(events.at(-3)).toBe('pool.end')
    expect(events.at(-1)).toMatch(/^DROP DATABASE IF EXISTS hourmere_test_.* WITH \(FORCE\)$/)
    expect(admin.end).toHaveBeenCalledTimes(2)
  })

  it('gives teardown its own longer timeout without shortening a configured timeout', async () => {
    vi.stubEnv('HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS', '12000')
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    await owned.drop()
    expect(pg.Pool).toHaveBeenCalledTimes(2)
    expect(vi.mocked(pg.Pool).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ statement_timeout: 12_000, query_timeout: 13_000 }),
    )
    expect(vi.mocked(pg.Pool).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 30_000,
        query_timeout: 31_000,
      }),
    )
    vi.stubEnv('HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS', '60000')
    const slower = await createTestDatabase('postgres://localhost/hourmere')
    await slower.drop()
    expect(vi.mocked(pg.Pool).mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({ statement_timeout: 60_000, query_timeout: 61_000 }),
    )
  })

  it('keeps effective admin timeouts independent of fixture URL and environment overrides', async () => {
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=1 -c lock_timeout=1')
    const parameters = new URLSearchParams({
      statement_timeout: '2',
      query_timeout: '3',
      connectionTimeoutMillis: '1',
      lock_timeout: '1',
      options: '-c statement_timeout=1 -c lock_timeout=1',
      sslmode: 'disable',
    })
    const owned = await createTestDatabase(`postgres://localhost/hourmere?${parameters}`)
    await owned.drop()
    expect(new URL(owned.url).searchParams.toString()).toBe(parameters.toString())
    for (const [index, timeout] of [5_000, 30_000].entries()) {
      const config = vi.mocked(pg.Pool).mock.calls[index]?.[0]
      const client = new pg.Client(config) as pg.Client & {
        connectionParameters: {
          statement_timeout: number
          query_timeout: number
          lock_timeout: false
          connect_timeout: number
          options: string
        }
      }
      try {
        expect(client.connectionParameters).toEqual(
          expect.objectContaining({
            statement_timeout: timeout,
            query_timeout: timeout + 1_000,
            lock_timeout: false,
            connect_timeout: 5,
            options: `-c statement_timeout=${timeout} -c lock_timeout=0`,
          }),
        )
      } finally {
        await client.end()
      }
    }
  })

  it('terminates only the owned database backends before force-dropping it', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    await owned.drop()
    const name = new URL(owned.url).pathname.slice(1)
    expect(admin.query).toHaveBeenNthCalledWith(
      3,
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    )
    expect(admin.query).toHaveBeenNthCalledWith(4, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  })

  it.each([
    [
      'statement timeout',
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    ],
    [
      'database in use',
      Object.assign(new Error('database is being accessed by other users'), { code: '55006' }),
    ],
    ['driver timeout', new Error('Query read timeout')],
  ])('retries a transient %s and retains one admin pool', async (_label, error) => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    let attempts = 0
    admin.query.mockImplementation(async (sql) => {
      if (sql.startsWith('DROP') && ++attempts === 1) throw error
      return { rows: [] }
    })
    await expect(owned.drop()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(
      admin.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pg_terminate_backend')),
    ).toHaveLength(2)
    expect(pg.Pool).toHaveBeenCalledTimes(2)
    expect(admin.end).toHaveBeenCalledTimes(2)
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('retries a timeout while terminating fixture backends', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    admin.query.mockRejectedValueOnce(
      Object.assign(new Error('statement timeout'), { code: '57014' }),
    )
    await expect(owned.drop()).resolves.toBeUndefined()
    expect(
      admin.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT pg_terminate_backend')),
    ).toHaveLength(2)
    expect(admin.query.mock.calls.filter(([sql]) => sql.startsWith('DROP'))).toHaveLength(1)
    expect(admin.end).toHaveBeenCalledTimes(2)
  })

  it('bounds automatic retries and keeps ownership for later cleanup', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    let attempts = 0
    const error = Object.assign(new Error('statement timeout'), { code: '57014' })
    admin.query.mockImplementation(async (sql) => {
      if (sql.startsWith('DROP') && ++attempts <= 3) throw error
      return { rows: [] }
    })
    await expect(owned.drop()).rejects.toBe(error)
    expect(attempts).toBe(3)
    expect(admin.end).toHaveBeenCalledTimes(2)
    await cleanupTestDatabases()
    expect(attempts).toBe(4)
    expect(admin.end).toHaveBeenCalledTimes(3)
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('does not retry unrelated drop errors and closes the admin pool', async () => {
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    let attempts = 0
    const error = Object.assign(new Error('permission denied'), { code: '42501' })
    admin.query.mockImplementation(async (sql) => {
      if (sql.startsWith('DROP') && ++attempts === 1) throw error
      return { rows: [] }
    })
    await expect(owned.drop()).rejects.toBe(error)
    expect(attempts).toBe(1)
    expect(admin.end).toHaveBeenCalledTimes(2)
    await owned.drop()
    expect(attempts).toBe(2)
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it.each(['0', '-1', '1.5', 'NaN', '10000000000000000', '2147482648'])(
    'rejects invalid admin timeout %s before creating a pool',
    async (value) => {
      vi.stubEnv('HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS', value)
      await expect(createTestDatabase('postgres://localhost/hourmere')).rejects.toThrow(
        'HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS must be a positive integer',
      )
      expect(pg.Pool).not.toHaveBeenCalled()
    },
  )

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
    expect(events.at(-3)).toBe('pool.end')
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
    const lifecycleEvents = ['SIGINT', 'SIGTERM', 'beforeExit', 'disconnect']
    const counts = lifecycleEvents.map((event) => process.listenerCount(event))
    const owned = await createTestDatabase('postgres://localhost/hourmere')
    expect(lifecycleEvents.map((event) => process.listenerCount(event))).toEqual(
      counts.map((count) => count + 1),
    )
    await owned.drop()
    expect(lifecycleEvents.map((event) => process.listenerCount(event))).toEqual(counts)
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

  it('drops owned databases when its parent IPC channel disconnects', async () => {
    await createTestDatabase('postgres://localhost/hourmere')
    const listener = process.listeners('disconnect').at(-1)
    expect(listener).toBeTypeOf('function')
    listener?.()
    await vi.waitFor(() => {
      expect(admin.query).toHaveBeenLastCalledWith(expect.stringContaining('WITH (FORCE)'))
    })
    expect(pool.end).toHaveBeenCalledOnce()
  })

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

  it('repeatedly removes busy fixtures without terminating another fixture', async () => {
    const neighbor = await createTestDatabase(serverUrl as string, undefined, {
      migrate: false,
      tag: 'neighbor',
    })
    const neighborClient = await neighbor.pool.connect()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Two concurrent owners keep this file far below CI's 100-connection ceiling.
      for (let round = 0; round < 8; round += 1) {
        await Promise.all(
          Array.from({ length: 2 }, async () => {
            const owned = await createTestDatabase(serverUrl as string, undefined, {
              migrate: false,
              tag: 'stress',
            })
            const extraPool = new pg.Pool({ connectionString: owned.url, max: 1 })
            databaseModule.guardPoolErrors(extraPool)
            let ownedClient: pg.PoolClient | undefined
            let extraClient: pg.PoolClient | undefined
            try {
              ownedClient = await owned.pool.connect()
              extraClient = await extraPool.connect()
              await ownedClient.query('BEGIN')
              await extraClient.query('SELECT 1')
              await owned.drop()
              expect(await exists(new URL(owned.url).pathname.slice(1))).toBe(false)
            } finally {
              ownedClient?.release(true)
              extraClient?.release(true)
              await extraPool.end()
              await owned.drop()
            }
          }),
        )
        expect((await neighborClient.query('SELECT 1 AS alive')).rows).toEqual([{ alive: 1 }])
      }
    } finally {
      neighborClient.release(true)
      await neighbor.drop()
      errorLog.mockRestore()
    }
  }, 30_000)

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

  it('finishes forced cleanup after IPC disconnect without logging to the lost parent', async () => {
    const source = `
      import { createTestDatabase, cleanupTestDatabases } from ${JSON.stringify(new URL('./testing.ts', import.meta.url).href)};
      import { createPool } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      process.on('error', (error) => {
        if (error.code === 'ERR_IPC_CHANNEL_CLOSED' || error.code === 'EPIPE') process.exit(1);
      });
      // Like Vitest's console interception: logging to a lost parent exits the worker.
      console.error = () => process.send?.('pool error');
      const owned = await createTestDatabase(process.env.DATABASE_URL, undefined, { migrate: false, tag: 'disconnect' });
      const ownedClient = await owned.pool.connect();
      const extraPool = createPool(owned.url);
      const extraClient = await extraPool.connect();
      process.on('disconnect', () => {
        void cleanupTestDatabases().then(async () => {
          ownedClient.release(true);
          extraClient.release(true);
          await extraPool.end();
          process.exit(0);
        }, () => process.exit(2));
      });
      process.stdout.write(new URL(owned.url).pathname.slice(1) + '\\n');
      setInterval(() => {}, 1000);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DATABASE_URL: serverUrl as string },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)
    const exited = once(child, 'exit')
    const [output] = await once(child.stdout as NodeJS.ReadableStream, 'data')
    const name = String(output).trim()
    expect(name).toMatch(/^hourmere_test_disconnect_\d+_[a-f0-9]{16}$/)
    try {
      expect(await exists(name)).toBe(true)
      child.disconnect()
      expect(await exited).toEqual([0, null])
      expect(await exists(name)).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
    }
  }, 20_000)
})
