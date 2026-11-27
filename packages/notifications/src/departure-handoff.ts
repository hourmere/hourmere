import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import {
  departureHandoffEmail,
  type Mailer,
  type MailMessage,
  sendWorkflowSmtpAttempt,
  type WorkflowSmtpAttemptOutcome,
} from '@hourmere/mail'
import {
  DEPARTURE_HANDOFF_SEND_LIMIT,
  departureHandoffRecipientHash,
  departureHandoffTokenDigest,
  lockDepartureHandoffSource,
} from '@hourmere/scheduling/departure-handoff-proposals'
import { cleanInviteeEmail } from '@hourmere/scheduling/text'
import { sql } from 'kysely'
import { z } from 'zod'
import type { NotificationDeps } from './index.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

export const DEPARTURE_HANDOFF_EMAIL_JOB = 'departure-handoff-email-v1'
const payload = z.strictObject({ recipientId: z.uuid() })
type DeliveryPayload = z.output<typeof payload>
type CompletedDelivery = 'sent' | 'failed'
type DeliveryState = CompletedDelivery | 'queued' | 'unavailable' | 'skipped' | 'unknown'

export function createDepartureHandoffEmailQueue(queue: {
  enqueue(
    name: typeof DEPARTURE_HANDOFF_EMAIL_JOB,
    request: DeliveryPayload,
    options: EnqueueOptions,
  ): Promise<string | null>
}) {
  return async (trx: Db, recipientId: string): Promise<string> => {
    try {
      const id = await queue.enqueue(
        DEPARTURE_HANDOFF_EMAIL_JOB,
        { recipientId },
        {
          transaction: trx,
        },
      )
      if (id) return id
    } catch {
      // The queue's diagnostics may contain private context.
    }
    throw new Error('handoff_email_queue_unavailable')
  }
}

export function departureHandoffEmailJob(deps?: NotificationDeps) {
  const definition = {
    name: DEPARTURE_HANDOFF_EMAIL_JOB as typeof DEPARTURE_HANDOFF_EMAIL_JOB,
    payload,
    concurrency: 2,
    retentionSeconds: 15 * 60,
  }
  return deps
    ? defineJob({
        ...definition,
        handler: (request, { id, signal }) =>
          deliverDepartureHandoffEmail(deps, request, { id, signal }),
      })
    : defineJob(definition)
}

export function departureHandoffCleanupJob(cleanup: () => Promise<void>) {
  return defineJob({
    name: 'departure-handoff-cleanup-v1',
    payload: z.strictObject({}),
    policy: 'exclusive',
    schedule: { cron: '23 * * * *', payload: {} },
    handler: cleanup,
  })
}

const clock = (deps: NotificationDeps) => deps.now?.() ?? Temporal.Now.instant()
const utc = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** The recipient binding is immutable. Its mutable fields and the intent are only read
 * under the same organization → source → exact offer → recipient lock order as writes. */
async function lockDelivery(trx: Db, recipientId: string, jobId: string) {
  const identity = await trx
    .selectFrom('departure_handoff_recipients')
    .select(['organization_id', 'source_booking_id', 'offer_id', 'offer_version', 'recipient_key'])
    .where('id', '=', recipientId)
    .executeTakeFirst()
  if (!identity) return
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', identity.organization_id)
    .forShare()
    .executeTakeFirst()
  if (!organization) return
  const source = await lockDepartureHandoffSource(trx, organization.id, identity.source_booking_id)
  if (!source) return
  const offer = await trx
    .selectFrom('departure_handoff_offers')
    .select([
      'state',
      utc('issued_at').as('issuedAt'),
      utc('expires_at').as('expiresAt'),
      utc('target_start_at').as('targetStart'),
    ])
    .where('organization_id', '=', organization.id)
    .where('source_booking_id', '=', source.id)
    .where('id', '=', identity.offer_id)
    .where('version', '=', identity.offer_version)
    .forUpdate()
    .executeTakeFirst()
  if (!offer) return
  const recipient = await trx
    .selectFrom('departure_handoff_recipients')
    .select(['decision', 'token_digest'])
    .where('id', '=', recipientId)
    .forUpdate()
    .executeTakeFirst()
  if (!recipient) return
  const delivery = await trx
    .selectFrom('departure_handoff_deliveries')
    .select('state')
    .where('job_id', '=', jobId)
    .where('recipient_id', '=', recipientId)
    .forUpdate()
    .executeTakeFirst()
  return delivery && { identity, source, offer, recipient, state: delivery.state }
}

type Delivery = NonNullable<Awaited<ReturnType<typeof lockDelivery>>>

function isLive(work: Delivery, now: Temporal.Instant) {
  return (
    work.source.status === 'confirmed' &&
    !work.source.hasSuccessor &&
    work.source.start !== null &&
    work.offer.state === 'live' &&
    work.recipient.decision === null &&
    Temporal.Instant.compare(work.offer.issuedAt, now) <= 0 &&
    [work.source.start, work.offer.expiresAt, work.offer.targetStart].every(
      (deadline) => Temporal.Instant.compare(now, deadline) < 0,
    )
  )
}

async function setState(trx: Db, jobId: string, state: Exclude<DeliveryState, 'queued'>) {
  await trx
    .updateTable('departure_handoff_deliveries')
    .set({ state })
    .where('job_id', '=', jobId)
    .execute()
}

