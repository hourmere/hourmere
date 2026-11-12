import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'kysely'
import type { Db } from './index.ts'
import {
  isSsoAuditAction,
  isSsoSecurityFailureAction,
  redactSsoSecurityFailure,
  SSO_AUDIT_LIMITS,
  SSO_AUDIT_TARGET_ID,
  type SsoAuditDetails,
  type SsoChangeAction,
  type SsoSecurityFailureInput,
  ssoAuditDetailsProblem,
} from './sso-audit.ts'

export type {
  SsoAuditAction,
  SsoAuditDetails,
  SsoAuditMethod,
  SsoAuditReason,
  SsoChangeAction,
  SsoSecurityFailureAction,
} from './sso-audit.ts'

/** Stable names. Detail keys are explicitly allow-listed per action. */
export const auditDetails = {
  'membership.invited': [],
  'membership.accepted': [],
  'membership.removed': [],
  'membership.left': [],
  'membership.role_changed': ['oldRole', 'newRole'],
  'organization.ownership_transferred': [],
  'organization.updated': [],
  'organization.created': [],
  'organization.branding_updated': ['logo', 'primaryColor'],
  'membership.invitation_cancelled': [],
  'membership.invitation_rejected': [],
  'api_key.created': ['scope'],
  'api_key.updated': [],
  'api_key.rotated': ['scope'],
  'api_key.revoked': [],
  'api_key.reenabled': [],
  'scim_token.created': [],
  'scim_token.rotated': [],
  'scim_token.revoked': [],
  'webhook.created': ['events'],
  'webhook.updated': ['events'],
  'webhook.deleted': ['events'],
  'webhook.secret_rotated': ['events'],
  'webhook.paused': ['events'],
  'webhook.resumed': ['events'],
  'slack_destination.created': ['events'],
  'slack_destination.updated': ['events'],
  'slack_destination.deleted': ['events'],
  'slack_destination.paused': ['events'],
  'slack_destination.resumed': ['events'],
  'slack_destination.tested': ['events'],
  'oauth.client_registered': [],
  'oauth.consent_granted': [],
  'oauth.token_revoked': ['familySize'],
  'session.revoked': [],
  'sign_in_method.added': [],
  'sign_in_method.removed': [],
  'booking.created': [],
  'booking.rescheduled': [],
  'booking.cancelled': [],
  'booking.reschedule_requested': [],
  'booking.attendee_no_show_changed': ['attendeeId', 'noShow'],
  'event_type.created': [],
  'event_type.updated': [],
  'event_type.deleted': [],
  'event_type.notifications_updated': [],
  'event_type.waitlist_updated': [],
  'event_type.round_robin_activated': [],
} as const
export type AuditAction = keyof typeof auditDetails
export interface AuditActor {
  type:
    | 'user'
    | 'api_key'
    | 'oauth_client'
    | 'system'
    | 'anonymous'
    | 'external_api_key'
    | 'external_oauth_client'
    | 'external_user'
  id?: string
}
export interface AuditCredential {
  type: 'session' | 'api_key' | 'oauth' | 'none'
  id?: string
  scope?: string
  clientId?: string
  grantId?: string
}
export interface AuditEvent {
  organizationId: string | null
  actor: AuditActor
  credential: AuditCredential
  action: AuditAction
  targetType: string
  targetId: string
  details?: Record<string, unknown>
  requestId?: string | null | undefined
}
export type AuditPrincipal = { user: { id: string } } & (
  | { kind: 'session'; sessionId: string }
  | { kind: 'api_key'; apiKeyId: string; apiKeyScope: string }
  | { kind: 'oauth'; oauthConsentId: string; clientId: string }
)
export function auditActor(principal: AuditPrincipal): Pick<AuditEvent, 'actor' | 'credential'> {
  if (principal.kind === 'api_key')
    return {
      actor: { type: 'api_key', id: principal.apiKeyId },
      credential: { type: 'api_key', id: principal.apiKeyId, scope: principal.apiKeyScope },
    }
  if (principal.kind === 'oauth')
    return {
      actor: { type: 'user', id: principal.user.id },
      credential: {
        type: 'oauth',
        clientId: principal.clientId,
        grantId: principal.oauthConsentId,
      },
    }
  return {
    actor: { type: 'user', id: principal.user.id },
    credential: { type: 'session', id: principal.sessionId },
  }
}

const requestContext = new AsyncLocalStorage<string>()
export function withAuditRequest<T>(requestId: string, fn: () => T): T {
  return requestContext.run(requestId, fn)
}

/** One INSERT, using the caller's transaction. Never swallow audit failures. */
export async function writeAuditEvent(trx: Db, event: AuditEvent): Promise<void> {
  if (!trx.isTransaction) throw new Error('Audit writes require a transaction')
  const allowed: readonly string[] | undefined = auditDetails[event.action]
  const details = event.details ?? {}
  if (!allowed || Object.keys(details).some((key) => !allowed.includes(key))) {
    throw new Error('Audit details are not allow-listed for this action')
  }
  await insertAuditEvent(trx, event, details)
}

