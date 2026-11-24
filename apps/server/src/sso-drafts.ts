import { type Principal, teamRoles } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import type { SsoRequest, sendSsoRequest } from '@hourmere/outbound/sso'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled, requireSsoRetained, type SsoCapabilities } from './sso.ts'
import { openSsoProviderConfiguration, sealSsoProviderConfiguration } from './sso-configuration.ts'
import { lockSsoDomain } from './sso-domains.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { currentSsoProviderTestStatus } from './sso-oidc-test-receipts.ts'
import { authorizeSsoRead } from './sso-reads.ts'
import { providerRecoveryAuthority, ssoWriteContextAccess } from './sso-recovery-use.ts'
import {
  normalizeSamlSigningCertificates,
  resolveSamlProviderInput,
  samlProviderInput,
} from './sso-saml-configuration.ts'
import { samlProviderConfig } from './sso-saml-state.ts'

export interface SsoDraftDeps extends FreshProofDeps {
  configurationKey?: Buffer | undefined
  privateTargets?: SsoRequest['privateTargets'] | undefined
  send?: typeof sendSsoRequest | undefined
}
function configurationKey(deps: SsoDraftDeps) {
  if (!deps.configurationKey) throw new Error('SSO configuration encryption is unavailable')
  return deps.configurationKey
}
const endpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  })
const oidc = z.strictObject({
  issuer: endpoint,
  clientId: z.string().min(1).max(1024),
  clientSecret: z.string().min(1).max(16384).meta({ writeOnly: true }),
  authorizationEndpoint: endpoint.optional(),
  tokenEndpoint: endpoint.optional(),
  jwksUrl: endpoint.optional(),
  algorithms: z.array(z.literal('RS256')).min(1).max(1).optional(),
})
const domains = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length)
const create = z.strictObject({
  protocol: z.enum(['oidc', 'saml']),
  displayName: z.string().trim().min(1).max(100),
  domainIds: domains,
  oidc: oidc.optional(),
  saml: samlProviderInput.optional(),
})
const update = z.strictObject({
  expectedRevision: z.number().int().min(1).max(2147483646),
  displayName: z.string().trim().min(1).max(100).optional(),
  domainIds: domains.optional(),
  oidc: oidc.partial().optional(),
  saml: samlProviderInput.optional(),
})
const remove = z.strictObject({ expectedRevision: z.number().int().min(1).max(2147483646) })
const activation = z.strictObject({
  expectedRevision: z.int().positive().max(2_147_483_647),
  enabled: z.boolean(),
})
const proof = { proofAttemptId: z.uuid().optional() }
export const CreateSsoProviderInput = create.extend(proof)
export const UpdateSsoProviderInput = update.extend(proof)
export const DeleteSsoProviderInput = remove.extend(proof)
export const ActivateSsoProviderInput = activation.extend(proof)
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
function uniformDenial(error: unknown): never {
  if (error instanceof HTTPException && error.status === 403) throw denied()
  throw error
}
const changed = () => new DomainError('conflict', 'sso_configuration_changed')
const missing = () => new DomainError('not_found', 'sso_not_found')
const invalid = () => new DomainError('invalid', 'invalid_request')

type SamlInput = z.infer<typeof samlProviderInput>
type ResolvedSaml = Awaited<ReturnType<typeof resolveSamlProviderInput>>

function draftProtocol(input: unknown) {
  if (input && typeof input === 'object') {
    if (('protocol' in input && input.protocol === 'saml') || 'saml' in input) return 'saml'
    if (('protocol' in input && input.protocol === 'oidc') || 'oidc' in input) return 'oidc'
  }
}

export function guardSsoDraftInput(capabilities: SsoCapabilities, input: unknown) {
  const protocol = draftProtocol(input)
  requireSsoEnabled(capabilities, protocol)
  return protocol
}

