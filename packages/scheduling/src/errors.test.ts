import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DomainError, RESERVED_ERROR_CODES } from './errors.ts'

function assertReservedCodes(ErrorClass: typeof DomainError) {
  expect(() => new ErrorClass('invalid', 'invalid_request', 'note: invalid')).not.toThrow()
  expect(new ErrorClass('invalid', 'invalid_request', 'note: invalid').kind).toBe('invalid')
  for (const kind of ['invalid', 'not_found', 'forbidden', 'conflict'] as const)
    for (const code of RESERVED_ERROR_CODES)
      if (kind !== 'invalid' || code !== 'invalid_request')
        expect(() => new ErrorClass(kind, code)).toThrow(/reserved/)
}

describe('service validation error codes', () => {
  it('permits invalid_request only for invalid input and preserves other reservations', () => {
    assertReservedCodes(DomainError)
  })
  it('reserves every generic code the HTTP layer answers, including service_unavailable', () => {
    // 503 service_unavailable is the server's answer to a database connection timeout; a
    // service must not be able to send the same code with a 4xx status.
    expect([...RESERVED_ERROR_CODES]).toContain('service_unavailable')
    for (const kind of ['invalid', 'not_found', 'forbidden', 'conflict'] as const)
      expect(() => new DomainError(kind, 'service_unavailable')).toThrow(/reserved/)
  })
  it.each([
    ['remove validation exception', " && !(kind === 'invalid' && code === 'invalid_request')", ''],
    [
      'allow other kinds',
      "kind === 'invalid' && code === 'invalid_request'",
      "code === 'invalid_request'",
    ],
    [
      'allow other reserved codes',
      "kind === 'invalid' && code === 'invalid_request'",
      "kind === 'invalid'",
    ],
  ])('detects a source-copy change: %s', (_name, before, after) => {
    const source = readFileSync(new URL('./errors.ts', import.meta.url), 'utf8')
    expect(source.includes(before), 'mutation must match source').toBe(true)
    const changed = stripTypeScriptTypes(source.replace(before, after)).replace(/\bexport /g, '')
    const MutatedError = new Function(`${changed}; return DomainError`)() as typeof DomainError
    expect(() => assertReservedCodes(MutatedError)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
