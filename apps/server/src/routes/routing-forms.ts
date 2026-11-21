import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import {
  archiveRoutingForm,
  createRoutingForm,
  getRoutingForm,
  listRoutingForms,
  previewRoutingForm,
  publishRoutingForm,
  updateRoutingForm,
} from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import {
  authenticated,
  type CallerMiddleware,
  CROSS_ORIGIN_WRITE,
  callerWithBodyLimit,
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import { RoutingAnswersInput, routingFormsGuard } from '../routing-forms.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from '../team-management.ts'

export const ROUTING_FORMS_DISABLED =
  'Set ROUTING_FORMS_ENABLED=true to enable routing forms, which are off by default. This operation returns routing_forms_disabled while routing forms are off.'
export const ROUTING_FORM_PUBLICATION_BEHAVIOR =
  'Supply the last-read expectedRevision. Publication leaves enabled unchanged and revalidates all targets and mappings. Unsupported targets, including group and payment-required events, and invalid mappings return invalid_routing_target. Reuse the optional requestId UUID with identical input to return the original version and the current form. Changed input with the same key returns idempotency_key_reused.'
export const ROUTING_FORM_PREVIEW_BEHAVIOR =
  'Personal owners and current team owners/admins can preview the current draft in their active organization. API keys require full scope. Supply answers keyed by question UUID. Returns the draft revision, rule and condition matches, and any target eligibility failures. Preview is read-only, with no stored answers, route capabilities or notifications.'
const identity = z.uuid()
const label = z.string().min(1).max(200)
const option = z.strictObject({ id: identity, label })
const questionFields = { id: identity, label, required: z.boolean().optional() }
const question = z.discriminatedUnion('type', [
  z.strictObject({ ...questionFields, type: z.enum(['short_text', 'email']) }),
  z.strictObject({
    ...questionFields,
    type: z.literal('select'),
    options: z.array(option).min(1).max(50),
  }),
])
const destination = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inviteeName') }),
  z.strictObject({ kind: z.literal('inviteeEmail') }),
  z.strictObject({ kind: z.literal('question'), questionId: z.string().min(1).max(64) }),
])
const mapping = z.strictObject({
  questionId: identity,
  destination,
  options: z.record(z.string(), z.string()).optional(),
})
const target = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('event'),
    eventTypeId: identity,
    mappings: z.array(mapping).max(22).optional(),
  }),
  z.strictObject({ kind: z.literal('message'), message: z.string().min(1).max(2000) }),
])
const condition = z.discriminatedUnion('operator', [
  z.strictObject({
    questionId: identity,
    operator: z.literal('equals'),
    value: z.string().max(500),
  }),
  z.strictObject({
    questionId: identity,
    operator: z.literal('one_of'),
    values: z.array(identity).min(1).max(50),
  }),
])
const rule = z.strictObject({ id: identity, conditions: z.array(condition).min(1).max(10), target })
const draft = {
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  title: label,
  description: z.string().max(2000).nullable().optional(),
  questions: z.array(question).max(20).optional(),
  rules: z.array(rule).max(50).optional(),
  fallback: target,
}
export const CreateRoutingForm = z
  .strictObject({ ...draft, requestId: z.uuid().optional() })
  .openapi('CreateRoutingForm')
