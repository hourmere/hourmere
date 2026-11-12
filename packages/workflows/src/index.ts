// Booking workflows: the definition contract, timer rules and definition reads behind the
// hard-off constant (docs/workflows.md). Only the guarded reads touch the database, and
// nothing sends mail or posts webhooks yet; later plan steps add writes and execution.

export {
  hardOffWorkflowAuditPort,
  WORKFLOW_AUDIT_EVENTS,
  WORKFLOW_SKIP_REASONS,
  type WorkflowAuditActor,
  type WorkflowAuditEvent,
  type WorkflowAuditPort,
  type WorkflowAuditRecord,
  type WorkflowSkipReason,
} from './audit.ts'
export {
  evaluateConditions,
  PERSONAL_ONLY_CONDITION_FIELDS,
  type WorkflowCondition,
  WorkflowConditionSchema,
  WorkflowConditionsSchema,
} from './conditions.ts'
export {
  parseWorkflowDefinition,
  validateWorkflowDefinition,
  WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES,
  WORKFLOW_CONTENT_LOCALES,
  type WorkflowAction,
  WorkflowActionSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowTrigger,
  WorkflowTriggerSchema,
  type WorkflowTriggerType,
  type WorkflowValidationContext,
  workflowMatches,
  workflowReferences,
} from './definition.ts'
export {
  requireWorkflowsImplemented,
  WORKFLOWS_IMPLEMENTED,
  workflowCapture,
  workflowExecution,
  workflowOperation,
} from './hard-off.ts'
export * from './limits.ts'
export {
  isWorkflowBooking,
  isWorkflowEventType,
  ownsEventType,
  ownsWebhook,
  scopeSelectsEventType,
  WORKFLOW_BOOKING_SOURCES,
  type WorkflowBookingFacts,
  type WorkflowBookingSource,
  type WorkflowEventTypeFacts,
  type WorkflowOwner,
  type WorkflowOwnerSelector,
  WorkflowOwnerSelectorSchema,
  type WorkflowQuestionFacts,
  type WorkflowScope,
  WorkflowScopeSchema,
  type WorkflowWebhookFacts,
  workflowOwnerSelector,
} from './ownership.ts'
export {
  getWorkflow,
  listWorkflows,
  WORKFLOW_PAGE,
  type WorkflowListInput,
  type WorkflowPage,
  type WorkflowReadContext,
  type WorkflowReader,
  type WorkflowView,
} from './reads.ts'
export {
  type WorkflowBookingInstants,
  type WorkflowCaptureSkipReason,
  type WorkflowDispatchWindow,
  type WorkflowRunTiming,
  type WorkflowTimer,
  workflowDispatchWindow,
  workflowRunTiming,
  workflowTimerDueAt,
} from './timers.ts'
export {
  templatePlaceholders,
  templateVariableProblem,
  WORKFLOW_ANSWER_VARIABLE_PREFIX,
  WORKFLOW_RECIPIENT_CLASSES,
  WORKFLOW_SCALAR_QUESTION_TYPES,
  WORKFLOW_TEMPLATE_VARIABLES,
  type WorkflowRecipientClass,
  type WorkflowTemplateContext,
  type WorkflowTemplateVariable,
} from './variables.ts'
