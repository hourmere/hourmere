import { expect, it } from 'vitest'
import source from './WaitlistJoin.tsx?raw'

const messages = [
  ['waitlist_full', 'This waitlist is full (100 entries). Please check available times later.'],
  ['waitlist_smtp_not_configured', 'Waitlist email is unavailable. Please contact the host.'],
] as const

// Evaluate only the source-copied catch mapping; browser tests exercise its rendered alerts.
function assertErrors(mutation?: string) {
  const start = source.indexOf('      setError(', source.indexOf('} catch (err)'))
  const end = source.indexOf('    } finally', start)
  let mapping = source.slice(start, end)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  if (mutation) {
    const anchor = `codeOf(err) === '${mutation}'`
    expect(mapping).toContain(anchor)
    mapping = mapping.replace(anchor, 'false')
  }
  const evaluate = new Function(
    'err',
    'codeOf',
    'failureMessage',
    'UNAVAILABLE',
    'setError',
    mapping,
  )
  for (const [code, expected] of messages) {
    let actual: unknown
    evaluate(
      code,
      (value: string) => value,
      () => 'Generic failure',
      'Unavailable',
      (value: unknown) => {
        actual = value
      },
    )
    expect(actual).toBe(expected)
  }
}

it('maps capacity and SMTP failures to actionable public messages', () => assertErrors())
it.each(messages)('detects source-copy removal of the %s message', (code) => {
  expect(() => assertErrors(code)).toThrowError(/expected/)
})
