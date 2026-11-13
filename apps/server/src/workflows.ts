import { DomainError } from '@hourmere/scheduling'
import { requireWorkflowsImplemented, workflowOperation } from '@hourmere/workflows'
import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import type { Tool } from './mcp/tools.ts'

// How every transport switches booking workflows off (docs/workflows.md, "Rollout and
// limitations"). Hard-off is behavior, not registration: the routes, tools and commands exist,
// and each answers `404 workflows_disabled` after credential validation and the API-key scope
// check (scope refusals keep their existing precedence) and before input validation, any role
// check or lookup. The decision is always the workflow package's own guard; nothing here takes
// an option, so no environment, configuration or caller can turn it on.

/**
 * The REST guard of a workflow operation. List it right after the caller in the route's
 * `middleware`: requireCaller answers missing credentials (401) and a key whose scope does
 * not allow the operation (403 insufficient_scope) first, then this answers
 * `404 workflows_disabled` before the request's parameters are validated.
 */
export const workflowsGuard = createMiddleware<CallerEnv>(
  workflowOperation(async (_c: Context<CallerEnv>, next: Next) => {
    await next()
  }),
)

/**
 * Registers workflow MCP tools behind the same guard: while workflows are off they are left out
 * of tools/list, and a direct call answers the API-key scope check first and then
 * `workflows_disabled`, before argument checks or the handler (Tool.requireAvailable).
 */
export function workflowFeatureTools(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => ({ ...tool, requireAvailable: requireWorkflowsImplemented }))
}

/** Whether the workflow guard admits operations now: what `/instance` reports. */
export function workflowsAvailable(): boolean {
  try {
    requireWorkflowsImplemented()
    return true
  } catch (error) {
    if (error instanceof DomainError && error.code === 'workflows_disabled') return false
    throw error
  }
}
