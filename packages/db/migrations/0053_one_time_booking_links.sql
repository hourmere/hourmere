-- Only the SHA-256 digest is retained; creation returns the random capability once.
CREATE TABLE one_time_booking_links (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  prefill_name text CHECK (char_length(prefill_name) <= 200),
  prefill_email text CHECK (char_length(prefill_email) <= 320),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'used', 'expired', 'revoked')),
  booking_id uuid UNIQUE,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_type_id, organization_id)
    REFERENCES event_types (id, organization_id) ON DELETE CASCADE,
  -- Keep the confirmed-booking evidence if someone attempts to delete only a booking.
  -- NO ACTION still allows the organization to cascade both rows in one statement.
  FOREIGN KEY (booking_id, organization_id)
    REFERENCES bookings (id, organization_id),
  CONSTRAINT one_time_booking_links_used_shape CHECK (
    (state = 'used') = (booking_id IS NOT NULL)
    AND (state = 'used') = (used_at IS NOT NULL)
  ),
  CONSTRAINT one_time_booking_links_revoked_shape CHECK (
    (state = 'revoked') = (revoked_at IS NOT NULL)
  )
);
CREATE INDEX one_time_booking_links_organization_created
  ON one_time_booking_links (organization_id, created_at, id);
CREATE INDEX one_time_booking_links_creator_state
  ON one_time_booking_links (creator_user_id, state);
CREATE INDEX one_time_booking_links_organization_active
  ON one_time_booking_links (organization_id) WHERE state = 'active';
CREATE INDEX one_time_booking_links_event_type
  ON one_time_booking_links (event_type_id);

CREATE FUNCTION guard_one_time_booking_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.event_type_id, NEW.creator_user_id,
           NEW.token_hash, NEW.expires_at, NEW.prefill_name, NEW.prefill_email, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.organization_id, OLD.event_type_id, OLD.creator_user_id,
           OLD.token_hash, OLD.expires_at, OLD.prefill_name, OLD.prefill_email, OLD.created_at) THEN
      RAISE EXCEPTION 'one-time booking link issuance is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'one_time_booking_links_issuance_immutable';
    END IF;
    IF OLD.state <> 'active' AND
       ROW(NEW.state, NEW.booking_id, NEW.used_at, NEW.revoked_at)
       IS DISTINCT FROM ROW(OLD.state, OLD.booking_id, OLD.used_at, OLD.revoked_at) THEN
      RAISE EXCEPTION 'one-time booking link terminal state is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'one_time_booking_links_terminal';
    END IF;
  END IF;

  IF NEW.state = 'used' AND (TG_OP = 'INSERT' OR OLD.state <> 'used') THEN
    -- The lock serializes consumption with cancellation. Cancellation after a
    -- successful claim is allowed and never changes the link's terminal state.
    PERFORM 1 FROM public.bookings b
      WHERE b.id = NEW.booking_id AND b.organization_id = NEW.organization_id
        AND b.event_type_id = NEW.event_type_id AND b.status = 'confirmed'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'one-time booking link requires its confirmed booking'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'one_time_booking_links_claim_booking';
    END IF;
    -- Wall time is checked after any booking lock wait, rather than transaction time.
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'one-time booking link has expired'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'one_time_booking_links_claim_expired';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER one_time_booking_links_guard BEFORE INSERT OR UPDATE ON one_time_booking_links
  FOR EACH ROW EXECUTE FUNCTION guard_one_time_booking_link();
CREATE TRIGGER one_time_booking_links_updated_at BEFORE UPDATE ON one_time_booking_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