async function provider(db: Db, organizationId: string, id: string) {
  if (!z.uuid().safeParse(id).success) throw missing()
  const row = await db
    .selectFrom('sso_providers')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw missing()
  return row
}
type Provider = Awaited<ReturnType<typeof provider>>
function summary(row: Provider) {
  return {
    id: row.id,
    protocol: row.protocol,
    revision: row.revision,
    enabled: row.enabled,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    hasClientSecret: row.protocol === 'oidc',
    validationStatus: 'unknown',
    testStatus: 'unknown',
  }
}
async function checkDomains(db: Db, organizationId: string, ids?: string[]) {
  if (!ids?.length) return
  const rows = await db
    .selectFrom('sso_domains')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('id', 'in', ids)
    .where('retired_at', 'is', null)
    .execute()
  if (rows.length !== ids.length) throw missing()
}
async function setDomains(db: Db, organizationId: string, providerId: string, ids: string[]) {
  await db
    .deleteFrom('sso_provider_domains')
    .where('provider_id', '=', providerId)
    .where('organization_id', '=', organizationId)
    .execute()
  if (ids.length)
    await db
      .insertInto('sso_provider_domains')
      .values(
        ids.map((domainId) => ({
          organization_id: organizationId,
          provider_id: providerId,
          domain_id: domainId,
        })),
      )
      .execute()
}
async function changeTrust(db: Db, organizationId: string) {
  await db
    .insertInto('sso_policies')
    .values({ organization_id: organizationId })
    .onConflict((oc) => oc.column('organization_id').doNothing())
    .execute()
  await db
    .updateTable('sso_policies')
    .set({ trust_generation: sql`trust_generation + 1` })
    .where('organization_id', '=', organizationId)
    .execute()
}
function browserPrincipal(deps: SsoDraftDeps, principal: Principal) {
  requireSsoRetained(deps.capabilities)
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  return principal
}
async function authorize(
  deps: SsoDraftDeps,
  db: Db,
  principal: Extract<Principal, { kind: 'session' }>,
  headers: Headers,
  recoveryRequired = false,
) {
  await authorizeSsoRead({ ...deps, db }, principal)
  await ssoWriteContextAccess(db, principal, headers, recoveryRequired)
}
async function audit(
  db: Db,
  principal: Principal,
  row: Provider,
  action:
    | 'sso_provider.created'
    | 'sso_provider.updated'
    | 'sso_provider.enabled'
    | 'sso_provider.disabled'
    | 'sso_provider.deleted'
    | 'sso_provider.certificate_rotated'
    | 'sso_provider.secret_rotated',
) {
  await writeSsoAuditEvent(db, {
    ...auditActor(principal),
    organizationId: principal.organization.id,
    action,
    targetType: 'sso_provider',
    targetId: row.id,
    details: {
      method: row.protocol === 'saml' ? 'saml' : 'oidc',
      providerId: row.id,
      revision: row.revision,
    },
  })
}

export async function createSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  input: unknown,
  recoveryRequired = false,
) {
  const protocol = guardSsoDraftInput(deps.capabilities, input)
  const p = browserPrincipal(deps, principal)
  let saml: SamlInput | undefined
  let resolvedSaml: ResolvedSaml | undefined
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'createSsoProvider',
      input,
      schema: create,
    },
    {
      consumeRecovery: providerRecoveryAuthority(p, recoveryRequired),
      authorize: async (db) => {
        await authorize(deps, db, p, headers, recoveryRequired)
        const parsed = CreateSsoProviderInput.parse(input)
        if (parsed.protocol === 'saml') {
          if (!parsed.saml || parsed.oidc) throw invalid()
          saml = parsed.saml
        } else if (!parsed.oidc || parsed.saml) {
          throw invalid()
        }
        await checkDomains(db, p.organization.id, parsed.domainIds)
      },
      ...(protocol === 'saml' && {
        prepare: async () => {
          if (!saml) throw invalid()
          resolvedSaml = await resolveSamlProviderInput(saml, {
            privateTargets: deps.privateTargets,
            transport: deps.send,
          })
        },
      }),
      mutate: async (db, raw) => {
        const value = create.parse(raw)
        const configuration = value.protocol === 'saml' ? resolvedSaml?.configuration : value.oidc
        const issuer = value.protocol === 'saml' ? resolvedSaml?.entityId : value.oidc?.issuer
        if (!configuration || !issuer) throw invalid()
        const { id } = await db
          .selectNoFrom(sql<string>`uuidv7()`.as('id'))
          .executeTakeFirstOrThrow()
        const row = await db
          .insertInto('sso_providers')
          .values({
            id,
            organization_id: p.organization.id,
            protocol: value.protocol,
            display_name: value.displayName,
            issuer,
            client_id: value.oidc?.clientId ?? null,
            configuration: sealSsoProviderConfiguration(
              configurationKey(deps),
              { organizationId: p.organization.id, providerId: id, revision: 1 },
              JSON.stringify(configuration),
            ),
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        await setDomains(db, p.organization.id, id, value.domainIds)
        await audit(db, p, row, 'sso_provider.created')
        return { provider: summary(row) }
      },
    },
  ).catch(uniformDenial)
}

