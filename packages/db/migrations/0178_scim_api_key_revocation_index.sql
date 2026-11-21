-- Better Auth stores the reference as text, and existing UUIDs can use mixed case.
-- Invalid stored metadata must still reach the application's credential guard.
-- The fixed jsonb validator and the extraction do not depend on database state.
CREATE FUNCTION auth.scim_api_key_organization_id(key_metadata text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS $$
BEGIN
  -- Keep conversion in a separate statement so the planner cannot fold it early.
  IF pg_input_is_valid(key_metadata, 'pg_catalog.jsonb') THEN
    RETURN lower(key_metadata::jsonb ->> 'organizationId');
  END IF;
  RETURN NULL;
END
$$;

-- Exclude non-UUID lengths so arbitrary legacy metadata cannot exceed the btree key limit.
CREATE INDEX apikey_scim_revocation_idx ON auth.apikey
  (lower("referenceId"), auth.scim_api_key_organization_id(metadata))
  WHERE length("referenceId") = 36 AND length(auth.scim_api_key_organization_id(metadata)) = 36;
