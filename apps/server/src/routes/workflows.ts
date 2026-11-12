import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { LOCATION_KINDS } from '@hourmere/scheduling'
import {
  getWorkflow,
  listWorkflows,
  WORKFLOW_BOOKING_SOURCES,
  WORKFLOW_CONTENT_LOCALES,
  WORKFLOW_PAGE,
  WORKFLOW_RECIPIENT_CLASSES,
  WorkflowTriggerSchema,
} from '@hourmere/workflows'
import {
  authenticated,
  type CallerMiddleware,
  errorResponses,
  json,
  type RouteModule,
} from '../openapi.ts'
import { workflowsGuard } from '../workflows.ts'

// Booking workflow definition reads (docs/workflows.md, step 4). Workflows are not available
// yet: every operation answers 404 workflows_disabled until they are enabled. The read
// representation is the stored current revision's definition (the definition contract's
// canonical form) with its identity, owner, current revision, live enabled flag and times.
// Response objects stay open for additive v1 fields.

/** Shown on every workflow operation, in OpenAPI and MCP discovery alike. */
export const WORKFLOWS_NOT_AVAILABLE =
  'Booking workflows are not available yet: this operation answers 404 workflows_disabled until they are enabled on this instance.'

const triggerTypes = (option: 'delayMinutes' | 'offsetMinutes') =>
  WorkflowTriggerSchema.options
    .filter((schema) => option in schema.shape)
    .map((schema) => schema.shape.type.value) as [string, ...string[]]

export const WorkflowOwner = z
  .object({
    kind: z.enum(['personal', 'team']),
    id: z.uuid().openapi({
      description: 'The user for a personal owner; the team organization for a team',
    }),
  })
  .openapi('WorkflowOwner', {
    description: 'Who owns the workflow: a person in their personal organization, or a team',
  })

const WorkflowScope = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('all_event_types') }),
    z.object({ type: z.literal('event_type'), eventTypeId: z.uuid() }),
  ])
  .openapi('WorkflowScope', {
    description: "One of the owner's event types, or all of its current and future event types",
  })

const WorkflowTrigger = z
  .discriminatedUnion('type', [
    z.object({
      type: z.enum(triggerTypes('delayMinutes')),
      delayMinutes: z.number().int().openapi({
        description: 'Minutes after the booking change; 0 runs right after it commits',
      }),
    }),
    z.object({
      type: z.enum(triggerTypes('offsetMinutes')),
      offsetMinutes: z.number().int().openapi({
        description: 'Minutes before the start or after the end',
      }),
    }),
  ])
  .openapi('WorkflowTrigger')

const WorkflowCondition = z
  .discriminatedUnion('field', [
    z.object({ field: z.literal('event_type'), operator: z.literal('equals'), value: z.uuid() }),
    z.object({
      field: z.literal('booking_source'),
      operator: z.literal('equals'),
      value: z.enum(WORKFLOW_BOOKING_SOURCES),
    }),
    z.object({
      field: z.literal('answer'),
      questionId: z.string(),
      operator: z.literal('equals'),
      value: z.union([z.string(), z.boolean()]),
    }),
    z.object({
      field: z.literal('location_kind'),
      operator: z.literal('equals'),
      value: z.enum(LOCATION_KINDS),
    }),
    z.object({
      field: z.literal('guest_count'),
      operator: z.enum(['equals', 'at_least', 'at_most']),
      value: z.number().int(),
    }),
  ])
  .openapi('WorkflowCondition', { description: 'A predicate; all conditions must hold' })

const WorkflowContent = z.object({ subject: z.string(), body: z.string() })

const WorkflowAction = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('email'),
      recipients: z.array(z.enum(WORKFLOW_RECIPIENT_CLASSES)),
      content: z
        .object(
          Object.fromEntries(
            WORKFLOW_CONTENT_LOCALES.map((locale) => [locale, WorkflowContent.optional()]),
          ),
        )
        .optional()
        .openapi({
          description:
            'Custom subject and body per locale; other locales use the built-in template',
        }),
    }),
    z.object({ type: z.literal('webhook'), webhookId: z.uuid() }),
  ])
  .openapi('WorkflowAction')