export const ArchiveRoutingForm = z
  .strictObject({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .openapi('ArchiveRoutingForm')
export const PublishRoutingForm = z
  .strictObject({ ...ArchiveRoutingForm.shape, requestId: identity.optional() })
  .openapi('PublishRoutingForm')
export const PreviewRoutingForm = z
  .strictObject({ answers: RoutingAnswersInput })
  .openapi('PreviewRoutingForm')
export const UpdateRoutingForm = z
  .strictObject(draft)
  .partial()
  .extend({
    ...ArchiveRoutingForm.shape,
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateRoutingForm')
export const RoutingFormId = z.strictObject({ id: z.uuid() })
export const RoutingFormListInput = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(512).optional(),
})
// Response objects remain open to additive fields within API v1.
// Stored routing IDs can use any PostgreSQL UUID, regardless of version or variant.
const storedIdentity = z.guid()
export const RoutingFormQuestion = z.discriminatedUnion('type', [
  z.object({
    id: z.uuid(),
    label: z.string(),
    required: z.boolean(),
    type: z.enum(['short_text', 'email']),
  }),
  z.object({
    id: z.uuid(),
    label: z.string(),
    required: z.boolean(),
    type: z.literal('select'),
    options: z.array(z.object({ id: z.uuid(), label: z.string() })),
  }),
])
const responseTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    eventTypeId: storedIdentity,
    mappings: z.array(
      z.object({
        questionId: storedIdentity,
        destination: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('inviteeName') }),
          z.object({ kind: z.literal('inviteeEmail') }),
          z.object({ kind: z.literal('question'), questionId: z.string() }),
        ]),
        options: z.record(z.string(), z.string()).optional(),
      }),
    ),
  }),
  z.object({ kind: z.literal('message'), message: z.string() }),
])
const responseCondition = z.discriminatedUnion('operator', [
  z.object({ questionId: z.uuid(), operator: z.literal('equals'), value: z.string() }),
  z.object({ questionId: z.uuid(), operator: z.literal('one_of'), values: z.array(z.string()) }),
])
const responseRule = z.object({
  id: z.uuid(),
  conditions: z.array(responseCondition),
  target: responseTarget,
})
const health = z.enum(['ok', 'unavailable', 'unknown'])
const summary = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  draftRevision: z.number().int(),
  enabled: z.boolean(),
  publishedVersionId: z.uuid().nullable(),
  publishedVersionNumber: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  health: health.nullable(),
})
export const RoutingFormResponse = summary
  .extend({
    description: z.string().nullable(),
    questions: z.array(RoutingFormQuestion),
    rules: z.array(responseRule),
    fallback: responseTarget,
    health: z
      .object({
        versionId: z.uuid(),
        status: health,
        targets: z.array(
          z.object({
            ruleId: z.string(),
            eventTypeId: z.uuid().nullable(),
            health,
            reason: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
  })
  .openapi('RoutingForm')
export const RoutingFormList = z
  .object({ data: z.array(summary), nextCursor: z.string().nullable() })
  .openapi('RoutingFormList')
const RoutingFormVersion = z
  .object({
    id: identity,
    formId: identity,
    versionNumber: z.number().int(),
    questions: z.array(RoutingFormQuestion),
    rules: z.array(responseRule),
    fallback: responseTarget,
    publishedAt: z.iso.datetime(),
  })
  .openapi('RoutingFormVersion')
export const RoutingFormPublication = z
  .object({ form: RoutingFormResponse, version: RoutingFormVersion })
  .openapi('RoutingFormPublication')
const previewRuleId = z.union([storedIdentity, z.literal('fallback')])
export const RoutingFormPreview = z
  .object({
    draftRevision: z.number().int(),
    matchedRuleId: previewRuleId.openapi({ description: 'First matching rule, or fallback' }),
    resolvedRuleId: previewRuleId.nullable().openapi({
      description: 'Rule or fallback whose target applies, or null when neither can be used',
    }),
    target: responseTarget.nullable(),
    unavailableTargets: z.array(z.object({ ruleId: previewRuleId, reason: z.string() })),
    rules: z
      .array(
        z.object({
          ruleId: storedIdentity,
          matched: z.boolean(),
          conditions: z.array(z.object({ questionId: storedIdentity, matched: z.boolean() })),
        }),
      )
      .openapi({ description: 'Rules evaluated in order, through the first matching rule' }),
  })
  .openapi('RoutingFormPreview')
const headers = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Required for session writes: the organization where the action opened. Optional on reads; ignored for API keys.',
  }),
})
const errors = errorResponses({
  400: 'invalid_request, invalid_routing_form, invalid_routing_target, invalid_cursor, invalid_limit',
  403: 'team_management_access_denied, insufficient_scope, cross_origin_write',
  404: 'routing_forms_disabled, routing_form_not_found',
  409: 'organization_context_changed, routing_revision_conflict, idempotency_key_reused, slug_taken, routing_form_limit_reached, routing_form_not_published',
})

export function routingFormRoutes(
  deps: ServiceDeps & { routingFormsEnabled: boolean },
): RouteModule {
  const writeContext = (principal: Principal, expected?: string) => ({
    ...serviceContext(deps, principal),
    authorizeOrganizationWrite: organizationContextAccess(principal, expected, true, true),
  })
  return ({ app, caller }) => {
    const route = {
      security: authenticated,
      middleware: [
        ...callerWithBodyLimit(caller, 2 * 1024 * 1024),
        routingFormsGuard(deps.routingFormsEnabled),
      ] as [CallerMiddleware, MiddlewareHandler<CallerEnv>, MiddlewareHandler<CallerEnv>],
      tags: ['Routing forms'],
      description: `${ROUTING_FORMS_DISABLED} Personal owners and current team owners/admins manage forms in their active organization. Reads require read/full API-key scope; writes require full scope. Session writes require X-Expected-Organization-Id and same-origin Origin/Referer checks. Create accepts an optional requestId UUID for safe retries; update/archive require the last-read expectedRevision.`,
    }
    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/routing-forms',
        operationId: 'listRoutingForms',
        summary: 'List routing forms',
        request: {
          headers,
          query: RoutingFormListInput.extend({
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        },
        responses: {
          200: {
            description: 'Active forms with current published target health; newest first',
            content: json(RoutingFormList),
          },
          ...errors,
        },
      }),
      async (c) => {
        await organizationContextAccess(
          c.var.principal,
          c.req.header(EXPECTED_ORGANIZATION_HEADER),
        )(deps.db, c.var.principal.organization.id)
        return c.json(
          await listRoutingForms(serviceContext(deps, c.var.principal), c.req.valid('query')),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/routing-forms/{id}',
        operationId: 'getRoutingForm',
        summary: 'Get a routing form',
        request: { headers, params: RoutingFormId },
        responses: {
          200: {
            description: 'Draft and current published target health, per rule and fallback',
            content: json(RoutingFormResponse),
          },
          ...errors,
        },
      }),
      async (c) => {
        await organizationContextAccess(
          c.var.principal,
          c.req.header(EXPECTED_ORGANIZATION_HEADER),
        )(deps.db, c.var.principal.organization.id)
        return c.json(
          await getRoutingForm(serviceContext(deps, c.var.principal), c.req.valid('param').id),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'post',
        path: '/api/v1/routing-forms',
        operationId: 'createRoutingForm',
        summary: 'Create a routing form',
        request: { headers, body: { required: true, content: json(CreateRoutingForm) } },
        responses: {
          201: {
            description: 'Created form or same-request replay',
            content: json(RoutingFormResponse),
          },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await createRoutingForm(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('json'),
          ),
          201,
        ),
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'patch',
        path: '/api/v1/routing-forms/{id}',
        operationId: 'updateRoutingForm',
        summary: 'Update a routing form',
        request: {
          params: RoutingFormId,
          headers,
          body: { required: true, content: json(UpdateRoutingForm) },
        },
        responses: {
          200: { description: 'Updated draft and revision', content: json(RoutingFormResponse) },
          ...errors,
        },
      }),
      async (c) =>
        c.json(
          await updateRoutingForm(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'delete',
        path: '/api/v1/routing-forms/{id}',
        operationId: 'archiveRoutingForm',
        summary: 'Archive a routing form',
        request: {
          params: RoutingFormId,
          headers,
          body: { required: true, content: json(ArchiveRoutingForm) },
        },
        responses: {
          204: { description: 'Archived and disabled; excluded from active reads' },
          ...errors,
        },
      }),
      async (c) => {
        await archiveRoutingForm(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
          c.req.valid('json'),
        )
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'post',
        path: '/api/v1/routing-forms/{id}/publish',
        operationId: 'publishRoutingForm',
        summary: 'Publish a routing form',
        description: `${ROUTING_FORMS_DISABLED} Personal owners and current team owners/admins can publish forms in their active organization. API keys require full scope. Session writes require X-Expected-Organization-Id and same-origin Origin/Referer checks. ${ROUTING_FORM_PUBLICATION_BEHAVIOR}`,
        request: {
          params: RoutingFormId,
          headers,
          body: { required: true, content: json(PublishRoutingForm) },
        },
        responses: {
          201: {
            description: 'Current form and the immutable version created by the original request',
            content: json(RoutingFormPublication),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_routing_form, invalid_routing_target',
            403: 'team_management_access_denied, insufficient_scope, cross_origin_write',
            404: 'routing_forms_disabled, routing_form_not_found',
            409: 'organization_context_changed, routing_revision_conflict, idempotency_key_reused, routing_form_version_limit_reached',
          }),
          413: { description: 'payload_too_large', content: json(ErrorBody) },
        },
      }),
      async (c) =>
        c.json(
          await publishRoutingForm(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          201,
        ),
    )
    app.openapi(
      createRoute({
        ...route,
        method: 'post',
        path: '/api/v1/routing-forms/{id}/preview',
        operationId: 'previewRoutingForm',
        summary: 'Preview a routing form draft',
        description: `${ROUTING_FORMS_DISABLED} ${ROUTING_FORM_PREVIEW_BEHAVIOR} Session requests require a same-origin Origin/Referer.`,
        request: {
          params: RoutingFormId,
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional for sessions. Pins the preview to the organization where it opened. Ignored for API keys.',
            }),
          }),
          body: { required: true, content: json(PreviewRoutingForm) },
        },
        responses: {
          200: {
            description: 'Draft route and author diagnostics',
            content: json(RoutingFormPreview),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_routing_answers, invalid_routing_form, invalid_routing_target',
            403: `team_management_access_denied, insufficient_scope, ${CROSS_ORIGIN_WRITE}`,
            404: 'routing_forms_disabled, routing_form_not_found',
            409: 'organization_context_changed',
          }),
          413: { description: 'payload_too_large', content: json(ErrorBody) },
        },
      }),
      async (c) => {
        await organizationContextAccess(
          c.var.principal,
          c.req.header(EXPECTED_ORGANIZATION_HEADER),
        )(deps.db, c.var.principal.organization.id)
        return c.json(
          await previewRoutingForm(
            serviceContext(deps, c.var.principal),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          200,
        )
      },
    )
  }
}
