import { randomUUID } from 'node:crypto'
import {
  checkTeamManagementMembership,
  invitationRecipientIsMember,
  invitationRoleAllowed,
  TeamManagementError,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  type Mailer,
  type MailMessage,
  MailRejectedError,
  teamInvitationEmail,
} from '@hourmere/mail'
import { sql } from 'kysely'
import { InvitationEmailPayload, type InvitationEmailRequest } from './invitation-email.ts'
import {
  invitationRecipientHash,
  lockNotificationEmailBudget,
  type NotificationMailLimits,
  notificationEmailBudget,
} from './mail-limits.ts'

const MAX_ATTEMPTS = 4
const LEASE_MS = 120_000
const SMTP_TIMEOUT_MS = 60_000
const LEASE_SAFETY_MS = 1_000
const MIN_SMTP_BUDGET_MS = 1_000
const retryDelay = (attempt: number) => 60_000 * 2 ** Math.min(attempt - 1, 2)

export interface InvitationEmailSenderDeps extends Pick<NotificationMailLimits, 'mailMaxPerHour'> {
  db: Db
  mailer: Mailer
  /** A resolving development log mailer is never evidence of SMTP acceptance. */
  smtpConfigured: boolean
  publicUrl: string
  /** BETTER_AUTH_SECRET, used only for purpose-separated recipient accounting. */
  secret: string
  defaultLanguage?: unknown
  log?: ((line: string) => void) | undefined
}

type ErrorCode =
  | 'transport_error'
  | 'smtp_auth'
  | 'smtp_temporary'
  | 'smtp_permanent'
  | 'smtp_not_configured'
  | 'mail_rate_limited'
  | 'interrupted'
  | 'attempts_exhausted'
  | 'invitation_ineligible'

interface Claim extends InvitationEmailRequest {
  attempt: number
  leaseId: string
}

/** Locks match admission, resend, cleanup and repair; always read time after lock waits. */
async function lockedDelivery(db: Db, invitationId: string) {
  const invitation = await db
    .selectFrom('auth.invitation')
    .selectAll()
    .where('id', '=', invitationId)
    .forUpdate()
    .executeTakeFirst()
  if (!invitation) return
  const delivery = await db
    .selectFrom('invitation_deliveries')
    .selectAll()
    .where('invitation_id', '=', invitationId)
    .forUpdate()
    .executeTakeFirst()
  if (!delivery) return
  return { invitation, delivery }
}

async function databaseTime(db: Db) {
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)
  const now = result.rows[0]?.now
  if (!now) throw new Error('invitation_email_clock_unavailable')
  return now
}

async function terminal(
  db: Db,
  request: InvitationEmailRequest,
  state: 'skipped' | 'failed',
  errorCode: ErrorCode,
  now: Date,
) {
  await db
    .updateTable('invitation_deliveries')
    .set({
      state,
      last_error_code: errorCode,
      lease_id: null,
      lease_until: null,
      updated_at: now,
    })
    .where('invitation_id', '=', request.invitationId)
    .where('generation', '=', request.generation)
    .execute()
}

async function originalInviterIsMember(
  db: Db,
  invitation: { organizationId: string; inviterId: string },
) {
  return Boolean(
    await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', invitation.organizationId)
      .where('userId', '=', invitation.inviterId)
      .executeTakeFirst(),
  )
}

async function invitationAuthorizationIsCurrent(
  db: Db,
  invitation: NonNullable<Awaited<ReturnType<typeof lockedDelivery>>>['invitation'],
  authorizedByUserId: string,
) {
  if (!invitationRoleAllowed(invitation.role)) return false
  // A resend's authorizing administrator cannot revive a departed inviter's link.
  // Current membership is sufficient for the original inviter after a demotion.
  if (!(await originalInviterIsMember(db, invitation))) return false
  const actor = await db
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', authorizedByUserId)
    .where('emailVerified', '=', true)
    .executeTakeFirst()
  if (!actor) return false
  try {
    // Each generation carries its authorizing administrator, rather than a browser session.
    // Read current team authority without reversing management's parent-first lock order.
    await checkTeamManagementMembership(db, authorizedByUserId, invitation.organizationId)
  } catch (error) {
    if (error instanceof TeamManagementError) return false
    throw error
  }
  if (await invitationRecipientIsMember(db, invitation.organizationId, invitation.email))
    return false
  return true
}

