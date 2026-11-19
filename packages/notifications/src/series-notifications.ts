import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import {
  MailRejectedError,
  type SeriesEmailDetails,
  type SeriesEmailMember,
  type SeriesEmailRecipient,
  seriesBookingEmail,
} from '@hourmere/mail'
import { sql } from 'kysely'
import { z } from 'zod'
import {
  lockBookingHostMembership,
  lockVerifiedHostAddress,
  sendAndRecordBookingEmail,
} from './booking-email-send.ts'
import { loadNotificationData, type NotificationDeps } from './index.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

const MAX_ATTEMPTS = 13
const LEASE_MS = 600_000
const SEND_MS = 240_000
const BATCH_SIZE = 100
const retryDelay = (attempt: number) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000)
const at = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime())

interface Action {
  id: string
  organization_id: string
  series_id: string
  kind: 'confirmation' | 'cancellation'
  sequence: string
  attempts: number
  lease_id: string | null
}

function claimSeriesNotification(db: Db, now: Date, leaseId: string) {
  // Claim only the intent. Recipient transactions and SMTP run after this commits.
  // An expired final lease is terminal even if its worker crashed.
  return sql<Action>`
    WITH next AS (
      SELECT id FROM booking_series_notifications
      WHERE row_type = 'outbox' AND kind IN ('confirmation', 'cancellation')
        AND outbox_state = 'pending' AND due_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now})
      ORDER BY due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE booking_series_notifications n SET
      outbox_state = CASE WHEN n.attempts >= ${MAX_ATTEMPTS} THEN 'exhausted' ELSE 'pending' END,
      attempts = LEAST(n.attempts + 1, ${MAX_ATTEMPTS}),
      lease_id = CASE WHEN n.attempts < ${MAX_ATTEMPTS} THEN ${leaseId}::uuid END,
      lease_until = CASE WHEN n.attempts < ${MAX_ATTEMPTS}
        THEN ${new Date(now.getTime() + LEASE_MS)}::timestamptz END,
      due_at = ${now}
    FROM next WHERE n.id = next.id
    RETURNING n.id, n.organization_id, n.series_id, n.kind, n.sequence, n.attempts, n.lease_id
  `.execute(db)
}

function currentSeriesMembers(db: Db, action: Action) {
  return db
    .selectFrom('booking_series_occurrences as o')
    .innerJoin('bookings as b', (join) =>
      join
        .onRef('b.series_occurrence_id', '=', 'o.id')
        .onRef('b.organization_id', '=', 'o.organization_id'),
    )
    .select([
      'o.id as occurrenceId',
      'o.ordinal',
      'o.root_booking_id as rootId',
      'b.id',
      'b.start_at',
      'b.end_at',
      'b.status',
      sql<string | null>`b.location ->> 'url'`.as('joinUrl'),
    ])
    .where('o.series_id', '=', action.series_id)
    .where('o.organization_id', '=', action.organization_id)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('bookings as successor')
            .select('successor.id')
            .whereRef('successor.rescheduled_from_id', '=', 'b.id')
            .whereRef('successor.organization_id', '=', 'o.organization_id')
            .whereRef('successor.series_occurrence_id', '=', 'o.id'),
        ),
      ),
    )
    .orderBy('o.ordinal')
    .execute()
}

type Member = Awaited<ReturnType<typeof currentSeriesMembers>>[number]

function describeMember(member: Member, now: Date, affected: boolean): SeriesEmailMember {
  const state =
    member.status === 'cancelled'
      ? 'cancelled'
      : member.start_at <= now
        ? 'started'
        : member.id !== member.rootId
          ? 'updated_separately'
          : 'confirmed'
  return {
    start: at(member.start_at),
    end: at(member.end_at),
    state,
    affected,
    ...(state === 'confirmed' &&
      member.joinUrl && { conference: { state: 'ready', url: member.joinUrl } }),
  }
}

type Recipient = {
  id: string
  email: string
  timeZone: string
  locale: string | null
  role: 'booker' | 'guest' | 'host'
}

