import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  AuditEventFilters,
  type AuditRetentionDays,
  getAuditLogSettings,
  listAuditEvents,
  setAuditLogSettings,
} from '@hourmere/scheduling'
import { serviceContext } from '../openapi.ts'
import {
  AuditEventPage,
  AuditLogSettings,
  AuditLogSettingsInput,
  auditFilterDescriptions,
} from '../routes/audit-log.ts'
import { defineTool, type Tool } from './tools.ts'

/** The same service, authorization and output as REST GET/PUT /api/v1/audit-*. */
export function auditLogTools(deps: { db: Db; auditLogRetentionDays: AuditRetentionDays }): Tool[] {
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const describe = <T extends z.ZodType>(schema: T, description: string) =>
    schema.openapi({ description })
  return [
    defineTool({
      name: 'list_audit_events',
      title: 'List audit events',
      description: `Lists the current organization's audit journal (who changed what, when), newest first, for the personal space owner or a team owner/admin. Requires full API key scope. Filter by time (from inclusive, to exclusive, RFC 3339 instants with offset), actor (actorType, optionally actorId) and exact action. Times are UTC. Page with limit (1–${AUDIT_PAGE_MAX}, default ${AUDIT_PAGE_DEFAULT}) and nextCursor with the same filters. Never returns session IDs, secrets, names or email addresses.`,
      input: z.strictObject({
        from: describe(AuditEventFilters.shape.from, auditFilterDescriptions.from),
        to: describe(AuditEventFilters.shape.to, auditFilterDescriptions.to),
        actorType: describe(AuditEventFilters.shape.actorType, auditFilterDescriptions.actorType),
        actorId: describe(AuditEventFilters.shape.actorId, auditFilterDescriptions.actorId),
        action: describe(AuditEventFilters.shape.action, auditFilterDescriptions.action),
        cursor: describe(AuditEventFilters.shape.cursor, auditFilterDescriptions.cursor),
        limit: z
          .number()
          .int()
          .optional()
          .openapi({
            description: `Page size, 1–${AUDIT_PAGE_MAX}; default ${AUDIT_PAGE_DEFAULT}`,
          }),
      }),
      output: AuditEventPage,
      annotations: read,
      run(args, call) {
        return listAuditEvents(serviceContext(deps, call.caller), args)
      },
    }),
    defineTool({
      name: 'get_audit_log_settings',
      title: 'Get audit log retention',
      description:
        'Reads how long the current organization keeps its audit journal and the instance default (null days means forever), for the personal space owner or a team owner/admin. Requires full API key scope.',
      input: z.strictObject({}),
      output: AuditLogSettings,
      annotations: read,
      run(_args, call) {
        return getAuditLogSettings(serviceContext(deps, call.caller), deps.auditLogRetentionDays)
      },
    }),
    defineTool({
      name: 'set_audit_log_settings',
      title: 'Set audit log retention',
      description:
        'Sets how long the current organization keeps its audit journal: retention "instance" (the instance default), "forever", or "days" with retentionDays 30–3650. Owners only (personal space owner or team owner); requires full API key scope. A background job later deletes older events; nothing younger than 30 days is deleted. Recorded as audit_log.retention_updated.',
      input: AuditLogSettingsInput,
      output: AuditLogSettings,
      annotations: { ...read, readOnlyHint: false, destructiveHint: true },
      run(args, call) {
        return setAuditLogSettings(
          serviceContext(deps, call.caller),
          deps.auditLogRetentionDays,
          args,
        )
      },
    }),
  ]
}
