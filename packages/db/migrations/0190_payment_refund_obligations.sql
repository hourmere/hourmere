-- Keep the original Checkout/payment identity on the chain root.
ALTER TABLE payment_checkout_attempts
  ADD COLUMN current_booking_id uuid UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT;
CREATE INDEX bookings_payment_reconciliation_scan
  ON bookings (id) WHERE payment_hold_expires_at IS NOT NULL;

-- Retain the operation across webhook replay, worker failure and booking data erasure.
CREATE TABLE payment_refund_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES payment_checkout_attempts (id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  mode text NOT NULL,
  payment_reference text NOT NULL UNIQUE,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  stripe_refund_id text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  first_attempted_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_refund_obligations_binding CHECK (
    mode IN ('test', 'live') AND amount_minor > 0 AND currency ~ '^[a-z]{3}$'
  ),
  CONSTRAINT payment_refund_obligations_state CHECK (
    (state = 'requested' AND stripe_refund_id IS NULL)
    OR (state IN ('pending', 'succeeded') AND stripe_refund_id IS NOT NULL)
    OR state = 'failed'
  ),
  CONSTRAINT payment_refund_obligations_attempts CHECK (
    (attempts = 0 AND first_attempted_at IS NULL)
    OR (attempts > 0 AND first_attempted_at IS NOT NULL)
  ),
  CONSTRAINT payment_refund_obligations_lease CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND state = 'requested')
  )
);
CREATE INDEX payment_refund_obligations_due
  ON payment_refund_obligations (account_id, mode, next_attempt_at, id)
  WHERE state = 'requested';

-- Only send money for historical late payments with a bound Checkout Session.
INSERT INTO payment_refund_obligations (
  attempt_id, account_id, mode, payment_reference, amount_minor, currency
)
SELECT a.id, a.account_id, a.mode, b.payment_reference, a.amount_minor, a.currency
FROM payment_checkout_attempts a
JOIN bookings b ON b.id = a.booking_id
WHERE b.payment_refund_required AND a.session_id IS NOT NULL;

-- Store only identifiers for signed paid observations that could not be bound.
ALTER TABLE payment_stripe_events
  ADD COLUMN finding text,
  ADD COLUMN account_id text,
  ADD COLUMN mode text,
  ADD COLUMN session_id text,
  ADD COLUMN payment_reference text,
  ADD CONSTRAINT payment_stripe_events_finding_shape CHECK (
    num_nonnulls(finding, account_id, mode, session_id, payment_reference) IN (0, 5)
  );
CREATE INDEX payment_stripe_events_findings
  ON payment_stripe_events (account_id, mode, event_id) WHERE finding IS NOT NULL;
