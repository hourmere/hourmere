import {
  checkTeamManagementAccess,
  MCP_OAUTH_CONSENT_LIFETIME_MS,
  MCP_OAUTH_SCOPE,
  mcpOAuthUrls,
  type Principal,
  parsePersistedApiKeyMetadata,
  TeamManagementError,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled } from './sso.ts'
import { BIND_SSO_DELEGATION, openDelegationProof } from './sso-delegation-proof.ts'
import { normalizeSsoDomain } from './sso-domains.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { browserBindingDigest, databaseClock } from './sso-mailbox-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

export const REVOKE_SSO_DELEGATION = 'revokeSsoDelegation'
export const ssoDelegationLifetime = 2_592_000 // Seconds.

const bindingInput = z.strictObject({
  credentialKind: z.enum(['api_key', 'oauth_grant']),
  credentialId: z.uuid(),
  expectedTrustGeneration: z.int().positive().max(2_147_483_647),
})
export const BindSsoDelegationInput = bindingInput.extend({ proofAttemptId: z.uuid().optional() })

export interface SsoDelegationDeps extends FreshProofDeps {
  configurationKey?: Buffer | undefined
}

const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const missing = () => new DomainError('not_found', 'sso_not_found')
const changed = () => new DomainError('conflict', 'sso_configuration_changed')
const invalidProof = () => new DomainError('invalid', 'sso_oidc_completion_invalid')
const unverified = () => new DomainError('conflict', 'sso_domain_unverified')

function delegationActor(deps: SsoDelegationDeps, principal: Principal, headers: Headers) {
  if (
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    headers.get('origin') !== new URL(deps.publicUrl).origin
  )
    throw denied()
  const organizationId = principal.organization.id
  const expectedOrganizationId = headers.get(EXPECTED_ORGANIZATION_HEADER)?.toLowerCase()
  if (expectedOrganizationId !== organizationId)
    throw new DomainError('conflict', 'organization_context_changed')
  return { principal, organizationId, expectedOrganizationId, userId: principal.user.id }
}

type DelegationActor = ReturnType<typeof delegationActor>

async function lockActor(
  trx: Db,
  { principal, organizationId, expectedOrganizationId }: DelegationActor,
) {
  try {
    await checkTeamManagementAccess(
      trx,
      principal,
      organizationId,
      true,
      { expectedOrganizationId, allowPersonal: false },
      true,
    )
  } catch (error) {
    if (!(error instanceof TeamManagementError)) throw error
    throw new DomainError(
      error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
      error.code,
    )
  }
}

async function lockCredential(
  trx: Db,
  { userId, organizationId }: DelegationActor,
  { credentialKind, credentialId }: z.infer<typeof bindingInput>,
  publicUrl: string,
) {
  if (credentialKind === 'api_key') {
    const key = await trx
      .selectFrom('auth.apikey')
      .select(['metadata', 'expiresAt'])
      .where('id', '=', credentialId)
      .where('referenceId', '=', userId)
      .where(sql<boolean>`enabled IS DISTINCT FROM false`)
      .forShare()
      .executeTakeFirst()
    const metadata = key && parsePersistedApiKeyMetadata(key.metadata)
    if (!key || metadata?.organizationId?.toLowerCase() !== organizationId) throw missing()
    return { column: 'api_key_id' as const, expiresAt: key.expiresAt }
  }

  // OAuth revocation deletes consent before the grant. Lock those rows in the same order.
  const consent = await trx
    .selectFrom('auth.oauthConsent as c')
    .innerJoin('mcp_oauth_grants as g', (join) =>
      join.on(sql<boolean>`c."referenceId" = g.id::text`),
    )
    .innerJoin('auth.oauthClient as a', 'a.clientId', 'g.client_id')
    .select(['g.client_id', 'c.createdAt', 'c.scopes', 'c.resources'])
    .where('g.id', '=', credentialId)
    .where('g.user_id', '=', userId)
    .where('g.organization_id', '=', organizationId)
    .whereRef('c.userId', '=', 'g.user_id')
    .whereRef('c.clientId', '=', 'g.client_id')
    .where(sql<boolean>`a.disabled IS DISTINCT FROM true`)
    .forShare('c')
    .executeTakeFirst()
  if (
    !consent ||
    !Array.isArray(consent.scopes) ||
    !consent.scopes.includes(MCP_OAUTH_SCOPE) ||
    !Array.isArray(consent.resources) ||
    !consent.resources.includes(mcpOAuthUrls(publicUrl).resource)
  )
    throw missing()
  const grant = await trx
    .selectFrom('mcp_oauth_grants')
    .select('id')
    .where('id', '=', credentialId)
    .where('user_id', '=', userId)
    .where('organization_id', '=', organizationId)
    .where('client_id', '=', consent.client_id)
    .forShare()
    .executeTakeFirst()
  if (!grant) throw missing()
  return {
    column: 'oauth_grant_id' as const,
    expiresAt: new Date(consent.createdAt.getTime() + MCP_OAUTH_CONSENT_LIFETIME_MS),
  }
}

