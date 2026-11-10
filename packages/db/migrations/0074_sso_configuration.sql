-- SSO configuration storage only (docs/sso.md, Configuration storage). No route, worker,
-- read path or setting uses these tables yet, and OIDC and SAML stay hard-off.

-- SSO configuration belongs to teams; a personal organization never has any. Policies,
-- providers and domain claims are deleted only with their organization: deleting and
-- inserting one again would reset a trust generation, reuse a provider ID or revive a
-- lapsed claim generation. Providers and claims are retired instead.
CREATE FUNCTION sso_team_organization(organization uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM public.personal_organizations WHERE organization_id = organization) THEN
    RAISE EXCEPTION 'SSO configuration belongs to a team, not a personal organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_team_organization';
  END IF;
END $$;

-- Team policy. policy_revision is the optimistic-concurrency revision of the policy and
-- recovery state; trust_generation is what browser proofs and delegations store and check.
CREATE TABLE sso_policies (
  organization_id uuid PRIMARY KEY REFERENCES auth.organization (id) ON DELETE CASCADE,
  require_sso boolean NOT NULL DEFAULT false,
  admission text NOT NULL DEFAULT 'invitation_only'
    CONSTRAINT sso_policies_admission CHECK (admission IN ('invitation_only', 'jit')),
  policy_revision integer NOT NULL DEFAULT 1
    CONSTRAINT sso_policies_policy_revision CHECK (policy_revision > 0),
  trust_generation integer NOT NULL DEFAULT 1
    CONSTRAINT sso_policies_trust_generation CHECK (trust_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION guard_sso_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'an SSO policy is kept while its team exists'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_policies_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sso_team_organization(NEW.organization_id);
    RETURN NEW;
  END IF;
  IF ROW(NEW.organization_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.organization_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SSO policy ownership is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_policies_identity_immutable';
  END IF;
  IF NEW.policy_revision < OLD.policy_revision OR NEW.trust_generation < OLD.trust_generation THEN
    RAISE EXCEPTION 'SSO policy revisions and trust generations never decrease'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_policies_counters_monotonic';
  END IF;
  IF ROW(NEW.require_sso, NEW.admission) IS DISTINCT FROM ROW(OLD.require_sso, OLD.admission)
     AND NEW.policy_revision = OLD.policy_revision THEN
    RAISE EXCEPTION 'an SSO policy change needs a new policy revision'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_policies_revision_required';
  END IF;
  -- Turning enforcement off ends every proof and delegation of the team.
  IF OLD.require_sso AND NOT NEW.require_sso AND NEW.trust_generation = OLD.trust_generation THEN
    RAISE EXCEPTION 'turning SSO enforcement off needs a new trust generation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_policies_enforcement_off_generation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_policies_guard BEFORE INSERT OR UPDATE OR DELETE ON sso_policies
  FOR EACH ROW EXECUTE FUNCTION guard_sso_policy();

-- Providers. The identity (protocol, OIDC issuer and client ID, or the SAML IdP entity ID
-- in issuer) is immutable: changing it needs a replacement provider. The configuration,
-- secrets included, is only stored as an AES-256-GCM envelope (version 1, IV, tag,
-- ciphertext) whose authenticated data binds organization, provider and revision.
-- Retirement is permanent, so a provider ID is never reused.
CREATE TABLE sso_providers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  protocol text NOT NULL CONSTRAINT sso_providers_protocol CHECK (protocol IN ('oidc', 'saml')),
  display_name text NOT NULL,
  issuer text NOT NULL,
  client_id text,
  configuration bytea NOT NULL,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT sso_providers_revision CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT sso_providers_organization_id_id UNIQUE (organization_id, id),
  CONSTRAINT sso_providers_text CHECK (
    char_length(display_name) BETWEEN 1 AND 100
    AND char_length(issuer) BETWEEN 1 AND 2048
    AND char_length(client_id) BETWEEN 1 AND 1024
  ),
  CONSTRAINT sso_providers_protocol_identity CHECK ((protocol = 'oidc') = (client_id IS NOT NULL)),
  CONSTRAINT sso_providers_configuration_envelope CHECK (
    octet_length(configuration) >= 30 AND get_byte(configuration, 0) = 1
  ),
  CONSTRAINT sso_providers_retired_disabled CHECK (retired_at IS NULL OR NOT enabled)
);

CREATE FUNCTION guard_sso_provider() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'an SSO provider is retired, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_providers_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sso_team_organization(NEW.organization_id);
    RETURN NEW;
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a retired SSO provider is permanent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_providers_retired_permanent';
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.protocol, NEW.issuer, NEW.client_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.protocol, OLD.issuer, OLD.client_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SSO provider identity is immutable; configure a replacement provider'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_providers_identity_immutable';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'SSO provider revisions never decrease'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_providers_revision_monotonic';
  END IF;
  -- The authenticated data binds the revision: a new revision is sealed again, and a
  -- changed configuration is a new revision.
  IF (NEW.revision > OLD.revision) <> (NEW.configuration IS DISTINCT FROM OLD.configuration) THEN
    RAISE EXCEPTION 'an SSO provider revision and its sealed configuration change together'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_providers_revision_sealed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_providers_guard BEFORE INSERT OR UPDATE OR DELETE ON sso_providers
  FOR EACH ROW EXECUTE FUNCTION guard_sso_provider();

-- Domain claims. A claim is pending until its first verification and reserves nothing.
-- From then until explicit retirement it is exclusive for its exact name, expired or not.
-- Each generation has its own challenge (only a SHA-256 digest is stored) and starts
-- unverified. Proofs and delegations record the claim and generation they relied on, so a
-- generation keeps its verification time and its expiry can be renewed (including by a
-- positive recheck of a frozen claim) only while it is unexpired: after a lapse, only a
-- new generation can be verified, and nothing that relied on the old one revives.
CREATE TABLE sso_domains (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  -- An exact IDNA ASCII name in lowercase with at least two labels: no wildcard, no
  -- trailing dot, and a top-level label starting with a letter, so never an IP address.
  -- Public suffixes are refused by the application, which has the suffix list.
  name text NOT NULL CONSTRAINT sso_domains_name CHECK (
    char_length(name) <= 253
    AND name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  generation integer NOT NULL DEFAULT 1 CONSTRAINT sso_domains_generation CHECK (generation > 0),
  challenge_digest text NOT NULL
    CONSTRAINT sso_domains_challenge_digest CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  challenge_expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  last_checked_at timestamptz,
  last_check_outcome text
    CONSTRAINT sso_domains_last_check_outcome CHECK (last_check_outcome IN ('positive', 'failed', 'unknown')),
  next_check_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_domains_organization_id_id UNIQUE (organization_id, id),
  CONSTRAINT sso_domains_verification_shape CHECK (
    (verified_at IS NULL) = (verification_expires_at IS NULL)
    AND (verified_at IS NULL OR (claimed_at IS NOT NULL AND verification_expires_at > verified_at))
  ),
  CONSTRAINT sso_domains_check_shape CHECK ((last_checked_at IS NULL) = (last_check_outcome IS NULL))
);
-- One active claim per exact domain per instance.
CREATE UNIQUE INDEX sso_domains_active_name ON sso_domains (name)
  WHERE claimed_at IS NOT NULL AND retired_at IS NULL;
-- One live record per team and domain; a new challenge is a new generation of it.
CREATE UNIQUE INDEX sso_domains_organization_name ON sso_domains (organization_id, name)
  WHERE retired_at IS NULL;

CREATE FUNCTION guard_sso_domain() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'an SSO domain claim is retired, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_retained';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sso_team_organization(NEW.organization_id);
  ELSE
    IF OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a retired SSO domain claim is permanent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_retired_permanent';
    END IF;
    IF ROW(NEW.id, NEW.organization_id, NEW.name, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.name, OLD.created_at) THEN
      RAISE EXCEPTION 'SSO domain claim identity is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_identity_immutable';
    END IF;
    IF OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
      RAISE EXCEPTION 'an SSO domain claim stays exclusive until it is retired'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_claim_kept';
    END IF;
    IF NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'SSO domain generations never decrease'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_generation_monotonic';
    END IF;
    IF NEW.generation > OLD.generation THEN
      IF NEW.challenge_digest = OLD.challenge_digest OR NEW.verified_at IS NOT NULL THEN
        RAISE EXCEPTION 'a new SSO domain generation has a new, unverified challenge'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_generation_challenge';
      END IF;
    ELSE
      IF ROW(NEW.challenge_digest, NEW.challenge_expires_at)
         IS DISTINCT FROM ROW(OLD.challenge_digest, OLD.challenge_expires_at) THEN
        RAISE EXCEPTION 'a new SSO domain challenge needs a new generation'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_challenge_fixed';
      END IF;
      IF OLD.verified_at IS NOT NULL AND (
           NEW.verified_at IS DISTINCT FROM OLD.verified_at
           OR (NEW.verification_expires_at IS DISTINCT FROM OLD.verification_expires_at
               AND OLD.verification_expires_at <= clock_timestamp())
         ) THEN
        RAISE EXCEPTION 'a verified SSO domain generation keeps its verification time and is renewed only before it lapses'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_generation_lapse';
      END IF;
    END IF;
  END IF;
  IF NEW.claimed_at IS NOT NULL AND NEW.verified_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.claimed_at IS NULL) THEN
    RAISE EXCEPTION 'an SSO domain claim starts with a verification'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domains_claim_verified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_domains_guard BEFORE INSERT OR UPDATE OR DELETE ON sso_domains
  FOR EACH ROW EXECUTE FUNCTION guard_sso_domain();

-- The domain claims a provider serves, always within the provider's own team.
CREATE TABLE sso_provider_domains (
  organization_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  PRIMARY KEY (provider_id, domain_id),
  CONSTRAINT sso_provider_domains_provider FOREIGN KEY (organization_id, provider_id)
    REFERENCES sso_providers (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_provider_domains_domain FOREIGN KEY (organization_id, domain_id)
    REFERENCES sso_domains (organization_id, id) ON DELETE CASCADE
);
CREATE INDEX sso_provider_domains_domain_id ON sso_provider_domains (domain_id);

-- Recovery nominations and recovery owners belong to a current owner's membership: the
-- membership foreign key deletes them with it (leaving, removal, or the team's or user's
-- deletion), and re-joining does not restore them. The organization and user are those of
-- that membership, checked on insert, and both records are immutable. Acceptance deletes
-- the nomination and inserts the recovery owner; a new nomination of the same owner
-- replaces the pending one.
CREATE FUNCTION guard_sso_recovery_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SSO recovery records are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_recovery_immutable';
  END IF;
  PERFORM public.sso_team_organization(NEW.organization_id);
  IF NOT EXISTS (
    SELECT FROM auth.member m
    WHERE m.id = NEW.member_id AND m."organizationId" = NEW.organization_id
      AND m."userId" = NEW.user_id
      AND 'owner' = ANY (SELECT btrim(r.token) FROM unnest(string_to_array(m.role, ',')) AS r (token))
  ) THEN
    RAISE EXCEPTION 'SSO recovery belongs to a current owner of the team'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_recovery_current_owner';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE sso_recovery_nominations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  nominated_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sso_recovery_nominations_pending UNIQUE (organization_id, user_id),
  CONSTRAINT sso_recovery_nominations_expiry CHECK (expires_at > created_at)
);
CREATE INDEX sso_recovery_nominations_member_id ON sso_recovery_nominations (member_id);
CREATE TRIGGER sso_recovery_nominations_guard BEFORE INSERT OR UPDATE ON sso_recovery_nominations
  FOR EACH ROW EXECUTE FUNCTION guard_sso_recovery_record();

CREATE TABLE sso_recovery_owners (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES auth.member (id) ON DELETE CASCADE,
  nominated_by_user_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX sso_recovery_owners_member_id ON sso_recovery_owners (member_id);
CREATE TRIGGER sso_recovery_owners_guard BEFORE INSERT OR UPDATE ON sso_recovery_owners
  FOR EACH ROW EXECUTE FUNCTION guard_sso_recovery_record();
