-- Internal paid-booking foundation. No credentials or card data are stored.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed','cancelled','pending_payment','expired'));
ALTER TABLE bookings ADD COLUMN payment_hold_expires_at timestamptz,
  ADD COLUMN payment_reference text,
  ADD COLUMN payment_refund_required boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_hold_shape CHECK (
  (status NOT IN ('pending_payment','expired') OR payment_hold_expires_at IS NOT NULL)
  AND (payment_hold_expires_at IS NULL OR (isfinite(payment_hold_expires_at) AND group_slot_id IS NULL AND source <> 'import'))
  AND (payment_reference IS NULL OR payment_hold_expires_at IS NOT NULL)
  AND (status <> 'confirmed' OR payment_hold_expires_at IS NULL OR payment_reference IS NOT NULL)
  AND (NOT payment_refund_required OR (payment_reference IS NOT NULL AND status IN ('expired','cancelled'))));
CREATE UNIQUE INDEX bookings_payment_reference ON bookings(payment_reference) WHERE payment_reference IS NOT NULL;
CREATE INDEX bookings_payment_hold_due ON bookings(payment_hold_expires_at) WHERE status='pending_payment';
CREATE OR REPLACE FUNCTION booking_host_slot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parent_host uuid; seat_slot uuid;
BEGIN
  -- Preserve the legacy missing-booking-parent diagnostic when neither parent is set.
  IF NEW.booking_id IS NULL AND NEW.group_slot_id IS NULL THEN
    RAISE EXCEPTION 'host occupancy requires a parent'
      USING ERRCODE='not_null_violation',SCHEMA='public',TABLE='booking_hosts',COLUMN='booking_id';
  END IF;
  IF (NEW.booking_id IS NULL)=(NEW.group_slot_id IS NULL) THEN
    RAISE EXCEPTION 'host occupancy requires exactly one parent'
      USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_parent';
  END IF;
  IF NEW.group_slot_id IS NOT NULL THEN
    SELECT tstzrange(s.start_at,s.end_at,'[)'),s.state='open',s.host_user_id
      INTO NEW.period,NEW.active,parent_host FROM group_slots s
      WHERE s.id=NEW.group_slot_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group slot % does not exist', NEW.group_slot_id
        USING ERRCODE='foreign_key_violation',SCHEMA='public',TABLE='booking_hosts',
          COLUMN='group_slot_id',CONSTRAINT='booking_hosts_group_slot_id_fkey';
    END IF;
    IF NEW.user_id<>parent_host THEN
      RAISE EXCEPTION 'group slot occupancy must use its required host'
        USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_group_host';
    END IF;
  ELSE
    SELECT tstzrange(b.start_at,b.end_at,'[)'),b.status IN ('confirmed','pending_payment'),b.group_slot_id
      INTO NEW.period,NEW.active,seat_slot FROM bookings b
      WHERE b.id=NEW.booking_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking % does not exist', NEW.booking_id
        USING ERRCODE='foreign_key_violation',SCHEMA='public',TABLE='booking_hosts',
          COLUMN='booking_id',CONSTRAINT='booking_hosts_booking_id_fkey';
    END IF;
    IF seat_slot IS NOT NULL THEN
      RAISE EXCEPTION 'group seats cannot own host occupancy'
        USING ERRCODE='check_violation',CONSTRAINT='booking_hosts_no_seat_parent';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A released hold cannot be resurrected, even by an accidental direct database write.
CREATE FUNCTION guard_payment_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.payment_hold_expires_at IS NOT NULL THEN
    IF NEW.payment_hold_expires_at IS DISTINCT FROM OLD.payment_hold_expires_at
      OR (OLD.status IN ('expired','cancelled') AND NEW.status IS DISTINCT FROM OLD.status)
      OR (OLD.payment_reference IS NOT NULL AND NEW.payment_reference IS DISTINCT FROM OLD.payment_reference)
      OR (OLD.status='confirmed' AND NEW.status NOT IN ('confirmed','cancelled')) THEN
      RAISE EXCEPTION 'invalid payment hold transition' USING ERRCODE='check_violation',CONSTRAINT='bookings_payment_transition';
    END IF;
    IF OLD.status='pending_payment' AND NEW.status='confirmed'
      AND (NEW.payment_reference IS NULL OR OLD.payment_hold_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'payment hold expired or unpaid' USING ERRCODE='check_violation',CONSTRAINT='bookings_payment_confirmation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_payment_transition BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION guard_payment_hold();

-- Pending paid work must not be converted into a group event.
CREATE OR REPLACE FUNCTION guard_event_booking_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.booking_mode IS DISTINCT FROM OLD.booking_mode THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'event-booking-mode:' || NEW.id::text,0));
  END IF;
  IF NEW.booking_mode IS DISTINCT FROM OLD.booking_mode AND (
    EXISTS (SELECT FROM bookings WHERE event_type_id=OLD.id AND status IN ('confirmed','pending_payment') AND end_at>clock_timestamp())
    OR EXISTS (SELECT FROM group_slots WHERE original_event_type_id=OLD.id AND state='open'
      AND active_seats>0 AND end_at>clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'event mode cannot change while booked work remains'
      USING ERRCODE='check_violation',CONSTRAINT='event_types_group_mode_work';
  END IF;
  RETURN NEW;
END $$;