async function claimAttempt(deps: InvitationEmailSenderDeps, request: InvitationEmailRequest) {
  return deps.db.transaction().execute(async (trx): Promise<Claim | undefined> => {
    const current = await lockedDelivery(trx, request.invitationId)
    // A stale queued job must never retire the only row, which now represents its successor.
    if (!current || current.delivery.generation !== request.generation) return
    const { invitation, delivery } = current
    if (delivery.state !== 'queued') return
    const initialNow = await databaseTime(trx)
    if (invitation.status !== 'pending' || invitation.expiresAt <= initialNow) {
      await terminal(trx, request, 'skipped', 'invitation_ineligible', initialNow)
      return
    }
    if (!(await originalInviterIsMember(trx, invitation))) {
      await terminal(trx, request, 'skipped', 'invitation_ineligible', initialNow)
      return
    }
    if (delivery.due_at > initialNow) return
    if (delivery.attempts >= MAX_ATTEMPTS) {
      await terminal(trx, request, 'failed', 'attempts_exhausted', initialNow)
      return
    }
    if (!deps.smtpConfigured) {
      await terminal(trx, request, 'failed', 'smtp_not_configured', initialNow)
      return
    }

    await lockNotificationEmailBudget(trx)
    const authorized = await invitationAuthorizationIsCurrent(
      trx,
      invitation,
      delivery.authorized_by_user_id ?? invitation.inviterId,
    )
    // Budget and authorization reads can wait; only a fresh clock can grant an attempt.
    const now = await databaseTime(trx)
    if (invitation.status !== 'pending' || invitation.expiresAt <= now) {
      await terminal(trx, request, 'skipped', 'invitation_ineligible', now)
      return
    }
    if (!authorized) {
      await terminal(trx, request, 'skipped', 'invitation_ineligible', now)
      return
    }
    const recipientHash = invitationRecipientHash(invitation.email, deps.secret)
    const reason = await notificationEmailBudget(
      trx,
      {
        mailMaxPerHour: deps.mailMaxPerHour,
        // Invitation admission owns recipient windows; retries spend only send capacity.
        mailRecipientMaxPerHour: Number.POSITIVE_INFINITY,
        mailRecipientMaxPerDay: Number.POSITIVE_INFINITY,
      },
      recipientHash,
      true,
      now,
    )
    if (reason) {
      await terminal(trx, request, 'failed', 'mail_rate_limited', now)
      return
    }
    const attempt = delivery.attempts + 1
    const leaseId = randomUUID()
    await trx
      .updateTable('invitation_deliveries')
      .set({
        state: 'sending',
        attempts: attempt,
        lease_id: leaseId,
        lease_until: new Date(now.getTime() + LEASE_MS),
        // A crash consumes this attempt and leaves its durable recovery backoff intact.
        due_at: new Date(now.getTime() + retryDelay(attempt)),
        updated_at: now,
      })
      .where('invitation_id', '=', request.invitationId)
      .where('generation', '=', request.generation)
      .execute()
    await trx
      .insertInto('notification_email_sends')
      .values({ recipient_hash: recipientHash, sent_at: now })
      .execute()
    // SMTP must begin only after this claim transaction has committed.
    return { ...request, attempt, leaseId }
  })
}

function ownsClaim(delivery: Awaited<ReturnType<typeof lockedDelivery>>, claim: Claim, now: Date) {
  return (
    delivery?.delivery.generation === claim.generation &&
    delivery.delivery.state === 'sending' &&
    delivery.delivery.attempts === claim.attempt &&
    delivery.delivery.lease_id === claim.leaseId &&
    delivery.delivery.lease_until !== null &&
    delivery.delivery.lease_until > now
  )
}

/** Recheck immediately before SMTP, including recipient/template data changed since claim. */
async function currentMessage(deps: InvitationEmailSenderDeps, claim: Claim) {
  return deps.db.transaction().execute(async (trx) => {
    const current = await lockedDelivery(trx, claim.invitationId)
    const now = await databaseTime(trx)
    if (!ownsClaim(current, claim, now) || !current) return
    const { invitation, delivery } = current
    const authorizedByUserId = delivery.authorized_by_user_id ?? invitation.inviterId
    if (invitation.status !== 'pending' || invitation.expiresAt <= now) {
      await terminal(trx, claim, 'skipped', 'invitation_ineligible', now)
      return
    }
    if (!(await invitationAuthorizationIsCurrent(trx, invitation, authorizedByUserId))) {
      await terminal(trx, claim, 'skipped', 'invitation_ineligible', now)
      return
    }
    const organization = await trx
      .selectFrom('auth.organization')
      .select('name')
      .where('id', '=', invitation.organizationId)
      .executeTakeFirst()
    const inviter = await trx
      .selectFrom('auth.user as u')
      .leftJoin('profiles as p', 'p.user_id', 'u.id')
      .select(['u.name', 'p.locale'])
      .where('u.id', '=', authorizedByUserId)
      .executeTakeFirst()
    if (!organization || !inviter) {
      await terminal(trx, claim, 'skipped', 'invitation_ineligible', now)
      return
    }
    // Template lookups can wait on database locks too. A claim or invitation that
    // expired during those reads must not start a new SMTP exchange.
    // Anchor before the clock read so query, rendering and COMMIT time consume the
    // remaining budget too; monotonic elapsed time does not depend on the app clock.
    const checkedAt = performance.now()
    const readyAt = await databaseTime(trx)
    if (!ownsClaim(current, claim, readyAt)) return
    if (invitation.expiresAt <= readyAt) {
      await terminal(trx, claim, 'skipped', 'invitation_ineligible', readyAt)
      return
    }
    try {
      const message = teamInvitationEmail({
        to: invitation.email,
        invitationId: invitation.id,
        teamName: organization.name,
        inviterName: inviter.name,
        expiresAt: invitation.expiresAt,
        publicUrl: deps.publicUrl,
        language: inviter.locale,
        defaultLanguage: deps.defaultLanguage,
      })
      const smtpDeadline =
        checkedAt +
        Math.min(
          SMTP_TIMEOUT_MS,
          (current.delivery.lease_until as Date).getTime() - readyAt.getTime() - LEASE_SAFETY_MS,
        )
      return { message, smtpDeadline }
    } catch {
      await terminal(trx, claim, 'failed', 'transport_error', readyAt)
      return
    }
  })
}

