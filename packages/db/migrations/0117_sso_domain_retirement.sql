-- Offline domain retirement ceremonies. They remove an expired claim, never transfer it.
-- Keep the requesting team and proof timestamps out of the audit details allow-list:
-- this record and the system audit event commit in the same transaction.
CREATE TABLE sso_domain_retirements (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  domain_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  old_organization_id uuid NOT NULL,
  requesting_organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  challenge_digest text NOT NULL CHECK (challenge_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  proved_at timestamptz,
  retired_at timestamptz,
  old_verified_at timestamptz,
  old_expires_at timestamptz,
  CONSTRAINT sso_domain_retirements_domain FOREIGN KEY (old_organization_id, domain_id)
    REFERENCES sso_domains (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT sso_domain_retirements_teams CHECK (old_organization_id <> requesting_organization_id),
  CONSTRAINT sso_domain_retirements_deadline CHECK (expires_at > created_at),
  CONSTRAINT sso_domain_retirements_completion CHECK (
    (proved_at IS NULL AND retired_at IS NULL AND old_verified_at IS NULL AND old_expires_at IS NULL)
    OR (proved_at IS NOT NULL AND retired_at IS NOT NULL AND old_verified_at IS NOT NULL AND old_expires_at IS NOT NULL
      AND proved_at >= created_at AND proved_at < expires_at AND retired_at >= proved_at
      AND old_expires_at > old_verified_at AND old_expires_at <= proved_at)
  )
);
CREATE FUNCTION guard_sso_domain_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF ROW(NEW.id, NEW.domain_id, NEW.generation, NEW.old_organization_id, NEW.requesting_organization_id,
      NEW.challenge_digest, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.domain_id, OLD.generation, OLD.old_organization_id, OLD.requesting_organization_id,
      OLD.challenge_digest, OLD.created_at, OLD.expires_at)
    OR (OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'domain retirement identity and completed proof are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sso_domain_retirements_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_domain_retirements_guard BEFORE UPDATE ON sso_domain_retirements
  FOR EACH ROW EXECUTE FUNCTION guard_sso_domain_retirement();

-- Snapshot owner IDs, never recipient addresses. Delivery resolves a still-current owner.
CREATE TABLE sso_domain_retirement_notifications (
  retirement_id uuid REFERENCES sso_domain_retirements (id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE,
  delivered_at timestamptz,
  PRIMARY KEY (retirement_id, user_id)
);
