-- The sign-up policy (SIGNUP), checked again in the transaction that inserts the user.
--
-- The application refuses a new account the policy does not allow, with a clear error, in
-- Better Auth's user create hook. That hook runs before the insert and outside its
-- transaction (Better Auth gives hooks no access to it, and creates email-link users without
-- one), so in first-user mode two sign-ups at the same moment could both find no user and
-- both be created. Here the check cannot race: first sign-ups take a transaction-scoped
-- advisory lock, so a concurrent one waits until the other's transaction ends, and only
-- then looks for an existing user (read committed: that statement sees the committed row).
--
-- Better Auth's connections carry the policy as settings (createAuthPool in @hourmere/auth):
-- hourmere.signup (open, first-user or closed) and hourmere.signup_allowed_domains
-- (comma-separated, lowercase). Other connections (migrations, psql, the application's own
-- pool) set neither and are not limited. An unknown mode refuses.
--
-- Connections without the settings are not limited, so anything that drops startup
-- parameters (a connection pooler such as PgBouncer, which refuses or ignores `options`)
-- would turn this check off. The server reads the settings back over Better Auth's pool at
-- startup (assertSignupEnforced) and refuses to start if they are missing or differ.
CREATE FUNCTION enforce_signup_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  mode text := current_setting('hourmere.signup', true);
  domains text[] := string_to_array(current_setting('hourmere.signup_allowed_domains', true), ',');
BEGIN
  IF coalesce(mode, '') IN ('', 'open') THEN
    RETURN NEW;
  END IF;
  IF lower(substring(NEW.email FROM '@([^@]*)$')) = ANY (domains) THEN
    RETURN NEW;
  END IF;
  IF mode = 'first-user' THEN
    PERFORM pg_advisory_xact_lock(7340173);
    IF NOT EXISTS (SELECT 1 FROM auth."user") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'sign-up is not open to this email address'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER user_signup_policy BEFORE INSERT ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION enforce_signup_policy();
