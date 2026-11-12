// Migration 0080 replaces audit_events_details_check so that the webhook and Slack
// destination branches check what `events` holds. These checks pass on the migration as
// written and fail when the constraint is dropped (audit-event-details-coverage.test.ts) or
// when the upgrade loses a branch (packages/webhooks/src/audit-event-details-migration.test.ts).
// The catalogues below are bound to the code by packages/webhooks/src/audit-event-catalogue.test.ts.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { assertAuditDetailProtections } from './audit-actions-followups-protections.ts'

export const webhookAuditActions = [
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
  'webhook.secret_rotated',
  'webhook.paused',
  'webhook.resumed',
] as const
export const slackAuditActions = [
  'slack_destination.created',
  'slack_destination.updated',
  'slack_destination.deleted',
  'slack_destination.paused',
  'slack_destination.resumed',
  'slack_destination.tested',
] as const
/** The event names 0080 admits for Slack destinations, in the code's order. */
export const slackAuditEvents = [
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.reschedule_requested',
  'booking.reschedule_request_expired',
] as const
/** The event names 0080 admits for webhooks: Slack's plus the attendee no-show change. */
export const webhookAuditEvents = [...slackAuditEvents, 'booking.attendee_no_show_changed'] as const

const insert = (pool: pg.Pool, action: string, details: unknown) =>
  pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('system', 'coverage', 'none', $1, 'coverage', $2, $3::jsonb)`,
    [action, randomUUID(), JSON.stringify(details)],
  )
const refused = { code: '23514', constraint: 'audit_events_details_check' }

/** `events` values no webhook or Slack action may hold, whatever its catalogue. */
export function refusedEventLists(catalogue: readonly string[]): unknown[] {
  const [first, second] = catalogue as [string, string]
  return [
    'https://hooks.slack.com/services/TPRIVATE/BPRIVATE/private-secret',
    first,
    { name: 'Private Invitee', email: 'invitee@example.com' },
    {},
    null,
    true,
    1,
    [],
    [first, first],
    [first, second, first],
    [...catalogue, first],
    [{ name: 'Private Invitee' }],
    [first, { email: 'invitee@example.com' }],
    [[first]],
    [first, null],
    [first, 1],
    [first, true],
    ['https://hooks.example.com/private'],
    ['Private Invitee'],
    ['invitee@example.com'],
    ['booking.reassigned'],
    [first, 'booking.reassigned'],
    [first.toUpperCase()],
    [` ${first}`],
    [`${first}\n`],
    [''],
  ]
}

/**
 * Throws when a webhook or Slack destination action accepts an `events` value other than one
 * to all distinct names of its catalogue, or when any 0078 branch has changed.
 */
export async function assertAuditEventListProtections(pool: pg.Pool): Promise<void> {
  await assertAuditDetailProtections(pool)
  for (const [actions, catalogue] of [
    [webhookAuditActions, webhookAuditEvents],
    [slackAuditActions, slackAuditEvents],
  ] as const) {
    const accepted: unknown[] = [
      undefined,
      [...catalogue],
      [...catalogue].sort(),
      [...catalogue].reverse(),
      ...catalogue.map((event) => [event]),
    ]
    const rejected = refusedEventLists(catalogue)
    for (const action of actions) {
      for (const events of accepted) {
        const details = events === undefined ? {} : { events }
        await expect(
          insert(pool, action, details),
          `${action} ${JSON.stringify(details)}`,
        ).resolves.toMatchObject({ rowCount: 1 })
      }
      for (const events of rejected)
        await expect(
          insert(pool, action, { events }),
          `${action} ${JSON.stringify({ events })}`,
        ).rejects.toMatchObject(refused)
    }
  }
  // The attendee no-show change is a signed-webhook event only: Slack never records it.
  for (const action of slackAuditActions)
    for (const events of [
      ['booking.attendee_no_show_changed'],
      ['booking.created', 'booking.attendee_no_show_changed'],
      [...webhookAuditEvents],
    ])
      await expect(
        insert(pool, action, { events }),
        `${action} ${JSON.stringify({ events })}`,
      ).rejects.toMatchObject(refused)
}
