import { DomainError } from '@hourmere/scheduling/errors'
import { requireWorkflowsImplemented, WORKFLOWS_IMPLEMENTED } from './hard-off.ts'

/** Internal dependency passed to workflow entry points. */
export interface WorkflowSettings {
  workflowsEnabled?: boolean | undefined
}

export function workflowsEnabled(settings: WorkflowSettings): boolean {
  return WORKFLOWS_IMPLEMENTED === true && settings.workflowsEnabled === true
}

function unavailable(): never {
  throw new DomainError('not_found', 'workflows_disabled')
}

export function requireWorkflowsEnabled(settings: WorkflowSettings): void {
  if (!workflowsEnabled(settings)) unavailable()
}

export function requireWorkflowUpdateAllowed(settings: WorkflowSettings, input: unknown): void {
  requireWorkflowsImplemented()
  if (settings.workflowsEnabled === true) return
  // Check the submitted shape before schema parsing or reading the current revision.
  if (
    typeof input !== 'object' ||
    input === null ||
    !('enabled' in input) ||
    input.enabled !== false ||
    !Object.hasOwn(input, 'enabled') ||
    !Object.hasOwn(input, 'expectedRevision') ||
    Object.keys(input).length !== 2
  )
    unavailable()
}
