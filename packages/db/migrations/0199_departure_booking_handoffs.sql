-- Each row represents one immutable offer version. Actor IDs preserve the historical
-- binding after a team member leaves. Current authority is checked by the service.
CREATE TABLE departure_handoff_offers (
  organization_id uuid NOT NULL,
  source_booking_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  version integer NOT NULL,
  proposer_user_id uuid NOT NULL,
  departing_user_id uuid NOT NULL,
  target_start_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL,
  location_option_id text,
  terms_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'live',
  PRIMARY KEY (organization_id, source_booking_id, id, version),
  CONSTRAINT departure_handoff_offers_source_fk FOREIGN KEY (source_booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_offers_source_version_key UNIQUE (organization_id, source_booking_id, version),
  CONSTRAINT departure_handoff_offers_version_check CHECK (version > 0),
  CONSTRAINT departure_handoff_offers_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT departure_handoff_offers_digest_check CHECK (terms_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT departure_handoff_offers_state_check CHECK (state IN ('live', 'closed')),
  CONSTRAINT departure_handoff_offers_window_check CHECK (
    isfinite(issued_at) AND isfinite(target_start_at)
    AND expires_at > issued_at AND expires_at <= issued_at + interval '48 hours'
    AND expires_at <= target_start_at
  )
);

CREATE UNIQUE INDEX departure_handoff_offers_one_live
  ON departure_handoff_offers (organization_id, source_booking_id) WHERE state = 'live';

CREATE FUNCTION guard_departure_handoff_offer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.source_booking_id, NEW.id, NEW.version,
         NEW.proposer_user_id, NEW.departing_user_id, NEW.target_start_at, NEW.duration_minutes,
         NEW.location_option_id, NEW.terms_digest, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.source_booking_id, OLD.id, OLD.version,
         OLD.proposer_user_id, OLD.departing_user_id, OLD.target_start_at, OLD.duration_minutes,
         OLD.location_option_id, OLD.terms_digest, OLD.issued_at, OLD.expires_at)
     OR (OLD.state = 'closed' AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'handoff offer version is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'departure_handoff_offers_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER departure_handoff_offers_immutable BEFORE UPDATE ON departure_handoff_offers
  FOR EACH ROW EXECUTE FUNCTION guard_departure_handoff_offer();

CREATE TABLE departure_handoff_recipients (
  organization_id uuid NOT NULL,
  source_booking_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  offer_version integer NOT NULL,
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_key text NOT NULL,
  decision text,
  decided_at timestamptz,
  CONSTRAINT departure_handoff_recipients_offer_fk
    FOREIGN KEY (organization_id, source_booking_id, offer_id, offer_version)
    REFERENCES departure_handoff_offers (organization_id, source_booking_id, id, version) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_recipients_mailbox_key
    UNIQUE (organization_id, source_booking_id, offer_id, offer_version, recipient_key),
  CONSTRAINT departure_handoff_recipients_mailbox_check CHECK (
    recipient_key <> '' AND recipient_key = lower(btrim(recipient_key) COLLATE "C")
  ),
  CONSTRAINT departure_handoff_recipients_decision_check CHECK (
    (decision IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND decision IN ('approved', 'declined')
        AND decided_at IS NOT NULL AND isfinite(decided_at))
  )
);

CREATE FUNCTION guard_departure_handoff_recipient() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.source_booking_id, NEW.offer_id,
         NEW.offer_version, NEW.id, NEW.recipient_key)
     IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.source_booking_id, OLD.offer_id,
         OLD.offer_version, OLD.id, OLD.recipient_key)
     OR (OLD.decision IS NOT NULL AND
         ROW(NEW.decision, NEW.decided_at) IS DISTINCT FROM ROW(OLD.decision, OLD.decided_at)) THEN
    RAISE EXCEPTION 'handoff recipient binding and recorded decision are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'departure_handoff_recipients_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER departure_handoff_recipients_immutable BEFORE UPDATE ON departure_handoff_recipients
  FOR EACH ROW EXECUTE FUNCTION guard_departure_handoff_recipient();

