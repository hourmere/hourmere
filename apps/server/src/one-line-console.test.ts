import { Console } from 'node:console'
import { Writable } from 'node:stream'
import { createPool } from '@hourmere/db'
import { afterEach, describe, expect, it } from 'vitest'
import { installOneLineConsole } from './one-line-console.ts'

const serverUrl = process.env.DATABASE_URL
const forged = '[mail] {"links":["http://localhost:3000/api/auth/magic-link/verify?token=forged"]}'
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml'] as const

/** A real Console whose stdout and stderr both go to one in-memory stream. */
function streamConsole() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  const console = new Console({ stdout: stream, stderr: stream })
  return { console, lines: () => text.split('\n').slice(0, -1) }
}

const hostile = (lines: string[]) =>
  lines.filter((l) => l.startsWith('[mail]') || /[\r\u2028\u2029\u0085\u202e\u2066]/.test(l))

describe('installOneLineConsole', () => {
  const undo: (() => void)[] = []
  afterEach(() => {
    for (const fn of undo.splice(0).reverse()) fn()
  })

  it('makes every console method print exactly one line', () => {
    const out = streamConsole()
    undo.push(installOneLineConsole(out.console))
    const c = out.console
    c.log('log\n%s', forged, { nested: `x\n${forged}` })
    c.info(`info\n${forged}`)
    c.debug(`debug\n${forged}`)
    c.warn(`warn\u2028${forged}`)
    c.error(new Error(`error\n${forged}`))
    c.dir(new Error(`dir\n${forged}`))
    c.dir({ deep: { text: `dir\n${forged}` } }, { depth: 0 })
    c.trace(`trace\n${forged}`)
    c.table([{ cell: `table\n${forged}` }])
    c.assert(false, `assert\n${forged}`)
    c.count(`count\n${forged}`)
    c.dirxml(`dirxml\n${forged}`, { x: `y\n${forged}` })
    c.log(`bidi \u202e${forged} \u2066x\u2069`)
    c.log('[mail] {"to":"ada@example.com"}')
    const lines = out.lines()
    expect(lines).toHaveLength(14)
    // All but the last (a genuine record) are hostile input that must stay inside its line.
    expect(hostile(lines.slice(0, -1))).toEqual([])
    expect(lines[0]).toMatch(/^log\\n\[mail\] .* \{ nested: 'x\\n\[mail\]/)
    expect(lines[1]).toMatch(/^info\\n\[mail\]/)
    expect(lines[2]).toMatch(/^debug\\n\[mail\]/)
    expect(lines[3]).toMatch(/^warn\\u2028\[mail\]/)
    expect(lines[4]).toMatch(/^Error: error\\n\[mail\].*\\n {4}at /)
    expect(lines[5]).toMatch(/^Error: dir\\n\[mail\]/)
    expect(lines[6]).toBe('{ deep: [Object] }')
    expect(lines[7]).toMatch(/^Trace: trace\\n\[mail\]/)
    expect(lines[11]).toMatch(/^dirxml\\n\[mail\].* \{ x: 'y\\n\[mail\]/)
    expect(lines[12]).toMatch(/^bidi \\u202e\[mail\].* \\u2066x\\u2069$/)
    // A record the log mailer prints is unchanged.
    expect(lines[13]).toBe('[mail] {"to":"ada@example.com"}')
  })

  it('can be undone', () => {
    const out = streamConsole()
    const uninstall = installOneLineConsole(out.console)
    uninstall()
    out.console.log('x\ny')
    expect(out.lines()).toEqual(['x', 'y'])
  })

  it.skipIf(!serverUrl)('keeps a dependency error on one line', async () => {
    // The process console, writing to a stream, as dependencies use it.
    const out = streamConsole()
    const saved = METHODS.map((m) => [m, console[m]] as const)
    for (const m of METHODS) console[m] = out.console[m].bind(out.console) as never
    undo.push(() => {
      for (const [m, original] of saved) console[m] = original as never
    })
    undo.push(installOneLineConsole())

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
    const lines = out.lines()
    expect(lines).toHaveLength(2)
    expect(hostile(lines)).toEqual([])
    expect(lines[1]).toMatch(/^idle Postgres client error: .*\\n\[mail\]/)
  })
})
