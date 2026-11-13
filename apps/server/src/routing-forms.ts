import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { Tool } from './mcp/tools.ts'
import { featureGate } from './rest-scopes.ts'

// The shared routing-forms switch (docs/routing-forms.md, Rollout gating). Production
// composition passes the hard-off constant in server.ts; only tests inject `true`.

/**
 * Throws `404 routing_forms_disabled` unless routing forms are enabled. Only the boolean
 * `true` enables; anything else a caller passes at run time, despite the type, fails closed.
 */
export function requireRoutingFormsEnabled(routingFormsEnabled: boolean): void {
  if (routingFormsEnabled !== true) throw new DomainError('not_found', 'routing_forms_disabled')
}

/**
 * The guard for a routing REST operation. List it last in the route's `middleware`: it then
 * answers after the transport checks (body limit, rate limits) and credential validation, and
 * before the API-key scope check, any role check, lookup, body read or input validation, with
 * the same response for every form and token (see featureGate in rest-scopes.ts).
 */
export function routingFormsGuard(routingFormsEnabled: boolean): MiddlewareHandler {
  return featureGate(() => requireRoutingFormsEnabled(routingFormsEnabled))
}

/**
 * Registers routing MCP tools behind the same switch: while routing is off they are left out
 * of tools/list, and a direct call of one answers `routing_forms_disabled` before the scope
 * check, argument validation or its handler (Tool.requireEnabled in mcp/tools.ts).
 */
export function routingFormTools(routingFormsEnabled: boolean, tools: readonly Tool[]): Tool[] {
  const requireEnabled = () => requireRoutingFormsEnabled(routingFormsEnabled)
  return tools.map((tool) => ({ ...tool, requireEnabled }))
}
