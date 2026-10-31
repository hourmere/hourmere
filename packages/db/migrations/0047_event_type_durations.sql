-- duration_minutes remains the default, preserving the existing API and booking rows.
-- A NULL expression default lets legacy INSERT statements omit the new column;
-- the BEFORE trigger replaces it before NOT NULL is checked. PostgreSQL discards
-- literal NULL defaults, so NULLIF preserves the default metadata for typed clients.
ALTER TABLE event_types ADD COLUMN allowed_durations_minutes integer[]
  DEFAULT NULLIF(ARRAY[]::integer[], ARRAY[]::integer[]);

-- Preserve historical timestamps as well as every existing event and booking field.
ALTER TABLE event_types DISABLE TRIGGER event_types_updated_at;
UPDATE event_types SET allowed_durations_minutes = ARRAY[duration_minutes];
ALTER TABLE event_types ENABLE TRIGGER event_types_updated_at;

CREATE FUNCTION valid_event_type_durations(durations integer[], default_duration integer)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp AS $$
  SELECT array_ndims(durations) = 1
    AND array_lower(durations, 1) = 1
    AND cardinality(durations) BETWEEN 1 AND 12
    AND default_duration = ANY(durations)
    AND NOT EXISTS (
      SELECT FROM unnest(durations) AS duration
      WHERE duration NOT BETWEEN 1 AND 1440
    )
    AND cardinality(durations) = (SELECT count(DISTINCT duration) FROM unnest(durations) AS duration);
$$;

ALTER TABLE event_types
  ALTER COLUMN allowed_durations_minutes SET NOT NULL,
  ADD CONSTRAINT event_types_allowed_durations_valid
    CHECK (valid_event_type_durations(allowed_durations_minutes, duration_minutes));

CREATE FUNCTION event_type_duration_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.allowed_durations_minutes IS NULL THEN
    NEW.allowed_durations_minutes := ARRAY[NEW.duration_minutes];
  ELSIF TG_OP = 'UPDATE'
    AND NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
    AND NEW.allowed_durations_minutes IS NOT DISTINCT FROM OLD.allowed_durations_minutes
    AND OLD.allowed_durations_minutes = ARRAY[OLD.duration_minutes] THEN
    -- A legacy edit of a single-duration event keeps it a single-duration event.
    NEW.allowed_durations_minutes := ARRAY[NEW.duration_minutes];
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER event_types_duration_defaults
  BEFORE INSERT OR UPDATE OF duration_minutes, allowed_durations_minutes ON event_types
  FOR EACH ROW EXECUTE FUNCTION event_type_duration_defaults();
