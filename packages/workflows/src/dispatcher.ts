// Internal due-work machinery. A ready claim still needs a fenced attempt marker.
import { randomUUID } from 'node:crypto'
import { type Db, isImportedBooking } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'
import type { WorkflowSkipReason } from './audit.ts'
import { WorkflowDefinitionSchema } from './definition.ts'
import { workflowExecution } from './hard-off.ts'
import { WORKFLOW_MAX_LATE_MINUTES } from './limits.ts'
import { workflowDispatchWindow, workflowTimerDueAt } from './timers.ts'

export const WORKFLOW_DISPATCH_PAGE = 100
export const WORKFLOW_CLAIM_SECONDS = 60
export interface WorkflowDispatchContext {
  db: Db
  now: () => Temporal.Instant
}
export interface WorkflowRunClaim {
  runId: string
  token: string
}
export interface WorkflowClaimOptions {
  runId?: string
  limit?: number
}
export interface WorkflowWakePort {
  /** Enqueue only this opaque identity, transactionally and idempotently by run ID. */
  ensureWake(trx: Db, runId: string): Promise<void>
}
const date = (value: Temporal.Instant) => new Date(value.epochMilliseconds)
const instant = (value: Date) => Temporal.Instant.fromEpochMilliseconds(value.getTime())
function page(value = WORKFLOW_DISPATCH_PAGE) {
  if (!Number.isInteger(value) || value < 1 || value > WORKFLOW_DISPATCH_PAGE)
    throw new RangeError('Invalid workflow dispatch page size')
  return value
}

/** Re-read after each parent wait; never lock a run before its definition or booking. */
export async function lockedWorkflowRun(
  trx: Db,
  runId: string,
  options?: { recipientClaimId: string; afterOrganization: (trx: Db) => Promise<void> },
) {
  const identity = await trx
    .selectFrom('workflow_runs as r')
    .innerJoin('workflow_enrollments as e', 'e.id', 'r.enrollment_id')
    .select(['r.organization_id', 'r.booking_id', 'e.workflow_id'])
    .where('r.id', '=', runId)
    .executeTakeFirst()
  if (!identity) return
  const personal = await trx
    .selectFrom('personal_organizations')
    .select('user_id')
    .where('organization_id', '=', identity.organization_id)
    .executeTakeFirst()
  const recipient = options
    ? await trx
        .selectFrom('workflow_recipient_claims')
        .select('recipient')
        .where('run_id', '=', runId)
        .where('id', '=', options.recipientClaimId)
        .where('state', '=', 'pending')
        .executeTakeFirst()
    : undefined
  const identityUsers = personal ? [personal.user_id] : []
  if (recipient?.recipient.startsWith('host:')) identityUsers.push(recipient.recipient.slice(5))
  if (identityUsers.length)
    await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', 'in', identityUsers)
      .orderBy('id')
      .forShare()
      .execute()
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', identity.organization_id)
    .forKeyShare()
    .executeTakeFirst()
  if (!organization) return
  await options?.afterOrganization(trx)
  const booking = await trx
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', identity.booking_id)
    .where('organization_id', '=', identity.organization_id)
    .forShare()
    .executeTakeFirst()
  const definition = await trx
    .selectFrom('workflow_definitions')
    .selectAll()
    .where('id', '=', identity.workflow_id)
    .where('organization_id', '=', identity.organization_id)
    .forShare()
    .executeTakeFirst()
  const run = await trx
    .selectFrom('workflow_runs')
    .selectAll()
    .where('id', '=', runId)
    .forUpdate()
    .executeTakeFirst()
  if (!run) return
  const enrollment = await trx
    .selectFrom('workflow_enrollments')
    .selectAll()
    .where('id', '=', run.enrollment_id)
    .executeTakeFirstOrThrow()
  return { run, enrollment, definition, booking }
}
type LockedRun = NonNullable<Awaited<ReturnType<typeof lockedWorkflowRun>>>
export function workflowRunWindow(run: LockedRun['run'], now: Temporal.Instant) {
  return workflowDispatchWindow(
    { dueAt: instant(run.due_at), expiresAt: instant(run.expires_at) },
    now,
  )
}

