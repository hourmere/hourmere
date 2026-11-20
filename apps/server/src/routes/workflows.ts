import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { LOCATION_KINDS } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  CreateWorkflowInputSchema,
  createWorkflow,
  DeleteWorkflowInputSchema,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  PreviewWorkflowInputSchema,
  previewWorkflow,
  UpdateWorkflowInputSchema,
  updateWorkflow,
  WORKFLOW_BOOKING_SOURCES,
  WORKFLOW_CONTENT_LOCALES,
  WORKFLOW_PAGE,
  WORKFLOW_RECIPIENT_CLASSES,
  WORKFLOW_RUN_PAGE,
  WorkflowPreviewSchema,
  WorkflowRunHistoryEntrySchema,
  type WorkflowSettings,
  WorkflowTriggerSchema,
} from '@hourmere/workflows'
import {
  authenticated,
  type CallerMiddleware,
  errorResponses,
  json,
  type RouteModule,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextAccess,
  organizationContextWriteLock,
} from '../team-management.ts'
import { workflowsEnabledGuard, workflowsGuard, workflowUpdateGuard } from '../workflows.ts'

// Booking workflow definitions (docs/workflows.md). Workflows are not available
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

export const WorkflowRunHistoryPage = z
  .object({
    data: z.array(
      WorkflowRunHistoryEntrySchema.openapi('WorkflowRunHistoryEntry', {
        description: 'A finished run with fixed outcome codes and aggregate recipient counts',
      }),
    ),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as `cursor` for the same workflow; null on the last page',
    }),
  })
  .openapi('WorkflowRunHistoryPage')

const workflowRunLimit = z.number().int().min(1).max(WORKFLOW_RUN_PAGE.max).optional()
const workflowRunCursor = z.string().max(WORKFLOW_RUN_PAGE.cursorMaxLength).optional()
const workflowRunLimitDescription = {
  description: `Page size, 1–${WORKFLOW_RUN_PAGE.max} (default ${WORKFLOW_RUN_PAGE.default})`,
}
const ListWorkflowRunsQuery = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_RUN_PAGE.max)
    .optional()
    .openapi(workflowRunLimitDescription),
  cursor: workflowRunCursor,
})

/** list_workflow_runs and `workflows runs`: workflow ID and paging, as JSON. */
export const ListWorkflowRunsInput = z.strictObject({
  id: z.string(),
  limit: workflowRunLimit.openapi(workflowRunLimitDescription),
  cursor: workflowRunCursor,
})

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

export const DeleteWorkflowInput = DeleteWorkflowInputSchema.openapi('DeleteWorkflowInput')

export const UpdateWorkflowInput = UpdateWorkflowInputSchema.openapi('UpdateWorkflowInput')

export const CreateWorkflowInput = CreateWorkflowInputSchema.openapi('CreateWorkflowInput')

export const WorkflowPreview = WorkflowPreviewSchema.openapi('WorkflowPreview')

