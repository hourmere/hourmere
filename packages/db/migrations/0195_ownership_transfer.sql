CREATE TABLE organization_ownership_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- Preserve the original binding when a participant leaves or deletes their account.
  -- A later operation must match these IDs to the current team memberships.
  initiator_user_id uuid NOT NULL,
  initiator_membership_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  target_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  terminal_at timestamptz,
  CONSTRAINT organization_ownership_transfers_participants CHECK (
    initiator_user_id <> target_user_id AND initiator_membership_id <> target_membership_id
  ),
  CONSTRAINT organization_ownership_transfers_deadline CHECK (
    isfinite(created_at) AND expires_at = created_at + interval '24 hours'
  ),
  CONSTRAINT organization_ownership_transfers_state CHECK (
    state IN ('pending', 'confirmed', 'revoked', 'expired', 'invalidated')
  ),
  CONSTRAINT organization_ownership_transfers_terminal_time CHECK (
    (state = 'pending') = (terminal_at IS NULL)
    AND (terminal_at IS NULL OR (isfinite(terminal_at) AND terminal_at >= created_at))
    AND (state NOT IN ('confirmed', 'revoked') OR terminal_at < expires_at)
    AND (state <> 'expired' OR terminal_at >= expires_at)
  )
);

CREATE UNIQUE INDEX organization_ownership_transfers_one_pending
  ON organization_ownership_transfers (organization_id) WHERE state = 'pending';

CREATE FUNCTION guard_organization_ownership_transfer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'ownership transfer must start pending'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_ownership_transfers_transition';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.expires_at := NEW.created_at + interval '24 hours';
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- The parent row is already gone when its foreign key cascades the delete.
    IF EXISTS (SELECT 1 FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'ownership transfer can only be deleted with its organization'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_ownership_transfers_delete_guard';
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(NEW.id, NEW.organization_id, NEW.initiator_user_id, NEW.initiator_membership_id,
         NEW.target_user_id, NEW.target_membership_id, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.initiator_user_id, OLD.initiator_membership_id,
         OLD.target_user_id, OLD.target_membership_id, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'ownership transfer binding is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_ownership_transfers_binding';
  END IF;

  IF OLD.state <> 'pending' OR NEW.state = 'pending' THEN
    RAISE EXCEPTION 'ownership transfer can only transition from pending to terminal'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_ownership_transfers_transition';
  END IF;

  -- The row is locked before this trigger runs. Transaction time can predate a lock wait.
  IF NEW.state IN ('confirmed', 'revoked') AND clock_timestamp() >= NEW.expires_at THEN
    RAISE EXCEPTION 'ownership transfer has expired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'organization_ownership_transfers_expired';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER organization_ownership_transfers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON organization_ownership_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_organization_ownership_transfer();

-- One durable counter per team and operation. A new aligned window replaces the old count.
CREATE TABLE organization_ownership_transfer_budgets (
  organization_id uuid REFERENCES auth.organization (id) ON DELETE CASCADE,
  operation text,
  window_start timestamptz NOT NULL CHECK (isfinite(window_start)),
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (organization_id, operation),
  CONSTRAINT organization_ownership_transfer_budgets_operation CHECK (operation IN ('initiate', 'revoke'))
);

-- Record only the target membership ID on an offer. Keep all previous detail rules.
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
    ELSE details = '{}'::jsonb
  END
) NOT VALID;
-- The runner applies each file in one transaction, so the ACCESS EXCLUSIVE lock taken above is
-- still held while existing rows are validated.
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;
