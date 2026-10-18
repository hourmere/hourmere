-- A user deletion cascades booking_hosts. Retain the original required identities so a
-- surviving host cannot silently reschedule a collective meeting without that person.
-- Historical identities already deleted before this migration cannot be recovered.
ALTER TABLE bookings ADD COLUMN required_host_user_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE bookings b SET required_host_user_ids = ARRAY(
  SELECT h.user_id FROM booking_hosts h WHERE h.booking_id = b.id ORDER BY h.user_id
);
CREATE FUNCTION immutable_required_booking_hosts() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.required_host_user_ids IS DISTINCT FROM OLD.required_host_user_ids THEN
    RAISE EXCEPTION 'required booking hosts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_required_hosts_immutable BEFORE UPDATE OF required_host_user_ids ON bookings
  FOR EACH ROW EXECUTE FUNCTION immutable_required_booking_hosts();
