// Creation capture shares the booking transaction. Due rows are the durable outbox; the
// dispatcher adds wakes later. Existing booking snapshots and immutable revisions supply
// content, so execution identity/history never duplicate answers or recipient addresses.
import { createHmac } from 'node:crypto'
import { type Db, isImportedBooking } from '@hourmere/db'
import { type BookingEvent, parseQuestions } from '@hourmere/scheduling'
import {
  DEFAULT_NOTIFICATIONS,
  type NotificationSnapshot,
} from '@hourmere/scheduling/notification-settings'
import { sql } from 'kysely'
import { evaluateConditions } from './conditions.ts'
import { WorkflowDefinitionSchema } from './definition.ts'
import { workflowCapture } from './hard-off.ts'
import {
  scopeSelectsEventType,
  type WorkflowBookingFacts,
  type WorkflowOwner,
} from './ownership.ts'
import { workflowRunTiming } from './timers.ts'
import type { WorkflowRecipientClass } from './variables.ts'

const instant = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime())
const date = (value: Temporal.Instant) => new Date(value.epochMilliseconds)

/** Separate purpose, same normalized-address protocol as the shared mail ledger. */
export function workflowRecipientHash(email: string, secret: string): Buffer {
  const key = createHmac('sha256', secret)
    .update('hourmere/notification-recipient-hash/v1', 'utf8')
    .digest()
  return createHmac('sha256', key)
    .update('workflow\0', 'utf8')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest()
}

interface Recipient {
  identity: string
  email: string
  kind: WorkflowRecipientClass
}

