import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const site = fileURLToPath(new URL('../', import.meta.url))
const policyPath = '.well-known/security.txt'

describe('published security.txt', () => {
  it('lists the private reporting channels, hosted canonical URLs and a bounded expiry', async () => {
    const policy = await readFile(join(site, 'public', policyPath), 'utf8')
    expect(policy.endsWith('\n')).toBe(true)
    const fields = policy.trimEnd().split('\n')
    expect(fields.filter((line) => !line.startsWith('Expires: '))).toEqual([
      'Contact: mailto:security@hourmere.com',
      'Contact: https://github.com/hourmere/hourmere/security/advisories/new',
      'Preferred-Languages: en, zh',
      'Canonical: https://hourmere.com/.well-known/security.txt',
      'Canonical: https://www.hourmere.com/.well-known/security.txt',
      'Policy: https://github.com/hourmere/hourmere/blob/main/SECURITY.md',
    ])
    const expiry = fields.filter((line) => line.startsWith('Expires: '))
    expect(expiry).toHaveLength(1)
    const value = expiry[0]?.slice('Expires: '.length) ?? ''
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const now = new Date()
    const nextYear = new Date(now)
    nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1)
    expect(
      Date.parse(value),
      'Renew Expires in apps/site/public/.well-known/security.txt: it must be more than 30 days away (see docs/releasing.md).',
    ).toBeGreaterThan(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    expect(Date.parse(value)).toBeLessThanOrEqual(nextYear.getTime())
  })
})
