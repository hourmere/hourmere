import { ssoHardOff, type TeamSsoCapabilities } from '@hourmere/auth'
import {
  DEPARTURE_HANDOFF_ITEM_GAP_SECONDS,
  MAX_DEPARTURE_HANDOFF_RUN_ITEMS,
} from '@hourmere/core/departure-handoff-run'
import type { Database, Db } from '@hourmere/db'
import { type AuditAction, writeAuditEvent } from '@hourmere/db/audit'
import { teamWriteTransaction } from '@hourmere/db/team-write'
import { sql, type Transaction } from 'kysely'
import type { BookingNotifier, ServiceContext } from './context.ts'
import {
  type DepartureHandoffTeamInput,
  type DepartureHandoffWriteContext,
  lockDepartureHandoffTeam,
} from './departure-handoff-access.ts'
import { applyQueuedDepartureHandoff } from './departure-handoff-apply.ts'
import { withDepartureHandoffRead } from './departure-handoff-preview.ts'
import { departureHandoffStore } from './departure-handoff-store.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'

export { MAX_DEPARTURE_HANDOFF_RUN_ITEMS } from '@hourmere/core/departure-handoff-run'
export const DEPARTURE_HANDOFF_RUN_STATES = [
  'running',
  'paused',
  'stopped',
  'completed',
  'failed',
] as const
export const DEPARTURE_HANDOFF_ITEM_OUTCOMES = [
  'pending',
  'applied',
  'ineligible',
  'processing_failed',
  'stopped',
] as const

const RUN_LIFETIME_MS = 30 * 60_000
const RUN_ADMISSION_GAP_MS = 60_000
const ITEM_GAP_MS = DEPARTURE_HANDOFF_ITEM_GAP_SECONDS * 1_000
const ACTIVE_STATES = ['running', 'paused'] as const

type RunState = (typeof DEPARTURE_HANDOFF_RUN_STATES)[number]
type ItemOutcome = (typeof DEPARTURE_HANDOFF_ITEM_OUTCOMES)[number]
type RunFailure = 'departed_member_returned' | 'authorization_lost' | 'run_expired'
type RunKey = { organizationId: string; runId: string }
type RunInput = DepartureHandoffTeamInput & { runId: string }
type Trx = Transaction<Database>

export type EnqueueDepartureHandoffRun = (
  trx: Db,
  organizationId: string,
  runId: string,
  startAfter?: Date,
) => Promise<string | null>

type WorkerOptions = Pick<
  ServiceContext,
  'automaticMeet' | 'automaticZoom' | 'microsoftCalendarEnabled' | 'scimResourcesEnabled'
> & {
  notify: BookingNotifier
  now?: ServiceContext['now'] | undefined
  ssoCapabilities?: TeamSsoCapabilities | undefined
  signal?: AbortSignal | undefined
}

const runNotFound = () => new DomainError('not_found', 'handoff_run_not_found')
const conflict = (code: string) => new DomainError('conflict', code)

async function enqueueRun(
  trx: Trx,
  key: RunKey,
  enqueue: EnqueueDepartureHandoffRun,
  startAfter?: Date,
) {
  try {
    await enqueue(trx, key.organizationId, key.runId, startAfter)
  } catch {
    throw new DomainError('unavailable', 'handoff_run_queue_unavailable')
  }
}

function runRows(db: Db, key: RunKey) {
  return db
    .selectFrom('departure_handoff_runs')
    .where('organization_id', '=', key.organizationId)
    .where('id', '=', key.runId)
}

function itemRows(db: Db, key: RunKey) {
  return db
    .selectFrom('departure_handoff_run_items')
    .where('organization_id', '=', key.organizationId)
    .where('run_id', '=', key.runId)
}

function updateRun(trx: Trx, key: RunKey) {
  return trx
    .updateTable('departure_handoff_runs')
    .where('organization_id', '=', key.organizationId)
    .where('id', '=', key.runId)
}

function updatePendingItems(trx: Trx, key: RunKey) {
  return trx
    .updateTable('departure_handoff_run_items')
    .where('organization_id', '=', key.organizationId)
    .where('run_id', '=', key.runId)
    .where('outcome', '=', 'pending')
}

