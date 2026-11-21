import type { Db } from '@hourmere/db'
import type { Mailer } from '@hourmere/mail'
import type { WorkflowMailLimits } from '@hourmere/notifications/workflow-mail'
import { workflowAuditPort } from './audit.ts'
import type { WorkflowTriggerType } from './definition.ts'
import {
  completeWorkflowEmailRun,
  finishWorkflowRun,
  lockedWorkflowRun,
  releaseWorkflowRun,
  type WorkflowDispatchContext,
  type WorkflowRunClaim,
  workflowRunEligibility,
  workflowRunWindow,
} from './dispatcher.ts'
import { attemptWorkflowEmail } from './email-attempt.ts'
import { workflowExecution } from './hard-off.ts'
import { type WorkflowSettings, workflowsEnabled } from './operator-settings.ts'

interface WorkflowExecutionContext
  extends Pick<WorkflowDispatchContext, 'db' | 'now'>,
    WorkflowSettings {
  budget: WorkflowMailLimits & { secret: string }
  followUpHostNotesEnabled: () => boolean
  mailer: Mailer
  captureWebhook(
    trx: Db,
    input: {
      webhookId: string
      organizationId: string
      bookingId: string
      workflowId: string
      workflowRevision: number
      trigger: WorkflowTriggerType
      workflowRunId: string
    },
    now: Temporal.Instant,
  ): Promise<boolean>
}

/** Route a fenced claim to the existing SMTP attempt service or transactional webhook outbox. */
export const executeWorkflowClaim = workflowExecution(
  async (ctx: WorkflowExecutionContext, claim: WorkflowRunClaim) => {
    if (!workflowsEnabled(ctx)) return
    const recipientId = await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedWorkflowRun(trx, claim.runId)
      if (!locked) return
      const { run, enrollment, auditIdentity } = locked
      if (run.state !== 'claimed' || run.claim_token !== claim.token || !run.lease_until) return
      const live = await workflowRunEligibility(trx, locked)
      const now = ctx.now()
      if (run.lease_until.getTime() <= now.epochMilliseconds) return
      const window = workflowRunWindow(run, now)
      if (window === 'not_due') return
      if (live.reason || window === 'expired') {
        await finishWorkflowRun(trx, locked, live.reason ?? 'expired', now)
        return
      }
      const action = live.captured.actions[0]
      if (action?.type === 'webhook') {
        const queued = await ctx.captureWebhook(
          trx,
          {
            webhookId: action.webhookId,
            organizationId: run.organization_id,
            bookingId: run.booking_id,
            workflowId: enrollment.workflow_id,
            workflowRevision: enrollment.revision,
            trigger: auditIdentity.trigger,
            workflowRunId: run.id,
          },
          now,
        )
        await finishWorkflowRun(trx, locked, queued ? 'completed' : 'retired', now)
        return
      }
      const pending = await trx
        .selectFrom('workflow_recipient_claims')
        .select('id')
        .where('run_id', '=', run.id)
        .where('state', '=', 'pending')
        .where((eb) =>
          eb.or([
            eb('next_attempt_at', 'is', null),
            eb('next_attempt_at', '<=', new Date(now.epochMilliseconds)),
          ]),
        )
        .orderBy('next_attempt_at', (order) => order.asc().nullsFirst())
        .orderBy('id')
        .executeTakeFirst()
      if (pending) return pending.id
      const skipped = await trx
        .selectFrom('workflow_recipient_claims')
        .select('id')
        .where('run_id', '=', run.id)
        .where('skip_reason', '=', 'existing_notification')
        .limit(1)
        .executeTakeFirst()
      const completed = await completeWorkflowEmailRun(
        trx,
        locked,
        now,
        workflowAuditPort,
        skipped ? 'existing_notification' : undefined,
      )
      if (!completed) await releaseWorkflowRun(trx, run.id)
    })
    if (recipientId) await attemptWorkflowEmail(ctx, claim, recipientId)
  },
)
