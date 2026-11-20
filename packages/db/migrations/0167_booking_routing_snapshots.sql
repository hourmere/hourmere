-- Read the routing marker with the existing booking lock. Ordinary moves need no
-- lookup of booking_routing, and ordinary booking writes do not fire the new trigger.
ALTER TABLE bookings ADD COLUMN has_routing_snapshot boolean NOT NULL DEFAULT false;

-- The constant default leaves ordinary rows untouched. Preserve the timestamps of
-- existing routed bookings while marking them.
ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;
UPDATE bookings AS b SET has_routing_snapshot = true
FROM booking_routing AS r
WHERE b.id = r.booking_id AND b.organization_id = r.organization_id;
-- Existing deferred booking checks must finish before ALTER TABLE can re-enable the trigger.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;

CREATE FUNCTION mark_booking_routing_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  payment_hold timestamptz;
BEGIN
  -- The snapshot's composite foreign key handles missing or cross-organization parents.
  UPDATE bookings SET has_routing_snapshot = true
  WHERE id = NEW.booking_id AND organization_id = NEW.organization_id
  RETURNING payment_hold_expires_at INTO payment_hold;
  IF payment_hold IS NOT NULL THEN
    RAISE EXCEPTION 'routing snapshots require an unpaid booking'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_routing_unpaid_booking';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER booking_routing_mark_snapshot AFTER INSERT ON booking_routing
  FOR EACH ROW EXECUTE FUNCTION mark_booking_routing_snapshot();