-- The edge and receipt are one append-only row. Recipient IDs retain consent evidence
-- even after the matching mailbox rows are pruned. The edge expires with either booking.
CREATE TABLE departure_booking_handoffs (
  organization_id uuid NOT NULL,
  source_booking_id uuid PRIMARY KEY,
  replacement_booking_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  offer_version integer NOT NULL,
  applying_user_id uuid NOT NULL,
  applied_at timestamptz NOT NULL,
  recipient_ids uuid[] NOT NULL,
  CONSTRAINT departure_booking_handoffs_replacement_key UNIQUE (replacement_booking_id),
  CONSTRAINT departure_booking_handoffs_distinct_check CHECK (source_booking_id <> replacement_booking_id),
  CONSTRAINT departure_booking_handoffs_recipients_check CHECK (
    array_ndims(recipient_ids) = 1 AND cardinality(recipient_ids) > 0
  ),
  CONSTRAINT departure_booking_handoffs_source_fk FOREIGN KEY (source_booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT departure_booking_handoffs_replacement_fk FOREIGN KEY (replacement_booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,
  -- The receipt guard rejects an offer cascade while both bookings still exist.
  CONSTRAINT departure_booking_handoffs_offer_fk
    FOREIGN KEY (organization_id, source_booking_id, offer_id, offer_version)
    REFERENCES departure_handoff_offers (organization_id, source_booking_id, id, version)
    ON DELETE CASCADE
);

CREATE FUNCTION guard_departure_booking_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  issued timestamptz;
  expires timestamptz;
  approved_ids uuid[];
  all_approved boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'committed handoff is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'departure_booking_handoffs_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = OLD.source_booking_id)
       AND EXISTS (SELECT 1 FROM public.bookings WHERE id = OLD.replacement_booking_id) THEN
      RAISE EXCEPTION 'committed handoff is retained while both bookings exist'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'departure_booking_handoffs_immutable';
    END IF;
    RETURN OLD;
  END IF;

  -- The apply transaction holds the source and exact offer locks. Store a copy of
  -- the exact approval IDs, independent of later retention of the recipient rows.
  IF NEW.organization_id IS NULL OR NEW.source_booking_id IS NULL OR NEW.offer_id IS NULL
     OR NEW.offer_version IS NULL OR NEW.applied_at IS NULL
     OR coalesce(cardinality(NEW.recipient_ids), 0) = 0 THEN
    RETURN NEW; -- Declarative constraints reject missing columns or empty evidence.
  END IF;
  SELECT o.issued_at, o.expires_at INTO issued, expires
    FROM public.departure_handoff_offers o
    WHERE (o.organization_id, o.source_booking_id, o.id, o.version) =
      (NEW.organization_id, NEW.source_booking_id, NEW.offer_id, NEW.offer_version);
  -- The version and its evidence must already exist when the receipt is inserted.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff receipt must reference an existing offer version'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'departure_booking_handoffs_offer_fk';
  END IF;
  SELECT array_agg(r.id ORDER BY r.id), bool_and(
    r.decision IS NOT DISTINCT FROM 'approved' AND r.decided_at BETWEEN issued AND NEW.applied_at
  ) INTO approved_ids, all_approved
    FROM public.departure_handoff_recipients r
    WHERE (r.organization_id, r.source_booking_id, r.offer_id, r.offer_version) =
      (NEW.organization_id, NEW.source_booking_id, NEW.offer_id, NEW.offer_version);
  IF NEW.applied_at < issued OR NEW.applied_at >= expires OR all_approved IS DISTINCT FROM true
     OR approved_ids IS DISTINCT FROM ARRAY(SELECT id FROM unnest(NEW.recipient_ids) AS id ORDER BY id) THEN
    RAISE EXCEPTION 'handoff receipt must match the exact approved offer recipients'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'departure_booking_handoffs_evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER departure_booking_handoffs_guard BEFORE INSERT OR UPDATE OR DELETE ON departure_booking_handoffs
  FOR EACH ROW EXECUTE FUNCTION guard_departure_booking_handoff();
