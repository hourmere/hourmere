// The SSO transport profile exists with no SSO caller (docs/sso.md, Transport): no production
// module imports `packages/outbound/src/sso.ts`, and `SSO_PRIVATE_TARGETS` is parsed by the
// configuration loader and read by nothing else, so the allowlist routes nothing. OIDC and
// SAML stay hard-off (apps/server/src/sso.test.ts starts the server with both settings and a
// populated allowlist). The first step that calls the profile narrows this to its callers.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)
const PROFILE = 'packages/outbound/src/sso.ts'
const TARGETS = 'packages/outbound/src/sso-private-targets.ts'

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

describe('SSO transport has no caller while OIDC and SAML are hard-off', () => {
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

  it('imports the profile from no production module', () => {
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
    expect(callers).toEqual([])
  })

  it('reads SSO_PRIVATE_TARGETS only in the configuration loader, and routes nothing with it', () => {
    const sources = productionSources()
    const read = (file: string) => readFileSync(new URL(file, root), 'utf8')
    // Only the loader parses the setting; only the profile itself uses the matcher.
    expect(sources.filter((file) => importsTargets(file, read(file)))).toEqual([
      'apps/server/src/config.ts',
      PROFILE,
    ])
    expect(read('apps/server/src/config.ts')).toMatch(/^ {4}SSO_PRIVATE_TARGETS: optional\(/m)
    // No production code reads the parsed value, so nothing receives the allowlist.
    const access =
      /\??\.[ \t]*SSO_PRIVATE_TARGETS\b|\[[ \t]*['"`]SSO_PRIVATE_TARGETS['"`][ \t]*\]|\{[^}]*\bSSO_PRIVATE_TARGETS\b[^}]*\}\s*=/
    expect(access.test('config.SSO_PRIVATE_TARGETS')).toBe(true)
    expect(access.test("env['SSO_PRIVATE_TARGETS']")).toBe(true)
    expect(access.test('config?.SSO_PRIVATE_TARGETS')).toBe(true)
    expect(access.test('const { SSO_PRIVATE_TARGETS } = config')).toBe(true)
    expect(access.test('  SSO_PRIVATE_TARGETS: optional(z.string())')).toBe(false)
    expect(access.test('never team-editable.\n    SSO_PRIVATE_TARGETS: optional(')).toBe(false)
    expect(sources.filter((file) => access.test(read(file)))).toEqual([])
  })
})
