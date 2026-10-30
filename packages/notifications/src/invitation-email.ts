import type { Db } from '@hourmere/db'
import {
  defineJob,
  type EnqueueOptions,
  type InvitationEmailJobIdentity,
  type KyselyTransactionLike,
} from '@hourmere/jobs'
import { sql } from 'kysely'
import { z } from 'zod'

export const INVITATION_EMAIL_JOB = 'invitation-email-v1'
export const INVITATION_EMAIL_REPAIR_JOB = 'invitation-email-repair-v1'

/** Queue storage contains only this identity, never the address or invitation link. */
export const InvitationEmailPayload = z.strictObject({
  invitationId: z.uuid(),
  generation: z.number().int().min(1).max(32),
})
export type InvitationEmailRequest = z.output<typeof InvitationEmailPayload>

export interface InvitationEmailQueue {
  enqueue(
    name: typeof INVITATION_EMAIL_JOB,
    payload: InvitationEmailRequest,
    options?: EnqueueOptions,
  ): Promise<string | null>
  hasLiveInvitationEmailJob(
    identity: InvitationEmailJobIdentity,
    transaction?: KyselyTransactionLike,
  ): Promise<boolean>
}

interface InvitationEmailDeps {
  db: Db
  queue: InvitationEmailQueue
}

/** Fixed public diagnostic: underlying database errors may contain private values. */
export class InvitationEmailQueueError extends Error {
  override name = 'InvitationEmailQueueError'
  constructor() {
    super('invitation_email_queue_unavailable')
  }
}

/** Always lock the invitation before its current delivery generation. */
async function currentDelivery(db: Db, invitationId: string) {
  const invitation = await db
    .selectFrom('auth.invitation')
    .select(['id', 'status'])
    .where('id', '=', invitationId)
    .forUpdate()
    .executeTakeFirst()
  if (!invitation) return undefined
  const delivery = await db
    .selectFrom('invitation_deliveries')
    .select(['generation', 'state', 'last_job_id', 'due_at'])
    .where('invitation_id', '=', invitationId)
    .forUpdate()
    .executeTakeFirst()
  if (!delivery) return undefined
  // Read the clock after both locks; time spent waiting cannot extend invitation validity.
  const expiry = await db
    .selectFrom('auth.invitation')
    .innerJoin('invitation_deliveries', 'invitation_deliveries.invitation_id', 'auth.invitation.id')
    .select([
      sql<boolean>`"expiresAt" > clock_timestamp()`.as('unexpired'),
      sql<boolean>`due_at <= clock_timestamp()`.as('due'),
    ])
    .where('id', '=', invitationId)
    .executeTakeFirstOrThrow()
  return {
    invitation: { ...invitation, unexpired: expiry.unexpired },
    delivery: { ...delivery, due: expiry.due },
  }
}

async function skipIneligible(db: Db, invitationId: string, generation: number) {
  await db
    .updateTable('invitation_deliveries')
    .set({
      state: 'skipped',
      last_error_code: 'invitation_ineligible',
      updated_at: sql`clock_timestamp()`,
    })
    .where('invitation_id', '=', invitationId)
    .where('generation', '=', generation)
    .where('state', '=', 'queued')
    .execute()
}

/**
 * Call after admission commits. The new transaction commits the queue insert and its
 * retained job identity together. Failure preserves the admission's due queued row.
 */
export function createInvitationEmailDispatcher(deps: InvitationEmailDeps) {
  return invitationEmailDispatcher(deps, false)
}

