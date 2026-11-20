import { ApiKeyScopeError } from '@hourmere/auth'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { hardOffWorkflowAuditPort, workflowAuditActor } from './audit.ts'
import { type WorkflowCreateContext, writableOwner } from './creates.ts'
import { workflowOperation } from './hard-off.ts'
import { uuidSchema } from './ownership.ts'

export const DeleteWorkflowInputSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
})
export type DeleteWorkflowInput = z.input<typeof DeleteWorkflowInputSchema>
export type WorkflowDeleteContext = WorkflowCreateContext
const notFound = () => new DomainError('not_found', 'workflow_not_found', 'No such workflow')

/** Retain identity and creation keys; retire pending work only after taking the tombstone. */
export async function deleteWorkflowDefinition(
  ctx: WorkflowDeleteContext,
  id: string,
  input: unknown,
): Promise<void> {
  if (ctx.principal.kind === 'api_key' && ctx.principal.apiKeyScope !== 'full')
    throw new ApiKeyScopeError()
  const parsed = DeleteWorkflowInputSchema.safeParse(input)
  if (!parsed.success)
    throw new DomainError('invalid', 'invalid_workflow', 'Invalid workflow definition')
  if (!uuidSchema.safeParse(id).success) throw notFound()
  await ctx.db.transaction().execute(async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    const identity = await trx
      .selectFrom('workflow_definitions')
      .select(['organization_id', 'owner_user_id'])
      .where('id', '=', id)
      .where('organization_id', '=', ctx.principal.organization.id)
      .executeTakeFirst()
    if (!identity) throw notFound()
    // Identity, organization and owner locks precede the definition and its runs. Recheck
    // current membership even for a retained tombstone: a replay grants no authority.
    const owner = await writableOwner(
      trx,
      ctx,
      identity.owner_user_id
        ? { kind: 'personal', id: identity.owner_user_id }
        : { kind: 'team', id: identity.organization_id },
    )
    const current = await trx
      .selectFrom('workflow_definitions')
      .select(['id', 'revision', 'deleted_at'])
      .where('id', '=', id)
      .where('organization_id', '=', owner.organizationId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) throw notFound()
    if (current.revision !== parsed.data.expectedRevision)
      throw new DomainError('conflict', 'workflow_revision_conflict')
    if (current.deleted_at !== null) return

    await trx
      .updateTable('workflow_definitions')
      .set({ enabled: false, deleted_at: sql`now()` })
      .where('id', '=', id)
      .execute()
    // Capture shares the live definition before inserting runs, so a carried timer either
    // commits before this update and is retired here, or sees the tombstone and cannot start.
    await trx
      .updateTable('workflow_runs')
      .set({ state: 'retired', finished_at: sql`now()` })
      .where('organization_id', '=', owner.organizationId)
      .where('state', '=', 'pending')
      .where('enrollment_id', 'in', (eb) =>
        eb
          .selectFrom('workflow_enrollments')
          .select('id')
          .where('organization_id', '=', owner.organizationId)
          .where('workflow_id', '=', id),
      )
      .execute()
    // History, enrollments, recipient claims and mail charges retain their own lifetimes.
    // Claimed runs require the dispatcher's live-definition check before an attempt.
    await (ctx.audit ?? hardOffWorkflowAuditPort()).record(trx, {
      event: 'workflow.deleted',
      occurredAt: Temporal.Now.instant(),
      owner,
      workflowId: current.id,
      revision: current.revision,
      actor: workflowAuditActor(ctx.principal),
    })
  })
}

export const deleteWorkflow = workflowOperation(deleteWorkflowDefinition)
