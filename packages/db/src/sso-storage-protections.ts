// Every constraint, index, trigger and trigger rule of migration 0074, each with a check
// that passes on the migration as written and the source-copy mutations that remove or
// weaken it. sso-storage.test.ts runs every check against the real schema and requires the
// table to name every object the migration creates; sso-storage-mutations.test.ts applies
// each mutation to the predecessor schema and requires its check to fail; and
// sso-storage-coverage.test.ts drops each object through checkConstraintCoverage.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import {
  accepted,
  at,
  claimedDomainValues,
  count,
  digest,
  domainName,
  inRolledBackTransaction,
  insert,
  insertAccepted,
  insertedRow,
  insertRefused,
  lapsedDomainValues,
  nominationValues,
  oidcProviderValues,
  pendingDomainValues,
  policyValues,
  recoveryOwnerValues,
  refused,
  type SsoFixture,
  type SsoTable,
  samlProviderValues,
  sealed,
  ssoFixture,
  updateAccepted,
  updateRefused,
} from './sso-storage-fixtures.ts'
import { checkActiveClaimRace } from './sso-storage-races.ts'

export interface SsoMutant {
  name: string
  apply: (source: string) => string
}
export interface SsoProtection {
  /** Catalog objects (constraints, unique indexes, triggers) and trigger rules it covers. */
  objects: string[]
  check: (f: SsoFixture) => Promise<void>
  mutants: SsoMutant[]
}

const violation = (constraint: string) => ({ code: '23514', constraint })
const duplicate = (constraint: string) => ({ code: '23505', constraint })
const foreignKey = { code: '23503' }

function replaceOnce(source: string, search: string, replacement: string) {
  const parts = source.split(search)
  if (parts.length !== 2) throw new Error(`Expected one occurrence of ${search}`)
  return parts.join(replacement)
}
const append = (name: string, sql: string): SsoMutant => ({
  name,
  apply: (source) => `${source}\n${sql}\n`,
})
const dropConstraint = (table: string, name: string, cascade = false) =>
  append(
    `drop ${name}`,
    `ALTER TABLE ${table} DROP CONSTRAINT ${name}${cascade ? ' CASCADE' : ''};`,
  )
const dropIndex = (name: string) => append(`drop ${name}`, `DROP INDEX ${name};`)
const dropTrigger = (table: string, name: string) =>
  append(`drop ${name}`, `DROP TRIGGER ${name} ON ${table};`)
const edit = (name: string, search: string, replacement: string): SsoMutant => ({
  name,
  apply: (source) => replaceOnce(source, search, replacement),
})
/** Replaces text inside one function's body only, where other functions repeat it. */
const editFunction = (fn: string, name: string, search: string, replacement: string) => ({
  name,
  apply: (source: string) => {
    const start = source.indexOf(`CREATE FUNCTION ${fn}(`)
    const end = source.indexOf('END $$;', start)
    if (start < 0 || end < 0) throw new Error(`Missing function ${fn}`)
    return (
      source.slice(0, start) +
      replaceOnce(source.slice(start, end), search, replacement) +
      source.slice(end)
    )
  },
})
const neverRaise = (name: string, condition: string) =>
  edit(name, `IF ${condition} THEN`, 'IF false THEN')

const provider = (f: SsoFixture, organization = f.team) =>
  insert(f.db, 'sso_providers', oidcProviderValues(organization))
const domain = (f: SsoFixture, values = claimedDomainValues(f.team)) =>
  insert(f.db, 'sso_domains', values)
const byId = (row: Record<string, unknown>) => ({ id: row.id })
const nextGeneration = (row: Record<string, unknown>) => ({
  generation: (row.generation as number) + 1,
  challenge_digest: digest(),
  challenge_expires_at: at(86_400),
  verified_at: null,
  verification_expires_at: null,
})

