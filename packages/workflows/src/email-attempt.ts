import { type Mailer, type MailMessage, sendWorkflowSmtpAttempt } from '@hourmere/mail'
import { lockNotificationEmailBudget, workflowRecipientHash } from '@hourmere/notifications'
import { stampWorkflowEmail, type WorkflowMailLimits } from '@hourmere/notifications/workflow-mail'
import {
  completeWorkflowEmailRun,
  dispatchClaimedWorkflowRun,
  finishWorkflowRun,
  lockedWorkflowRun,
  releaseWorkflowRun,
  WORKFLOW_CLAIM_SECONDS,
  type WorkflowDispatchContext,
  type WorkflowRunClaim,
  workflowRunIneligibility,
  workflowRunWindow,
} from './dispatcher.ts'

interface WorkflowEmailMarkerContext extends WorkflowDispatchContext {
  budget: WorkflowMailLimits & { secret: string }
}

type MarkerResult = 'marked' | 'expired' | 'budget_suppressed' | 'stale' | 'waiting'
type SmtpOutcome = Awaited<ReturnType<typeof sendWorkflowSmtpAttempt>>
const date = (value: Temporal.Instant) => new Date(value.epochMilliseconds)

// If admission itself runs out of time, roll back its stamp before finishing the run.
class MarkerWindowClosed extends Error {
  readonly result: 'expired' | 'stale'

  constructor(result: 'expired' | 'stale') {
    super('Workflow email marker window closed')
    this.result = result
  }
}

/** The caller supplies a recipient and rendered content; live recipient policy belongs to the
 * attempt caller. Bind the supplied address to the captured digest before charging or sending. */
export async function markWorkflowEmailAttempt(
  ctx: WorkflowEmailMarkerContext,
  claim: WorkflowRunClaim,
  recipientClaimId: string,
  recipientEmail: string,
): Promise<MarkerResult> {
  try {
    return await ctx.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // Organization -> shared budget -> booking/definition -> run -> recipient.
        const locked = await lockedWorkflowRun(trx, claim.runId, lockNotificationEmailBudget)
        if (!locked) return 'stale'
        const { run } = locked
        if (run.state !== 'claimed' || run.claim_token !== claim.token || !run.lease_until)
          return 'stale'
        // One in-flight recipient per run lease. Finishing it releases the lease, so a safe
        // retry always gets a fresh token and cannot be reversed by the previous worker.
        const active = await trx
          .selectFrom('workflow_recipient_claims')
          .select('id')
          .where('run_id', '=', run.id)
          .where('state', '=', 'dispatching')
          .executeTakeFirst()
        if (active) return 'stale'
        const recipient = await trx
          .selectFrom('workflow_recipient_claims')
          .select(['recipient_hash', 'attempts', 'next_attempt_at'])
          .where('run_id', '=', run.id)
          .where('id', '=', recipientClaimId)
          .where('state', '=', 'pending')
          .forUpdate()
          .executeTakeFirst()
        const recipientHash = workflowRecipientHash(recipientEmail, ctx.budget.secret)
        if (!recipient?.recipient_hash.equals(recipientHash)) return 'stale'

        const ineligible = await workflowRunIneligibility(trx, locked)
        const now = ctx.now()
        const window = workflowRunWindow(run, now)
        if (run.lease_until <= date(now) || window === 'not_due') return 'stale'
        if (ineligible || window === 'expired') {
          await finishWorkflowRun(trx, locked, ineligible ?? 'expired', now)
          return ineligible ? 'stale' : 'expired'
        }
        if (recipient.next_attempt_at && recipient.next_attempt_at > date(now)) return 'waiting'

        const admission = await stampWorkflowEmail(
          trx,
          ctx.budget,
          {
            organizationId: run.organization_id,
            runId: run.id,
            claimId: recipientClaimId,
            recipientHash,
          },
          date(now),
          recipient.attempts > 0 ? {} : undefined,
        )
        const markerTime = ctx.now()
        if (workflowRunWindow(run, markerTime) === 'expired')
          throw new MarkerWindowClosed('expired')
        if (run.lease_until <= date(markerTime)) throw new MarkerWindowClosed('stale')
        if (admission.status === 'budget_suppressed') {
          await trx
            .updateTable('workflow_recipient_claims')
            .set({
              state: 'skipped',
              skip_reason: 'budget_suppressed',
              next_attempt_at: null,
              finished_at: date(markerTime),
            })
            .where('id', '=', recipientClaimId)
            .execute()
          if (!(await completeWorkflowEmailRun(trx, locked, markerTime, 'budget_suppressed')))
            await releaseWorkflowRun(trx, run.id)
          return 'budget_suppressed'
        }
        if (admission.status !== 'admitted') return 'stale'

        await trx
          .updateTable('workflow_runs')
          .set({ lease_until: date(markerTime.add({ seconds: WORKFLOW_CLAIM_SECONDS })) })
          .where('id', '=', run.id)
          .execute()
        await trx
          .updateTable('workflow_recipient_claims')
          .set({
            state: 'dispatching',
            claim_token: claim.token,
            attempts: recipient.attempts + 1,
            next_attempt_at: null,
          })
          .where('id', '=', recipientClaimId)
          .execute()
        return 'marked'
      })
  } catch (error) {
    if (!(error instanceof MarkerWindowClosed)) throw error
    if (error.result === 'expired') await dispatchClaimedWorkflowRun(ctx, claim)
    return error.result
  }
}