async function databaseTime(db: Db) {
  const { now } = await db
    .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
    .executeTakeFirstOrThrow()
  return now
}

async function hasDepartingMember(db: Db, organizationId: string, userId: string) {
  return Boolean(
    await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('userId', '=', userId)
      .executeTakeFirst(),
  )
}

function journalRun(
  trx: Trx,
  key: RunKey,
  action: Extract<AuditAction, `booking.handoff_run_${string}`>,
  actorUserId?: string,
) {
  return writeAuditEvent(trx, {
    action,
    organizationId: key.organizationId,
    targetType: 'departure_handoff_run',
    targetId: key.runId,
    actor: actorUserId
      ? { type: 'user', id: actorUserId }
      : { type: 'system', id: 'departure-handoff' },
    credential: { type: actorUserId ? 'session' : 'none' },
  })
}

async function runStatus(db: Db, key: RunKey) {
  if (!isUuid(key.runId)) throw runNotFound()
  const row = await runRows(db, key)
    .select(['id', 'departing_user_id', 'state', 'failure_code'])
    .executeTakeFirst()
  if (!row) throw runNotFound()
  const items = await itemRows(db, key)
    .select(['source_booking_id', 'offer_id', 'offer_version', 'outcome', 'replacement_booking_id'])
    .orderBy('ordinal')
    .execute()
  return {
    id: row.id,
    departingUserId: row.departing_user_id,
    state: row.state as RunState,
    failureCode: row.failure_code as RunFailure | null,
    items: items.map((item) => ({
      sourceBookingId: item.source_booking_id,
      offerId: item.offer_id,
      version: item.offer_version,
      outcome: item.outcome as ItemOutcome,
      replacementBookingId: item.replacement_booking_id,
    })),
  }
}

export function readDepartureHandoffRun(
  ctx: ServiceContext,
  input: RunInput,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return withDepartureHandoffRead(
    ctx,
    input.teamId,
    input.expectedOrganizationId,
    capabilities,
    ({ db }, organizationId) => runStatus(db, { organizationId, runId: input.runId }),
  )
}

/** This only identifies approved candidates. Apply rechecks the exact terms, all current
 * recipients and slot eligibility under its own locks. No offer or link is minted here. */
function approvedCandidates(trx: Trx, organizationId: string, userId: string, now: string) {
  const instant = sql<Date>`${now}::timestamptz`
  return trx
    .selectFrom('departure_handoff_offers as offer')
    .innerJoin('bookings as booking', (join) =>
      join
        .onRef('booking.id', '=', 'offer.source_booking_id')
        .onRef('booking.organization_id', '=', 'offer.organization_id'),
    )
    .select(['offer.source_booking_id', 'offer.id', 'offer.version'])
    .where('offer.organization_id', '=', organizationId)
    .where('offer.departing_user_id', '=', userId)
    .where('offer.state', '=', 'live')
    .where('booking.status', '=', 'confirmed')
    .where('booking.start_at', '>', instant)
    .where('offer.issued_at', '<=', instant)
    .where('offer.expires_at', '>', instant)
    .where('offer.target_start_at', '>', instant)
    .where(sql<boolean>`offer.issued_at + interval '48 hours' > ${now}::timestamptz`)
    .where((eb) => {
      const recipients = eb
        .selectFrom('departure_handoff_recipients as recipient')
        .select('recipient.id')
        .whereRef('recipient.organization_id', '=', 'offer.organization_id')
        .whereRef('recipient.source_booking_id', '=', 'offer.source_booking_id')
        .whereRef('recipient.offer_id', '=', 'offer.id')
        .whereRef('recipient.offer_version', '=', 'offer.version')
      return eb.and([
        eb.exists(recipients),
        eb.not(
          eb.exists(recipients.where(sql<boolean>`recipient.decision IS DISTINCT FROM 'approved'`)),
        ),
      ])
    })
    .orderBy('offer.expires_at')
    .orderBy('offer.source_booking_id')
    .limit(MAX_DEPARTURE_HANDOFF_RUN_ITEMS)
    .execute()
}