export async function finishWorkflowRun(
  trx: Db,
  locked: LockedRun,
  result: WorkflowSkipReason | 'completed' | 'retired',
  now: Temporal.Instant,
) {
  const { run, enrollment, definition } = locked
  const terminal = result === 'retired' || result === 'completed'
  await trx
    .updateTable('workflow_runs')
    .set({
      state: terminal ? result : 'skipped',
      skip_reason: terminal ? null : result,
      claim_token: null,
      lease_until: null,
      finished_at: date(now),
    })
    .where('id', '=', run.id)
    .execute()
  if (!terminal)
    await trx
      .updateTable('workflow_recipient_claims')
      .set({
        state: 'skipped',
        skip_reason: result,
        claim_token: null,
        next_attempt_at: null,
        finished_at: date(now),
      })
      .where('run_id', '=', run.id)
      .where('state', '=', 'pending')
      .execute()
  if (definition) {
    const counts = await trx
      .selectFrom('workflow_recipient_claims')
      .select([
        sql<number>`count(*) FILTER (WHERE state = 'sent')::integer`.as('sent'),
        sql<number>`count(*) FILTER (WHERE state = 'rejected')::integer`.as('rejected'),
        sql<number>`count(*) FILTER (WHERE state = 'delivery_unknown')::integer`.as(
          'delivery_unknown',
        ),
        sql<number>`count(*) FILTER (WHERE state = 'skipped')::integer`.as('skipped'),
      ])
      .where('run_id', '=', run.id)
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('workflow_run_history')
      .values({
        run_id: run.id,
        organization_id: run.organization_id,
        workflow_id: enrollment.workflow_id,
        revision: enrollment.revision,
        trigger: enrollment.trigger,
        due_at: run.due_at,
        finished_at: date(now),
        outcome: terminal ? result : 'skipped',
        reason: terminal ? null : result,
        ...counts,
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute()
  }
}

export async function releaseWorkflowRun(trx: Db, runId: string) {
  await trx
    .updateTable('workflow_runs')
    .set({ state: 'pending', claim_token: null, lease_until: null })
    .where('id', '=', runId)
    .execute()
}

/** Finish only after every recipient of an email run reaches an outcome. */
export async function completeWorkflowEmailRun(
  trx: Db,
  locked: LockedRun,
  now: Temporal.Instant,
  skipReason?: 'budget_suppressed' | 'expired' | 'existing_notification' | 'render_limit',
) {
  const recipients = await trx
    .selectFrom('workflow_recipient_claims')
    .select('state')
    .where('run_id', '=', locked.run.id)
    .execute()
  if (recipients.some(({ state }) => state === 'pending' || state === 'dispatching')) return false
  await finishWorkflowRun(
    trx,
    locked,
    skipReason && recipients.every(({ state }) => state === 'skipped') ? skipReason : 'completed',
    now,
  )
  return true
}

async function recoverWorkflowEmailMarker(trx: Db, locked: LockedRun, now: Temporal.Instant) {
  const abandoned = await trx
    .updateTable('workflow_recipient_claims')
    .set({ state: 'delivery_unknown', claim_token: null, finished_at: date(now) })
    .where('run_id', '=', locked.run.id)
    .where('state', '=', 'dispatching')
    .executeTakeFirst()
  return abandoned.numUpdatedRows > 0n
}

export async function workflowRunEligibility(trx: Db, locked: LockedRun) {
  const { booking, definition, enrollment, run } = locked
  const retired = { reason: 'retired' } as const
  if (!definition || definition.deleted_at !== null || !booking) return retired
  if (!definition.enabled) return { reason: 'workflow_disabled' } as const
  if (
    booking.status !== (enrollment.trigger === 'booking.cancelled' ? 'cancelled' : 'confirmed') ||
    booking.group_slot_id !== null ||
    !booking.event_type_id ||
    !['web', 'embed', 'api', 'mcp'].includes(booking.source) ||
    (await isImportedBooking(trx, booking.id))
  )
    return retired
  const eventType = await trx
    .selectFrom('event_types')
    .selectAll()
    .where('id', '=', booking.event_type_id)
    .forShare()
    .executeTakeFirst()
  if (
    !eventType ||
    eventType.deleted_at !== null ||
    eventType.booking_mode !== 'individual' ||
    eventType.organization_id !== run.organization_id ||
    eventType.owner_user_id !== definition.owner_user_id
  )
    return retired
  const successor = await trx
    .selectFrom('bookings')
    .select('id')
    .where('rescheduled_from_id', '=', booking.id)
    .executeTakeFirst()
  if (successor) return retired
  const revision = await trx
    .selectFrom('workflow_revisions')
    .select('definition')
    .where('organization_id', '=', run.organization_id)
    .where('workflow_id', '=', enrollment.workflow_id)
    .where('revision', '=', enrollment.revision)
    .executeTakeFirst()
  const captured = WorkflowDefinitionSchema.safeParse(revision?.definition)
  if (!captured.success) return retired
  const trigger = captured.data.trigger
  if (
    trigger.type !== enrollment.trigger ||
    (captured.data.scope.type === 'event_type' && captured.data.scope.eventTypeId !== eventType.id)
  )
    return retired
  if (trigger.type === 'before_start' || trigger.type === 'after_end') {
    const due = workflowTimerDueAt(
      {
        anchor: trigger.type === 'before_start' ? 'start' : 'end',
        direction: trigger.type === 'before_start' ? 'before' : 'after',
        offsetMinutes: trigger.offsetMinutes,
      },
      { start: instant(booking.start_at), end: instant(booking.end_at) },
    )
    if (due.epochMilliseconds !== run.due_at.getTime()) return retired
  }
  return { reason: undefined, booking, eventType, captured: captured.data }
}

/** Take the same parent locks as dispatch, before the sender locks the endpoint. */
export async function lockWorkflowWebhookRun(
  trx: Db,
  delivery: { runId: string; organizationId: string; bookingId: string | null; webhookId: string },
) {
  const locked = await lockedWorkflowRun(trx, delivery.runId)
  if (
    !locked ||
    locked.run.organization_id !== delivery.organizationId ||
    locked.run.booking_id !== delivery.bookingId ||
    locked.run.state === 'retired' ||
    locked.run.state === 'skipped'
  )
    return
  const eligibility = await workflowRunEligibility(trx, locked)
  if (
    eligibility.reason ||
    !eligibility.captured.actions.some(
      (action) => action.type === 'webhook' && action.webhookId === delivery.webhookId,
    )
  )
    return
  return {
    eventTypeId: eligibility.eventType.id,
    expiresAt: Math.min(
      locked.run.expires_at.getTime(),
      instant(locked.run.due_at).add({ minutes: WORKFLOW_MAX_LATE_MINUTES }).epochMilliseconds,
    ),
  }
}

/** Bounded discovery is unlocked; each candidate is rechecked under ordered locks. */
async function dueCandidates(
  ctx: WorkflowDispatchContext,
  options: WorkflowClaimOptions,
  afterId?: string,
) {
  const now = date(ctx.now())
  let query = ctx.db
    .selectFrom('workflow_runs as r')
    .select('r.id')
    .where('r.due_at', '<=', now)
    .where((eb) =>
      eb.or([
        eb.and([eb('r.state', '=', 'claimed'), eb('r.lease_until', '<=', now)]),
        eb.and([
          eb('r.state', '=', 'pending'),
          eb.or([
            eb('r.expires_at', '<=', now),
            eb(
              eb.fn.coalesce(
                eb
                  .selectFrom('workflow_recipient_claims as c')
                  .select('c.next_attempt_at')
                  .whereRef('c.organization_id', '=', 'r.organization_id')
                  .whereRef('c.run_id', '=', 'r.id')
                  .where('c.state', '=', 'pending')
                  .orderBy(sql`c.next_attempt_at ASC NULLS FIRST`)
                  .limit(1),
                eb.val(now),
              ),
              '<=',
              now,
            ),
          ]),
        ]),
      ]),
    )
  if (options.runId) query = query.where('id', '=', options.runId)
  if (afterId !== undefined)
    return query.where('id', '>', afterId).orderBy('id').limit(page(options.limit)).execute()
  return query.orderBy('due_at').orderBy('id').limit(page(options.limit)).execute()
}

function canClaim(run: LockedRun['run'], now: Temporal.Instant) {
  return (
    run.state === 'pending' ||
    (run.state === 'claimed' && run.lease_until !== null && run.lease_until <= date(now))
  )
}

/** Discovery races a reversal. Recheck when the run lock has been acquired. */
async function waitingForEmailRetry(trx: Db, runId: string, now: Temporal.Instant) {
  const first = await trx
    .selectFrom('workflow_recipient_claims')
    .select('next_attempt_at')
    .where('run_id', '=', runId)
    .where('state', '=', 'pending')
    .orderBy(sql`next_attempt_at ASC NULLS FIRST`)
    .limit(1)
    .executeTakeFirst()
  return first?.next_attempt_at != null && first.next_attempt_at > date(now)
}

/** Internal service; public callers use the guarded dispatcher below. */
export async function claimDueWorkflowRuns(
  ctx: WorkflowDispatchContext,
  options: WorkflowClaimOptions = {},
): Promise<WorkflowRunClaim[]> {
  const claims: WorkflowRunClaim[] = []
  for (const candidate of await dueCandidates(ctx, options)) {
    const claim = await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedWorkflowRun(trx, candidate.id)
      if (!locked) return
      const { run } = locked
      const now = ctx.now()
      if (!canClaim(run, now)) return
      if (run.due_at.getTime() > now.epochMilliseconds) return
      const recovered =
        run.state === 'claimed' && (await recoverWorkflowEmailMarker(trx, locked, now))
      if (recovered && (await completeWorkflowEmailRun(trx, locked, now))) return
      const { reason } = await workflowRunEligibility(trx, locked)
      const afterWait = ctx.now()
      if (reason || workflowRunWindow(run, afterWait) === 'expired') {
        await finishWorkflowRun(trx, locked, reason ?? 'expired', afterWait)
        return
      }
      if (await waitingForEmailRetry(trx, run.id, afterWait)) {
        if (run.state === 'claimed') await releaseWorkflowRun(trx, run.id)
        return
      }
      const token = randomUUID()
      await trx
        .updateTable('workflow_runs')
        .set({
          state: 'claimed',
          claim_token: token,
          lease_until: date(afterWait.add({ seconds: WORKFLOW_CLAIM_SECONDS })),
        })
        .where('id', '=', run.id)
        .execute()
      return { runId: run.id, token }
    })
    if (claim) claims.push(claim)
  }
  return claims
}

