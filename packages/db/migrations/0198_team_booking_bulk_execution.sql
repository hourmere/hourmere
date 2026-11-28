ALTER TABLE public.team_booking_bulk_cancellations
  ADD COLUMN state text NOT NULL DEFAULT 'awaiting_confirmation',
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT team_booking_bulk_cancellations_state_check CHECK (
    CASE state
      WHEN 'awaiting_confirmation' THEN admitted_at IS NULL AND completed_at IS NULL
      WHEN 'queued' THEN admitted_at IS NOT NULL AND completed_at IS NULL
      WHEN 'running' THEN admitted_at IS NOT NULL AND completed_at IS NULL
      WHEN 'completed' THEN admitted_at IS NOT NULL AND completed_at IS NOT NULL
        AND completed_at >= admitted_at
      ELSE false
    END
    AND (admitted_at IS NULL OR (admitted_at >= created_at AND admitted_at < expires_at))
  );

CREATE UNIQUE INDEX team_booking_bulk_cancellations_active_team_idx
  ON public.team_booking_bulk_cancellations (organization_id)
  WHERE state IN ('queued', 'running');

CREATE INDEX team_booking_bulk_cancellations_admissions_idx
  ON public.team_booking_bulk_cancellations (organization_id, admitted_at)
  WHERE admitted_at IS NOT NULL;

CREATE INDEX team_booking_bulk_cancellations_preview_expiry_idx
  ON public.team_booking_bulk_cancellations (expires_at, id)
  WHERE state = 'awaiting_confirmation';

CREATE INDEX team_booking_bulk_cancellations_completed_retention_idx
  ON public.team_booking_bulk_cancellations (completed_at, id)
  WHERE state = 'completed';

ALTER TABLE public.team_booking_bulk_cancellation_items
  ADD COLUMN outcome text,
  ADD COLUMN attempt_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT team_booking_bulk_items_outcome_check CHECK (
    outcome IS NULL
    OR (preview_outcome <> 'eligible' AND outcome = preview_outcome)
    OR (preview_outcome = 'eligible' AND outcome IN (
      'pending', 'cancelled', 'already_cancelled', 'booking_started',
      'booking_not_supported', 'booking_unavailable', 'booking_host_departed',
      'authorization_lost', 'processing_failed'
    ))
  ),
  ADD CONSTRAINT team_booking_bulk_items_attempt_count_check CHECK (attempt_count BETWEEN 0 AND 3),
  ADD CONSTRAINT team_booking_bulk_items_due_check CHECK (
    (outcome IS NOT DISTINCT FROM 'pending') = (next_attempt_at IS NOT NULL)
  ),
  ADD CONSTRAINT team_booking_bulk_items_claim_check CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND outcome IS NOT DISTINCT FROM 'pending' AND attempt_count > 0)
  );

CREATE UNIQUE INDEX team_booking_bulk_items_active_claim_idx
  ON public.team_booking_bulk_cancellation_items (batch_id)
  WHERE claim_token IS NOT NULL;

CREATE TABLE public.team_booking_bulk_request_limits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('preview', 'status')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX team_booking_bulk_request_limits_team_idx
  ON public.team_booking_bulk_request_limits (organization_id, kind, created_at);

CREATE INDEX team_booking_bulk_request_limits_actor_idx
  ON public.team_booking_bulk_request_limits (organization_id, kind, actor_user_id, created_at);

CREATE INDEX team_booking_bulk_request_limits_cleanup_idx
  ON public.team_booking_bulk_request_limits (created_at, id);

