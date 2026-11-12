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
  ssoRecoveryNominationLifetime: 259200,
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
// implementation's SAML verifier and SAML timing and replay steps; no product
// verifier exists in this PR.
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

// A lifetime-based rejection anywhere would contradict the deadline rule, so every
// sentence of the whole document is checked, not one section. A rejection is a
// reject/refuse/deny verb not directly negated, or a negated "accept". Only a negation
// directly before the reject verb ("Do not reject ...", "are not rejected") marks the
// protected rule. Validity wording and the limit's identifier count as lifetime terms.
const lifetimeTerm =
  /\blifetimes?\b|maximumSamlAssertionLifetime|\bvalidity (?:window|interval|period)\b|\bvalid for\b|\bwindow\b/i
const negatedAccept =
  /\b(?:do not|does not|don't|doesn't|never|must not|cannot|can't|will not|won't|may not)\s+accept/i
function lifetimeRejections(document: string) {
  return document
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?]) /)
    .filter((sentence) => {
      const verb = /\b(?:reject|refus|den(?:y|ie))\w*/i.exec(sentence)
      const before = verb ? sentence.slice(0, verb.index).trim().split(' ').slice(-3).join(' ') : ''
      const rejects =
        (verb !== null && !/\b(?:not|never|don't)$/i.test(before)) || negatedAccept.test(sentence)
      return (
        rejects &&
        /\bassertions?\b/i.test(sentence) &&
        lifetimeTerm.test(sentence) &&
        /\b(?:exceed\w*|longer than|more than|greater than|above)\b/i.test(sentence)
      )
    })
}

function assertSamlCommitments(document: string) {
  const section = document.split('### SAML\n')[1]?.split('\n### ')[0] ?? ''
  const normalized = section.replace(/\s+/g, ' ')
  for (const commitment of Object.values(samlCommitments)) {
    expect(normalized).toContain(commitment)
  }
  expect(lifetimeRejections(document)).toEqual([])
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

  it.each([
    ['pinned limits prose', '## Pinned operational limits\n'],
    ['implementation sequence', '## Implementation sequence\n'],
    ['self-hosting notes', '## Self-hosting and local acceptance\n'],
    ['delegated clients section', '### Delegated clients\n'],
  ])('rejects a contradictory lifetime rule in the %s', (_, heading) => {
    for (const rule of [
      'Reject assertions whose Conditions lifetime exceeds maximumSamlAssertionLifetime.',
      'The verifier rejects SAML assertions whose\nlifetime exceeds the configured maximum.',
      'Assertions whose lifetime exceeds maximumSamlAssertionLifetime are rejected.',
      'Refuse assertions whose lifetime exceeds the configured maximum.',
      'Deny any assertion with a lifetime longer than 600 seconds.',
      'Reject assertions whose lifetime exceeds 600 seconds; do not log them.',
      'Reject assertions whose lifetime exceeds the maximum and never accept unsigned ones.',
      'Refuse any assertion whose validity window exceeds `maximumSamlAssertionLifetime`.',
      'Assertions valid for longer than 600 seconds are rejected.',
      'Hourmere does not accept an assertion whose lifetime exceeds 600 seconds.',
    ]) {
      expect(source).toContain(heading)
      const mutated = source.replace(heading, `${heading}\n${rule}\n`)
      expect(() => assertSamlCommitments(mutated)).toThrow()
    }
    assertSamlCommitments(source)
  })
})