/** Internal service, directly exercised by fixtures; production uses the guarded export. */
export async function captureCreatedWorkflows(
  trx: Db,
  event: BookingEvent,
  now: Temporal.Instant,
  secret: string,
): Promise<void> {
  if (!trx.isTransaction) throw new Error('Workflow capture needs the booking transaction')
  if (event.type !== 'created') return
  const identity = await trx
    .selectFrom('bookings')
    .select('organization_id')
    .where('id', '=', event.bookingId)
    .executeTakeFirst()
  if (!identity) return
  // Protect the organization before touching any definition or execution row.
  await sql`SELECT id FROM auth.organization WHERE id=${identity.organization_id} FOR KEY SHARE`.execute(
    trx,
  )
  const booking = await trx
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', event.bookingId)
    .executeTakeFirst()
  if (
    booking?.status !== 'confirmed' ||
    booking.rescheduled_from_id !== null ||
    booking.group_slot_id !== null ||
    !booking.event_type_id ||
    !['web', 'embed', 'api', 'mcp'].includes(booking.source) ||
    (await isImportedBooking(trx, booking.id))
  )
    return
  const eventType = await trx
    .selectFrom('event_types')
    .selectAll()
    .where('id', '=', booking.event_type_id)
    .executeTakeFirst()
  if (
    !eventType ||
    eventType.organization_id !== booking.organization_id ||
    eventType.deleted_at !== null ||
    eventType.booking_mode !== 'individual'
  )
    return
  const eventFacts = {
    id: eventType.id,
    organizationId: eventType.organization_id,
    ownerUserId: eventType.owner_user_id,
    bookingMode: eventType.booking_mode,
    deleted: false,
    questions: parseQuestions(eventType.questions),
  }
  // Acquire all definition share locks in ID order, then use creation order for intent winners.
  const definitions = await trx
    .selectFrom('workflow_definitions')
    .selectAll()
    .select(
      sql<string>`(extract(epoch from created_at) * 1000000)::bigint::text`.as('creation_order'),
    )
    .where('organization_id', '=', booking.organization_id)
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('id')
    .forShare()
    .execute()
  definitions.sort((a, b) => {
    const order = BigInt(a.creation_order) - BigInt(b.creation_order)
    return order < 0n ? -1 : order > 0n ? 1 : a.id.localeCompare(b.id)
  })
  const attendees = await trx
    .selectFrom('booking_attendees')
    .selectAll()
    .where('booking_id', '=', booking.id)
    .orderBy('is_booker', 'desc')
    .orderBy('id')
    .execute()
  const hosts = await sql<{ id: string; email: string }>`SELECT u.id,u.email FROM booking_hosts h
    JOIN auth."user" u ON u.id=h.user_id
    JOIN auth.member m ON m."userId"=u.id AND m."organizationId"=${booking.organization_id}
    WHERE h.booking_id=${booking.id} AND u."emailVerified"=true ORDER BY u.id`.execute(trx)
  const recipients: Recipient[] = [
    ...attendees.map(
      (a): Recipient => ({
        identity: `attendee:${a.id}`,
        email: a.email,
        kind: a.is_booker ? 'booker' : 'guests',
      }),
    ),
    ...hosts.rows.map(
      (h): Recipient => ({ identity: `host:${h.id}`, email: h.email, kind: 'hosts' }),
    ),
  ]
  const facts: WorkflowBookingFacts = {
    eventTypeId: eventType.id,
    source: booking.source,
    imported: false,
    groupSeat: false,
    responses: booking.responses as Record<string, unknown>,
    locationKind: (booking.location as { kind?: string } | null)?.kind ?? null,
    guestCount: attendees.filter((a) => !a.is_booker).length,
  }
  const snapshot = booking.notification_snapshot as unknown as NotificationSnapshot | null
  const notifications = snapshot?.notifications ?? DEFAULT_NOTIFICATIONS
  const coreIntents = new Set<string>()
  for (const [kind, rules] of [
    ['before_start', notifications.reminders],
    ['after_end', notifications.followUps],
  ] as const) {
    for (const rule of rules)
      for (const recipient of recipients) {
        const selected =
          recipient.kind === 'booker'
            ? rule.recipients.invitee
            : recipient.kind === 'guests'
              ? rule.recipients.guests
              : rule.recipients.host
        if (selected)
          coreIntents.add(
            `${kind}:${rule.offsetMinutes}:${workflowRecipientHash(recipient.email, secret).toString('hex')}`,
          )
      }
  }
  for (const row of definitions) {
    const revision = await trx
      .selectFrom('workflow_revisions')
      .select('definition')
      .where('organization_id', '=', booking.organization_id)
      .where('workflow_id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirstOrThrow()
    const definition = WorkflowDefinitionSchema.parse(revision.definition)
    if (!['booking.created', 'before_start', 'after_end'].includes(definition.trigger.type))
      continue
    const owner: WorkflowOwner = row.owner_user_id
      ? {
          kind: 'personal',
          organizationId: row.organization_id,
          userId: row.owner_user_id,
        }
      : { kind: 'team', organizationId: row.organization_id }
    if (!scopeSelectsEventType(owner, definition.scope, eventFacts)) continue
    const enrollment = await trx
      .insertInto('workflow_enrollments')
      .values({
        organization_id: booking.organization_id,
        booking_id: booking.id,
        workflow_id: row.id,
        revision: row.revision,
        occurrence: 'created',
        trigger: definition.trigger.type,
      })
      .onConflict((oc) => oc.columns(['booking_id', 'occurrence', 'workflow_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    // Replayed capture never changes the revision, timing, recipient choices or terminal state.
    if (!enrollment) continue
    const timing = workflowRunTiming(
      definition.trigger,
      { start: instant(booking.start_at), end: instant(booking.end_at) },
      now,
    )
    const conditionsMatch =
      evaluateConditions(owner, definition.conditions, facts) &&
      definition.conditions.every(
        (condition) =>
          condition.field !== 'answer' ||
          eventFacts.questions.some(
            (q) =>
              q.id === condition.questionId &&
              ((q.type === 'checkbox' && typeof condition.value === 'boolean') ||
                (q.type === 'select' &&
                  typeof condition.value === 'string' &&
                  q.options?.includes(condition.value))),
          ),
      )
    const reason = conditionsMatch ? timing.skipReason : 'condition_false'
    const run = await trx
      .insertInto('workflow_runs')
      .values({
        organization_id: booking.organization_id,
        enrollment_id: enrollment.id,
        booking_id: booking.id,
        due_at: date(timing.dueAt),
        expires_at: date(timing.expiresAt),
        state: reason ? 'skipped' : 'pending',
        skip_reason: reason ?? null,
        finished_at: reason ? date(now) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (reason) {
      await trx
        .insertInto('workflow_run_history')
        .values({
          run_id: run.id,
          organization_id: booking.organization_id,
          workflow_id: row.id,
          revision: row.revision,
          trigger: definition.trigger.type,
          due_at: date(timing.dueAt),
          finished_at: date(now),
          outcome: 'skipped',
          reason,
        })
        .execute()
      continue
    }
    const action = definition.actions[0]
    if (action?.type !== 'email') continue
    const seen = new Set<string>()
    for (const recipient of recipients.filter((r) => action.recipients.includes(r.kind))) {
      const hash = workflowRecipientHash(recipient.email, secret)
      const hex = hash.toString('hex')
      if (seen.has(hex)) continue
      seen.add(hex)
      const trigger = definition.trigger
      const timer =
        trigger.type === 'before_start' || trigger.type === 'after_end' ? trigger : undefined
      const existing =
        timer &&
        (coreIntents.has(`${timer.type}:${timer.offsetMinutes}:${hex}`) ||
          (await trx
            .selectFrom('workflow_recipient_claims')
            .select('id')
            .where('booking_id', '=', booking.id)
            .where('intent_kind', '=', timer.type)
            .where('intent_offset_minutes', '=', timer.offsetMinutes)
            .where('recipient_hash', '=', hash)
            .executeTakeFirst()))
      await trx
        .insertInto('workflow_recipient_claims')
        .values({
          organization_id: booking.organization_id,
          run_id: run.id,
          booking_id: booking.id,
          recipient: recipient.identity,
          recipient_hash: hash,
          intent_kind: timer && !existing ? timer.type : null,
          intent_offset_minutes: timer && !existing ? timer.offsetMinutes : null,
          state: existing ? 'skipped' : 'pending',
          skip_reason: existing ? 'existing_notification' : null,
          finished_at: existing ? date(now) : null,
        })
        .execute()
    }
  }
}

export const captureWorkflowCreation = workflowCapture(captureCreatedWorkflows)