/** Live checks after a queued claim waits. Ready retains the lease for the future attempt layer. */
export async function dispatchClaimedWorkflowRun(
  ctx: WorkflowDispatchContext,
  claim: WorkflowRunClaim,
): Promise<'ready' | 'stale' | 'skipped' | 'retired'> {
  return ctx.db.transaction().execute(async (trx) => {
    const locked = await lockedWorkflowRun(trx, claim.runId)
    if (!locked) return 'stale'
    const { run } = locked
    if (
      run.state !== 'claimed' ||
      run.claim_token !== claim.token ||
      !run.lease_until ||
      run.lease_until.getTime() <= ctx.now().epochMilliseconds
    )
      return 'stale'
    const { reason } = await workflowRunEligibility(trx, locked)
    const now = ctx.now()
    // Eligibility itself may wait on live parent rows, so fence and deadline are read again.
    if (run.lease_until.getTime() <= now.epochMilliseconds) return 'stale'
    const window = workflowRunWindow(run, now)
    if (reason || window === 'expired') {
      // A rechecked ready claim cannot retire or skip an in-flight email marker.
      const marker = await trx
        .selectFrom('workflow_recipient_claims')
        .select('id')
        .where('run_id', '=', run.id)
        .where('state', '=', 'dispatching')
        .executeTakeFirst()
      if (marker) return 'stale'
      await finishWorkflowRun(trx, locked, reason ?? 'expired', now)
      return reason === 'retired' ? 'retired' : 'skipped'
    }
    return window === 'open' ? 'ready' : 'stale'
  })
}

