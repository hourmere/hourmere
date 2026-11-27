import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  AuditEventFilters,
  type AuditRetentionDays,
  getAuditLogSettings,
  listAuditEvents,
  setAuditLogSettings,
} from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import type { CallerEnv } from '../caller.ts'
import {
  authenticated,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextAccess,
  organizationContextWriteLock,
} from '../team-management.ts'

export interface AuditLogDeps extends ServiceDeps {
  /** The instance default (AUDIT_LOG_RETENTION_DAYS): days, or null to keep forever. */
  auditLogRetentionDays: AuditRetentionDays
}

const ACCESS =
  'Personal space owner, or team owner/admin of the organization the caller acts in, with a session, a full-scope API key or MCP OAuth. Members, read/bookings-scope keys and stale or foreign expected organizations are refused before anything is read.'

export const AuditEvent = z
  .object({
    id: z.string().openapi({ description: 'Journal ID (a decimal integer), unique per instance' }),
    occurredAt: z.string().openapi({
      description: 'UTC time the event was written, RFC 3339 with microseconds',
      example: '2026-11-12T17:04:05.123456Z',
    }),
    action: z.string().openapi({
      description:
        'Stable dotted action, e.g. membership.role_changed. New actions may appear; ignore unknown ones.',
    }),
    actor: z.object({
      type: z.string().openapi({
        description: `Who acted: ${AUDIT_ACTOR_TYPES.join(', ')}. New types may appear.`,
      }),
      id: z.string().nullable().openapi({
        description:
          'Stored user, API key, OAuth client, SCIM token or SCIM connection ID, or a system service name; null for anonymous and external actors',
      }),
    }),
    credential: z.object({
      type: z
        .string()
        .openapi({ description: 'session, api_key, oauth or none. New types may appear.' }),
      apiKeyId: z.string().nullable(),
      apiKeyScope: z
        .string()
        .nullable()
        .openapi({ description: 'Scope of the key used; null when unknown or not a key' }),
      oauthClientId: z.string().nullable(),
      oauthGrantId: z.string().nullable(),
    }),
    target: z.object({
      type: z.string(),
      id: z.string().nullable().openapi({ description: 'Target ID; null for session targets' }),
    }),
    details: z.record(z.string(), z.unknown()).openapi({
      description:
        'The allow-listed details recorded with the action (https://hourmere.com/docs/audit-log); often empty',
    }),
    requestId: z.string().nullable(),
  })
  .openapi('AuditEvent', {
    description:
      'One journal entry. Session IDs, secrets, token values, names and email addresses are never returned.',
  })
export const AuditEventPage = z
  .object({
    data: z.array(AuditEvent),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as cursor, with the same filters, for the next page; null on the last',
    }),
  })
  .openapi('AuditEventPage')

const retentionDays = z.number().int().nullable()
export const AuditLogSettings = z
  .object({
    retention: z.enum(['instance', 'forever', 'days']).openapi({
      description:
        "This organization's choice: follow the instance default, keep forever, or keep retentionDays days",
    }),
    retentionDays: retentionDays.openapi({ description: 'Set when retention is days' }),
    instanceRetentionDays: retentionDays.openapi({
      description: 'The instance default in days; null keeps events forever',
    }),
    effectiveRetentionDays: retentionDays.openapi({
      description: 'What applies to this organization; null keeps events forever',
    }),
    canChangeRetention: z.boolean().openapi({
      description: 'Whether the caller is an owner and may change retention',
    }),
  })
  .openapi('AuditLogSettings')
export const AuditLogSettingsInput = z
  .strictObject({
    retention: z.enum(['instance', 'forever', 'days']),
    retentionDays: z
      .number()
      .int()
      .min(AUDIT_RETENTION_MIN_DAYS)
      .max(AUDIT_RETENTION_MAX_DAYS)
      .optional()
      .openapi({
        description: `Required with retention "days" and refused otherwise; ${AUDIT_RETENTION_MIN_DAYS}–${AUDIT_RETENTION_MAX_DAYS}`,
      }),
  })
  .openapi('AuditLogSettingsInput')

