import { currentSsoRecoveryOwner, type Principal, teamRoles } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'
import { lockSsoDomain } from './sso-domains.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import {
  currentSsoProviderOwnerTestStatus,
  currentSsoProviderTestStatus,
} from './sso-oidc-test-receipts.ts'
import { authorizeSsoRead, ssoPolicySummary } from './sso-reads.ts'
import { consumeSsoRecoveryAuthority } from './sso-recovery-use.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

const policyInput = z.strictObject({
  expectedRevision: z.int().min(1).max(2_147_483_646),
  requireSso: z.boolean(),
  admission: z.enum(['invitation_only', 'jit']),
})
export const SetSsoPolicyInput = policyInput.extend({ proofAttemptId: z.uuid().optional() })
export type SsoPolicyDeps = FreshProofDeps

const denied = () => new DomainError('forbidden', 'team_management_access_denied')

async function getTestedProviders(db: Db, capabilities: SsoCapabilities, organizationId: string) {
  const enabled = await db
    .selectFrom('sso_providers')
    .select([
      'id',
      'protocol',
      currentSsoProviderTestStatus.as('testStatus'),
      currentSsoProviderOwnerTestStatus.as('ownerTestStatus'),
    ])
    .where('organization_id', '=', organizationId)
    .where('retired_at', 'is', null)
    .where('enabled', '=', true)
    .execute()
  const available = enabled.filter(({ protocol }) =>
    protocol === 'oidc' ? capabilities.ssoOidcEnabled : capabilities.ssoSamlEnabled,
  )
  if (enabled.length && !available.length) throw new DomainError('not_found', 'sso_disabled')
  const tested = available.filter(
    ({ testStatus, ownerTestStatus }) => testStatus === 'passed' && ownerTestStatus === 'passed',
  )
  if (!tested.length) throw new DomainError('conflict', 'sso_test_required')
  return tested.map(({ id }) => id)
}

function policyDomains(db: Db, organizationId: string, providerIds?: string[]) {
  const domains = db
    .selectFrom('sso_domains as d')
    .where('d.organization_id', '=', organizationId)
    .where('d.retired_at', 'is', null)
  if (!providerIds) return domains
  return domains.where((eb) =>
    eb.exists(
      eb
        .selectFrom('sso_provider_domains as pd')
        .select('pd.domain_id')
        .whereRef('pd.organization_id', '=', 'd.organization_id')
        .whereRef('pd.domain_id', '=', 'd.id')
        .where('pd.provider_id', 'in', providerIds),
    ),
  )
}

async function requireVerifiedDomain(domains: ReturnType<typeof policyDomains>) {
  const verified = await domains
    .select('d.id')
    .where('d.verified_at', 'is not', null)
    .where('d.verification_expires_at', '>', sql<Date>`clock_timestamp()`)
    .where('d.last_check_outcome', '=', 'positive')
    .limit(1)
    .executeTakeFirst()
  if (!verified) throw new DomainError('conflict', 'sso_domain_unverified')
}

export async function setSsoPolicy(
  deps: SsoPolicyDeps,
  principal: Principal,
  headers: Headers,
  input: z.infer<typeof SetSsoPolicyInput>,
  recoveryRequired = false,
) {
  requireSsoEnabled(deps.capabilities)
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  const organizationId = principal.organization.id
  const access = organizationContextAccess(
    principal,
    headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
    true,
    true,
  )
  let before: ReturnType<typeof ssoPolicySummary>
  let domains: ReturnType<typeof policyDomains> | undefined
  let eligibleForRecovery = false
  const recoveryDenied = () => new DomainError('forbidden', 'sso_required')
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: principal.user.id,
      sessionId: principal.sessionId,
      organizationId,
      operation: 'setSsoPolicy',
      proofMode: 'administration',
      input,
      schema: policyInput,
    },
    {
      // Check pre-change authority even when enabling, which changes the proof required by the
      // enclosing team write check before this mailbox-authorized transaction can commit.
      changesAuthority: true,
      authorize: async (trx) => {
        await authorizeSsoRead({ ...deps, db: trx }, principal)
        await access(trx, organizationId)
        const stored = await trx
          .selectFrom('sso_policies')
          .select(['require_sso', 'admission', 'policy_revision', 'trust_generation'])
          .where('organization_id', '=', organizationId)
          .forUpdate()
          .executeTakeFirst()
        before = ssoPolicySummary(stored)
        const enablesJit = input.admission === 'jit' && before.admission !== 'jit'
        eligibleForRecovery = before.requireSso && !input.requireSso && !enablesJit
        if (recoveryRequired && !eligibleForRecovery) throw recoveryDenied()
        if (input.requireSso !== before.requireSso) {
          const member = await trx
            .selectFrom('auth.member')
            .select('role')
            .where('organizationId', '=', organizationId)
            .where('userId', '=', principal.user.id)
            .executeTakeFirst()
          if (!teamRoles(member?.role).includes('owner')) throw denied()
        }
        if (input.expectedRevision !== before.policyRevision)
          throw new DomainError('conflict', 'sso_configuration_changed')
        const enablesEnforcement = input.requireSso && !before.requireSso
        if (!enablesEnforcement && !enablesJit) return
        const testedProviders = enablesEnforcement
          ? await getTestedProviders(trx, deps.capabilities, organizationId)
          : undefined
        domains = policyDomains(trx, organizationId, testedProviders)
        // The recheck worker takes only the domain-name lock. Read verification after waiting.
        const names = await domains.select('d.name').orderBy('d.name').execute()
        for (const { name } of names) await lockSsoDomain(trx, name)
        await requireVerifiedDomain(domains)
        if (enablesEnforcement && !(await currentSsoRecoveryOwner(trx, organizationId)))
          throw new DomainError('conflict', 'sso_recovery_required')
      },
      consumeRecovery: async (trx, binding, now) => {
        if (!eligibleForRecovery || (!recoveryRequired && input.proofAttemptId !== undefined))
          return
        const authority = await consumeSsoRecoveryAuthority(trx, principal, binding, now)
        if (!authority && recoveryRequired) throw recoveryDenied()
        return authority
      },
      mutate: async (trx) => {
        // A verified claim can expire during proof consumption.
        if (domains) await requireVerifiedDomain(domains)
        const enforcementChanged = before.requireSso !== input.requireSso
        if (!enforcementChanged && before.admission === input.admission) return before
        const values = {
          require_sso: input.requireSso,
          admission: input.admission,
          policy_revision: before.policyRevision + 1,
          trust_generation:
            before.trustGeneration + Number(enforcementChanged && !input.requireSso),
        }
        await trx
          .insertInto('sso_policies')
          .values({ organization_id: organizationId, ...values })
          .onConflict((conflict) => conflict.column('organization_id').doUpdateSet(values))
          .execute()
        await writeSsoAuditEvent(trx, {
          ...auditActor(principal),
          organizationId,
          action: enforcementChanged
            ? input.requireSso
              ? 'sso_enforcement.enabled'
              : 'sso_enforcement.disabled'
            : 'sso_enforcement.updated',
          targetType: 'organization',
          targetId: organizationId,
          details: { revision: values.policy_revision },
        })
        return ssoPolicySummary(values)
      },
    },
  ).catch((error: unknown) => {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    throw error
  })
}