async function claimDelivery(
  deps: NotificationDeps,
  recipientId: string,
  jobId: string,
  signal?: AbortSignal,
) {
  return deps.db.transaction().execute(async (trx) => {
    const work = await lockDelivery(trx, recipientId, jobId)
    if (work?.state !== 'queued') return
    if (!isLive(work, clock(deps))) return setState(trx, jobId, 'skipped')
    // A resolving log mailer provides no evidence of any delivery.
    if (!deps.mailer.sendWorkflowAttempt) return setState(trx, jobId, 'unavailable')

    const { organization_id, source_booking_id, recipient_key } = work.identity
    const recipientHash = departureHandoffRecipientHash(source_booking_id, recipient_key)
    const budgets = trx
      .selectFrom('departure_handoff_send_budgets')
      .select('counted_sends')
      .where('organization_id', '=', organization_id)
      .where('source_booking_id', '=', source_booking_id)
      .where('recipient_hash', '=', recipientHash)
    const counted = (await budgets.executeTakeFirst())?.counted_sends ?? 0
    if (counted >= DEPARTURE_HANDOFF_SEND_LIMIT) return setState(trx, jobId, 'unavailable')
    const attendees = await trx
      .selectFrom('booking_attendees')
      .select(['email', 'locale', 'is_booker'])
      .where('booking_id', '=', source_booking_id)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute()
    const recipient = attendees
      .map((attendee) => ({ ...attendee, email: cleanInviteeEmail(attendee.email) }))
      .find((attendee) => attendee.email?.toLowerCase() === recipient_key)
    if (!recipient?.email) return setState(trx, jobId, 'skipped')
    const locale = recipient.locale ?? attendees.find((attendee) => attendee.is_booker)?.locale

    await lockNotificationEmailBudget(trx)
    signal?.throwIfAborted()
    const now = clock(deps)
    if (!isLive(work, now)) return setState(trx, jobId, 'skipped')
    const mailHash = notificationRecipientHash(recipient_key, deps.secret)
    const sentAt = new Date(now.epochMilliseconds)
    if (await notificationEmailBudget(trx, deps, mailHash, true, sentAt))
      return setState(trx, jobId, 'unavailable')

    const secret = randomBytes(32).toString('base64url')
    const digest = departureHandoffTokenDigest(recipientId, secret)
    const message = departureHandoffEmail({
      to: recipient.email,
      publicUrl: deps.publicUrl,
      recipientId,
      secret,
      locale,
    })
    await trx
      .insertInto('departure_handoff_send_budgets')
      .values({
        organization_id,
        source_booking_id,
        recipient_hash: recipientHash,
        counted_sends: counted + 1,
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'source_booking_id', 'recipient_hash'])
          .doUpdateSet({ counted_sends: counted + 1 }),
      )
      .execute()
    await trx
      .updateTable('departure_handoff_recipients')
      .set({ token_digest: digest })
      .where('id', '=', recipientId)
      .execute()
    // The durable claim accounts for delivery even if the worker dies after SMTP accepts.
    await trx
      .insertInto('notification_email_sends')
      .values({ recipient_hash: mailHash, sent_at: sentAt })
      .execute()
    await setState(trx, jobId, 'unknown')
    return { digest, message }
  })
}

/** Pending SMTP holds no database locks. Recheck liveness immediately before starting,
 * and fence completion against withdrawal, expiration, or a later send. */
function checkDelivery(
  deps: NotificationDeps,
  recipientId: string,
  jobId: string,
  digest: string,
  outcome?: CompletedDelivery,
) {
  return deps.db.transaction().execute(async (trx) => {
    const work = await lockDelivery(trx, recipientId, jobId)
    if (work?.state !== 'unknown') return false
    const ownsDigest = work.recipient.token_digest === digest
    const active = ownsDigest && isLive(work, clock(deps))
    // A known SMTP result belongs to this historical attempt even when its link
    // was revoked while the exchange was under way.
    const state = outcome ?? (active ? undefined : 'skipped')
    if (state === undefined) return true
    await setState(trx, jobId, state)
    if (ownsDigest && (!active || state !== 'sent'))
      await trx
        .updateTable('departure_handoff_recipients')
        .set({ token_digest: null })
        .where('id', '=', recipientId)
        .execute()
    return false
  })
}

function sendOnce(
  mailer: Mailer,
  message: MailMessage,
  shutdown: AbortSignal | undefined,
): Promise<WorkflowSmtpAttemptOutcome> {
  const timeout = AbortSignal.timeout(60_000)
  const signal = shutdown ? AbortSignal.any([shutdown, timeout]) : timeout
  if (signal.aborted) return Promise.resolve('known_not_sent')
  return new Promise((resolve) => {
    const abort = () => resolve('delivery_unknown')
    signal.addEventListener('abort', abort, { once: true })
    void sendWorkflowSmtpAttempt(mailer, message)
      .then(resolve)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function deliverDepartureHandoffEmail(
  deps: NotificationDeps,
  { recipientId }: DeliveryPayload,
  { id, signal }: { id: string; signal?: AbortSignal },
): Promise<void> {
  try {
    signal?.throwIfAborted()
    const claim = await claimDelivery(deps, recipientId, id, signal)
    if (!claim || !(await checkDelivery(deps, recipientId, id, claim.digest))) return
    const result = await sendOnce(deps.mailer, claim.message, signal)
    if (result !== 'delivery_unknown')
      await checkDelivery(
        deps,
        recipientId,
        id,
        claim.digest,
        result === 'sent' ? 'sent' : 'failed',
      )
  } catch {
    // Database and transport exceptions may contain an address or capability.
    throw new Error('handoff_email_delivery_unavailable')
  }
}