const policyProtections: Record<string, SsoProtection> = {
  'one policy per team': {
    objects: ['sso_policies_pkey', 'sso_policies_organization_id_not_null'],
    check: async (f) => {
      await insertAccepted(f.db, 'sso_policies', policyValues(f.team))
      await insertRefused(
        f.db,
        'sso_policies',
        policyValues(f.team),
        duplicate('sso_policies_pkey'),
      )
    },
    mutants: [dropConstraint('sso_policies', 'sso_policies_pkey')],
  },
  'policy belongs to an existing organization and goes with it': {
    objects: ['sso_policies_organization_id_fkey'],
    check: async (f) => {
      await insertRefused(f.db, 'sso_policies', policyValues(randomUUID()), foreignKey)
      await insert(f.db, 'sso_policies', policyValues(f.team))
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, 'sso_policies', { organization_id: f.team })).toBe(0)
    },
    mutants: [dropConstraint('sso_policies', 'sso_policies_organization_id_fkey')],
  },
  'admission is invitation-only or JIT': {
    objects: ['sso_policies_admission'],
    check: async (f) => {
      await insertAccepted(f.db, 'sso_policies', { ...policyValues(f.team), admission: 'jit' })
      await insertAccepted(f.db, 'sso_policies', {
        ...policyValues(f.otherTeam),
        admission: 'invitation_only',
      })
      for (const admission of ['open', 'JIT', 'domain'])
        await insertRefused(
          f.db,
          'sso_policies',
          { organization_id: randomUUID(), admission },
          violation('sso_policies_admission'),
        )
    },
    mutants: [
      dropConstraint('sso_policies', 'sso_policies_admission'),
      edit(
        'admission also accepts open',
        "admission IN ('invitation_only', 'jit')",
        "admission IN ('invitation_only', 'jit', 'open')",
      ),
    ],
  },
  'policy revision and trust generation are positive': {
    objects: ['sso_policies_policy_revision', 'sso_policies_trust_generation'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_policies',
        { ...policyValues(f.team), policy_revision: 0 },
        violation('sso_policies_policy_revision'),
      )
      await insertRefused(
        f.db,
        'sso_policies',
        { ...policyValues(f.team), trust_generation: 0 },
        violation('sso_policies_trust_generation'),
      )
    },
    mutants: [
      dropConstraint('sso_policies', 'sso_policies_policy_revision'),
      dropConstraint('sso_policies', 'sso_policies_trust_generation'),
    ],
  },
  'policy ownership is immutable': {
    objects: ['sso_policies_guard', 'sso_policies_identity_immutable'],
    check: async (f) => {
      await insert(f.db, 'sso_policies', policyValues(f.team))
      const where = { organization_id: f.team }
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { organization_id: f.otherTeam },
        violation('sso_policies_identity_immutable'),
      )
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { created_at: at(-60) },
        violation('sso_policies_identity_immutable'),
      )
    },
    mutants: [
      dropTrigger('sso_policies', 'sso_policies_guard'),
      neverRaise(
        'policy identity may change',
        'ROW(NEW.organization_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.organization_id, OLD.created_at)',
      ),
    ],
  },
  'policy revision and trust generation never decrease': {
    objects: ['sso_policies_counters_monotonic'],
    check: async (f) => {
      await insert(f.db, 'sso_policies', {
        ...policyValues(f.team),
        policy_revision: 3,
        trust_generation: 3,
      })
      const where = { organization_id: f.team }
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { policy_revision: 2 },
        violation('sso_policies_counters_monotonic'),
      )
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { trust_generation: 2 },
        violation('sso_policies_counters_monotonic'),
      )
      await updateAccepted(f.db, 'sso_policies', where, { policy_revision: 4, trust_generation: 4 })
    },
    mutants: [
      neverRaise(
        'counters may decrease',
        'NEW.policy_revision < OLD.policy_revision OR NEW.trust_generation < OLD.trust_generation',
      ),
      edit(
        'trust generation may decrease',
        'IF NEW.policy_revision < OLD.policy_revision OR NEW.trust_generation < OLD.trust_generation THEN',
        'IF NEW.policy_revision < OLD.policy_revision THEN',
      ),
      edit(
        'policy revision may decrease',
        'IF NEW.policy_revision < OLD.policy_revision OR NEW.trust_generation < OLD.trust_generation THEN',
        'IF NEW.trust_generation < OLD.trust_generation THEN',
      ),
    ],
  },
  'a policy change takes a new policy revision': {
    objects: ['sso_policies_revision_required'],
    check: async (f) => {
      await insert(f.db, 'sso_policies', policyValues(f.team))
      const where = { organization_id: f.team }
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { admission: 'jit' },
        violation('sso_policies_revision_required'),
      )
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { require_sso: true },
        violation('sso_policies_revision_required'),
      )
      await updateAccepted(f.db, 'sso_policies', where, { admission: 'jit', policy_revision: 2 })
      // Recovery-state changes take a new policy revision without a policy change.
      await updateAccepted(f.db, 'sso_policies', where, { policy_revision: 3 })
    },
    mutants: [
      neverRaise(
        'policy may change in place',
        'ROW(NEW.require_sso, NEW.admission) IS DISTINCT FROM ROW(OLD.require_sso, OLD.admission)\n     AND NEW.policy_revision = OLD.policy_revision',
      ),
      edit(
        'admission may change in place',
        'ROW(NEW.require_sso, NEW.admission) IS DISTINCT FROM ROW(OLD.require_sso, OLD.admission)',
        'NEW.require_sso IS DISTINCT FROM OLD.require_sso',
      ),
    ],
  },
  'turning enforcement off takes a new trust generation': {
    objects: ['sso_policies_enforcement_off_generation'],
    check: async (f) => {
      await insert(f.db, 'sso_policies', { ...policyValues(f.team), require_sso: true })
      const where = { organization_id: f.team }
      await updateRefused(
        f.db,
        'sso_policies',
        where,
        { require_sso: false, policy_revision: 2 },
        violation('sso_policies_enforcement_off_generation'),
      )
      await updateAccepted(f.db, 'sso_policies', where, {
        require_sso: false,
        policy_revision: 2,
        trust_generation: 2,
      })
      // Turning it on keeps the generation: unchanged providers' proofs already qualify.
      await updateAccepted(f.db, 'sso_policies', where, { require_sso: true, policy_revision: 3 })
    },
    mutants: [
      neverRaise(
        'enforcement may turn off without a new generation',
        'OLD.require_sso AND NOT NEW.require_sso AND NEW.trust_generation = OLD.trust_generation',
      ),
    ],
  },
}

