-- Explicit activation and durable equal-rotation state. Legacy modes stay unactivated.
CREATE TABLE round_robin_state (
  event_type_id uuid PRIMARY KEY REFERENCES event_types(id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
  enabled boolean NOT NULL DEFAULT false
);
ALTER TABLE event_type_hosts ADD COLUMN last_assigned_sequence bigint NOT NULL DEFAULT 0
  CHECK (last_assigned_sequence >= 0);

-- A one-host round-robin booking must keep its original default-schedule policy even if
-- the event type later changes to individual with a custom schedule.
ALTER TABLE bookings ADD COLUMN hosts_use_default_schedule boolean NOT NULL DEFAULT false;
ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;
UPDATE bookings SET hosts_use_default_schedule = true
  WHERE cardinality(required_host_user_ids) > 1;
ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;

CREATE OR REPLACE FUNCTION immutable_required_booking_hosts() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.required_host_user_ids IS DISTINCT FROM OLD.required_host_user_ids
     OR NEW.hosts_use_default_schedule IS DISTINCT FROM OLD.hosts_use_default_schedule THEN
    RAISE EXCEPTION 'required booking hosts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER bookings_required_hosts_immutable ON bookings;
CREATE TRIGGER bookings_required_hosts_immutable
  BEFORE UPDATE OF required_host_user_ids, hosts_use_default_schedule ON bookings
  FOR EACH ROW EXECUTE FUNCTION immutable_required_booking_hosts();
