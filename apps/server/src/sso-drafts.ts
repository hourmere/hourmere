import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled } from './sso.ts'
import { openSsoProviderConfiguration, sealSsoProviderConfiguration } from './sso-configuration.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { authorizeSsoRead } from './sso-reads.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

export interface SsoDraftDeps extends FreshProofDeps {
  configurationKey?: Buffer | undefined
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
  protocol: z.literal('oidc'),
  displayName: z.string().trim().min(1).max(100),
  domainIds: domains,
  oidc,
})
const update = z.strictObject({
  expectedRevision: z.number().int().min(1).max(2147483646),
  displayName: z.string().trim().min(1).max(100).optional(),
  domainIds: domains.optional(),
  oidc: oidc.partial().optional(),
})
const remove = z.strictObject({ expectedRevision: z.number().int().min(1).max(2147483646) })
const proof = { proofAttemptId: z.uuid().optional() }
export const CreateSsoProviderInput = create.extend({
  ...proof,
  protocol: z.enum(['oidc', 'saml']),
  oidc: oidc.optional(),
  saml: z.unknown().optional(),
})
export const UpdateSsoProviderInput = update.extend({ ...proof, saml: z.unknown().optional() })
export const DeleteSsoProviderInput = remove.extend(proof)
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
function uniformDenial(error: unknown): never {
  if (error instanceof HTTPException && error.status === 403) throw denied()
  throw error
}
const changed = () => new DomainError('conflict', 'sso_configuration_changed')
const missing = () => new DomainError('not_found', 'sso_not_found')

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
    hasClientSecret: true,
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
function enabled(deps: SsoDraftDeps, principal: Principal, input: unknown) {
  requireSsoEnabled(deps.capabilities)
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  if (
    input &&
    typeof input === 'object' &&
    (('protocol' in input && input.protocol === 'saml') || 'saml' in input)
  )
    throw new DomainError('not_found', 'sso_disabled')
  if (!deps.capabilities.ssoOidcEnabled) throw new DomainError('not_found', 'sso_disabled')
  return principal
}
async function authorize(deps: SsoDraftDeps, db: Db, principal: Principal, headers: Headers) {
  await authorizeSsoRead({ ...deps, db }, principal)
  await organizationContextAccess(
    principal,
    headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
    true,
    true,
  )(db, principal.organization.id)
}
async function audit(
  db: Db,
  principal: Principal,
  row: Provider,
  action:
    | 'sso_provider.created'
    | 'sso_provider.updated'
    | 'sso_provider.deleted'
    | 'sso_provider.secret_rotated',
) {
  await writeSsoAuditEvent(db, {
    ...auditActor(principal),
    organizationId: principal.organization.id,
    action,
    targetType: 'sso_provider',
    targetId: row.id,
    details: { method: 'oidc', providerId: row.id, revision: row.revision },
  })
}

export async function createSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  input: unknown,
) {
  const p = enabled(deps, principal, input)
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
      authorize: async (db) => {
        await authorize(deps, db, p, headers)
        const parsed = CreateSsoProviderInput.parse(input)
        await checkDomains(db, p.organization.id, parsed.domainIds)
      },
      mutate: async (db, raw) => {
        const value = create.parse(raw)
        const { id } = await db
          .selectNoFrom(sql<string>`uuidv7()`.as('id'))
          .executeTakeFirstOrThrow()
        const row = await db
          .insertInto('sso_providers')
          .values({
            id,
            organization_id: p.organization.id,
            protocol: 'oidc',
            display_name: value.displayName,
            issuer: value.oidc.issuer,
            client_id: value.oidc.clientId,
            configuration: sealSsoProviderConfiguration(
              configurationKey(deps),
              { organizationId: p.organization.id, providerId: id, revision: 1 },
              JSON.stringify(value.oidc),
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

export async function updateSsoProvider(
  deps: SsoDraftDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: unknown,
) {
  const p = enabled(deps, principal, input)
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
      authorize: async (db) => {
        await authorize(deps, db, p, headers)
        const row = await provider(db, p.organization.id, providerId)
        if (row.retired_at) throw missing()
        if (row.protocol !== 'oidc') throw new DomainError('not_found', 'sso_disabled')
        const value = UpdateSsoProviderInput.parse(input)
        if (row.revision !== value.expectedRevision) throw changed()
        if (
          (value.oidc?.issuer !== undefined && value.oidc.issuer !== row.issuer) ||
          (value.oidc?.clientId !== undefined && value.oidc.clientId !== row.client_id)
        )
          throw new DomainError('invalid', 'invalid_request')
        await checkDomains(db, p.organization.id, value.domainIds)
      },
      mutate: async (db, raw) => {
        const { providerId: _providerId, ...body } = raw
        const value = update.parse(body)
        const old = await provider(db, p.organization.id, providerId)
        const before = JSON.parse(
          openSsoProviderConfiguration(
            configurationKey(deps),
            { organizationId: p.organization.id, providerId, revision: old.revision },
            old.configuration,
          ),
        )
        const configuration = { ...before, ...value.oidc }
        const oldDomains = await db
          .selectFrom('sso_provider_domains')
          .select('domain_id')
          .where('provider_id', '=', providerId)
          .execute()
        const trustChanged =
          JSON.stringify(configuration) !== JSON.stringify(before) ||
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
  const p = enabled(deps, principal, input)
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'deleteSsoProvider',
      input: boundInput(input, providerId),
      schema: remove.extend({ providerId: z.uuid() }),
    },
    {
      authorize: async (db) => {
        await authorize(deps, db, p, headers)
        const row = await provider(db, p.organization.id, providerId)
        if (row.protocol !== 'oidc') throw new DomainError('not_found', 'sso_disabled')
        if (
          !row.retired_at &&
          row.revision !== DeleteSsoProviderInput.parse(input).expectedRevision
        )
          throw changed()
      },
      mutate: async (db) => {
        const old = await provider(db, p.organization.id, providerId)
        if (old.retired_at) return { deleted: true as const }
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
