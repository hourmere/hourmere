-- Sessions started before a user proved their email address end when it is proven.
--
-- 0004 deletes such a user's API keys. When the owner proves the address with an email link,
-- Better Auth also revokes the account's sessions; when they prove it by signing in with a
-- provider that confirms the address (Google), it links that provider and marks the email
-- verified without revoking anything. A session of whoever held the unverified account
-- before would then belong to a verified user, able to mint new API keys. The owner's own
-- session is created after the email is verified, so it is not affected.
CREATE FUNCTION revoke_sessions_on_email_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM auth.session WHERE "userId" = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER user_email_proof_revokes_sessions AFTER UPDATE OF "emailVerified" ON auth."user"
  FOR EACH ROW WHEN (NOT OLD."emailVerified" AND NEW."emailVerified")
  EXECUTE FUNCTION revoke_sessions_on_email_proof();
