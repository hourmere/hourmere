-- Extend the existing insert-time policy to live team invitations.
-- Keep 0006 unchanged so existing installations can migrate with checksum verification.
CREATE OR REPLACE FUNCTION enforce_signup_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mode text := current_setting('hourmere.signup', true);
  invitation_expires_at timestamptz;
  domains text[] := string_to_array(current_setting('hourmere.signup_allowed_domains', true), ',');
BEGIN
  IF coalesce(mode, '') IN ('', 'open') THEN
    RETURN NEW;
  END IF;
  IF lower(substring(NEW.email FROM '@([^@]*)$')) = ANY (domains) THEN
    RETURN NEW;
  END IF;
  IF mode IN ('first-user', 'closed') THEN
    -- Lock the invitation until the user insert commits. A concurrent revocation/deletion
    -- either finishes first (and is rechecked) or waits for this sign-up to finish. This is
    -- only permission to create a verified account, not acceptance or team membership.
    SELECT i."expiresAt" INTO invitation_expires_at
      FROM auth.invitation i
      WHERE lower(i.email) = lower(NEW.email)
        AND i.status = 'pending' AND i."expiresAt" > clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM public.personal_organizations p
            WHERE p.organization_id = i."organizationId"
        )
      ORDER BY i."expiresAt" DESC
      LIMIT 1 FOR SHARE OF i;
    -- A row lock may have waited; never use an invitation that expired while waiting.
    IF FOUND AND invitation_expires_at > clock_timestamp() THEN
      RETURN NEW;
    END IF;
  END IF;
  IF mode = 'first-user' THEN
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'first-user sign-up needs read committed or serializable isolation'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    PERFORM pg_advisory_xact_lock(7340173);
    IF NOT EXISTS (SELECT 1 FROM auth."user") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'sign-up is not open to this email address'
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Match the case-insensitive lookup without scanning all historical invitations.
CREATE INDEX invitation_pending_email_idx ON auth.invitation (lower(email))
  WHERE status = 'pending';