async function lockReliance(trx: Db, actor: DelegationActor, attemptId: string) {
  const { organizationId, userId } = actor
  return trx
    .selectFrom('sso_attempts as a')
    .innerJoin('sso_identity_links as l', 'l.id', 'a.step_up_link_id')
    .innerJoin('sso_providers as p', 'p.id', 'a.step_up_provider_id')
    .innerJoin('auth.member as m', (join) =>
      join.onRef('m.userId', '=', 'l.user_id').onRef('m.organizationId', '=', 'l.organization_id'),
    )
    .select([
      'l.id as linkId',
      'l.generation as linkGeneration',
      'l.proven_email as mailbox',
      'p.id as providerId',
      'p.revision',
      'm.id as memberId',
      'a.expires_at as attemptDeadline',
      'a.step_up_proof_expires_at as stepUpDeadline',
      'a.mailbox_proof_expires_at as mailboxDeadline',
    ])
    .where('a.id', '=', attemptId)
    .where('l.user_id', '=', userId)
    .where('l.organization_id', '=', organizationId)
    .where('l.retired_at', 'is', null)
    .where('p.protocol', '=', 'oidc')
    .where('p.enabled', '=', true)
    .where('p.retired_at', 'is', null)
    .forShare(['l', 'p', 'm'])
    .executeTakeFirst()
}

async function lockClaim(trx: Db, organizationId: string, providerId: string, mailbox: string) {
  const domain = normalizeSsoDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1))
  if (!domain) throw unverified()
  const claim = await trx
    .selectFrom('sso_domains as d')
    .innerJoin('sso_provider_domains as pd', (join) =>
      join.onRef('pd.domain_id', '=', 'd.id').onRef('pd.organization_id', '=', 'd.organization_id'),
    )
    .select(['d.id', 'd.generation', 'd.verification_expires_at'])
    .where('pd.provider_id', '=', providerId)
    .where('d.organization_id', '=', organizationId)
    .where('d.name', '=', domain)
    .where('d.retired_at', 'is', null)
    .where('d.verified_at', 'is not', null)
    .where('d.verification_expires_at', '>', sql<Date>`clock_timestamp()`)
    .forShare(['d', 'pd'])
    .executeTakeFirst()
  if (!claim) throw unverified()
  return claim
}

