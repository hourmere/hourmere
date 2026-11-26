import { randomUUID } from 'node:crypto'
import {
  checkTeamManagementAccess,
  lockTeamSsoProof,
  ssoHardOff,
  TeamManagementError,
  type TeamSsoCapabilities,
  withScimResources,
} from '@hourmere/auth'
import { type Database, type Db, isConnectionTimeout } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import { type BookingNotifier, cancelTeamBookingBulkItem } from '@hourmere/scheduling'
import { sql, type Transaction } from 'kysely'
import { type BulkBookingOutcome, bulkOutcomeCounts } from './team-booking-bulk-state.ts'

const MAX_ATTEMPTS = 3
const RETRY_DELAYS = [5_000, 15_000]
const CLAIM_MS = 15_000
const EXECUTION_MS = 5 * 60_000
const RETAIN_RECEIPT_DAYS = 7
const MAX_CONCURRENT_ITEMS = 4
const RECOVERY_WAKE_LIMIT = 25
const CLEANUP_LIMIT = 100

type Trx = Transaction<Database>
type Outcome = Exclude<BulkBookingOutcome, 'pending'>
type Claim = {
  id: string
  organizationId: string
  userId: string
  sessionId: string
  ordinal: number
  bookingId: string
  token: string
  deadline: Date
}

export interface BulkCancellationWorkerOptions {
  notify: BookingNotifier
  scimResourcesEnabled?: boolean | undefined
  ssoCapabilities?: TeamSsoCapabilities | undefined
  signal?: AbortSignal | undefined
}

async function boundTransaction(trx: Trx) {
  await sql`SET LOCAL lock_timeout = '2s'; SET LOCAL transaction_timeout = '10s'`.execute(trx)
}

async function databaseTime(trx: Trx) {
  const { now } = await trx
    .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
    .executeTakeFirstOrThrow()
  return now
}

async function activeBatch(trx: Trx, id: string) {
  const query = trx
    .selectFrom('team_booking_bulk_cancellations')
    .where('id', '=', id)
    .where('state', 'in', ['queued', 'running'])
  const target = await query.select('organization_id').executeTakeFirst()
  if (!target) return
  // Completion inserts into the journal. Take its organization FK lock before the
  // receipt so a status or admission transaction holding the team cannot deadlock it.
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', target.organization_id)
    .forKeyShare()
    .executeTakeFirst()
  if (!organization) return
  return query
    .select(['state', 'organization_id', 'actor_user_id', 'session_id', 'admitted_at'])
    .forUpdate()
    .executeTakeFirst()
}

function pendingItems(trx: Trx, id: string) {
  return trx
    .selectFrom('team_booking_bulk_cancellation_items')
    .select(['ordinal', 'booking_id', 'attempt_count', 'next_attempt_at', 'claim_expires_at'])
    .where('batch_id', '=', id)
    .where('outcome', '=', 'pending')
}

async function settleItems(trx: Trx, id: string, outcome: Outcome, ordinal?: number) {
  await trx
    .updateTable('team_booking_bulk_cancellation_items')
    .set({
      outcome,
      next_attempt_at: null,
      claim_token: null,
      claim_expires_at: null,
    })
    .where('batch_id', '=', id)
    .where('outcome', '=', 'pending')
    .$if(ordinal !== undefined, (query) => query.where('ordinal', '=', ordinal as number))
    .execute()
}

async function completeBatch(trx: Trx, id: string, organizationId: string) {
  const rows = await trx
    .selectFrom('team_booking_bulk_cancellation_items')
    .select('outcome')
    .where('batch_id', '=', id)
    .execute()
  const counts = bulkOutcomeCounts(rows.map(({ outcome }) => outcome as BulkBookingOutcome))
  await trx
    .updateTable('team_booking_bulk_cancellations')
    .set({ state: 'completed', completed_at: sql`clock_timestamp()` })
    .where('id', '=', id)
    .execute()
  await writeAuditEvent(trx, {
    action: 'booking.bulk_cancellation_completed',
    organizationId,
    targetType: 'team_booking_bulk_cancellation',
    targetId: id,
    requestId: id,
    actor: { type: 'system', id: 'team-booking-bulk-cancellation' },
    credential: { type: 'none' },
    details: { counts },
  })
}

type Next =
  | { kind: 'stop'; wakeAt?: Date }
  | { kind: 'continue' }
  | { kind: 'claimed'; claim: Claim }

