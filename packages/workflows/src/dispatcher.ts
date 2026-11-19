// Internal due-work machinery. A ready claim is not a delivery: the later attempt layer must
// establish its own fenced marker. Neither this module nor its jobs call a transport.
import { randomUUID } from 'node:crypto'
import { type Db, isImportedBooking } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'
import { WorkflowDefinitionSchema } from './definition.ts'
import { workflowExecution } from './hard-off.ts'
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
async function lockedRun(trx: Db, runId: string) {
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
  if (personal)
    await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', personal.user_id)
      .forShare()
      .executeTakeFirst()
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', identity.organization_id)
    .forKeyShare()
    .executeTakeFirst()
  if (!organization) return
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
type LockedRun = NonNullable<Awaited<ReturnType<typeof lockedRun>>>
type Terminal = 'workflow_disabled' | 'expired' | 'retired'
async function finish(trx: Db, locked: LockedRun, reason: Terminal, now: Temporal.Instant) {
  const { run, enrollment, definition } = locked
  await trx
    .updateTable('workflow_runs')
    .set({
      state: reason === 'retired' ? 'retired' : 'skipped',
      skip_reason: reason === 'retired' ? null : reason,
      claim_token: null,
      lease_until: null,
      finished_at: date(now),
    })
    .where('id', '=', run.id)
    .execute()
  if (reason !== 'retired')
    await trx
      .updateTable('workflow_recipient_claims')
      .set({
        state: 'skipped',
        skip_reason: reason,
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
      .select(sql<number>`count(*)::integer`.as('skipped'))
      .where('run_id', '=', run.id)
      .where('state', '=', 'skipped')
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
        outcome: reason === 'retired' ? 'retired' : 'skipped',
        reason: reason === 'retired' ? null : reason,
        skipped: counts.skipped,
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute()
  }
}

async function eligibility(trx: Db, locked: LockedRun): Promise<Terminal | undefined> {
  const { booking, definition, enrollment, run } = locked
  if (!definition || definition.deleted_at !== null || !booking) return 'retired'
  if (!definition.enabled) return 'workflow_disabled'
  if (
    booking.status !== (enrollment.trigger === 'booking.cancelled' ? 'cancelled' : 'confirmed') ||
    booking.group_slot_id !== null ||
    !booking.event_type_id ||
    !['web', 'embed', 'api', 'mcp'].includes(booking.source) ||
    (await isImportedBooking(trx, booking.id))
  )
    return 'retired'
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
    return 'retired'
  const successor = await trx
    .selectFrom('bookings')
    .select('id')
    .where('rescheduled_from_id', '=', booking.id)
    .executeTakeFirst()
  if (successor) return 'retired'
  const revision = await trx
    .selectFrom('workflow_revisions')
    .select('definition')
    .where('organization_id', '=', run.organization_id)
    .where('workflow_id', '=', enrollment.workflow_id)
    .where('revision', '=', enrollment.revision)
    .executeTakeFirst()
  const captured = WorkflowDefinitionSchema.safeParse(revision?.definition)
  if (!captured.success) return 'retired'
  const trigger = captured.data.trigger
  if (trigger.type === 'before_start' || trigger.type === 'after_end') {
    const due = workflowTimerDueAt(
      {
        anchor: trigger.type === 'before_start' ? 'start' : 'end',
        direction: trigger.type === 'before_start' ? 'before' : 'after',
        offsetMinutes: trigger.offsetMinutes,
      },
      { start: instant(booking.start_at), end: instant(booking.end_at) },
    )
    if (due.epochMilliseconds !== run.due_at.getTime()) return 'retired'
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
    .selectFrom('workflow_runs')
    .select('id')
    .where('due_at', '<=', now)
    .where((eb) =>
      eb.or([
        eb('state', '=', 'pending'),
        eb.and([eb('state', '=', 'claimed'), eb('lease_until', '<=', now)]),
      ]),
    )
  if (options.runId) query = query.where('id', '=', options.runId)
  if (afterId !== undefined)
    return query.where('id', '>', afterId).orderBy('id').limit(page(options.limit)).execute()
  return query.orderBy('due_at').orderBy('id').limit(page(options.limit)).execute()
}

/** Internal service; public callers use the guarded dispatcher below. */
export async function claimDueWorkflowRuns(
  ctx: WorkflowDispatchContext,
  options: WorkflowClaimOptions = {},
): Promise<WorkflowRunClaim[]> {
  const claims: WorkflowRunClaim[] = []
  for (const candidate of await dueCandidates(ctx, options)) {
    const claim = await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedRun(trx, candidate.id)
      if (!locked) return
      const { run } = locked
      const now = ctx.now()
      if (
        run.state !== 'pending' &&
        !(
          run.state === 'claimed' &&
          run.lease_until &&
          run.lease_until.getTime() <= now.epochMilliseconds
        )
      )
        return
      if (run.due_at.getTime() > now.epochMilliseconds) return
      const reason = await eligibility(trx, locked)
      const afterWait = ctx.now()
      if (
        reason ||
        workflowDispatchWindow(
          { dueAt: instant(run.due_at), expiresAt: instant(run.expires_at) },
          afterWait,
        ) === 'expired'
      ) {
        await finish(trx, locked, reason ?? 'expired', afterWait)
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
    const locked = await lockedRun(trx, claim.runId)
    if (!locked) return 'stale'
    const { run } = locked
    if (
      run.state !== 'claimed' ||
      run.claim_token !== claim.token ||
      !run.lease_until ||
      run.lease_until.getTime() <= ctx.now().epochMilliseconds
    )
      return 'stale'
    const reason = await eligibility(trx, locked)
    const now = ctx.now()
    // Eligibility itself may wait on live parent rows, so fence and deadline are read again.
    if (run.lease_until.getTime() <= now.epochMilliseconds) return 'stale'
    const window = workflowDispatchWindow(
      { dueAt: instant(run.due_at), expiresAt: instant(run.expires_at) },
      now,
    )
    if (reason || window === 'expired') {
      await finish(trx, locked, reason ?? 'expired', now)
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

/** Missing jobs are disposable wakes. Never insert a run, enrollment or recipient intent here. */
export async function repairWorkflowRunWakes(
  ctx: WorkflowDispatchContext,
  port: WorkflowWakePort,
  limit?: number,
): Promise<void> {
  const cursor = repairCursors.get(port) ?? FIRST_ID
  let candidates = await dueCandidates(ctx, { limit }, cursor)
  if (!candidates.length && cursor !== FIRST_ID)
    candidates = await dueCandidates(ctx, { limit }, FIRST_ID)
  for (const candidate of candidates) {
    await ctx.db.transaction().execute(async (trx) => {
      const locked = await lockedRun(trx, candidate.id)
      if (!locked) return
      const { run } = locked
      const now = ctx.now()
      if (
        run.state !== 'pending' &&
        !(
          run.state === 'claimed' &&
          run.lease_until &&
          run.lease_until.getTime() <= now.epochMilliseconds
        )
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
