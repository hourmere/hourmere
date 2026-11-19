-- Internal storage for recurring bookings. Admission remains hard-off.
ALTER TABLE event_types
  ADD COLUMN recurrence jsonb,
  ADD COLUMN recurrence_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT event_types_recurrence_revision_check CHECK (recurrence_revision >= 0),
  ADD CONSTRAINT event_types_recurrence_check CHECK (
    CASE
      WHEN recurrence IS NULL THEN true
      WHEN jsonb_typeof(recurrence) = 'object'
        AND jsonb_typeof(recurrence->'timeZone') = 'string'
        AND jsonb_typeof(recurrence->'allowedPatterns') = 'array'
        AND jsonb_typeof(recurrence->'maxOccurrences') = 'number'
      THEN recurrence - ARRAY['timeZone', 'allowedPatterns', 'maxOccurrences'] = '{}'::jsonb
        AND btrim(recurrence->>'timeZone') <> ''
        AND (recurrence->'allowedPatterns') <@ '["weekly", "fortnightly", "monthly_weekday"]'::jsonb
        AND jsonb_array_length(recurrence->'allowedPatterns') > 0
        AND jsonb_array_length(recurrence->'allowedPatterns') =
          ((recurrence->'allowedPatterns') ? 'weekly')::integer +
          ((recurrence->'allowedPatterns') ? 'fortnightly')::integer +
          ((recurrence->'allowedPatterns') ? 'monthly_weekday')::integer
        AND (recurrence->>'maxOccurrences')::numeric BETWEEN 2 AND 12
        AND (recurrence->>'maxOccurrences')::numeric = trunc((recurrence->>'maxOccurrences')::numeric)
      ELSE false
    END
  );

