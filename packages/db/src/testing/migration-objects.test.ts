import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrationsDir } from '../migrate.ts'

// Migrations that predate the constraint-coverage requirement (constraint-coverage.ts): every
// migration on main when this list was written, all numbered below 0071. It includes
// 0068-0070, which the earlier number-based guard exempted; 0067_audit_events left it when
// audit-events-coverage.test.ts covered it. The list is frozen: never add an entry, and remove
// one only in the change that gives its migration an expectation file and coverage test.
// Every other migration, whatever its number, ships both in the same change.
const legacyMigrations = new Set([
  '0001_auth',
  '0002_scheduling',
  '0003_schema_followups',
  '0004_api_keys_follow_email_proof',
  '0005_sessions_follow_email_proof',
  '0006_signup_policy',
  '0007_booking_notifications',
  '0008_calendar_oauth_states',
  '0009_calendar_sync',
  '0010_booking_cancellation_origin',
  '0011_calendar_oauth_provider',
  '0012_invited_signup',
  '0013_unlisted_event_types',
  '0014_queued_sign_in_email',
  '0015_guest_email_controls',
  '0016_mcp_oauth',
  '0017_booking_webhooks',
  '0018_booking_activity_indexes',
  '0019_required_booking_hosts',
  '0020_round_robin_assignment',
  '0021_automatic_google_meet',
  '0022_zoom_connections',
  '0023_multi_host_google_meet',
  '0024_conference_notification_retries',
  '0025_automatic_zoom',
  '0026_conference_notification_skips',
  '0027_nontransitive_invited_signup',
  '0028_webhook_interrupted_deliveries',
  '0029_host_reschedule_tokens',
  '0030_mcp_oauth_client_activity',
  '0031_discard_sign_in_id_tokens',
  '0032_booking_conferences_booking_id_index',
  '0033_conference_authorization_time',
  '0034_webhook_pending_delivery_index',
  '0035_conference_token_operations',
  '0036_google_meet_conference_patch',
  '0037_conference_pending_timeout',
  '0038_booking_ical_identity',
  '0039_calendar_busy_all_day_dates',
  '0040_notification_mail_limits',
  '0041_organization_operations',
  '0042_invitation_deliveries',
  '0043_invitation_mail_limits',
  '0044_invitation_delivery_attempt_time',
  '0045_invitation_generation_actor',
  '0046_current_inviter_signup',
  '0047_event_type_durations',
  '0048_api_key_scopes',
  '0049_configurable_booking_messages',
  '0050_booking_success_redirect',
  '0051_waitlist',
  '0052_follow_up_host_note',
  '0053_one_time_booking_links',
  '0056_event_type_locations',
  '0057_weekly_monthly_booking_limits',
  '0058_one_time_link_idempotency',
  '0059_group_seats',
  '0060_calcom_import_state',
  '0061_group_slot_resources',
  '0063_organization_branding',
  '0064_reschedule_requests',
  '0065_payment_holds',
  '0066_scim_provisioning_tokens',
  '0068_slack_destinations',
  '0069_sms_delivery_limits',
  '0070_attendee_no_show',
])

const expectationFiles = new Set(
  readdirSync(fileURLToPath(new URL('./migration-objects/', import.meta.url)))
    .filter((file) => file.endsWith('.json'))
    .map((file) => basename(file, '.json')),
)

describe('constraint coverage adoption', () => {
  const migrations = readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .map((file) => basename(file, '.sql'))
    .sort()

  it('has an expectation file for exactly the migrations not on the legacy list', () => {
    // Both sides are compared whole, so a migration cannot be left out of the requirement
    // while its expectation file still exists, nor its file removed while it is required.
    expect(
      [...expectationFiles].sort(),
      'add a constraint coverage test and its migration-objects file (CONTRIBUTING.md)',
    ).toEqual(migrations.filter((name) => !legacyMigrations.has(name)))
  })

  it('names expectation files and legacy entries after existing migrations', () => {
    const names = new Set(migrations)
    expect([...expectationFiles, ...legacyMigrations].filter((name) => !names.has(name))).toEqual(
      [],
    )
  })
})
