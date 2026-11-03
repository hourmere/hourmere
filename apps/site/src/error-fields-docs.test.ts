import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUCCESS_REDIRECT_ERROR_FIELDS } from '../../server/src/success-redirect-errors.ts'

function verify(source: string) {
  const text = source.replace(/`/g, '').replace(/\s+/g, ' ')
  expect(text).toContain('An optional field string')
  expect(text).toContain('New values may appear within /api/v1; clients must ignore unknown values')
  expect(text).toContain('open string, not a closed enum')
  expect(text).toContain('field may be absent')
  for (const field of SUCCESS_REDIRECT_ERROR_FIELDS) expect(source).toContain(`\`${field}\``)
}

describe.each(['docs/api-conventions.md', 'apps/site/src/content/docs/docs/api-conventions.md'])(
  'validation error field convention in %s',
  (path) => {
    it('documents optional, open field names and future-compatible handling', () => {
      verify(readFileSync(path, 'utf8'))
    })

    it.each([
      ['An optional `field` string', 'A required `field` enum'],
      ['clients must ignore unknown values', 'clients reject unknown values'],
      ['`successRedirect.url`', '`unrelatedField`'],
    ])('detects a changed source copy: %s', (from, to) => {
      const source = readFileSync(path, 'utf8')
      expect(source).toContain(from)
      expect(() => verify(source.replace(from, to))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  },
)