export function startDepartureHandoffRun(
  ctx: DepartureHandoffWriteContext,
  input: RunInput & { departingUserId: string },
  enqueue: EnqueueDepartureHandoffRun,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return teamWriteTransaction(
    ctx.db.transaction().setIsolationLevel('read committed'),
    async (trx) => {
      const team = await lockDepartureHandoffTeam(trx, ctx, input, capabilities)
      if (!isUuid(input.runId) || !isUuid(input.departingUserId))
        throw new DomainError('invalid', 'invalid_request')
      const key = { organizationId: team.organizationId, runId: input.runId.toLowerCase() }
      const userId = input.departingUserId.toLowerCase()
      // Serialize admission and the team-wide cooldown alongside ordinary booking writes.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hourmere.departure-handoff-run-start:${key.organizationId}`}, 0))`.execute(
        trx,
      )
      const previous = await runRows(trx, key).select('departing_user_id').executeTakeFirst()
      if (previous) {
        if (previous.departing_user_id !== userId) throw conflict('handoff_run_id_conflict')
      } else {
        await admitRun(trx, key, userId, team.actor, ctx.now(), enqueue)
      }
      const result = await runStatus(trx, key)
      await team.checkDeadline()
      return result
    },
  )
}

async function admitRun(
  trx: Trx,
  key: RunKey,
  userId: string,
  actor: { userId: string; sessionId: string },
  bookingNow: Temporal.Instant,
  enqueue: EnqueueDepartureHandoffRun,
) {
  if (await hasDepartingMember(trx, key.organizationId, userId))
    throw conflict('handoff_departing_member_present')
  const teamRuns = trx
    .selectFrom('departure_handoff_runs')
    .where('organization_id', '=', key.organizationId)
  if (await teamRuns.select('id').where('state', 'in', ACTIVE_STATES).executeTakeFirst())
    throw conflict('handoff_run_active')
  const now = await databaseTime(trx)
  const threshold = new Date(now.getTime() - RUN_ADMISSION_GAP_MS)
  if (await teamRuns.select('id').where('created_at', '>', threshold).limit(1).executeTakeFirst())
    throw conflict('handoff_run_rate_limited')
  const offers = await approvedCandidates(trx, key.organizationId, userId, bookingNow.toString())
  if (!offers.length) throw conflict('handoff_run_no_eligible_offers')
  await trx
    .insertInto('departure_handoff_runs')
    .values({
      organization_id: key.organizationId,
      id: key.runId,
      departing_user_id: userId,
      actor_user_id: actor.userId,
      session_id: actor.sessionId,
      created_at: now,
      next_item_at: now,
      expires_at: new Date(now.getTime() + RUN_LIFETIME_MS),
    })
    .execute()
  await trx
    .insertInto('departure_handoff_run_items')
    .values(
      offers.map((offer, index) => ({
        organization_id: key.organizationId,
        run_id: key.runId,
        ordinal: index + 1,
        source_booking_id: offer.source_booking_id,
        offer_id: offer.id,
        offer_version: offer.version,
      })),
    )
    .execute()
  await journalRun(trx, key, 'booking.handoff_run_started', actor.userId)
  await enqueueRun(trx, key, enqueue)
}

async function finishRun(
  trx: Trx,
  key: RunKey,
  state: 'stopped' | 'completed' | 'failed',
  failureCode: RunFailure | null = null,
  actorUserId?: string,
) {
  if (state !== 'completed')
    await updatePendingItems(trx, key).set({ outcome: 'stopped' }).execute()
  await updateRun(trx, key)
    .set({ state, finished_at: sql`clock_timestamp()`, failure_code: failureCode })
    .execute()
  await journalRun(trx, key, `booking.handoff_run_${state}`, actorUserId)
  return undefined
}