CREATE TABLE booking_series (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  event_type_id uuid,
  original_event_type_id uuid NOT NULL,
  rule_version smallint NOT NULL DEFAULT 1 CHECK (rule_version = 1),
  rule_pattern text NOT NULL,
  rule_ordinal smallint, -- -1 denotes the last weekday of the month.
  rule_weekday smallint, -- ISO weekday, with Monday = 1.
  time_zone text NOT NULL CHECK (btrim(time_zone) <> ''),
  first_local_start timestamp NOT NULL CHECK (isfinite(first_local_start)),
  requested_count smallint NOT NULL CHECK (requested_count BETWEEN 2 AND 12),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  notification_snapshot jsonb NOT NULL CHECK (jsonb_typeof(notification_snapshot) = 'object'),
  host_policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(host_policy_snapshot) = 'object'),
  manage_token_hash bytea UNIQUE CHECK (octet_length(manage_token_hash) = 32),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CONSTRAINT booking_series_event_fkey FOREIGN KEY (organization_id, event_type_id)
    REFERENCES event_types(organization_id, id) ON DELETE SET NULL (event_type_id),
  CONSTRAINT booking_series_original_event_check CHECK (event_type_id = original_event_type_id),
  CONSTRAINT booking_series_rule_check CHECK (
    (rule_pattern IN ('weekly', 'fortnightly') AND rule_ordinal IS NULL AND rule_weekday IS NULL)
    OR (rule_pattern = 'monthly_weekday' AND rule_ordinal IS NOT NULL AND rule_weekday IS NOT NULL
      AND rule_ordinal IN (-1, 1, 2, 3, 4) AND rule_weekday BETWEEN 1 AND 7)
  )
);
CREATE INDEX booking_series_event_type ON booking_series (event_type_id) WHERE event_type_id IS NOT NULL;
CREATE TRIGGER booking_series_updated_at BEFORE UPDATE ON booking_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE booking_series_occurrences (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  series_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 12),
  original_local_start timestamp NOT NULL CHECK (isfinite(original_local_start)),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  root_booking_id uuid NOT NULL UNIQUE,
  UNIQUE (organization_id, id),
  UNIQUE (series_id, ordinal),
  CONSTRAINT booking_series_occurrences_interval_check
    CHECK (isfinite(start_at) AND isfinite(end_at) AND end_at > start_at),
  CONSTRAINT booking_series_occurrences_series_fkey FOREIGN KEY (organization_id, series_id)
    REFERENCES booking_series(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_series_occurrences_root_fkey FOREIGN KEY (organization_id, root_booking_id)
    REFERENCES bookings(organization_id, id) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE bookings
  ADD COLUMN series_occurrence_id uuid,
  ADD CONSTRAINT bookings_series_occurrence_fkey FOREIGN KEY (organization_id, series_occurrence_id)
    REFERENCES booking_series_occurrences(organization_id, id),
  ADD CONSTRAINT bookings_series_member_check CHECK (series_occurrence_id IS NULL OR (
    status IN ('confirmed', 'cancelled') AND source <> 'import'
    AND payment_hold_expires_at IS NULL AND group_slot_id IS NULL
  ));
CREATE INDEX bookings_series_occurrence ON bookings (series_occurrence_id) WHERE series_occurrence_id IS NOT NULL;
CREATE UNIQUE INDEX bookings_series_confirmed_occurrence ON bookings (series_occurrence_id)
  WHERE series_occurrence_id IS NOT NULL AND status = 'confirmed';

CREATE FUNCTION protect_booking_series_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'series occurrence and original event identities are immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
END $$;
CREATE TRIGGER booking_series_original_event_immutable
  BEFORE UPDATE OF original_event_type_id ON booking_series
  FOR EACH ROW WHEN (NEW.original_event_type_id IS DISTINCT FROM OLD.original_event_type_id)
  EXECUTE FUNCTION protect_booking_series_snapshot();
CREATE TRIGGER booking_series_occurrences_immutable BEFORE UPDATE ON booking_series_occurrences
  FOR EACH ROW WHEN (NEW IS DISTINCT FROM OLD)
  EXECUTE FUNCTION protect_booking_series_snapshot();

-- A new member can be the designated root or a successor of a member of that
-- occurrence. Historical single bookings cannot be attached to a series later.
CREATE FUNCTION guard_booking_series_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE predecessor_organization uuid; predecessor_occurrence uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.series_occurrence_id IS DISTINCT FROM OLD.series_occurrence_id
      OR (OLD.series_occurrence_id IS NOT NULL AND
        (NEW.id, NEW.organization_id, NEW.rescheduled_from_id)
        IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.rescheduled_from_id)) THEN
      RAISE EXCEPTION 'series booking membership is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_series_membership_immutable';
    END IF;
  END IF;

  IF NEW.rescheduled_from_id IS NOT NULL THEN
    SELECT organization_id, series_occurrence_id INTO predecessor_organization, predecessor_occurrence
      FROM bookings WHERE id = NEW.rescheduled_from_id;
    IF (NEW.series_occurrence_id IS NOT NULL OR predecessor_occurrence IS NOT NULL)
      AND (NEW.organization_id, NEW.series_occurrence_id)
        IS DISTINCT FROM (predecessor_organization, predecessor_occurrence) THEN
      RAISE EXCEPTION 'series successors must retain their predecessor occurrence'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_series_predecessor_check';
    END IF;
  ELSIF NEW.series_occurrence_id IS NOT NULL AND EXISTS (
    SELECT FROM booking_series_occurrences
    WHERE organization_id = NEW.organization_id AND id = NEW.series_occurrence_id AND root_booking_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'only the designated root can start a series occurrence booking chain'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_series_root_check';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER bookings_series_membership_guard
  AFTER INSERT OR UPDATE OF id, organization_id, series_occurrence_id, rescheduled_from_id ON bookings
  FOR EACH ROW EXECUTE FUNCTION guard_booking_series_member();

-- Check the final transaction state. The root FK guarantees existence in the
-- organization; the roots must also point back to their own occurrences.
CREATE FUNCTION check_booking_series_roots() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target uuid; expected_count integer; actual_count integer; last_ordinal integer;
BEGIN
  IF TG_TABLE_NAME = 'booking_series' THEN
    target := NEW.id;
  ELSIF TG_TABLE_NAME = 'bookings' THEN
    SELECT series_id INTO target FROM booking_series_occurrences
      WHERE (organization_id, id, root_booking_id) = (OLD.organization_id, OLD.series_occurrence_id, OLD.id);
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.series_id;
  ELSE
    target := NEW.series_id;
  END IF;

  SELECT requested_count INTO expected_count FROM booking_series WHERE id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), max(ordinal) INTO actual_count, last_ordinal
    FROM booking_series_occurrences WHERE series_id = target;
  IF actual_count <> expected_count OR last_ordinal <> expected_count THEN
    RAISE EXCEPTION 'series must have every requested occurrence'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_series_occurrence_count';
  END IF;
  IF EXISTS (
    SELECT FROM booking_series_occurrences o
    JOIN bookings b ON (b.organization_id, b.id) = (o.organization_id, o.root_booking_id)
    WHERE o.series_id = target AND (b.series_occurrence_id IS DISTINCT FROM o.id OR b.rescheduled_from_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'series roots must own their occurrences'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_series_root_ownership';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER booking_series_roots AFTER INSERT OR UPDATE OF id, requested_count ON booking_series
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_booking_series_roots();
CREATE CONSTRAINT TRIGGER booking_series_occurrences_roots AFTER INSERT OR DELETE ON booking_series_occurrences
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_booking_series_roots();
CREATE CONSTRAINT TRIGGER bookings_series_roots AFTER DELETE ON bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.series_occurrence_id IS NOT NULL)
  EXECUTE FUNCTION check_booking_series_roots();
