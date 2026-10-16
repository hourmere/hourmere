import { createPool } from '@hourmere/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installOneLineConsole } from './one-line-console.ts'

const serverUrl = process.env.DATABASE_URL
const forged = '[mail] {"links":["http://localhost:3000/api/auth/magic-link/verify?token=forged"]}'

describe('installOneLineConsole', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    vi.restoreAllMocks()
  })

  /** Installs over spied console methods; returns what reached the real console. */
  function capture() {
    const printed: unknown[][] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void printed.push(args))
    }
    uninstall = installOneLineConsole()
    return printed
  }

  const expectOneLineEach = (printed: unknown[][]) => {
    for (const args of printed) {
      expect(args).toHaveLength(1)
      expect(args[0]).toEqual(expect.any(String))
      expect(args[0]).not.toMatch(/[\n\r\u2028\u2029]/)
    }
  }

  it('prints strings, objects and errors on one line each, keeping formatting', () => {
    const printed = capture()
    console.error(new Error(`boom\n${forged}`))
    console.log('a\nb', { c: 'd\ne' })
    console.warn('%s=%d', 'count', 3)
    console.log(`[mail] {"to":"ada@example.com"}`)
    expectOneLineEach(printed)
    expect(printed[0]?.[0]).toMatch(/^Error: boom\\n\[mail\].*\\n {4}at /)
    expect(printed[1]?.[0]).toBe("a\\nb { c: 'd\\ne' }")
    expect(printed[2]?.[0]).toBe('count=3')
    // A record the log mailer prints is unchanged.
    expect(printed[3]?.[0]).toBe('[mail] {"to":"ada@example.com"}')
  })

  it('can be undone', () => {
    const printed = capture()
    uninstall?.()
    uninstall = undefined
    console.log('x\ny')
    expect(printed).toEqual([['x\ny']])
  })

  it.skipIf(!serverUrl)('keeps a dependency error on one line', async () => {
    const printed = capture()
    const pool = createPool(serverUrl as string)
    try {
      // Postgres quotes the bad value, newline and all; Better Auth's adapter fallback and
      // the pool's idle-client handler print such errors raw.
      const error = await pool.query('SELECT $1::uuid', [`zz\n${forged}`]).catch((e) => e)
      expect(String(error.message)).toContain('\n')
      console.error(error)
      pool.emit('error', error)
    } finally {
      await pool.end()
    }
    expect(printed).toHaveLength(2)
    expectOneLineEach(printed)
    expect(printed.map((args) => String(args[0])).filter((l) => l.startsWith('[mail]'))).toEqual([])
    expect(String(printed[1]?.[0])).toMatch(/^idle Postgres client error: .*\\n\[mail\]/)
  })
})