export const Workflow = z
  .object({
    id: z.uuid(),
    owner: WorkflowOwner,
    revision: z.number().int().min(1).openapi({
      description: 'The current revision; later updates name it as their expected revision',
    }),
    enabled: z.boolean().openapi({ description: 'Whether the workflow runs for new bookings' }),
    name: z.string(),
    scope: WorkflowScope,
    trigger: WorkflowTrigger,
    conditions: z.array(WorkflowCondition),
    actions: z.array(WorkflowAction),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Workflow', {
    description: "A booking workflow: its current revision's definition and its live enabled flag",
  })

export const WorkflowPage = z
  .object({
    data: z.array(Workflow),
    nextCursor: z.string().nullable().openapi({
      description:
        'Pass as `cursor`, with the same owner, for the next page; null on the last page',
    }),
  })
  .openapi('WorkflowPage')

const limit = {
  description: `Page size, 1–${WORKFLOW_PAGE.max} (default ${WORKFLOW_PAGE.default})`,
}

/** GET /api/v1/workflows: the owner to list, named explicitly, and paging. */
export const ListWorkflowsQuery = z.object({
  ownerKind: z.enum(['personal', 'team']).openapi({
    description: 'personal for your own workflows, team for a team you own or administer',
  }),
  ownerId: z.uuid().openapi({
    description:
      'Your user ID (personal) or the team organization ID (team): the owner the caller acts as in its current organization',
  }),
  limit: z.coerce.number().int().min(1).max(WORKFLOW_PAGE.max).optional().openapi(limit),
  cursor: z.string().max(512).optional(),
})

/** list_workflows and `workflows list`: the same owner selector and paging, as JSON. */
export const ListWorkflowsInput = z.strictObject({
  owner: z
    .strictObject({
      kind: ListWorkflowsQuery.shape.ownerKind,
      id: ListWorkflowsQuery.shape.ownerId,
    })
    .openapi({ description: 'The owner whose workflows to list, as the caller acts now' }),
  // HTTP query strings are coerced by REST; MCP advertises and accepts JSON integers.
  limit: z.number().int().min(1).max(WORKFLOW_PAGE.max).optional().openapi(limit),
  cursor: ListWorkflowsQuery.shape.cursor,
})

const errors = {
  list: errorResponses({
    400: 'invalid_request or invalid_cursor',
    403: 'insufficient_role: the owner is not the personal owner or a team the caller owns or administers in the organization it acts in',
    404: 'workflows_disabled: workflows are not available on this instance',
  }),
  get: errorResponses({
    404: 'workflows_disabled: workflows are not available on this instance; workflow_not_found: no such workflow of the owner the caller acts as',
  }),
}

/** Booking workflow definitions of the personal owner or team the caller acts as. */
export function workflowRoutes({ db }: { db: Db }): RouteModule {
  return ({ app, caller }) => {
    // The guard answers after the caller and its scope check, before input validation.
    const middleware = [caller, workflowsGuard] as [CallerMiddleware, typeof workflowsGuard]
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/workflows',
        tags: ['Workflows'],
        operationId: 'listWorkflows',
        summary: 'List the booking workflows of the owner the caller acts as',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full or read API-key scope. Name the owner explicitly: ownerKind=personal with your user ID in your personal organization, or ownerKind=team with the team ID while acting in that team as a current owner or admin. Any other owner, existing or not, gets the same 403 insufficient_role. Deleted workflows are not listed. Oldest first, by time-ordered ID; pass nextCursor as cursor with the same owner for the next page.`,
        security: authenticated,
        middleware,
        request: { query: ListWorkflowsQuery },
        responses: {
          200: { description: "The owner's workflows", content: json(WorkflowPage) },
          ...errors.list,
        },
      }),
      async (c) => {
        const { ownerKind, ownerId, limit, cursor } = c.req.valid('query')
        return c.json(
          await listWorkflows(
            { db, principal: c.var.principal },
            { owner: { kind: ownerKind, id: ownerId }, limit, cursor },
          ),
          200,
        )
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/workflows/{id}',
        tags: ['Workflows'],
        operationId: 'getWorkflow',
        summary: 'Read one booking workflow',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full or read API-key scope. Returns a workflow of the owner the caller acts as in its current organization: its own personal workflow, or a team workflow while it is a current owner or admin of that team. A missing, deleted or malformed ID, another owner's workflow and a workflow of another organization all get the same 404 workflow_not_found.`,
        security: authenticated,
        middleware,
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: { description: 'The workflow', content: json(Workflow) },
          ...errors.get,
        },
      }),
      async (c) =>
        c.json(await getWorkflow({ db, principal: c.var.principal }, c.req.valid('param').id), 200),
    )
  }
}
