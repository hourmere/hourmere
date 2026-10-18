-- Explicit Zoom grants. Published0022 identity rows/ciphertext/timestamps stay unchanged.
-- Old unfinished v1 states lack authenticated mode/expected-connection bindings. Retain
-- them verbatim, but only new binding_version=2 attempts may redeem a provider code.
ALTER TABLE conference_connections ADD COLUMN mode text NOT NULL DEFAULT 'identity'
  CHECK (mode IN ('identity','meetings'));
ALTER TABLE conference_oauth_states ADD COLUMN mode text NOT NULL DEFAULT 'identity'
  CHECK (mode IN ('identity','meetings'));
ALTER TABLE conference_oauth_states ADD COLUMN binding_version integer NOT NULL DEFAULT 1
  CHECK (binding_version IN (1,2));
-- Locate only the two original scope constraints by their exact expression, retaining
-- every unrelated status, owner, token, tombstone and session cleanup safeguard.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'conference_connections'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) IN (
        'CHECK (((status <> ''active''::text) OR (scopes = ARRAY[''user:read:user''::text])))',
        'CHECK (((scopes = ''{}''::text[]) OR (scopes = ARRAY[''user:read:user''::text])))'
      ) LOOP
    EXECUTE format('ALTER TABLE conference_connections DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;
ALTER TABLE conference_connections ADD CONSTRAINT conference_connection_mode_scopes CHECK (
  scopes = '{}'::text[] OR
  (mode = 'identity' AND scopes = ARRAY['user:read:user']::text[]) OR
  (mode = 'meetings' AND scopes = ARRAY['user:read:user','meeting:write:meeting',
    'meeting:read:meeting','meeting:update:meeting','meeting:delete:meeting']::text[])
);
ALTER TABLE conference_connections ADD CONSTRAINT conference_connection_active_scopes
  CHECK (status <> 'active' OR cardinality(scopes) > 0);
ALTER TABLE conference_connections DROP CONSTRAINT conference_connections_last_error_check;
ALTER TABLE conference_connections ADD CONSTRAINT conference_connections_last_error_check
  CHECK (last_error IN ('provider_unavailable','needs_reauth','permissions_missing',
    'identity_mismatch','credentials_unavailable','mode_conflict'));
