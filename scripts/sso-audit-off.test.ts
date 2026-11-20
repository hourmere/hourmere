// SSO audit storage owns the action catalogue. Each operation may emit only its own
// actions. A new writer requires an explicit owner entry.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditDetails } from '../packages/db/src/audit.ts'
import { SSO_SECURITY_FAILURE_ACTIONS, ssoAuditDetails } from '../packages/db/src/sso-audit.ts'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)

// The journal module, the SSO catalogue and their test support (protection suite, check reader).
const AUDIT_LAYER = new Set([
  'packages/db/src/audit.ts',
  'packages/db/src/sso-audit.ts',
  'packages/db/src/sso-audit-protections.ts',
  'packages/db/src/sso-audit-check-source.ts',
])
const EMITTERS: Readonly<Record<string, readonly string[]>> = {
  'apps/server/src/sso-policy.ts': [
    'sso_enforcement.enabled',
    'sso_enforcement.disabled',
    'sso_enforcement.updated',
  ],
  'apps/server/src/sso-recovery-enrollment.ts': ['sso_recovery.nominated', 'sso_recovery.enrolled'],
  'apps/server/src/sso-recovery-use.ts': ['sso_recovery.used'],
  'packages/auth/src/sso-recovery-membership.ts': ['sso_recovery.removed'],
  'packages/auth/src/audit.ts': ['sso_delegation.revoked'],
  'apps/server/src/sso-delegation.ts': ['sso_delegation.bound', 'sso_delegation.revoked'],
  'apps/server/src/sso-domain-retirement.ts': ['sso_maintenance.domain_retired'],
  'apps/server/src/sso-operator-recovery.ts': ['sso_maintenance.enforcement_disabled'],
  'apps/server/src/sso-domain-recheck.ts': ['sso_domain.renewed', 'sso_domain.expired'],
  'apps/server/src/sso-domains.ts': [
    'sso_domain.challenged',
    'sso_domain.verified',
    'sso_domain.renewed',
    'sso_domain.released',
  ],
  'apps/server/src/sso-drafts.ts': [
    'sso_provider.created',
    'sso_provider.updated',
    'sso_provider.enabled',
    'sso_provider.disabled',
    'sso_provider.deleted',
    'sso_provider.secret_rotated',
  ],
  'apps/server/src/sso-oidc-admission-write.ts': [
    'sso_jit.admitted',
    'sso_jit.refused',
    'sso_link.linked',
  ],
  'apps/server/src/sso-oidc-link.ts': ['sso_link.linked', 'sso_link.conflicted'],
  'apps/server/src/sso-link-recovery.ts': ['sso_link.unlinked'],
  'apps/server/src/sso-oidc-session.ts': ['sso_authentication.succeeded'],
  'apps/server/src/sso-oidc-sign-in.ts': [
    'sso_authentication.failed',
    'sso_authentication.replay_rejected',
  ],
  'apps/server/src/sso-oidc-test-receipts.ts': ['sso_provider.tested'],
}
// An SSO action name as a string literal, whether or not the catalogue lists it.
const SSO_ACTION = /['"`]sso_[a-z_]+\.[a-z_]+['"`]/
// The SSO writers and the catalogue module, by name or import.
const SSO_WRITER =
  /\b(?:writeSsoAuditEvent|writeSsoSecurityFailure|redactSsoSecurityFailure)\b|sso-audit(?:-[a-z-]+)?(?:\.ts)?['"`]/

/** Every non-test source file in the src directory of each apps, packages and tools workspace. */
function productionSources(): string[] {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
        files.push(relative(rootPath, path))
    }
  }
  for (const group of ['apps', 'packages', 'tools'])
    for (const name of readdirSync(new URL(group, root))) {
      const source = new URL(`${group}/${name}/src`, root)
      try {
        if (statSync(source).isDirectory()) walk(fileURLToPath(source))
      } catch {
        // Not a workspace with sources.
      }
    }
  return files.sort()
}

describe('SSO audit actions have explicit guarded emitters', () => {
  it('recognises SSO action names and writers, and nothing else', () => {
    for (const source of [
      "action: 'sso_provider.created'",
      'action: "sso_jit.refused"',
      'const action = `sso_link.linked`',
      "'sso_maintenance.key_rotated'",
      "'sso_unlisted.something'",
    ])
      expect(SSO_ACTION.test(source), source).toBe(true)
    for (const source of [
      "selectFrom('sso_providers')",
      "'sso_attempts_kind'",
      "'scim_token.created'",
      "requireSsoEnabled(capabilities, 'oidc')",
      "code: 'sso_disabled'",
    ])
      expect(SSO_ACTION.test(source), source).toBe(false)
    for (const source of [
      'await writeSsoAuditEvent(trx, event)',
      'writeSsoSecurityFailure(db, failure)',
      "import { ssoAuditDetails } from '@hourmere/db/src/sso-audit.ts'",
      "from './sso-audit'",
      "import { ssoAuditTestId } from '../../db/src/sso-audit-protections.ts'",
    ])
      expect(SSO_WRITER.test(source), source).toBe(true)
    for (const source of ['writeAuditEvent(trx, event)', "from './sso-storage-errors.ts'"])
      expect(SSO_WRITER.test(source), source).toBe(false)
  })

  it('keeps every SSO action and writer inside the audit layer or its explicit emitter', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    const layer = sources.filter((file) => AUDIT_LAYER.has(file))
    expect(layer).toEqual(
      expect.arrayContaining(['packages/db/src/audit.ts', 'packages/db/src/sso-audit.ts']),
    )
    // The matchers see the layer itself, so a reference elsewhere cannot hide from them.
    const catalogue = readFileSync(new URL('packages/db/src/sso-audit.ts', root), 'utf8')
    expect(SSO_ACTION.test(catalogue)).toBe(true)
    const journal = readFileSync(new URL('packages/db/src/audit.ts', root), 'utf8')
    expect(SSO_WRITER.test(journal)).toBe(true)
    const referencing = sources
      .filter((file) => !AUDIT_LAYER.has(file) && !Object.hasOwn(EMITTERS, file))
      .filter((file) => {
        const text = readFileSync(new URL(file, root), 'utf8')
        return (
          SSO_ACTION.test(text) ||
          SSO_WRITER.test(text) ||
          Object.keys(ssoAuditDetails).some((action) => text.includes(action))
        )
      })
    expect(referencing).toEqual([])
    const securityFailures = new Set<string>(SSO_SECURITY_FAILURE_ACTIONS)
    for (const [file, actions] of Object.entries(EMITTERS)) {
      expect(sources).toContain(file)
      const source = readFileSync(new URL(file, root), 'utf8')
      const named = [...source.matchAll(/['"`]sso_[a-z_]+\.[a-z_]+['"`]/g)].map(([name]) =>
        name.slice(1, -1),
      )
      expect([...new Set(named)].sort()).toEqual([...actions].sort())
      expect(/\bwriteSsoAuditEvent\b/.test(source), file).toBe(
        actions.some((action) => !securityFailures.has(action)),
      )
      expect(/\bwriteSsoSecurityFailure\b/.test(source), file).toBe(
        actions.some((action) => securityFailures.has(action)),
      )
      expect(source).not.toMatch(/\bredactSsoSecurityFailure\b/)
    }
  })

  it('keeps the existing actions and the SSO actions apart', () => {
    const sso = Object.keys(ssoAuditDetails)
    expect(sso.every((action) => action.startsWith('sso_'))).toBe(true)
    expect(Object.keys(auditDetails).filter((action) => action.startsWith('sso_'))).toEqual([])
  })
})
