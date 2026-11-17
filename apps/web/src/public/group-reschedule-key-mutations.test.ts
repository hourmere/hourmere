import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { compileSourceCopy } from '../test/compile-source-copy.ts'
import { randomKey } from './api.ts'

const page = readFileSync('apps/web/src/public/ManageBookingPage.tsx', 'utf8')
const start = page.indexOf('                const { slot } = mode')
const end = page.indexOf('// The new booking answers no request', start)
const source = page.slice(start, end)

it.each([
  ['reuse', 'if (moveAttempt.current?.request !== request)', 'if (true)'],
  ['forwarding', '                    moveAttempt.current.key,', ''],
])(
  'kills removal of group move key %s in the production submit handler',
  async (_, before, after) => {
    expect(source).toContain(before)
    async function verify(text: string) {
      const code = compileSourceCopy(
        'managed move submission',
        `export async function submit(mode, token, booking, moveAttempt, randomKey, rescheduleManagedBooking) { ${text} return result } catch(error) { throw error } }`,
        { loader: 'ts', format: 'cjs' },
      )
      const module = { exports: {} as { submit: (...args: unknown[]) => Promise<void> } }
      new Function('module', 'exports', code)(module, module.exports)
      const attempt = { current: null }
      const keys: string[] = []
      for (const target of ['first', 'first', 'second']) {
        await module.exports.submit(
          { slot: { start: target } },
          'token',
          { id: 'booking' },
          attempt,
          randomKey,
          async (_token: string, _start: string, _request: string, key = randomKey()) => {
            keys.push(key)
          },
        )
      }
      expect(keys[1]).toBe(keys[0])
      expect(keys[2]).not.toBe(keys[0])
    }
    await verify(source)
    await expect(verify(source.replace(before, after))).rejects.toThrow(/expected/)
  },
)
