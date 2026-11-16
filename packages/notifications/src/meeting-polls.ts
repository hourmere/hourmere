// Durable credential outbox. SMTP never holds a database transaction or a poll lock.
import { createHmac, randomUUID } from 'node:crypto'
import type { Db, MeetingPollDeliveryRow } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import {
  type Mailer,
  type MailMessage,
  MailRejectedError,
  meetingPollCredentialEmail,
} from '@hourmere/mail'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  lockNotificationEmailBudget,
  type NotificationMailLimits,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

export interface MeetingPollEmailDeps extends NotificationMailLimits {
  db: Db
  meetingPollSecret: string
  /** Shared notification ledger key. */
  secret: string
  publicUrl: string
  mailer: Mailer
  smtpConfigured: boolean
  now?: (() => Temporal.Instant) | undefined
  defaultLanguage?: unknown
  log?: ((line: string) => void) | undefined
}
export interface MeetingPollEmailRequest {
  id: string
}
const KINDS = ['verification', 'invitation', 'recovery']
async function clock(db: Db, deps: MeetingPollEmailDeps): Promise<Date> {
  if (deps.now) return new Date(deps.now().epochMilliseconds)
  return (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db)).rows[0]?.at as Date
}
async function locked(db: Db, id: string) {
  const initial = await db
    .selectFrom('meeting_poll_deliveries')
    .select('poll_id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!initial) return
  // Deletion and cleanup acquire the parent first; never invert their lock order.
  const poll = await db
    .selectFrom('meeting_polls')
    .selectAll()
    .where('id', '=', initial.poll_id)
    .forUpdate()
    .executeTakeFirst()
  if (!poll) return
  const row = await db
    .selectFrom('meeting_poll_deliveries')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  return row ? { poll, row } : undefined
}
async function finish(
  db: Db,
  row: MeetingPollDeliveryRow,
  at: Date,
  state: 'sent' | 'skipped' | 'suppressed',
  code: string | null,
) {
  await db
    .updateTable('meeting_poll_deliveries')
    .set({
      state,
      terminal_at: at,
      updated_at: at,
      lease_id: null,
      lease_until: null,
      capability_ciphertext: null,
      error_class: code,
    })
    .where('id', '=', row.id)
    .execute()
}
// Scheduling constructs Zod schemas; load it only when work runs, after the HTTP
// composition has installed its OpenAPI extension (including the policy subpath).
async function prepare(deps: MeetingPollEmailDeps, request: MeetingPollEmailRequest) {
  const {
    ensureMeetingPollKey,
    openMeetingPollCredential,
    meetingPollCapabilityDigest,
    MEETING_POLL_RETENTION,
  } = await import('@hourmere/scheduling/meeting-poll-delivery')
  return deps.db.transaction().execute(async (db) => {
    await ensureMeetingPollKey(db, deps.meetingPollSecret)
    const work = await locked(db, request.id)
    if (!work) return
    const { poll, row } = work
    const at = await clock(db, deps)
    if (
      !KINDS.includes(row.kind) ||
      !['pending', 'processing'].includes(row.state) ||
      row.due_at > at ||
      (row.lease_until && row.lease_until > at)
    )
      return
    if (row.attempts >= MEETING_POLL_RETENTION.deliveryMaxAttempts)
      return finish(db, row, at, 'skipped', 'attempts_exhausted')
    // The budget lock precedes final eligibility reads. Only the reservation is inside
    // this transaction; failed/uncertain SMTP consumes it conservatively as well.
    await lockNotificationEmailBudget(db)
    const ready = await clock(db, deps)
    const event = await db
      .selectFrom('event_types')
      .select('deleted_at')
      .where('id', '=', poll.event_type_id)
      .executeTakeFirst()
    const voter = row.voter_id
      ? await db
          .selectFrom('meeting_poll_voters')
          .selectAll()
          .where('id', '=', row.voter_id)
          .executeTakeFirst()
      : undefined
    if (
      !event ||
      event.deleted_at ||
      !['open', 'closed'].includes(poll.status) ||
      (poll.status === 'closed' && row.kind !== 'recovery') ||
      poll.deadline_at <= ready ||
      !voter ||
      voter.withdrawn_at ||
      (voter.pending_expires_at && voter.pending_expires_at <= ready)
    )
      return finish(db, row, ready, 'skipped', 'recipient_unavailable')
    const opened = openMeetingPollCredential(
      deps.meetingPollSecret,
      {
        organizationId: row.organization_id,
        pollId: row.poll_id,
        voterId: voter.id,
        generation: row.generation,
      },
      row.capability_ciphertext,
    )
    if (!opened) return finish(db, row, ready, 'skipped', 'credential_unavailable')
    const capability = await db
      .selectFrom('meeting_poll_capabilities')
      .selectAll()
      .where('poll_id', '=', row.poll_id)
      .where('voter_id', '=', voter.id)
      .where('generation', '=', row.generation)
      .where('purpose', '=', opened.purpose)
      .where('token_digest', '=', meetingPollCapabilityDigest(opened.purpose, opened.token))
      .where('revoked_at', 'is', null)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', ready)
      .executeTakeFirst()
    if (!capability) return finish(db, row, ready, 'skipped', 'credential_unavailable')
    const hash = notificationRecipientHash(voter.email, deps.secret)
    const suppressed = await notificationEmailBudget(db, deps, hash, true, ready)
    if (suppressed) return finish(db, row, ready, 'suppressed', suppressed)
    if (!deps.smtpConfigured) return finish(db, row, ready, 'skipped', 'smtp_not_configured')
    // Independent preference capability: deterministic per retained voter, so recovery
    // and host resend preserve it without retaining another plaintext/ciphertext copy.
    const optOutToken = createHmac('sha256', deps.meetingPollSecret)
      .update(
        `hourmere/meeting-poll/reminder-opt-out/v1\0${row.organization_id}\0${row.poll_id}\0${voter.id}`,
      )
      .digest('base64url')
    if (opened.purpose === 'voting')
      await db
        .insertInto('meeting_poll_capabilities')
        .values({
          organization_id: row.organization_id,
          poll_id: row.poll_id,
          voter_id: voter.id,
          purpose: 'reminder_opt_out',
          generation: 1,
          token_digest: meetingPollCapabilityDigest('reminder_opt_out', optOutToken),
          expires_at: poll.deadline_at,
          capability_ciphertext: null,
        })
        .onConflict((c) => c.column('token_digest').doNothing())
        .execute()
    const message = meetingPollCredentialEmail({
      to: voter.email,
      publicUrl: deps.publicUrl,
      token: opened.token,
      purpose: opened.purpose,
      optOutToken: opened.purpose === 'voting' ? optOutToken : undefined,
      pollTitle: poll.title,
      expiresAt: capability.expires_at,
      timeZone: voter.time_zone,
      language: voter.locale,
      defaultLanguage: deps.defaultLanguage,
    })
    const leaseId = randomUUID()
    await db
      .insertInto('notification_email_sends')
      .values({ recipient_hash: hash, sent_at: ready })
      .execute()
    await db
      .updateTable('meeting_poll_deliveries')
      .set({
        state: 'processing',
        attempts: row.attempts + 1,
        lease_id: leaseId,
        lease_until: new Date(ready.getTime() + MEETING_POLL_RETENTION.deliveryLeaseSeconds * 1000),
        updated_at: ready,
      })
      .where('id', '=', row.id)
      .execute()
    return {
      message,
      leaseId,
      attempt: row.attempts + 1,
      remaining: Math.min(
        60_000,
        capability.expires_at.getTime() - ready.getTime(),
        poll.deadline_at.getTime() - ready.getTime(),
      ),
    }
  })
}
function failureCode(error: unknown) {
  if (error instanceof MailRejectedError)
    return {
      code: error.permanent ? 'smtp_permanent' : 'smtp_temporary',
      permanent: error.permanent,
    }
  return { code: 'transport_error', permanent: false }
}
async function send(mailer: Mailer, message: MailMessage, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error('meeting_poll_email_interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return mailer.send(message, { signal })
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
export async function deliverMeetingPollEmail(
  deps: MeetingPollEmailDeps,
  request: MeetingPollEmailRequest,
  shutdown?: AbortSignal,
) {
  try {
    shutdown?.throwIfAborted()
    const anchor = performance.now()
    const claim = await prepare(deps, request)
    if (!claim) return
    let failure: ReturnType<typeof failureCode> | undefined
    try {
      const remaining = Math.floor(claim.remaining - (performance.now() - anchor))
      if (remaining <= 0) throw new Error('meeting_poll_email_expired')
      const timeout = AbortSignal.timeout(remaining)
      await send(
        deps.mailer,
        claim.message,
        shutdown ? AbortSignal.any([shutdown, timeout]) : timeout,
      )
    } catch (error) {
      failure = failureCode(error)
    }
    const { ensureMeetingPollKey, MEETING_POLL_RETENTION } = await import(
      '@hourmere/scheduling/meeting-poll-delivery'
    )
    await deps.db.transaction().execute(async (db) => {
      await ensureMeetingPollKey(db, deps.meetingPollSecret)
      const work = await locked(db, request.id)
      if (work?.row.state !== 'processing' || work.row.lease_id !== claim.leaseId) return
      const at = await clock(db, deps)
      if (!failure) return finish(db, work.row, at, 'sent', null)
      if (failure.permanent || claim.attempt >= MEETING_POLL_RETENTION.deliveryMaxAttempts)
        return finish(
          db,
          work.row,
          at,
          'skipped',
          failure.permanent ? failure.code : 'attempts_exhausted',
        )
      await db
        .updateTable('meeting_poll_deliveries')
        .set({
          state: 'pending',
          lease_id: null,
          lease_until: null,
          due_at: new Date(at.getTime() + 60_000 * 2 ** (claim.attempt - 1)),
          error_class: failure.code,
          updated_at: at,
        })
        .where('id', '=', request.id)
        .execute()
    })
  } catch {
    // SMTP accepted + receipt commit failed can duplicate on lease recovery. Never log
    // provider/database errors, which may contain addresses or credential plaintext.
    throw new Error('meeting_poll_email_delivery_unavailable')
  }
}
export function createMeetingPollEmailWorker(deps: MeetingPollEmailDeps) {
  let cursor: string | undefined
  return async (signal?: AbortSignal) => {
    const { ensureMeetingPollKey } = await import('@hourmere/scheduling/meeting-poll-delivery')
    const due = () =>
      deps.db.transaction().execute(async (db) => {
        await ensureMeetingPollKey(db, deps.meetingPollSecret)
        const at = await clock(db, deps)
        return db
          .selectFrom('meeting_poll_deliveries')
          .select('id')
          .where('kind', 'in', KINDS)
          .where('due_at', '<=', at)
          .where((eb) =>
            eb.or([
              eb('state', '=', 'pending'),
              eb.and([eb('state', '=', 'processing'), eb('lease_until', '<=', at)]),
            ]),
          )
          .$if(!!cursor, (q) => q.where('id', '>', cursor as string))
          .orderBy('id')
          .limit(100)
          .execute()
      })
    let rows = await due()
    if (!rows.length && cursor) {
      cursor = undefined
      rows = await due()
    }
    const started = performance.now()
    for (const row of rows) {
      if (signal?.aborted || performance.now() - started > 45_000) break
      cursor = row.id
      try {
        await deliverMeetingPollEmail(deps, row, signal)
      } catch {
        deps.log?.('meeting_poll_email_delivery_unavailable')
      }
    }
  }
}
export function meetingPollEmailJob(run?: (signal: AbortSignal) => Promise<void>) {
  const definition = {
    name: 'meeting-poll-email-v1' as const,
    payload: z.strictObject({}),
    policy: 'stately' as const,
    concurrency: 1,
    retry: { limit: 0 },
    expireInSeconds: 180,
    schedule: { cron: '* * * * *', payload: {} },
  }
  return run
    ? defineJob({ ...definition, handler: (_payload, { signal }) => run(signal) })
    : defineJob(definition)
}
