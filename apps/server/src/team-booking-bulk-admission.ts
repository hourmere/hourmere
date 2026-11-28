import type { Database } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { DomainError } from '@hourmere/scheduling'
import { type Expression, sql, type Transaction } from 'kysely'
import { type BulkPageBinding, databaseWallTime } from './team-booking-bulk-proof.ts'
import { type BulkBookingOutcome, bulkOutcomeCounts } from './team-booking-bulk-state.ts'

type Tx = Transaction<Database>

export type EnqueueBulkCancellation = (trx: Tx, batchId: string) => Promise<string | null>

export interface BulkCancellationThrottle {
  error: 'rate_limited' | 'bulk_queue_full'
  retryAfterSeconds: number
}

export const admittedBulkStates = ['queued', 'running', 'completed'] as const
type AdmittedState = (typeof admittedBulkStates)[number]
type Admission = { id: string; state: AdmittedState }

const notFound = () => new DomainError('not_found', 'bulk_cancellation_not_found')
const expired = () => new DomainError('conflict', 'bulk_confirmation_expired')
const accessDenied = () => new DomainError('forbidden', 'team_management_access_denied')
const minute = 60_000
const resultRetentionMs = 7 * 24 * 60 * minute
const staleRateRowsPerRequest = 30

function rateLimit(
  now: Date,
  all: readonly { at: Date; actor: string }[],
  userId: string,
  actorLimit: number,
  teamLimit?: number,
): BulkCancellationThrottle | undefined {
  const actor = all.filter((event) => event.actor === userId)
  const actorReset = actor.at(actorLimit - 1)?.at
  const teamReset = teamLimit === undefined ? undefined : all.at(teamLimit - 1)?.at
  const resetAt = Math.max(actorReset?.getTime() ?? 0, teamReset?.getTime() ?? 0) + minute
  if (resetAt > now.getTime())
    return {
      error: 'rate_limited',
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now.getTime()) / 1_000)),
    }
}

/** All callers hold the shared team-write lock. Failed proof and status lookups also count. */
export async function takeBulkReadBudget(
  trx: Tx,
  binding: BulkPageBinding,
  kind: 'preview' | 'status',
): Promise<BulkCancellationThrottle | undefined> {
  const now = await databaseWallTime(trx)
  const cutoff = new Date(now.getTime() - minute)
  const scope = trx
    .selectFrom('team_booking_bulk_request_limits')
    .where('organization_id', '=', binding.organizationId)
    .where('kind', '=', kind)
    .$if(kind === 'status', (query) => query.where('actor_user_id', '=', binding.userId))
  await trx
    .deleteFrom('team_booking_bulk_request_limits')
    .where(
      'id',
      'in',
      scope
        .select('id')
        .where('created_at', '<=', cutoff)
        .orderBy('created_at')
        .orderBy('id')
        .limit(staleRateRowsPerRequest)
        .forUpdate()
        .skipLocked(),
    )
    .execute()
  const rows = await scope
    .select(['created_at as at', 'actor_user_id as actor'])
    .where('created_at', '>', cutoff)
    .orderBy('created_at', 'desc')
    .limit(30)
    .execute()
  const limited = rateLimit(
    now,
    rows,
    binding.userId,
    kind === 'preview' ? 6 : 30,
    kind === 'preview' ? 30 : undefined,
  )
  if (limited) return limited

  await trx
    .insertInto('team_booking_bulk_request_limits')
    .values({
      organization_id: binding.organizationId,
      actor_user_id: binding.userId,
      kind,
      created_at: now,
    })
    .execute()
}

/** One scoped lock serializes confirmation, status and retention for this receipt. */
function scopedReceipt(trx: Tx, binding: BulkPageBinding, id: string) {
  return trx
    .selectFrom('team_booking_bulk_cancellations')
    .select(['id', 'session_id', 'state', 'expires_at', 'completed_at'])
    .where('id', '=', id)
    .where('organization_id', '=', binding.organizationId)
    .where('actor_user_id', '=', binding.userId)
}

async function stillRetained(trx: Tx, completedAt: Date | null) {
  return (
    !completedAt ||
    completedAt.getTime() > (await databaseWallTime(trx)).getTime() - resultRetentionMs
  )
}

