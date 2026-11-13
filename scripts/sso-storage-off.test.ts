// SSO configuration and identity storage are tables only (docs/sso.md, Configuration storage
// and Identity storage): migrations 0074 and 0075, the generated table types and the storage
// test support exist, and no production module imports or queries the new tables, so no
// route, worker or read path uses them. The one other module that names them,
// apps/server/src/sso-storage-errors.ts, only recognises them in database errors so that the
// error log omits their row details; it imports nothing and performs no data access. OIDC
// and SAML stay hard-off (apps/server/src/sso.test.ts and sso-catalogues.test.ts). The scan
// is limited to the new table names; it never compares whole catalogues. The first step that
// reads or writes this storage from service code narrows it to the modules that own SSO data
// access.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url)
const rootPath = fileURLToPath(root)

// The storage layer: the migrations, the generated table types and the storage test support.
const STORAGE_LAYER =
  /^packages\/db\/(migrations\/|src\/tables\.ts$|src\/sso-(storage|identity)-[^/]+\.ts$)/
// Recognises the tables in database errors for the error log; never reads or writes them.
const ERROR_RECOGNISER = 'apps/server/src/sso-storage-errors.ts'
// A table name as a whole identifier in any case (PostgreSQL folds unquoted identifiers),
// its generated row type, or the storage test support. `sso_providers_guard` or
// `listSsoProviders` is not one, and neither is an import of the error recogniser.
const STORAGE_NAMES = new RegExp(
  `sso-storage(?!-errors\\.ts)|sso-identity-|(?<![A-Za-z0-9_])(?:${[
    // Configuration storage (0074).
    'sso_policies',
    'sso_providers',
    'sso_domains',
    'sso_provider_domains',
    'sso_recovery_nominations',
    'sso_recovery_owners',
    'SsoPolicies',
    'SsoProviders',
    'SsoDomains',
    'SsoProviderDomains',
    'SsoRecoveryNominations',
    'SsoRecoveryOwners',
    // Identity storage (0075).
    'sso_identity_links',
    'sso_attempts',
    'sso_mailbox_tokens',
    'sso_replay_cache',
    'sso_browser_proofs',
    'sso_delegation_bindings',
    'SsoIdentityLinks',
    'SsoAttempts',
    'SsoMailboxTokens',
    'SsoReplayCache',
    'SsoBrowserProofs',
    'SsoDelegationBindings',
  ].join('|')})(?![A-Za-z0-9_])`,
  'i',
)

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

describe('SSO configuration and identity storage are tables only', () => {
  it('recognises the new tables as whole identifiers, in any case', () => {
    for (const source of [
      "selectFrom('sso_providers')",
      'DELETE FROM "sso_domains"',
      'SELECT 1 FROM SSO_POLICIES',
      'from Sso_Recovery_Owners',
      "insertInto('sso_recovery_nominations')",
      'JOIN sso_provider_domains d',
      "import type { SsoProviders } from '@hourmere/db'",
      "import { ssoFixture } from './sso-storage-fixtures.ts'",
      "selectFrom('sso_identity_links')",
      'INSERT INTO SSO_ATTEMPTS',
      'DELETE FROM "sso_mailbox_tokens"',
      'from Sso_Replay_Cache',
      "updateTable('sso_browser_proofs')",
      'JOIN sso_delegation_bindings b',
      "import type { SsoDelegationBindings } from '@hourmere/db'",
      "import { identityFixture } from './sso-identity-fixtures.ts'",
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(true)
    for (const source of [
      'listSsoProviders',
      'list_sso_providers',
      'sso_providers_guard',
      'getSsoPolicy',
      'ssoOidcEnabled',
      'SSO_OIDC_ENABLED',
      '/api/v1/team/sso/providers',
      'sso_identity_links_guard',
      'linkSsoAccount',
      'bindSsoDelegation',
      'sso_attempts_kind',
      'ssoDelegationLifetime',
      "import { ssoStorageDiagnostic } from './sso-storage-errors.ts'",
    ])
      expect(STORAGE_NAMES.test(source), source).toBe(false)
  })

  it('keeps the SSO tables unreferenced outside the storage layer', () => {
    const sources = productionSources()
    expect(sources.length).toBeGreaterThan(100)
    expect(sources).toContain('apps/server/src/server.ts')
    expect(sources).toContain('apps/server/src/sso.ts')
    expect(sources).toContain('apps/server/src/sso-configuration.ts')
    expect(sources).toContain('packages/db/src/index.ts')
    const storage = sources.filter((file) => STORAGE_LAYER.test(file))
    // The matcher sees the storage layer itself, so a reference elsewhere cannot hide from it.
    expect(storage).toEqual(
      expect.arrayContaining([
        'packages/db/src/tables.ts',
        'packages/db/src/sso-storage-fixtures.ts',
        'packages/db/src/sso-identity-fixtures.ts',
        'packages/db/src/sso-identity-races.ts',
      ]),
    )
    const tables = readFileSync(new URL('packages/db/src/tables.ts', root), 'utf8')
    expect(tables).toMatch(/^ {2}sso_recovery_owners: SsoRecoveryOwners;$/m)
    expect(tables).toMatch(/^ {2}sso_delegation_bindings: SsoDelegationBindings;$/m)
    const referencing = sources
      .filter((file) => !STORAGE_LAYER.test(file) && file !== ERROR_RECOGNISER)
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
  })

  it('lets the error recogniser name the tables without any data access', () => {
    expect(productionSources()).toContain(ERROR_RECOGNISER)
    const recogniser = readFileSync(new URL(ERROR_RECOGNISER, root), 'utf8')
    // It does name them, so the exception is needed...
    expect(STORAGE_NAMES.test(recogniser)).toBe(true)
    // ...but imports nothing and has no query builder, SQL, driver or database handle.
    expect(recogniser).not.toMatch(/^\s*import\b|\bimport\(|\brequire\(/m)
    expect(recogniser).not.toMatch(
      /selectFrom|insertInto|updateTable|deleteFrom|\bsql\s*`|\.query\(|\bdb\.|\bpool\b/,
    )
  })
})
