import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it.each(['payments', 'configuration'])(
  '%s describes the reserved payment flag accurately',
  (page) => {
    const source = readFileSync(new URL(`./content/docs/docs/${page}.md`, import.meta.url), 'utf8')
    const check = (text: string) => {
      const prose = text.replace(/\s+/g, ' ')
      expect(prose).toContain('has no runtime effect in this release')
      expect(prose).toContain('does not permit hold creation or enable payment collection')
      expect(prose).toContain('Existing holds expire regardless')
    }
    check(source)
    expect(() => check(source.replace('does not permit', 'permits'))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  },
)
