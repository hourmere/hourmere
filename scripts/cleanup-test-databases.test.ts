import { randomBytes } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  embeddedPid,
  isProcessAlive,
  listTestDatabases,
  main,
  maintenanceUrl,
  selectionReason,
  sweepTestDatabases,
  type TestDatabaseCandidate,
} from './cleanup-test-databases.ts'

const now = Date.parse('2026-10-20T12:00:00Z')
const candidate = (overrides: Partial<TestDatabaseCandidate> = {}): TestDatabaseCandidate => ({
  name: 'hourmere_test_fixture_2147483647_aabbccdd',
  oid: '1234',
  modifiedAt: new Date(now - 25 * 3_600_000),
  connections: 0,
  ...overrides,
})
const options = { now, processAlive: () => false }

afterEach(() => vi.restoreAllMocks())

describe('stale database selection', () => {
  it.each([
    ['hourmere', 'outside test namespace'],
    ['hourmere_testx_12_abcd', 'outside test namespace'],
    ['hourmere_test_12_abcd";DROP DATABASE hourmere;', 'outside test namespace'],
  ])('rejects %s', (name, reason) => {
    expect(selectionReason(candidate({ name }), options)).toBe(reason)
  })

  it('requires a known age strictly greater than the default 24 hours', () => {
    expect(selectionReason(candidate(), options)).toBe('eligible')
    for (const modifiedAt of [null, new Date('invalid')])
      expect(selectionReason(candidate({ modifiedAt }), options)).toBe('unknown age')
    for (const hours of [24, 23, 0, -1])
      expect(
        selectionReason(candidate({ modifiedAt: new Date(now - hours * 3_600_000) }), options),
      ).toBe('too young')
    expect(selectionReason(candidate(), { ...options, minAgeHours: 26 })).toBe('too young')
    expect(selectionReason(candidate(), { ...options, minAgeHours: 1 })).toBe('eligible')
  })

  it.each([1, 3, -1, Number.NaN])('requires exactly zero connections (%s)', (connections) => {
    expect(selectionReason(candidate({ connections }), options)).toBe('has connections')
  })

  it('retains a live PID, including tags, while accepting old names without a PID', () => {
    const processAlive = vi.fn(() => true)
    expect(selectionReason(candidate(), { now, processAlive })).toBe('PID is live')
    expect(processAlive).toHaveBeenCalledWith(2_147_483_647)
    expect(embeddedPid('hourmere_test_1234_aabb')).toBe(1234)
    expect(embeddedPid('hourmere_test_host_tokens_1234_aabb')).toBe(1234)
    expect(embeddedPid('hourmere_test_1234_1729367788000')).toBe(1234)
    const name = 'hourmere_test_host_tokens_868f6d4619174bca971e0fd3cd312a6c'
    expect(embeddedPid(name)).toBeNull()
    expect(selectionReason(candidate({ name }), { now, processAlive })).toBe('eligible')
  })

  it('treats inaccessible processes as live and only ESRCH as dead', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(isProcessAlive(1234)).toBe(true)
    for (const code of ['EPERM', 'EINVAL']) {
      kill.mockImplementation(() => {
        throw Object.assign(new Error('fixture'), { code })
      })
      expect(isProcessAlive(1234)).toBe(true)
    }
    kill.mockImplementation(() => {
      throw Object.assign(new Error('fixture'), { code: 'ESRCH' })
    })
    expect(isProcessAlive(1234)).toBe(false)
  })

  it.each([0, -1, Infinity, Number.NaN, Number.MAX_VALUE])(
    'rejects unsafe age %s',
    (minAgeHours) => {
      expect(() => selectionReason(candidate(), { minAgeHours })).toThrow('finite positive')
    },
  )

  it('derives the maintenance database even from URL database overrides', () => {
    const url = new URL(
      maintenanceUrl(
        'postgres://user:fixture@localhost/hourmere?database=hourmere&dbname=hourmere&sslmode=disable',
      ),
    )
    expect(url.pathname).toBe('/postgres')
    expect(url.searchParams.has('database')).toBe(false)
    expect(url.searchParams.has('dbname')).toBe(false)
    expect(url.searchParams.get('sslmode')).toBe('disable')
    expect(() => maintenanceUrl('https://example.test/hourmere')).toThrow('PostgreSQL')
  })
})