async function sendSeriesRecipient(
  deps: NotificationDeps,
  action: Action,
  rootId: string,
  recipient: Recipient,
  details: Omit<SeriesEmailDetails, 'members'>,
  affected: ReadonlySet<string>,
  clock: () => Date,
  signal: AbortSignal,
): Promise<'done' | 'skipped'> {
  const inviteeFacing = recipient.role !== 'host'
  const recipientHash = notificationRecipientHash(recipient.email, deps.secret)
  const outcome = await deps.db.transaction().execute(async (trx) => {
    if (inviteeFacing) {
      const attendee = await trx
        .selectFrom('booking_attendees')
        .select('id')
        .where('booking_id', '=', rootId)
        .where('id', '=', recipient.id)
        .where('email', '=', recipient.email)
        .where('is_booker', '=', recipient.role === 'booker')
        .forShare()
        .executeTakeFirst()
      if (!attendee) return { state: 'done' } as const
    } else if (
      !(await lockVerifiedHostAddress(trx, recipient)) ||
      !(await lockBookingHostMembership(trx, rootId, recipient.id))
    ) {
      return { state: 'done' } as const
    }

    await lockNotificationEmailBudget(trx)
    signal.throwIfAborted()
    const lease = await trx
      .selectFrom('booking_series_notifications')
      .select('id')
      .where('id', '=', action.id)
      .where('lease_id', '=', action.lease_id)
      .where('lease_until', '>', clock())
      .where('outbox_state', '=', 'pending')
      .executeTakeFirst()
    if (!lease) return { state: 'skipped' } as const
    // Read the latest members for each recipient, after waiting for the shared budget.
    // Keep booking/series lifecycle writes free to run while SMTP is in flight.
    const rows = await currentSeriesMembers(trx, action)
    const now = clock()
    if (
      !rows.length ||
      (action.kind === 'confirmation' &&
        !rows.some((row) => row.status === 'confirmed' && row.start_at > now))
    ) {
      return { state: 'skipped' } as const
    }
    const receipt = await trx
      .insertInto('booking_series_notifications')
      .values({
        organization_id: action.organization_id,
        series_id: action.series_id,
        row_type: 'receipt',
        kind: action.kind,
        sequence: action.sequence,
        recipient_role: recipient.role,
        recipient_id: recipient.id,
        // A provisional receipt claims the identity. Only delivery or suppression commits.
        outcome: 'rejected',
      })
      .onConflict((oc) => oc.constraint('booking_series_notifications_identity_key').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!receipt) return { state: 'done' } as const
    const updateReceipt = () =>
      trx.updateTable('booking_series_notifications').where('id', '=', receipt.id)
    const reason = await notificationEmailBudget(trx, deps, recipientHash, inviteeFacing, now)
    if (reason) {
      await updateReceipt().set({ outcome: 'suppressed', suppression_reason: reason }).execute()
      return { state: 'done', reason } as const
    }

    const mailRecipient: SeriesEmailRecipient =
      recipient.role === 'host'
        ? {
            ...recipient,
            role: 'host',
            seriesUrl: new URL(`/app/booking-series/${action.series_id}`, details.publicUrl).href,
          }
        : { ...recipient, role: recipient.role, token: randomBytes(32).toString('base64url') }
    const token = 'token' in mailRecipient ? mailRecipient.token : undefined
    const members = rows.map((row) => describeMember(row, now, affected.has(row.occurrenceId)))
    const sentAt = await sendAndRecordBookingEmail(
      trx,
      deps.mailer,
      action.organization_id,
      inviteeFacing ? recipientHash : null,
      () =>
        seriesBookingEmail(
          action.kind === 'confirmation' ? 'confirmed' : 'cancelled',
          { ...details, members },
          mailRecipient,
        ),
      clock,
      signal,
    )
    await updateReceipt()
      .set({
        outcome: 'delivered',
        sent_at: sentAt,
        reported_ordinals: rows.map((row) => row.ordinal),
        reported_link_states: members.map((member) =>
          member.state === 'confirmed'
            ? action.kind === 'confirmation'
              ? (member.conference?.state ?? 'no_conference')
              : 'no_conference'
            : member.state,
        ),
        manage_token_hash: token ? createHash('sha256').update(token, 'utf8').digest() : null,
        capability_scope: token ? (recipient.role === 'booker' ? 'manage' : 'read') : null,
      })
      .execute()
    return { state: 'done' } as const
  })
  if (outcome.reason) {
    ;(deps.log ?? console.warn)(
      JSON.stringify({
        level: 'warn',
        event: 'notification_email_suppressed',
        seriesId: action.series_id,
        kind: action.kind,
        reason: outcome.reason,
        recipientHash: recipientHash.toString('hex'),
      }),
    )
  }
  return outcome.state
}

