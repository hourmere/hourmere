-- Zoom identities are independent of authentication and calendars. Retained tombstones
-- keep stable connection IDs for future conference intents; disconnect never cascades them.
CREATE TABLE conference_connections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid REFERENCES auth."user"(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider = 'zoom'),
  external_user_id text CHECK (external_user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  account_email text CHECK (octet_length(account_email) <= 320),
  display_name text CHECK (char_length(display_name) <= 200),
  credentials bytea,
  operation_id uuid,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('active', 'refreshing', 'needs_reauth', 'disconnected')),
  last_error text CHECK (last_error IN ('provider_unavailable','needs_reauth','permissions_missing','identity_mismatch','credentials_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_user_id),
  CHECK ((status = 'active') = (credentials IS NOT NULL)),
  CHECK ((status = 'refreshing') = (operation_id IS NOT NULL)),
  CHECK (status = 'disconnected' OR (user_id IS NOT NULL AND external_user_id IS NOT NULL)),
  CHECK (user_id IS NOT NULL OR (external_user_id IS NULL AND account_email IS NULL AND display_name IS NULL AND credentials IS NULL AND operation_id IS NULL AND cardinality(scopes) = 0 AND status = 'disconnected' AND last_error IS NULL)),
  CHECK (status <> 'active' OR scopes = ARRAY['user:read:user']::text[]),
  CHECK (scopes = '{}'::text[] OR scopes = ARRAY['user:read:user']::text[])
);
CREATE INDEX conference_connections_owner ON conference_connections(user_id,id);
CREATE TRIGGER conference_connections_updated_at BEFORE UPDATE ON conference_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE conference_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth.session(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES conference_connections(id) ON DELETE CASCADE,
  verifier bytea,
  claimed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (claimed = (verifier IS NULL))
);
CREATE INDEX conference_oauth_states_owner ON conference_oauth_states(user_id,created_at);
-- All application operations first lock auth.user, then its session/connection/state.
-- DELETE already owns that user lock. Wipe secrets and metadata before retaining the row;
-- neither a new user nor an equal email address can inherit the old connection.
CREATE FUNCTION clear_deleted_conference_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE conference_connections SET user_id = NULL, external_user_id = NULL,
    account_email = NULL, display_name = NULL, credentials = NULL, operation_id = NULL, scopes = '{}',
    status = 'disconnected', last_error = NULL WHERE user_id = OLD.id;
  DELETE FROM conference_oauth_states WHERE user_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER conference_owner_deleted BEFORE DELETE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION clear_deleted_conference_owner();
