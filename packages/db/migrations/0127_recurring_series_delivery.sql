-- Durable receipts, notification intents and the admission counter for hard-off series.
CREATE TABLE booking_series_receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  series_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('create', 'bulk_cancel')),
  authority_scope bytea NOT NULL CHECK (octet_length(authority_scope) = 32),
  -- The ASCII request key grants no authority. Keep only its SHA-256 for replay.
  idempotency_key bytea NOT NULL CHECK (octet_length(idempotency_key) = 32),
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  affected_occurrence_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(affected_occurrence_ids) <= 12 AND array_ndims(affected_occurrence_ids) <= 1),
  result_booking_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(result_booking_ids) <= 12 AND array_ndims(result_booking_ids) <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_series_receipts_series_fkey FOREIGN KEY (organization_id, series_id)
    REFERENCES booking_series(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_series_receipts_replay_key
    UNIQUE (organization_id, authority_scope, operation_kind, idempotency_key)
);
CREATE INDEX booking_series_receipts_series ON booking_series_receipts (series_id);

-- These are historical result IDs. Check ownership when written without making later
-- changes to a member booking depend on any receipt.
CREATE FUNCTION check_booking_series_receipt_members() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT FROM unnest(NEW.affected_occurrence_ids) AS affected(id)
    WHERE NOT EXISTS (
      SELECT FROM booking_series_occurrences o
      WHERE (o.organization_id, o.series_id, o.id) = (NEW.organization_id, NEW.series_id, affected.id)
    )
  ) OR EXISTS (
    SELECT FROM unnest(NEW.result_booking_ids) AS result(id)
    WHERE NOT EXISTS (
      SELECT FROM bookings b JOIN booking_series_occurrences o
        ON (o.organization_id, o.id) = (b.organization_id, b.series_occurrence_id)
      WHERE (b.organization_id, o.series_id, b.id) = (NEW.organization_id, NEW.series_id, result.id)
    )
  ) THEN
    RAISE EXCEPTION 'series receipt members must belong to the receipt series'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER booking_series_receipts_member_binding
  AFTER INSERT OR UPDATE OF organization_id, series_id, affected_occurrence_ids, result_booking_ids
  ON booking_series_receipts FOR EACH ROW EXECUTE FUNCTION check_booking_series_receipt_members();

CREATE TABLE booking_series_notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  series_id uuid NOT NULL,
  row_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('confirmation', 'cancellation', 'link_update')),
  -- Action revision, or a per-recipient counter for link updates.
  sequence bigint NOT NULL CHECK (sequence > 0),
  recipient_role text CHECK (recipient_role IN ('booker', 'guest', 'host')),
  recipient_id uuid,
  capability_scope text,
  manage_token_hash bytea UNIQUE CHECK (octet_length(manage_token_hash) = 32),
  outcome text CHECK (outcome IN ('delivered', 'suppressed', 'rejected')),
  sent_at timestamptz,
  suppression_reason text CHECK (suppression_reason IN (
    'recipient_hourly_limit', 'recipient_daily_limit', 'instance_hourly_limit'
  )),
  -- Parallel arrays describe the dates and link states in the delivered report.
  reported_ordinals smallint[],
  reported_link_states text[],
  due_at timestamptz,
  attempts smallint CHECK (attempts BETWEEN 0 AND 13),
  lease_id uuid,
  lease_until timestamptz,
  outbox_state text CHECK (outbox_state IN ('pending', 'done', 'skipped', 'exhausted')),
  -- As in booking_notifications, don't hold a series key-share lock across SMTP.
  CONSTRAINT booking_series_notifications_series_fkey FOREIGN KEY (organization_id, series_id)
    REFERENCES booking_series(organization_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT booking_series_notifications_identity_key
    UNIQUE NULLS NOT DISTINCT (series_id, row_type, kind, sequence, recipient_role, recipient_id),
  CONSTRAINT booking_series_notifications_row_shape_check CHECK (
    (row_type = 'receipt' AND recipient_role IS NOT NULL AND recipient_id IS NOT NULL
      AND outcome IS NOT NULL AND due_at IS NULL AND attempts IS NULL AND outbox_state IS NULL)
    OR
    (row_type = 'outbox' AND
      ((kind = 'link_update' AND recipient_role IS NOT NULL AND recipient_id IS NOT NULL)
      OR (kind <> 'link_update' AND recipient_role IS NULL AND recipient_id IS NULL))
      AND outcome IS NULL AND due_at IS NOT NULL AND attempts IS NOT NULL AND outbox_state IS NOT NULL)
  ),
  CONSTRAINT booking_series_notifications_report_check CHECK (
    (outcome IS NOT DISTINCT FROM 'delivered' AND sent_at IS NOT NULL AND isfinite(sent_at)
      AND reported_ordinals IS NOT NULL AND reported_link_states IS NOT NULL
      AND cardinality(reported_ordinals) <= 12
      AND cardinality(reported_ordinals) = cardinality(reported_link_states)
      AND coalesce(array_ndims(reported_ordinals), 1) = 1
      AND coalesce(array_ndims(reported_link_states), 1) = 1
      AND reported_ordinals <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]
      AND reported_link_states <@ ARRAY['no_conference', 'pending', 'ready', 'failed',
        'updated_separately', 'started', 'cancelled'])
    OR
    (outcome IS DISTINCT FROM 'delivered'
      AND sent_at IS NULL AND reported_ordinals IS NULL AND reported_link_states IS NULL)
  ),
  CONSTRAINT booking_series_notifications_suppression_check
    CHECK ((outcome IS NOT DISTINCT FROM 'suppressed') = (suppression_reason IS NOT NULL)),
  CONSTRAINT booking_series_notifications_capability_check CHECK (
    (manage_token_hash IS NULL AND capability_scope IS NULL) OR (
      manage_token_hash IS NOT NULL AND outcome IS NOT DISTINCT FROM 'delivered'
      AND ((recipient_role = 'booker' AND capability_scope IS NOT DISTINCT FROM 'manage')
        OR (recipient_role = 'guest' AND capability_scope IS NOT DISTINCT FROM 'read'))
    )
  ),
  CONSTRAINT booking_series_notifications_lease_check CHECK (
    (lease_id IS NULL AND lease_until IS NULL) OR
    (lease_id IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until)
      AND outbox_state IS NOT DISTINCT FROM 'pending')
  )
);
CREATE UNIQUE INDEX booking_series_notifications_waiting_link
  ON booking_series_notifications (series_id, recipient_role, recipient_id)
  WHERE kind = 'link_update' AND outbox_state = 'pending';
CREATE INDEX booking_series_notifications_due
  ON booking_series_notifications (due_at, id) WHERE outbox_state = 'pending';

CREATE TABLE booking_series_admissions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL,
  event_type_id uuid NOT NULL,
  -- Digest of the API key / OAuth consent identity, or a server-keyed address HMAC.
  actor_digest bytea NOT NULL CHECK (octet_length(actor_digest) = 32),
  admitted_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(admitted_at)),
  CONSTRAINT booking_series_admissions_event_fkey FOREIGN KEY (organization_id, event_type_id)
    REFERENCES event_types(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_series_admissions_actor
  ON booking_series_admissions (event_type_id, actor_digest, admitted_at);
CREATE INDEX booking_series_admissions_age
  ON booking_series_admissions (admitted_at, id);
