-- SSO identity storage only (docs/sso.md, Identity storage). No route, worker, read path or
-- setting uses these tables yet, and OIDC and SAML stay hard-off. Admission tombstones are the
-- shared scim_membership_blocks table of migration 0073; nothing is added for them here.

-- Identity links. An identity is (organization, provider, validated issuer or IdP entity ID,
-- immutable subject). The provider fixes the organization and the issuer (both immutable
-- since 0074) and a link must repeat the provider's issuer, so one live link per provider and
-- subject keeps the whole tuple unique; the index leaves the long issuer out of its key. A
-- person has at most one live link per provider. A link keeps the mailbox Hourmere last
-- proved for it; an IdP's email statement is never stored as proof. A link is retired, not
-- deleted, while its team and its account exist; retirement is permanent and comes with a new
-- generation, which browser proofs and delegation bindings record.
CREATE TABLE sso_identity_links (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL
    CONSTRAINT sso_identity_links_subject CHECK (octet_length(subject) BETWEEN 1 AND 1024),
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1
    CONSTRAINT sso_identity_links_generation CHECK (generation > 0),
  proven_email text NOT NULL CONSTRAINT sso_identity_links_proven_email CHECK (
    proven_email = lower(btrim(proven_email)) AND char_length(proven_email) BETWEEN 3 AND 320
    AND strpos(proven_email, '@') > 1
  ),
  email_proven_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT sso_identity_links_owner UNIQUE (organization_id, provider_id, user_id, id),
  CONSTRAINT sso_identity_links_provider FOREIGN KEY (organization_id, provider_id)
    REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX sso_identity_links_live_identity ON sso_identity_links (provider_id, subject)
  WHERE retired_at IS NULL;
CREATE UNIQUE INDEX sso_identity_links_live_user ON sso_identity_links (provider_id, user_id)
  WHERE retired_at IS NULL;
CREATE INDEX sso_identity_links_user_id ON sso_identity_links (user_id);

CREATE FUNCTION guard_sso_identity_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)
       AND EXISTS (SELECT FROM auth."user" WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'an SSO identity link is retired, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT FROM public.sso_providers WHERE id = NEW.provider_id AND retired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a retired SSO provider gets no new identity links'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_live_provider';
    END IF;
    IF EXISTS (SELECT FROM public.sso_providers WHERE id = NEW.provider_id AND issuer <> NEW.issuer) THEN
      RAISE EXCEPTION 'an SSO identity link names its provider''s issuer'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_issuer';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a retired SSO identity link is permanent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_retired_permanent';
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.provider_id, NEW.issuer, NEW.subject, NEW.user_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.provider_id, OLD.issuer, OLD.subject, OLD.user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SSO identity link identity is immutable; link the new subject instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_identity_immutable';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'SSO identity link generations never decrease'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_generation_monotonic';
  END IF;
  -- Retiring a link ends the proofs and delegation bindings that recorded its generation.
  IF NEW.retired_at IS NOT NULL AND NEW.generation = OLD.generation THEN
    RAISE EXCEPTION 'retiring an SSO identity link needs a new link generation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_retirement_generation';
  END IF;
  IF NEW.email_proven_at < OLD.email_proven_at
     OR (NEW.proven_email <> OLD.proven_email AND NEW.email_proven_at <= OLD.email_proven_at) THEN
    RAISE EXCEPTION 'a newly proven SSO link mailbox needs a later proof time'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_identity_links_email_proof';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_identity_links_guard BEFORE INSERT OR UPDATE OR DELETE ON sso_identity_links
  FOR EACH ROW EXECUTE FUNCTION guard_sso_identity_link();

-- Pending attempts. Each kind freezes what it was created for: a sign-in to one provider
-- revision from one browser; a provider test or self-link by a signed-in person and session at
-- one provider revision; or a fresh proof for one operation and canonical input digest
-- (excluding proofAttemptId) by a signed-in person and session in one team. An attempt lives at
-- most authenticationAttemptLifetime (600 seconds). Its required proof methods only grow by
-- the mailbox (a sign-in or link that must prove a mailbox, or a step-up that cannot prove
-- freshness); its mailbox is fixed once chosen; each proof is recorded once and lasts at most
-- freshAdministrationProof (300 seconds). Nothing changes after expiry, and an attempt is
-- consumed once, only with every required proof live. Deleting an attempt only ends it.
CREATE TABLE sso_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL
    CONSTRAINT sso_attempts_kind CHECK (kind IN ('sign_in', 'test', 'link', 'fresh_proof')),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  provider_id uuid,
  provider_revision integer,
  -- The person is the session's (checked on insert); the session's deletion ends the attempt.
  user_id uuid,
  session_id uuid REFERENCES auth.session (id) ON DELETE CASCADE,
  browser_binding_digest text NOT NULL,
  operation text NOT NULL
    CONSTRAINT sso_attempts_operation CHECK (operation ~ '^[a-z][A-Za-z0-9_]{0,63}$'),
  input_digest text NOT NULL,
  requires_mailbox boolean NOT NULL DEFAULT false,
  requires_sso boolean NOT NULL DEFAULT false,
  mailbox text CONSTRAINT sso_attempts_mailbox CHECK (
    mailbox = lower(btrim(mailbox)) AND char_length(mailbox) BETWEEN 3 AND 320
    AND strpos(mailbox, '@') > 1
  ),
  mailbox_proven_at timestamptz,
  mailbox_proof_expires_at timestamptz,
  step_up_provider_id uuid,
  step_up_link_id uuid,
  step_up_authenticated_at timestamptz,
  step_up_proof_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT sso_attempts_organization_id_id UNIQUE (organization_id, id),
  CONSTRAINT sso_attempts_provider FOREIGN KEY (organization_id, provider_id)
    REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE,
  -- The step-up came through the attempt's own person's link in the attempt's team.
  CONSTRAINT sso_attempts_step_up_link
    FOREIGN KEY (organization_id, step_up_provider_id, user_id, step_up_link_id)
    REFERENCES sso_identity_links (organization_id, provider_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_attempts_kind_shape CHECK (
    (provider_id IS NULL) = (kind = 'fresh_proof')
    AND (provider_revision IS NULL) = (provider_id IS NULL)
    AND (user_id IS NULL) = (kind = 'sign_in')
    AND (session_id IS NULL) = (kind = 'sign_in')
  ),
  CONSTRAINT sso_attempts_digests CHECK (
    browser_binding_digest ~ '^[0-9a-f]{64}$' AND input_digest ~ '^[0-9a-f]{64}$'
  ),
  -- Only a fresh proof can require an SSO step-up, and a fresh proof requires a method.
  CONSTRAINT sso_attempts_methods CHECK (
    (NOT requires_sso OR kind = 'fresh_proof')
    AND (kind <> 'fresh_proof' OR requires_mailbox OR requires_sso)
  ),
  CONSTRAINT sso_attempts_mailbox_required CHECK (NOT requires_mailbox OR mailbox IS NOT NULL),
  CONSTRAINT sso_attempts_mailbox_proof CHECK (
    (mailbox_proven_at IS NULL) = (mailbox_proof_expires_at IS NULL)
    AND (mailbox_proven_at IS NULL OR (
      requires_mailbox
      AND mailbox_proof_expires_at > mailbox_proven_at
      AND mailbox_proof_expires_at <= expires_at
      AND mailbox_proof_expires_at <= mailbox_proven_at + interval '300 seconds'
    ))
  ),
  CONSTRAINT sso_attempts_step_up CHECK (
    num_nulls(step_up_provider_id, step_up_link_id, step_up_authenticated_at, step_up_proof_expires_at) IN (0, 4)
    AND (step_up_link_id IS NULL OR (
      requires_sso
      AND step_up_authenticated_at >= created_at - interval '60 seconds'
      AND step_up_proof_expires_at > step_up_authenticated_at
      AND step_up_proof_expires_at <= expires_at
      AND step_up_proof_expires_at <= step_up_authenticated_at + interval '300 seconds'
    ))
  ),
  CONSTRAINT sso_attempts_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '600 seconds'
  )
);
CREATE INDEX sso_attempts_session_id ON sso_attempts (session_id);
CREATE INDEX sso_attempts_step_up_link_id ON sso_attempts (step_up_link_id);

