import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { type MailMessage, MailRejectedError } from '@hourmere/mail'
import { type Expression, sql } from 'kysely'
import { lockBookingHostMembership, sendAndRecordBookingEmail } from './booking-email-send.ts'
import type { NotificationDeps } from './index.ts'
import {
  lockNotificationEmailBudget,
  notificationEmailBudget,
  notificationRecipientHash,
} from './mail-limits.ts'

const LINK_UPDATE_SPACING_MS = 60 * 60_000
const LINK_UPDATE_DAY_MS = 24 * 60 * 60_000
const LINK_UPDATES_PER_DAY = 3

type Recipient = { id: string; role: 'booker' | 'guest' | 'host'; email: string }
type LinkUpdate = {
  id: string
  organization_id: string
  series_id: string
  sequence: string
  recipient_role: Recipient['role']
  recipient_id: string
  root_booking_id: string
  attempts: number
}

export type RenderSeriesLinkUpdate = (
  trx: Db,
  link: Pick<LinkUpdate, 'organization_id' | 'series_id' | 'root_booking_id'>,
  recipient: Recipient,
  clock: () => Date,
) => Promise<
  | {
      message: () => MailMessage
      report: {
        calendar_ordinals: number[]
        reported_ordinals: number[]
        reported_link_states: string[]
        manage_token_hash: Buffer | null
        capability_scope: 'manage' | 'read' | null
      }
    }
  | undefined
>

function hasUpcomingMember(
  organizationId: Expression<string>,
  seriesId: Expression<string>,
  now: Date,
) {
  return sql<boolean>`EXISTS (
    SELECT FROM booking_series_occurrences o
    JOIN bookings b ON (b.organization_id, b.series_occurrence_id) = (o.organization_id, o.id)
    WHERE (o.organization_id, o.series_id) = (${organizationId}, ${seriesId})
      AND b.status = 'confirmed' AND b.start_at > ${now}
  )`
}

// The waiting-link unique index guarantees that every previous link update for this
// recipient is already final. An earlier aggregate action may still owe this recipient
// a copy even after it has written receipts for other recipients.
function hasEarlierCopy() {
  return sql<boolean>`EXISTS (
    SELECT FROM booking_series_notifications prior
    WHERE (prior.organization_id, prior.series_id) = (link.organization_id, link.series_id)
      AND prior.row_type = 'outbox' AND prior.kind IN ('confirmation', 'cancellation')
      AND prior.sequence <= link.after_action_revision
      AND prior.outbox_state = 'pending'
      AND NOT EXISTS (
        SELECT FROM booking_series_notifications receipt
        WHERE receipt.row_type = 'receipt'
          AND (receipt.series_id, receipt.kind, receipt.sequence)
            = (prior.series_id, prior.kind, prior.sequence)
          AND (receipt.recipient_role, receipt.recipient_id)
            = (link.recipient_role, link.recipient_id)
      )
  )`
}

/** Caller holds the mail-budget lock and has written the earlier copy's final outcome. */
export async function wakeSeriesLinkUpdates(
  trx: Db,
  action: { organization_id: string; series_id: string },
  now: Date,
  recipient?: Pick<Recipient, 'role' | 'id'>,
) {
  let waiting = trx
    .selectFrom('booking_series_notifications as link')
    .select('link.id')
    .where('link.organization_id', '=', action.organization_id)
    .where('link.series_id', '=', action.series_id)
    .where('link.waiting_for_earlier', '=', true)
    .where(sql<boolean>`NOT ${hasEarlierCopy()}`)
  if (recipient)
    waiting = waiting
      .where('link.recipient_role', '=', recipient.role)
      .where('link.recipient_id', '=', recipient.id)
  await trx
    .updateTable('booking_series_notifications')
    .set({ waiting_for_earlier: false, due_at: now })
    .where(
      'id',
      'in',
      waiting.orderBy('link.recipient_role').orderBy('link.recipient_id').forUpdate('link'),
    )
    .execute()
}