export function controlDepartureHandoffRun(
  ctx: DepartureHandoffWriteContext,
  input: RunInput & { action: 'pause' | 'resume' | 'stop' },
  enqueue: EnqueueDepartureHandoffRun,
  capabilities: TeamSsoCapabilities = ssoHardOff,
) {
  return teamWriteTransaction(
    ctx.db.transaction().setIsolationLevel('read committed'),
    async (trx) => {
      const team = await lockDepartureHandoffTeam(trx, ctx, input, capabilities)
      if (!isUuid(input.runId)) throw runNotFound()
      const key = { organizationId: team.organizationId, runId: input.runId.toLowerCase() }
      const run = await runRows(trx, key)
        .select(['state', 'expires_at', 'departing_user_id', 'next_item_at'])
        .forUpdate()
        .executeTakeFirst()
      if (!run) throw runNotFound()
      const active = run.state === 'running' || run.state === 'paused'
      const actorId = team.actor.userId
      if (input.action === 'stop' && active) {
        await finishRun(trx, key, 'stopped', null, actorId)
      } else if (active && run.expires_at <= (await databaseTime(trx))) {
        await finishRun(trx, key, 'failed', 'run_expired')
      } else if (input.action === 'pause' && run.state === 'running') {
        await updateRun(trx, key).set({ state: 'paused' }).execute()
        await journalRun(trx, key, 'booking.handoff_run_paused', actorId)
      } else if (input.action === 'resume' && run.state === 'paused') {
        if (await hasDepartingMember(trx, key.organizationId, run.departing_user_id)) {
          await finishRun(trx, key, 'failed', 'departed_member_returned')
        } else {
          await updateRun(trx, key)
            .set({
              state: 'running',
              actor_user_id: actorId,
              session_id: team.actor.sessionId,
            })
            .execute()
          await journalRun(trx, key, 'booking.handoff_run_resumed', actorId)
          await enqueueRun(trx, key, enqueue, run.next_item_at)
        }
      } else if (
        run.state !== { pause: 'paused', resume: 'running', stop: 'stopped' }[input.action]
      ) {
        throw conflict('handoff_run_transition_invalid')
      }
      const result = await runStatus(trx, key)
      await team.checkDeadline()
      return result
    },
  )
}

function authorityLost(error: unknown) {
  return (
    error instanceof DomainError &&
    ['team_management_access_denied', 'organization_context_changed', 'sso_required'].includes(
      error.code,
    )
  )
}

async function lockWorkerAuthority(
  trx: Trx,
  key: RunKey,
  identity: { actor_user_id: string; session_id: string },
  options: WorkerOptions,
) {
  await sql`SAVEPOINT handoff_run_authority`.execute(trx)
  try {
    const team = await lockDepartureHandoffTeam(
      trx,
      {
        principal: {
          kind: 'session',
          user: { id: identity.actor_user_id },
          sessionId: identity.session_id,
          organization: { id: key.organizationId },
        },
        scimResourcesEnabled: options.scimResourcesEnabled,
      },
      { teamId: key.organizationId, expectedOrganizationId: key.organizationId },
      options.ssoCapabilities ?? ssoHardOff,
    )
    await sql`RELEASE SAVEPOINT handoff_run_authority`.execute(trx)
    return team
  } catch (error) {
    if (!authorityLost(error)) throw error
    await sql`ROLLBACK TO SAVEPOINT handoff_run_authority`.execute(trx)
    await sql`RELEASE SAVEPOINT handoff_run_authority`.execute(trx)
    // Acquire the organization lock even when authority was lost before that step.
    await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', key.organizationId)
      .forShare()
      .executeTakeFirst()
  }
}

/** One run-row lock fences both controls and other workers. A disconnect rolls back the item,
 * booking, receipt and outbox together, leaving the same item eligible for a recovery wake. */