/** The batch header serializes durable attempt creation and terminal completion. */
function prepareNext(db: Db, id: string): Promise<Next> {
  return db.transaction().execute(async (trx) => {
    await boundTransaction(trx)
    const batch = await activeBatch(trx, id)
    if (!batch?.admitted_at) return { kind: 'stop' }

    const item = await pendingItems(trx, id)
      .orderBy('ordinal')
      .limit(1)
      .forUpdate()
      .executeTakeFirst()
    if (!item) {
      await completeBatch(trx, id, batch.organization_id)
      return { kind: 'stop' }
    }

    const now = await databaseTime(trx)
    const deadline = new Date(batch.admitted_at.getTime() + EXECUTION_MS)
    if (item.claim_expires_at && item.claim_expires_at > now)
      return { kind: 'stop', wakeAt: item.claim_expires_at }
    if (now >= deadline) {
      await settleItems(trx, id, 'processing_failed')
      await completeBatch(trx, id, batch.organization_id)
      return { kind: 'stop' }
    }
    if (item.next_attempt_at && item.next_attempt_at > now)
      return {
        kind: 'stop',
        wakeAt: item.next_attempt_at < deadline ? item.next_attempt_at : deadline,
      }
    if (item.attempt_count >= MAX_ATTEMPTS) {
      await settleItems(trx, id, 'processing_failed', item.ordinal)
      return { kind: 'continue' }
    }

    const token = randomUUID()
    await trx
      .updateTable('team_booking_bulk_cancellation_items')
      .set({
        attempt_count: item.attempt_count + 1,
        claim_token: token,
        claim_expires_at: new Date(now.getTime() + CLAIM_MS),
        // A worker that disappears consumes the committed attempt and observes its retry delay.
        next_attempt_at: new Date(
          now.getTime() + CLAIM_MS + (RETRY_DELAYS[item.attempt_count] ?? 0),
        ),
      })
      .where('batch_id', '=', id)
      .where('ordinal', '=', item.ordinal)
      .execute()
    if (batch.state !== 'running') {
      await trx
        .updateTable('team_booking_bulk_cancellations')
        .set({ state: 'running' })
        .where('id', '=', id)
        .execute()
    }
    return {
      kind: 'claimed',
      claim: {
        id,
        organizationId: batch.organization_id,
        userId: batch.actor_user_id,
        sessionId: batch.session_id,
        ordinal: item.ordinal,
        bookingId: item.booking_id,
        token,
        deadline,
      },
    }
  })
}

function fencedItem(trx: Trx, claim: Claim) {
  return pendingItems(trx, claim.id)
    .where('ordinal', '=', claim.ordinal)
    .where('claim_token', '=', claim.token)
    .forUpdate()
    .executeTakeFirst()
}