const providerProtections: Record<string, SsoProtection> = {
  'provider IDs are unique across teams': {
    objects: ['sso_providers_pkey', 'sso_providers_id_not_null'],
    check: async (f) => {
      const id = randomUUID()
      await insert(f.db, 'sso_providers', { ...oidcProviderValues(f.team), id })
      await insertRefused(
        f.db,
        'sso_providers',
        { ...oidcProviderValues(f.otherTeam), id },
        duplicate('sso_providers_pkey'),
      )
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_pkey')],
  },
  'provider belongs to an existing organization and goes with it': {
    objects: ['sso_providers_organization_id_fkey'],
    check: async (f) => {
      await insertRefused(f.db, 'sso_providers', oidcProviderValues(randomUUID()), foreignKey)
      await provider(f)
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, 'sso_providers', { organization_id: f.team })).toBe(0)
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_organization_id_fkey')],
  },
  'protocol is OIDC or SAML': {
    objects: ['sso_providers_protocol'],
    check: async (f) => {
      await insertAccepted(f.db, 'sso_providers', oidcProviderValues(f.team))
      await insertAccepted(f.db, 'sso_providers', samlProviderValues(f.team))
      for (const protocol of ['ldap', 'SAML', 'cas'])
        await insertRefused(
          f.db,
          'sso_providers',
          { ...samlProviderValues(f.team), protocol },
          violation('sso_providers_protocol'),
        )
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_protocol')],
  },
  'provider names and identities are bounded and nonempty': {
    objects: ['sso_providers_text'],
    check: async (f) => {
      await insertAccepted(f.db, 'sso_providers', {
        ...oidcProviderValues(f.team),
        display_name: 'n'.repeat(100),
        issuer: `https://${'i'.repeat(2040)}`,
        client_id: 'c'.repeat(1024),
      })
      for (const values of [
        { display_name: '' },
        { display_name: 'n'.repeat(101) },
        { issuer: '' },
        { issuer: `https://${'i'.repeat(2041)}` },
        { client_id: '' },
        { client_id: 'c'.repeat(1025) },
      ])
        await insertRefused(
          f.db,
          'sso_providers',
          { ...oidcProviderValues(f.team), ...values },
          violation('sso_providers_text'),
        )
    },
    mutants: [
      dropConstraint('sso_providers', 'sso_providers_text'),
      edit(
        'display names may be empty',
        'char_length(display_name) BETWEEN 1 AND 100',
        'char_length(display_name) BETWEEN 0 AND 100',
      ),
      edit('client IDs are unbounded', '\n    AND char_length(client_id) BETWEEN 1 AND 1024', ''),
    ],
  },
  'OIDC has a client ID and SAML has none': {
    objects: ['sso_providers_protocol_identity'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_providers',
        { ...oidcProviderValues(f.team), client_id: null },
        violation('sso_providers_protocol_identity'),
      )
      await insertRefused(
        f.db,
        'sso_providers',
        { ...samlProviderValues(f.team), client_id: 'client' },
        violation('sso_providers_protocol_identity'),
      )
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_protocol_identity')],
  },
  'configuration is stored only as a sealed envelope': {
    objects: ['sso_providers_configuration_envelope'],
    check: async (f) => {
      const plaintext = Buffer.from(
        JSON.stringify({ clientSecret: 'synthetic plaintext secret, never stored', x: 'y' }),
      )
      const versionTwo = Buffer.concat([Buffer.from([2]), sealed().subarray(1)])
      for (const configuration of [plaintext, versionTwo, sealed().subarray(0, 29)])
        await insertRefused(
          f.db,
          'sso_providers',
          { ...oidcProviderValues(f.team), configuration },
          violation('sso_providers_configuration_envelope'),
        )
      await insertAccepted(f.db, 'sso_providers', {
        ...oidcProviderValues(f.team),
        configuration: sealed().subarray(0, 30),
      })
    },
    mutants: [
      dropConstraint('sso_providers', 'sso_providers_configuration_envelope'),
      edit(
        'any version byte',
        'octet_length(configuration) >= 30 AND get_byte(configuration, 0) = 1',
        'octet_length(configuration) >= 30',
      ),
      edit(
        'short envelopes',
        'octet_length(configuration) >= 30 AND get_byte(configuration, 0) = 1',
        'octet_length(configuration) >= 1 AND get_byte(configuration, 0) = 1',
      ),
    ],
  },
  'provider revisions are positive': {
    objects: ['sso_providers_revision'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_providers',
        { ...oidcProviderValues(f.team), revision: 0 },
        violation('sso_providers_revision'),
      )
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_revision')],
  },
  'a retired provider is disabled': {
    objects: ['sso_providers_retired_disabled'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_providers',
        { ...oidcProviderValues(f.team), enabled: true, retired_at: at(-60) },
        violation('sso_providers_retired_disabled'),
      )
      const row = await insert(f.db, 'sso_providers', {
        ...oidcProviderValues(f.team),
        enabled: true,
      })
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { retired_at: at(0) },
        violation('sso_providers_retired_disabled'),
      )
      await updateAccepted(f.db, 'sso_providers', byId(row), {
        retired_at: at(0),
        enabled: false,
      })
    },
    mutants: [dropConstraint('sso_providers', 'sso_providers_retired_disabled')],
  },
  'a provider serves only its own team’s domains': {
    objects: [
      'sso_providers_organization_id_id',
      'sso_domains_organization_id_id',
      'sso_provider_domains_provider',
      'sso_provider_domains_domain',
    ],
    check: async (f) => {
      const own = await provider(f)
      const other = await provider(f, f.otherTeam)
      const ownDomain = await domain(f)
      const otherDomain = await domain(f, claimedDomainValues(f.otherTeam))
      const link = (organization: string, providerId: unknown, domainId: unknown) => ({
        organization_id: organization,
        provider_id: providerId,
        domain_id: domainId,
      })
      await insertRefused(
        f.db,
        'sso_provider_domains',
        link(f.team, other.id, ownDomain.id),
        foreignKey,
      )
      await insertRefused(
        f.db,
        'sso_provider_domains',
        link(f.team, own.id, otherDomain.id),
        foreignKey,
      )
      await insertRefused(
        f.db,
        'sso_provider_domains',
        link(f.otherTeam, own.id, ownDomain.id),
        foreignKey,
      )
      await insertAccepted(f.db, 'sso_provider_domains', link(f.team, own.id, ownDomain.id))
      await insertAccepted(
        f.db,
        'sso_provider_domains',
        link(f.otherTeam, other.id, otherDomain.id),
      )
      // Providers and claims go only with their team, and their links with them.
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, 'sso_provider_domains', { organization_id: f.team })).toBe(0)
      expect(await count(f.db, 'sso_provider_domains', { organization_id: f.otherTeam })).toBe(1)
    },
    mutants: [
      dropConstraint('sso_providers', 'sso_providers_organization_id_id', true),
      dropConstraint('sso_domains', 'sso_domains_organization_id_id', true),
      dropConstraint('sso_provider_domains', 'sso_provider_domains_provider'),
      dropConstraint('sso_provider_domains', 'sso_provider_domains_domain'),
      // One cascade alone still removes the links when the team goes: each side is deleted
      // only with the organization. Both missing blocks the team's deletion.
      {
        name: 'the links do not cascade',
        apply: (source: string) =>
          source
            .replace(
              'REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE',
              'REFERENCES sso_providers (organization_id, id)',
            )
            .replace(
              'REFERENCES sso_domains (organization_id, id) ON DELETE CASCADE',
              'REFERENCES sso_domains (organization_id, id)',
            ),
      },
    ],
  },
  'a domain is linked to a provider once': {
    objects: [
      'sso_provider_domains_pkey',
      'sso_provider_domains_provider_id_not_null',
      'sso_provider_domains_domain_id_not_null',
    ],
    check: async (f) => {
      const values = {
        organization_id: f.team,
        provider_id: (await provider(f)).id,
        domain_id: (await domain(f)).id,
      }
      await insertAccepted(f.db, 'sso_provider_domains', values)
      await insertRefused(
        f.db,
        'sso_provider_domains',
        values,
        duplicate('sso_provider_domains_pkey'),
      )
    },
    mutants: [dropConstraint('sso_provider_domains', 'sso_provider_domains_pkey')],
  },
  'provider identity is immutable': {
    objects: ['sso_providers_guard', 'sso_providers_identity_immutable'],
    check: async (f) => {
      const row = await provider(f)
      for (const values of [
        { issuer: 'https://login.example.test/other/v2.0' },
        { client_id: 'another-client' },
        { protocol: 'saml', client_id: null },
        { organization_id: f.otherTeam },
        { id: randomUUID() },
        { created_at: at(-60) },
      ])
        await updateRefused(
          f.db,
          'sso_providers',
          byId(row),
          { ...values, revision: 2, configuration: sealed() },
          violation('sso_providers_identity_immutable'),
        )
      await updateAccepted(f.db, 'sso_providers', byId(row), {
        display_name: 'Renamed',
        revision: 2,
        configuration: sealed(),
      })
    },
    mutants: [
      dropTrigger('sso_providers', 'sso_providers_guard'),
      edit(
        'the issuer may change',
        'ROW(NEW.id, NEW.organization_id, NEW.protocol, NEW.issuer, NEW.client_id, NEW.created_at)',
        'ROW(NEW.id, NEW.organization_id, NEW.protocol, OLD.issuer, NEW.client_id, NEW.created_at)',
      ),
      edit(
        'the client ID may change',
        'ROW(NEW.id, NEW.organization_id, NEW.protocol, NEW.issuer, NEW.client_id, NEW.created_at)',
        'ROW(NEW.id, NEW.organization_id, NEW.protocol, NEW.issuer, OLD.client_id, NEW.created_at)',
      ),
    ],
  },
  'provider revisions never decrease': {
    objects: ['sso_providers_revision_monotonic'],
    check: async (f) => {
      const row = await insert(f.db, 'sso_providers', {
        ...oidcProviderValues(f.team),
        revision: 3,
      })
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { revision: 2 },
        violation('sso_providers_revision_monotonic'),
      )
    },
    mutants: [neverRaise('revisions may decrease', 'NEW.revision < OLD.revision')],
  },
  'a new provider revision and a new sealed configuration go together': {
    objects: ['sso_providers_revision_sealed'],
    check: async (f) => {
      const row = await provider(f)
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { configuration: sealed() },
        violation('sso_providers_revision_sealed'),
      )
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { revision: 2 },
        violation('sso_providers_revision_sealed'),
      )
      await updateAccepted(f.db, 'sso_providers', byId(row), {
        revision: 2,
        configuration: sealed(),
      })
      // Activation and naming keep the revision and its sealed configuration.
      await updateAccepted(f.db, 'sso_providers', byId(row), {
        enabled: true,
        display_name: 'Renamed',
      })
    },
    mutants: [
      neverRaise(
        'revision and configuration may change separately',
        '(NEW.revision > OLD.revision) <> (NEW.configuration IS DISTINCT FROM OLD.configuration)',
      ),
      edit(
        'a new revision may keep the old ciphertext',
        'IF (NEW.revision > OLD.revision) <> (NEW.configuration IS DISTINCT FROM OLD.configuration) THEN',
        'IF NEW.configuration IS DISTINCT FROM OLD.configuration AND NEW.revision = OLD.revision THEN',
      ),
      edit(
        'the configuration may change in place',
        'IF (NEW.revision > OLD.revision) <> (NEW.configuration IS DISTINCT FROM OLD.configuration) THEN',
        'IF NEW.revision > OLD.revision AND NEW.configuration IS NOT DISTINCT FROM OLD.configuration THEN',
      ),
    ],
  },
  'a retired provider is permanent': {
    objects: ['sso_providers_retired_permanent'],
    check: async (f) => {
      const row = await insert(f.db, 'sso_providers', {
        ...oidcProviderValues(f.team),
        retired_at: at(-60),
      })
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { retired_at: null },
        violation('sso_providers_retired_permanent'),
      )
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { display_name: 'Revived' },
        violation('sso_providers_retired_permanent'),
      )
      await updateRefused(
        f.db,
        'sso_providers',
        byId(row),
        { revision: 2, configuration: sealed() },
        violation('sso_providers_retired_permanent'),
      )
      // Repeating the retirement changes nothing and succeeds.
      await updateAccepted(f.db, 'sso_providers', byId(row), { retired_at: row.retired_at })
    },
    mutants: [
      editFunction(
        'guard_sso_provider',
        'retired providers may change',
        'IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN',
        'IF false THEN',
      ),
    ],
  },
}

