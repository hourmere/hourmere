-- Expand the event configuration vocabulary. The existing constraints and
-- historical booking location snapshots remain in place.
CREATE OR REPLACE FUNCTION valid_location_option(option jsonb, known_kind boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = public, pg_temp AS $$
BEGIN
  RETURN jsonb_typeof(option) = 'object'
    AND jsonb_typeof(option->'id') = 'string'
    AND length(option->>'id') > 0
    AND option->>'id' <> '__proto__'
    AND jsonb_typeof(option->'kind') = 'string'
    AND (NOT known_kind OR option->>'kind' IN
      ('google_meet', 'zoom', 'phone', 'in_person', 'link', 'microsoft_teams'))
    AND (NOT option ? 'isDefault' OR option->'isDefault' = 'true'::jsonb);
END $$;