/** Inspect only known fields, never SMTP reply text, error messages or cause chains. */
function failureCode(error: unknown, signal: AbortSignal, shutdown?: AbortSignal): ErrorCode {
  if (shutdown?.aborted) return 'interrupted'
  if (signal.aborted) return 'transport_error'
  try {
    if (error instanceof MailRejectedError) {
      return error.permanent ? 'smtp_permanent' : 'smtp_temporary'
    }
    const detail = error as { code?: unknown; responseCode?: unknown }
    if (detail?.code === 'EAUTH') return 'smtp_auth'
    if (typeof detail?.responseCode === 'number') {
      if (detail.responseCode >= 500 && detail.responseCode < 600) return 'smtp_permanent'
      if (detail.responseCode >= 400 && detail.responseCode < 500) return 'smtp_temporary'
    }
    if (detail?.code === 'EENVELOPE') return 'smtp_permanent'
  } catch {
    // Arbitrary thrown values may even have throwing property accessors.
  }
  return 'transport_error'
}

/** Bound even a test/custom mailer that ignores the signal; late outcomes are never receipts. */
async function boundedSend(
  deps: InvitationEmailSenderDeps,
  message: MailMessage,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error('invitation_email_send_interrupted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return deps.mailer.send(message, { signal })
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function finishAttempt(deps: InvitationEmailSenderDeps, claim: Claim, code?: ErrorCode) {
  return deps.db.transaction().execute(async (trx) => {
    const current = await lockedDelivery(trx, claim.invitationId)
    const now = await databaseTime(trx)
    if (!ownsClaim(current, claim, now)) return
    const exhausted = code !== undefined && claim.attempt >= MAX_ATTEMPTS
    const permanent = code === 'smtp_auth' || code === 'smtp_permanent'
    const state =
      code === undefined ? 'smtp_accepted' : exhausted || permanent ? 'failed' : 'queued'
    const errorCode = exhausted ? 'attempts_exhausted' : (code ?? null)
    await trx
      .updateTable('invitation_deliveries')
      .set({
        state,
        smtp_accepted_at: code === undefined ? now : null,
        last_error_code: errorCode,
        lease_id: null,
        lease_until: null,
        ...(state === 'queued' && { due_at: new Date(now.getTime() + retryDelay(claim.attempt)) }),
        updated_at: now,
      })
      .where('invitation_id', '=', claim.invitationId)
      .where('generation', '=', claim.generation)
      .where('lease_id', '=', claim.leaseId)
      .execute()
    return { state, errorCode }
  })
}

/** Application-owned budget: pg-boss retries stay zero; the repairer requeues due retries. */
export async function deliverInvitationEmail(
  deps: InvitationEmailSenderDeps,
  request: InvitationEmailRequest,
  signal?: AbortSignal,
  jobId?: string,
): Promise<void> {
  try {
    signal?.throwIfAborted()
    const payload = InvitationEmailPayload.parse(request)
    const claim = await claimAttempt(deps, payload)
    if (!claim) return
    const prepared = await currentMessage(deps, claim)
    if (!prepared) return
    const remaining = Math.floor(prepared.smtpDeadline - performance.now())
    const timeout = AbortSignal.timeout(Math.max(0, remaining))
    const sending = signal ? AbortSignal.any([signal, timeout]) : timeout
    let code: ErrorCode | undefined
    if (remaining < MIN_SMTP_BUDGET_MS) {
      // Do not start an exchange that cannot fit safely inside the current lease.
      code = 'interrupted'
    } else {
      try {
        await boundedSend(deps, prepared.message, sending)
      } catch (error) {
        code = failureCode(error, sending, signal)
      }
    }
    const outcome = await finishAttempt(deps, claim, code)
    if (outcome) {
      // Identifiers and fixed codes only: omit even the redacted recipient and usable link.
      const log = deps.log ?? console.info
      log(
        JSON.stringify({
          event: 'invitation_email_attempt',
          invitationId: payload.invitationId,
          generation: payload.generation,
          ...(jobId !== undefined && { jobId }),
          attempts: claim.attempt,
          state: outcome.state,
          errorCode: outcome.errorCode,
        }),
      )
    }
  } catch {
    // A failure after SMTP acceptance deliberately leaves the consumed claim for repair.
    // Its next finite retry can duplicate mail; no SMTP exactly-once guarantee is possible.
    throw new Error('invitation_email_delivery_unavailable')
  }
}
