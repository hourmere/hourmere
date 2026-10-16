-- Follow-ups from the review of 0002: personal-organization deletion, host-row errors and
-- defaults, and event type bounds matching the availability engine.

-- 1. Delete a personal organization only when its user is deleted. The previous trigger
--    fired on any delete of the marker row, so removing the marker (e.g. when a personal
--    workspace becomes a team) would have deleted the organization and all its bookings.
DROP TRIGGER personal_organizations_cascade ON personal_organizations;
DROP FUNCTION delete_personal_organization();

CREATE FUNCTION delete_user_personal_organization() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM auth.organization o
   USING public.personal_organizations p
   WHERE p.user_id = OLD.id AND o.id = p.organization_id;
  RETURN OLD;
END $$;
CREATE TRIGGER user_personal_organization_cascade BEFORE DELETE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION delete_user_personal_organization();

-- 2. A host row for a booking that does not exist reports a foreign-key violation
--    (23503) instead of a NOT NULL violation on period, so callers can map it correctly.
--    A NULL booking_id is left to its NOT NULL constraint (23502): a programming error,
--    not a missing booking.
CREATE OR REPLACE FUNCTION booking_host_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- FOR SHARE: a concurrent reschedule of the booking must wait for us (and vice versa);
  -- the foreign key check alone takes a weaker lock that would allow a race.
  SELECT tstzrange(b.start_at, b.end_at, '[)'), b.status <> 'cancelled'
    INTO NEW.period, NEW.active
    FROM public.bookings b
   WHERE b.id = NEW.booking_id
     FOR SHARE;
  IF NOT FOUND AND NEW.booking_id IS NOT NULL THEN
    RAISE EXCEPTION 'booking % does not exist', NEW.booking_id
      USING ERRCODE = 'foreign_key_violation', SCHEMA = 'public', TABLE = 'booking_hosts',
            COLUMN = 'booking_id', CONSTRAINT = 'booking_hosts_booking_id_fkey';
  END IF;
  RETURN NEW;
END $$;

-- 3. period and active are always overwritten by booking_host_slot(); placeholder
--    defaults let inserts omit them (and make the generated types optional). The CHECK
--    keeps the placeholder period from ever being stored, even with triggers disabled.
ALTER TABLE booking_hosts
  ALTER COLUMN period SET DEFAULT 'empty',
  ALTER COLUMN active SET DEFAULT false,
  ADD CONSTRAINT booking_hosts_period_not_empty CHECK (NOT isempty(period));
COMMENT ON COLUMN booking_hosts.period IS 'Derived from the booking by booking_host_slot(); any value written is replaced.';
COMMENT ON COLUMN booking_hosts.active IS 'Derived from the booking status by booking_host_slot(); any value written is replaced.';

-- 4. Upper bounds matching the availability engine (@hourmere/core), so a stored event
--    type can never make every availability query fail validation.
ALTER TABLE event_types
  ADD CONSTRAINT event_types_slot_step_max CHECK (slot_step_minutes <= 1440),
  ADD CONSTRAINT event_types_buffer_before_max CHECK (buffer_before_minutes <= 1440),
  ADD CONSTRAINT event_types_buffer_after_max CHECK (buffer_after_minutes <= 1440),
  ADD CONSTRAINT event_types_minimum_notice_max CHECK (minimum_notice_minutes <= 525600),
  ADD CONSTRAINT event_types_booking_window_max CHECK (booking_window_days <= 3650),
  ADD CONSTRAINT event_types_max_bookings_per_day_max CHECK (max_bookings_per_day <= 1000);
