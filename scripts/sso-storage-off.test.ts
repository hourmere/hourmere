// SSO configuration and identity storage (docs/sso.md, Configuration storage and Identity
// storage): migrations 0074 and 0075, the generated table types and the storage test support.
// The Mailbox proof module owns mailbox data access
// (apps/server/src/sso-mailbox-proof.ts): it reads and writes attempts and their mailbox tokens
// and reads providers, nothing else, and both of its endpoints answer `404 sso_disabled` while
// OIDC and SAML stay hard-off (apps/server/src/sso-mailbox-proof.test.ts). The fresh-proof
// gate owns attempts and reads policies for browser draft writes. The OIDC attempt module
// owns one-shot sign-in, draft test and self-link attempts and checks current providers.
// Self-link completion creates the caller's link after checking the frozen team and mailbox.
// Admission stages the signed identity, then checks proof, current trust and team admission.
// Departures use guarded SSO team and link lookups to capture mailbox tombstones.
// The OIDC adapter
// reads providers and its session transaction rechecks the link, policy and domain
// before writing browser proof. OIDC completion uses pending attempts and updates the
// proven mailbox on the link. Draft reads owns
// the provider/domain inventory, policies and opaque recovery link summaries, behind the same
// hard-off gate. The shared team proof service checks policy and live browser proof
// in every state. The invitation sender also joins the policy in its existing organization
// lookup before delivery. The provider test receipt query correlates the audit journal with the provider's current revision. The other module
// that names the tables, apps/server/src/sso-storage-errors.ts, only recognises them in
// database errors so that the error log omits their row details; it imports nothing and
// performs no data access. The scan is limited to the new table names; it never compares whole
// catalogues. Each later step that reads or writes this storage adds its module, and the tables
// it may name, to DATA_OWNERS.
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
// The production modules that own SSO data access, each with the only tables it may name.
const DATA_OWNERS: Readonly<Record<string, readonly string[]>> = {
  'apps/server/src/sso-domains.ts': ['sso_domains'],
  'apps/server/src/sso-domain-recheck.ts': ['sso_domains'],
  'apps/server/src/sso-domain-retirement.ts': [
    'sso_domains',
    'sso_domain_retirements',
    'sso_domain_retirement_notifications',
  ],
  'apps/server/src/sso-drafts.ts': [
    'sso_providers',
    'sso_provider_domains',
    'sso_domains',
    'sso_policies',
  ],
  'apps/server/src/sso-policy.ts': [
    'sso_policies',
    'sso_providers',
    'sso_domains',
    'sso_provider_domains',
  ],
  'apps/server/src/sso-mailbox-proof.ts': ['sso_attempts', 'sso_mailbox_tokens', 'sso_providers'],
  'apps/server/src/sso-me.ts': ['sso_attempts', 'sso_identity_links', 'sso_providers'],
  'packages/auth/src/team-sso.ts': [
    'sso_browser_proofs',
    'sso_domains',
    'sso_identity_links',
    'sso_policies',
    'sso_provider_domains',
    'sso_providers',
  ],
  'apps/server/src/sso-fresh-proof.ts': [
    'sso_attempts',
    'sso_identity_links',
    'sso_policies',
    'sso_providers',
  ],
  'apps/server/src/sso-oidc-admission-write.ts': [
    'sso_attempts',
    'sso_identity_links',
    'sso_policies',
  ],
  'apps/server/src/sso-oidc-admission.ts': ['sso_attempts', 'sso_providers'],
  'apps/server/src/sso-oidc-attempt.ts': [
    'sso_attempts',
    'sso_identity_links',
    'sso_policies',
    'sso_providers',
  ],
  'apps/server/src/sso-oidc-completion.ts': ['sso_attempts', 'sso_identity_links'],
  'apps/server/src/sso-oidc-link.ts': [
    'sso_attempts',
    'sso_domains',
    'sso_identity_links',
    'sso_provider_domains',
  ],
  'apps/server/src/sso-oidc-session.ts': [
    'sso_providers',
    'sso_policies',
    'sso_identity_links',
    'sso_domains',
    'sso_provider_domains',
    'sso_browser_proofs',
  ],
  'apps/server/src/sso-oidc-sign-in.ts': ['sso_providers'],
  'apps/server/src/sso-link-recovery.ts': [
    'sso_providers',
    'sso_identity_links',
    'sso_browser_proofs',
    'sso_delegation_bindings',
  ],
  'apps/server/src/sso-recovery-enrollment.ts': [
    'sso_policies',
    'sso_recovery_nominations',
    'sso_recovery_owners',
  ],
  'packages/auth/src/sso-recovery-membership.ts': ['sso_policies', 'sso_recovery_owners'],
  'apps/server/src/sso-delegation.ts': [
    'sso_attempts',
    'sso_delegation_bindings',
    'sso_domains',
    'sso_identity_links',
    'sso_policies',
    'sso_provider_domains',
    'sso_providers',
  ],
  'packages/auth/src/sso-delegation-summaries.ts': ['sso_policies'],
  'packages/auth/src/sso-delegation-access.ts': [
    'sso_delegation_bindings',
    'sso_domains',
    'sso_identity_links',
    'sso_policies',
    'sso_provider_domains',
    'sso_providers',
  ],
  'packages/auth/src/audit.ts': ['sso_delegation_bindings', 'sso_providers'],
  'apps/server/src/mcp/oauth.ts': ['sso_policies'],
  'apps/server/src/sso-oidc-test-receipts.ts': ['sso_providers'],
  'apps/server/src/sso-reads.ts': [
    'sso_providers',
    'sso_provider_domains',
    'sso_domains',
    'sso_identity_links',
    'sso_policies',
  ],
  'packages/notifications/src/invitation-sender.ts': ['sso_policies'],
  'packages/auth/src/sso-admission-blocks.ts': [
    'sso_identity_links',
    'sso_policies',
    'sso_providers',
  ],
}
// A table name as a whole identifier in any case (PostgreSQL folds unquoted identifiers),
// its generated row type, or the storage test support. `sso_providers_guard` or
// `listSsoProviders` is not one, and neither is an import of the error recogniser.
const STORAGE_TABLE_NAMES = [
  // Configuration storage (0074).
  'sso_domain_retirements',
  'sso_domain_retirement_notifications',
  'SsoDomainRetirements',
  'SsoDomainRetirementNotifications',
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
] as const
const whole = (names: readonly string[]) =>
  `(?<![A-Za-z0-9_])(?:${names.join('|')})(?![A-Za-z0-9_])`