function claimLinkUpdate(db: Db, now: Date, leaseId: string, leaseMs: number, maxAttempts: number) {
  return sql<LinkUpdate>`
    WITH next AS (
      SELECT link.id, o.root_booking_id, s.revision FROM booking_series_notifications link
      JOIN booking_series s
        ON (s.organization_id, s.id) = (link.organization_id, link.series_id)
      JOIN booking_series_occurrences o
        ON (o.organization_id, o.series_id) = (link.organization_id, link.series_id)
        AND o.ordinal = 1
      WHERE link.row_type = 'outbox' AND link.kind = 'link_update'
        AND link.outbox_state = 'pending'
        AND (link.lease_until IS NULL OR link.lease_until <= ${now})
        AND (
          (NOT link.waiting_for_earlier AND link.due_at <= ${now})
          OR NOT ${hasUpcomingMember(sql.ref('link.organization_id'), sql.ref('link.series_id'), now)}
        )
      ORDER BY link.due_at, link.id LIMIT 1 FOR UPDATE OF link SKIP LOCKED
    )
    UPDATE booking_series_notifications link SET
      -- A live claim reserves a copy. An expired claim counts as an interruption.
      attempts = LEAST(link.attempts + CASE WHEN link.lease_id IS NULL THEN 0 ELSE 1 END,
        ${maxAttempts}),
      after_action_revision = COALESCE(link.after_action_revision, next.revision),
      waiting_for_earlier = false,
      lease_id = ${leaseId}::uuid,
      lease_until = ${new Date(now.getTime() + leaseMs)}::timestamptz
    FROM next WHERE link.id = next.id
    RETURNING link.id, link.organization_id, link.series_id, link.sequence,
      link.recipient_role, link.recipient_id, link.attempts, next.root_booking_id
  `.execute(db)
}

async function lockLinkRecipient(trx: Db, link: LinkUpdate): Promise<Recipient | undefined> {
  const role = link.recipient_role
  const id = link.recipient_id
  if (role === 'host') {
    const user = await trx
      .selectFrom('auth.user as u')
      .innerJoin('booking_hosts as h', 'h.user_id', 'u.id')
      .select('u.email')
      .where('u.id', '=', id)
      .where('u.emailVerified', '=', true)
      .where('h.booking_id', '=', link.root_booking_id)
      .forShare('u')
      .executeTakeFirst()
    if (user && (await lockBookingHostMembership(trx, link.root_booking_id, id)))
      return { id, role, email: user.email }
    return
  }
  const attendee = await trx
    .selectFrom('booking_attendees')
    .select('email')
    .where('id', '=', id)
    .where('booking_id', '=', link.root_booking_id)
    .where('is_booker', '=', role === 'booker')
    .forShare()
    .executeTakeFirst()
  if (attendee) return { id, role, email: attendee.email }
}

function ownedLinkUpdate(db: Db, link: LinkUpdate, leaseId: string) {
  return db
    .updateTable('booking_series_notifications')
    .where('id', '=', link.id)
    .where('lease_id', '=', leaseId)
}

export function deliveredSeriesReports(
  db: Db,
  series: Pick<LinkUpdate, 'organization_id' | 'series_id'>,
  recipient: Pick<Recipient, 'id' | 'role'>,
) {
  return db
    .selectFrom('booking_series_notifications')
    .where('organization_id', '=', series.organization_id)
    .where('series_id', '=', series.series_id)
    .where('row_type', '=', 'receipt')
    .where('kind', 'in', ['confirmation', 'link_update'])
    .where('outcome', '=', 'delivered')
    .where('recipient_id', '=', recipient.id)
    .where('recipient_role', '=', recipient.role)
}

async function linkUpdateDueAt(trx: Db, link: LinkUpdate, recipient: Recipient, now: Date) {
  const nowMs = now.getTime()
  const reports = await deliveredSeriesReports(trx, link, recipient)
    .select(['kind', 'sent_at'])
    .where('sent_at', '>', new Date(nowMs - LINK_UPDATE_DAY_MS))
    .orderBy('sent_at', 'desc')
    .execute()
  const latest = reports[0]?.sent_at
  const capReceipt = reports.filter((report) => report.kind === 'link_update')[
    LINK_UPDATES_PER_DAY - 1
  ]?.sent_at
  const spacedAt = latest ? latest.getTime() + LINK_UPDATE_SPACING_MS : nowMs
  const underCapAt = capReceipt ? capReceipt.getTime() + LINK_UPDATE_DAY_MS : nowMs
  return new Date(Math.max(spacedAt, underCapAt))
}

