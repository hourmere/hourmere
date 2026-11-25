import {
  checkTeamManagementAccess,
  type Principal,
  TeamManagementError,
  teamRoles,
} from '@hourmere/auth'
import { localeCodes, resolveAdminLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, ssoLinkRemovalEmail } from '@hourmere/mail'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoRetained, type SsoCapabilities, ssoRetained } from './sso.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

const input = z.strictObject({ expectedLinkGeneration: z.int().min(1).max(2147483646) })
const proof = { proofAttemptId: z.uuid().optional() }
export const UnlinkSsoAccountInput = input.extend({ linkId: z.uuid(), ...proof })
export const RemoveSsoIdentityLinkInput = input.extend(proof)
export const UNLINK_SSO_ACCOUNT = 'unlinkSsoAccount'
export const REMOVE_SSO_IDENTITY_LINK = 'removeSsoIdentityLink'

const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const missing = () => new DomainError('not_found', 'sso_not_found')
const changed = () => new DomainError('conflict', 'sso_configuration_changed')

function recoveryProvider(db: Db, organizationId: string, providerId: string) {
  return db
    .selectFrom('sso_providers')
    .select(['protocol', 'revision', 'retired_at'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', providerId)
}

function requireRecoveryProtocol(
  capabilities: SsoCapabilities,
  protocol: string,
): asserts protocol is 'oidc' | 'saml' {
  // OIDC recovery survives setting-off. SAML remains unavailable while hard-off.
  if (protocol !== 'oidc' && (protocol !== 'saml' || !capabilities.ssoSamlEnabled))
    throw new DomainError('not_found', 'sso_disabled')
}

const notificationJob = 'sso-link-removal-email'
const notificationPayload = z.strictObject({ userId: z.uuid(), language: z.enum(localeCodes) })
export interface SsoLinkRemovalQueue {
  enqueue(
    name: typeof notificationJob,
    payload: z.infer<typeof notificationPayload>,
    options: EnqueueOptions,
  ): Promise<string | null>
}

export interface SsoIdentityRecoveryDeps extends FreshProofDeps {
  notificationQueue?: SsoLinkRemovalQueue | undefined
}

/** A known hard-off SAML provider takes precedence over the team's browser-proof gate. */
export async function refuseHardOffSamlLinkRemoval(
  deps: SsoIdentityRecoveryDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
) {
  const organizationId = principal.organization.id
  const expectedOrganizationId = headers.get(EXPECTED_ORGANIZATION_HEADER)?.toLowerCase()
  if (
    deps.capabilities.ssoSamlEnabled ||
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    headers.get('origin') !== new URL(deps.publicUrl).origin ||
    expectedOrganizationId !== organizationId
  )
    return
  try {
    await checkTeamManagementAccess(deps.db, principal, organizationId, false, {
      expectedOrganizationId,
      allowPersonal: false,
    })
  } catch (error) {
    if (error instanceof TeamManagementError) return
    throw error
  }
  const provider = await recoveryProvider(deps.db, organizationId, providerId).executeTakeFirst()
  if (provider) requireRecoveryProtocol(deps.capabilities, provider.protocol)
}

export function ssoLinkRemovalEmailJob({
  db,
  capabilities,
  mailer,
}: {
  db: Db
  capabilities: SsoCapabilities
  mailer: Mailer
}) {
  return defineJob({
    name: notificationJob,
    payload: notificationPayload,
    retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 60 },
    handler: async ({ userId, language }, { signal }) => {
      if (!ssoRetained(capabilities)) return
      try {
        const user = await db
          .selectFrom('auth.user')
          .select('email')
          .where('id', '=', userId)
          .where('emailVerified', '=', true)
          .executeTakeFirst()
        if (user) await mailer.send(ssoLinkRemovalEmail(user.email, language), { signal })
      } catch {
        // SMTP diagnostics can repeat the recipient address.
        throw new Error('SSO link removal email could not be sent')
      }
    },
  })
}

export async function retireSsoIdentityLink(
  deps: SsoIdentityRecoveryDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  linkId: string,
  request: z.infer<typeof RemoveSsoIdentityLinkInput>,
  operation: typeof UNLINK_SSO_ACCOUNT | typeof REMOVE_SSO_IDENTITY_LINK,
) {
  requireSsoRetained(deps.capabilities)
  if (
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    headers.get('origin') !== new URL(deps.publicUrl).origin
  )
    throw denied()
  const { id: organizationId } = principal.organization
  const expectedOrganizationId = headers.get(EXPECTED_ORGANIZATION_HEADER)?.toLowerCase()
  if (expectedOrganizationId !== organizationId)
    throw new DomainError('conflict', 'organization_context_changed')

  const self = operation === UNLINK_SSO_ACCOUNT
  const actor = { userId: principal.user.id, id: principal.sessionId }
  const findLink = (db: Db) =>
    db
      .selectFrom('sso_identity_links')
      .select(['id', 'user_id', 'generation', 'retired_at'])
      .where('organization_id', '=', organizationId)
      .where('provider_id', '=', providerId)
      .where('id', '=', linkId)
      .$if(self, (qb) => qb.where('user_id', '=', actor.userId))
  const checkAccess = (db: Db, lock: boolean) =>
    checkTeamManagementAccess(
      db,
      principal,
      organizationId,
      lock,
      { expectedOrganizationId, allowPersonal: false },
      self,
    )

  try {
    // Resolve the immutable target before taking parent locks, so the fresh-proof gate
    // can lock both accounts before the organization. Recheck the full scope under lock.
    if (!self) await checkAccess(deps.db, false)
    const affectedUserId = self
      ? actor.userId
      : (await findLink(deps.db).executeTakeFirst())?.user_id
    let target: { userId: string; revision: number; protocol: 'oidc' | 'saml' } | undefined
    return await runWithFreshProof(
      deps,
      {
        headers,
        userId: actor.userId,
        affectedUserId,
        sessionId: actor.id,
        organizationId,
        operation,
        proofMode: self ? 'mailbox' : 'trust_reduction',
        input: { ...request, providerId, linkId },
        schema: input.extend({ providerId: z.uuid(), linkId: z.uuid() }),
      },
      {
        authorize: async (trx) => {
          const actorAccess = await checkAccess(trx, true)
          const provider = await recoveryProvider(trx, organizationId, providerId)
            .forShare()
            .executeTakeFirst()
          if (!provider) throw missing()
          const { protocol } = provider
          requireRecoveryProtocol(deps.capabilities, protocol)
          if (provider.retired_at) throw missing()
          const link = await findLink(trx).forUpdate().executeTakeFirst()
          if (!link || link.retired_at || link.user_id !== affectedUserId) throw missing()
          if (!self) {
            if (link.user_id === actor.userId) throw denied()
            const member = await trx
              .selectFrom('auth.member')
              .select('role')
              .where('organizationId', '=', organizationId)
              .where('userId', '=', link.user_id)
              .forShare()
              .executeTakeFirst()
            if (!member) throw missing()
            const roles = teamRoles(member.role)
            if (
              roles.includes('owner')
                ? actorAccess.role !== 'owner'
                : !roles.includes('member') && !roles.includes('admin')
            )
              throw denied()
          }
          if (link.generation !== request.expectedLinkGeneration) throw changed()
          target = { userId: link.user_id, revision: provider.revision, protocol }
        },
        mutate: async (trx, _input, _browser, _mailbox, attemptId) => {
          if (!target || !deps.notificationQueue) throw new Error('SSO link removal is unavailable')
          // Email sign-in remains available for existing accounts even with closed signup.
          // The account's verified login mailbox is independent of the IdP and of its claims.
          const login = await trx
            .selectFrom('auth.user')
            .select('emailVerified')
            .where('id', '=', target.userId)
            .executeTakeFirst()
          if (!login?.emailVerified) throw new DomainError('conflict', 'sso_recovery_required')
          await trx
            .updateTable('sso_identity_links')
            .set({ retired_at: sql`clock_timestamp()`, generation: sql`generation + 1` })
            .where('id', '=', linkId)
            .execute()
          await trx.deleteFrom('sso_browser_proofs').where('link_id', '=', linkId).execute()
          await trx.deleteFrom('sso_delegation_bindings').where('link_id', '=', linkId).execute()
          await writeSsoAuditEvent(trx, {
            ...auditActor(principal),
            organizationId,
            targetType: 'sso_link',
            targetId: linkId,
            action: 'sso_link.unlinked',
            details: {
              method: target.protocol,
              providerId,
              revision: target.revision,
              correlationId: attemptId,
            },
          })
          const jobId = await deps.notificationQueue.enqueue(
            notificationJob,
            {
              userId: target.userId,
              language: resolveAdminLanguage({
                cookie: headers.get('cookie') ?? undefined,
                acceptLanguage: headers.get('accept-language') ?? undefined,
              }),
            },
            { transaction: trx },
          )
          if (!jobId) throw new Error('SSO link removal email could not be queued')
        },
      },
    )
  } catch (error) {
    if (error instanceof TeamManagementError)
      throw new DomainError(
        error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
        error.code,
      )
    if (error instanceof HTTPException && error.status === 403) throw denied()
    throw error
  }
}
