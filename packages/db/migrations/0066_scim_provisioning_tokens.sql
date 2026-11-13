-- Separate credential namespace: these digests never enter auth.apikey.
CREATE TABLE scim_provisioning_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash text UNIQUE CHECK (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  previous_token_hash text UNIQUE CHECK (previous_token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  previous_valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL,
  rotated_by_user_id uuid REFERENCES auth.user(id) ON DELETE SET NULL,
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK ((previous_token_hash IS NULL) = (previous_valid_until IS NULL)),
  CHECK ((revoked_at IS NULL AND token_hash IS NOT NULL) OR
    (revoked_at IS NOT NULL AND token_hash IS NULL AND previous_token_hash IS NULL))
);
CREATE INDEX scim_provisioning_tokens_organization_idx ON scim_provisioning_tokens(organization_id);
