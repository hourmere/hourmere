import { interfaceLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { type Mailer, type MailMessage, sendWorkflowSmtpAttempt } from '@hourmere/mail'
import { lockNotificationEmailBudget, workflowRecipientHash } from '@hourmere/notifications'
import { stampWorkflowEmail, type WorkflowMailLimits } from '@hourmere/notifications/workflow-mail'
import { findPublicBookingPath, parseQuestions } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import type { NotificationSnapshot } from '@hourmere/scheduling/notification-settings'
import { hardOffWorkflowAuditPort } from './audit.ts'
import { coreWorkflowIntents } from './capture.ts'
import {
  completeWorkflowEmailRun,
  dispatchClaimedWorkflowRun,
  finishWorkflowRun,
  lockedWorkflowRun,
  releaseWorkflowRun,
  WORKFLOW_CLAIM_SECONDS,
  type WorkflowDispatchContext,
  type WorkflowRunClaim,
  workflowRunEligibility,
  workflowRunWindow,
} from './dispatcher.ts'
import { renderWorkflowEmail, type WorkflowEmailAction, type WorkflowEmailInput } from './email.ts'
import { templatePlaceholders } from './variables.ts'

interface WorkflowEmailMarkerContext extends WorkflowDispatchContext {
  budget: WorkflowMailLimits & { secret: string }
  followUpHostNotesEnabled: () => boolean
}

type RecipientSkip = 'budget_suppressed' | 'existing_notification' | 'render_limit'
type MarkerResult = { message: MailMessage } | RecipientSkip | 'expired' | 'stale' | 'waiting'
type SmtpOutcome = Awaited<ReturnType<typeof sendWorkflowSmtpAttempt>>
const date = (value: Temporal.Instant) => new Date(value.epochMilliseconds)
const instant = (value: Date) => Temporal.Instant.fromEpochMilliseconds(value.getTime())

async function liveEmailAudience(trx: Db, bookingId: string, organizationId: string) {
  const attendees = await trx
    .selectFrom('booking_attendees')
    .select(['id', 'name', 'email', 'time_zone', 'locale', 'is_booker'])
    .where('booking_id', '=', bookingId)
    .orderBy('id')
    .forShare()
    .execute()
  const locale = attendees.find((row) => row.is_booker)?.locale ?? 'en'
  const hosts = await trx
    .selectFrom('booking_hosts as h')
    .innerJoin('auth.user as u', 'u.id', 'h.user_id')
    .innerJoin('auth.member as m', (join) =>
      join.onRef('m.userId', '=', 'u.id').on('m.organizationId', '=', organizationId),
    )
    .leftJoin('profiles as p', 'p.user_id', 'u.id')
    .leftJoin('schedules as s', (join) =>
      join.onRef('s.user_id', '=', 'u.id').on('s.is_default', '=', true),
    )
    .select([
      'u.id',
      'u.name',
      'u.email',
      'p.locale',
      'p.time_zone',
      's.time_zone as schedule_zone',
    ])
    .where('h.booking_id', '=', bookingId)
    .where('u.emailVerified', '=', true)
    .execute()
  return [
    ...attendees.map((row) => ({
      identity: `attendee:${row.id}`,
      kind: row.is_booker ? ('booker' as const) : ('guests' as const),
      name: row.name,
      email: row.email,
      timeZone: row.time_zone,
      locale,
    })),
    ...hosts.map((row) => ({
      identity: `host:${row.id}`,
      kind: 'hosts' as const,
      name: row.name,
      email: row.email,
      timeZone: row.time_zone ?? row.schedule_zone ?? 'UTC',
      locale: row.locale ?? 'en',
    })),
  ]
}

type EligibleRun = Extract<
  Awaited<ReturnType<typeof workflowRunEligibility>>,
  { reason: undefined }
>

async function workflowEmailInput(
  trx: Db,
  ctx: WorkflowEmailMarkerContext,
  { booking, eventType, captured }: EligibleRun,
  action: WorkflowEmailAction,
  recipient: Awaited<ReturnType<typeof liveEmailAudience>>[number],
): Promise<WorkflowEmailInput> {
  const locale = interfaceLanguage(recipient.locale)
  let hostTextEnabled = ctx.followUpHostNotesEnabled()
  const custom = hostTextEnabled && locale ? action.content?.[locale] : undefined
  const usesPublicPath =
    custom &&
    [custom.subject, custom.body].some((text) =>
      templatePlaceholders(text)?.includes('event_type.public_path'),
    )
  let publicPath: string | undefined
  if (usesPublicPath) {
    publicPath = await findPublicBookingPath(trx, eventType.id)
    hostTextEnabled = ctx.followUpHostNotesEnabled()
  }
  const personal = eventType.owner_user_id !== null
  const eventScoped = captured.scope.type === 'event_type'
  const answers =
    hostTextEnabled && custom && personal && eventScoped && !action.recipients.includes('guests')
      ? Object.fromEntries(
          Object.entries(booking.responses ?? {}).filter(
            (entry): entry is [string, string | number | boolean | null] =>
              entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1]),
          ),
        )
      : undefined
  return {
    action,
    trigger: captured.trigger.type,
    followUpHostNotesEnabled: hostTextEnabled,
    context: {
      owner: personal ? 'personal' : 'team',
      eventType: eventScoped
        ? {
            id: eventType.id,
            organizationId: eventType.organization_id,
            ownerUserId: eventType.owner_user_id,
            bookingMode: eventType.booking_mode,
            deleted: false,
            questions: parseQuestions(eventType.questions),
          }
        : undefined,
    },
    recipient,
    eventType: { title: eventType.title, publicPath: publicPath ?? null },
    booking: { start: instant(booking.start_at), end: instant(booking.end_at) },
    ...(answers && { answers }),
  }
}

