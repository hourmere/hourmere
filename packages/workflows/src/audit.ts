// The injected workflow audit port (docs/workflows.md, "Permissions, persistence and audit").
// Every workflow step records through this port, so no step depends on a particular audit
// store. Later steps bind it to the shared audit writer; until then the only implementation is
// the no-op port, which is safe solely while workflows are hard-off and refuses otherwise.

import type { Db } from '@hourmere/db'
import type { WorkflowTriggerType } from './definition.ts'
import { WORKFLOWS_IMPLEMENTED } from './hard-off.ts'
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
  | { kind: 'session'; userId: string }
  | { kind: 'api_key'; userId: string; apiKeyId: string }
  | { kind: 'oauth'; userId: string; clientId: string }
  | { kind: 'background'; job: 'capture' | 'dispatch' | 'repair' | 'retention' }

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
