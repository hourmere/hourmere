import { ApiKeyScopeError } from '@hourmere/auth'
import { teamWriteTransaction } from '@hourmere/db/team-write'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { workflowAuditActor, workflowAuditPort } from './audit.ts'
import { WorkflowConditionsSchema } from './conditions.ts'
import { type WorkflowCreateContext, writableOwner } from './creates.ts'
import { WorkflowDefinitionSchema } from './definition.ts'
import { workflowOperation } from './hard-off.ts'
import { WORKFLOW_MAX_ENABLED_PER_EVENT } from './limits.ts'
import { uuidSchema } from './ownership.ts'
import { type WorkflowView, workflowView } from './reads.ts'
import { validateWorkflowWriteDefinition } from './write-definition.ts'

export const UpdateWorkflowInputSchema = WorkflowDefinitionSchema.partial().extend({
  expectedRevision: z.number().int().min(1),
  enabled: z.boolean().optional(),
  conditions: WorkflowConditionsSchema.optional(),
})
export type UpdateWorkflowInput = z.input<typeof UpdateWorkflowInputSchema>
export type WorkflowUpdateContext = WorkflowCreateContext
const notFound = () => new DomainError('not_found', 'workflow_not_found', 'No such workflow')
const invalid = () => new DomainError('invalid', 'invalid_workflow', 'Invalid workflow definition')
const limitReached = () => new DomainError('conflict', 'workflow_limit_reached')

export async function updateWorkflowDefinition(
  ctx: WorkflowUpdateContext,
  id: string,
  input: unknown,
): Promise<WorkflowView> {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')
    throw new ApiKeyScopeError()
  const parsed = UpdateWorkflowInputSchema.safeParse(input)
  if (!parsed.success) throw invalid()
  if (!uuidSchema.safeParse(id).success) throw notFound()
  const { expectedRevision, ...patch } = parsed.data
  return teamWriteTransaction(ctx.db.transaction(), async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    // This lookup reveals nothing outside the current organization; lock and re-read below.
    const identity = await trx
      .selectFrom('workflow_definitions')
      .select(['organization_id', 'owner_user_id'])
      .where('id', '=', id)
      .where('organization_id', '=', ctx.principal.organization.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!identity) throw notFound()
    const owner = await writableOwner(
      trx,
      ctx,
      identity.owner_user_id
        ? { kind: 'personal', id: identity.owner_user_id }
        : { kind: 'team', id: identity.organization_id },
    )
    const current = await trx
      .selectFrom('workflow_definitions as d')
      .innerJoin('workflow_revisions as r', (join) =>
        join
          .onRef('r.workflow_id', '=', 'd.id')
          .onRef('r.revision', '=', 'd.revision')
          .onRef('r.organization_id', '=', 'd.organization_id'),
      )
      .select(['d.id', 'd.revision', 'd.enabled', 'd.created_at', 'd.updated_at', 'r.definition'])
      .where('d.id', '=', id)
      .where('d.organization_id', '=', owner.organizationId)
      .where('d.deleted_at', 'is', null)
      .forUpdate('d')
      .executeTakeFirst()
    if (!current) throw notFound()
    if (current.revision !== expectedRevision)
      throw new DomainError('conflict', 'workflow_revision_conflict')
    const candidate = WorkflowDefinitionSchema.parse({
      ...(current.definition as object),
      enabled: current.enabled,
      ...patch,
    })
    const disableOnly = patch.enabled === false && Object.keys(patch).length === 1
    const definition = disableOnly
      ? candidate
      : await validateWorkflowWriteDefinition(trx, candidate, owner, ctx.followUpHostNotesEnabled)
    const existing = await trx
      .selectFrom('workflow_definitions as d')
      .innerJoin('workflow_revisions as r', (join) =>
        join.onRef('r.workflow_id', '=', 'd.id').onRef('r.revision', '=', 'd.revision'),
      )
      .select(['d.enabled', 'r.definition'])
      .where('d.organization_id', '=', owner.organizationId)
      .where(
        'd.owner_user_id',
        owner.kind === 'personal' ? '=' : 'is',
        owner.kind === 'personal' ? owner.userId : null,
      )
      .where('d.deleted_at', 'is', null)
      .where('d.id', '!=', id)
      .execute()
    if (definition.enabled) {
      const scopes = existing
        .filter((row) => row.enabled)
        .map(
          (row) =>
            WorkflowDefinitionSchema.parse({ ...(row.definition as object), enabled: true }).scope,
        )
      const all = scopes.filter((scope) => scope.type === 'all_event_types').length
      const perEvent = new Map<string, number>()
      for (const scope of scopes)
        if (scope.type === 'event_type')
          perEvent.set(scope.eventTypeId, (perEvent.get(scope.eventTypeId) ?? 0) + 1)
      const count =
        definition.scope.type === 'event_type'
          ? all + (perEvent.get(definition.scope.eventTypeId) ?? 0)
          : all + Math.max(0, ...perEvent.values())
      if (count >= WORKFLOW_MAX_ENABLED_PER_EVENT) throw limitReached()
    }

    const { enabled, ...revision } = definition
    const edited = Object.keys(patch).some((key) => key !== 'enabled')
    const nextRevision = current.revision + (edited ? 1 : 0)
    if (edited)
      await trx
        .insertInto('workflow_revisions')
        .values({
          organization_id: owner.organizationId,
          workflow_id: id,
          revision: nextRevision,
          definition: sql`${JSON.stringify(revision)}::jsonb`,
        })
        .execute()
    const row = await trx
      .updateTable('workflow_definitions')
      .set({ enabled })
      .where('id', '=', id)
      .returning(['id', 'revision', 'enabled', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()
    const audit = ctx.audit ?? workflowAuditPort
    const auditEvents = [
      ...(edited ? ['workflow.updated' as const] : []),
      ...(enabled !== current.enabled
        ? [enabled ? ('workflow.enabled' as const) : ('workflow.disabled' as const)]
        : []),
    ]
    for (const event of auditEvents)
      await audit.record(trx, {
        event,
        occurredAt: Temporal.Now.instant(),
        owner,
        workflowId: row.id,
        revision: nextRevision,
        trigger: definition.trigger.type,
        actor: workflowAuditActor(ctx.principal),
      })
    return workflowView(owner, { ...row, definition: revision })
  })
}
export const updateWorkflow = workflowOperation(
  (ctx: Omit<WorkflowUpdateContext, 'audit'>, id: string, input: unknown) =>
    updateWorkflowDefinition({ ...ctx, audit: workflowAuditPort }, id, input),
)
