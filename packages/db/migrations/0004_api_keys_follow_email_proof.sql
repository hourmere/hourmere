-- API keys minted before a user proved their email address die when it is proven.
--
-- Better Auth keeps an unverified account (e.g. created through a sign-in provider that did
-- not vouch for the address) until the mailbox owner signs in with an email link; it then
-- deletes the account's sign-in methods and sessions and marks the email verified. API keys
-- are a plugin table it does not clean up, so a key made by whoever held the account before
-- would keep acting as the owner. The application already refuses to create unverified
-- users; this covers any user that becomes verified by any route.
CREATE FUNCTION revoke_api_keys_on_email_proof() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM auth.apikey WHERE "referenceId" = NEW.id::text;
  RETURN NULL;
END $$;
CREATE TRIGGER user_email_proof_revokes_api_keys AFTER UPDATE OF "emailVerified" ON auth."user"
  FOR EACH ROW WHEN (NOT OLD."emailVerified" AND NEW."emailVerified")
  EXECUTE FUNCTION revoke_api_keys_on_email_proof();
