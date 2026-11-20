import {
  requireWorkflowsEnabled,
  requireWorkflowsImplemented,
  requireWorkflowUpdateAllowed,
  type WorkflowSettings,
  workflowOperation,
  workflowsEnabled,
} from '@hourmere/workflows'
import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from './caller.ts'
import type { Tool } from './mcp/tools.ts'

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

export function workflowsEnabledGuard(settings: WorkflowSettings) {
  return createMiddleware<CallerEnv>(async (_c, next) => {
    requireWorkflowsEnabled(settings)
    await next()
  })
}

export function workflowUpdateGuard(settings: WorkflowSettings) {
  return createMiddleware<CallerEnv>(async (c, next) => {
    if (!workflowsEnabled(settings))
      requireWorkflowUpdateAllowed(settings, await c.req.json().catch(() => undefined))
    await next()
  })
}

/**
 * Discovery requires workflows to be enabled. A known direct call still runs the tool's
 * availability check after the API-key scope check, so recovery works while operator-off.
 */
export function workflowFeatureTools(tools: readonly Tool[], settings: WorkflowSettings): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    discoverable: () => workflowsEnabled(settings),
    requireAvailable(args) {
      requireWorkflowsImplemented()
      return tool.requireAvailable?.(args)
    },
  }))
}
