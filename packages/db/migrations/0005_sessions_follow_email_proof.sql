-- Sessions and linked sign-in accounts from before a user proved their email address end
-- when it is proven.
--
-- 0004 deletes such a user's API keys. When the owner proves the address with an email link,
-- Better Auth also deletes the account's linked sign-in methods and sessions; when a provider
-- already linked to the account starts confirming the address (e.g. the owner's Google), it
-- just marks the email verified. A session of whoever held the unverified account before
-- would then belong to a verified user, and their linked provider (one that never confirmed
-- the address) would sign them back in. This does what the email-link route does, in the
-- same order. The owner's own session is created after the email is verified, and a
-- provider that confirms the address is linked again at their next sign-in.
CREATE FUNCTION revoke_access_on_email_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM auth.account WHERE "userId" = NEW.id;
  DELETE FROM auth.session WHERE "userId" = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER user_email_proof_revokes_access AFTER UPDATE OF "emailVerified" ON auth."user"
  FOR EACH ROW WHEN (NOT OLD."emailVerified" AND NEW."emailVerified")
  EXECUTE FUNCTION revoke_access_on_email_proof();
