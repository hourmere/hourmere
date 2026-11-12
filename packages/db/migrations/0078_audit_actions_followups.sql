-- Attendee no-show marks, SCIM provisioning tokens and Slack destinations join the audit
-- journal (docs/audit-log.md). The details check is replaced as a whole: every earlier branch
-- is unchanged. A no-show change admits exactly the attendee and the resulting state, never
-- a name, an email or free text; Slack destinations admit only the subscribed events, like
-- webhooks; SCIM token actions fall to the empty-details rule.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_details_check CHECK (
  jsonb_typeof(details) = 'object' AND
  CASE
    WHEN action = 'membership.role_changed' THEN details - ARRAY['oldRole','newRole'] = '{}'::jsonb
    WHEN action IN ('api_key.created','api_key.rotated') THEN details - 'scope' = '{}'::jsonb
    WHEN action IN ('webhook.created','webhook.updated','webhook.deleted','webhook.secret_rotated','webhook.paused','webhook.resumed') THEN details - 'events' = '{}'::jsonb
    WHEN action IN ('slack_destination.created','slack_destination.updated','slack_destination.deleted','slack_destination.paused','slack_destination.resumed','slack_destination.tested') THEN details - 'events' = '{}'::jsonb
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
);