function boundInput(input: unknown, providerId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'providerId' in input)
    throw new DomainError('invalid', 'invalid_request')
  return { ...input, providerId }
}

function providerDomains(db: Db, organizationId: string) {
  return db
    .selectFrom('sso_provider_domains as pd')
    .innerJoin('sso_domains as d', (join) =>
      join.onRef('d.id', '=', 'pd.domain_id').onRef('d.organization_id', '=', 'pd.organization_id'),
    )
    .where('pd.organization_id', '=', organizationId)
    .where('d.retired_at', 'is', null)
}

function liveProviderDomains(db: Db, organizationId: string) {
  return providerDomains(db, organizationId)
    .where('d.verified_at', 'is not', null)
    .where('d.verification_expires_at', '>', sql<Date>`clock_timestamp()`)
}

async function checkActivation(
  db: Db,
  capabilities: SsoCapabilities,
  row: Provider,
  enable: boolean,
  testStatus: string,
) {
  if (enable) {
    if (testStatus !== 'passed') throw new DomainError('conflict', 'sso_test_required')
    const verified = await liveProviderDomains(db, row.organization_id)
      .select('d.id')
      .where('pd.provider_id', '=', row.id)
      .where('d.last_check_outcome', '=', 'positive')
      .limit(1)
      .executeTakeFirst()
    if (!verified) throw new DomainError('conflict', 'sso_domain_unverified')
    return
  }
  await requireUsableReplacement(db, capabilities, row)
}

async function requireUsableReplacement(db: Db, capabilities: SsoCapabilities, row: Provider) {
  if (!row.enabled || row.protocol !== 'oidc' || !capabilities.ssoOidcEnabled) return
  const enforced = await db
    .selectFrom('sso_policies')
    .select('organization_id')
    .where('organization_id', '=', row.organization_id)
    .where('require_sso', '=', true)
    .executeTakeFirst()
  if (!enforced) return

  // A failed recheck freezes new activation but does not end existing sign-ins before expiry.
  const alternative = await liveProviderDomains(db, row.organization_id)
    .innerJoin('sso_providers as p', (join) =>
      join
        .onRef('p.id', '=', 'pd.provider_id')
        .onRef('p.organization_id', '=', 'pd.organization_id'),
    )
    .select('p.id')
    .where('p.id', '!=', row.id)
    .where('p.enabled', '=', true)
    .where('p.retired_at', 'is', null)
    .where('p.protocol', '=', 'oidc')
    .limit(1)
    .executeTakeFirst()
  if (!alternative) throw new DomainError('conflict', 'sso_last_provider')
}