const domainProtections: Record<string, SsoProtection> = {
  'domain claim IDs are unique across teams': {
    objects: ['sso_domains_pkey', 'sso_domains_id_not_null'],
    check: async (f) => {
      const id = randomUUID()
      await insert(f.db, 'sso_domains', { ...pendingDomainValues(f.team), id })
      await insertRefused(
        f.db,
        'sso_domains',
        { ...pendingDomainValues(f.otherTeam), id },
        duplicate('sso_domains_pkey'),
      )
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_pkey')],
  },
  'domain claim belongs to an existing organization and goes with it': {
    objects: ['sso_domains_organization_id_fkey'],
    check: async (f) => {
      await insertRefused(f.db, 'sso_domains', pendingDomainValues(randomUUID()), foreignKey)
      await domain(f)
      await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect(await count(f.db, 'sso_domains', { organization_id: f.team })).toBe(0)
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_organization_id_fkey')],
  },
  'domain names are exact lowercase IDNA ASCII DNS names': {
    objects: ['sso_domains_name'],
    check: async (f) => {
      const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
      for (const name of [
        'example.com',
        'mail.example.co.uk',
        'xn--bcher-kva.example',
        'a-b.example.xn--p1ai',
        '1password.example',
        longest,
      ])
        await insertAccepted(f.db, 'sso_domains', pendingDomainValues(f.team, name))
      for (const name of [
        'Example.com',
        'EXAMPLE.COM',
        '*.example.com',
        'example.com.',
        '.example.com',
        'example..com',
        'localhost',
        '192.168.10.20',
        '10.0.0.1',
        'exa_mple.com',
        '-a.example.com',
        'a-.example.com',
        'bücher.example',
        ' example.com',
        `${'a'.repeat(64)}.example`,
        `${longest.slice(0, -1)}dd`,
        '',
      ])
        await insertRefused(
          f.db,
          'sso_domains',
          pendingDomainValues(f.team, name),
          violation('sso_domains_name'),
        )
    },
    mutants: [
      dropConstraint('sso_domains', 'sso_domains_name'),
      edit(
        'uppercase names',
        "name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'",
        "name ~* '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'",
      ),
      edit(
        'numeric top-level labels (IP addresses)',
        '[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]',
        '[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]',
      ),
      edit('wildcards', "name ~ '^(", "name ~ '^(\\*\\.)?("),
      edit('overlong names', 'char_length(name) <= 253', 'char_length(name) <= 255'),
    ],
  },
  'domain generations are positive': {
    objects: ['sso_domains_generation'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_domains',
        { ...pendingDomainValues(f.team), generation: 0 },
        violation('sso_domains_generation'),
      )
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_generation')],
  },
  'only a SHA-256 digest of the challenge is stored': {
    objects: ['sso_domains_challenge_digest'],
    check: async (f) => {
      for (const challenge_digest of [
        digest().toUpperCase(),
        digest().slice(1),
        `${digest()}0`,
        'hourmere-sso-verification=synthetic-raw-challenge',
      ])
        await insertRefused(
          f.db,
          'sso_domains',
          { ...pendingDomainValues(f.team), challenge_digest },
          violation('sso_domains_challenge_digest'),
        )
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_challenge_digest')],
  },
  'recheck outcomes are positive, failed or unknown': {
    objects: ['sso_domains_last_check_outcome'],
    check: async (f) => {
      for (const last_check_outcome of ['positive', 'failed', 'unknown'])
        await insertAccepted(f.db, 'sso_domains', {
          ...claimedDomainValues(f.team, domainName()),
          last_check_outcome,
        })
      for (const last_check_outcome of ['missing', 'verified', 'POSITIVE'])
        await insertRefused(
          f.db,
          'sso_domains',
          { ...claimedDomainValues(f.team), last_check_outcome },
          violation('sso_domains_last_check_outcome'),
        )
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_last_check_outcome')],
  },
  'a verification has its expiry and a claim': {
    objects: ['sso_domains_verification_shape'],
    check: async (f) => {
      for (const values of [
        { verification_expires_at: null },
        { verified_at: null, claimed_at: null },
        { verification_expires_at: at(-2 * 86_400) },
        { claimed_at: null },
      ])
        await insertRefused(
          f.db,
          'sso_domains',
          { ...claimedDomainValues(f.team), ...values },
          violation('sso_domains_verification_shape'),
        )
    },
    mutants: [
      dropConstraint('sso_domains', 'sso_domains_verification_shape'),
      edit(
        'expiry may precede verification',
        'verification_expires_at > verified_at',
        'verification_expires_at IS NOT NULL',
      ),
    ],
  },
  'a recheck has its outcome': {
    objects: ['sso_domains_check_shape'],
    check: async (f) => {
      for (const values of [{ last_checked_at: null }, { last_check_outcome: null }])
        await insertRefused(
          f.db,
          'sso_domains',
          { ...claimedDomainValues(f.team), ...values },
          violation('sso_domains_check_shape'),
        )
    },
    mutants: [dropConstraint('sso_domains', 'sso_domains_check_shape')],
  },
  'one active claim per domain; pending challenges reserve nothing': {
    objects: ['sso_domains_active_name'],
    check: async (f) => {
      const name = domainName()
      const claim = await domain(f, claimedDomainValues(f.team, name))
      // Another team's pending challenge for the same name is allowed but cannot verify.
      const pending = await insertedRow(f.db, 'sso_domains', pendingDomainValues(f.otherTeam, name))
      const verify = {
        claimed_at: at(0),
        verified_at: at(0),
        verification_expires_at: at(7 * 86_400),
      }
      await updateRefused(
        f.db,
        'sso_domains',
        byId(pending),
        verify,
        duplicate('sso_domains_active_name'),
      )
      await insertRefused(
        f.db,
        'sso_domains',
        claimedDomainValues(f.otherTeam, name),
        duplicate('sso_domains_active_name'),
      )
      // Still exclusive while the claim's next generation is pending.
      await updateAccepted(f.db, 'sso_domains', byId(claim), nextGeneration(claim))
      await updateRefused(
        f.db,
        'sso_domains',
        byId(pending),
        verify,
        duplicate('sso_domains_active_name'),
      )
      // A lapsed claim stays exclusive until it is retired.
      const lapsedName = domainName()
      await domain(f, lapsedDomainValues(f.team, lapsedName))
      await insertRefused(
        f.db,
        'sso_domains',
        claimedDomainValues(f.otherTeam, lapsedName),
        duplicate('sso_domains_active_name'),
      )
      // Two pending challenges never conflict, and retirement releases the name.
      const shared = domainName()
      await insertAccepted(f.db, 'sso_domains', pendingDomainValues(f.team, shared))
      await insertAccepted(f.db, 'sso_domains', pendingDomainValues(f.otherTeam, shared))
      await updateAccepted(f.db, 'sso_domains', byId(claim), { retired_at: at(0) })
      await updateAccepted(f.db, 'sso_domains', byId(pending), verify)
    },
    mutants: [
      dropIndex('sso_domains_active_name'),
      edit(
        'only currently verified claims are exclusive',
        'ON sso_domains (name)\n  WHERE claimed_at IS NOT NULL AND retired_at IS NULL',
        'ON sso_domains (name)\n  WHERE verified_at IS NOT NULL AND retired_at IS NULL',
      ),
      edit(
        'pending challenges reserve the name',
        'ON sso_domains (name)\n  WHERE claimed_at IS NOT NULL AND retired_at IS NULL',
        'ON sso_domains (name)\n  WHERE retired_at IS NULL',
      ),
      edit(
        'retired claims keep the name',
        'ON sso_domains (name)\n  WHERE claimed_at IS NOT NULL AND retired_at IS NULL',
        'ON sso_domains (name)\n  WHERE claimed_at IS NOT NULL',
      ),
    ],
  },
  'one live record per team and domain': {
    objects: ['sso_domains_organization_name'],
    check: async (f) => {
      const name = domainName()
      const first = await insert(f.db, 'sso_domains', pendingDomainValues(f.team, name))
      await insertRefused(
        f.db,
        'sso_domains',
        pendingDomainValues(f.team, name),
        duplicate('sso_domains_organization_name'),
      )
      await updateAccepted(f.db, 'sso_domains', byId(first), { retired_at: at(0) })
      await insertAccepted(f.db, 'sso_domains', pendingDomainValues(f.team, name))
    },
    mutants: [
      dropIndex('sso_domains_organization_name'),
      edit(
        'retired records keep the name',
        'ON sso_domains (organization_id, name)\n  WHERE retired_at IS NULL',
        'ON sso_domains (organization_id, name)',
      ),
    ],
  },
  'domain claim identity is immutable': {
    objects: ['sso_domains_guard', 'sso_domains_identity_immutable'],
    check: async (f) => {
      const row = await domain(f)
      for (const values of [
        { name: domainName() },
        { organization_id: f.otherTeam },
        { id: randomUUID() },
        { created_at: at(-60) },
      ])
        await updateRefused(
          f.db,
          'sso_domains',
          byId(row),
          values,
          violation('sso_domains_identity_immutable'),
        )
    },
    mutants: [
      dropTrigger('sso_domains', 'sso_domains_guard'),
      neverRaise(
        'domain identity may change',
        'ROW(NEW.id, NEW.organization_id, NEW.name, NEW.created_at)\n       IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.name, OLD.created_at)',
      ),
    ],
  },
  'a claim stays exclusive until it is retired': {
    objects: ['sso_domains_claim_kept'],
    check: async (f) => {
      const row = await domain(f)
      await updateAccepted(f.db, 'sso_domains', byId(row), nextGeneration(row))
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { claimed_at: null },
        violation('sso_domains_claim_kept'),
      )
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { claimed_at: at(0) },
        violation('sso_domains_claim_kept'),
      )
    },
    mutants: [
      neverRaise(
        'claims may be released without retirement',
        'OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at',
      ),
    ],
  },
  'a claim starts with a verification': {
    objects: ['sso_domains_claim_verified'],
    check: async (f) => {
      await insertRefused(
        f.db,
        'sso_domains',
        { ...pendingDomainValues(f.team), claimed_at: at(0) },
        violation('sso_domains_claim_verified'),
      )
      const pending = await insert(f.db, 'sso_domains', pendingDomainValues(f.team))
      await updateRefused(
        f.db,
        'sso_domains',
        byId(pending),
        { claimed_at: at(0) },
        violation('sso_domains_claim_verified'),
      )
      await updateAccepted(f.db, 'sso_domains', byId(pending), {
        claimed_at: at(0),
        verified_at: at(0),
        verification_expires_at: at(7 * 86_400),
      })
    },
    mutants: [
      neverRaise(
        'claims without verification',
        "NEW.claimed_at IS NOT NULL AND NEW.verified_at IS NULL\n     AND (TG_OP = 'INSERT' OR OLD.claimed_at IS NULL)",
      ),
    ],
  },
  'domain generations never decrease': {
    objects: ['sso_domains_generation_monotonic'],
    check: async (f) => {
      const row = await insert(f.db, 'sso_domains', {
        ...pendingDomainValues(f.team),
        generation: 3,
      })
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { generation: 2 },
        violation('sso_domains_generation_monotonic'),
      )
    },
    mutants: [neverRaise('generations may decrease', 'NEW.generation < OLD.generation')],
  },
  'a new generation has a new, unverified challenge': {
    objects: ['sso_domains_generation_challenge'],
    check: async (f) => {
      const row = await domain(f)
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { ...nextGeneration(row), challenge_digest: row.challenge_digest },
        violation('sso_domains_generation_challenge'),
      )
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { generation: (row.generation as number) + 1, challenge_digest: digest() },
        violation('sso_domains_generation_challenge'),
      )
      await updateAccepted(f.db, 'sso_domains', byId(row), nextGeneration(row))
    },
    mutants: [
      neverRaise(
        'a new generation may keep its challenge or verification',
        'NEW.challenge_digest = OLD.challenge_digest OR NEW.verified_at IS NOT NULL',
      ),
      edit(
        'a new generation may keep the verification',
        'IF NEW.challenge_digest = OLD.challenge_digest OR NEW.verified_at IS NOT NULL THEN',
        'IF NEW.challenge_digest = OLD.challenge_digest THEN',
      ),
    ],
  },
  'a generation’s challenge is fixed': {
    objects: ['sso_domains_challenge_fixed'],
    check: async (f) => {
      const row = await insert(f.db, 'sso_domains', pendingDomainValues(f.team))
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { challenge_digest: digest() },
        violation('sso_domains_challenge_fixed'),
      )
      await updateRefused(
        f.db,
        'sso_domains',
        byId(row),
        { challenge_expires_at: at(2 * 86_400) },
        violation('sso_domains_challenge_fixed'),
      )
    },
    mutants: [
      neverRaise(
        'a challenge may rotate within a generation',
        'ROW(NEW.challenge_digest, NEW.challenge_expires_at)\n         IS DISTINCT FROM ROW(OLD.challenge_digest, OLD.challenge_expires_at)',
      ),
    ],
  },
  'a lapsed generation cannot be re-verified': {
    objects: ['sso_domains_generation_lapse'],
    check: async (f) => {
      // Renewal before expiry keeps the generation and everything relying on it.
      const current = await domain(f)
      await updateAccepted(f.db, 'sso_domains', byId(current), {
        verification_expires_at: at(13 * 86_400),
        last_checked_at: at(0),
        next_check_at: at(86_400),
      })
      await updateRefused(
        f.db,
        'sso_domains',
        byId(current),
        { verified_at: at(0) },
        violation('sso_domains_generation_lapse'),
      )
      await updateRefused(
        f.db,
        'sso_domains',
        byId(current),
        { verified_at: null, verification_expires_at: null },
        violation('sso_domains_generation_lapse'),
      )
      // After a lapse the same generation cannot be renewed or verified again ...
      const lapsed = await domain(f, lapsedDomainValues(f.team))
      for (const values of [
        { verification_expires_at: at(7 * 86_400) },
        { verified_at: at(0), verification_expires_at: at(7 * 86_400) },
        { verified_at: null, verification_expires_at: null },
      ])
        await updateRefused(
          f.db,
          'sso_domains',
          byId(lapsed),
          values,
          violation('sso_domains_generation_lapse'),
        )
      // ... only a new generation can be verified, and it carries a new number.
      await updateAccepted(f.db, 'sso_domains', byId(lapsed), nextGeneration(lapsed))
      await updateAccepted(f.db, 'sso_domains', byId(lapsed), {
        verified_at: at(0),
        verification_expires_at: at(7 * 86_400),
      })
      const { rows } = await f.db.query<{ generation: number }>(
        'SELECT generation FROM sso_domains WHERE id=$1',
        [lapsed.id],
      )
      expect(rows[0]?.generation).toBe((lapsed.generation as number) + 1)
    },
    mutants: [
      neverRaise(
        'lapsed generations may be renewed',
        'OLD.verified_at IS NOT NULL AND (\n           NEW.verified_at IS DISTINCT FROM OLD.verified_at\n           OR (NEW.verification_expires_at IS DISTINCT FROM OLD.verification_expires_at\n               AND OLD.verification_expires_at <= clock_timestamp())\n         )',
      ),
      edit(
        'verification time may be reset',
        'NEW.verified_at IS DISTINCT FROM OLD.verified_at\n           OR ',
        '',
      ),
      edit(
        'a day of grace after expiry',
        'AND OLD.verification_expires_at <= clock_timestamp())',
        "AND OLD.verification_expires_at <= clock_timestamp() - interval '1 day')",
      ),
    ],
  },
  'a retired claim is permanent': {
    objects: ['sso_domains_retired_permanent'],
    check: async (f) => {
      const row = await insert(f.db, 'sso_domains', {
        ...lapsedDomainValues(f.team),
        retired_at: at(-60),
      })
      for (const values of [
        { retired_at: null },
        { next_check_at: at(3 * 86_400) },
        nextGeneration(row),
      ])
        await updateRefused(
          f.db,
          'sso_domains',
          byId(row),
          values,
          violation('sso_domains_retired_permanent'),
        )
      await updateAccepted(f.db, 'sso_domains', byId(row), { retired_at: row.retired_at })
    },
    mutants: [
      editFunction(
        'guard_sso_domain',
        'retired claims may change',
        'IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN',
        'IF false THEN',
      ),
    ],
  },
}