/** Transaction advisory slots enforce the write budget across all worker replicas. */
async function acquireItemSlot(trx: Trx) {
  for (let slot = 0; slot < MAX_CONCURRENT_ITEMS; slot++) {
    const { rows } = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`hourmere.bulk-cancellation.worker:${slot}`}, 0))
        AS acquired
    `.execute(trx)
    if (rows[0]?.acquired) return true
  }
  return false
}

class BulkAuthorityLost extends Error {}

async function processItem(db: Db, claim: Claim, options: BulkCancellationWorkerOptions) {
  const identity = { userId: claim.userId, sessionId: claim.sessionId }
  const principal = {
    kind: 'session' as const,
    sessionId: identity.sessionId,
    user: { id: identity.userId },
    organization: { id: claim.organizationId },
    ...(options.scimResourcesEnabled && { scimResourcesEnabled: true as const }),
  }
  const capabilities = withScimResources(
    options.ssoCapabilities ?? ssoHardOff,
    options.scimResourcesEnabled,
  )
  const denied = () => {
    throw new BulkAuthorityLost()
  }
  const authorize = async (trx: Trx) => {
    const actor = await checkTeamManagementAccess(trx, principal, claim.organizationId, true, {
      expectedOrganizationId: claim.organizationId,
      allowPersonal: false,
    })
    await lockTeamSsoProof({ capabilities }, trx, identity, claim.organizationId, denied, {
      organizationLocked: true,
    })
    return actor
  }

  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await boundTransaction(trx)
      if (!(await acquireItemSlot(trx))) return false
      // User → organization → member → session/proof → claim → series → group slot → booking.
      const actor = await authorize(trx)
      const item = await fencedItem(trx, claim)
      if (!item?.claim_expires_at) return true
      const now = await databaseTime(trx)
      if (item.claim_expires_at <= now) return true
      const outcome =
        now >= claim.deadline
          ? 'processing_failed'
          : await cancelTeamBookingBulkItem(trx, actor, claim.bookingId, {
              batchId: claim.id,
              sessionId: claim.sessionId,
              notify: options.notify,
              deadline: claim.deadline,
            })
      await settleItems(trx, claim.id, outcome, claim.ordinal)
      // Recheck the database clock against session and SSO proof deadlines before committing.
      await authorize(trx)
      return true
    })
}

function transientFailure(error: unknown) {
  if (isConnectionTimeout(error)) return true
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string')
    return (
      error instanceof Error &&
      (/^Connection terminated/.test(error.message) ||
        /^jobs are not running \((starting|stopping)\)$/.test(error.message))
    )
  return (
    error.code.startsWith('08') ||
    [
      '25P03',
      '25P04',
      '40001',
      '40P01',
      '55P03',
      '57014',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
    ].includes(error.code)
  )
}

/** A failed or unknown COMMIT may have succeeded. Only the still-pending fenced attempt
 * can be retried, deferred, or settled. This write runs after the work transaction unwinds. */
function recordFailure(
  db: Db,
  claim: Claim,
  failure: 'defer' | 'retry' | 'authorization_lost' | 'processing_failed',
) {
  return db.transaction().execute(async (trx) => {
    await boundTransaction(trx)
    const batch = await activeBatch(trx, claim.id)
    if (!batch) return
    const item = await fencedItem(trx, claim)
    if (!item) return
    if (failure === 'authorization_lost') {
      await settleItems(trx, claim.id, failure)
      await completeBatch(trx, claim.id, batch.organization_id)
      return
    }

    const now = await databaseTime(trx)
    const retryDelay = RETRY_DELAYS[item.attempt_count - 1]
    if (
      now >= claim.deadline ||
      failure === 'processing_failed' ||
      (failure === 'retry' && retryDelay === undefined)
    ) {
      await settleItems(trx, claim.id, 'processing_failed', claim.ordinal)
      return
    }

    await trx
      .updateTable('team_booking_bulk_cancellation_items')
      .set({
        attempt_count: failure === 'defer' ? item.attempt_count - 1 : item.attempt_count,
        next_attempt_at: new Date(
          now.getTime() + (failure === 'defer' ? 1_000 : (retryDelay ?? 0)),
        ),
        claim_token: null,
        claim_expires_at: null,
      })
      .where('batch_id', '=', claim.id)
      .where('ordinal', '=', claim.ordinal)
      .execute()
  })
}

/** Drain a wake's due items, returning the next due time for a delayed wake if needed. */
export async function runTeamBookingBulkCancellation(
  db: Db,
  batchId: string,
  options: BulkCancellationWorkerOptions,
): Promise<Date | undefined> {
  while (!options.signal?.aborted) {
    const next = await prepareNext(db, batchId)
    if (next.kind === 'stop') return next.wakeAt
    if (next.kind === 'continue') continue
    let failure: Parameters<typeof recordFailure>[2] | undefined
    try {
      if (!(await processItem(db, next.claim, options))) failure = 'defer'
    } catch (error) {
      if (error instanceof TeamManagementError || error instanceof BulkAuthorityLost) {
        failure = 'authorization_lost'
      } else {
        failure = transientFailure(error) ? 'retry' : 'processing_failed'
      }
    }
    if (failure) await recordFailure(db, next.claim, failure)
  }
}

export type EnqueueBulkCancellation = (
  trx: Trx,
  batchId: string,
  startAfter?: Date,
) => Promise<string | null>

/** Find the first pending item in each active batch. Wakeups are disposable and deduplicated
 * by the queue, while batch state, attempts and claims survive worker or database restarts. */
export async function recoverTeamBookingBulkCancellations(
  db: Db,
  enqueue: EnqueueBulkCancellation,
) {
  await db.transaction().execute(async (trx) => {
    await boundTransaction(trx)
    const { rows } = await sql<{ id: string }>`
      SELECT batch.id
      FROM team_booking_bulk_cancellations AS batch
      LEFT JOIN LATERAL (
        SELECT claim_expires_at, next_attempt_at
        FROM team_booking_bulk_cancellation_items
        WHERE batch_id = batch.id AND outcome = 'pending'
        ORDER BY ordinal LIMIT 1
      ) next_item ON true
      WHERE batch.state IN ('queued', 'running')
        AND (next_item.claim_expires_at IS NULL OR next_item.claim_expires_at <= clock_timestamp())
        AND (next_item.next_attempt_at IS NULL OR next_item.next_attempt_at <= clock_timestamp()
          OR batch.admitted_at + interval '5 minutes' <= clock_timestamp())
      ORDER BY batch.admitted_at, batch.id
      LIMIT ${RECOVERY_WAKE_LIMIT}
      FOR UPDATE OF batch SKIP LOCKED
    `.execute(trx)
    for (const { id } of rows) await enqueue(trx, id)
  })
  await db.transaction().execute(async (trx) => {
    await boundTransaction(trx)
    // Keep the expiry response available briefly after an unresolved confirmation, and
    // detailed results and replay for seven days after terminal completion.
    await sql`
      DELETE FROM team_booking_bulk_cancellations
      WHERE id IN (
        SELECT id FROM team_booking_bulk_cancellations
        WHERE (state = 'awaiting_confirmation' AND expires_at < clock_timestamp() - interval '1 day')
          OR (state = 'completed'
            AND completed_at < clock_timestamp() - ${RETAIN_RECEIPT_DAYS} * interval '1 day')
        ORDER BY coalesce(completed_at, expires_at), id
        LIMIT ${CLEANUP_LIMIT} FOR UPDATE SKIP LOCKED
      )
    `.execute(trx)
    await sql`
      DELETE FROM team_booking_bulk_request_limits
      WHERE id IN (
        SELECT id FROM team_booking_bulk_request_limits
        WHERE created_at < clock_timestamp() - interval '1 minute'
        ORDER BY created_at, id
        LIMIT ${CLEANUP_LIMIT} FOR UPDATE SKIP LOCKED
      )
    `.execute(trx)
  })
}