export async function activateSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: z.infer<typeof ActivateSsoProviderInput>,
  recoveryRequired = false,
) {
  if (input.enabled) requireSsoEnabled(deps.capabilities)
  const p = browserPrincipal(deps, principal)
  const organizationId = p.organization.id
  let target: { row: Provider; testStatus: string }
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId,
      operation: 'activateSsoProvider',
      proofMode: input.enabled ? 'administration' : 'trust_reduction',
      input: boundInput(input, providerId),
      schema: activation.extend({ providerId: z.uuid() }),
    },
    {
      changesAuthority: !input.enabled,
      consumeRecovery: providerRecoveryAuthority(p, recoveryRequired),
      authorize: async (db) => {
        await authorize(deps, db, p, headers, recoveryRequired)
        const member = await db
          .selectFrom('auth.member')
          .select('role')
          .where('organizationId', '=', organizationId)
          .where('userId', '=', p.user.id)
          .executeTakeFirst()
        if (!member || !teamRoles(member.role).includes('owner')) throw denied()

        const row = await provider(db, organizationId, providerId)
        if (row.retired_at) throw missing()
        if (input.enabled)
          requireSsoEnabled(deps.capabilities, row.protocol === 'saml' ? 'saml' : 'oidc')
        if (row.revision !== input.expectedRevision) throw changed()
        const { testStatus } = await db
          .selectFrom('sso_providers')
          .select(currentSsoProviderTestStatus.as('testStatus'))
          .where('id', '=', row.id)
          .where('organization_id', '=', organizationId)
          .executeTakeFirstOrThrow()

        if (input.enabled) {
          // Rechecks take the same lock before looking up DNS. Read the claims after waiting.
          const linked = await providerDomains(db, organizationId)
            .select('d.name')
            .where('pd.provider_id', '=', row.id)
            .orderBy('d.name')
            .execute()
          for (const { name } of linked) await lockSsoDomain(db, name)
        }
        await checkActivation(db, deps.capabilities, row, input.enabled, testStatus)
        target = { row, testStatus }
      },
      mutate: async (db) => {
        const { row, testStatus } = target
        // A verification can expire while the fresh browser proof is being checked.
        await checkActivation(db, deps.capabilities, row, input.enabled, testStatus)
        if (row.enabled === input.enabled) return { provider: { ...summary(row), testStatus } }

        const updated = await db
          .updateTable('sso_providers')
          .set({ enabled: input.enabled })
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        if (!input.enabled) await changeTrust(db, organizationId)
        await audit(
          db,
          p,
          updated,
          input.enabled ? 'sso_provider.enabled' : 'sso_provider.disabled',
        )
        return { provider: { ...summary(updated), testStatus } }
      },
    },
  ).catch(uniformDenial)
}