export async function dispatchDueWorkflowRuns(
  ctx: WorkflowDispatchContext,
  options: WorkflowClaimOptions = {},
): Promise<void> {
  for (const claim of await claimDueWorkflowRuns(ctx, options))
    await dispatchClaimedWorkflowRun(ctx, claim)
}

const repairCursors = new WeakMap<WorkflowWakePort, string>()
const FIRST_ID = '00000000-0000-0000-0000-000000000000'

/** Lifecycle retirement can clear the run's lease after the marker has committed. */
async function repairRetiredWorkflowEmailMarkers(ctx: WorkflowDispatchContext, limit?: number) {
  const cutoff = () => date(ctx.now().subtract({ seconds: WORKFLOW_CLAIM_SECONDS }))
  const candidates = await ctx.db
    .selectFrom('workflow_recipient_claims as c')
    .innerJoin('workflow_runs as r', 'r.id', 'c.run_id')
    .select('r.id')
    .distinct()
    .where('c.state', '=', 'dispatching')
    .where('r.finished_at', '<=', cutoff())
    .orderBy('r.id')
    .limit(page(limit))
    .execute()
  for (const { id } of candidates)
    await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedWorkflowRun(trx, id)
      if (locked?.run.finished_at && locked.run.finished_at <= cutoff())
        await recoverWorkflowEmailMarker(trx, locked, ctx.now())
    })
}

