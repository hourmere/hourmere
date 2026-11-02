// Durable waitlist delivery. The outboxes own attempts; queue retries never replenish them.
import { randomBytes, randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import {
  type Mailer,
  type MailMessage,
  MailRejectedError,
  waitlistNotificationEmail,
  waitlistVerificationEmail,
} from '@hourmere/mail'
import type { WaitlistContext } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  lockNotificationEmailBudget,
  type NotificationMailLimits,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

const MAX_ATTEMPTS = 3
const LEASE_MS = 120_000
const SMTP_MS = 60_000
const retryDelay = (attempt: number) => 60_000 * 2 ** (attempt - 1)

export interface WaitlistEmailDeps extends WaitlistContext, NotificationMailLimits {
  mailer: Mailer
  smtpConfigured: boolean
  defaultLanguage?: unknown
  log?: ((line: string) => void) | undefined
}

export interface WaitlistEmailRequest {
  kind: 'verification' | 'notification'
  id: string
}
type Outcome = 'accepted' | 'suppressed' | 'failed' | 'expired' | 'obsolete' | 'rejected'
interface Claim extends WaitlistEmailRequest {
  token: string
  attempt: number
}
interface WorkRow {
  id: string
  entry_id: string
  state: string
  attempts: number
  claim_token: string | null
  lease_until: Date | null
  next_attempt_at: Date
  expires_at: Date
  generation?: number
  encrypted_payload?: Buffer | null
  slots?: { start: string; end: string }[]
}
const tableFor = (kind: WaitlistEmailRequest['kind']) =>
  kind === 'verification' ? 'waitlist_verification_outbox' : 'waitlist_candidates'
// Load the service layer only when executing work. Eager barrel evaluation would
// construct Zod schemas before the HTTP composition installs its OpenAPI extension.
const clock = async (db: Db, deps: WaitlistContext) => {
  const { waitlistNow } = await import('@hourmere/scheduling')
  return waitlistNow(db, deps.now ? new Date(deps.now().epochMilliseconds) : undefined)
}

async function workRow(db: Db, request: WaitlistEmailRequest, lock = false) {
  const { rows } = await sql<WorkRow>`SELECT * FROM ${sql.table(tableFor(request.kind))}
    WHERE id=${request.id} ${lock ? sql`FOR UPDATE SKIP LOCKED` : sql``}`.execute(db)
  return rows[0]
}

async function finish(
  db: Db,
  claim: Claim,
  row: WorkRow,
  state: Outcome,
  at: Date,
  code?: string,
  managementToken?: string,
) {
  const { waitlistTokenHash } = await import('@hourmere/scheduling')
  // Removal and booking take entry -> outbox locks. Completion uses that order too,
  // only after SMTP has finished; no entry/host/booking lock is held during SMTP.
  const entry = await db
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', row.entry_id)
    .forUpdate()
    .executeTakeFirst()
  if (
    state === 'accepted' &&
    managementToken &&
    entry &&
    entry.expires_at > at &&
    ['pending_verification', 'active', 'notified'].includes(entry.status)
  ) {
    // The raw capability exists only in memory until SMTP accepts. Creating its FK
    // before sending would retain an entry row lock during the provider exchange.
    await db
      .insertInto('waitlist_capabilities')
      .values({
        entry_id: entry.id,
        purpose: 'management',
        token_hash: waitlistTokenHash(managementToken, 'management'),
        generation: entry.verification_generation,
        expires_at: entry.expires_at,
        created_at: at,
      })
      .execute()
  }
  const terminalState =
    claim.kind === 'verification' && ['obsolete', 'rejected'].includes(state) ? 'failed' : state
  await sql`UPDATE ${sql.table(tableFor(claim.kind))} SET state=${terminalState},
    claim_token=NULL,lease_until=NULL,accepted_at=${state === 'accepted' ? at : null},
    error_code=${code ?? null},updated_at=${at}
    WHERE id=${claim.id} AND state='processing' AND claim_token=${claim.token}::uuid
      AND attempts=${claim.attempt}`.execute(db)
  if (claim.kind === 'notification') {
    if (entry)
      await sql`UPDATE waitlist_slot_tombstones SET outcome=${state}
      WHERE event_type_id=(SELECT event_type_id FROM waitlist_entries WHERE id=${row.entry_id})
      AND recipient_hash=${entry.recipient_hash} AND outcome='pending'
      AND EXISTS(SELECT FROM jsonb_to_recordset(${JSON.stringify(row.slots)}::jsonb)
        AS slot(start timestamptz,"end" timestamptz)
        WHERE slot.start=start_at AND slot."end"=end_at)`.execute(db)
    if (state === 'accepted')
      await db
        .updateTable('waitlist_entries')
        .set({ status: 'notified' })
        .where('id', '=', row.entry_id)
        .where('status', 'in', ['active', 'notified'])
        .where('expires_at', '>', at)
        .execute()
  }
}

async function claimAttempt(deps: WaitlistEmailDeps, request: WaitlistEmailRequest) {
  const { ensureWaitlistKey } = await import('@hourmere/scheduling')
  return deps.db.transaction().execute(async (db): Promise<Claim | undefined> => {
    await ensureWaitlistKey(db, deps.secret, await clock(db, deps))
    // A sender can still be committing its accepted receipt after the lease expires,
    // for example while waiting for an unrelated entry update. Take its budget fence
    // before claiming work so a successor cannot replace that sender's identity.
    await lockNotificationEmailBudget(db)
    const row = await workRow(db, request, true)
    const at = await clock(db, deps)
    if (!row || !['pending', 'processing'].includes(row.state) || row.next_attempt_at > at) return
    if (row.state === 'processing' && row.lease_until && row.lease_until > at) return
    const claim = { ...request, token: randomUUID(), attempt: row.attempts + 1 }
    // Claim commits before any provider call. A crashed attempt remains consumed.
    // Terminalizing here would reverse removal's entry -> outbox lock order; instead
    // exhausted/expired work is finished in the next short transaction below.
    if (row.attempts >= MAX_ATTEMPTS || row.expires_at <= at) return { ...claim, attempt: 0 }
    await sql`UPDATE ${sql.table(tableFor(request.kind))}
      SET state='processing',attempts=attempts+1,claim_token=${claim.token}::uuid,
        lease_until=${new Date(at.getTime() + LEASE_MS)},updated_at=${at}
      WHERE id=${request.id}`.execute(db)
    return claim
  })
}

async function retireUnsendable(deps: WaitlistEmailDeps, request: WaitlistEmailRequest) {
  await deps.db.transaction().execute(async (db) => {
    const initial = await workRow(db, request)
    if (!initial) return
    await db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('id', '=', initial.entry_id)
      .forUpdate()
      .execute()
    const row = await workRow(db, request, true)
    const at = await clock(db, deps)
    if (!row || !['pending', 'processing'].includes(row.state)) return
    if (row.state === 'processing' && row.lease_until && row.lease_until > at) return
    const state = row.expires_at <= at ? 'expired' : 'failed'
    // Install a finalizer identity without consuming a fourth attempt.
    const token = randomUUID()
    await sql`UPDATE ${sql.table(tableFor(request.kind))} SET state='processing',
      claim_token=${token}::uuid,lease_until=${new Date(at.getTime() + LEASE_MS)}
      WHERE id=${request.id}`.execute(db)
    await finish(
      db,
      { ...request, token, attempt: row.attempts },
      row,
      state,
      at,
      state === 'failed' ? 'attempts_exhausted' : 'deadline_reached',
    )
  })
}

async function currentMessage(
  db: Db,
  deps: WaitlistEmailDeps,
  claim: Claim,
  row: WorkRow,
  at: Date,
) {
  const {
    resolveWaitlistEventById,
    openWaitlistVerificationOutbox,
    waitlistTokenHash,
    listPublicSlots,
    listPublicTeamSlots,
  } = await import('@hourmere/scheduling')
  const entry = await db
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', row.entry_id)
    .executeTakeFirst()
  if (
    !entry?.email ||
    entry.expires_at <= at ||
    !['pending_verification', 'active', 'notified'].includes(entry.status)
  )
    return
  const event = await resolveWaitlistEventById(db, entry.event_type_id)
  if (!event) return
  if (claim.kind === 'verification') {
    if (
      entry.status !== 'pending_verification' ||
      entry.pending_expires_at <= at ||
      entry.verification_generation !== row.generation
    )
      return
    const opened = openWaitlistVerificationOutbox(deps, {
      id: row.id,
      entry_id: row.entry_id,
      generation: row.generation as number,
      encrypted_payload: row.encrypted_payload ?? null,
    })
    if (!opened) return
    const cap = await db
      .selectFrom('waitlist_capabilities')
      .select('id')
      .where('purpose', '=', 'verification')
      .where('token_hash', '=', waitlistTokenHash(opened.verificationToken, 'verification'))
      .where('revoked_at', 'is', null)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', at)
      .executeTakeFirst()
    if (!cap) return
    return { entry, event, verificationToken: opened.verificationToken }
  }
  if (
    !entry.verified_at ||
    !['active', 'notified'].includes(entry.status) ||
    !entry.window_start ||
    !entry.window_end ||
    !row.slots?.length
  )
    return
  // Reread the exact offered intervals after waiting for the shared budget fence.
  // Cache-only availability invokes no calendar providers and takes no host row lock.
  const slots = row.slots
  const start = Temporal.Instant.from(slots[0]?.start as string)
  const end = Temporal.Instant.from(slots.at(-1)?.end as string)
  if (
    start.epochMilliseconds < entry.window_start.getTime() ||
    end.epochMilliseconds > entry.window_end.getTime() ||
    start.epochMilliseconds - event.minimumNoticeMinutes * 60_000 <= at.getTime()
  )
    return
  const available = await (event.team ? listPublicTeamSlots : listPublicSlots)(
    { ...deps, db, now: () => Temporal.Instant.fromEpochMilliseconds(at.getTime()) },
    { handle: event.team?.slug ?? event.handle, slug: event.slug, start, end },
  )
  if (
    !slots.every((slot) =>
      available.some(
        (offered) =>
          Date.parse(offered.start) === Date.parse(slot.start) &&
          Date.parse(offered.end) === Date.parse(slot.end),
      ),
    )
  )
    return
  return { entry, event, verificationToken: undefined }
}

async function boundedSend(mailer: Mailer, message: MailMessage, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error('waitlist_email_interrupted'))
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

/** Fixed codes only: SMTP and database exceptions may contain the capability or address. */
function failureCode(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof MailRejectedError)
    return {
      code: error.permanent ? 'smtp_permanent' : 'smtp_temporary',
      permanent: error.permanent,
    }
  try {
    if ((error as { code?: unknown })?.code === 'EAUTH')
      return { code: 'smtp_auth', permanent: true }
  } catch {
    /* Untrusted errors may have throwing getters. */
  }
  return { code: 'transport_error', permanent: false }
}

