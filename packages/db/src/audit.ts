import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'kysely'
import type { Db } from './index.ts'

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
  'scim_user.created': [],
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
    /** A SCIM provisioning token (its ID); the credential is then `none`. */
    | 'scim_token'
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
