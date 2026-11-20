import { currentSsoRecoveryOwner, type Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled, USE_SSO_RECOVERY } from './sso.ts'
import { runWithFreshProof } from './sso-fresh-proof.ts'
import { bindingCookieName, browserBindingDigest, readBindingCookie } from './sso-mailbox-proof.ts'
import { notifySsoRecoveryUse, type SsoRecoveryEnrollmentDeps } from './sso-recovery-enrollment.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

const recoveryInput = z.strictObject({ expectedRevision: z.int().min(1).max(2_147_483_646) })
export const UseSsoRecoveryInput = recoveryInput.extend({ proofAttemptId: z.uuid().optional() })
const denied = () => new DomainError('forbidden', 'team_management_access_denied')

export async function useSsoRecovery(
  deps: SsoRecoveryEnrollmentDeps,
  principal: Principal,
  headers: Headers,
  input: z.infer<typeof UseSsoRecoveryInput>,
) {
  requireSsoEnabled(deps.capabilities)
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  const organizationId = principal.organization.id
  const userId = principal.user.id
  const access = organizationContextAccess(
    principal,
    headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
    true,
    true,
  )
  try {
    return await runWithFreshProof(
      deps,
      {
        headers,
        userId,
        sessionId: principal.sessionId,
        organizationId,
        operation: USE_SSO_RECOVERY,
        proofMode: 'mailbox',
        input,
        schema: recoveryInput,
      },
      {
        authorize: async (trx) => {
          await access(trx, organizationId)
          if (!(await currentSsoRecoveryOwner(trx, organizationId, userId))) throw denied()
          const policy = await trx
            .selectFrom('sso_policies')
            .select('policy_revision')
            .where('organization_id', '=', organizationId)
            .executeTakeFirst()
          if ((policy?.policy_revision ?? 1) !== input.expectedRevision)
            throw new DomainError('conflict', 'sso_configuration_changed')
        },
        mutate: async (trx, _input, _binding, _mailbox, attemptId) => {
          // The gate has consumed the mailbox attempt. Retain it as the only live grant
          // for this session and team, with the original mailbox proof deadline.
          await recoveryAttempts(trx, principal).where('id', '!=', attemptId).execute()
          await writeSsoAuditEvent(trx, {
            ...auditActor(principal),
            organizationId,
            action: 'sso_recovery.used',
            targetType: 'organization',
            targetId: organizationId,
            details: { correlationId: attemptId },
          })
          await notifySsoRecoveryUse(deps, trx, organizationId, headers)
        },
      },
    )
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    throw error
  }
}

type Browser = Extract<Principal, { kind: 'session' }>

function recoveryAttempts(db: Db, principal: Browser) {
  return db
    .deleteFrom('sso_attempts')
    .where('organization_id', '=', principal.organization.id)
    .where('user_id', '=', principal.user.id)
    .where('session_id', '=', principal.sessionId)
    .where('kind', '=', 'fresh_proof')
    .where('operation', '=', USE_SSO_RECOVERY)
    .where('consumed_at', 'is not', null)
}

async function liveRecoveryAuthority(db: Db, principal: Browser, binding: string, now?: string) {
  const observedAt = sql`coalesce(${now ?? null}::timestamptz, statement_timestamp())`
  const { rows } = await sql<{ id: string; deadline: string }>`
    SELECT a.id, least(a.mailbox_proof_expires_at, a.expires_at, s."expiresAt")::text AS deadline
    FROM sso_attempts a
    JOIN auth.session s ON s.id = a.session_id AND s."userId" = a.user_id
    JOIN auth."user" u ON u.id = a.user_id
    JOIN sso_recovery_owners r ON r.organization_id = a.organization_id AND r.user_id = a.user_id
    JOIN auth.member m ON m.id = r.member_id AND m."organizationId" = r.organization_id
      AND m."userId" = r.user_id
    WHERE a.organization_id = ${principal.organization.id}::uuid
      AND a.user_id = ${principal.user.id}::uuid AND a.session_id = ${principal.sessionId}::uuid
      AND a.kind = 'fresh_proof' AND a.operation = ${USE_SSO_RECOVERY}
      AND a.consumed_at IS NOT NULL AND r.accepted_at <= a.consumed_at
      AND a.browser_binding_digest = ${binding} AND a.mailbox = lower(btrim(u.email))
      AND u."emailVerified" AND lower(s."activeOrganizationId") = a.organization_id::text
      AND NOT ${scimSuspended(sql.ref('a.organization_id'), sql.ref('a.user_id'))}
      AND a.mailbox_proof_expires_at > ${observedAt} AND a.expires_at > ${observedAt}
      AND s."expiresAt" > ${observedAt}
      AND EXISTS (SELECT FROM unnest(string_to_array(m.role, ',')) AS roles(token)
        WHERE btrim(token) = 'owner')
    ORDER BY a.consumed_at DESC
    LIMIT 1`.execute(db)
  return rows[0]
}

/** Use only as a fallback on the explicitly recovery-enabled browser configuration routes. */
export async function hasSsoRecoveryAuthority(
  db: Db,
  principal: Principal,
  headers: Headers,
  publicUrl: string,
) {
  const origin = headers.get('origin')
  if (
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    (origin !== null && origin !== new URL(publicUrl).origin)
  )
    return false
  const binding = browserBindingDigest(readBindingCookie(headers, bindingCookieName(publicUrl)))
  return binding !== null && !!(await liveRecoveryAuthority(db, principal, binding))
}

/** The caller holds the organization and browser-session locks acquired by the fresh-proof gate. */
export async function consumeSsoRecoveryAuthority(
  trx: Db,
  principal: Browser,
  binding: string,
  now: string,
) {
  const authority = await liveRecoveryAuthority(trx, principal, binding, now)
  if (!authority) return
  const spent = await recoveryAttempts(trx, principal)
    .where('id', '=', authority.id)
    .returning('id')
    .executeTakeFirst()
  return spent && authority
}