async function deliverSeriesNotification(
  deps: NotificationDeps,
  action: Action,
  clock: () => Date,
  signal: AbortSignal,
) {
  const operation = await deps.db
    .selectFrom('booking_series_receipts as r')
    .innerJoin('booking_series_occurrences as o', (join) =>
      join
        .onRef('o.series_id', '=', 'r.series_id')
        .onRef('o.organization_id', '=', 'r.organization_id'),
    )
    .leftJoin('bookings as b', (join) =>
      join
        .onRef('b.organization_id', '=', 'r.organization_id')
        .on(sql<boolean>`b.id = r.result_booking_ids[1]`),
    )
    .select(['r.affected_occurrence_ids', 'o.root_booking_id', 'b.cancel_reason'])
    .where('r.id', '=', action.id)
    .where('r.series_id', '=', action.series_id)
    .where('r.organization_id', '=', action.organization_id)
    .where('r.operation_kind', '=', action.kind === 'confirmation' ? 'create' : 'bulk_cancel')
    .where('o.ordinal', '=', 1)
    .executeTakeFirst()
  if (!operation) return 'skipped'
  const data = await loadNotificationData(deps.db, operation.root_booking_id)
  const booker = data?.attendees.find((a) => a.isBooker)
  if (!data || !booker) return 'skipped'
  const details = {
    eventName: data.booking.eventName,
    hostName: data.hosts[0]?.displayName ?? '',
    ...(data.collective && { hostNames: data.hosts.map((host) => host.displayName) }),
    inviteeName: booker.name,
    locale: booker.locale,
    cancelReason: operation.cancel_reason,
    publicUrl: new URL(deps.publicUrl).origin,
  }
  const affected = new Set(action.kind === 'cancellation' ? operation.affected_occurrence_ids : [])
  const recipients: Recipient[] = [
    ...data.hosts.map((host) => ({ ...host, role: 'host' as const })),
    ...data.attendees.map((a) => ({
      ...a,
      role: a.isBooker ? ('booker' as const) : ('guest' as const),
    })),
  ]
  let retry = false
  for (const recipient of recipients) {
    signal.throwIfAborted()
    try {
      if (
        (await sendSeriesRecipient(
          deps,
          action,
          operation.root_booking_id,
          recipient,
          details,
          affected,
          clock,
          signal,
        )) === 'skipped'
      )
        return 'skipped'
    } catch (error) {
      if (!(error instanceof MailRejectedError) || !error.recipientOnly) throw error
      retry = true
    }
  }
  return retry ? 'pending' : 'done'
}

async function dispatchSeriesNotifications(deps: NotificationDeps, signal: AbortSignal) {
  const clock = () => new Date((deps.now?.() ?? Temporal.Now.instant()).epochMilliseconds)
  const exhausted = (action: Action) =>
    (deps.log ?? console.warn)(
      JSON.stringify({
        level: 'warn',
        event: 'series_notification_exhausted',
        notificationId: action.id,
      }),
    )
  for (let batch = 0; batch < BATCH_SIZE; batch++) {
    signal.throwIfAborted()
    const {
      rows: [action],
    } = await claimSeriesNotification(deps.db, clock(), randomUUID())
    if (!action) return
    if (!action.lease_id) {
      exhausted(action)
      continue
    }
    const timeout = AbortSignal.timeout(SEND_MS)
    let state: 'pending' | 'done' | 'skipped' | 'exhausted' = 'pending'
    try {
      state = await deliverSeriesNotification(
        deps,
        action,
        clock,
        AbortSignal.any([signal, timeout]),
      )
    } catch {
      // SMTP and rendering errors can contain the message or capability.
    }
    if (state === 'pending' && action.attempts >= MAX_ATTEMPTS) state = 'exhausted'
    const now = clock()
    const finished = await deps.db
      .updateTable('booking_series_notifications')
      .set({
        outbox_state: state,
        due_at: state === 'pending' ? new Date(now.getTime() + retryDelay(action.attempts)) : now,
        lease_id: null,
        lease_until: null,
      })
      .where('id', '=', action.id)
      .where('lease_id', '=', action.lease_id)
      .where('lease_until', '>', now)
      .returning('id')
      .executeTakeFirst()
    if (finished && state === 'exhausted') exhausted(action)
  }
}

/** Series retries have their own schedule so they cannot occupy the ordinary booking queue. */
export function seriesNotificationDispatchJob(deps: NotificationDeps) {
  return defineJob({
    name: 'series-notification-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 300,
    retry: { limit: 12, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 },
    handler: (_payload, { signal }) => dispatchSeriesNotifications(deps, signal),
  })
}