CREATE FUNCTION public.team_booking_bulk_audit_counts_valid(counts jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
RETURN CASE WHEN jsonb_typeof(counts) = 'object' THEN
  counts ?& ARRAY[
    'pending', 'cancelled', 'already_cancelled', 'booking_started', 'booking_not_supported',
    'booking_unavailable', 'booking_host_departed', 'authorization_lost', 'processing_failed'
  ]
  AND counts - ARRAY[
    'pending', 'cancelled', 'already_cancelled', 'booking_started', 'booking_not_supported',
    'booking_unavailable', 'booking_host_departed', 'authorization_lost', 'processing_failed'
  ] = '{}'::jsonb
  AND counts->'pending' = '0'::jsonb
  AND (SELECT bool_and(n IS NOT NULL) AND sum(n) BETWEEN 1 AND 25
       FROM (
         SELECT CASE WHEN jsonb_typeof(value) = 'number'
           AND value #>> '{}' ~ '^(0|[1-9]|1[0-9]|2[0-5])$'
           THEN (value #>> '{}')::int END AS n
         FROM jsonb_each(counts)
       ) AS bounded)
ELSE false END;

-- Carry forward the journal rules from 0197 and add the bulk cancellation actions.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_details_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_details_check CHECK (
  jsonb_typeof(details) = 'object' AND
  CASE
    -- Record changed public addresses and whether the name changed, without storing names.
    WHEN action = 'organization.updated' THEN details - ARRAY['oldSlug','newSlug','nameChanged'] = '{}'::jsonb
      AND (NOT details ? 'nameChanged' OR details->'nameChanged' = 'true'::jsonb)
      AND (details ? 'oldSlug') = (details ? 'newSlug')
      AND (NOT details ? 'newSlug' OR (
        jsonb_typeof(details->'newSlug') = 'string'
        AND (details->>'newSlug') COLLATE "C" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'
        AND (details->'oldSlug' = 'null'::jsonb OR (
          jsonb_typeof(details->'oldSlug') = 'string'
          AND (details->>'oldSlug') COLLATE "C" ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$'
        ))
      ))
    WHEN action = 'membership.role_changed' THEN details - ARRAY['oldRole','newRole'] = '{}'::jsonb
    WHEN action IN ('api_key.created','api_key.rotated') THEN details - 'scope' = '{}'::jsonb
    -- Each catalogue name present adds one to the sum, so the sum equals the length only when
    -- every element is a catalogue string and none repeats.
    WHEN action IN ('webhook.created','webhook.updated','webhook.deleted','webhook.secret_rotated','webhook.paused','webhook.resumed') THEN details - 'events' = '{}'::jsonb
      AND (NOT details ? 'events' OR CASE WHEN jsonb_typeof(details->'events') = 'array' THEN
        jsonb_array_length(details->'events') BETWEEN 1 AND 7
        AND jsonb_array_length(details->'events') = (details->'events' ? 'booking.created')::int
          + (details->'events' ? 'booking.rescheduled')::int
          + (details->'events' ? 'booking.cancelled')::int
          + (details->'events' ? 'booking.reschedule_requested')::int
          + (details->'events' ? 'booking.reschedule_request_expired')::int
          + (details->'events' ? 'booking.attendee_no_show_changed')::int
          + (details->'events' ? 'workflow.executed')::int
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
    -- SSO provider changes and the operator's re-sealing: the protocol, the provider (a UUIDv7)
    -- and the configuration revision it now has; never an issuer, client ID, secret or certificate.
    WHEN action IN ('sso_provider.created','sso_provider.updated','sso_provider.enabled','sso_provider.disabled','sso_provider.deleted','sso_provider.secret_rotated','sso_provider.certificate_rotated','sso_maintenance.key_rotated') THEN details - ARRAY['method','providerId','revision'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
    -- An SSO provider test: the same, whether it passed, and a listed reason code and the test
    -- attempt (a UUIDv7) when known.
    WHEN action = 'sso_provider.tested' THEN details - ARRAY['method','providerId','revision','outcome','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'outcome') = 'string' AND details->>'outcome' IN ('passed','failed'), false)
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified'), false))
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- A domain renewal check: passed, failed or unknown; never the domain or a DNS answer.
    WHEN action = 'sso_domain.renewed' THEN details - 'outcome' = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'outcome') = 'string' AND details->>'outcome' IN ('passed','failed','unknown'), false)
    -- Links, sign-ins, replays, JIT admission, delegations and proofs: the protocol and the
    -- provider, and the revision and the attempt when known; never a subject, an email, a token
    -- or an assertion.
    WHEN action IN ('sso_link.linked','sso_link.unlinked','sso_link.conflicted','sso_authentication.succeeded','sso_authentication.replay_rejected','sso_jit.admitted','sso_delegation.bound','sso_proof.revoked') THEN details - ARRAY['method','providerId','revision','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- A key moving teams invalidates its old binding with a fixed reason code.
    WHEN action = 'sso_delegation.revoked' THEN details - ARRAY['method','providerId','revision','correlationId','reason'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('key_moved_team'), false))
    -- Failed SSO sign-ins can record a SCIM suspension, with the same redacted fields.
    WHEN action = 'sso_authentication.failed' THEN details - ARRAY['method','providerId','revision','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified','scim_suspended'), false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- JIT refusals keep their existing reason codes.
    WHEN action = 'sso_jit.refused' THEN details - ARRAY['method','providerId','revision','reason','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' IN ('attempt_invalid','attempt_expired','browser_mismatch','provider_error','provider_unreachable','token_exchange_failed','response_malformed','signature_invalid',
          'algorithm_refused','issuer_mismatch','audience_mismatch','destination_mismatch','nonce_mismatch','timing_invalid','subject_invalid','authentication_stale',
          'configuration_changed','provider_disabled','domain_unverified','mailbox_unproven','jit_disabled','unclassified'), false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- Enforcement policy changes, including the operator's recovery command: the policy revision.
    WHEN action IN ('sso_enforcement.enabled','sso_enforcement.disabled','sso_enforcement.updated','sso_maintenance.enforcement_disabled') THEN details - 'revision' = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
    -- A recovery use: the mailbox ceremony's attempt when known, never its capability.
    WHEN action = 'sso_recovery.used' THEN details - 'correlationId' = '{}'::jsonb
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- PUT keeps empty details. PATCH stores only its ordered, normalized operation names.
    WHEN action = 'scim_user.updated' THEN
      CASE WHEN jsonb_typeof(details->'operations') = 'array' THEN
        details - 'operations' = '{}'::jsonb
        AND jsonb_array_length(details->'operations') BETWEEN 1 AND 100
        AND (details->'operations') <@ '["add","replace","remove"]'::jsonb
      ELSE details = '{}'::jsonb END
    -- Legacy empty details stay valid. New rows carry only the workflow revision and trigger.
    WHEN action IN ('workflow.created','workflow.updated','workflow.enabled','workflow.disabled') THEN details = '{}'::jsonb OR (
      details - ARRAY['revision','trigger'] = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false))
    -- Tombstones identify the last definition revision.
    WHEN action = 'workflow.deleted' THEN details = '{}'::jsonb OR (
      details - 'revision' = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
    -- A preview records the candidate's trigger and a fixed reason code when a condition fails.
    WHEN action = 'workflow.previewed' THEN details = '{}'::jsonb OR (
      details - ARRAY['trigger','reason'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false)
      AND (NOT details ? 'reason' OR coalesce(jsonb_typeof(details->'reason') = 'string'
        AND details->>'reason' = 'condition_false', false)))
    -- Keep legacy empty details valid. Execution records carry only revision, trigger and fixed reasons.
    WHEN action IN ('workflow.run_scheduled','workflow.run_cancelled','workflow.run_skipped','workflow.email_attempted','workflow.email_sent','workflow.email_rejected','workflow.email_delivery_unknown','workflow.webhook_queued','workflow.webhook_completed','workflow.webhook_failed') THEN details = '{}'::jsonb OR (
      details - ARRAY['revision','trigger','reason'] = '{}'::jsonb
      AND CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END
      AND coalesce(jsonb_typeof(details->'trigger') = 'string'
        AND details->>'trigger' IN ('booking.created','booking.cancelled','booking.rescheduled','before_start','after_end'), false)
      AND CASE
        WHEN action = 'workflow.run_skipped' THEN coalesce(jsonb_typeof(details->'reason') = 'string'
          AND details->>'reason' IN ('condition_false','existing_notification','minimum_gap','offset_not_future',
            'expired','budget_suppressed','render_limit','workflow_disabled','instance_disabled'), false)
        WHEN action = 'workflow.webhook_failed' THEN NOT details ? 'reason' OR coalesce(
          jsonb_typeof(details->'reason') = 'string' AND details->>'reason' = 'expired', false)
        ELSE NOT details ? 'reason'
      END)
    WHEN action = 'organization.ownership_transfer_offered' THEN details - 'targetMembershipId' = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'targetMembershipId') = 'string'
        AND details->>'targetMembershipId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    -- Custom-role changes use the journal's actor, target and time columns. Keep session
    -- identifiers out of these rows and allow only fixed, typed detail values.
    WHEN action IN ('custom_role.created','custom_role.revised','custom_role.archived','membership.custom_role_assigned','membership.custom_role_cleared','team.custom_roles_enabled','team.custom_roles_disabled') THEN coalesce(
      organization_id IS NOT NULL
      AND credential_id IS NULL
      AND (
        (actor_type = 'user' AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND credential_type = 'session')
        OR (action = 'membership.custom_role_cleared' AND credential_type = 'none' AND (
          (actor_type IN ('user', 'scim_token') AND actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          OR (actor_type = 'system' AND actor_id = 'system')
        ))
      )
      AND CASE
        WHEN action LIKE 'custom_role.%' THEN target_type = 'custom_role' AND target_id = details->>'roleId'
        WHEN action LIKE 'membership.%' THEN target_type = 'membership' AND target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ELSE target_type = 'organization' AND target_id = organization_id::text
      END
      AND details->'outcome' = '"succeeded"'::jsonb
      AND jsonb_typeof(details->'masterEpoch') = 'number'
      AND details->>'masterEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
      AND details->'masterEpoch' <= '2147483647'::jsonb
      AND (NOT details ? 'roleId' OR (
        jsonb_typeof(details->'roleId') = 'string'
        AND details->>'roleId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      AND (NOT details ? 'oldRoleId' OR (
        jsonb_typeof(details->'oldRoleId') = 'string'
        AND details->>'oldRoleId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      AND (NOT details ? 'oldRevision' OR (
        jsonb_typeof(details->'oldRevision') = 'number'
        AND details->>'oldRevision' ~ '^[1-9][0-9]{0,9}$'
        AND details->'oldRevision' <= '2147483647'::jsonb))
      AND (NOT details ? 'newRevision' OR (
        jsonb_typeof(details->'newRevision') = 'number'
        AND details->>'newRevision' ~ '^[1-9][0-9]{0,9}$'
        AND details->'newRevision' <= '2147483647'::jsonb))
      AND (NOT details ? 'policyEpoch' OR (
        jsonb_typeof(details->'policyEpoch') = 'number'
        AND details->>'policyEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
        AND details->'policyEpoch' <= '2147483647'::jsonb))
      AND (NOT details ? 'personalDataPermissionIds' OR CASE
        WHEN jsonb_typeof(details->'personalDataPermissionIds') = 'array' THEN
          jsonb_array_length(details->'personalDataPermissionIds') BETWEEN 1 AND 4
          AND jsonb_array_length(details->'personalDataPermissionIds') =
            (details->'personalDataPermissionIds' ? 'event_types.generate_open_time_snippet')::int
            + (details->'personalDataPermissionIds' ? 'team_bookings.read')::int
            + (details->'personalDataPermissionIds' ? 'waitlists.read_settings')::int
            + (details->'personalDataPermissionIds' ? 'waitlists.update_settings')::int
        ELSE false END)
      AND CASE action
        WHEN 'custom_role.created' THEN
          details - ARRAY['roleId','newRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','newRevision','policyEpoch']
        WHEN 'custom_role.revised' THEN
          details - ARRAY['roleId','oldRevision','newRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','newRevision','policyEpoch']
          AND details->'newRevision' > details->'oldRevision'
        WHEN 'custom_role.archived' THEN
          details - ARRAY['roleId','oldRevision','policyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','policyEpoch']
        WHEN 'membership.custom_role_assigned' THEN
          details - ARRAY['roleId','oldRoleId','oldRevision','newRevision','policyEpoch','masterEpoch','outcome','personalDataPermissionIds'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','newRevision','policyEpoch']
          AND (details ? 'oldRoleId') = (details ? 'oldRevision')
        WHEN 'membership.custom_role_cleared' THEN
          details - ARRAY['roleId','oldRevision','policyEpoch','masterEpoch','outcome','personalDataPermissionIds'] = '{}'::jsonb
          AND details ?& ARRAY['roleId','oldRevision','policyEpoch']
        ELSE details - ARRAY['oldPolicyEpoch','newPolicyEpoch','masterEpoch','outcome'] = '{}'::jsonb
          AND jsonb_typeof(details->'oldPolicyEpoch') = 'number'
          AND jsonb_typeof(details->'newPolicyEpoch') = 'number'
          AND details->>'oldPolicyEpoch' ~ '^(0|[1-9][0-9]{0,9})$'
          AND details->>'newPolicyEpoch' ~ '^[1-9][0-9]{0,9}$'
          AND details->'newPolicyEpoch' <= '2147483647'::jsonb
          AND details->'newPolicyEpoch' > details->'oldPolicyEpoch'
      END, false)
    WHEN action = 'booking.bulk_cancellation_admitted' THEN
      details - 'selectedCount' = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'selectedCount') = 'number'
        AND details->>'selectedCount' ~ '^([1-9]|1[0-9]|2[0-5])$', false)
    WHEN action = 'booking.bulk_cancellation_completed' THEN
      details - 'counts' = '{}'::jsonb
      AND coalesce(public.team_booking_bulk_audit_counts_valid(details->'counts'), false)
    ELSE details = '{}'::jsonb
  END
) NOT VALID;
-- The runner applies each file in one transaction, so the ACCESS EXCLUSIVE lock taken above is
-- still held while existing rows are validated.
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;