const recoveryProtections: Record<string, SsoProtection> = {
  'nomination IDs are unique': {
    objects: ['sso_recovery_nominations_pkey', 'sso_recovery_nominations_id_not_null'],
    check: async (f) => {
      const id = randomUUID()
      await insert(f.db, 'sso_recovery_nominations', { ...nominationValues(f), id })
      await insertRefused(
        f.db,
        'sso_recovery_nominations',
        { ...nominationValues(f, { user: f.owner, member: f.ownerMember }), id },
        duplicate('sso_recovery_nominations_pkey'),
      )
    },
    mutants: [dropConstraint('sso_recovery_nominations', 'sso_recovery_nominations_pkey')],
  },
  'one pending nomination per owner': {
    objects: ['sso_recovery_nominations_pending'],
    check: async (f) => {
      await insert(f.db, 'sso_recovery_nominations', nominationValues(f))
      await insertRefused(
        f.db,
        'sso_recovery_nominations',
        nominationValues(f),
        duplicate('sso_recovery_nominations_pending'),
      )
      await insertAccepted(
        f.db,
        'sso_recovery_nominations',
        nominationValues(f, { user: f.owner, member: f.ownerMember }),
      )
    },
    mutants: [dropConstraint('sso_recovery_nominations', 'sso_recovery_nominations_pending')],
  },
  'a nomination expires after it is made': {
    objects: ['sso_recovery_nominations_expiry'],
    check: async (f) => {
      const created = at(0)
      for (const expires_at of [created, at(-60)])
        await insertRefused(
          f.db,
          'sso_recovery_nominations',
          { ...nominationValues(f), created_at: created, expires_at },
          violation('sso_recovery_nominations_expiry'),
        )
    },
    mutants: [dropConstraint('sso_recovery_nominations', 'sso_recovery_nominations_expiry')],
  },
  'one recovery record per team owner': {
    objects: [
      'sso_recovery_owners_pkey',
      'sso_recovery_owners_organization_id_not_null',
      'sso_recovery_owners_user_id_not_null',
    ],
    check: async (f) => {
      await insertAccepted(f.db, 'sso_recovery_owners', recoveryOwnerValues(f))
      await insertRefused(
        f.db,
        'sso_recovery_owners',
        recoveryOwnerValues(f),
        duplicate('sso_recovery_owners_pkey'),
      )
    },
    mutants: [dropConstraint('sso_recovery_owners', 'sso_recovery_owners_pkey')],
  },
  'recovery records end with the membership': {
    objects: ['sso_recovery_nominations_member_id_fkey', 'sso_recovery_owners_member_id_fkey'],
    check: async (f) => {
      await insert(f.db, 'sso_recovery_owners', recoveryOwnerValues(f))
      await insert(f.db, 'sso_recovery_nominations', nominationValues(f))
      await insert(f.db, 'sso_recovery_owners', {
        ...recoveryOwnerValues(f, { user: f.otherOwner, member: f.otherOwnerMember }),
        organization_id: f.otherTeam,
      })
      await insert(f.db, 'sso_recovery_nominations', {
        ...nominationValues(f, { user: f.otherOwner, member: f.otherOwnerMember }),
        organization_id: f.otherTeam,
      })
      // Leaving or removal deletes the membership; re-joining does not restore anything.
      await accepted(f.db, 'DELETE FROM auth.member WHERE id = ANY($1)', [
        [f.ownerMember, f.coOwnerMember],
      ])
      await f.db.query(
        `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
        VALUES ($1,$2,'owner',now()),($1,$3,'owner',now())`,
        [f.team, f.owner, f.coOwner],
      )
      expect(await count(f.db, 'sso_recovery_owners', { organization_id: f.team })).toBe(0)
      expect(await count(f.db, 'sso_recovery_nominations', { organization_id: f.team })).toBe(0)
      // Deleting the user removes their membership and with it the records.
      await accepted(f.db, 'DELETE FROM auth."user" WHERE id=$1', [f.otherOwner])
      expect(await count(f.db, 'sso_recovery_owners', { organization_id: f.otherTeam })).toBe(0)
      expect(await count(f.db, 'sso_recovery_nominations', { organization_id: f.otherTeam })).toBe(
        0,
      )
    },
    mutants: [
      dropConstraint('sso_recovery_nominations', 'sso_recovery_nominations_member_id_fkey'),
      dropConstraint('sso_recovery_owners', 'sso_recovery_owners_member_id_fkey'),
      edit(
        'recovery owners outlive the membership',
        '  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE CASCADE,\n  nominated_by_user_id uuid NOT NULL,\n  accepted_at',
        '  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE RESTRICT,\n  nominated_by_user_id uuid NOT NULL,\n  accepted_at',
      ),
    ],
  },
  'recovery belongs to a current owner of the team': {
    objects: [
      'sso_recovery_nominations_guard',
      'sso_recovery_owners_guard',
      'sso_recovery_current_owner',
    ],
    check: async (f) => {
      for (const table of ['sso_recovery_nominations', 'sso_recovery_owners'] as const) {
        const values = table === 'sso_recovery_owners' ? recoveryOwnerValues : nominationValues
        for (const nominee of [
          { user: f.admin, member: f.adminMember },
          { user: f.member, member: f.memberMember },
          // Another team's owner, or a membership that is not the named user's.
          { user: f.otherOwner, member: f.otherOwnerMember },
          { user: f.admin, member: f.ownerMember },
          { user: f.owner, member: randomUUID() },
        ])
          await insertRefused(
            f.db,
            table,
            values(f, nominee),
            violation('sso_recovery_current_owner'),
          )
        await insertAccepted(f.db, table, values(f, { user: f.owner, member: f.ownerMember }))
        await insertAccepted(f.db, table, values(f, { user: f.coOwner, member: f.coOwnerMember }))
      }
    },
    mutants: [
      dropTrigger('sso_recovery_nominations', 'sso_recovery_nominations_guard'),
      dropTrigger('sso_recovery_owners', 'sso_recovery_owners_guard'),
      edit(
        'any member',
        "\n      AND 'owner' = ANY (SELECT btrim(r.token) FROM unnest(string_to_array(m.role, ',')) AS r (token))",
        '',
      ),
      edit('any user of the membership', '\n      AND m."userId" = NEW.user_id', ''),
      edit(
        'any team of the membership',
        'm.id = NEW.member_id AND m."organizationId" = NEW.organization_id',
        'm.id = NEW.member_id',
      ),
    ],
  },
  'recovery records are immutable': {
    objects: ['sso_recovery_immutable'],
    check: async (f) => {
      const nomination = await insert(f.db, 'sso_recovery_nominations', nominationValues(f))
      await updateRefused(
        f.db,
        'sso_recovery_nominations',
        byId(nomination),
        { expires_at: at(30 * 86_400) },
        violation('sso_recovery_immutable'),
      )
      await insert(f.db, 'sso_recovery_owners', recoveryOwnerValues(f))
      await updateRefused(
        f.db,
        'sso_recovery_owners',
        { organization_id: f.team, user_id: f.owner },
        { accepted_at: at(-60), nominated_by_user_id: f.owner },
        violation('sso_recovery_immutable'),
      )
    },
    mutants: [neverRaise('recovery records may change', "TG_OP = 'UPDATE'")],
  },
}

