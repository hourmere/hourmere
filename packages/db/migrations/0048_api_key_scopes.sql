-- Old auth writers must stop before this migration: they do not enforce scoped keys.
-- Inspect every row before rewriting any; errors expose only a count, never key metadata.
LOCK TABLE auth.apikey IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  row_metadata text;
  parsed jsonb;
  invalid_count bigint := 0;
BEGIN
  FOR row_metadata IN SELECT metadata FROM auth.apikey LOOP
    IF row_metadata IS NOT NULL THEN
      BEGIN
        parsed := row_metadata::jsonb;
        IF jsonb_typeof(parsed) IS DISTINCT FROM 'object' THEN
          invalid_count := invalid_count + 1;
        END IF;
      EXCEPTION WHEN data_exception THEN
        invalid_count := invalid_count + 1;
      END;
    END IF;
  END LOOP;
  IF invalid_count > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'API_KEY_METADATA_MIGRATION_INVALID', DETAIL = invalid_count::text;
  END IF;
END
$$;

-- Scope was not a reserved property before this migration, so all old keys remain full.
UPDATE auth.apikey
SET metadata = (coalesce(metadata::jsonb, '{}'::jsonb) || '{"scope":"full"}'::jsonb)::text;

CREATE FUNCTION auth.enforce_api_key_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parsed jsonb;
  old_scope jsonb;
BEGIN
  BEGIN
    parsed := coalesce(NEW.metadata::jsonb, '{}'::jsonb);
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'API_KEY_METADATA_INVALID';
  END;
  IF jsonb_typeof(parsed) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'API_KEY_METADATA_INVALID';
  END IF;
  IF TG_OP = 'INSERT' AND NOT parsed ? 'scope' THEN
    parsed := parsed || '{"scope":"full"}'::jsonb;
  END IF;
  IF jsonb_typeof(parsed -> 'scope') IS DISTINCT FROM 'string'
      OR parsed ->> 'scope' NOT IN ('full', 'read', 'bookings') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'API_KEY_SCOPE_INVALID';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_scope := OLD.metadata::jsonb -> 'scope';
    IF parsed -> 'scope' IS DISTINCT FROM old_scope THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'API_KEY_SCOPE_IMMUTABLE';
    END IF;
  END IF;
  -- Keep metadata byte-for-byte for ordinary counter/timestamp updates.
  IF TG_OP = 'INSERT' AND NEW.metadata IS DISTINCT FROM parsed::text THEN
    NEW.metadata := parsed::text;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER api_key_scope_guard BEFORE INSERT OR UPDATE ON auth.apikey
FOR EACH ROW EXECUTE FUNCTION auth.enforce_api_key_scope();