function liveBulkSession(binding: BulkPageBinding, at: Expression<Date>) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM auth.session
    WHERE id = ${binding.sessionId}
      AND "userId" = ${binding.userId}
      AND "expiresAt" > ${at}
  )`
}

/** The team write still holds the session row lock, but expiry can pass while waiting. */
async function requireLiveBulkSession(trx: Tx, binding: BulkPageBinding) {
  const { live } = await trx
    .selectNoFrom(liveBulkSession(binding, sql<Date>`clock_timestamp()`).as('live'))
    .executeTakeFirstOrThrow()
  if (!live) throw accessDenied()
}

export async function confirmBulkCancellation(
  trx: Tx,
  binding: BulkPageBinding,
  id: string,
  enqueue: EnqueueBulkCancellation,
): Promise<Admission | BulkCancellationThrottle> {
  const receipt = await scopedReceipt(trx, binding, id).forUpdate().executeTakeFirst()
  if (!receipt || !(await stillRetained(trx, receipt.completed_at))) throw notFound()
  if (receipt.state !== 'awaiting_confirmation') {
    await requireLiveBulkSession(trx, binding)
    const limited = await takeBulkReadBudget(trx, binding, 'status')
    return limited ?? { id: receipt.id, state: receipt.state as AdmittedState }
  }
  if (receipt.session_id !== binding.sessionId) throw notFound()
  if ((await databaseWallTime(trx)) >= receipt.expires_at) throw expired()

  const items = await trx
    .selectFrom('team_booking_bulk_cancellation_items')
    .select('preview_outcome')
    .where('batch_id', '=', receipt.id)
    .execute()
  if (!items.some((item) => item.preview_outcome === 'eligible'))
    throw new DomainError('conflict', 'bulk_no_eligible_bookings')

  // Make the instance cap atomic across web replicas. Team access locks already precede this.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('hourmere.team-booking-bulk-admission', 0))`.execute(
    trx,
  )
  await requireLiveBulkSession(trx, binding)
  const now = await databaseWallTime(trx)
  if (now >= receipt.expires_at) throw expired()

  const recent = await trx
    .selectFrom('team_booking_bulk_cancellations')
    .select(['admitted_at as at', 'actor_user_id as actor'])
    .where('organization_id', '=', binding.organizationId)
    .where('admitted_at', '>', new Date(now.getTime() - minute))
    .$narrowType<{ at: Date }>()
    .orderBy('admitted_at', 'desc')
    .limit(4)
    .execute()
  const limited = rateLimit(now, recent, binding.userId, 2, 4)
  if (limited) return limited

  const active = await trx
    .selectFrom('team_booking_bulk_cancellations')
    .select('organization_id')
    .where('state', 'in', ['queued', 'running'])
    .limit(100)
    .execute()
  if (active.length === 100 || active.some((row) => row.organization_id === binding.organizationId))
    return { error: 'bulk_queue_full', retryAfterSeconds: 5 }

  const admitted = await trx
    .with('admission_clock', (db) => db.selectNoFrom(sql<Date>`clock_timestamp()`.as('now')))
    .updateTable('team_booking_bulk_cancellations')
    .from('admission_clock')
    .set((eb) => ({ admitted_at: eb.ref('admission_clock.now'), state: 'queued' }))
    .where('id', '=', receipt.id)
    .whereRef('expires_at', '>', 'admission_clock.now')
    .where((eb) => liveBulkSession(binding, eb.ref('admission_clock.now')))
    .returning('admitted_at')
    .executeTakeFirst()
  const admittedAt = admitted?.admitted_at
  if (!admittedAt) {
    await requireLiveBulkSession(trx, binding)
    throw expired()
  }

  await trx
    .updateTable('team_booking_bulk_cancellation_items')
    .set((eb) => ({
      outcome: eb
        .case()
        .when('preview_outcome', '=', 'eligible')
        .then('pending')
        .else(eb.ref('preview_outcome'))
        .end(),
      next_attempt_at: eb
        .case()
        .when('preview_outcome', '=', 'eligible')
        .then(sql<Date>`${admittedAt}::timestamptz`)
        .else(null)
        .end(),
    }))
    .where('batch_id', '=', receipt.id)
    .execute()
  await writeAuditEvent(trx, {
    organizationId: binding.organizationId,
    actor: { type: 'user', id: binding.userId },
    credential: { type: 'session', id: binding.sessionId },
    action: 'booking.bulk_cancellation_admitted',
    targetType: 'team_booking_bulk_cancellation',
    targetId: receipt.id,
    requestId: receipt.id,
    details: { selectedCount: items.length },
  })
  if ((await enqueue(trx, receipt.id)) === null)
    throw new Error('Bulk cancellation wake was not enqueued')
  return { id: receipt.id, state: 'queued' }
}

export async function bulkCancellationStatus(trx: Tx, binding: BulkPageBinding, id: string) {
  const limited = await takeBulkReadBudget(trx, binding, 'status')
  if (limited) return limited
  const receipt = await scopedReceipt(trx, binding, id).forShare().executeTakeFirst()
  await requireLiveBulkSession(trx, binding)
  // Return expected refusals so authorized reads still consume their status budget.
  if (!receipt || !(await stillRetained(trx, receipt.completed_at))) return notFound()
  if (receipt.state === 'awaiting_confirmation')
    return (await databaseWallTime(trx)) < receipt.expires_at
      ? {
          id: receipt.id,
          state: 'awaiting_confirmation' as const,
          expiresAt: receipt.expires_at.toISOString(),
        }
      : expired()
  const rows = await trx
    .selectFrom('team_booking_bulk_cancellation_items')
    .select(['booking_id as bookingId', 'outcome as code'])
    .where('batch_id', '=', receipt.id)
    .orderBy('ordinal')
    .execute()
  const items = rows.map(({ bookingId, code }) => ({ bookingId, code: code as BulkBookingOutcome }))
  return {
    id: receipt.id,
    state: receipt.state as AdmittedState,
    counts: bulkOutcomeCounts(items.map((item) => item.code)),
    items,
  }
}
