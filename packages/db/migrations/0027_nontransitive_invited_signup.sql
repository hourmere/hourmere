-- Invitation-based registration is non-transitive on restricted instances. Only a user
-- with a currently allowed email domain, or the earliest remaining auth user, may admit an
-- invitation's exact address. Creating a team or accepting an invitation grants no such
-- authority. Match the application's deterministic first-user ordering (createdAt, id).
-- Replace 0012's function without changing any previously published migration.
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
    -- Lock both the invitation and inviter until insertion commits: concurrent revocation,
    -- deletion or inviter email changes finish first and are rechecked, or wait for sign-up.
    SELECT i."expiresAt" INTO invitation_expires_at
      FROM auth.invitation i
      JOIN auth."user" inviter ON inviter.id = i."inviterId"
      WHERE lower(i.email) = lower(NEW.email)
        AND i.status = 'pending' AND i."expiresAt" > clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM public.personal_organizations p
            WHERE p.organization_id = i."organizationId"
        )
        AND (
          lower(substring(inviter.email FROM '@([^@]*)$')) = ANY (domains)
          OR inviter.id = (SELECT id FROM auth."user" ORDER BY "createdAt", id LIMIT 1)
        )
      ORDER BY i."expiresAt" DESC
      LIMIT 1 FOR SHARE OF i, inviter;
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
