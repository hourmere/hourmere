import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  DomainError,
  type PublicRoutingFormAddress,
  resolvePublicRoutingForm,
  submitRoutingForm,
} from '@hourmere/scheduling'
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

export const RoutingAnswersInput = z
  .preprocess(
    (answers, ctx) => {
      // Zod's record parser otherwise strips this key before the service can reject it.
      if (answers != null && Object.hasOwn(answers, '__proto__'))
        ctx.addIssue({ code: 'custom', message: 'Invalid answer key' })
      return answers
    },
    z.record(z.string(), z.string().nullable()),
  )
  .openapi({
    description:
      'Map question UUIDs to text or select option UUIDs. Omit or use null for an unanswered optional question.',
  })

export const RoutingSubmission = z
  .strictObject({
    versionId: z.guid().openapi({ description: 'Current published version from public metadata' }),
    answers: RoutingAnswersInput,
  })
  .openapi('RoutingSubmission')

export const RoutingSubmissionResponse = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('message'), message: z.string() }),
    z.object({
      kind: z.literal('continuation'),
      routeToken: z.string().openapi({ description: 'Private bearer capability' }),
      expiresAt: z.iso.datetime(),
      continuationUrl: z.url().openapi({ description: 'Private continuation link' }),
    }),
  ])
  .openapi('RoutingSubmissionResponse')

export async function submitPublicRoutingForm(
  {
    db,
    routingFormsEnabled,
    routingSecret,
    publicUrl,
  }: {
    db: Db
    routingFormsEnabled: boolean
    routingSecret?: string | undefined
    publicUrl: string
  },
  address: PublicRoutingFormAddress,
  input: z.infer<typeof RoutingSubmission>,
): Promise<z.infer<typeof RoutingSubmissionResponse>> {
  requireRoutingFormsEnabled(routingFormsEnabled)
  if (!routingSecret) throw new Error('Routing submission requires the server secret')
  const continuation = new URL('/route/continue', publicUrl)
  const locator = await resolvePublicRoutingForm(db, address)
  const result = await submitRoutingForm({ db, routingFormsEnabled, routingSecret }, locator, input)
  if (result.kind === 'message') return result
  continuation.hash = `token=${encodeURIComponent(result.routeToken)}`
  return { ...result, continuationUrl: continuation.href }
}