const finalState = 'Both settings; this step changes both defaults to true'
const protocolStates = [
  'hard-off',
  'setting introduced (default false)',
  'setting (default false)',
] as const
// Everything an operator setting may expose must exist first (see Rollout gating).
const settingPrerequisites = {
  OIDC: [
    'Transport',
    'OIDC verifier',
    'OIDC sign-in',
    'OIDC completion',
    'OIDC self-link',
    'OIDC admission',
    'Identity recovery',
    'OIDC step-up',
    'Team enforcement',
    'Team write enforcement',
    'Native enforcement',
    'Delegation enforcement',
    'Recovery enrollment',
    'Provider activation',
    'Enforcement policy',
    'Recovery use',
    'Recovery repair',
    'Operator recovery',
    'Member UI',
    'Recovery UI',
    'Enforcement UI',
    'Keycloak OIDC fixture',
    'Keycloak OIDC linking',
    'Keycloak OIDC acceptance',
  ],
  SAML: [
    'Recovery use',
    'Recovery repair',
    'Operator recovery',
    'Team enforcement',
    'Team write enforcement',
    'SAML verifier',
    'SAML timing and replay',
    'SAML start',
    'SAML ACS and completion',
    'SAML configuration and test',
    'SAML self-link',
    'SAML admission',
    'SAML identity recovery',
    'SAML step-up',
    'SAML UI',
    'Keycloak SAML fixture',
    'Keycloak SAML linking',
    'Keycloak SAML acceptance',
  ],
} as const

interface PlanRow {
  step: string
  dependencies: string[]
  flag: string
  acceptance: string
}

function planRows(document: string): PlanRow[] {
  const section = document.split('## Implementation sequence\n')[1]?.split('\n## ')[0] ?? ''
  const [header, ...lines] = section.split('\n').filter((line) => line.startsWith('| '))
  expect(header).toBe(
    '| Step | Builds; endpoint / MCP / CLI ownership | Dependencies | Flag state | Acceptance checks |',
  )
  return lines.map((line) => {
    expect(line.endsWith(' |')).toBe(true)
    const cells = line.slice(2, -2).split(' | ')
    expect(cells).toHaveLength(5)
    const [step = '', , dependencies = '', flag = '', acceptance = ''] = cells
    return { step, dependencies: dependencies.split(', '), flag, acceptance }
  })
}

function assertPlan(document: string) {
  const rows = planRows(document)
  const names = rows.map((row) => row.step)
  expect(rows.length).toBeGreaterThan(1)
  expect(new Set(names).size).toBe(names.length)
  const closure = new Map<string, Set<string>>()
  rows.forEach((row, index) => {
    // Dependencies refer only to earlier rows.
    if (index === 0) expect(row.dependencies).toEqual(['Accepted design'])
    else
      for (const dependency of row.dependencies) expect(names.slice(0, index)).toContain(dependency)
    const reachable = new Set<string>()
    for (const dependency of row.dependencies) {
      reachable.add(dependency)
      for (const earlier of closure.get(dependency) ?? []) reachable.add(earlier)
    }
    closure.set(row.step, reachable)
    expect(row.acceptance).toMatch(/\. Off: \S/)
  })
  const last = rows.at(-1)
  expect(last?.flag).toBe(finalState)
  for (const [protocol, prerequisites] of Object.entries(settingPrerequisites)) {
    const states = rows.slice(0, -1).map((row) => {
      const match = row.flag.match(/^OIDC (.+); SAML (.+)$/)
      expect(match).not.toBeNull()
      const state = protocol === 'OIDC' ? match?.[1] : match?.[2]
      expect(protocolStates).toContain(state)
      return state
    })
    const introduced = states.indexOf('setting introduced (default false)')
    expect(introduced).toBeGreaterThan(0)
    expect(states.lastIndexOf('setting introduced (default false)')).toBe(introduced)
    expect(names[introduced]).toBe(`${protocol} setting`)
    expect(states.slice(0, introduced).every((state) => state === 'hard-off')).toBe(true)
    expect(states.slice(introduced + 1).every((state) => state === 'setting (default false)')).toBe(
      true,
    )
    const reachable = closure.get(`${protocol} setting`) ?? new Set<string>()
    for (const prerequisite of prerequisites) expect([...reachable]).toContain(prerequisite)
  }
  expect([...(closure.get('Enforcement policy') ?? [])]).toContain('Recovery enrollment')
}

function row(document: string, step: string) {
  const line = document.split('\n').find((candidate) => candidate.startsWith(`| ${step} | `))
  expect(line).toBeDefined()
  return line ?? ''
}

