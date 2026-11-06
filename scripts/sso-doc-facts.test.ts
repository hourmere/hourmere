import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../docs/sso.md', import.meta.url), 'utf8')
const limits = {
  clockSkew: 60,
  authenticationAttemptLifetime: 600,
  maximumSamlAssertionLifetime: 600,
  ssoProofLifetime: 28800,
  freshAdministrationProof: 300,
  domainChallengeLifetime: 86400,
  domainRecheckInterval: 86400,
  domainVerificationLifetime: 604800,
  jwksCacheMaximum: 3600,
} as const

function assertLimits(document: string) {
  const table = document.split('## Pinned operational limits')[1]?.split('\n## ')[0] ?? ''
  const entries = [...table.matchAll(/^\| `([^`]+)` \| (\d+) \| seconds \|$/gm)].map(
    ([, name, value]) => [name, Number(value)],
  )
  expect(entries).toHaveLength(Object.keys(limits).length)
  expect(Object.fromEntries(entries)).toEqual(limits)
}

describe('SSO design numeric commitments (not runtime verification)', () => {
  it('pins all operational limits until implementation supplies shared constants', () => {
    assertLimits(source)
  })

  it.each(Object.entries(limits))('rejects a source-copy change to %s', (name, value) => {
    const row = `| \`${name}\` | ${value} | seconds |`
    expect(source).toContain(row)
    const mutated = source.replace(row, `| \`${name}\` | ${value + 1} | seconds |`)
    expect(() => assertLimits(mutated)).toThrow()
    assertLimits(source)
  })

  it('rejects a removed or duplicated limit row', () => {
    const row = '| `clockSkew` | 60 | seconds |'
    expect(() => assertLimits(source.replace(row, ''))).toThrow()
    expect(() => assertLimits(source.replace(row, `${row}\n${row}`))).toThrow()
    assertLimits(source)
  })
})