export async function bindSsoDelegation(
  deps: SsoDelegationDeps,
  principal: Principal,
  headers: Headers,
  input: z.infer<typeof BindSsoDelegationInput>,
  envelope: string | undefined,
) {
  requireSsoEnabled(deps.capabilities, 'oidc')
  const actor = delegationActor(deps, principal, headers)
  const { organizationId, userId } = actor
  let credential: Awaited<ReturnType<typeof lockCredential>>
  try {
    return await runWithFreshProof(
      deps,
      {
        headers,
        userId,
        sessionId: actor.principal.sessionId,
        organizationId,
        operation: BIND_SSO_DELEGATION,
        proofMode: 'sso',
        schema: bindingInput,
        input,
      },
      {
        authorize: async (trx) => {
          await lockActor(trx, actor)
          credential = await lockCredential(trx, actor, input, deps.publicUrl)
          const policy = await trx
            .selectFrom('sso_policies')
            .select('trust_generation')
            .where('organization_id', '=', organizationId)
            .forShare()
            .executeTakeFirst()
          if ((policy?.trust_generation ?? 1) !== input.expectedTrustGeneration) throw changed()
          if (credential.expiresAt && credential.expiresAt <= new Date(await databaseClock(trx)))
            throw missing()
        },
        mutate: async (trx, _input, browserBinding, _mailbox, attemptId) => {
          const link = await lockReliance(trx, actor, attemptId)
          const digest = browserBindingDigest(browserBinding)
          if (!link || !digest) throw invalidProof()
          const proof = openDelegationProof(
            deps.configurationKey,
            { organizationId, providerId: link.providerId, revision: link.revision },
            attemptId,
            digest,
            envelope,
          )
          if (!proof || proof.linkGeneration !== link.linkGeneration) throw invalidProof()
          const claim = await lockClaim(trx, organizationId, link.providerId, link.mailbox)
          const now = await databaseClock(trx)
          const checkedAt = new Date(now)
          if (!claim.verification_expires_at || claim.verification_expires_at <= checkedAt)
            throw unverified()
          if (credential.expiresAt && credential.expiresAt <= checkedAt) throw missing()
          if (
            link.attemptDeadline <= checkedAt ||
            !link.stepUpDeadline ||
            link.stepUpDeadline <= checkedAt ||
            (link.mailboxDeadline && link.mailboxDeadline <= checkedAt) ||
            (proof.sessionDeadline && new Date(proof.sessionDeadline) <= checkedAt)
          )
            throw invalidProof()

          // A rebind replaces the owned credential's prior lease, including after an
          // API key moved teams through its native settings. Revokes still name the old ID.
          await trx
            .deleteFrom('sso_delegation_bindings')
            .where(credential.column, '=', input.credentialId)
            .where('user_id', '=', userId)
            .execute()
          const binding = await trx
            .insertInto('sso_delegation_bindings')
            .values({
              organization_id: organizationId,
              user_id: userId,
              member_id: link.memberId,
              [credential.column]: input.credentialId,
              provider_id: link.providerId,
              link_id: link.linkId,
              link_generation: link.linkGeneration,
              trust_generation: input.expectedTrustGeneration,
              domain_id: claim.id,
              domain_generation: claim.generation,
              created_at: now,
              expires_at: sql<Date>`least(
                ${now}::timestamptz + make_interval(secs => ${ssoDelegationLifetime}),
                ${credential.expiresAt}::timestamptz,
                ${proof.sessionDeadline ?? null}::timestamptz
              )`,
            })
            .returning(['id', 'expires_at'])
            .executeTakeFirstOrThrow()
          await writeSsoAuditEvent(trx, {
            ...auditActor(principal),
            organizationId,
            action: 'sso_delegation.bound',
            targetType: 'sso_delegation',
            targetId: binding.id,
            details: {
              method: 'oidc',
              providerId: link.providerId,
              revision: link.revision,
              correlationId: attemptId,
            },
          })
          return { id: binding.id, expiresAt: binding.expires_at.toISOString() }
        },
      },
    )
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    if (error instanceof Error && 'constraint' in error) {
      if (error.constraint === 'sso_reliance_domain') throw unverified()
      if (error.constraint === 'sso_reliance_live' || error.constraint === 'sso_attempts_proven')
        throw invalidProof()
    }
    throw error
  }
}

export async function revokeSsoDelegation(
  deps: SsoDelegationDeps,
  principal: Principal,
  headers: Headers,
  bindingId: string,
) {
  requireSsoEnabled(deps.capabilities)
  const actor = delegationActor(deps, principal, headers)
  const { organizationId, userId } = actor
  await deps.db.transaction().execute(async (trx) => {
    await lockActor(trx, actor)
    const binding = await trx
      .deleteFrom('sso_delegation_bindings')
      .where('id', '=', bindingId)
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', userId)
      .returning(['id', 'provider_id'])
      .executeTakeFirst()
    if (!binding) throw missing()
    const provider = await trx
      .selectFrom('sso_providers')
      .select(['protocol', 'revision'])
      .where('id', '=', binding.provider_id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirstOrThrow()
    await writeSsoAuditEvent(trx, {
      ...auditActor(principal),
      organizationId,
      action: 'sso_delegation.revoked',
      targetType: 'sso_delegation',
      targetId: binding.id,
      details: {
        method: z.enum(['oidc', 'saml']).parse(provider.protocol),
        providerId: binding.provider_id,
        revision: provider.revision,
      },
    })
  })
}