const teamProtections: Record<string, SsoProtection> = {
  'personal organizations hold no SSO configuration': {
    objects: ['sso_team_organization'],
    check: async (f) => {
      const personalOwner = {
        user: f.personalUser,
        member: f.personalMember,
        organization: f.personal,
      }
      const refusedValues: [SsoTable, Record<string, unknown>][] = [
        ['sso_policies', policyValues(f.personal)],
        ['sso_providers', oidcProviderValues(f.personal)],
        ['sso_domains', pendingDomainValues(f.personal)],
        ['sso_recovery_nominations', nominationValues(f, personalOwner)],
        ['sso_recovery_owners', recoveryOwnerValues(f, personalOwner)],
      ]
      for (const [table, values] of refusedValues)
        await insertRefused(f.db, table, values, violation('sso_team_organization'))
      await insertAccepted(f.db, 'sso_policies', policyValues(f.team))
      await insertAccepted(f.db, 'sso_providers', oidcProviderValues(f.team))
      await insertAccepted(f.db, 'sso_domains', pendingDomainValues(f.team))
    },
    mutants: [
      edit(
        'personal organizations are accepted',
        'IF EXISTS (SELECT FROM public.personal_organizations WHERE organization_id = organization) THEN',
        'IF false THEN',
      ),
      editFunction(
        'guard_sso_policy',
        'policies skip the team check',
        'PERFORM public.sso_team_organization(NEW.organization_id);',
        '',
      ),
      editFunction(
        'guard_sso_provider',
        'providers skip the team check',
        'PERFORM public.sso_team_organization(NEW.organization_id);',
        '',
      ),
      editFunction(
        'guard_sso_domain',
        'domains skip the team check',
        'PERFORM public.sso_team_organization(NEW.organization_id);',
        '',
      ),
      editFunction(
        'guard_sso_recovery_record',
        'recovery records skip the team check',
        'PERFORM public.sso_team_organization(NEW.organization_id);',
        '',
      ),
    ],
  },
}