function invitationEmailDispatcher({ db, queue }: InvitationEmailDeps, dueOnly: boolean) {
  return async (request: InvitationEmailRequest): Promise<void> => {
    try {
      const payload = InvitationEmailPayload.parse(request)
      const confirmed = await db.transaction().execute(async (trx) => {
        const current = await currentDelivery(trx, payload.invitationId)
        if (!current || current.delivery.generation !== payload.generation) return false
        const { invitation, delivery } = current
        if (delivery.state !== 'queued') return false
        if (dueOnly && !delivery.due) return false
        if (invitation.status !== 'pending' || !invitation.unexpired) {
          await skipIneligible(trx, payload.invitationId, payload.generation)
          return false
        }
        if (
          delivery.last_job_id &&
          (await queue.hasLiveInvitationEmailJob({ id: delivery.last_job_id, ...payload }, trx))
        )
          return true
        const jobId = await queue.enqueue(INVITATION_EMAIL_JOB, payload, {
          singletonKey: `invitation-email:v1:${payload.invitationId}:${payload.generation}`,
          // pg-boss starts retention at startAfter. An overdue row needs a fresh
          // queue lifetime, while its original application due time stays intact.
          startAfter: delivery.due ? undefined : delivery.due_at,
          transaction: trx,
        })
        // Exclusive conflicts are deliberately not assumed to prove the retained identity.
        if (!jobId) throw new InvitationEmailQueueError()
        await trx
          .updateTable('invitation_deliveries')
          .set({ last_job_id: jobId })
          .where('invitation_id', '=', payload.invitationId)
          .where('generation', '=', payload.generation)
          .execute()
        return true
      })
      // Ineligible rows are retired above, but only a confirmed durable job is success.
      if (!confirmed) throw new InvitationEmailQueueError()
    } catch {
      throw new InvitationEmailQueueError()
    }
  }
}

/** The sender is added separately. This handler only retires ineligible generations. */
export function invitationEmailJob({ db }: { db: Db }) {
  return defineJob({
    name: INVITATION_EMAIL_JOB,
    payload: InvitationEmailPayload,
    policy: 'exclusive',
    retry: { limit: 0, delaySeconds: 0, backoff: false },
    expireInSeconds: 180,
    retentionSeconds: 86400,
    deleteAfterSeconds: 604800,
    async handler(payload) {
      try {
        await db.transaction().execute(async (trx) => {
          const current = await currentDelivery(trx, payload.invitationId)
          // Only one current-generation row exists. An old job must not retire its successor.
          if (!current || current.delivery.generation !== payload.generation) return
          if (current.invitation.status !== 'pending' || !current.invitation.unexpired) {
            await skipIneligible(trx, payload.invitationId, payload.generation)
          }
        })
      } catch {
        throw new Error('invitation_email_worker_unavailable')
      }
    },
  })
}

/**
 * One bounded batch per run. Advancing past every candidate, including failures, keeps
 * an unhealthy low ID from starving later invitations; the next run wraps at the end.
 */
export function createInvitationEmailRepairer(deps: InvitationEmailDeps) {
  const dispatch = invitationEmailDispatcher(deps, true)
  let afterId: string | null = null
  return async (): Promise<void> => {
    try {
      let candidates = await dueInvitations(deps.db, afterId)
      if (!candidates.length && afterId !== null) {
        afterId = null
        candidates = await dueInvitations(deps.db, afterId)
      }
      for (const candidate of candidates) {
        afterId = candidate.invitation_id
        try {
          await dispatch({
            invitationId: candidate.invitation_id,
            generation: candidate.generation,
          })
        } catch {
          // The due row survives. Continue so one unavailable generation cannot starve others.
        }
      }
    } catch {
      throw new Error('invitation_email_repair_unavailable')
    }
  }
}

async function dueInvitations(db: Db, afterId: string | null) {
  return db
    .selectFrom('invitation_deliveries')
    .select(['invitation_id', 'generation'])
    .where('state', '=', 'queued')
    .where('due_at', '<=', sql<Date>`clock_timestamp()`)
    .$if(afterId !== null, (query) => query.where('invitation_id', '>', afterId as string))
    .orderBy('invitation_id')
    .limit(100)
    .execute()
}

/** Workers install this every-minute schedule; startup invokes the same repair closure. */
export function invitationEmailRepairJob(repair: () => Promise<void>) {
  return defineJob({
    name: INVITATION_EMAIL_REPAIR_JOB,
    payload: z.strictObject({}),
    retry: { limit: 0, delaySeconds: 0, backoff: false },
    schedule: { cron: '* * * * *', payload: {} },
    handler: repair,
  })
}