export const WORKFLOW_PREVIEW_DESCRIPTION = `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope and current personal ownership or team owner/admin access in the active organization. Supply owner, the candidate definition fields and optional synthetic example values. Returns the match outcome, rendered email text and escaped HTML, and static estimates. Preview uses synthetic booking data and makes no deliveries.`

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
export function workflowRoutes({
  db,
  followUpHostNotesEnabled,
  workflowRunCursorSecret,
  workflowsEnabled,
}: {
  db: Db
  followUpHostNotesEnabled?: boolean | undefined
  workflowRunCursorSecret?: string | undefined
} & WorkflowSettings): RouteModule {
  const contextAccess =
    (
      principal: Principal,
      expectedOrganizationId: string | undefined,
      lock: boolean | 'key share' = false,
    ) =>
    async (trx: Db, organizationId: string) => {
      try {
        await organizationContextAccess(
          principal,
          expectedOrganizationId,
          true,
          lock,
        )(trx, organizationId)
      } catch (error) {
        // Keep workflow ownership refusals opaque across session and agent credentials.
        // A stale browser context remains a recoverable conflict.
        if (error instanceof DomainError && error.code === 'team_management_access_denied')
          throw new DomainError('not_found', 'workflow_not_found', 'No such workflow')
        throw error
      }
    }
  const writeContext = (principal: Principal, expectedOrganizationId?: string) => ({
    db,
    principal,
    followUpHostNotesEnabled,
    workflowsEnabled,
    prepareOrganizationWrite: async (trx: Db) => {
      await organizationContextWriteLock(principal)(trx)
      await contextAccess(principal, expectedOrganizationId)(trx, principal.organization.id)
    },
    authorizeOrganizationWrite: contextAccess(principal, expectedOrganizationId, 'key share'),
  })
  return ({ app, caller }) => {
    // The guard answers after the caller and its scope check, before input validation.
    const middleware = [caller, workflowsGuard] as [CallerMiddleware, typeof workflowsGuard]
    const enabledMiddleware = [
      ...middleware,
      workflowsEnabledGuard({ workflowsEnabled }),
    ] satisfies [...typeof middleware, typeof workflowsGuard]
    const updateMiddleware = [...middleware, workflowUpdateGuard({ workflowsEnabled })] satisfies [
      ...typeof middleware,
      typeof workflowsGuard,
    ]
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/workflows',
        tags: ['Workflows'],
        operationId: 'createWorkflow',
        summary: 'Create a booking workflow',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope. Name your personal owner or a team you currently own or administer in the active organization. Retain idempotencyKey for retries: the same normalized request returns the stored definition, while changed input conflicts. IDs are server-generated; caller-supplied IDs and unknown fields are rejected. Webhook actions are not available yet. Creation does not send mail.`,
        security: authenticated,
        middleware: enabledMiddleware,
        request: {
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Required for session writes: the organization where the action opened. Ignored for API keys.',
            }),
          }),
          body: { required: true, content: json(CreateWorkflowInput) },
        },
        responses: {
          201: {
            description: 'Created workflow, or its stored definition on replay',
            content: json(Workflow),
          },
          ...errorResponses({
            400: 'invalid_request or invalid_workflow',
            403: 'insufficient_scope or cross-origin session write',
            404: 'workflows_disabled or workflow_not_found',
            409: 'idempotency_key_reused, workflow_limit_reached or organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await createWorkflow(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('json'),
          ),
          201,
        ),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/workflows/preview',
        tags: ['Workflows'],
        operationId: 'previewWorkflow',
        summary: 'Preview a booking workflow with synthetic data',
        description: WORKFLOW_PREVIEW_DESCRIPTION,
        security: authenticated,
        middleware: enabledMiddleware,
        request: {
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Required for session requests: the organization where the action opened. Ignored for API keys.',
            }),
          }),
          body: { required: true, content: json(PreviewWorkflowInputSchema) },
        },
        responses: {
          200: { description: 'Synthetic workflow preview', content: json(WorkflowPreview) },
          ...errorResponses({
            400: 'invalid_request, invalid_workflow or render_limit',
            403: 'insufficient_scope or cross-origin session write',
            404: 'workflows_disabled or workflow_not_found',
            409: 'organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await previewWorkflow(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('json'),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/workflows/{id}',
        tags: ['Workflows'],
        operationId: 'updateWorkflow',
        summary: 'Edit, enable or disable a booking workflow',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope. Supply expectedRevision and the fields to change. Content edits append an immutable revision; changing only enabled preserves the revision. A stale revision conflicts. Missing, foreign and mismatched owner contexts return workflow_not_found. Disabling or enabling changes no existing booking enrollment or execution. Webhook actions are not available yet.`,
        security: authenticated,
        middleware: updateMiddleware,
        request: {
          params: z.object({ id: z.string() }),
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Required for session writes: the organization where the action opened. Ignored for API keys.',
            }),
          }),
          body: { required: true, content: json(UpdateWorkflowInput) },
        },
        responses: {
          200: { description: 'Updated workflow', content: json(Workflow) },
          ...errorResponses({
            400: 'invalid_request or invalid_workflow',
            403: 'insufficient_scope or cross-origin session write',
            404: 'workflows_disabled or workflow_not_found',
            409: 'workflow_revision_conflict, workflow_limit_reached or organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await updateWorkflow(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/workflows/{id}',
        tags: ['Workflows'],
        operationId: 'deleteWorkflow',
        summary: 'Delete a booking workflow',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full API-key scope and expectedRevision. Tombstones the definition and retires its pending runs. Repeated authorized deletion is safe. Missing, foreign and mismatched owner contexts return workflow_not_found. Revisions and creation keys remain with the tombstone; existing minimal history follows retention.`,
        security: authenticated,
        middleware,
        request: {
          params: z.object({ id: z.string() }),
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Required for session writes: the organization where the action opened. Ignored for API keys.',
            }),
          }),
          body: { required: true, content: json(DeleteWorkflowInput) },
        },
        responses: {
          204: { description: 'Deleted workflow, including an authorized repeat' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'insufficient_scope or cross-origin session write',
            404: 'workflows_disabled or workflow_not_found',
            409: 'workflow_revision_conflict or organization_context_changed',
          }),
        },
      }),
      async (c) => {
        await deleteWorkflow(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.body(null, 204)
      },
    )

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

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/workflows/{id}/runs',
        tags: ['Workflows'],
        operationId: 'listWorkflowRuns',
        summary: 'List finished runs of a booking workflow',
        description: `${WORKFLOWS_NOT_AVAILABLE} Requires full or read API-key scope and personal ownership or current team owner/admin access in the active organization. Returns metadata and aggregate outcomes only, newest first. Pass nextCursor as cursor with the same workflow for the next page. Missing, deleted, malformed and inaccessible workflow IDs return workflow_not_found.`,
        security: authenticated,
        middleware,
        request: { params: z.object({ id: z.string() }), query: ListWorkflowRunsQuery },
        responses: {
          200: {
            description: 'The workflow’s finished runs',
            content: json(WorkflowRunHistoryPage),
          },
          ...errorResponses({ 400: 'invalid_request or invalid_cursor' }),
          ...errors.get,
        },
      }),
      async (c) =>
        c.json(
          await listWorkflowRuns(
            { db, principal: c.var.principal, workflowRunCursorSecret },
            c.req.valid('param').id,
            c.req.valid('query'),
          ),
          200,
        ),
    )
  }
}