function replaceCell(document: string, step: string, cell: number, value: string) {
  const line = row(document, step)
  const cells = line.slice(2, -2).split(' | ')
  cells[cell] = value
  return document.replace(line, `| ${cells.join(' | ')} |`)
}

describe('SSO implementation plan ordering and rollout gating (documentation only)', () => {
  it('orders dependencies and keeps each protocol hard-off until its setting step', () => {
    assertPlan(source)
  })

  it.each([
    [
      'a setting introduced before recovery use',
      (document: string) =>
        replaceCell(
          replaceCell(document, 'OIDC setting', 3, 'OIDC setting (default false); SAML hard-off'),
          'Recovery use',
          3,
          'OIDC setting introduced (default false); SAML hard-off',
        ),
    ],
    [
      'a second setting introduction',
      (document: string) =>
        replaceCell(
          document,
          'Keycloak SAML acceptance',
          3,
          'OIDC setting (default false); SAML setting introduced (default false)',
        ),
    ],
    [
      'an undefined flag label',
      (document: string) => replaceCell(document, 'Drafts', 3, 'OIDC test-only opt-in; SAML off'),
    ],
    [
      'a dependency on a later row',
      (document: string) => replaceCell(document, 'Recovery enrollment', 2, 'Enforcement policy'),
    ],
    [
      'a setting that skips recovery and UI prerequisites',
      (document: string) => replaceCell(document, 'OIDC setting', 2, 'Recovery enrollment'),
    ],
    [
      'an acceptance cell without its off check',
      (document: string) => {
        const line = row(document, 'Domains')
        return document.replace(line, line.replace('. Off: ', '. '))
      },
    ],
    [
      'a final row that keeps the defaults false',
      (document: string) =>
        replaceCell(
          document,
          'Acceptance and defaults',
          3,
          'OIDC setting (default false); SAML setting (default false)',
        ),
    ],
  ])('rejects %s', (_, mutate) => {
    const mutated = mutate(source)
    expect(mutated).not.toBe(source)
    expect(() => assertPlan(mutated)).toThrow()
    assertPlan(source)
  })
})

function assertStableCodes(document: string) {
  const table =
    document.split('The stable domain codes are exactly:\n\n')[1]?.split('\n\n')[0] ?? ''
  const statuses = new Map(
    [...table.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \|/gm)].map(([, code, status]) => [
      code,
      status,
    ]),
  )
  const rows = table.split('\n').filter((line) => line.startsWith('| `'))
  expect(statuses.size).toBeGreaterThan(0)
  expect(statuses.size).toBe(rows.length)
  for (const required of ['sso_disabled', 'sso_reauthentication_required', 'sso_required'])
    expect(statuses.has(required)).toBe(true)
  // Every SSO code the design mentions anywhere must be defined in that table, and a
  // status written next to it must be the table's status.
  for (const [, status, code = ''] of document.matchAll(/`(?:(\d{3}) )?(sso_[a-z_]+)`/g)) {
    expect([...statuses.keys()]).toContain(code)
    if (status) expect(status).toBe(statuses.get(code))
  }
}

describe('SSO stable error codes (documentation only)', () => {
  it('defines every SSO code the design uses', () => {
    assertStableCodes(source)
  })

  it.each([
    'Refusals use `sso_recovery_missing`.',
    'Refusals use `409 sso_recovery_missing`.',
    'Refusals use `409 sso_disabled`.',
  ])('rejects an undefined or mismatched code: %s', (sentence) => {
    const mutated = source.replace(
      '## Out of scope and remaining decisions\n',
      `## Out of scope and remaining decisions\n\n${sentence}\n`,
    )
    expect(() => assertStableCodes(mutated)).toThrow()
    assertStableCodes(source)
  })

  it('rejects a removed code definition', () => {
    const removed = source.replace(/^\| `sso_disabled` \|.*\n/m, '')
    expect(removed).not.toBe(source)
    expect(() => assertStableCodes(removed)).toThrow()
    assertStableCodes(source)
  })
})