export async function deliverWaitlistEmail(
  deps: WaitlistEmailDeps,
  request: WaitlistEmailRequest,
  shutdown?: AbortSignal,
) {
  try {
    shutdown?.throwIfAborted()
    const claim = await claimAttempt(deps, request)
    if (!claim) return
    if (!claim.attempt) return retireUnsendable(deps, request)
    await deps.db.transaction().execute(async (db) => {
      const { ensureWaitlistKey } = await import('@hourmere/scheduling')
      await ensureWaitlistKey(db, deps.secret, await clock(db, deps))
      await lockNotificationEmailBudget(db)
      const row = await workRow(db, request)
      const at = await clock(db, deps)
      if (
        row?.state !== 'processing' ||
        row.claim_token !== claim.token ||
        row.attempts !== claim.attempt ||
        !row.lease_until ||
        row.lease_until <= at
      )
        return
      if (row.expires_at <= at) return finish(db, claim, row, 'expired', at, 'deadline_reached')
      const prepared = await currentMessage(db, deps, claim, row, at)
      if (!prepared) return finish(db, claim, row, 'obsolete', at, 'entry_or_slots_unavailable')
      const hash = notificationRecipientHash(prepared.entry.email as string, deps.secret)
      const suppressed = await notificationEmailBudget(db, deps, hash, true, at)
      if (suppressed) return finish(db, claim, row, 'suppressed', at, suppressed)
      if (!deps.smtpConfigured) return finish(db, claim, row, 'failed', at, 'smtp_not_configured')
      // Sample after all database reads. Rendering and provider time consume the lease.
      const anchor = performance.now()
      const ready = await clock(db, deps)
      const deadline = Math.min(
        row.expires_at.getTime(),
        prepared.entry.expires_at.getTime(),
        claim.kind === 'notification'
          ? Date.parse(row.slots?.[0]?.start as string) -
              prepared.event.minimumNoticeMinutes * 60_000
          : row.expires_at.getTime(),
      )
      const remaining = Math.min(
        SMTP_MS,
        row.lease_until.getTime() - ready.getTime() - 1000,
        deadline - ready.getTime(),
      )
      if (remaining < 1000) return finish(db, claim, row, 'expired', ready, 'deadline_reached')
      const management = `${row.entry_id}.${randomBytes(32).toString('base64url')}`
      const common = {
        to: prepared.entry.email as string,
        publicUrl: deps.publicUrl,
        removalToken: management,
        eventTitle: prepared.event.title,
        expiresAt: new Date(deadline),
        timeZone: prepared.entry.time_zone as string,
        language: prepared.entry.locale,
        defaultLanguage: deps.defaultLanguage,
      }
      const message =
        claim.kind === 'verification'
          ? waitlistVerificationEmail({ ...common, token: prepared.verificationToken as string })
          : waitlistNotificationEmail({
              ...common,
              token: management,
              bookingPath: prepared.event.team
                ? `/team/${prepared.event.team.slug}/${prepared.event.slug}`
                : `/${prepared.event.handle}/${prepared.event.slug}`,
              slots: row.slots as { start: string; end: string }[],
            })
      const timeout = AbortSignal.timeout(
        Math.max(0, Math.floor(remaining - (performance.now() - anchor))),
      )
      const signal = shutdown ? AbortSignal.any([shutdown, timeout]) : timeout
      let failure: ReturnType<typeof failureCode> | undefined
      try {
        await boundedSend(deps.mailer, message, signal)
      } catch (error) {
        failure = failureCode(error)
      }
      const sentAt = await clock(db, deps)
      if (!failure) {
        await db
          .insertInto('notification_email_sends')
          .values({ recipient_hash: hash, sent_at: sentAt })
          .execute()
        await finish(db, claim, row, 'accepted', sentAt, undefined, management)
      } else if (failure.permanent || claim.attempt >= MAX_ATTEMPTS) {
        await finish(
          db,
          claim,
          row,
          failure.permanent ? 'rejected' : 'failed',
          sentAt,
          failure.permanent ? failure.code : 'attempts_exhausted',
        )
      } else {
        // Keep the spent attempt. Only a due future scan can try again, after 60/120s.
        await sql`UPDATE ${sql.table(tableFor(claim.kind))} SET state='pending',claim_token=NULL,
          lease_until=NULL,next_attempt_at=${new Date(sentAt.getTime() + retryDelay(claim.attempt))},
          error_code=${failure.code},updated_at=${sentAt}
          WHERE id=${claim.id} AND state='processing' AND claim_token=${claim.token}::uuid
          AND attempts=${claim.attempt}`.execute(db)
      }
      deps.log?.(
        JSON.stringify({
          event: 'waitlist_email_attempt',
          kind: claim.kind,
          id: claim.id,
          attempts: claim.attempt,
          outcome: failure?.code ?? 'accepted',
        }),
      )
    })
  } catch {
    // SMTP acceptance + failed receipt COMMIT remains the documented duplicate window.
    // The durable claim survives; restart recovery spends another finite attempt.
    throw new Error('waitlist_email_delivery_unavailable')
  }
}

