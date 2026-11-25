import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it.each(['payments', 'configuration'])(
  '%s documents the off-by-default receiver and disabled paid admission',
  (page) => {
    const source = readFileSync(new URL(`./content/docs/docs/${page}.md`, import.meta.url), 'utf8')
    const check = (text: string) => {
      const prose = text.replace(/\s+/g, ' ')
      expect(prose).toContain('`PAID_BOOKINGS_ENABLED` defaults to `false`')
      expect(prose).toContain('`POST /api/webhooks/stripe`')
      expect(prose).toMatch(/Paid hold admission and public Checkout (?:stay|remain) disabled/)
      expect(prose).toContain('Existing holds expire regardless')
    }
    check(source)
    expect(() => check(source.replace('defaults to `false`', 'defaults to `true`'))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  },
)