/** Shared by REST and MCP: query strings and tool arguments describe the same filters. */
export const auditFilterDescriptions = {
  from: 'Earliest time, inclusive: RFC 3339 instant with an offset',
  to: 'Latest time, exclusive: RFC 3339 instant with an offset',
  actorType: 'Only events by this actor type',
  actorId: 'Only events by this actor ID (requires actorType)',
  action: 'Only this exact action, e.g. api_key.created',
  cursor: 'nextCursor from the previous page with the same filters',
} as const
const ListQuery = z.object({
  from: AuditEventFilters.shape.from.openapi({ description: auditFilterDescriptions.from }),
  to: AuditEventFilters.shape.to.openapi({ description: auditFilterDescriptions.to }),
  actorType: AuditEventFilters.shape.actorType.openapi({
    description: auditFilterDescriptions.actorType,
  }),
  actorId: AuditEventFilters.shape.actorId.openapi({
    description: auditFilterDescriptions.actorId,
  }),
  action: AuditEventFilters.shape.action.openapi({ description: auditFilterDescriptions.action }),
  cursor: AuditEventFilters.shape.cursor.openapi({ description: auditFilterDescriptions.cursor }),
  limit: z
    .string()
    .optional()
    .openapi({
      description: `Page size, ${1}–${AUDIT_PAGE_MAX}; default ${AUDIT_PAGE_DEFAULT}`,
    }),
})
const headers = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Expected organization. Optional for session reads, required for session writes; stale context is rejected. Ignored for API keys.',
  }),
})

/** `limit` from a query string: a whole number, or the service's invalid_limit refusal. */
export function queryLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  return /^[0-9]{1,4}$/.test(value) ? Number(value) : Number.NaN
}

export function auditLogRoutes(deps: AuditLogDeps): RouteModule {
  const readContext = async (principal: Principal, expected?: string) => {
    await organizationContextAccess(principal, expected)(deps.db, principal.organization.id)
    return serviceContext(deps, principal)
  }
  const writeContext = (principal: Principal, expected?: string) => ({
    ...serviceContext(deps, principal),
    prepareOrganizationWrite: async (trx: Db) => {
      await organizationContextWriteLock(principal)(trx)
      await organizationContextAccess(principal, expected, true)(trx, principal.organization.id)
    },
  })
  // Check membership before route validators so malformed input cannot change a member's refusal.
  const authorize: MiddlewareHandler<CallerEnv> = async (c, next) => {
    await getAuditLogSettings(
      await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
      deps.auditLogRetentionDays,
    )
    await next()
  }
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/audit-events',
        operationId: 'listAuditEvents',
        tags: ['Audit log'],
        summary: 'List audit events of the current organization, newest first',
        description: `${ACCESS} Ordered by time and ID, descending. Requires full API key scope: the journal reveals who did what. Follow nextCursor with the same filters; events written after the first page never repeat or shift earlier entries. Reads are not recorded.`,
        security: authenticated,
        middleware: [caller, authorize] as const,
        request: { query: ListQuery, headers },
        responses: {
          200: { description: 'One page of events', content: json(AuditEventPage) },
          ...errorResponses({
            400: 'invalid_request, invalid_range, invalid_limit or invalid_cursor',
            403: 'team_management_access_denied',
            409: 'organization_context_changed',
          }),
        },
      }),
      async (c) => {
        const { limit, ...filters } = c.req.valid('query')
        return c.json(
          await listAuditEvents(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            { ...filters, limit: queryLimit(limit) },
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/audit-log/settings',
        operationId: 'getAuditLogSettings',
        tags: ['Audit log'],
        summary: 'Read audit log retention of the current organization',
        description: `${ACCESS} Requires full API key scope.`,
        security: authenticated,
        middleware: [caller, authorize] as const,
        request: { headers },
        responses: {
          200: {
            description: 'Retention choice and the instance default',
            content: json(AuditLogSettings),
          },
          ...errorResponses({
            403: 'team_management_access_denied',
            409: 'organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await getAuditLogSettings(
            await readContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            deps.auditLogRetentionDays,
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'put',
        path: '/api/v1/audit-log/settings',
        operationId: 'setAuditLogSettings',
        tags: ['Audit log'],
        summary: 'Set audit log retention of the current organization',
        description: `Personal space owner or team owner only, with a session, a full-scope API key or MCP OAuth. Events older than the retention are deleted by a background job; nothing younger than ${AUDIT_RETENTION_MIN_DAYS} days is ever deleted. A change is recorded as audit_log.retention_updated; repeating the current value records nothing.`,
        security: authenticated,
        middleware: [caller, authorize] as const,
        request: {
          headers,
          body: { required: true, content: json(AuditLogSettingsInput) },
        },
        responses: {
          200: { description: 'The retention now in effect', content: json(AuditLogSettings) },
          ...errorResponses({
            400: 'invalid_request',
            403: 'team_management_access_denied or insufficient_role',
            409: 'organization_context_changed',
          }),
        },
      }),
      async (c) =>
        c.json(
          await setAuditLogSettings(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            deps.auditLogRetentionDays,
            c.req.valid('json'),
          ),
          200,
        ),
    )
  }
}
