-- Append-only application journal. Retention will use explicit operator bulk deletes,
-- never cascading account deletion. Identifiers intentionally outlive their subjects.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','api_key','oauth_client','system','anonymous','external_api_key','external_oauth_client')),
  actor_id text,
  credential_type text NOT NULL CHECK (credential_type IN ('session','api_key','oauth','none')),
  credential_id text,
  credential_scope text,
  oauth_client_id text,
  oauth_grant_id text,
  action text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 80),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 256),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT audit_events_details_check CHECK (
    jsonb_typeof(details) = 'object' AND
    CASE
      WHEN action = 'membership.role_changed' THEN details - ARRAY['oldRole','newRole'] = '{}'::jsonb
      WHEN action IN ('api_key.created','api_key.rotated') THEN details - 'scope' = '{}'::jsonb
      WHEN action IN ('webhook.created','webhook.updated','webhook.deleted','webhook.secret_rotated','webhook.paused','webhook.resumed') THEN details - 'events' = '{}'::jsonb
      WHEN action = 'oauth.token_revoked' THEN details - 'familySize' = '{}'::jsonb
      ELSE details = '{}'::jsonb
    END
  ),
  request_id text CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT audit_actor_identity CHECK (
    (actor_type IN ('anonymous','external_api_key','external_oauth_client') AND actor_id IS NULL) OR
    (actor_type NOT IN ('anonymous','external_api_key','external_oauth_client') AND actor_id IS NOT NULL AND length(actor_id) BETWEEN 1 AND 256)
  ),
  -- A caller from another organization never leaves its credential identifiers here.
  CONSTRAINT audit_external_actor_credential CHECK (
    actor_type NOT IN ('external_api_key','external_oauth_client') OR credential_type = 'none'
  ),
  CONSTRAINT audit_credential_shape CHECK (
    (credential_type = 'none' AND credential_id IS NULL AND credential_scope IS NULL
      AND oauth_client_id IS NULL AND oauth_grant_id IS NULL) OR
    (credential_type = 'session' AND credential_scope IS NULL
      AND oauth_client_id IS NULL AND oauth_grant_id IS NULL) OR
    (credential_type = 'api_key' AND credential_id IS NOT NULL
      AND (credential_scope IS NULL OR credential_scope IN ('read','bookings','full'))
      AND oauth_client_id IS NULL AND oauth_grant_id IS NULL) OR
    (credential_type = 'oauth' AND credential_id IS NULL AND credential_scope IS NULL
      AND oauth_client_id IS NOT NULL AND oauth_grant_id IS NOT NULL)
  )
);
CREATE INDEX audit_events_organization_time ON audit_events (organization_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_organization_actor ON audit_events (organization_id, actor_type, actor_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_organization_action ON audit_events (organization_id, action, occurred_at DESC, id DESC);
