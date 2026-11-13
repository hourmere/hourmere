// The SSO audit actions exist with no emitter (docs/sso.md, Audit actions): their names, detail
// allow-lists and writers live in the audit journal module and its SSO catalogue, migration 0085
// checks their details, and no route, worker or service records one, because no SSO write path
// exists yet. OIDC and SAML stay hard-off (apps/server/src/sso.test.ts). The scan is limited to
// SSO action names and the SSO writers; it never freezes the rest of the audit catalogue. The
// first step that records an SSO action narrows it to the modules that write it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditDetails } from '../packages/db/src/audit.ts'
import { ssoAuditDetails } from '../packages/db/src/sso-audit.ts'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)

// The journal module, the SSO catalogue and their test support (protection suite, check reader).
const AUDIT_LAYER = new Set([
  'packages/db/src/audit.ts',
  'packages/db/src/sso-audit.ts',
  'packages/db/src/sso-audit-protections.ts',
  'packages/db/src/sso-audit-check-source.ts',
])
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

describe('SSO audit actions are defined but never recorded', () => {
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

  it('keeps every SSO action and writer inside the audit layer', () => {
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
      .filter((file) => !AUDIT_LAYER.has(file))
      .filter((file) => {
        const text = readFileSync(new URL(file, root), 'utf8')
        return (
          SSO_ACTION.test(text) ||
          SSO_WRITER.test(text) ||
          Object.keys(ssoAuditDetails).some((action) => text.includes(action))
        )
      })
    expect(referencing).toEqual([])
  })

  it('keeps the existing actions and the SSO actions apart', () => {
    const sso = Object.keys(ssoAuditDetails)
    expect(sso.every((action) => action.startsWith('sso_'))).toBe(true)
    expect(Object.keys(auditDetails).filter((action) => action.startsWith('sso_'))).toEqual([])
  })
})
