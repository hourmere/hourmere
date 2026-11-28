ALTER TABLE departure_handoff_offers
  ADD COLUMN close_reason text,
  ADD CONSTRAINT departure_handoff_offers_close_reason_check CHECK (
    close_reason IS NULL OR (state = 'closed' AND close_reason IN ('withdrawn', 'superseded', 'expired'))
  );

CREATE INDEX departure_handoff_offers_expiry_idx
  ON departure_handoff_offers (expires_at, organization_id, source_booking_id, version);

ALTER TABLE departure_handoff_recipients
  ADD COLUMN token_digest text,
  ADD CONSTRAINT departure_handoff_recipients_token_digest_check CHECK (
    token_digest IS NULL OR (decision IS NULL AND token_digest ~ '^[a-f0-9]{64}$')
  );

CREATE UNIQUE INDEX departure_handoff_recipients_token_digest_key
  ON departure_handoff_recipients (token_digest) WHERE token_digest IS NOT NULL;

-- Keep the cap across versions and recipient purges. The purpose-specific mailbox hash
-- avoids retaining a copy of the address in this long-lived budget record.
CREATE TABLE departure_handoff_send_budgets (
  organization_id uuid NOT NULL,
  source_booking_id uuid NOT NULL,
  recipient_hash text NOT NULL,
  counted_sends integer NOT NULL,
  CONSTRAINT departure_handoff_send_budgets_pkey
    PRIMARY KEY (organization_id, source_booking_id, recipient_hash),
  CONSTRAINT departure_handoff_send_budgets_source_fk FOREIGN KEY (source_booking_id, organization_id)
    REFERENCES bookings (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_send_budgets_recipient_hash_check
    CHECK (recipient_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT departure_handoff_send_budgets_counted_sends_check
    CHECK (counted_sends BETWEEN 1 AND 3)
);

-- The transactional mail outbox job ID is also the claim identity. An initial
-- delivery has a null request key; explicit resends carry an idempotency key.
CREATE TABLE departure_handoff_deliveries (
  job_id uuid PRIMARY KEY,
  recipient_id uuid NOT NULL,
  request_key uuid,
  state text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT departure_handoff_deliveries_recipient_fk FOREIGN KEY (recipient_id)
    REFERENCES departure_handoff_recipients (id) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_deliveries_request_key
    UNIQUE NULLS NOT DISTINCT (recipient_id, request_key),
  CONSTRAINT departure_handoff_deliveries_state_check
    CHECK (state IN ('queued', 'unknown', 'sent', 'failed', 'unavailable', 'skipped')),
  CONSTRAINT departure_handoff_deliveries_created_at_check CHECK (isfinite(created_at))
);

CREATE UNIQUE INDEX departure_handoff_deliveries_one_queued
  ON departure_handoff_deliveries (recipient_id) WHERE state = 'queued';