/** Only the worker whose token is on this marker can settle it. An expired-lease repair
 * may already have changed it to delivery_unknown, which is final. */
export async function finishWorkflowEmailAttempt(
  ctx: WorkflowDispatchContext,
  claim: WorkflowRunClaim,
  recipientClaimId: string,
  outcome: SmtpOutcome,
): Promise<Exclude<SmtpOutcome, 'known_not_sent'> | 'retry_scheduled' | 'expired' | 'stale'> {
  return ctx.db.transaction().execute(async (trx) => {
    const locked = await lockedWorkflowRun(trx, claim.runId)
    if (!locked) return 'stale'
    const { run } = locked
    const marker = await trx
      .selectFrom('workflow_recipient_claims')
      .select('attempts')
      .where('run_id', '=', run.id)
      .where('id', '=', recipientClaimId)
      .where('state', '=', 'dispatching')
      .where('claim_token', '=', claim.token)
      .forUpdate()
      .executeTakeFirst()
    if (!marker) return 'stale'

    const now = ctx.now()
    const recipient = trx
      .updateTable('workflow_recipient_claims')
      .where('id', '=', recipientClaimId)
    const runIsClaimed = run.state === 'claimed'
    if (outcome === 'known_not_sent' && workflowRunWindow(run, now) !== 'expired') {
      const delayMinutes = Math.min(15, 2 ** Math.min(marker.attempts - 1, 4))
      const nextAttempt = new Date(
        Math.min(run.expires_at.getTime(), now.add({ minutes: delayMinutes }).epochMilliseconds),
      )
      await recipient
        .set({
          state: 'pending',
          claim_token: null,
          next_attempt_at: runIsClaimed ? nextAttempt : null,
        })
        .execute()
      if (!runIsClaimed) return 'stale'
      await releaseWorkflowRun(trx, run.id)
      return 'retry_scheduled'
    }

    const state = outcome === 'known_not_sent' ? 'skipped' : outcome
    const reason = state === 'skipped' ? 'expired' : null
    await recipient
      .set({
        state,
        claim_token: null,
        skip_reason: reason,
        finished_at: date(now),
      })
      .execute()
    if (runIsClaimed && !(await completeWorkflowEmailRun(trx, locked, now, reason ?? undefined)))
      await releaseWorkflowRun(trx, run.id)
    return outcome === 'known_not_sent' ? 'expired' : outcome
  })
}

/** Internal attempt service. No registered workflow worker supplies a message while hard-off. */
export async function attemptWorkflowEmail(
  ctx: WorkflowEmailMarkerContext & { mailer: Mailer },
  claim: WorkflowRunClaim,
  recipientClaimId: string,
  message: MailMessage,
) {
  const outbound = {
    ...message,
    sensitive: true,
    messageId: `<workflow-${recipientClaimId}@hourmere.invalid>`,
  }
  const marked = await markWorkflowEmailAttempt(ctx, claim, recipientClaimId, outbound.to)
  if (marked !== 'marked') return marked
  const outcome = await sendWorkflowSmtpAttempt(ctx.mailer, outbound)
  return finishWorkflowEmailAttempt(ctx, claim, recipientClaimId, outcome)
}