/** Clear the delivered marker when none of its current advertised suggestions remain. */
async function refreshNotifiedEntries(deps: WaitlistEmailDeps, afterId: string | null) {
  const { resolveWaitlistEventById, listPublicSlots, listPublicTeamSlots } = await import(
    '@hourmere/scheduling'
  )
  const at = await clock(deps.db, deps)
  const query = () =>
    deps.db
      .selectFrom('waitlist_entries')
      .select(['id', 'event_type_id'])
      .where('status', '=', 'notified')
      .where('expires_at', '>', at)
      .$if(afterId !== null, (q) => q.where('id', '>', afterId as string))
      .orderBy('id')
      .limit(20)
      .execute()
  let entries = await query()
  if (!entries.length && afterId !== null) {
    afterId = null
    entries = await query()
  }
  const started = performance.now()
  for (const entry of entries) {
    if (performance.now() - started > 5000) break
    afterId = entry.id
    try {
      const event = await resolveWaitlistEventById(deps.db, entry.event_type_id)
      if (!event) continue
      const receipts = await deps.db
        .selectFrom('waitlist_candidates')
        .select(['id', 'slots'])
        .where('entry_id', '=', entry.id)
        .where('state', '=', 'accepted')
        .where('expires_at', '>', at)
        .orderBy('id')
        .limit(101)
        .execute()
      // An unusually large live receipt set is unknown until older receipts expire.
      if (receipts.length > 100) continue
      let offered = false
      for (const receipt of receipts) {
        if (performance.now() - started > 5000) return afterId
        const slots = (receipt.slots as { start: string; end: string }[]).filter(
          (slot) => Date.parse(slot.start) - event.minimumNoticeMinutes * 60_000 > at.getTime(),
        )
        if (!slots.length) continue
        const available = await (event.team ? listPublicTeamSlots : listPublicSlots)(
          { ...deps, now: () => Temporal.Instant.fromEpochMilliseconds(at.getTime()) },
          {
            handle: event.team?.slug ?? event.handle,
            slug: event.slug,
            start: Temporal.Instant.from(slots[0]?.start as string),
            end: Temporal.Instant.from(slots.at(-1)?.end as string),
          },
        )
        if (
          slots.some((slot) =>
            available.some(
              (candidate) =>
                Date.parse(slot.start) === Date.parse(candidate.start) &&
                Date.parse(slot.end) === Date.parse(candidate.end),
            ),
          )
        ) {
          offered = true
          break
        }
      }
      if (offered) continue
      await deps.db
        .updateTable('waitlist_entries')
        .set({ status: 'active' })
        .where('id', '=', entry.id)
        .where('status', '=', 'notified')
        .where('expires_at', '>', at)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('waitlist_candidates as c')
                .select('c.id')
                .whereRef('c.entry_id', '=', 'waitlist_entries.id')
                .where('c.state', '=', 'accepted')
                .where('c.expires_at', '>', at)
                .$if(receipts.length > 0, (q) =>
                  q.where(
                    'c.id',
                    'not in',
                    receipts.map((row) => row.id),
                  ),
                ),
            ),
          ),
        )
        .execute()
    } catch {
      // A calendar/availability failure says nothing about whether a suggestion remains.
      // Keep the delivered marker and move on; a later pass will check again.
    }
  }
  return afterId
}

