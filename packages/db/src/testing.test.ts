import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as databaseModule from './index.ts'
import * as migrationModule from './migrate.ts'
import {
  cleanupTestDatabases,
  createTestDatabase,
  createTestDatabaseTemplate,
  reuseConnectionsAfterErrors,
  type TestDatabase,
} from './testing.ts'

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
    expect(admin.end).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['the default', undefined, 30_000, 5_000],
    ['a configured shorter', '12000', 30_000, 12_000],
    ['a configured longer', '60000', 60_000, 60_000],
  ])(
    'with %s admin timeout, gives only CREATE and DROP their longer timeout',
    async (_label, configured, long, short) => {
      vi.stubEnv('HOURMERE_TEST_DATABASE_ADMIN_TIMEOUT_MS', configured)
      const statements: [string, unknown, unknown][] = []
      vi.mocked(pg.Pool).mockImplementation(function (this: pg.Pool, config?: pg.PoolConfig) {
        Object.assign(this, admin, {
          query: async (sql: string, values?: string[]) => {
            statements.push([
              sql.split(' ', 2).join(' '),
              config?.statement_timeout,
              config?.query_timeout,
            ])
            return admin.query(sql, values)
          },
        })
        return this
      })
      const owned = await createTestDatabase('postgres://localhost/hourmere', undefined, {
        template: 'hourmere_test_coverage_42_0123456789abcdef',
      })
      await owned.drop()
      expect(statements).toEqual([
        ['CREATE DATABASE', long, long + 1_000],
        ['ALTER DATABASE', short, short + 1_000],
        ['ALTER DATABASE', short, short + 1_000],
        ['SELECT pg_terminate_backend(pid)', long, long + 1_000],
        ['DROP DATABASE', long, long + 1_000],
      ])
      expect(pg.Pool).toHaveBeenCalledTimes(3)
      for (const [config] of vi.mocked(pg.Pool).mock.calls) {
        expect(config).toEqual(expect.objectContaining({ max: 1, connectionTimeoutMillis: 5_000 }))
      }
      expect(admin.end).toHaveBeenCalledTimes(3)
    },
  )

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
    for (const [index, timeout] of [30_000, 5_000, 30_000].entries()) {
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
            options: `-c statement_timeout=${timeout} -c lock_timeout=0 -c client_connection_check_interval=1000`,
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
      2,
      `ALTER DATABASE ${name} SET synchronous_commit = off`,
    )
    expect(admin.query).toHaveBeenNthCalledWith(3, `ALTER DATABASE ${name} SET jit = off`)
    expect(admin.query).toHaveBeenNthCalledWith(
      4,
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    )
    expect(admin.query).toHaveBeenNthCalledWith(5, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
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
    expect(pg.Pool).toHaveBeenCalledTimes(3)
    expect(admin.end).toHaveBeenCalledTimes(3)
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
    expect(admin.end).toHaveBeenCalledTimes(3)
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
    expect(admin.end).toHaveBeenCalledTimes(3)
    await cleanupTestDatabases()
    expect(attempts).toBe(4)
    expect(admin.end).toHaveBeenCalledTimes(4)
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
    expect(admin.end).toHaveBeenCalledTimes(3)
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

  it('copies a test template database and still migrates by default', async () => {
    const template = 'hourmere_test_coverage_42_0123456789abcdef'
    const owned = await createTestDatabase('postgres://localhost/hourmere', '/migrations', {
      template,
    })
    expect(admin.query).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^CREATE DATABASE hourmere_test_${process.pid}_[a-f0-9]{16} TEMPLATE ${template}$`,
        ),
      ),
    )
    expect(migrationModule.runMigrations).toHaveBeenCalledWith(pool, '/migrations')
    await owned.drop()
  })

  describe("the run's migrated template", () => {
    const shared = 'hourmere_test_migrated_42_0123456789abcdef'
    const created = () => events.find((sql) => sql.startsWith('CREATE DATABASE'))

    beforeEach(() => {
      vi.stubEnv('HOURMERE_TEST_MIGRATED_TEMPLATE', shared)
      vi.stubEnv('HOURMERE_TEST_MIGRATED_TEMPLATE_SERVER', 'postgres://test@localhost:5432')
    })

    it.each([
      ['the default directory', undefined],
      ['the repository directory by path', migrationModule.migrationsDir],
    ])('is copied for %s and the copy still runs the migrations', async (_label, directory) => {
      const owned = await createTestDatabase(
        'postgresql://test:password@localhost:5432/hourmere',
        directory,
      )
      expect(created()).toMatch(new RegExp(` TEMPLATE ${shared}$`))
      expect(migrationModule.runMigrations).toHaveBeenCalledWith(pool, directory)
      await owned.drop()
    })

    it.each([
      ['another server', 'postgres://test:password@otherhost/hourmere', undefined, {}],
      ['another user', 'postgres://other:password@localhost/hourmere', undefined, {}],
      ['another port', 'postgres://test:password@localhost:5433/hourmere', undefined, {}],
      [
        'an empty fixture',
        'postgres://test:password@localhost/hourmere',
        undefined,
        { migrate: false },
      ],
      ['another directory', 'postgres://test:password@localhost/hourmere', '/migrations', {}],
    ] as const)('is not used for %s', async (_label, url, directory, options) => {
      const owned = await createTestDatabase(url, directory, options)
      expect(created()).toMatch(/^CREATE DATABASE hourmere_test_\d+_[a-f0-9]{16}$/)
      await owned.drop()
    })

    it('gives way to an explicit template and ignores an unsafe name', async () => {
      const explicit = 'hourmere_test_coverage_42_0123456789abcdef'
      const owned = await createTestDatabase('postgres://test@localhost/hourmere', undefined, {
        template: explicit,
      })
      expect(created()).toMatch(new RegExp(` TEMPLATE ${explicit}$`))
      await owned.drop()
      events.length = 0
      vi.stubEnv('HOURMERE_TEST_MIGRATED_TEMPLATE', 'template1')
      const plain = await createTestDatabase('postgres://test@localhost/hourmere')
      expect(created()).toMatch(/^CREATE DATABASE hourmere_test_\d+_[a-f0-9]{16}$/)
      await plain.drop()
    })
  })

  it.each(['hourmere', 'template1', 'hourmere_test_x; DROP DATABASE hourmere'])(
    'rejects the non-test template %s before creating a pool',
    async (template) => {
      await expect(
        createTestDatabase('postgres://localhost/hourmere', undefined, { template }),
      ).rejects.toThrow('Test database templates must be test databases')
      expect(pg.Pool).not.toHaveBeenCalled()
    },
  )

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
    expect(admin.end).toHaveBeenCalledTimes(3)
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
    expect(admin.end).toHaveBeenCalledTimes(4)
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

  /** Migration ledger of a fixture, and whether its first entry predates `since`. */
  async function ledger(owned: TestDatabase, since: Date) {
    const rows = (
      await owned.pool.query<{ name: string; checksum: string; applied_at: Date }>(
        'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
      )
    ).rows
    return {
      entries: rows.map(({ name, checksum }) => [name, checksum]),
      copied: (rows[0]?.applied_at.getTime() ?? Number.POSITIVE_INFINITY) < since.getTime(),
      /** When each migration was applied: equal times mean a copy of the same template. */
      appliedAt: rows.map(({ applied_at }) => applied_at.toISOString()),
    }
  }

  const predecessorTemplates = async () =>
    (
      await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname LIKE $1',
        [`hourmere_test_predecessor_${process.pid}_%`],
      )
    ).rows.map((row) => row.datname)

  it("copies the run's migrated template for repository migrations", async () => {
    expect(process.env.HOURMERE_TEST_MIGRATED_TEMPLATE).toMatch(/^hourmere_test_migrated_\d+_/)
    const since = new Date()
    const owned = await createTestDatabase(serverUrl as string)
    try {
      const { entries, copied } = await ledger(owned, since)
      const repository = (await readdir(migrationModule.migrationsDir))
        .filter((file) => file.endsWith('.sql'))
        .sort()
      expect(entries.map(([name]) => name)).toEqual(repository)
      expect(copied).toBe(true)
    } finally {
      await owned.drop()
    }
  })

  it('migrates repeated source copies from one template of their unchanged predecessors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-predecessor-test-'))
    directories.push(directory)
    const repository = (await readdir(migrationModule.migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .slice(0, 3)
    for (const file of repository) {
      await copyFile(join(migrationModule.migrationsDir, file), join(directory, file))
    }
    await writeFile(join(directory, '9999_probe.sql'), 'CREATE TABLE probe (id integer);')
    expect(await predecessorTemplates()).toEqual([])
    const fixtures: TestDatabase[] = []
    try {
      const results = []
      for (let copy = 0; copy < 3; copy += 1) {
        const since = new Date()
        const owned = await createTestDatabase(serverUrl as string, directory)
        fixtures.push(owned)
        await owned.pool.query('INSERT INTO probe VALUES (1)')
        results.push(await ledger(owned, since))
      }
      // The first fixture replays as before; later ones copy one template of 0001..0003, so
      // they share its application times, and each applies only the probe itself.
      const predecessors = results.map(({ appliedAt }) => appliedAt.slice(0, 3))
      expect(results[0]?.copied).toBe(false)
      expect(predecessors[1]).not.toEqual(predecessors[0])
      expect(predecessors[2]).toEqual(predecessors[1])
      expect(results[2]?.appliedAt[3]).not.toBe(results[1]?.appliedAt[3])
      expect(results[1]?.entries).toEqual(results[0]?.entries)
      expect(results[2]?.entries).toEqual(results[0]?.entries)
      expect(results[0]?.entries.map(([name]) => name)).toEqual([...repository, '9999_probe.sql'])
      expect(await predecessorTemplates()).toHaveLength(1)
      // A changed predecessor file is never taken from the template.
      await writeFile(
        join(directory, repository[2] as string),
        'CREATE TABLE changed (id integer);',
      )
      const since = new Date()
      const changed = await createTestDatabase(serverUrl as string, directory)
      fixtures.push(changed)
      expect((await ledger(changed, since)).copied).toBe(false)
      await changed.pool.query('SELECT FROM changed')
    } finally {
      for (const fixture of fixtures) await fixture.drop()
    }
    await cleanupTestDatabases()
    expect(await predecessorTemplates()).toEqual([])
    // After cleanup, repeated copies build a new template instead of naming the dropped one.
    await copyFile(
      join(migrationModule.migrationsDir, repository[2] as string),
      join(directory, repository[2] as string),
    )
    for (let copy = 0; copy < 2; copy += 1) {
      const owned = await createTestDatabase(serverUrl as string, directory)
      try {
        await owned.pool.query('INSERT INTO probe VALUES (1)')
      } finally {
        await owned.drop()
      }
    }
    expect(await predecessorTemplates()).toHaveLength(1)
    await cleanupTestDatabases()
  })

  /**
   * Keeps CREATE DATABASE … TEMPLATE waiting: COMMENT ON DATABASE holds SHARE UPDATE EXCLUSIVE
   * on the template until rollback, which conflicts with the SHARE lock CREATE takes on it.
   * Only clones of this test's own template wait; no other session is touched.
   */
  async function holdTemplate(template: string) {
    const maintenance = new URL(serverUrl as string)
    maintenance.pathname = '/postgres'
    const holder = new pg.Client({ connectionString: maintenance.toString() })
    holder.on('error', () => {})
    let pid: number | undefined
    try {
      await holder.connect()
      pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
      await holder.query('BEGIN')
      await holder.query(
        `COMMENT ON DATABASE ${pg.escapeIdentifier(template)} IS 'held by a CREATE timeout test'`,
      )
    } catch (error) {
      await holder.end().catch(() => {})
      throw error
    }
    let released: Promise<void> | undefined
    const release = () => {
      released ??= holder
        .query('ROLLBACK')
        .catch(() => {})
        .then(() => holder.end())
      return released
    }
    // CREATE has reached the template lock and waits for this holder, not for anything else.
    const waitForBlockedCreate = async () => {
      const blocked = new RegExp(`^CREATE DATABASE hourmere_test_\\w+ TEMPLATE ${template}$`)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { rows } = await admin.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity
            WHERE $1::int = ANY (pg_blocking_pids(pid)) AND query LIKE 'CREATE DATABASE %'`,
          [pid],
        )
        if (rows.some(({ query }) => blocked.test(query))) return
        await delay(50)
      }
      throw new Error('CREATE DATABASE never waited for the held template')
    }
    return { release, waitForBlockedCreate }
  }

  function settle(creation: Promise<TestDatabase>) {
    return creation.then(
      (database) => ({ database, error: undefined }),
      (error: unknown) => ({ database: undefined, error }),
    )
  }

  it('lets CREATE DATABASE wait past the default admin timeouts', async () => {
    // URL parameters and PGOPTIONS cannot shorten the wait, including with a lock timeout.
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=1000 -c lock_timeout=1000')
    const shortened = new URL(serverUrl as string)
    shortened.searchParams.set('statement_timeout', '1000')
    shortened.searchParams.set('query_timeout', '1000')
    shortened.searchParams.set('lock_timeout', '1000')
    let template: Awaited<ReturnType<typeof createTestDatabaseTemplate>> | undefined
    let holder: Awaited<ReturnType<typeof holdTemplate>> | undefined
    let creation: ReturnType<typeof settle> | undefined
    try {
      template = await createTestDatabaseTemplate(shortened.toString(), async () => {}, {
        tag: 'slow_template',
      })
      holder = await holdTemplate(template.name)
      const started = performance.now()
      creation = settle(template.clone(undefined, { migrate: false, tag: 'slow_create' }))
      await holder.waitForBlockedCreate()
      // Past the default 5 s statement timeout and its 6 s client timeout.
      await delay(Math.max(0, 7_000 - (performance.now() - started)))
      await holder.release()
      const { database, error } = await creation
      expect(error).toBeUndefined()
      expect(performance.now() - started).toBeGreaterThan(7_000)
      expect(await exists(new URL(database?.url as string).pathname.slice(1))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await holder?.release()
      await (await creation)?.database?.drop()
      await template?.drop()
    }
  }, 20_000)

  it('lets the server abort a CREATE DATABASE whose client has gone', async () => {
    // URL parameters and PGOPTIONS cannot disable the server-side client check.
    vi.stubEnv('PGOPTIONS', '-c client_connection_check_interval=0')
    const weakened = new URL(serverUrl as string)
    weakened.searchParams.set('client_connection_check_interval', '0')
    weakened.searchParams.set('options', '-c client_connection_check_interval=0')
    const clients: pg.Client[] = []
    const connect = pg.Client.prototype.connect
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      clients.push(this)
      return (connect as (...a: unknown[]) => unknown).apply(this, args) as never
    } as never)
    let template: Awaited<ReturnType<typeof createTestDatabaseTemplate>> | undefined
    let holder: Awaited<ReturnType<typeof holdTemplate>> | undefined
    let creation: ReturnType<typeof settle> | undefined
    try {
      template = await createTestDatabaseTemplate(weakened.toString(), async () => {}, {
        tag: 'gone_template',
      })
      clients.length = 0
      holder = await holdTemplate(template.name)
      creation = settle(template.clone(undefined, { migrate: false, tag: 'gone_client' }))
      await holder.waitForBlockedCreate()
      // Only the connection this test's CREATE opened: the backend of that CREATE.
      const { rows: backends } = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE query LIKE $1 || '%' AND query LIKE '% TEMPLATE ' || $2",
        ['CREATE DATABASE hourmere_test_gone_client_', template.name],
      )
      expect(backends).toHaveLength(1)
      const pid = backends[0]?.pid as number
      const client = clients.find(
        (candidate) => (candidate as unknown as { processID: number }).processID === pid,
      )
      expect(client).toBeDefined()
      const stream = (client as unknown as { connection: { stream: { destroy(): void } } })
        .connection.stream
      stream.destroy()
      const started = performance.now()
      let running = true
      while (running && performance.now() - started < 3_000) {
        await delay(100)
        const { rowCount } = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND query LIKE 'CREATE DATABASE %'",
          [pid],
        )
        running = rowCount !== 0
      }
      expect(running, 'server-side CREATE DATABASE kept running after its client went').toBe(false)
      const pattern = `hourmere_test_gone_client_${process.pid}_%`
      const leftovers = () =>
        admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [pattern])
      expect((await leftovers()).rows).toEqual([])
      await holder.release()
      await delay(1_000)
      expect((await leftovers()).rows).toEqual([])
      await creation
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      await holder?.release()
      await (await creation)?.database?.drop()
      await template?.drop()
    }
  }, 30_000)

  it('still cancels CREATE DATABASE with a statement timeout after its 30 s cap', async () => {
    const guard = new AbortController()
    let template: Awaited<ReturnType<typeof createTestDatabaseTemplate>> | undefined
    let holder: Awaited<ReturnType<typeof holdTemplate>> | undefined
    let creation: ReturnType<typeof settle> | undefined
    try {
      template = await createTestDatabaseTemplate(serverUrl as string, async () => {}, {
        tag: 'cap_template',
      })
      holder = await holdTemplate(template.name)
      const started = performance.now()
      creation = settle(template.clone(undefined, { migrate: false, tag: 'over_cap' }))
      await holder.waitForBlockedCreate()
      // Without a cap, CREATE would wait for as long as the template stays held.
      const outcome = await Promise.race([
        creation,
        delay(40_000, 'still waiting', { signal: guard.signal }),
      ])
      expect(outcome, 'CREATE DATABASE was still waiting after 40 s').not.toBe('still waiting')
      expect(typeof outcome === 'object' && outcome.error).toMatchObject({
        code: '57014',
        message: 'canceling statement due to statement timeout',
      })
      expect(performance.now() - started).toBeGreaterThan(29_500)
      const leftovers = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
        `hourmere_test_over_cap_${process.pid}_%`,
      ])
      expect(leftovers.rows).toEqual([])
    } finally {
      guard.abort()
      await holder?.release()
      await (await creation)?.database?.drop()
      await template?.drop()
    }
  }, 60_000)

  it('can keep a connection after failed statements instead of reopening one', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      migrate: false,
      tag: 'reuse',
    })
    try {
      const pool = reuseConnectionsAfterErrors(owned.pool)
      const backends = new Set<number>()
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(pool.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
        backends.add((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      }
      expect(backends.size).toBe(1)
      expect(pool.totalCount).toBe(1)
    } finally {
      await owned.drop()
    }
  })

  it('creates migrated fixtures with synchronous_commit and JIT disabled', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const client = await owned.pool.connect()
    try {
      expect((await client.query('SHOW synchronous_commit')).rows).toEqual([
        { synchronous_commit: 'off' },
      ])
      expect((await client.query('SHOW jit')).rows).toEqual([{ jit: 'off' }])
      // Mid-file statistics can lift any read past the JIT thresholds. Cross them here and
      // require the read to run uncompiled.
      await client.query('SET jit_above_cost = 0')
      const plan = (
        await client.query('EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM schema_migrations')
      ).rows[0]?.['QUERY PLAN']?.[0]
      expect(plan?.['Execution Time']).toEqual(expect.any(Number))
      expect(plan).not.toHaveProperty('JIT')
      expect(
        (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations'))
          .rows[0]?.n,
      ).toBeGreaterThan(0)
    } finally {
      client.release(true)
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