async function insertAuditEvent(
  trx: Db,
  event: Omit<AuditEvent, 'action'> & { action: string },
  details: Record<string, unknown>,
): Promise<void> {
  await sql`INSERT INTO audit_events
    (organization_id, actor_type, actor_id, credential_type, credential_id, credential_scope,
     oauth_client_id, oauth_grant_id, action, target_type, target_id, details, request_id)
    VALUES (${event.organizationId}, ${event.actor.type}, ${event.actor.id ?? null},
      ${event.credential.type}, ${event.credential.id ?? null}, ${event.credential.scope ?? null},
      ${event.credential.clientId ?? null}, ${event.credential.grantId ?? null}, ${event.action},
      ${event.targetType}, ${event.targetId}, ${JSON.stringify(details)}::jsonb, ${event.requestId ?? requestContext.getStore() ?? null})`.execute(
    trx,
  )
}

/** An SSO change event; `details` holds only the action's allow-listed keys (sso-audit.ts). */
export interface SsoAuditEvent<A extends SsoChangeAction = SsoChangeAction>
  extends Omit<AuditEvent, 'action' | 'details'> {
  action: A
  details: SsoAuditDetails<A>
}

/**
 * Records an SSO change in the transaction that makes it, so the two commit or roll back
 * together. Keys outside the action's allow-list, missing keys and unsafe values are refused
 * before the INSERT; the database checks them again. The target is a stored ID. Security
 * failures are not changes: they go through `writeSsoSecurityFailure`.
 */
export async function writeSsoAuditEvent<A extends SsoChangeAction>(
  trx: Db,
  event: SsoAuditEvent<A>,
): Promise<void> {
  if (!trx.isTransaction) throw new Error('Audit writes require a transaction')
  if (!isSsoAuditAction(event.action) || isSsoSecurityFailureAction(event.action))
    throw new Error('Audit details are not allow-listed for this action')
  if (typeof event.targetId !== 'string' || !SSO_AUDIT_TARGET_ID.test(event.targetId))
    throw new Error('SSO audit targets are stored IDs')
  const problem = ssoAuditDetailsProblem(event.action, event.details)
  if (problem === 'keys') throw new Error('Audit details are not allow-listed for this action')
  if (problem === 'values') throw new Error('SSO audit detail values are not allowed')
  await insertAuditEvent(trx, event, event.details as Record<string, unknown>)
}

/** An SSO security failure: who failed against which provider, never what they presented. */
export interface SsoSecurityFailure extends SsoSecurityFailureInput {
  organizationId: string
  actor: AuditActor
  credential: AuditCredential
  requestId?: string | null | undefined
}
const failureFields = new Set([
  'organizationId',
  'actor',
  'credential',
  'requestId',
  'action',
  'method',
  'providerId',
  'revision',
  'reason',
  'correlationId',
])

/** The advisory-lock scope that serializes one provider's failures of one source. */
export const ssoSecurityFailureScope = (
  failure: Pick<SsoSecurityFailure, 'organizationId' | 'providerId' | 'action'>,
) =>
  `hourmere.sso-security-failure:${failure.organizationId.toLowerCase()}:${failure.providerId}:${failure.action}`

/**
 * Records a security failure, which has no business transaction, in a short transaction of its
 * own, so the request's rollback does not remove it. The target is the provider. Details are
 * redacted (`redactSsoSecurityFailure`). At most `ssoSecurityFailureEvents` failures are
 * recorded per provider and source (the failure action) within `ssoSecurityFailureWindow`
 * seconds; the rest are dropped so that failed attempts cannot flood the journal. Returns
 * whether the failure was recorded.
 */
export async function writeSsoSecurityFailure(
  db: Db,
  failure: SsoSecurityFailure,
): Promise<boolean> {
  if (db.isTransaction)
    throw new Error('SSO security failures are written in a transaction of their own')
  if (
    !isSsoSecurityFailureAction(failure.action) ||
    typeof failure.organizationId !== 'string' ||
    Object.keys(failure).some((key) => !failureFields.has(key))
  )
    throw new Error('Audit details are not allow-listed for this action')
  const details = redactSsoSecurityFailure(failure)
  if (ssoAuditDetailsProblem(failure.action, details) !== null)
    throw new Error('SSO audit detail values are not allowed')
  const { ssoSecurityFailureEvents: limit, ssoSecurityFailureWindow: window } = SSO_AUDIT_LIMITS
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ssoSecurityFailureScope(failure)}, 0))`.execute(
      trx,
    )
    const recent = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (
        SELECT 1 FROM audit_events
        WHERE organization_id = ${failure.organizationId} AND action = ${failure.action}
          AND target_type = 'sso_provider' AND target_id = ${failure.providerId}
          AND occurred_at > clock_timestamp() - ${window} * interval '1 second'
        LIMIT ${limit}) recent`.execute(trx)
    if ((recent.rows[0]?.n ?? 0) >= limit) return false
    await insertAuditEvent(
      trx,
      { ...failure, targetType: 'sso_provider', targetId: failure.providerId },
      details,
    )
    return true
  })
}