export async function runDepartureHandoffQueueItem(
  db: Db,
  key: RunKey,
  options: WorkerOptions,
): Promise<Date | undefined> {
  if (options.signal?.aborted) return
  const identity = await runRows(db, key)
    .select(['actor_user_id', 'session_id'])
    .where('state', 'in', ACTIVE_STATES)
    .executeTakeFirst()
  if (!identity) return
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '2s'; SET LOCAL transaction_timeout = '10s'`.execute(trx)
      const team = await lockWorkerAuthority(trx, key, identity, options)
      const run = await runRows(trx, key)
        .selectAll()
        .where('state', 'in', ACTIVE_STATES)
        .forUpdate()
        .executeTakeFirst()
      if (
        !run ||
        run.actor_user_id !== identity.actor_user_id ||
        run.session_id !== identity.session_id
      )
        return
      const now = await databaseTime(trx)
      if (run.expires_at <= now) return finishRun(trx, key, 'failed', 'run_expired')
      if (run.state !== 'running') return
      if (run.next_item_at > now) return run.next_item_at
      if (!team) return finishRun(trx, key, 'failed', 'authorization_lost')
      if (await hasDepartingMember(trx, key.organizationId, run.departing_user_id))
        return finishRun(trx, key, 'failed', 'departed_member_returned')
      options.signal?.throwIfAborted()
      const pending = itemRows(trx, key)
        .select(['ordinal', 'source_booking_id', 'offer_id', 'offer_version'])
        .where('outcome', '=', 'pending')
        .orderBy('ordinal')
        .limit(1)
      const item = await pending.executeTakeFirst()
      if (!item) return finishRun(trx, key, 'completed')

      await sql`SAVEPOINT handoff_run_item`.execute(trx)
      let replacementId: string | null = null
      let outcome: ItemOutcome
      try {
        const receipt = await applyQueuedDepartureHandoff(
          {
            ...options,
            db: trx,
            now: options.now ?? (() => Temporal.Now.instant()),
            scimResourcesEnabled: team.scimResourcesEnabled,
          },
          { organizationId: key.organizationId, sourceBookingId: item.source_booking_id },
          { offerId: item.offer_id, version: item.offer_version },
          departureHandoffStore,
          team.actor,
        )
        await team.checkDeadline()
        replacementId = receipt.replacementBookingId
        outcome = 'applied'
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT handoff_run_item`.execute(trx)
        if (authorityLost(error)) return finishRun(trx, key, 'failed', 'authorization_lost')
        outcome =
          error instanceof DomainError && error.kind !== 'unavailable'
            ? 'ineligible'
            : 'processing_failed'
      }
      await sql`RELEASE SAVEPOINT handoff_run_item`.execute(trx)
      options.signal?.throwIfAborted()
      await updatePendingItems(trx, key)
        .where('ordinal', '=', item.ordinal)
        .set({ outcome, replacement_booking_id: replacementId })
        .execute()
      if (!(await pending.executeTakeFirst())) return finishRun(trx, key, 'completed')
      const next = new Date((await databaseTime(trx)).getTime() + ITEM_GAP_MS)
      await updateRun(trx, key).set({ next_item_at: next }).execute()
      return next < run.expires_at ? next : run.expires_at
    })
}

/** Wakes can be lost or replayed. Only the durable, due run advances. */
export async function recoverDepartureHandoffRuns(db: Db, enqueue: EnqueueDepartureHandoffRun) {
  await db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('departure_handoff_runs')
      .select(['organization_id', 'id'])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('state', '=', 'running'),
            eb('next_item_at', '<=', sql<Date>`clock_timestamp()`),
          ]),
          eb.and([
            eb('state', 'in', ACTIVE_STATES),
            eb('expires_at', '<=', sql<Date>`clock_timestamp()`),
          ]),
        ]),
      )
      .orderBy('next_item_at')
      .orderBy('organization_id')
      .orderBy('id')
      .limit(25)
      .forUpdate()
      .skipLocked()
      .execute()
    for (const run of due) await enqueue(trx, run.organization_id, run.id)
    // Keep terminal results and replay keys for seven days.
    await sql`DELETE FROM departure_handoff_runs
      WHERE (organization_id, id) IN (
        SELECT organization_id, id FROM departure_handoff_runs
        WHERE finished_at < clock_timestamp() - interval '7 days'
        ORDER BY finished_at, organization_id, id LIMIT 100 FOR UPDATE SKIP LOCKED
      )`.execute(trx)
  })
}