export async function updateSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: unknown,
  recoveryRequired = false,
) {
  const protocol = guardSsoDraftInput(deps.capabilities, input)
  const p = browserPrincipal(deps, principal)
  let old: Provider
  let saml: SamlInput | undefined
  let resolvedSaml: ResolvedSaml | undefined
  let samlCertificatesRotated = false
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'updateSsoProvider',
      input: boundInput(input, providerId),
      schema: update.extend({ providerId: z.uuid() }),
    },
    {
      changesAuthority: true,
      consumeRecovery: providerRecoveryAuthority(p, recoveryRequired),
      authorize: async (db) => {
        await authorize(deps, db, p, headers, recoveryRequired)
        const row = await provider(db, p.organization.id, providerId)
        if (row.retired_at) throw missing()
        requireSsoEnabled(deps.capabilities, row.protocol === 'saml' ? 'saml' : 'oidc')
        const value = UpdateSsoProviderInput.parse(input)
        if (row.revision !== value.expectedRevision) throw changed()
        if (
          (value.saml && row.protocol !== 'saml') ||
          (value.oidc && row.protocol !== 'oidc') ||
          (value.oidc?.issuer !== undefined && value.oidc.issuer !== row.issuer) ||
          (value.oidc?.clientId !== undefined && value.oidc.clientId !== row.client_id) ||
          (value.saml?.entityId !== undefined && value.saml.entityId !== row.issuer)
        )
          throw invalid()
        await checkDomains(db, p.organization.id, value.domainIds)
        old = row
        saml = value.saml
      },
      ...(protocol === 'saml' && {
        prepare: async () => {
          if (!saml) throw invalid()
          const configuration = samlProviderConfig.safeParse(
            JSON.parse(
              openSsoProviderConfiguration(
                configurationKey(deps),
                { organizationId: p.organization.id, providerId, revision: old.revision },
                old.configuration,
              ),
            ),
          )
          if (!configuration.success) throw invalid()
          resolvedSaml = await resolveSamlProviderInput(saml, {
            current: { entityId: old.issuer, configuration: configuration.data },
            privateTargets: deps.privateTargets,
            transport: deps.send,
          })
          try {
            const previousPins = normalizeSamlSigningCertificates(
              configuration.data.signingCertificates ?? [],
            )
            samlCertificatesRotated =
              JSON.stringify(previousPins) !==
              JSON.stringify(resolvedSaml.configuration.signingCertificates)
          } catch {
            // A valid replacement repairs invalid stored pins.
            samlCertificatesRotated = true
          }
        },
      }),
      mutate: async (db, raw) => {
        const { providerId: _providerId, ...body } = raw
        const value = update.parse(body)
        const before = JSON.parse(
          openSsoProviderConfiguration(
            configurationKey(deps),
            { organizationId: p.organization.id, providerId, revision: old.revision },
            old.configuration,
          ),
        )
        const configuration = resolvedSaml?.configuration ?? { ...before, ...value.oidc }
        const oldDomains = await db
          .selectFrom('sso_provider_domains')
          .select('domain_id')
          .where('provider_id', '=', providerId)
          .execute()
        const trustChanged =
          (resolvedSaml
            ? samlCertificatesRotated ||
              resolvedSaml.configuration.ssoEndpoint !== before.ssoEndpoint
            : JSON.stringify(configuration) !== JSON.stringify(before)) ||
          (value.domainIds !== undefined &&
            JSON.stringify([...value.domainIds].sort()) !==
              JSON.stringify(oldDomains.map((d) => d.domain_id).sort()))
        const row = await db
          .updateTable('sso_providers')
          .set({
            display_name: value.displayName ?? old.display_name,
            revision: old.revision + 1,
            configuration: sealSsoProviderConfiguration(
              configurationKey(deps),
              { organizationId: p.organization.id, providerId, revision: old.revision + 1 },
              JSON.stringify(configuration),
            ),
          })
          .where('id', '=', providerId)
          .returningAll()
          .executeTakeFirstOrThrow()
        if (value.domainIds !== undefined)
          await setDomains(db, p.organization.id, providerId, value.domainIds)
        if (trustChanged) await changeTrust(db, p.organization.id)
        await audit(db, p, row, 'sso_provider.updated')
        if (samlCertificatesRotated) await audit(db, p, row, 'sso_provider.certificate_rotated')
        if (
          value.oidc?.clientSecret !== undefined &&
          value.oidc.clientSecret !== before.clientSecret
        )
          await audit(db, p, row, 'sso_provider.secret_rotated')
        return { provider: summary(row) }
      },
    },
  ).catch(uniformDenial)
}

export async function deleteSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: unknown,
) {
  const p = browserPrincipal(deps, principal)
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'deleteSsoProvider',
      proofMode: 'trust_reduction',
      input: boundInput(input, providerId),
      schema: remove.extend({ providerId: z.uuid() }),
    },
    {
      changesAuthority: true,
      authorize: async (db) => {
        await authorize(deps, db, p, headers)
        const row = await provider(db, p.organization.id, providerId)
        if (
          !row.retired_at &&
          row.revision !== DeleteSsoProviderInput.parse(input).expectedRevision
        )
          throw changed()
        await requireUsableReplacement(db, deps.capabilities, row)
      },
      mutate: async (db) => {
        const old = await provider(db, p.organization.id, providerId)
        if (old.retired_at) return { deleted: true as const }
        await requireUsableReplacement(db, deps.capabilities, old)
        const configuration = openSsoProviderConfiguration(
          configurationKey(deps),
          { organizationId: p.organization.id, providerId, revision: old.revision },
          old.configuration,
        )
        const row = await db
          .updateTable('sso_providers')
          .set({
            enabled: false,
            retired_at: sql`clock_timestamp()`,
            revision: old.revision + 1,
            configuration: sealSsoProviderConfiguration(
              configurationKey(deps),
              { organizationId: p.organization.id, providerId, revision: old.revision + 1 },
              configuration,
            ),
          })
          .where('id', '=', providerId)
          .returningAll()
          .executeTakeFirstOrThrow()
        await changeTrust(db, p.organization.id)
        await audit(db, p, row, 'sso_provider.deleted')
        return { deleted: true as const }
      },
    },
  ).catch(uniformDenial)
}