/** Fair bounded scans repair lost jobs and crashed claims without queue payload secrets. */
export function createWaitlistEmailWorker(deps: WaitlistEmailDeps) {
  let cursor: string | null = null
  let notifiedCursor: string | null = null
  return async (signal?: AbortSignal) => {
    notifiedCursor = await refreshNotifiedEntries(deps, notifiedCursor)
    const at = await clock(deps.db, deps)
    const due = async () =>
      (
        await sql<WaitlistEmailRequest>`
      SELECT kind,id FROM (
        SELECT 'verification'::text AS kind,id,next_attempt_at,state,lease_until FROM waitlist_verification_outbox
        UNION ALL SELECT 'notification',id,next_attempt_at,state,lease_until FROM waitlist_candidates
      ) work WHERE state IN ('pending','processing') AND next_attempt_at<=${at}
        AND (state='pending' OR lease_until<=${at}) ${cursor ? sql`AND id>${cursor}::uuid` : sql``}
      ORDER BY id LIMIT 100`.execute(deps.db)
      ).rows
    let requests = await due()
    if (!requests.length && cursor) {
      cursor = null
      requests = await due()
    }
    const started = performance.now()
    for (const request of requests) {
      if (signal?.aborted || performance.now() - started > 45_000) break
      cursor = request.id
      try {
        await deliverWaitlistEmail(deps, request, signal)
      } catch {
        deps.log?.('waitlist_email_delivery_unavailable')
      }
    }
  }
}

export function waitlistEmailJob(run?: (signal: AbortSignal) => Promise<void>) {
  const definition = {
    name: 'waitlist-email-v1' as const,
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