const STORAGE_NAMES = new RegExp(
  `sso-storage(?!-errors\\.ts)|sso-identity-|${whole(STORAGE_TABLE_NAMES)}`,
  'i',
)
/** Every storage name in a source, lower case. */
function storageNamesIn(source: string): string[] {
  const names = new RegExp(
    `sso-storage(?!-errors\\.ts)|sso-identity-|${whole(STORAGE_TABLE_NAMES)}`,
    'gi',
  )
  return [...new Set([...source.matchAll(names)].map(([name]) => name.toLowerCase()))].sort()
}

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
      .filter((file) => !Object.hasOwn(DATA_OWNERS, file))
      .filter((file) => STORAGE_NAMES.test(readFileSync(new URL(file, root), 'utf8')))
    expect(referencing).toEqual([])
  })

  it('lets each data owner name only its own tables', () => {
    const sources = productionSources()
    for (const [file, tables] of Object.entries(DATA_OWNERS)) {
      expect(sources).toContain(file)
      const named = storageNamesIn(readFileSync(new URL(file, root), 'utf8'))
      // It does name them, so the exception is needed, and names nothing else.
      expect(named.length).toBeGreaterThan(0)
      expect(
        named.every((name) => tables.includes(name)),
        `${file}: ${named}`,
      ).toBe(true)
    }
    // The check sees a table that is not the owner's.
    expect(storageNamesIn("selectFrom('sso_browser_proofs') FROM sso_attempts")).toEqual([
      'sso_attempts',
      'sso_browser_proofs',
    ])
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