describe('sweeper safety', () => {
  const mockAdmin = (rows: TestDatabaseCandidate[] = [candidate()]) => {
    const query = vi.fn().mockResolvedValue({ rows })
    return { query, pool: { query } as unknown as pg.Pool }
  }

  it('defaults to dry run without executing any SQL', async () => {
    const { pool, query } = mockAdmin()
    const log = vi.fn()
    expect(await sweepTestDatabases(pool, [candidate()], { ...options, log })).toBe(0)
    expect(query).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WOULD DROP'))
  })

  it('requires explicit yes, rechecks eligibility and drops without force', async () => {
    const { pool, query } = mockAdmin()
    expect(
      await sweepTestDatabases(pool, [candidate()], { ...options, yes: true, log: vi.fn() }),
    ).toBe(1)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[1]).toEqual([candidate().name])
    expect(query.mock.calls[1]?.[0]).toBe(`DROP DATABASE "${candidate().name}"`)
  })

  it.each([
    [],
    [candidate({ oid: '9999' })],
    [candidate({ connections: 1 })],
    [candidate({ modifiedAt: new Date(now) })],
  ])('skips changed inventory %#', async (...rows) => {
    const { pool, query } = mockAdmin(rows as TestDatabaseCandidate[])
    expect(
      await sweepTestDatabases(pool, [candidate()], { ...options, yes: true, log: vi.fn() }),
    ).toBe(0)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('lets a newly arrived connection veto DROP', async () => {
    const { pool, query } = mockAdmin()
    query
      .mockResolvedValueOnce({ rows: [candidate()] })
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: '55006' }))
    const log = vi.fn()
    expect(await sweepTestDatabases(pool, [candidate()], { ...options, yes: true, log })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('acquired connections'))
  })

  it('validates CLI arguments without printing credential-bearing errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const args of [
      [],
      ['--yes', '--older-than-hours=0'],
      ['--unknown=postgres://fixture:private@example.test'],
    ])
      expect(await main(args, {})).toBe(1)
    expect(error.mock.calls.flat().join(' ')).not.toContain('private')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('sweeper integration', () => {
  it('dry-runs and drops only owned fake-old fixtures, preserving young, live and connected databases', async () => {
    const admin = new pg.Pool({
      connectionString: maintenanceUrl(process.env.DATABASE_URL as string),
      max: 1,
    })
    const owners: TestDatabase[] = []
    const renamed: string[] = []
    let busy: pg.Pool | undefined
    try {
      for (let i = 0; i < 3; i++) {
        const owner = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
          migrate: false,
          tag: 'sweep',
        })
        owners.push(owner)
        if (i < 2) {
          const oldName = new URL(owner.url).pathname.slice(1)
          const name = `hourmere_test_sweep_old_2147483647_${randomBytes(6).toString('hex')}`
          await admin.query(
            `ALTER DATABASE ${pg.escapeIdentifier(oldName)} RENAME TO ${pg.escapeIdentifier(name)}`,
          )
          renamed.push(name)
        }
      }
      const ownNames = new Set([
        ...renamed,
        ...owners.map((owner) => new URL(owner.url).pathname.slice(1)),
      ])
      const inventory = () =>
        listTestDatabases(admin).then((rows) => rows.filter((row) => ownNames.has(row.name)))
      const future = Date.now() + 25 * 3_600_000
      const busyUrl = new URL(owners[1]?.url as string)
      busyUrl.pathname = `/${renamed[1]}`
      busy = new pg.Pool({ connectionString: busyUrl.toString(), max: 1 })
      await busy.query('SELECT 1')
      const log = vi.fn()
      const fresh = await inventory()
      expect(fresh).toHaveLength(3)
      expect(fresh.every((row) => selectionReason(row) === 'too young')).toBe(true)
      expect(await sweepTestDatabases(admin, fresh, { now: future, log })).toBe(0)
      expect(await inventory()).toHaveLength(3)
      expect(
        await sweepTestDatabases(admin, await inventory(), { now: future, yes: true, log }),
      ).toBe(1)
      const remaining = await inventory()
      expect(remaining.map((row) => row.name)).toEqual(
        expect.arrayContaining([renamed[1], new URL(owners[2]?.url as string).pathname.slice(1)]),
      )
      expect(remaining).toHaveLength(2)
      expect(log.mock.calls.flat().join('\n')).toContain('has connections')
      expect(log.mock.calls.flat().join('\n')).toContain('PID is live')
    } finally {
      await busy?.end()
      for (const owner of owners) await owner.drop()
      // Exact renamed names belong to this test only. Never sweep the shared inventory
      // with the advanced test clock: other tasks may own any of those databases.
      for (const name of renamed)
        await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
      await admin.end()
    }
  }, 30_000)
})