CREATE FUNCTION guard_sso_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sso_team_organization(NEW.organization_id);
    IF NEW.created_at > clock_timestamp() OR NEW.expires_at <= clock_timestamp()
       OR num_nonnulls(NEW.mailbox_proven_at, NEW.mailbox_proof_expires_at, NEW.step_up_provider_id,
            NEW.step_up_link_id, NEW.step_up_authenticated_at, NEW.step_up_proof_expires_at,
            NEW.consumed_at) > 0 THEN
      RAISE EXCEPTION 'an SSO attempt starts unexpired, unproven and unconsumed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_starts_open';
    END IF;
    IF EXISTS (
      SELECT FROM public.sso_providers WHERE id = NEW.provider_id
        AND (retired_at IS NOT NULL OR (NEW.kind IN ('sign_in', 'link') AND NOT enabled))
    ) THEN
      RAISE EXCEPTION 'an SSO attempt needs a live provider, enabled unless it tests a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_live_provider';
    END IF;
    IF EXISTS (SELECT FROM public.sso_providers WHERE id = NEW.provider_id AND revision <> NEW.provider_revision) THEN
      RAISE EXCEPTION 'an SSO attempt is bound to its provider''s current revision'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_current_revision';
    END IF;
    IF EXISTS (
      SELECT FROM auth.session WHERE id = NEW.session_id
        AND ("userId" <> NEW.user_id OR "expiresAt" <= clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'an SSO attempt''s session is its person''s current session'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_session';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a consumed SSO attempt is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_consumed_final';
  END IF;
  IF OLD.expires_at <= clock_timestamp() AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'an expired SSO attempt cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_unexpired';
  END IF;
  IF ROW(NEW.id, NEW.kind, NEW.organization_id, NEW.provider_id, NEW.provider_revision, NEW.user_id,
         NEW.session_id, NEW.browser_binding_digest, NEW.operation, NEW.input_digest, NEW.created_at,
         NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.kind, OLD.organization_id, OLD.provider_id, OLD.provider_revision,
         OLD.user_id, OLD.session_id, OLD.browser_binding_digest, OLD.operation, OLD.input_digest,
         OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'what an SSO attempt was created for is frozen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_frozen';
  END IF;
  IF NEW.requires_sso IS DISTINCT FROM OLD.requires_sso OR (OLD.requires_mailbox AND NOT NEW.requires_mailbox) THEN
    RAISE EXCEPTION 'an SSO attempt only adds the mailbox to its required proofs'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_methods_added';
  END IF;
  IF OLD.mailbox IS NOT NULL AND NEW.mailbox IS DISTINCT FROM OLD.mailbox THEN
    RAISE EXCEPTION 'an SSO attempt''s mailbox is fixed once chosen'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_mailbox_fixed';
  END IF;
  IF (OLD.mailbox_proven_at IS NOT NULL
      AND ROW(NEW.mailbox_proven_at, NEW.mailbox_proof_expires_at)
          IS DISTINCT FROM ROW(OLD.mailbox_proven_at, OLD.mailbox_proof_expires_at))
     OR (OLD.step_up_link_id IS NOT NULL
      AND ROW(NEW.step_up_provider_id, NEW.step_up_link_id, NEW.step_up_authenticated_at, NEW.step_up_proof_expires_at)
          IS DISTINCT FROM ROW(OLD.step_up_provider_id, OLD.step_up_link_id, OLD.step_up_authenticated_at, OLD.step_up_proof_expires_at)) THEN
    RAISE EXCEPTION 'an SSO attempt records each proof once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_proof_once';
  END IF;
  IF NEW.mailbox_proven_at IS NOT NULL AND OLD.mailbox_proven_at IS NULL AND NOT EXISTS (
    SELECT FROM public.sso_mailbox_tokens
    WHERE attempt_id = NEW.id AND consumed_at IS NOT NULL AND expires_at = NEW.mailbox_proof_expires_at
  ) THEN
    RAISE EXCEPTION 'a mailbox proof consumes the attempt''s mailbox token and ends with it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_mailbox_token';
  END IF;
  IF NEW.step_up_link_id IS NOT NULL AND OLD.step_up_link_id IS NULL AND (
    NEW.step_up_authenticated_at > clock_timestamp() + interval '60 seconds'
    OR EXISTS (
      SELECT FROM public.sso_identity_links l JOIN public.sso_providers p ON p.id = l.provider_id
      WHERE l.id = NEW.step_up_link_id
        AND (l.retired_at IS NOT NULL OR NOT p.enabled)
    )
  ) THEN
    RAISE EXCEPTION 'an SSO step-up comes from a live link at an enabled provider, not from the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_step_up_proof';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL AND (
    (NEW.requires_mailbox AND (NEW.mailbox_proof_expires_at IS NULL OR NEW.mailbox_proof_expires_at <= clock_timestamp()))
    OR (NEW.requires_sso AND (NEW.step_up_proof_expires_at IS NULL OR NEW.step_up_proof_expires_at <= clock_timestamp()))
  ) THEN
    RAISE EXCEPTION 'an SSO attempt is consumed only with every required proof live'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_attempts_proven';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_attempts_guard BEFORE INSERT OR UPDATE ON sso_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_sso_attempt();

-- Mailbox proof tokens: only a SHA-256 digest of the emailed one-use token is stored. An
-- attempt has at most one token, issued while it awaits its mailbox proof and valid until the
-- earlier of the attempt's expiry and issuance plus freshAdministrationProof (300 seconds).
-- Resending deletes the token and issues a new one. A token is consumed once, before it
-- expires, and is otherwise immutable.
CREATE TABLE sso_mailbox_tokens (
  token_digest text PRIMARY KEY
    CONSTRAINT sso_mailbox_tokens_digest CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT sso_mailbox_tokens_one_per_attempt UNIQUE (attempt_id),
  CONSTRAINT sso_mailbox_tokens_attempt FOREIGN KEY (organization_id, attempt_id)
    REFERENCES sso_attempts (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_mailbox_tokens_lifetime CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '300 seconds'
  )
);

CREATE FUNCTION guard_sso_mailbox_token() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.issued_at > clock_timestamp() OR NEW.expires_at <= clock_timestamp() OR NEW.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a mailbox token starts unexpired and unconsumed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_mailbox_tokens_starts_live';
    END IF;
    IF EXISTS (
      SELECT FROM public.sso_attempts WHERE id = NEW.attempt_id
        AND (NOT requires_mailbox OR mailbox_proven_at IS NOT NULL OR consumed_at IS NOT NULL
             OR expires_at <= clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'a mailbox token is issued only for an open attempt awaiting its mailbox proof'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_mailbox_tokens_awaiting_proof';
    END IF;
    IF EXISTS (SELECT FROM public.sso_attempts WHERE id = NEW.attempt_id AND expires_at < NEW.expires_at) THEN
      RAISE EXCEPTION 'a mailbox token ends no later than its attempt'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_mailbox_tokens_within_attempt';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.token_digest, NEW.organization_id, NEW.attempt_id, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.token_digest, OLD.organization_id, OLD.attempt_id, OLD.issued_at, OLD.expires_at)
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
    RAISE EXCEPTION 'a mailbox token is immutable and consumed once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_mailbox_tokens_immutable';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL AND OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'an expired mailbox token cannot be consumed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_mailbox_tokens_unexpired';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_mailbox_tokens_guard BEFORE INSERT OR UPDATE ON sso_mailbox_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_sso_mailbox_token();

-- The shared replay cache: a SAML request, response or assertion ID is consumed once per
-- provider (only its SHA-256 digest is stored), by whichever of any number of concurrent
-- callbacks inserts it first. An entry is immutable and kept until retain_until, which the
-- service sets to at least max(acceptanceDeadline + clockSkew, requestExpiresAt); only the
-- team's deletion removes it earlier.
CREATE TABLE sso_replay_cache (
  organization_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  kind text NOT NULL
    CONSTRAINT sso_replay_cache_kind CHECK (kind IN ('saml_request', 'saml_response', 'saml_assertion')),
  key_digest text NOT NULL
    CONSTRAINT sso_replay_cache_key_digest CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (provider_id, kind, key_digest),
  CONSTRAINT sso_replay_cache_provider FOREIGN KEY (organization_id, provider_id)
    REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_replay_cache_retention CHECK (retain_until > consumed_at)
);

CREATE FUNCTION guard_sso_replay_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SSO replay cache entries are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_replay_cache_immutable';
  END IF;
  IF OLD.retain_until > clock_timestamp()
     AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
    RAISE EXCEPTION 'an SSO replay cache entry is kept until its retention ends'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_replay_cache_retained';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER sso_replay_cache_guard BEFORE UPDATE OR DELETE ON sso_replay_cache
  FOR EACH ROW EXECUTE FUNCTION guard_sso_replay_entry();

-- Browser proofs and delegation bindings record what they relied on: the member, the enabled
-- provider (a retired provider is never enabled), its identity link and that link's generation, the team's trust generation (1 until the team
-- has a policy) and the domain claim with its generation. Each must be current when the row is
-- written, so no row names a generation that does not exist yet; every use compares them with
-- the current values, so a lapsed claim generation, which can never be verified again, never
-- revives a proof or lease. Both are immutable; revoking one deletes it.
CREATE FUNCTION guard_sso_reliance() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SSO browser proofs and delegation bindings are immutable; revoking one deletes it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_immutable';
  END IF;
  IF NEW.created_at > clock_timestamp() OR NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'an SSO proof or delegation starts now and has not expired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_live';
  END IF;
  IF EXISTS (
    SELECT FROM auth.member WHERE id = NEW.member_id
      AND ("organizationId" <> NEW.organization_id OR "userId" <> NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'an SSO proof or delegation belongs to its person''s membership of the team'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_member';
  END IF;
  IF EXISTS (
    SELECT FROM public.sso_providers WHERE id = NEW.provider_id AND NOT enabled
  ) THEN
    RAISE EXCEPTION 'an SSO proof or delegation relies on an enabled provider'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_provider';
  END IF;
  IF EXISTS (
    SELECT FROM public.sso_identity_links WHERE id = NEW.link_id
      AND (retired_at IS NOT NULL OR generation <> NEW.link_generation)
  ) THEN
    RAISE EXCEPTION 'an SSO proof or delegation relies on the current generation of a live link'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_link';
  END IF;
  IF NEW.trust_generation <> coalesce(
    (SELECT trust_generation FROM public.sso_policies WHERE organization_id = NEW.organization_id), 1
  ) THEN
    RAISE EXCEPTION 'an SSO proof or delegation records the team''s current trust generation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_trust_generation';
  END IF;
  IF EXISTS (
    SELECT FROM public.sso_domains d WHERE d.id = NEW.domain_id AND d.organization_id = NEW.organization_id
      AND (d.retired_at IS NOT NULL OR d.verified_at IS NULL OR d.verification_expires_at <= clock_timestamp()
           OR d.generation <> NEW.domain_generation
           OR NOT EXISTS (
             SELECT FROM public.sso_provider_domains
             WHERE provider_id = NEW.provider_id AND domain_id = NEW.domain_id
           ))
  ) THEN
    RAISE EXCEPTION 'an SSO proof or delegation relies on the current, unexpired generation of a claim its provider serves'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_reliance_domain';
  END IF;
  RETURN NEW;
END $$;

-- Browser proofs: one session's proof through one link, ended by logout (the session's
-- deletion), the member's removal or the link's retirement, and lasting at most
-- ssoProofLifetime (28800 seconds), the session's expiry and the claim's verification expiry.
CREATE TABLE sso_browser_proofs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth.session (id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  link_id uuid NOT NULL,
  link_generation integer NOT NULL,
  trust_generation integer NOT NULL,
  domain_id uuid NOT NULL,
  domain_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sso_browser_proofs_link FOREIGN KEY (organization_id, provider_id, user_id, link_id)
    REFERENCES sso_identity_links (organization_id, provider_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_browser_proofs_domain FOREIGN KEY (organization_id, domain_id)
    REFERENCES sso_domains (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_browser_proofs_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '28800 seconds'
  )
);
CREATE INDEX sso_browser_proofs_session_id ON sso_browser_proofs (session_id);
CREATE INDEX sso_browser_proofs_member_id ON sso_browser_proofs (member_id);
CREATE INDEX sso_browser_proofs_link_id ON sso_browser_proofs (link_id);
CREATE INDEX sso_browser_proofs_domain_id ON sso_browser_proofs (domain_id);
CREATE TRIGGER sso_browser_proofs_reliance BEFORE INSERT OR UPDATE ON sso_browser_proofs
  FOR EACH ROW EXECUTE FUNCTION guard_sso_reliance();

CREATE FUNCTION guard_sso_browser_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT FROM auth.session WHERE id = NEW.session_id
      AND ("userId" <> NEW.user_id OR "expiresAt" < NEW.expires_at)
  ) THEN
    RAISE EXCEPTION 'a browser proof belongs to its person''s session and ends with it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_browser_proofs_session';
  END IF;
  IF EXISTS (SELECT FROM public.sso_domains WHERE id = NEW.domain_id AND verification_expires_at < NEW.expires_at) THEN
    RAISE EXCEPTION 'a browser proof ends no later than the domain verification it relied on'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_browser_proofs_domain_deadline';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_browser_proofs_guard BEFORE INSERT ON sso_browser_proofs
  FOR EACH ROW EXECUTE FUNCTION guard_sso_browser_proof();

-- Delegation bindings: one person's own same-team API key or MCP OAuth grant, bound through
-- one link and lasting at most ssoDelegationLifetime (2592000 seconds) and the key's own
-- expiry. Renewing the claim keeps the lease; a lapse ends it for good and needs a new
-- binding. Deleting the credential, the membership or the link deletes the binding.
CREATE TABLE sso_delegation_bindings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES auth.apikey (id) ON DELETE CASCADE,
  oauth_grant_id uuid REFERENCES mcp_oauth_grants (id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  link_id uuid NOT NULL,
  link_generation integer NOT NULL,
  trust_generation integer NOT NULL,
  domain_id uuid NOT NULL,
  domain_generation integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sso_delegation_bindings_one_per_api_key UNIQUE (api_key_id),
  CONSTRAINT sso_delegation_bindings_one_per_oauth_grant UNIQUE (oauth_grant_id),
  CONSTRAINT sso_delegation_bindings_credential_kind CHECK (num_nonnulls(api_key_id, oauth_grant_id) = 1),
  CONSTRAINT sso_delegation_bindings_link FOREIGN KEY (organization_id, provider_id, user_id, link_id)
    REFERENCES sso_identity_links (organization_id, provider_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_delegation_bindings_domain FOREIGN KEY (organization_id, domain_id)
    REFERENCES sso_domains (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_delegation_bindings_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '2592000 seconds'
  )
);
CREATE INDEX sso_delegation_bindings_member_id ON sso_delegation_bindings (member_id);
CREATE INDEX sso_delegation_bindings_link_id ON sso_delegation_bindings (link_id);
CREATE INDEX sso_delegation_bindings_domain_id ON sso_delegation_bindings (domain_id);
CREATE TRIGGER sso_delegation_bindings_reliance BEFORE INSERT OR UPDATE ON sso_delegation_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_sso_reliance();

CREATE FUNCTION guard_sso_delegation_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT FROM auth.apikey WHERE id = NEW.api_key_id
      AND ("referenceId" <> NEW.user_id::text
           OR lower(metadata::jsonb ->> 'organizationId') IS DISTINCT FROM NEW.organization_id::text)
  ) OR EXISTS (
    SELECT FROM public.mcp_oauth_grants WHERE id = NEW.oauth_grant_id
      AND (user_id <> NEW.user_id OR organization_id <> NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'a delegation binding binds its person''s own credential for the same team'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_delegation_bindings_credential';
  END IF;
  IF EXISTS (SELECT FROM auth.apikey WHERE id = NEW.api_key_id AND "expiresAt" < NEW.expires_at) THEN
    RAISE EXCEPTION 'a delegation binding ends no later than its API key'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_delegation_bindings_credential_deadline';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_delegation_bindings_guard BEFORE INSERT ON sso_delegation_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_sso_delegation_binding();
