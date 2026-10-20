import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { createPool } from './index.ts'

vi.mock('pg', () => ({
  default: {
    types: { builtins: { DATE: 1082 }, setTypeParser: vi.fn() },
    Pool: vi.fn(function MockPool() {
      return { on: vi.fn(), end: vi.fn(async () => {}) }
    }),
  },
}))

it('lets a test file mock pg before database modules are imported', async () => {
  const pool = createPool('postgres://localhost/mock_fixture')
  try {
    expect(pg.Pool).toHaveBeenCalledOnce()
    expect(pg.Pool).toHaveBeenCalledWith({ connectionString: 'postgres://localhost/mock_fixture' })
    expect(pool).toBe(vi.mocked(pg.Pool).mock.results[0]?.value)
  } finally {
    await pool.end()
  }
})
