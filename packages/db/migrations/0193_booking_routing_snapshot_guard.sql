-- Protect both directions of the booking marker without reading routing tables on ordinary moves.
ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;

CREATE FUNCTION clear_booking_routing_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- The booking may already be gone when its foreign key cascades the delete.
  UPDATE bookings SET has_routing_snapshot = false
  WHERE id = OLD.booking_id AND organization_id = OLD.organization_id
    AND has_routing_snapshot;
  RETURN OLD;
END $$;
CREATE TRIGGER booking_routing_clear_snapshot AFTER DELETE ON booking_routing
  FOR EACH ROW EXECUTE FUNCTION clear_booking_routing_snapshot();

-- Repair markers written before they were guarded, preserving booking timestamps.
UPDATE bookings AS b SET has_routing_snapshot = true
FROM booking_routing AS r
WHERE b.id = r.booking_id AND b.organization_id = r.organization_id
  AND NOT b.has_routing_snapshot;
UPDATE bookings AS b SET has_routing_snapshot = false
WHERE b.has_routing_snapshot AND NOT EXISTS (
  SELECT 1 FROM booking_routing AS r
  WHERE r.booking_id = b.id AND r.organization_id = b.organization_id
);
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;

CREATE FUNCTION guard_booking_routing_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- A snapshot's foreign key requires its booking to exist before insertion.
  IF TG_OP = 'INSERT' AND NEW.has_routing_snapshot IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.has_routing_snapshot <> EXISTS (
    SELECT 1 FROM booking_routing
    WHERE booking_id = NEW.id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'booking routing marker must match its snapshot'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_routing_snapshot_matches';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bookings_routing_snapshot_guard
  BEFORE INSERT OR UPDATE OF has_routing_snapshot, id, organization_id ON bookings
  FOR EACH ROW EXECUTE FUNCTION guard_booking_routing_snapshot();
