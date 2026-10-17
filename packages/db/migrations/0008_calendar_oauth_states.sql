-- Calendar authorization is separate from sign-in. Only a digest of the browser's state
-- and an encrypted PKCE verifier are kept; each attempt belongs to one existing session.
CREATE TABLE calendar_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth.session (id) ON DELETE CASCADE,
  verifier bytea NOT NULL,
  claimed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_oauth_states_user ON calendar_oauth_states (user_id, created_at);
