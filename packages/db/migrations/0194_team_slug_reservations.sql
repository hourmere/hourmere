-- Fail the upgrade on case collisions and identify the affected rows by ID. Legacy
-- slug values may contain unrestricted text, so the error never writes them to logs.
-- Freeze concurrent writes between this check and installation of the unique index.
LOCK TABLE auth.organization IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(team_ids, '; ' ORDER BY team_ids) INTO collisions
  FROM (
    SELECT string_agg(id::text, ', ' ORDER BY id) AS team_ids
    FROM auth.organization
    GROUP BY lower(slug COLLATE pg_catalog.pg_unicode_fast)
    HAVING count(*) > 1
  ) AS conflicting_groups;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Case-insensitive organization slug collisions must be resolved before upgrading',
      DETAIL = 'Conflicting organization IDs by slug: ' || collisions;
  END IF;
END;
$$;

-- Keep existing spellings so that already published URLs keep working, and use the
-- same folded identity across locale settings.
CREATE UNIQUE INDEX organization_slug_lower_uidx
  ON auth.organization (lower(slug COLLATE pg_catalog.pg_unicode_fast));

CREATE TABLE public.team_slug_reservations (
  slug text PRIMARY KEY,
  organization_id uuid REFERENCES auth.organization (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL
);

CREATE FUNCTION public.reserve_team_slug() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_slug text := lower(NEW.slug COLLATE pg_catalog.pg_unicode_fast);
  old_slug text;
  new_lock bigint := hashtextextended('hourmere.team-slug:' || new_slug, 0);
  old_lock bigint;
BEGIN
  IF new_slug IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_slug := lower(OLD.slug COLLATE pg_catalog.pg_unicode_fast);
    IF old_slug = new_slug THEN
      RETURN NEW;
    END IF;
    old_lock := hashtextextended('hourmere.team-slug:' || old_slug, 0);
    -- Lock both slugs in a stable order so opposite renames cannot deadlock.
    PERFORM pg_advisory_xact_lock(least(old_lock, new_lock));
    PERFORM pg_advisory_xact_lock(greatest(old_lock, new_lock));
  ELSE
    PERFORM pg_advisory_xact_lock(new_lock);
  END IF;

  -- Probe the unique key so a repeatable-read writer cannot miss a hold created
  -- after its snapshot. PostgreSQL raises a serialization error on that conflict.
  INSERT INTO public.team_slug_reservations (slug, organization_id, expires_at)
    VALUES (new_slug, NULL, '-infinity')
  ON CONFLICT DO NOTHING;

  -- Consume the probe, an expired hold or a reclaim. Leave every other hold intact.
  DELETE FROM public.team_slug_reservations
  WHERE slug = new_slug AND (organization_id = NEW.id OR expires_at <= clock_timestamp());
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      CONSTRAINT = 'team_slug_reserved',
      MESSAGE = 'Organization slug is reserved by a previous owner';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO public.team_slug_reservations (slug, organization_id, expires_at)
    VALUES (old_slug, OLD.id, clock_timestamp() + interval '2160 hours');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER team_slug_reservation_guard
  BEFORE INSERT OR UPDATE OF slug ON auth.organization
  FOR EACH ROW EXECUTE FUNCTION public.reserve_team_slug();

-- Extend the previous audit allow-list while retaining all existing action branches.
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
    ELSE details = '{}'::jsonb
  END
) NOT VALID;
-- The runner applies each file in one transaction, so the ACCESS EXCLUSIVE lock taken above is
-- still held while existing rows are validated.
ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;
