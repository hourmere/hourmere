import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { lockNotificationEmailBudget, workflowRecipientHash } from './mail-limits.ts'

export interface WorkflowMailLimits {
  /** Zero removes only the shared instance ceiling, never workflow sub-caps. */
  mailMaxPerHour?: number | undefined
  workflowMailMaxPerHour?: number | undefined
  workflowOwnerMailMaxPerHour?: number | undefined
}
export interface WorkflowMailDeps extends WorkflowMailLimits {
  db: Db
  secret: string
  now?: (() => Temporal.Instant) | undefined
}
export interface WorkflowMailRequest {
  organizationId: string
  runId: string
  claimId: string
  email: string
}
type WorkflowMailCharge = Omit<WorkflowMailRequest, 'email'> & { recipientHash: Buffer }

export type WorkflowMailAdmission =
  | { status: 'admitted'; reservationId: string; sentAt: Date }
  | { status: 'already_reserved'; reservationId: string }
  | { status: 'budget_suppressed' }
  | { status: 'unavailable' }

async function available(
  db: Db,
  limits: WorkflowMailLimits,
  organizationId: string,
  hash: Buffer,
  now: Date,
  excludedReservationId: string | null,
): Promise<boolean> {
  const hour = new Date(now.getTime() - 3_600_000)
  const day = new Date(now.getTime() - 86_400_000)
  const { rows } = await sql<{
    global_hour: string
    workflow_hour: string
    owner_hour: string
    recipient_hour: string
    recipient_day: string
  }>`SELECT
    count(*) FILTER (WHERE s.sent_at > ${hour}) AS global_hour,
    count(*) FILTER (WHERE s.sent_at > ${hour} AND s.workflow_reservation_id IS NOT NULL)
      AS workflow_hour,
    count(*) FILTER (WHERE s.sent_at > ${hour} AND r.organization_id = ${organizationId})
      AS owner_hour,
    count(*) FILTER (WHERE s.sent_at > ${hour} AND s.recipient_hash = ${hash})
      AS recipient_hour,
    count(*) FILTER (WHERE s.recipient_hash = ${hash}) AS recipient_day
    FROM notification_email_sends s
    LEFT JOIN workflow_mail_reservations r ON r.id = s.workflow_reservation_id
    WHERE s.sent_at > ${day}
      AND (${excludedReservationId}::uuid IS NULL
        OR s.workflow_reservation_id IS DISTINCT FROM ${excludedReservationId}::uuid)`.execute(db)
  const counts = rows[0]
  if (!counts) throw new Error('Workflow mail budget count unavailable')
  const global = limits.mailMaxPerHour ?? 100
  const configured = limits.workflowMailMaxPerHour ?? 20
  const workflow = global > 0 ? Math.min(configured, Math.floor(global / 5)) : configured
  return (
    (global === 0 || Number(counts.global_hour) < global) &&
    Number(counts.workflow_hour) < workflow &&
    Number(counts.owner_hour) < (limits.workflowOwnerMailMaxPerHour ?? 5) &&
    Number(counts.recipient_hour) < 1 &&
    Number(counts.recipient_day) < 3
  )
}

/**
 * Caller owns the organization and shared budget locks, in that order. The charge and
 * the caller's dispatch marker commit together. A retry must find its existing charge.
 */
export async function stampWorkflowEmail(
  db: Db,
  limits: WorkflowMailLimits,
  request: WorkflowMailCharge,
  at: Date,
  retry?: { reservationId?: string },
): Promise<WorkflowMailAdmission> {
  if (!db.isTransaction) throw new Error('Workflow mail admission needs a transaction')
  const hash = request.recipientHash
  const existing = await db
    .selectFrom('workflow_mail_reservations')
    .selectAll()
    .where('claim_id', '=', request.claimId)
    .forUpdate()
    .executeTakeFirst()
  if (existing) {
    if (
      existing.organization_id !== request.organizationId ||
      existing.run_id !== request.runId ||
      (retry?.reservationId !== undefined && existing.id !== retry.reservationId)
    )
      return { status: 'unavailable' }
    const charge = await db
      .selectFrom('notification_email_sends')
      .select(['recipient_hash', 'sent_at'])
      .where('workflow_reservation_id', '=', existing.id)
      .forUpdate()
      .executeTakeFirst()
    if (!charge?.recipient_hash?.equals(hash)) return { status: 'unavailable' }
    if (!retry) return { status: 'already_reserved', reservationId: existing.id }
    if (at < existing.reserved_at || at < charge.sent_at) return { status: 'unavailable' }
    if (!(await available(db, limits, request.organizationId, hash, at, existing.id)))
      return { status: 'budget_suppressed' }
    await db
      .updateTable('notification_email_sends')
      .set({ sent_at: at })
      .where('workflow_reservation_id', '=', existing.id)
      .execute()
    await db
      .updateTable('workflow_mail_reservations')
      .set({ reserved_at: at })
      .where('id', '=', existing.id)
      .execute()
    return { status: 'admitted', reservationId: existing.id, sentAt: at }
  }
  if (retry) return { status: 'unavailable' }
  if (!(await available(db, limits, request.organizationId, hash, at, null)))
    return { status: 'budget_suppressed' }
  const reservationId = randomUUID()
  await db
    .insertInto('notification_email_sends')
    .values({ recipient_hash: hash, sent_at: at, workflow_reservation_id: reservationId })
    .execute()
  await db
    .insertInto('workflow_mail_reservations')
    .values({
      id: reservationId,
      organization_id: request.organizationId,
      run_id: request.runId,
      claim_id: request.claimId,
      reserved_at: at,
    })
    .execute()
  return { status: 'admitted', reservationId, sentAt: at }
}

async function admit(
  deps: WorkflowMailDeps,
  request: WorkflowMailRequest,
  retry?: { reservationId: string },
): Promise<WorkflowMailAdmission> {
  return deps.db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (db) => {
      // Invitation creation holds this organization FOR UPDATE before taking the same budget.
      const owner = await sql<{ id: string }>`SELECT id FROM auth.organization
      WHERE id = ${request.organizationId} FOR KEY SHARE`.execute(db)
      if (!owner.rows.length) return { status: 'unavailable' }
      await lockNotificationEmailBudget(db)
      const at = deps.now
        ? new Date(deps.now().epochMilliseconds)
        : (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db)).rows[0]?.at
      if (!at) throw new Error('Workflow mail admission needs the database clock')
      return stampWorkflowEmail(
        db,
        deps,
        { ...request, recipientHash: workflowRecipientHash(request.email, deps.secret) },
        at,
        retry,
      )
    })
}

/** Reserve one new intent atomically in the same ledger counted by core mail. */
export function admitWorkflowEmail(deps: WorkflowMailDeps, request: WorkflowMailRequest) {
  return admit(deps, request)
}

/** Known-not-sent retry: recount without this charge, then move both stamps together. */
export function readmitWorkflowEmail(
  deps: WorkflowMailDeps,
  request: WorkflowMailRequest & { reservationId: string },
) {
  return admit(deps, request, { reservationId: request.reservationId })
}