async function sendLinkUpdate(
  deps: NotificationDeps,
  link: LinkUpdate,
  leaseId: string,
  clock: () => Date,
  signal: AbortSignal,
  maxAttempts: number,
  render: RenderSeriesLinkUpdate,
) {
  return deps.db.transaction().execute(async (trx) => {
    const recipient = await lockLinkRecipient(trx, link)
    await lockNotificationEmailBudget(trx)
    signal.throwIfAborted()
    const now = clock()
    const claim = await trx
      .selectFrom('booking_series_notifications as link')
      .select([
        hasUpcomingMember(sql.ref('link.organization_id'), sql.ref('link.series_id'), now).as(
          'active',
        ),
        hasEarlierCopy().as('blocked'),
      ])
      .where('link.id', '=', link.id)
      .where('link.lease_id', '=', leaseId)
      .where('link.lease_until', '>', now)
      .forUpdate('link')
      .executeTakeFirst()
    if (!claim) return
    const finish = () =>
      ownedLinkUpdate(trx, link, leaseId).set({ lease_id: null, lease_until: null })
    if (!claim.active || !recipient) {
      await finish().set({ outbox_state: 'skipped', due_at: now }).execute()
      return
    }
    if (link.attempts >= maxAttempts) {
      await finish().set({ outbox_state: 'exhausted', due_at: now }).execute()
      return 'exhausted'
    }
    if (claim.blocked) {
      await finish().set({ waiting_for_earlier: true }).execute()
      return
    }
    // Re-read committed delivery times on every claim, including after SMTP rollback.
    const dueAt = await linkUpdateDueAt(trx, link, recipient, now)
    if (dueAt > now) {
      await finish().set({ due_at: dueAt }).execute()
      return
    }
    const content = await render(trx, link, recipient, clock)
    if (!content) {
      await finish().set({ outbox_state: 'skipped', due_at: clock() }).execute()
      return
    }

    const inviteeFacing = recipient.role !== 'host'
    const recipientHash = notificationRecipientHash(recipient.email, deps.secret)
    const reason = await notificationEmailBudget(trx, deps, recipientHash, inviteeFacing, clock())
    const receipt = {
      organization_id: link.organization_id,
      series_id: link.series_id,
      row_type: 'receipt',
      kind: 'link_update',
      sequence: link.sequence,
      recipient_role: recipient.role,
      recipient_id: recipient.id,
    }
    const record = () => trx.insertInto('booking_series_notifications')
    if (reason) {
      await record()
        .values({ ...receipt, outcome: 'suppressed', suppression_reason: reason })
        .execute()
      await finish().set({ outbox_state: 'done', due_at: now }).execute()
      return
    }
    let sentAt: Date | undefined
    try {
      sentAt = await sendAndRecordBookingEmail(
        trx,
        deps.mailer,
        link.organization_id,
        inviteeFacing ? recipientHash : null,
        content.message,
        clock,
        signal,
      )
    } catch (error) {
      if (!(error instanceof MailRejectedError && error.permanent)) throw error
    }
    await record()
      .values(
        sentAt
          ? {
              ...receipt,
              outcome: 'delivered',
              sent_at: sentAt,
              ...content.report,
            }
          : { ...receipt, outcome: 'rejected' },
      )
      .execute()
    await finish()
      .set({ outbox_state: 'done', due_at: clock(), attempts: link.attempts + 1 })
      .execute()
  })
}

export async function dispatchSeriesLinkUpdates(
  deps: NotificationDeps,
  clock: () => Date,
  signal: AbortSignal,
  limits: {
    batchSize: number
    leaseMs: number
    sendMs: number
    maxAttempts: number
    retryDelay: (attempt: number) => number
  },
  render: RenderSeriesLinkUpdate,
) {
  for (let batch = 0; batch < limits.batchSize; batch++) {
    signal.throwIfAborted()
    const leaseId = randomUUID()
    const {
      rows: [link],
    } = await claimLinkUpdate(deps.db, clock(), leaseId, limits.leaseMs, limits.maxAttempts)
    if (!link) return
    let exhausted = false
    try {
      exhausted =
        (await sendLinkUpdate(
          deps,
          link,
          leaseId,
          clock,
          AbortSignal.any([signal, AbortSignal.timeout(limits.sendMs)]),
          limits.maxAttempts,
          render,
        )) === 'exhausted'
    } catch {
      // The rolled-back message or SMTP error can contain private recipient information.
      const now = clock()
      const attempts = Math.min(link.attempts + 1, limits.maxAttempts)
      const final = attempts >= limits.maxAttempts
      const finished = await ownedLinkUpdate(deps.db, link, leaseId)
        .where('lease_until', '>', now)
        .set({
          attempts,
          outbox_state: final ? 'exhausted' : 'pending',
          due_at: final ? now : new Date(now.getTime() + limits.retryDelay(attempts)),
          lease_id: null,
          lease_until: null,
        })
        .returning('id')
        .executeTakeFirst()
      exhausted = final && !!finished
    }
    if (exhausted)
      (deps.log ?? console.warn)(
        JSON.stringify({
          level: 'warn',
          event: 'series_notification_exhausted',
          notificationId: link.id,
        }),
      )
  }
}