// If admission itself runs out of time, roll back its stamp before finishing the run.
class MarkerWindowClosed extends Error {
  readonly result: 'expired' | 'stale'

  constructor(result: 'expired' | 'stale') {
    super('Workflow email marker window closed')
    this.result = result
  }
}

/** Resolve the captured recipient and content after lifecycle locks, then commit the only
 * authorization for SMTP together with its charge. */
export async function markWorkflowEmailAttempt(
  ctx: WorkflowEmailMarkerContext,
  claim: WorkflowRunClaim,
  recipientClaimId: string,
): Promise<MarkerResult> {
  try {
    return await ctx.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        // Identity -> organization -> shared budget -> booking/definition -> run -> recipient.
        const locked = await lockedWorkflowRun(trx, claim.runId, {
          recipientClaimId,
          afterOrganization: lockNotificationEmailBudget,
        })
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
          .selectAll()
          .where('run_id', '=', run.id)
          .where('id', '=', recipientClaimId)
          .forUpdate()
          .executeTakeFirst()
        if (!recipient || !['pending', 'skipped'].includes(recipient.state)) return 'stale'

        const live = await workflowRunEligibility(trx, locked)
        let now = ctx.now()
        const window = workflowRunWindow(run, now)
        if (run.lease_until <= date(now) || window === 'not_due') return 'stale'
        if (live.reason || window === 'expired') {
          await finishWorkflowRun(trx, locked, live.reason ?? 'expired', now, ctx.audit)
          return live.reason ? 'stale' : 'expired'
        }
        if (recipient.next_attempt_at && recipient.next_attempt_at > date(now)) return 'waiting'
        if (recipient.state === 'skipped') {
          if (recipient.skip_reason !== 'existing_notification') return 'stale'
          await completeWorkflowEmailRun(trx, locked, now, ctx.audit, 'existing_notification')
          return 'existing_notification'
        }

        const action = live.captured.actions[0]
        if (action?.type !== 'email') return 'stale'
        // Leave the intent intact for dedupe and let the dispatcher expire it. In the
        // meantime, a new lease can serve the remaining eligible recipients.
        const deferUnavailableRecipient = async () => {
          await trx
            .updateTable('workflow_recipient_claims')
            .set({ next_attempt_at: run.expires_at })
            .where('id', '=', recipientClaimId)
            .execute()
          await releaseWorkflowRun(trx, run.id)
          return 'stale' as const
        }
        const audience = await liveEmailAudience(trx, run.booking_id, run.organization_id)
        const target = audience.find(({ identity }) => identity === recipient.recipient)
        if (!target || !action.recipients.includes(target.kind)) return deferUnavailableRecipient()
        const { secret } = ctx.budget
        const recipientHash = workflowRecipientHash(target.email, secret)
        if (!recipient.recipient_hash.equals(recipientHash)) return deferUnavailableRecipient()

        const skip = async (reason: RecipientSkip, at: Temporal.Instant) => {
          await trx
            .updateTable('workflow_recipient_claims')
            .set({
              state: 'skipped',
              skip_reason: reason,
              next_attempt_at: null,
              finished_at: date(at),
            })
            .where('id', '=', recipientClaimId)
            .execute()
          if (!(await completeWorkflowEmailRun(trx, locked, at, ctx.audit, reason)))
            await releaseWorkflowRun(trx, run.id)
          return reason
        }
        const trigger = live.captured.trigger
        if (trigger.type === 'before_start' || trigger.type === 'after_end') {
          const intent = `${trigger.type}:${trigger.offsetMinutes}:${recipientHash.toString('hex')}`
          const snapshot = live.booking
            .notification_snapshot as unknown as NotificationSnapshot | null
          if (coreWorkflowIntents(snapshot, audience, secret).has(intent))
            return skip('existing_notification', ctx.now())
        }

        const input = await workflowEmailInput(trx, ctx, live, action, target)
        let rendered: ReturnType<typeof renderWorkflowEmail>
        try {
          rendered = renderWorkflowEmail(input)
        } catch (error) {
          if (!(error instanceof DomainError)) throw error
          if (error.code === 'render_limit') return skip('render_limit', ctx.now())
          if (error.code === 'invalid_workflow') return deferUnavailableRecipient()
          throw error
        }
        now = ctx.now()
        if (run.lease_until <= date(now)) return 'stale'
        if (workflowRunWindow(run, now) === 'expired') {
          await finishWorkflowRun(trx, locked, 'expired', now, ctx.audit)
          return 'expired'
        }

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
        if (admission.status === 'budget_suppressed') return skip('budget_suppressed', markerTime)
        if (admission.status !== 'admitted') return 'stale'

        await trx
          .updateTable('workflow_runs')
          .set({ lease_until: date(markerTime.add({ seconds: WORKFLOW_CLAIM_SECONDS })) })
          .where('id', '=', run.id)
          .execute()
        if (rendered.contentSource === 'custom' && !ctx.followUpHostNotesEnabled())
          rendered = renderWorkflowEmail({ ...input, followUpHostNotesEnabled: false })
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
        await (ctx.audit ?? hardOffWorkflowAuditPort()).record(trx, {
          ...locked.auditIdentity,
          event: 'workflow.email_attempted',
          actor: { kind: 'background', job: 'dispatch' },
          occurredAt: markerTime,
        })
        return {
          message: {
            to: target.email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            sensitive: true,
            messageId: `<workflow-${recipientClaimId}@hourmere.invalid>`,
          },
        }
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
    if (state !== 'skipped')
      await (ctx.audit ?? hardOffWorkflowAuditPort()).record(trx, {
        ...locked.auditIdentity,
        event: `workflow.email_${state}`,
        actor: { kind: 'background', job: 'dispatch' },
        occurredAt: now,
      })
    if (
      runIsClaimed &&
      !(await completeWorkflowEmailRun(trx, locked, now, ctx.audit, reason ?? undefined))
    )
      await releaseWorkflowRun(trx, run.id)
    return outcome === 'known_not_sent' ? 'expired' : outcome
  })
}

/** Internal attempt service. SMTP starts only after the marker transaction releases its locks. */
export async function attemptWorkflowEmail(
  ctx: WorkflowEmailMarkerContext & { mailer: Mailer },
  claim: WorkflowRunClaim,
  recipientClaimId: string,
) {
  const marked = await markWorkflowEmailAttempt(ctx, claim, recipientClaimId)
  if (typeof marked === 'string') return marked
  const outcome = await sendWorkflowSmtpAttempt(ctx.mailer, marked.message)
  return finishWorkflowEmailAttempt(ctx, claim, recipientClaimId, outcome)
}