const retainedCheck =
  (table: SsoTable, constraint: string, row: (f: SsoFixture) => Promise<Record<string, unknown>>) =>
  async (f: SsoFixture) => {
    const kept = await row(f)
    const where = table === 'sso_policies' ? 'organization_id=$1' : 'id=$1'
    const key = table === 'sso_policies' ? kept.organization_id : kept.id
    await refused(f.db, `DELETE FROM ${table} WHERE ${where}`, [key], violation(constraint))
    expect(await count(f.db, table, { organization_id: f.team })).toBe(1)
    // The organization's deletion still removes it.
    await accepted(f.db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
    expect(await count(f.db, table, { organization_id: f.team })).toBe(0)
  }
const keptWhileTeamExists = (fn: string, name: string) =>
  editFunction(
    fn,
    name,
    'IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN',
    'IF false THEN',
  )

const retainedProtections: Record<string, SsoProtection> = {
  'a policy is kept while its team exists': {
    objects: ['sso_policies_retained'],
    check: retainedCheck('sso_policies', 'sso_policies_retained', async (f) =>
      insert(f.db, 'sso_policies', { ...policyValues(f.team), trust_generation: 3 }),
    ),
    mutants: [keptWhileTeamExists('guard_sso_policy', 'policies may be deleted and reset')],
  },
  'a provider is retired, not deleted': {
    objects: ['sso_providers_retained'],
    check: retainedCheck('sso_providers', 'sso_providers_retained', async (f) =>
      insert(f.db, 'sso_providers', { ...oidcProviderValues(f.team), retired_at: at(-60) }),
    ),
    mutants: [keptWhileTeamExists('guard_sso_provider', 'providers may be deleted and reused')],
  },
  'a domain claim is retired, not deleted': {
    objects: ['sso_domains_retained'],
    check: retainedCheck('sso_domains', 'sso_domains_retained', async (f) =>
      insert(f.db, 'sso_domains', lapsedDomainValues(f.team)),
    ),
    mutants: [keptWhileTeamExists('guard_sso_domain', 'lapsed claims may be deleted and revived')],
  },
}

const indexProtections: Record<string, SsoProtection> = {
  'membership and domain lookups for cascades are indexed': {
    objects: [
      'sso_provider_domains_domain_id',
      'sso_recovery_nominations_member_id',
      'sso_recovery_owners_member_id',
    ],
    check: async (f) => {
      const { rows } = await f.db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)
        ORDER BY indexname`,
        [
          [
            'sso_provider_domains_domain_id',
            'sso_recovery_nominations_member_id',
            'sso_recovery_owners_member_id',
          ],
        ],
      )
      expect(rows.map(({ indexdef }) => indexdef)).toEqual([
        'CREATE INDEX sso_provider_domains_domain_id ON public.sso_provider_domains USING btree (domain_id)',
        'CREATE INDEX sso_recovery_nominations_member_id ON public.sso_recovery_nominations USING btree (member_id)',
        'CREATE INDEX sso_recovery_owners_member_id ON public.sso_recovery_owners USING btree (member_id)',
      ])
    },
    mutants: [
      dropIndex('sso_provider_domains_domain_id'),
      dropIndex('sso_recovery_nominations_member_id'),
      dropIndex('sso_recovery_owners_member_id'),
    ],
  },
}

/** Every NOT NULL column outside a primary key, with a complete row for its table. */
const requiredColumns: Record<SsoTable, string[]> = {
  sso_policies: ['require_sso', 'admission', 'policy_revision', 'trust_generation', 'created_at'],
  sso_providers: [
    'organization_id',
    'protocol',
    'display_name',
    'issuer',
    'configuration',
    'revision',
    'enabled',
    'created_at',
  ],
  sso_domains: [
    'organization_id',
    'name',
    'generation',
    'challenge_digest',
    'challenge_expires_at',
    'created_at',
  ],
  sso_provider_domains: ['organization_id'],
  sso_recovery_nominations: [
    'organization_id',
    'member_id',
    'user_id',
    'nominated_by_user_id',
    'created_at',
    'expires_at',
  ],
  sso_recovery_owners: ['member_id', 'nominated_by_user_id', 'accepted_at'],
}
const completeRow = (f: SsoFixture, table: SsoTable): Record<string, unknown> => {
  const created = { created_at: at(0) }
  switch (table) {
    case 'sso_policies':
      return {
        ...policyValues(f.team),
        require_sso: false,
        admission: 'invitation_only',
        policy_revision: 1,
        trust_generation: 1,
        ...created,
      }
    case 'sso_providers':
      return { ...oidcProviderValues(f.team), revision: 1, enabled: false, ...created }
    case 'sso_domains':
      return { ...pendingDomainValues(f.team), generation: 1, ...created }
    case 'sso_provider_domains':
      return { organization_id: f.team, provider_id: randomUUID(), domain_id: randomUUID() }
    case 'sso_recovery_nominations':
      return { ...nominationValues(f), ...created }
    case 'sso_recovery_owners':
      return { ...recoveryOwnerValues(f), accepted_at: at(0) }
  }
}
const notNullProtections: Record<string, SsoProtection> = Object.fromEntries(
  Object.entries(requiredColumns).flatMap(([table, columns]) =>
    columns.map((column) => [
      `${table}.${column} is required`,
      {
        objects: [`${table}_${column}_not_null`],
        check: async (f: SsoFixture) => {
          const row = completeRow(f, table as SsoTable)
          // The complete row is valid; with the column missing only NOT NULL refuses it.
          await insertAccepted(f.db, table, row, { withoutTriggers: true })
          await insertRefused(
            f.db,
            table,
            { ...row, [column]: null },
            { code: '23502', column },
            { withoutTriggers: true },
          )
        },
        mutants: [
          append(
            `${table}.${column} may be null`,
            `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL;`,
          ),
        ],
      } satisfies SsoProtection,
    ]),
  ),
)

export const ssoProtections: Record<string, SsoProtection> = {
  ...policyProtections,
  ...providerProtections,
  ...domainProtections,
  ...recoveryProtections,
  ...teamProtections,
  ...retainedProtections,
  ...indexProtections,
  ...notNullProtections,
}

/**
 * The whole suite on one database, for checkConstraintCoverage: every check in its own
 * rolled-back transaction, then the concurrent-claim race (which commits its own teams).
 * Throws on the first failing assertion.
 */
export async function assertSsoProtections(pool: pg.Pool) {
  for (const protection of Object.values(ssoProtections))
    await inRolledBackTransaction(pool, async (db) => protection.check(await ssoFixture(db)))
  await checkActiveClaimRace(pool)
}
