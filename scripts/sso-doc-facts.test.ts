import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../docs/sso.md', import.meta.url), 'utf8')
const limits = {
  clockSkew: 60,
  oidcClockSkew: 30,
  authenticationAttemptLifetime: 600,
  maximumSamlAssertionLifetime: 600,
  ssoProofLifetime: 28800,
  ssoDelegationLifetime: 2592000,
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

// These guard the written contract only. Signed protocol fixtures belong to the
// implementation's SAML verifier step; no product verifier exists in this PR.
const samlCommitments = {
  requiredTimestamps:
    'require finite Conditions NotBefore and NotOnOrAfter, bearer SubjectConfirmationData NotOnOrAfter and assertion IssueInstant.',
  deadline:
    '`acceptanceDeadline = min(SubjectConfirmationData.NotOnOrAfter, Conditions.NotOnOrAfter, IssueInstant + maximumSamlAssertionLifetime)`',
  exclusiveExpiry: 'Accept only while `now < acceptanceDeadline + clockSkew`',
  completionRecheck: 'recheck at browser completion as well as ACS validation.',
  longValidity:
    'Do not reject an assertion solely because its Conditions or bearer validity window exceeds `maximumSamlAssertionLifetime`.',
  replayRetention: '`max(acceptanceDeadline + clockSkew, requestExpiresAt)`',
} as const

function assertSamlCommitments(document: string) {
  const section = document.split('### SAML\n')[1]?.split('\n### ')[0] ?? ''
  const normalized = section.replace(/\s+/g, ' ')
  for (const commitment of Object.values(samlCommitments)) {
    expect(normalized).toContain(commitment)
  }
  expect(normalized).not.toContain('reject assertions whose lifetime exceeds')
}

describe('SAML acceptance deadline documentation (not runtime verification)', () => {
  it('defines compatible acceptance and replay deadlines', () => {
    assertSamlCommitments(source)
  })

  it.each(Object.entries(samlCommitments))('rejects a source-copy loss of %s', (_, text) => {
    const normalized = source.replace(/\s+/g, ' ')
    expect(normalized).toContain(text)
    // Preserve section separators while removing exactly the protected statement.
    const words = text.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const mutated = source.replace(new RegExp(words.join('\\s+')), 'REMOVED COMMITMENT')
    expect(mutated).not.toBe(source)
    expect(() => assertSamlCommitments(mutated)).toThrow()
    assertSamlCommitments(source)
  })
})
