-- SSO audit actions join the details check (docs/audit-log.md, "SSO actions"). No version
-- writes them yet; the later SSO steps record them through packages/db/src/audit.ts. The check
-- is replaced as a whole and every earlier branch is unchanged from 0078. An SSO action admits
-- only its allow-listed keys, each with a safe value: the protocol, a provider or attempt ID (a
-- UUIDv7, which no secret, token, assertion, IdP subject or mailbox capability is), a positive
-- integer revision and an outcome or reason code from a closed list. The other SSO actions fall
-- to the empty-details rule. packages/db/src/sso-audit-binding.test.ts binds the lists to the code.
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
    WHEN action IN ('sso_link.linked','sso_link.unlinked','sso_link.conflicted','sso_authentication.succeeded','sso_authentication.replay_rejected','sso_jit.admitted','sso_delegation.bound','sso_delegation.revoked','sso_proof.revoked') THEN details - ARRAY['method','providerId','revision','correlationId'] = '{}'::jsonb
      AND coalesce(jsonb_typeof(details->'method') = 'string' AND details->>'method' IN ('oidc','saml'), false)
      AND coalesce(jsonb_typeof(details->'providerId') = 'string'
        AND details->>'providerId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
      AND (NOT details ? 'revision' OR CASE WHEN jsonb_typeof(details->'revision') = 'number' AND details->>'revision' ~ '^[1-9][0-9]{0,9}$'
        THEN (details->>'revision')::bigint <= 2147483647 ELSE false END)
      AND (NOT details ? 'correlationId' OR coalesce(jsonb_typeof(details->'correlationId') = 'string'
        AND details->>'correlationId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false))
    -- Failed SSO sign-ins and JIT refusals: the same with a listed reason code, never the
    -- provider's error text.
    WHEN action IN ('sso_authentication.failed','sso_jit.refused') THEN details - ARRAY['method','providerId','revision','reason','correlationId'] = '{}'::jsonb
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
    ELSE details = '{}'::jsonb
  END
);
