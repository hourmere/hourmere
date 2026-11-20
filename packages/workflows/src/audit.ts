// The injected workflow audit port (docs/workflows.md, "Permissions, persistence and audit").
// Definition and preview events use the shared audit journal. Execution still uses the
// no-op port while workflows are hard-off.

import type { Db } from '@hourmere/db'
import { type AuditPrincipal, auditActor, writeAuditEvent } from '@hourmere/db/audit'
import type { WorkflowTriggerType } from './definition.ts'
import { WORKFLOWS_IMPLEMENTED, workflowExecution } from './hard-off.ts'
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

/** Who caused the event. Background work names its job explicitly instead of a person. */
export type WorkflowAuditActor =
  | AuditPrincipal
  | { kind: 'background'; job: 'capture' | 'dispatch' | 'repair' | 'retention' }

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
 * Records audit events inside the caller's transaction, so a record commits or rolls back with
 * the change it describes and a replay cannot duplicate a terminal record.
 */
export interface WorkflowAuditPort {
  record(trx: Db, record: WorkflowAuditRecord): Promise<void>
}

/** The writer behind the hard-off guard. Use only for definition and preview transactions. */
export async function recordWorkflowDefinitionAudit(
  trx: Db,
  record: WorkflowAuditRecord,
): Promise<void> {
  const { actor, event, owner, reason, revision, trigger, workflowId } = record
  if (actor.kind === 'background') throw new Error('Workflow definition audit requires a caller')
  const scope = { ...auditActor(actor), organizationId: owner.organizationId }
  switch (event) {
    case 'workflow.previewed':
      if (trigger === undefined) throw new Error('Workflow preview audit requires a trigger')
      return writeAuditEvent(trx, {
        ...scope,
        action: event,
        targetType: 'workflow_preview',
        targetId: owner.organizationId,
        details: { trigger, ...(reason === 'condition_false' && { reason }) },
      })
    case 'workflow.created':
    case 'workflow.updated':
    case 'workflow.enabled':
    case 'workflow.disabled':
    case 'workflow.deleted':
      if (workflowId === null || revision === null)
        throw new Error('Workflow definition audit requires a workflow and revision')
      if (event !== 'workflow.deleted' && trigger === undefined)
        throw new Error('Workflow definition audit requires a trigger')
      return writeAuditEvent(trx, {
        ...scope,
        action: event,
        targetType: 'workflow',
        targetId: workflowId,
        details: event === 'workflow.deleted' ? { revision } : { revision, trigger },
      })
    default:
      throw new Error('Workflow execution audit is not bound to the definition writer')
  }
}

export const workflowDefinitionAuditPort: WorkflowAuditPort = Object.freeze({
  record: workflowExecution(recordWorkflowDefinitionAudit),
})

const noopAuditPort: WorkflowAuditPort = Object.freeze({
  record: async () => {},
})

/**
 * The port for hard-off: it records nothing and touches no transaction. It refuses once
 * workflows are implemented, so no production wiring can keep it after the opt-in.
 */
export function hardOffWorkflowAuditPort(): WorkflowAuditPort {
  if (WORKFLOWS_IMPLEMENTED !== false)
    throw new Error('The no-op workflow audit port is only for hard-off; bind the audit writer')
  return noopAuditPort
}