/** Missing jobs are disposable wakes. Never insert a run, enrollment or recipient intent here. */
export async function repairWorkflowRunWakes(
  ctx: WorkflowDispatchContext,
  port: WorkflowWakePort,
  limit?: number,
): Promise<void> {
  const cursor = repairCursors.get(port) ?? FIRST_ID
  await repairRetiredWorkflowEmailMarkers(ctx, limit)
  let candidates = await dueCandidates(ctx, { limit }, cursor)
  if (!candidates.length && cursor !== FIRST_ID)
    candidates = await dueCandidates(ctx, { limit }, FIRST_ID)
  for (const candidate of candidates) {
    await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedWorkflowRun(trx, candidate.id)
      if (!locked) return
      const { run } = locked
      const now = ctx.now()
      if (!canClaim(run, now)) return
      if (
        run.state === 'pending' &&
        workflowRunWindow(run, now) !== 'expired' &&
        (await waitingForEmailRetry(trx, run.id, now))
      )
        return
      if (run.due_at.getTime() <= now.epochMilliseconds) await port.ensureWake(trx, run.id)
    })
    repairCursors.set(port, candidate.id)
  }
}

export const dispatchWorkflowRuns = workflowExecution(dispatchDueWorkflowRuns)
export const repairWorkflowWakes = workflowExecution(repairWorkflowRunWakes)

/** Definitions are not installed in a production worker while workflows remain hard-off. */
export function workflowJobs(ctx: WorkflowDispatchContext, port: WorkflowWakePort) {
  return [
    defineJob({
      name: 'workflow-dispatch-v1',
      payload: z.strictObject({ runId: z.uuid() }),
      policy: 'exclusive',
      retry: { limit: 0 },
      expireInSeconds: 55,
      handler: async ({ runId }) => {
        await dispatchWorkflowRuns(ctx, { runId })
      },
    }),
    defineJob({
      name: 'workflow-repair-v1',
      payload: z.strictObject({}),
      policy: 'exclusive',
      retry: { limit: 0 },
      expireInSeconds: 55,
      schedule: { cron: '* * * * *', payload: {} },
      handler: async () => {
        await repairWorkflowWakes(ctx, port)
      },
    }),
  ] as const
}
