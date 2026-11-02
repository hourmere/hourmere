-- Keep historical values and timestamps; only the new columns are backfilled.
ALTER TABLE event_types ADD COLUMN locations jsonb;
ALTER TABLE bookings ADD COLUMN location_option jsonb;

ALTER TABLE event_types DISABLE TRIGGER event_types_updated_at;
UPDATE event_types SET locations = jsonb_build_array(jsonb_build_object('id', 'legacy') || location)
  WHERE location IS NOT NULL;
ALTER TABLE event_types ENABLE TRIGGER event_types_updated_at;

ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;
UPDATE bookings SET location_option = jsonb_build_object('id', 'legacy') || location
  WHERE location IS NOT NULL;
ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;

-- Kind-specific settings remain service-validated, including legacy settings that
-- predate the list contract. Snapshots may additionally contain resolved values.
CREATE FUNCTION valid_location_option(option jsonb, known_kind boolean DEFAULT true) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $$
BEGIN
  RETURN jsonb_typeof(option) = 'object'
    AND jsonb_typeof(option->'id') = 'string'
    AND length(option->>'id') > 0
    AND jsonb_typeof(option->'kind') = 'string'
    AND (NOT known_kind OR option->>'kind' IN ('google_meet', 'zoom', 'phone', 'in_person', 'link'))
    AND (NOT option ? 'isDefault' OR option->'isDefault' = 'true'::jsonb);
END $$;

CREATE FUNCTION valid_event_type_locations(options jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $$
DECLARE
  option jsonb;
BEGIN
  IF jsonb_typeof(options) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(options) NOT BETWEEN 1 AND 5 THEN RETURN false; END IF;
  FOR option IN SELECT value FROM jsonb_array_elements(options) LOOP
    IF valid_location_option(option) IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT value->>'id') = count(*)
      AND count(DISTINCT value->>'kind') = count(*)
      AND count(*) FILTER (WHERE value->'isDefault' = 'true'::jsonb) <= 1
    FROM jsonb_array_elements(options));
END $$;

ALTER TABLE event_types ADD CONSTRAINT event_types_locations_valid
  CHECK (locations IS NULL OR valid_event_type_locations(locations));
ALTER TABLE bookings ADD CONSTRAINT bookings_location_option_valid
  -- Historical resolved booking payloads can use custom kinds. Preserve their
  -- snapshots without admitting those kinds into new event configuration.
  CHECK (location_option IS NULL OR valid_location_option(location_option, false) IS TRUE);

CREATE FUNCTION event_type_location_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.locations IS NULL THEN
    IF NEW.location IS NOT NULL THEN
      NEW.locations := jsonb_build_array(jsonb_build_object('id', 'legacy') || NEW.location);
    END IF;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.location IS DISTINCT FROM OLD.location
    AND NEW.locations IS NOT DISTINCT FROM OLD.locations THEN
    -- Old callers replace the singleton through their existing location field.
    NEW.locations := CASE WHEN NEW.location IS NULL THEN NULL
      ELSE jsonb_build_array(jsonb_build_object('id', 'legacy') || NEW.location) END;
  END IF;
  -- Explicit lists take precedence. The first option is the implicit default.
  IF NEW.locations IS NULL THEN
    NEW.location := NULL;
  ELSIF valid_event_type_locations(NEW.locations) IS TRUE THEN
    SELECT value - 'id' - 'label' - 'isDefault' INTO NEW.location
      FROM jsonb_array_elements(NEW.locations) WITH ORDINALITY
      ORDER BY (value->'isDefault' = 'true'::jsonb) DESC NULLS LAST, ordinality
      LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER event_types_location_defaults
  BEFORE INSERT OR UPDATE OF location, locations ON event_types
  FOR EACH ROW EXECUTE FUNCTION event_type_location_defaults();

CREATE FUNCTION booking_location_option_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.location_option IS DISTINCT FROM OLD.location_option THEN
      RAISE EXCEPTION 'booking location option is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.location_option IS NULL AND NEW.location IS NOT NULL THEN
    NEW.location_option := jsonb_build_object('id', 'legacy') || NEW.location;
  END IF;
  RETURN NEW;
END $$;

-- Conference reconciliation updates resolved location later; it must never
-- rewrite the chosen option snapshot. New booking writers supply it explicitly.
CREATE TRIGGER bookings_location_option_defaults
  BEFORE INSERT OR UPDATE OF location_option ON bookings
  FOR EACH ROW EXECUTE FUNCTION booking_location_option_defaults();
