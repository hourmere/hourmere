// The injected workflow audit port (docs/workflows.md, "Permissions, persistence and audit").
// All events use the shared audit journal inside the transition transaction.

import type { Db } from '@hourmere/db'
import { type AuditPrincipal, auditActor, writeAuditEvent } from '@hourmere/db/audit'
import type { WorkflowTriggerType } from './definition.ts'
import type { WorkflowOwner } from './ownership.ts'

/** Every workflow audit event: definition changes, preview, scheduling and delivery. */
export const WORKFLOW_AUDIT_EVENTS = Object.freeze([
  'workflow.created',
  'workflow.updated',
  'workflow.enabled',
  'workflow.disabled',
  'workflow.deleted',
  'workflow.previewed',
  'workflow.run_scheduled',
  'workflow.run_cancelled',
  'workflow.run_skipped',
  'workflow.email_attempted',
  'workflow.email_sent',
  'workflow.email_rejected',
  'workflow.email_delivery_unknown',
  'workflow.webhook_queued',
  'workflow.webhook_completed',
  'workflow.webhook_failed',
] as const)
export type WorkflowAuditEvent = (typeof WORKFLOW_AUDIT_EVENTS)[number]

/** Fixed skip reasons a run can end with; history and audit carry the code, never details. */
export const WORKFLOW_SKIP_REASONS = Object.freeze([
  'condition_false',
  'existing_notification',
  'minimum_gap',
  'offset_not_future',
  'expired',
  'budget_suppressed',
  'render_limit',
  'workflow_disabled',
  'instance_disabled',
] as const)
export type WorkflowSkipReason = (typeof WORKFLOW_SKIP_REASONS)[number]

const BACKGROUND_ACTOR_IDS = {
  capture: 'workflow-capture',
  dispatch: 'workflow-dispatch',
  repair: 'workflow-repair',
} as const

/** Who caused the event. Background work names its job explicitly instead of a person. */
export type WorkflowAuditActor =
  | AuditPrincipal
  | { kind: 'background'; job: keyof typeof BACKGROUND_ACTOR_IDS }

/** Project the authenticated principal to the identifiers used by the shared audit policy. */
export function workflowAuditActor(principal: AuditPrincipal): AuditPrincipal {
  const user = { id: principal.user.id }
  switch (principal.kind) {
    case 'session':
      return { user, kind: principal.kind, sessionId: principal.sessionId }
    case 'api_key':
      return {
        user,
        kind: principal.kind,
        apiKeyId: principal.apiKeyId,
        apiKeyScope: principal.apiKeyScope,
      }
    case 'oauth':
      return {
        user,
        kind: principal.kind,
        clientId: principal.clientId,
        oauthConsentId: principal.oauthConsentId,
      }
  }
}

/**
 * One audit record: actor, owner scope, workflow and revision identity, a fixed reason and the
 * instant. There is deliberately no free-form field: no bodies, answers, addresses, raw URLs or
 * secrets can reach the audit trail through this type.
 */
export interface WorkflowAuditRecord {
  event: WorkflowAuditEvent
  occurredAt: Temporal.Instant
  actor: WorkflowAuditActor
  owner: WorkflowOwner
  /** Null only for a preview of a candidate that has no stored identity. */
  workflowId: string | null
  revision: number | null
  trigger?: WorkflowTriggerType | undefined
  reason?: WorkflowSkipReason | undefined
}

/**
 * Records audit events inside the caller's transaction. The transition's replay fence
 * determines whether to write an event.
 */
export interface WorkflowAuditPort {
  record(trx: Db, record: WorkflowAuditRecord): Promise<void>
}

/** Project workflow records onto the shared journal's actor, scope and safe details. */
async function recordWorkflowAudit(trx: Db, record: WorkflowAuditRecord): Promise<void> {
  const { actor, event, owner, reason, revision, trigger, workflowId } = record
  const organizationId = owner.organizationId
  switch (event) {
    case 'workflow.previewed':
      if (actor.kind === 'background') throw new Error('Workflow preview audit requires a caller')
      if (trigger === undefined) throw new Error('Workflow preview audit requires a trigger')
      return writeAuditEvent(trx, {
        ...auditActor(actor),
        organizationId,
        action: event,
        targetType: 'workflow_preview',
        targetId: organizationId,
        details: { trigger, ...(reason === 'condition_false' && { reason }) },
      })
    case 'workflow.created':
    case 'workflow.updated':
    case 'workflow.enabled':
    case 'workflow.disabled':
    case 'workflow.deleted':
      if (actor.kind === 'background')
        throw new Error('Workflow definition audit requires a caller')
      if (workflowId === null || revision === null)
        throw new Error('Workflow definition audit requires a workflow and revision')
      if (event !== 'workflow.deleted' && trigger === undefined)
        throw new Error('Workflow definition audit requires a trigger')
      return writeAuditEvent(trx, {
        ...auditActor(actor),
        organizationId,
        action: event,
        targetType: 'workflow',
        targetId: workflowId,
        details: event === 'workflow.deleted' ? { revision } : { revision, trigger },
      })
    default:
      if (actor.kind !== 'background' || !Object.hasOwn(BACKGROUND_ACTOR_IDS, actor.job))
        throw new Error('Workflow execution audit requires a job')
      if (workflowId === null || revision === null || trigger === undefined)
        throw new Error('Workflow execution audit requires a workflow, revision and trigger')
      if (event === 'workflow.run_skipped' && reason === undefined)
        throw new Error('Workflow skip audit requires a reason')
      return writeAuditEvent(trx, {
        organizationId,
        actor: { type: 'system', id: BACKGROUND_ACTOR_IDS[actor.job] },
        credential: { type: 'none' },
        action: event,
        targetType: 'workflow',
        targetId: workflowId,
        details: { revision, trigger, ...(reason !== undefined && { reason }) },
      })
  }
}

export const workflowAuditPort: WorkflowAuditPort = Object.freeze({
  record: recordWorkflowAudit,
})
