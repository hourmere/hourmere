// The workflow hard-off switch (docs/workflows.md, "Rollout and limitations"). Release tags
// can select main commits, so an environment flag is not a sufficient barrier for incomplete
// work: this source constant is. It is not read from the environment or the configuration, no
// function changes it, and no option or parameter overrides it, in production or in tests.
// Tests exercise the internal services behind these guards by calling them directly with
// injected dependencies. The one transport test of the enabled read path replaces this module
// in its own file with a test module mock (apps/server/src/workflows-enabled.test.ts), which no
// production code can do. The plan's opt-in step is the only change that may set it to true.

import { DomainError } from '@hourmere/scheduling/errors'

/** Whether booking workflows are implemented. False until the whole stack exists. */
export const WORKFLOWS_IMPLEMENTED: boolean = false

/**
 * Throws `404 workflows_disabled` while workflows are off. Every workflow operation (REST,
 * MCP, CLI, reads, disable and delete included) calls it before any lookup or validation.
 */
export function requireWorkflowsImplemented(): void {
  if (WORKFLOWS_IMPLEMENTED !== true) throw new DomainError('not_found', 'workflows_disabled')
}

/** Wraps a workflow operation so it answers `workflows_disabled` before running while off. */
export function workflowOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    requireWorkflowsImplemented()
    return operation(...args)
  }
}

/**
 * Wraps workflow capture, which runs inside a booking's own transaction. While off it captures
 * nothing and resolves, so the booking change itself is never refused because of workflows.
 */
export function workflowCapture<Args extends unknown[]>(
  capture: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    if (WORKFLOWS_IMPLEMENTED !== true) return
    await capture(...args)
  }
}

/**
 * Wraps a workflow execution entry point: a dispatch, repair or retry job handler. While off
 * it claims, admits, sends and posts nothing, and resolves without calling the handler.
 */
export function workflowExecution<Args extends unknown[]>(
  execute: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    if (WORKFLOWS_IMPLEMENTED !== true) return
    await execute(...args)
  }
}
