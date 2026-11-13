-- The webhook and Slack destination actions keep `events` as their only detail key, and the
-- database now checks its value the way the application validates subscriptions: an array of
-- distinct names from that destination's event catalogue (WEBHOOK_EVENTS, SLACK_EVENTS), at
-- least one and at most the catalogue size. A URL, a name or any other value is refused.
-- packages/webhooks/src/audit-event-catalogue.test.ts binds both lists and bounds to the code.
-- The details check is replaced as a whole: every other branch is unchanged from 0078.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_details_check CHECK (
  jsonb_typeof(details) = 'object' AND
  CASE
    WHEN action = 'membership.role_changed' THEN details - ARRAY['oldRole','newRole'] = '{}'::jsonb
    WHEN action IN ('api_key.created','api_key.rotated') THEN details - 'scope' = '{}'::jsonb
    -- Each catalogue name present adds one to the sum, so the sum equals the length only when
    -- every element is a catalogue string and none repeats.
    WHEN action IN ('webhook.created','webhook.updated','webhook.deleted','webhook.secret_rotated','webhook.paused','webhook.resumed') THEN details - 'events' = '{}'::jsonb
      AND (NOT details ? 'events' OR CASE WHEN jsonb_typeof(details->'events') = 'array' THEN
        jsonb_array_length(details->'events') BETWEEN 1 AND 6
        AND jsonb_array_length(details->'events') = (details->'events' ? 'booking.created')::int
          + (details->'events' ? 'booking.rescheduled')::int
          + (details->'events' ? 'booking.cancelled')::int
          + (details->'events' ? 'booking.reschedule_requested')::int
          + (details->'events' ? 'booking.reschedule_request_expired')::int
          + (details->'events' ? 'booking.attendee_no_show_changed')::int
        ELSE false END)
    -- Slack's catalogue leaves out the attendee no-show change.
    WHEN action IN ('slack_destination.created','slack_destination.updated','slack_destination.deleted','slack_destination.paused','slack_destination.resumed','slack_destination.tested') THEN details - 'events' = '{}'::jsonb
      AND (NOT details ? 'events' OR CASE WHEN jsonb_typeof(details->'events') = 'array' THEN
        jsonb_array_length(details->'events') BETWEEN 1 AND 5
        AND jsonb_array_length(details->'events') = (details->'events' ? 'booking.created')::int
          + (details->'events' ? 'booking.rescheduled')::int
          + (details->'events' ? 'booking.cancelled')::int
          + (details->'events' ? 'booking.reschedule_requested')::int
          + (details->'events' ? 'booking.reschedule_request_expired')::int
        ELSE false END)
    WHEN action = 'oauth.token_revoked' THEN details - 'familySize' = '{}'::jsonb
    -- Which branding settings changed and how; never the image or the colour itself.
    WHEN action = 'organization.branding_updated' THEN details - ARRAY['logo','primaryColor'] = '{}'::jsonb
      AND details <> '{}'::jsonb
      AND (NOT details ? 'logo' OR coalesce(details->>'logo' IN ('uploaded','selected','removed'), false))
      AND (NOT details ? 'primaryColor' OR coalesce(details->>'primaryColor' IN ('set','cleared'), false))
    -- Which attendee (a lowercase UUID) and whether the change marked or unmarked them.
    WHEN action = 'booking.attendee_no_show_changed' THEN details - ARRAY['attendeeId','noShow'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'attendeeId') = 'string'
        AND details->>'attendeeId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'noShow') = 'string'
        AND details->>'noShow' IN ('marked','unmarked'), false)
    ELSE details = '{}'::jsonb
  END
) NOT VALID;
-- The runner applies each file in one transaction, so the ACCESS EXCLUSIVE lock taken above is
-- still held while existing rows are validated (0080_audit_event_details.md).
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;
