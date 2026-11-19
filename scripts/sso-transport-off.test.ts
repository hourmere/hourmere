// The SSO transport profile serves domain TXT proofs, OIDC documents and OIDC token exchange.
// Interactive writes, rechecks and sign-in are hard-off. Offline retirement removes trust.
// The configuration loader parses `SSO_PRIVATE_TARGETS` and server composition passes it
// to guarded OIDC sign-in, provider tests and self-link, so it routes nothing while OIDC
// is off. Production route tests assert those operations answer sso_disabled.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)
const PROFILE = 'packages/outbound/src/sso.ts'
const TARGETS = 'packages/outbound/src/sso-private-targets.ts'
const OIDC_ADMISSION_WRITE = 'apps/server/src/sso-oidc-admission-write.ts'
const OIDC_ADMISSION = 'apps/server/src/sso-oidc-admission.ts'
const OIDC_ATTEMPT = 'apps/server/src/sso-oidc-attempt.ts'
const OIDC_COMPLETION = 'apps/server/src/sso-oidc-completion.ts'
const OIDC_JWKS = 'apps/server/src/sso-oidc-jwks.ts'
const OIDC_LINK = 'apps/server/src/sso-oidc-link.ts'
const OIDC_SESSION = 'apps/server/src/sso-oidc-session.ts'
const OIDC_SIGN_IN = 'apps/server/src/sso-oidc-sign-in.ts'
const OIDC_TEST_RECEIPTS = 'apps/server/src/sso-oidc-test-receipts.ts'
const OIDC_VERIFIER = 'apps/server/src/sso-oidc-verifier.ts'
const OIDC_VERIFIER_MODULES = new Set([OIDC_ATTEMPT, OIDC_JWKS, OIDC_VERIFIER])

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

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)['"`]([^'"`]+)['"`]/g

/** Static, dynamic and re-export specifiers, resolved to repository paths or kept as bare. */
function imports(file: string, source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(([, specifier = '']) =>
    specifier.startsWith('.')
      ? relative(rootPath, resolve(dirname(join(rootPath, file)), specifier))
      : specifier,
  )
}

const importsProfile = (file: string, source: string) =>
  imports(file, source).some(
    (target) => target === PROFILE || /^@hourmere\/outbound\/sso(?:\.ts)?$/.test(target),
  )
const importsTargets = (file: string, source: string) =>
  imports(file, source).some(
    (target) => target === TARGETS || target === '@hourmere/outbound/sso-private-targets',
  )

describe('SSO transport permits only domain TXT and guarded OIDC ceremonies', () => {
  it('recognises every import form of the profile and nothing else', () => {
    const server = 'apps/server/src/example.ts'
    const outbound = 'packages/outbound/src/example.ts'
    for (const [file, source] of [
      [server, "import { sendSsoRequest } from '@hourmere/outbound/sso'"],
      [server, "const { sendSsoRequest } = await import('@hourmere/outbound/sso')"],
      [server, "export * from '@hourmere/outbound/sso'"],
      [server, "export { sendSsoRequest } from '@hourmere/outbound/sso'"],
      [server, "import '@hourmere/outbound/sso'"],
      [outbound, "import { sendSsoRequest } from './sso.ts'"],
      ['packages/outbound/src/nested/example.ts', "import { ssoUrl } from '../sso.ts'"],
      [server, "import { sendSsoRequest } from '../../../packages/outbound/src/sso.ts'"],
    ] as const)
      expect(importsProfile(file, source), source).toBe(true)
    for (const [file, source] of [
      // The hard-off guard is apps/server/src/sso.ts, a different module.
      [server, "import { requireSsoEnabled } from './sso.ts'"],
      [server, "import { parseSsoPrivateTargets } from '@hourmere/outbound/sso-private-targets'"],
      [server, "import { isPublicAddress } from '@hourmere/outbound'"],
      [outbound, "import { parseSsoPrivateTargets } from './sso-private-targets.ts'"],
    ] as const)
      expect(importsProfile(file, source), source).toBe(false)
  })

  it('imports the profile only for domain TXT, OIDC documents and code exchange', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    // The scan sees the profile, its package and the server, so a caller cannot hide.
    expect(sources).toEqual(
      expect.arrayContaining([
        PROFILE,
        TARGETS,
        'apps/server/src/server.ts',
        'apps/server/src/config.ts',
      ]),
    )
    expect(readFileSync(new URL(PROFILE, root), 'utf8')).toContain(
      'export async function sendSsoRequest',
    )
    const callers = sources.filter((file) =>
      importsProfile(file, readFileSync(new URL(file, root), 'utf8')),
    )
    const domainCallers = [
      'apps/server/src/sso-domain-recheck.ts',
      'apps/server/src/sso-domain-retirement.ts',
      'apps/server/src/sso-domains.ts',
    ]
    expect(callers).toEqual([...domainCallers, OIDC_JWKS, OIDC_SIGN_IN])
    for (const caller of domainCallers) {
      const domainSource = readFileSync(new URL(caller, root), 'utf8')
      expect(domainSource).toContain('resolveSsoDomainTxt')
      expect(domainSource).not.toContain('sendSsoRequest')
    }
    expect(readFileSync(new URL(OIDC_JWKS, root), 'utf8')).toContain('sendSsoRequest')
    expect(readFileSync(new URL(OIDC_SIGN_IN, root), 'utf8')).toContain('sendSsoRequest')
  })

  it('restricts OIDC verification dependencies to guarded ceremonies', () => {
    const sources = productionSources()
    expect(sources).toEqual(expect.arrayContaining([...OIDC_VERIFIER_MODULES]))
    const callers = sources
      .filter((file) => !OIDC_VERIFIER_MODULES.has(file))
      .flatMap((file) => {
        const helpers = imports(file, readFileSync(new URL(file, root), 'utf8'))
          .filter((target) => OIDC_VERIFIER_MODULES.has(target))
          .sort()
        return helpers.length ? [[file, helpers]] : []
      })
    expect(callers).toEqual([
      [OIDC_ADMISSION_WRITE, [OIDC_ATTEMPT]],
      [OIDC_ADMISSION, [OIDC_ATTEMPT]],
      [OIDC_COMPLETION, [OIDC_ATTEMPT]],
      [OIDC_LINK, [OIDC_ATTEMPT, OIDC_VERIFIER]],
      [OIDC_SESSION, [OIDC_ATTEMPT, OIDC_VERIFIER]],
      [OIDC_SIGN_IN, [OIDC_ATTEMPT, OIDC_JWKS, OIDC_VERIFIER]],
      [OIDC_TEST_RECEIPTS, [OIDC_ATTEMPT]],
    ])
  })

  it('parses SSO_PRIVATE_TARGETS in the loader and passes it only to guarded sign-in', () => {
    const sources = productionSources()
    const read = (file: string) => readFileSync(new URL(file, root), 'utf8')
    // Only the loader parses the setting; only the profile itself uses the matcher.
    expect(sources.filter((file) => importsTargets(file, read(file)))).toEqual([
      'apps/server/src/config.ts',
      PROFILE,
    ])
    expect(read('apps/server/src/config.ts')).toMatch(/^ {4}SSO_PRIVATE_TARGETS: optional\(/m)
    // The loader names it twice: its schema key and its error message. The server
    // passes it on once, and no other production module reads the setting.
    expect(sources.filter((file) => /\bSSO_PRIVATE_TARGETS\b/.test(read(file)))).toEqual([
      'apps/server/src/config.ts',
      'apps/server/src/server.ts',
      TARGETS,
      PROFILE,
    ])
    expect(read('apps/server/src/config.ts').match(/\bSSO_PRIVATE_TARGETS\b/g)).toHaveLength(2)
    expect(read('apps/server/src/server.ts').match(/\bSSO_PRIVATE_TARGETS\b/g)).toHaveLength(1)
  })
})
