// Migration 0078 replaces audit_events_details_check. These checks pass on the migration as
// written and fail when the constraint is dropped (audit-actions-followups-coverage.test.ts)
// or when the upgrade loses a branch (audit-actions-followups-migration.test.ts).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

const insert = (pool: pg.Pool, action: string, details: unknown) =>
  pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('system', 'coverage', 'none', $1, 'coverage', $2, $3::jsonb)`,
    [action, randomUUID(), JSON.stringify(details)],
  )
const refused = { code: '23514', constraint: 'audit_events_details_check' }

/** Throws when audit details accept anything beyond each action's allow-list. */
export async function assertAuditDetailProtections(pool: pg.Pool): Promise<void> {
  const attendeeId = randomUUID()
  const accepted: [string, unknown][] = [
    ['booking.attendee_no_show_changed', { attendeeId, noShow: 'marked' }],
    ['booking.attendee_no_show_changed', { attendeeId, noShow: 'unmarked' }],
    ['membership.role_changed', { oldRole: 'member', newRole: 'admin' }],
    ['api_key.created', { scope: 'read' }],
    ['webhook.updated', { events: ['booking.created'] }],
    ['oauth.token_revoked', { familySize: 2 }],
    ['organization.branding_updated', { logo: 'uploaded', primaryColor: 'set' }],
    ['booking.created', {}],
    ['slack_destination.created', { events: ['booking.created'] }],
    ['slack_destination.paused', { events: ['booking.cancelled'] }],
    ['slack_destination.tested', {}],
    ['scim_token.rotated', {}],
  ]
  for (const [action, details] of accepted)
    await expect(insert(pool, action, details), action).resolves.toMatchObject({ rowCount: 1 })
  const rejected: [string, unknown][] = [
    ['booking.attendee_no_show_changed', { attendeeId, noShow: 'marked', name: 'Invitee' }],
    ['booking.attendee_no_show_changed', { attendeeId, noShow: true }],
    ['booking.attendee_no_show_changed', { attendeeId: 'invitee@example.com', noShow: 'marked' }],
    ['booking.attendee_no_show_changed', { noShow: 'marked' }],
    ['booking.attendee_no_show_changed', { attendeeId }],
    ['booking.attendee_no_show_changed', []],
    ['membership.role_changed', { oldRole: 'member', email: 'member@example.com' }],
    ['api_key.created', { scope: 'read', key: 'hm_secret' }],
    ['webhook.updated', { events: [], url: 'https://hooks.example.com/private' }],
    ['oauth.token_revoked', { familySize: 2, token: 'secret' }],
    ['organization.branding_updated', {}],
    ['organization.branding_updated', { primaryColor: '#12AB34' }],
    ['booking.created', { attendeeId, noShow: 'marked' }],
    ['slack_destination.updated', { events: [], url: 'https://hooks.slack.com/services/T/B/x' }],
    ['slack_destination.paused', { reason: 'url_rejected' }],
    ['scim_token.created', { name: 'IdP' }],
    ['scim_token.revoked', { events: [] }],
  ]
  for (const [action, details] of rejected)
    await expect(
      insert(pool, action, details),
      `${action} ${JSON.stringify(details)}`,
    ).rejects.toMatchObject(refused)
}
